# Agent Teams Redesign

Replace `@tmustier/pi-agent-teams` with an in-package implementation built on `tk` tickets, `SessionManager` session peeking, and single-task disposable workers.

## Problem

The current teams plugin is unreliable:
- Leader doesn't actively poll workers — relies on file-based mailbox messages that arrive late or never
- File-based mailbox/protocol is complex and race-prone (JSON inbox files, shutdown handshakes, idle notifications)
- Long-lived workers accumulate stale worktree state, causing merge conflicts and dirty reads
- No direct visibility into what a worker is actually doing

## Design Principles

1. **Reliability over features** — every interaction must be deterministic and testable
2. **Simplicity** — `tk` tickets are the single communication channel (no mailboxes, no protocol messages)
3. **Disposable workers** — one worker per ticket, fresh process + fresh worktree, nuked on completion
4. **Leader polls, not workers push** — leader actively reads worker sessions + ticket state on a timer

## Architecture

```
Leader (main Pi session)
├── registers `teams` tool (LLM-callable)
├── registers /team commands
├── runs polling loop (setInterval)
│
├── On task:
│   1. Creates tk ticket (status: open, tag: team, assigned: <worker-name>)
│   2. Creates git worktree (if worktree mode)
│   3. Spawns child `pi` process with:
│      - PI_TEAMS_WORKER=1
│      - PI_TEAMS_TICKET_ID=<id>
│      - PI_TEAMS_LEADER_SESSION=<path>
│      - cwd = worktree dir (or shared dir)
│   4. Records { pid, ticketId, workerName, sessionFile, worktreePath }
│
├── Polling loop (every 3-5s):
│   For each active worker:
│     1. Is process alive? (kill -0 pid)
│     2. Open worker session (SessionManager.open), read latest entries
│     3. Read tk ticket (status, comments)
│     4. Decide:
│        - Ticket closed → harvest result, nuke worktree, remove worker
│        - Worker dead + ticket open → mark ticket failed, nuke worktree
│        - Worker stuck (no progress for N minutes) → optionally steer/kill
│        - Worker commented "blocked" → surface to leader LLM
│     5. Report changes to leader LLM via sendMessage (custom type)
│
└── On cleanup:
    - Kill all workers
    - Nuke all worktrees
    - Close/archive tickets
```

```
Worker (child Pi process)
├── Reads ticket ID from env
├── Reads ticket from tk (gets subject + description)
├── System prompt includes:
│   "You are a worker. Your task is described in ticket #<id>.
│    Comment on the ticket to communicate with the leader.
│    When done, close the ticket with your result summary."
├── Does the work (has full Pi tools)
├── Comments on ticket as it goes (progress, questions, blockers)
├── When done: closes ticket via tk, then exits
└── On crash: process exits non-zero, leader detects via polling
```

## Communication via tk Tickets

The ticket IS the mailbox. No separate protocol.

### Leader → Worker
- **Initial task**: ticket subject + description (worker reads on startup)
- **Follow-up instructions**: leader comments on the ticket. Worker's system prompt tells it to check for new comments periodically (or leader steers via `sendUserMessage` on the worker session).

### Worker → Leader
- **Progress**: worker comments on ticket ("working on X", "50% done")
- **Blocked/question**: worker comments ("blocked: need API key for Y")
- **Done**: worker closes ticket (tk close), adds result as final comment
- **Failed**: worker comments with error, closes ticket as failed

### Leader reads state from two sources
1. **tk ticket**: status (open/closed/failed), comments (communication log)
2. **Worker session**: latest entries (what the LLM is actually doing right now)

The ticket is the **durable** record. The session peek is the **live** view.

## Worker Lifecycle

```
SPAWNING → RUNNING → DONE
                  → FAILED
                  → KILLED (by leader)

SPAWNING:
  - Leader creates ticket, worktree, spawns process
  - Worker reads ticket, starts working

RUNNING:
  - Worker is alive, ticket is open
  - Leader can peek session, read ticket comments

DONE:
  - Worker closed ticket, process exited 0
  - Leader harvests result from ticket, nukes worktree

FAILED:
  - Process exited non-zero, or ticket still open but process dead
  - Leader marks ticket failed, nukes worktree

KILLED:
  - Leader sends SIGTERM, waits briefly, then SIGKILL
  - Leader marks ticket failed, nukes worktree
```

## Worktree Management

Each worker gets a fresh worktree branched from the current HEAD:

```bash
git worktree add <teams-dir>/<worker-name> -b teams/<worker-name>/<ticket-id> HEAD
```

On completion (success or failure):
```bash
# If successful, leader can merge or cherry-pick
git worktree remove <teams-dir>/<worker-name> --force
git branch -D teams/<worker-name>/<ticket-id>  # if not merged
```

Worktrees are always nuked after the worker exits. No reuse.

## Leader Polling Loop

```typescript
const POLL_INTERVAL_MS = 3000;
const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes no progress

setInterval(async () => {
  for (const worker of activeWorkers) {
    const alive = isProcessAlive(worker.pid);
    const ticket = await tk.get(worker.ticketId);
    
    if (ticket.status === "done" || ticket.status === "closed") {
      // Success: harvest result
      await harvestResult(worker, ticket);
      await nukeWorktree(worker);
      removeWorker(worker);
      notifyLeaderLLM(`Worker ${worker.name} completed ticket #${worker.ticketId}`);
      continue;
    }

    if (!alive) {
      // Crashed: mark failed
      await tk.comment(worker.ticketId, "Worker process died unexpectedly");
      await tk.close(worker.ticketId, { status: "failed" });
      await nukeWorktree(worker);
      removeWorker(worker);
      notifyLeaderLLM(`Worker ${worker.name} crashed on ticket #${worker.ticketId}`);
      continue;
    }

    // Alive + open: check progress
    const session = SessionManager.open(worker.sessionFile);
    const leaf = session.getLeafEntry();
    const lastActivity = leaf?.timestamp ?? worker.spawnedAt;
    
    if (Date.now() - lastActivity > STUCK_THRESHOLD_MS) {
      notifyLeaderLLM(`Worker ${worker.name} may be stuck on ticket #${worker.ticketId} (no activity for 5m)`);
    }

    // Check for new comments from worker (questions, blockers)
    const newComments = getNewComments(ticket, worker.lastSeenCommentId);
    for (const comment of newComments) {
      notifyLeaderLLM(`Worker ${worker.name} on ticket #${worker.ticketId}: ${comment.text}`);
      worker.lastSeenCommentId = comment.id;
    }
  }
}, POLL_INTERVAL_MS);
```

## tk Integration

Workers interact with `tk` directly via CLI (since they have bash):

```bash
# Worker reads its ticket
tk show $PI_TEAMS_TICKET_ID

# Worker comments on progress
tk comment $PI_TEAMS_TICKET_ID "Implementing auth middleware"

# Worker marks done
tk done $PI_TEAMS_TICKET_ID "Completed: added auth middleware with JWT validation"

# Worker marks blocked
tk comment $PI_TEAMS_TICKET_ID "BLOCKED: need database credentials"
```

Leader uses `tk` programmatically (via `pi.exec`):

```bash
# Create ticket for worker
tk add -d "Implement auth middleware" -t team,worker:alice --start "Implement auth middleware"

# Comment on worker's ticket
tk comment <id> "Try using the existing JWT helper in lib/auth.ts"

# List team tickets
tk list -t team
```

## File Structure (in-package)

```
extensions/
  teams/
    index.ts          # entry point: leader vs worker routing
    leader.ts         # leader setup: commands, tool, polling loop
    worker.ts         # worker setup: read ticket, prompt injection, exit handling
    polling.ts        # polling loop logic (session peek, ticket check, stuck detection)
    spawner.ts        # child process spawning + worktree creation
    cleanup.ts        # worktree nuking, process cleanup
    types.ts          # shared types (WorkerState, TeamConfig, etc.)
  lib/
    tool-ui-utils.ts  # (existing)
```

## Testing Strategy

Three tiers, all using `bun test`:

### Tier 1: Unit tests (no Pi, no processes)
Fast, deterministic, test pure logic:

- **Ticket parsing**: read tk output, extract status/comments/metadata
- **Worker state machine**: SPAWNING → RUNNING → DONE/FAILED/KILLED transitions
- **Polling logic**: given (processAlive, ticketStatus, lastActivity) → expected action
- **Stuck detection**: time-based thresholds
- **Worktree path generation**: deterministic naming

```
tests/
  teams/
    worker-state.test.ts
    polling-logic.test.ts
    ticket-parsing.test.ts
    worktree-paths.test.ts
```

### Tier 2: Integration tests (real tk, real filesystem, no Pi)
Test tk + filesystem interactions without spawning Pi:

- Create ticket via `tk`, read it back, verify fields
- Comment on ticket, verify comment appears
- Close ticket, verify status change
- Create/remove git worktrees
- Simulate worker lifecycle (create ticket → update → close → cleanup)

```
tests/
  teams/
    tk-integration.test.ts
    worktree-integration.test.ts
    lifecycle-integration.test.ts
```

### Tier 3: E2E tests (real Pi processes)
Full leader + worker flow:

- Leader creates ticket, spawns worker, worker does trivial task, closes ticket, leader detects completion
- Worker crashes mid-task, leader detects and cleans up
- Leader kills worker, verifies cleanup
- Multiple workers running concurrently
- Worker comments "blocked", leader sees it

```
tests/
  teams/
    e2e-single-worker.test.ts
    e2e-worker-crash.test.ts
    e2e-leader-kill.test.ts
    e2e-multi-worker.test.ts
    e2e-communication.test.ts
```

### Test helpers

```typescript
// Spawn a real Pi worker pointing at a temp tk project
async function spawnTestWorker(ticketId: string, opts?: { cwd?: string }) → { pid, sessionFile, cleanup }

// Create a temp git repo with tk initialized
async function createTestRepo() → { dir, cleanup }

// Wait for ticket status change with timeout
async function waitForTicketStatus(id: string, status: string, timeoutMs?: number) → Ticket
```

## Minimal Viable Scope (Phase 1)

1. Leader extension with `teams` tool (delegate action only)
2. Worker extension (read ticket, do work, comment, close)
3. Polling loop (process alive check, ticket status, session peek)
4. Worktree create/nuke
5. Spawner (child Pi process with env vars)
6. Tier 1 + Tier 2 tests passing
7. One E2E test (happy path: create → work → done → cleanup)

## Out of Scope (Later Phases)

- Plan approval / governance mode
- Hooks / quality gates
- Dependency tracking between tickets (tk already supports deps)
- UI widget / panel (use `/team list` and tk commands for now)
- Session branching (clone leader context into worker)
- Style system (soviet/pirate naming)
- Attach/detach (join existing team)
- Scale optimizations for 10+ workers
