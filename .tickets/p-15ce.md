---
id: p-15ce
status: closed
deps: []
links: []
created: 2026-02-19T09:14:44Z
type: feature
priority: 1
assignee: Alexander Mangel
tags: [agent, bash, tooling, background]
---
# Add background bash execution support for agents

Investigate current bash tool execution model and implement a way for agents to run commands in the background (start, inspect status/output, and optionally stop) similar to codex/claude code workflows.



## Goal
Enable agents to launch and manage long-running shell commands asynchronously without blocking the main turn.

## Acceptance Criteria
- [ ] Agents can start a bash command in background and immediately regain control.
- [ ] Agents can query background job status and retrieve incremental/final output.
- [ ] Agents can terminate a running background job.
- [ ] Behavior is documented and covered by tests.

## Verification
- [ ] Run test suite for the changed package.
- [ ] Manually verify starting a long-running command, polling status/output, and termination.

## Worktree
- .

## Notes

**2026-02-19T09:21:30Z**

Added `extensions/background-bash.ts` with `bash_bg_start`, `bash_bg_status`, `bash_bg_logs`, `bash_bg_stop`, and `bash_bg_list` tools backed by `BackgroundBashManager` (detached child processes + per-job tmp logs). Added tests in tests/background-bash/manager.test.ts covering start/log capture, stop flow, and paged log reads. Updated README tools table. Verification: `bun test tests/background-bash/manager.test.ts` passes; full `bun test` still has pre-existing missing-module failures in tests/teams/polling.test.ts and tests/teams/state.test.ts.
