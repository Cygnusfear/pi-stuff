# Agent Teams Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a reliable multi-agent team system where the leader delegates work via `tk` tickets to disposable child Pi workers, polls their progress, and cleans up after them.

**Architecture:** Leader extension creates tickets + spawns child `pi` processes per task. Workers read their ticket, do the work, comment progress, close when done. Leader polls every 3s: checks process alive, peeks worker session, reads ticket state. Worktrees are nuked after each task.

**Tech Stack:** TypeScript, Pi extension API, `tk` CLI, `git worktree`, `bun test`, `SessionManager`

---

### Task 1: Types and constants

**Files:**
- Create: `extensions/teams/types.ts`

**Step 1: Write the types file**

```typescript
// Worker states
export type WorkerStatus = "spawning" | "running" | "done" | "failed" | "killed";

// What the leader tracks per worker
export interface WorkerHandle {
  name: string;
  pid: number;
  ticketId: string;
  sessionFile: string;
  worktreePath: string | null; // null if shared workspace
  status: WorkerStatus;
  spawnedAt: number;
  lastActivityAt: number;
  lastSeenCommentCount: number;
}

// Config for spawning a worker
export interface SpawnConfig {
  ticketId: string;
  workerName: string;
  useWorktree: boolean;
  cwd: string; // leader's cwd
  leaderSessionFile: string;
}

// What the polling loop reports back
export type PollEvent =
  | { type: "completed"; worker: WorkerHandle; result: string }
  | { type: "failed"; worker: WorkerHandle; reason: string }
  | { type: "stuck"; worker: WorkerHandle; idleSeconds: number }
  | { type: "comment"; worker: WorkerHandle; comment: string }
  | { type: "alive"; worker: WorkerHandle };

export const POLL_INTERVAL_MS = 3000;
export const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
export const TEAMS_TAG = "team";
export const WORKER_ENV_PREFIX = "PI_TEAMS";
```

**Step 2: Commit**

```bash
git add extensions/teams/types.ts
git commit -m "feat(teams): add core types and constants"
```

---

### Task 2: Ticket helpers (unit-testable)

**Files:**
- Create: `extensions/teams/tickets.ts`
- Create: `tests/teams/tickets.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/teams/tickets.test.ts
import { describe, test, expect } from "bun:test";
import { parseTicketShow, extractNotes, getNewNotes } from "../extensions/teams/tickets";

describe("parseTicketShow", () => {
  test("parses ticket with notes", () => {
    const raw = `---
id: p-abc1
status: in_progress
deps: []
links: []
created: 2026-02-12T07:02:23Z
type: task
priority: 2
assignee: alice
tags: [team]
---
# Do the thing

Some description

## Notes

**2026-02-12T20:00:00Z**

started working

**2026-02-12T20:05:00Z**

halfway done
`;
    const ticket = parseTicketShow(raw);
    expect(ticket.id).toBe("p-abc1");
    expect(ticket.status).toBe("in_progress");
    expect(ticket.assignee).toBe("alice");
    expect(ticket.subject).toBe("Do the thing");
    expect(ticket.description).toBe("Some description");
    expect(ticket.notes).toHaveLength(2);
    expect(ticket.notes[0].text).toBe("started working");
    expect(ticket.notes[1].text).toBe("halfway done");
  });

  test("parses ticket without notes", () => {
    const raw = `---
id: p-abc2
status: open
deps: []
links: []
created: 2026-02-12T07:02:23Z
type: task
priority: 2
---
# Simple task
`;
    const ticket = parseTicketShow(raw);
    expect(ticket.id).toBe("p-abc2");
    expect(ticket.status).toBe("open");
    expect(ticket.notes).toHaveLength(0);
  });
});

describe("getNewNotes", () => {
  test("returns notes after lastSeen count", () => {
    const notes = [
      { timestamp: "2026-02-12T20:00:00Z", text: "first" },
      { timestamp: "2026-02-12T20:01:00Z", text: "second" },
      { timestamp: "2026-02-12T20:02:00Z", text: "third" },
    ];
    expect(getNewNotes(notes, 1)).toEqual([
      { timestamp: "2026-02-12T20:01:00Z", text: "second" },
      { timestamp: "2026-02-12T20:02:00Z", text: "third" },
    ]);
  });

  test("returns empty if no new notes", () => {
    const notes = [{ timestamp: "t", text: "only" }];
    expect(getNewNotes(notes, 1)).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
bun test tests/teams/tickets.test.ts
```

**Step 3: Write the implementation**

```typescript
// extensions/teams/tickets.ts

export interface TicketNote {
  timestamp: string;
  text: string;
}

export interface ParsedTicket {
  id: string;
  status: string;
  assignee?: string;
  subject: string;
  description: string;
  notes: TicketNote[];
  tags: string[];
}

export function parseTicketShow(raw: string): ParsedTicket {
  const lines = raw.split("\n");
  let inFrontmatter = false;
  let pastFrontmatter = false;
  const frontmatter: Record<string, string> = {};
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter && !pastFrontmatter) {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        inFrontmatter = false;
        pastFrontmatter = true;
        continue;
      }
    }
    if (inFrontmatter) {
      const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (match) frontmatter[match[1]] = match[2].trim();
      continue;
    }
    if (pastFrontmatter) bodyLines.push(line);
  }

  const body = bodyLines.join("\n");
  const notesIdx = body.indexOf("## Notes");

  let contentPart = notesIdx >= 0 ? body.slice(0, notesIdx) : body;
  const notesPart = notesIdx >= 0 ? body.slice(notesIdx) : "";

  // Extract subject from first # heading
  let subject = "";
  const subjectMatch = contentPart.match(/^#\s+(.+)$/m);
  if (subjectMatch) {
    subject = subjectMatch[1].trim();
    contentPart = contentPart.replace(/^#\s+.+$/m, "");
  }

  const description = contentPart.trim();
  const notes = parseNotes(notesPart);

  let tags: string[] = [];
  const tagsRaw = frontmatter.tags ?? "";
  if (tagsRaw.startsWith("[")) {
    try {
      tags = JSON.parse(tagsRaw);
    } catch {
      tags = tagsRaw.replace(/[\[\]]/g, "").split(",").map(s => s.trim()).filter(Boolean);
    }
  }

  return {
    id: frontmatter.id ?? "",
    status: frontmatter.status ?? "open",
    assignee: frontmatter.assignee || undefined,
    subject,
    description,
    notes,
    tags,
  };
}

function parseNotes(notesPart: string): TicketNote[] {
  if (!notesPart) return [];
  const notes: TicketNote[] = [];
  const timestampRe = /^\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\*\*$/;
  let currentTs = "";
  let currentLines: string[] = [];

  for (const line of notesPart.split("\n")) {
    if (line.startsWith("## Notes")) continue;
    const m = line.match(timestampRe);
    if (m) {
      if (currentTs) {
        notes.push({ timestamp: currentTs, text: currentLines.join("\n").trim() });
      }
      currentTs = m[1];
      currentLines = [];
    } else if (currentTs) {
      currentLines.push(line);
    }
  }
  if (currentTs) {
    notes.push({ timestamp: currentTs, text: currentLines.join("\n").trim() });
  }
  return notes;
}

export function getNewNotes(notes: TicketNote[], lastSeenCount: number): TicketNote[] {
  return notes.slice(lastSeenCount);
}
```

**Step 4: Run test to verify it passes**

```bash
bun test tests/teams/tickets.test.ts
```

**Step 5: Commit**

```bash
git add extensions/teams/tickets.ts tests/teams/tickets.test.ts
git commit -m "feat(teams): ticket parsing with notes extraction + tests"
```

---

### Task 3: Worker state machine (unit-testable)

**Files:**
- Create: `extensions/teams/state.ts`
- Create: `tests/teams/state.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/teams/state.test.ts
import { describe, test, expect } from "bun:test";
import { nextWorkerStatus } from "../extensions/teams/state";

describe("nextWorkerStatus", () => {
  test("running + ticket closed → done", () => {
    expect(nextWorkerStatus("running", { processAlive: true, ticketClosed: true })).toBe("done");
  });

  test("running + process dead + ticket open → failed", () => {
    expect(nextWorkerStatus("running", { processAlive: false, ticketClosed: false })).toBe("failed");
  });

  test("running + process alive + ticket open → running", () => {
    expect(nextWorkerStatus("running", { processAlive: true, ticketClosed: false })).toBe("running");
  });

  test("spawning + process alive → running", () => {
    expect(nextWorkerStatus("spawning", { processAlive: true, ticketClosed: false })).toBe("running");
  });

  test("spawning + process dead → failed", () => {
    expect(nextWorkerStatus("spawning", { processAlive: false, ticketClosed: false })).toBe("failed");
  });

  test("done stays done", () => {
    expect(nextWorkerStatus("done", { processAlive: false, ticketClosed: true })).toBe("done");
  });

  test("failed stays failed", () => {
    expect(nextWorkerStatus("failed", { processAlive: false, ticketClosed: false })).toBe("failed");
  });

  test("killed stays killed", () => {
    expect(nextWorkerStatus("killed", { processAlive: false, ticketClosed: false })).toBe("killed");
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write the implementation**

```typescript
// extensions/teams/state.ts
import type { WorkerStatus } from "./types.js";

export interface StatusInput {
  processAlive: boolean;
  ticketClosed: boolean;
}

const TERMINAL: WorkerStatus[] = ["done", "failed", "killed"];

export function nextWorkerStatus(current: WorkerStatus, input: StatusInput): WorkerStatus {
  if (TERMINAL.includes(current)) return current;

  if (input.ticketClosed) return "done";
  if (!input.processAlive) return "failed";
  if (current === "spawning") return "running";
  return "running";
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add extensions/teams/state.ts tests/teams/state.test.ts
git commit -m "feat(teams): worker state machine + tests"
```

---

### Task 4: Polling logic (unit-testable)

**Files:**
- Create: `extensions/teams/polling.ts`
- Create: `tests/teams/polling.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/teams/polling.test.ts
import { describe, test, expect } from "bun:test";
import { computePollEvents } from "../extensions/teams/polling";
import type { WorkerHandle } from "../extensions/teams/types";

const makeWorker = (overrides?: Partial<WorkerHandle>): WorkerHandle => ({
  name: "alice",
  pid: 1234,
  ticketId: "p-abc1",
  sessionFile: "/tmp/session.jsonl",
  worktreePath: null,
  status: "running",
  spawnedAt: Date.now() - 10000,
  lastActivityAt: Date.now(),
  lastSeenCommentCount: 0,
  ...overrides,
});

describe("computePollEvents", () => {
  test("ticket closed + alive → completed", () => {
    const events = computePollEvents(makeWorker(), {
      processAlive: true,
      ticketStatus: "closed",
      ticketNotes: [{ timestamp: "t", text: "done: result here" }],
      lastSeenCommentCount: 0,
      sessionLastActivityAt: Date.now(),
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "completed" }));
  });

  test("process dead + ticket open → failed", () => {
    const events = computePollEvents(makeWorker(), {
      processAlive: false,
      ticketStatus: "open",
      ticketNotes: [],
      lastSeenCommentCount: 0,
      sessionLastActivityAt: Date.now(),
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "failed" }));
  });

  test("new comments → comment events", () => {
    const events = computePollEvents(makeWorker({ lastSeenCommentCount: 1 }), {
      processAlive: true,
      ticketStatus: "in_progress",
      ticketNotes: [
        { timestamp: "t1", text: "old" },
        { timestamp: "t2", text: "new comment" },
      ],
      lastSeenCommentCount: 1,
      sessionLastActivityAt: Date.now(),
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "comment", comment: "new comment" }));
  });

  test("no activity for long time → stuck", () => {
    const longAgo = Date.now() - 10 * 60 * 1000;
    const events = computePollEvents(makeWorker({ lastActivityAt: longAgo }), {
      processAlive: true,
      ticketStatus: "in_progress",
      ticketNotes: [],
      lastSeenCommentCount: 0,
      sessionLastActivityAt: longAgo,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "stuck" }));
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write the implementation**

```typescript
// extensions/teams/polling.ts
import type { PollEvent, WorkerHandle } from "./types.js";
import type { TicketNote } from "./tickets.js";
import { getNewNotes } from "./tickets.js";
import { nextWorkerStatus } from "./state.js";
import { STUCK_THRESHOLD_MS } from "./types.js";

export interface PollInput {
  processAlive: boolean;
  ticketStatus: string;
  ticketNotes: TicketNote[];
  lastSeenCommentCount: number;
  sessionLastActivityAt: number;
}

export function computePollEvents(worker: WorkerHandle, input: PollInput): PollEvent[] {
  const events: PollEvent[] = [];

  const ticketClosed = input.ticketStatus === "closed" || input.ticketStatus === "done";
  const newStatus = nextWorkerStatus(worker.status, {
    processAlive: input.processAlive,
    ticketClosed,
  });

  if (newStatus === "done" && worker.status !== "done") {
    const lastNote = input.ticketNotes.at(-1);
    events.push({
      type: "completed",
      worker: { ...worker, status: newStatus },
      result: lastNote?.text ?? "(no result)",
    });
    return events; // terminal
  }

  if (newStatus === "failed" && worker.status !== "failed") {
    events.push({
      type: "failed",
      worker: { ...worker, status: newStatus },
      reason: input.processAlive ? "ticket failed" : "process died",
    });
    return events; // terminal
  }

  // New comments from worker
  const newNotes = getNewNotes(input.ticketNotes, input.lastSeenCommentCount);
  for (const note of newNotes) {
    events.push({
      type: "comment",
      worker: { ...worker, status: newStatus },
      comment: note.text,
    });
  }

  // Stuck detection
  const lastActivity = Math.max(input.sessionLastActivityAt, worker.lastActivityAt);
  if (Date.now() - lastActivity > STUCK_THRESHOLD_MS) {
    events.push({
      type: "stuck",
      worker: { ...worker, status: newStatus },
      idleSeconds: Math.floor((Date.now() - lastActivity) / 1000),
    });
  }

  return events;
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add extensions/teams/polling.ts tests/teams/polling.test.ts
git commit -m "feat(teams): polling logic with stuck detection + tests"
```

---

### Task 5: Worktree helpers

**Files:**
- Create: `extensions/teams/worktree.ts`
- Create: `tests/teams/worktree.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/teams/worktree.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { createWorktree, removeWorktree, worktreeBranchName } from "../extensions/teams/worktree";
import { mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

function initRepo(): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teams-wt-"));
  execSync("git init && git commit --allow-empty -m init", { cwd: tmpDir, stdio: "pipe" });
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    try {
      execSync(`git worktree prune`, { cwd: tmpDir, stdio: "pipe" });
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("worktreeBranchName", () => {
  test("generates deterministic name", () => {
    expect(worktreeBranchName("alice", "p-abc1")).toBe("teams/alice/p-abc1");
  });
});

describe("createWorktree + removeWorktree", () => {
  test("creates and removes worktree", async () => {
    const repo = initRepo();
    const wtPath = path.join(tmpDir, ".pi-teams", "alice");
    const result = await createWorktree(repo, "alice", "p-abc1", wtPath);
    expect(result.success).toBe(true);
    expect(result.path).toBe(wtPath);

    const rmResult = await removeWorktree(repo, wtPath, "teams/alice/p-abc1");
    expect(rmResult.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

**Step 3: Write the implementation**

```typescript
// extensions/teams/worktree.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function worktreeBranchName(workerName: string, ticketId: string): string {
  return `teams/${workerName}/${ticketId}`;
}

export async function createWorktree(
  repoDir: string,
  workerName: string,
  ticketId: string,
  worktreePath: string,
): Promise<{ success: boolean; path: string; error?: string }> {
  const branch = worktreeBranchName(workerName, ticketId);
  try {
    await exec("git", ["worktree", "add", worktreePath, "-b", branch, "HEAD"], { cwd: repoDir });
    return { success: true, path: worktreePath };
  } catch (err) {
    return { success: false, path: worktreePath, error: String(err) };
  }
}

export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoDir });
  } catch {
    // worktree may already be gone
  }
  try {
    await exec("git", ["branch", "-D", branch], { cwd: repoDir });
  } catch {
    // branch may already be gone
  }
  return { success: true };
}
```

**Step 4: Run test, verify pass**

**Step 5: Commit**

```bash
git add extensions/teams/worktree.ts tests/teams/worktree.test.ts
git commit -m "feat(teams): worktree create/remove helpers + tests"
```

---

### Task 6: Spawner (spawn child Pi process)

**Files:**
- Create: `extensions/teams/spawner.ts`

**Step 1: Write the implementation**

```typescript
// extensions/teams/spawner.ts
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { SpawnConfig, WorkerHandle } from "./types.js";
import { TEAMS_TAG } from "./types.js";

export function spawnWorker(config: SpawnConfig): { process: ChildProcess; handle: WorkerHandle } {
  const env: Record<string, string> = {
    ...process.env,
    PI_TEAMS_WORKER: "1",
    PI_TEAMS_TICKET_ID: config.ticketId,
    PI_TEAMS_LEADER_SESSION: config.leaderSessionFile,
    PI_TEAMS_WORKER_NAME: config.workerName,
  };

  const cwd = config.useWorktree ? config.cwd : config.cwd; // worktree path passed as cwd
  const sessionDir = path.join(cwd, ".pi", "sessions", `team-${config.workerName}-${config.ticketId}`);

  const child = spawn("pi", [
    "--non-interactive",
    "--session-dir", sessionDir,
    "-p", buildWorkerPrompt(config.ticketId, config.workerName),
  ], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const sessionFile = path.join(sessionDir, "session.jsonl");

  const handle: WorkerHandle = {
    name: config.workerName,
    pid: child.pid!,
    ticketId: config.ticketId,
    sessionFile,
    worktreePath: config.useWorktree ? cwd : null,
    status: "spawning",
    spawnedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastSeenCommentCount: 0,
  };

  return { process: child, handle };
}

function buildWorkerPrompt(ticketId: string, workerName: string): string {
  return [
    `You are worker "${workerName}". You have been assigned ticket ${ticketId}.`,
    "",
    "Instructions:",
    `1. Read your ticket: tk show ${ticketId}`,
    "2. Do the work described in the ticket.",
    `3. Comment on the ticket as you work: tk add-note ${ticketId} "your progress"`,
    `4. When done, close the ticket with a result summary: tk add-note ${ticketId} "DONE: <summary>" && tk close ${ticketId}`,
    `5. If you are blocked, comment: tk add-note ${ticketId} "BLOCKED: <reason>"`,
    "",
    "Stay focused on the ticket. Do not ask for confirmation — just do the work.",
  ].join("\n");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killWorker(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  // Force kill after 5s
  setTimeout(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }, 5000);
}
```

**Step 2: Commit**

```bash
git add extensions/teams/spawner.ts
git commit -m "feat(teams): worker spawner with prompt injection"
```

---

### Task 7: Cleanup module

**Files:**
- Create: `extensions/teams/cleanup.ts`

**Step 1: Write the implementation**

```typescript
// extensions/teams/cleanup.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { WorkerHandle } from "./types.js";
import { killWorker, isProcessAlive } from "./spawner.js";
import { removeWorktree, worktreeBranchName } from "./worktree.js";

export async function cleanupWorker(
  pi: ExtensionAPI,
  repoDir: string,
  worker: WorkerHandle,
): Promise<void> {
  // Kill process if still alive
  if (isProcessAlive(worker.pid)) {
    killWorker(worker.pid);
  }

  // Nuke worktree if it exists
  if (worker.worktreePath) {
    const branch = worktreeBranchName(worker.name, worker.ticketId);
    await removeWorktree(repoDir, worker.worktreePath, branch);
  }
}

export async function cleanupAllWorkers(
  pi: ExtensionAPI,
  repoDir: string,
  workers: WorkerHandle[],
): Promise<void> {
  await Promise.all(workers.map(w => cleanupWorker(pi, repoDir, w)));
}
```

**Step 2: Commit**

```bash
git add extensions/teams/cleanup.ts
git commit -m "feat(teams): worker cleanup (kill + nuke worktree)"
```

---

### Task 8: Leader core (polling loop + worker management)

**Files:**
- Create: `extensions/teams/leader.ts`

**Step 1: Write the implementation**

This is the main orchestrator. It:
- Tracks active workers
- Runs the polling loop
- Reports events to the LLM via `pi.sendMessage`

```typescript
// extensions/teams/leader.ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { WorkerHandle, SpawnConfig, PollEvent } from "./types.js";
import { POLL_INTERVAL_MS, TEAMS_TAG } from "./types.js";
import { spawnWorker, isProcessAlive, killWorker } from "./spawner.js";
import { computePollEvents, type PollInput } from "./polling.js";
import { parseTicketShow } from "./tickets.js";
import { createWorktree, worktreeBranchName } from "./worktree.js";
import { cleanupWorker } from "./cleanup.js";
import path from "node:path";

export class TeamLeader {
  private workers = new Map<string, WorkerHandle>();
  private childProcesses = new Map<string, import("node:child_process").ChildProcess>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pi: ExtensionAPI;
  private ctx: ExtensionContext | null = null;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  setContext(ctx: ExtensionContext) {
    this.ctx = ctx;
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async delegate(ticketId: string, workerName: string, useWorktree: boolean): Promise<WorkerHandle> {
    if (!this.ctx) throw new Error("Leader context not set");

    const repoDir = this.ctx.cwd;
    let cwd = repoDir;

    if (useWorktree) {
      const wtPath = path.join(repoDir, ".pi-teams", workerName);
      const result = await createWorktree(repoDir, workerName, ticketId, wtPath);
      if (!result.success) throw new Error(`Worktree creation failed: ${result.error}`);
      cwd = wtPath;
    }

    const sessionFile = this.ctx.sessionManager.getSessionFile() ?? "";
    const config: SpawnConfig = {
      ticketId,
      workerName,
      useWorktree,
      cwd,
      leaderSessionFile: sessionFile,
    };

    const { process: child, handle } = spawnWorker(config);
    this.workers.set(workerName, handle);
    this.childProcesses.set(workerName, child);

    child.on("exit", () => {
      // Process exit will be detected on next poll
    });

    return handle;
  }

  async kill(workerName: string): Promise<void> {
    const worker = this.workers.get(workerName);
    if (!worker) return;
    worker.status = "killed";
    if (this.ctx) {
      await cleanupWorker(this.pi, this.ctx.cwd, worker);
    }
    this.workers.delete(workerName);
    this.childProcesses.delete(workerName);
  }

  async killAll(): Promise<void> {
    for (const name of [...this.workers.keys()]) {
      await this.kill(name);
    }
  }

  getWorkers(): WorkerHandle[] {
    return [...this.workers.values()];
  }

  getWorker(name: string): WorkerHandle | undefined {
    return this.workers.get(name);
  }

  private async poll() {
    if (!this.ctx) return;

    for (const [name, worker] of this.workers) {
      if (["done", "failed", "killed"].includes(worker.status)) continue;

      try {
        // 1. Check process
        const alive = isProcessAlive(worker.pid);

        // 2. Read ticket
        const tkResult = await this.pi.exec("tk", ["show", worker.ticketId], {
          cwd: this.ctx.cwd,
          timeout: 5000,
        });
        const ticket = parseTicketShow(tkResult.stdout ?? "");

        // 3. Peek session (best-effort)
        let sessionLastActivity = worker.spawnedAt;
        try {
          const sm = SessionManager.open(worker.sessionFile);
          const leaf = sm.getLeafEntry();
          if (leaf?.timestamp) sessionLastActivity = leaf.timestamp;
        } catch {
          // session file may not exist yet
        }

        // 4. Compute events
        const input: PollInput = {
          processAlive: alive,
          ticketStatus: ticket.status,
          ticketNotes: ticket.notes,
          lastSeenCommentCount: worker.lastSeenCommentCount,
          sessionLastActivityAt: sessionLastActivity,
        };

        const events = computePollEvents(worker, input);

        // 5. Update worker state + notify leader LLM
        for (const event of events) {
          worker.status = event.worker.status;
          worker.lastActivityAt = Date.now();

          if (event.type === "comment") {
            worker.lastSeenCommentCount = ticket.notes.length;
          }

          this.notifyLLM(event);

          if (event.type === "completed" || event.type === "failed") {
            await cleanupWorker(this.pi, this.ctx.cwd, worker);
            this.workers.delete(name);
            this.childProcesses.delete(name);
            break;
          }
        }
      } catch (err) {
        // Polling error for this worker; skip, try again next cycle
      }
    }
  }

  private notifyLLM(event: PollEvent) {
    const msg = formatPollEvent(event);
    this.pi.sendMessage({
      customType: "team-event",
      content: msg,
      display: true,
    }, { deliverAs: "followUp" });
  }
}

function formatPollEvent(event: PollEvent): string {
  switch (event.type) {
    case "completed":
      return `✅ Worker "${event.worker.name}" completed ticket #${event.worker.ticketId}:\n${event.result}`;
    case "failed":
      return `❌ Worker "${event.worker.name}" failed on ticket #${event.worker.ticketId}: ${event.reason}`;
    case "stuck":
      return `⚠️ Worker "${event.worker.name}" may be stuck on ticket #${event.worker.ticketId} (${event.idleSeconds}s idle)`;
    case "comment":
      return `💬 Worker "${event.worker.name}" on ticket #${event.worker.ticketId}: ${event.comment}`;
    case "alive":
      return `Worker "${event.worker.name}" is alive, working on ticket #${event.worker.ticketId}`;
  }
}
```

**Step 2: Commit**

```bash
git add extensions/teams/leader.ts
git commit -m "feat(teams): leader core with polling loop and worker management"
```

---

### Task 9: Teams tool + extension entry point

**Files:**
- Create: `extensions/teams/index.ts`
- Create: `extensions/teams/tool.ts`

**Step 1: Write the teams tool**

```typescript
// extensions/teams/tool.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamLeader } from "./leader.js";

const TeamsParams = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("delegate"),
    Type.Literal("list"),
    Type.Literal("kill"),
    Type.Literal("kill_all"),
  ])),
  tasks: Type.Optional(Type.Array(Type.Object({
    text: Type.String({ description: "Task description" }),
    assignee: Type.Optional(Type.String({ description: "Worker name" })),
  }))),
  name: Type.Optional(Type.String({ description: "Worker name for kill action" })),
  useWorktree: Type.Optional(Type.Boolean({ description: "Give each worker its own git worktree", default: true })),
});

export function registerTeamsTool(pi: ExtensionAPI, leader: TeamLeader) {
  pi.registerTool({
    name: "teams",
    label: "Teams",
    description: `Coordinate a team of worker agents.

Actions:
- delegate: Create tickets and spawn workers. Provide "tasks" array with { text, assignee? }.
- list: Show all active workers and their status.
- kill: Kill a specific worker by name.
- kill_all: Kill all workers.`,
    parameters: TeamsParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      leader.setContext(ctx);
      const action = params.action ?? "delegate";

      if (action === "list") {
        const workers = leader.getWorkers();
        if (workers.length === 0) {
          return { content: [{ type: "text", text: "No active workers." }] };
        }
        const lines = workers.map(w =>
          `${w.name}: ${w.status} | ticket #${w.ticketId} | pid ${w.pid}`
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      if (action === "kill") {
        if (!params.name) return { content: [{ type: "text", text: "Provide worker name." }], isError: true };
        await leader.kill(params.name);
        return { content: [{ type: "text", text: `Killed worker "${params.name}"` }] };
      }

      if (action === "kill_all") {
        await leader.killAll();
        return { content: [{ type: "text", text: "All workers killed." }] };
      }

      if (action === "delegate") {
        if (!params.tasks?.length) {
          return { content: [{ type: "text", text: "Provide tasks array." }], isError: true };
        }

        const useWorktree = params.useWorktree ?? true;
        const results: string[] = [];
        let workerIdx = 0;

        for (const task of params.tasks) {
          const workerName = task.assignee ?? `worker-${++workerIdx}`;

          // Create ticket via tk
          const createResult = await pi.exec("tk", [
            "create", task.text,
            "-d", task.text,
            "--tags", "team",
            "-a", workerName,
          ], { cwd: ctx.cwd, timeout: 5000 });

          const ticketId = (createResult.stdout ?? "").trim();
          if (!ticketId || createResult.code !== 0) {
            results.push(`Failed to create ticket for "${task.text}": ${createResult.stderr}`);
            continue;
          }

          // Start the ticket
          await pi.exec("tk", ["start", ticketId], { cwd: ctx.cwd, timeout: 5000 });

          try {
            const handle = await leader.delegate(ticketId, workerName, useWorktree);
            results.push(`Spawned "${workerName}" → ticket #${ticketId} (pid ${handle.pid})`);
          } catch (err) {
            results.push(`Failed to spawn "${workerName}": ${err}`);
          }
        }

        leader.startPolling();
        return { content: [{ type: "text", text: results.join("\n") }] };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
    },
  });
}
```

**Step 2: Write the entry point**

```typescript
// extensions/teams/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TeamLeader } from "./leader.js";
import { registerTeamsTool } from "./tool.js";

const IS_WORKER = process.env.PI_TEAMS_WORKER === "1";

export default function (pi: ExtensionAPI) {
  if (IS_WORKER) {
    // Worker mode: handled by worker.ts (Task 10)
    return;
  }

  // Leader mode
  const leader = new TeamLeader(pi);
  registerTeamsTool(pi, leader);

  pi.on("session_start", (_event, ctx) => {
    leader.setContext(ctx);
  });

  pi.on("session_shutdown", async () => {
    leader.stopPolling();
    await leader.killAll();
  });
}
```

**Step 3: Commit**

```bash
git add extensions/teams/index.ts extensions/teams/tool.ts
git commit -m "feat(teams): teams tool + extension entry point"
```

---

### Task 10: Worker extension (reads ticket, works, comments, closes)

**Files:**
- Create: `extensions/teams/worker.ts`

**Step 1: Write the implementation**

```typescript
// extensions/teams/worker.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function runWorker(pi: ExtensionAPI): void {
  const ticketId = process.env.PI_TEAMS_TICKET_ID;
  const workerName = process.env.PI_TEAMS_WORKER_NAME ?? "worker";

  if (!ticketId) {
    console.error("[teams-worker] PI_TEAMS_TICKET_ID not set");
    return;
  }

  // Register a convenience tool for commenting on the ticket
  pi.registerTool({
    name: "team_comment",
    label: "Team Comment",
    description: `Comment on your assigned ticket (${ticketId}). Use this to report progress, ask questions, or flag blockers.`,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Your comment" },
      },
      required: ["message"],
    } as any,
    async execute(_id, params: { message: string }, _signal, _onUpdate, ctx) {
      const result = await pi.exec("tk", ["add-note", ticketId, params.message], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
      if (result.code !== 0) {
        return {
          content: [{ type: "text", text: `Failed to comment: ${result.stderr}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Commented on ticket #${ticketId}` }] };
    },
  });

  // On agent end (work finished), close the ticket
  pi.on("agent_end", async (event, ctx) => {
    // Add final result as note, then close
    try {
      await pi.exec("tk", ["add-note", ticketId, "DONE: Task completed."], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
      await pi.exec("tk", ["close", ticketId], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
    } catch {
      // best effort
    }
  });
}
```

**Step 2: Update index.ts to import worker**

Update `extensions/teams/index.ts`:
```typescript
import { runWorker } from "./worker.js";
// ... in the IS_WORKER branch:
if (IS_WORKER) {
  runWorker(pi);
  return;
}
```

**Step 3: Commit**

```bash
git add extensions/teams/worker.ts extensions/teams/index.ts
git commit -m "feat(teams): worker extension with ticket commenting + auto-close"
```

---

### Task 11: E2E happy path test

**Files:**
- Create: `tests/teams/e2e-happy-path.test.ts`

**Step 1: Write the test**

```typescript
// tests/teams/e2e-happy-path.test.ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

function initTestRepo(): string {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "teams-e2e-"));
  execSync("git init && git commit --allow-empty -m init", { cwd: tmpDir, stdio: "pipe" });
  execSync("tk create 'test task' -d 'create a file called hello.txt with content hello' --tags team", {
    cwd: tmpDir,
    stdio: "pipe",
  });
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("e2e: happy path", () => {
  test("ticket is created and readable", () => {
    const repo = initTestRepo();
    const ticketsDir = path.join(repo, ".tickets");
    expect(existsSync(ticketsDir)).toBe(true);

    const output = execSync("tk ls --tags team", { cwd: repo, encoding: "utf8" });
    expect(output).toContain("test task");
  });

  // Full e2e with Pi spawn requires PI binary + API keys.
  // This test validates the ticket + worktree lifecycle without Pi.
  test("worktree lifecycle", async () => {
    const repo = initTestRepo();
    const { createWorktree, removeWorktree, worktreeBranchName } = await import("../../extensions/teams/worktree");

    const wtPath = path.join(tmpDir, ".pi-teams", "alice");
    const result = await createWorktree(repo, "alice", "p-test", wtPath);
    expect(result.success).toBe(true);
    expect(existsSync(wtPath)).toBe(true);

    const branch = worktreeBranchName("alice", "p-test");
    const rmResult = await removeWorktree(repo, wtPath, branch);
    expect(rmResult.success).toBe(true);
  });
});
```

**Step 2: Run test**

```bash
bun test tests/teams/e2e-happy-path.test.ts
```

**Step 3: Commit**

```bash
git add tests/teams/e2e-happy-path.test.ts
git commit -m "test(teams): e2e happy path (ticket + worktree lifecycle)"
```

---

### Task 12: Run all tests, verify clean

**Step 1: Run all team tests**

```bash
bun test tests/teams/
```

**Step 2: Type check**

```bash
npx tsc --noEmit
```

**Step 3: Commit any fixes**

---

### Task 13: Final commit + update design doc

**Step 1: Update design doc with "Phase 1 complete" note**

**Step 2: Commit**

```bash
git add -A
git commit -m "feat(teams): phase 1 complete — tk-based disposable workers"
```
