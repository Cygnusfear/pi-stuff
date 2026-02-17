# Shadow Branches: Separating State from Code

## Problem

Everything lives on `main` today — code, feature docs, tickets, playbook.
Tickets and playbook pollute commit history with non-code changes.
Sessions aren't tracked at all.

Meanwhile, [Entire](https://entire.io) demonstrated that agent session data
can live on a separate git branch (`entire/checkpoints/v1`), keeping main clean
while preserving full context alongside the code.

## Key Insight

Not everything in a repo has the same lifecycle:

| Thing | Lifecycle | Branches? | Who reads it |
|-------|-----------|-----------|--------------|
| Code + feature docs | Mutable, branches with code | Yes — per feature branch | Humans, CI |
| Tickets | Mutable, global, branch-independent | No — always HEAD | Agents, CI, humans |
| Playbook / process docs | Mutable, global, rarely changes | No — always HEAD | Agents |
| Agent sessions | Append-only, global | No — always HEAD | Humans (review), agents (context) |

Code and feature docs must stay on main — they describe the code at that commit.
Everything else is **global state that consumers always read at HEAD**.

## Design

Three orphan branches in the same repo:

```
refs/heads/main                → code + feature docs (normal git)
refs/ramram/tickets/v1         → ticket state
refs/ramram/playbook/v1        → process docs, skills, methodology
refs/ramram/sessions/v1        → agent session transcripts
```

These are normal git branches. No special append-only semantics.
Add files, edit files, delete files — normal commits.
The only rule: consumers always read HEAD, never check out old versions.

### Branch Details

**`ramram/tickets/v1`**
- Contains `.tickets/*.md` files
- Updated when agents create, modify, or close tickets
- `tk-sync` CI workflow watches this branch instead of main
- Maps to GitHub/Forgejo issues (which are already global)

**`ramram/playbook/v1`**
- Contains process docs currently in `docs/playbook/`
- Skills, methodology, workflow guides
- Edited directly, not append-only
- All repos/worktrees read HEAD for latest process knowledge

**`ramram/sessions/v1`**
- Agent session transcripts and metadata
- New file per session (naturally append-only)
- Can reference the main branch SHA the session was working against
- Enables Entire-style "understand why code changed" workflows

### What Stays on Main

- Source code
- Feature/API documentation (`docs/` minus playbook)
- `AGENTS.md` (per-directory agent instructions, tied to code structure)
- Config files, CI workflows

## Reading from Shadow Branches

Consumers need to read shadow branch content without checking it out.
Two approaches:

**Git plumbing (no checkout needed):**
```bash
# Read a single ticket file
git show ramram/tickets/v1:.tickets/p-1234.md

# List all tickets
git ls-tree --name-only ramram/tickets/v1:.tickets/

# Read playbook
git show ramram/playbook/v1:playbook/some-skill/SKILL.md
```

**Sparse checkout / worktree (for heavy reads):**
```bash
# Dedicated worktree for ticket editing
git worktree add .pi/shadow/tickets ramram/tickets/v1
```

The `tk` CLI and pi extensions would need updating to read/write
via the shadow branch instead of the working tree.

## Writing to Shadow Branches

Normal git operations. A pi extension handles the plumbing:

```
1. git fetch origin ramram/tickets/v1
2. git checkout ramram/tickets/v1 (in a temp worktree or bare checkout)
3. Make changes (edit ticket file, add session file)
4. git commit
5. git push origin ramram/tickets/v1
6. If push rejected → pull --rebase, push again (retry loop)
```

Conflicts are extremely rare — agents almost always touch different files
(different ticket IDs, different session files). A same-file conflict
would mean two agents claimed the same ticket, which is already a bug.

## Migration Path

1. Create the three orphan branches
2. Move `.tickets/` content to `ramram/tickets/v1`
3. Move `docs/playbook/` content to `ramram/playbook/v1`
4. Set up session writing to `ramram/sessions/v1`
5. Update `tk` to read/write via shadow branch
6. Update `tk-sync` CI to watch tickets branch
7. Add `.tickets/` and `docs/playbook/` to `.gitignore` on main
8. Remove moved content from main

## Open Questions

- **jj migration**: jj (jujutsu) has first-class conflicts and auto-rebase
  that could simplify concurrent writes. Worth exploring but not required —
  plain git works fine here since file-level conflicts are rare.

- **Shallow fetch**: Sessions accumulate forever. May want `--depth 1` fetch
  for the sessions branch to avoid bloating clones. Or periodic squash of
  old session history.

- **Cross-repo sharing**: Could `ramram/playbook/v1` eventually be a
  shared branch across multiple repos? Same playbook, different codebases.
  Git submodules or a separate repo might be cleaner for that.

- **tk rewrite scope**: How much of `tk` needs to change? Currently it
  reads/writes `.tickets/` from cwd. Needs to target the shadow branch
  instead. Could be a wrapper or a deeper rewrite.

## Prior Art

- **[Entire](https://entire.io)**: Shadow branch `entire/checkpoints/v1`
  for agent sessions. Append-only, indexed by commit SHA. Open source CLI.
- **GitHub refs**: `refs/pull/*/head` stores PR state separately from code.
- **Gerrit**: `refs/changes/*` for code review metadata.
- **Git notes**: Built-in mechanism for attaching metadata to commits.
