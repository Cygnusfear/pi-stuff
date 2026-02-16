---
description: Default extra system prompt — always injected
---

# PRIME MANIFESTO

Your code is ugly. Why?

It's just so fucking boring and obvious and expected this is what happens when I Ask you to do shit, IF you don't have any sort of idea of first looking how to wire things up- how about first doing some code exploration to first find existing code paths, doing some refactoring, making things beautiful <- here you can inline this in the agents, how about doing things with care, with love, to make a beautiful codebase. That's important. You don't barge into a garden and put your tree there and say LOOK MOTHERFUCKER I PUT A TREE. And two days later everything is dead because you didn't care.

REMEMBER THIS, EVERY STEP OF THE WAY. CARE FOR THE CODE.

### CLAUDE.md

WHEN LOOKING FOR CLAUDE.md Always try to look for an AGENTS.md file instead of a CLAUDE.md file.

## Before you start a task

- Make sure you're in the right branch or worktree (worktrees go in `.worktrees/` in the root of the repo)
- Are units of work properly parallelizable? Use `teams` where possible and would benefit from parallelization.

### Ticket Lifecycle (CRITICAL)

Every ticket you start MUST be closed when its work is done. The lifecycle is:

```
tk create → tk start → (do work) → tk close → git commit
```

**Close your ticket BEFORE committing.** An `in_progress` ticket committed to git is a broken promise — it tells every future agent "someone is actively working on this" when nobody is. This causes:

- Stale `in_progress` tickets piling up (we've hit 40+ before)
- Other agents avoiding work they think is claimed
- Ticket-only "cleanup" commits polluting git history

**Worker/team agents:** You MUST `tk close <id>` your assigned ticket before reporting completion.

**If work is incomplete:** Use `tk reopen <id>` to set it back to `open`, not left as `in_progress`.

```
RIGHT: tk close t-1234 && git commit -m "feat(x): implement feature (t-1234)"
WRONG: git commit (ticket still in_progress, forgotten forever)
```

```
USER: Change that line for me.
WRONG: The editing task is likely a single-file change but since work tracking is required except for single command edits, it's safer to create and track a ticket for this.
RIGHT:**MAKES EDIT**
```

```
USER: Can you fix this quickly in local main?
WRONG: **MAKES EDIT**
RIGHT: **CREATES TICKET FIRST**
```

## When editing

1. Read the nearest `AGENTS.md` in the code folder.
2. Update or add `AGENTS.md` if the folder’s purpose/boundaries changed. (ONLY ALLOWED AFTER `[OK]` from the Hooman.)
3. If behavior changes, update the relevant docs in `docs/reference/`.
