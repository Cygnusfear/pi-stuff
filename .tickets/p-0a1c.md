---
id: p-0a1c
status: closed
deps: []
links: []
created: 2026-02-17T19:50:26Z
type: bug
priority: 1
assignee: Alexander Mangel
tags: [bug, teams, workers, idle-timeout, orchestration]
---
# teams: idle detector falsely marks active workers as stuck during long Rust builds/tests

When delegating multiple workers via teams.delegate (observed with model openai-codex/gpt-5.3-codex), workers are repeatedly flagged as "may be stuck (300s idle)" while they are still actively running long cargo/rustc workloads in their .pi-teams worktrees. This causes unnecessary manual kill/retry churn, duplicate follow-up tickets, and risks losing in-flight work.

Observed symptoms:
- Repeated 300s idle warnings across multiple workers despite ongoing work.
- At warning time, `ps` shows active rustc processes under .pi-teams/<worker>/target/... with non-trivial CPU.
- Worker branches often show no commit yet because the worker is still in compile/test phase, but gets killed due to timeout warning.

Likely issue:
- Idle detection appears tied primarily to agent note/heartbeat frequency, not child-process liveness/CPU/activity.

Expected behavior:
- A worker running a long command (cargo test/build, long lint, etc.) should not be marked stuck solely due to missing textual progress notes.

Requested fix direction:
1) Treat active child process execution as heartbeat (or explicit "busy" state).
2) Consider subprocess stdout/stderr activity and/or CPU/runtime when evaluating idle.
3) Only emit stuck warning when both are true: no worker heartbeat AND no active child process activity for threshold duration.
4) Expose richer status: current command + elapsed + last output timestamp.
5) Make idle threshold configurable per task profile (e.g., compile-heavy repos).



## Goal
Prevent false-positive stuck warnings for active workers during long-running compile/test phases in teams workflows.

## Acceptance Criteria
- [ ] Workers executing long-running child processes (e.g., cargo test/build) are not marked as stuck solely due to missing periodic notes.
- [ ] Idle warnings require both missing heartbeat and no active child process activity for the timeout window.
- [ ] Status output shows enough context to distinguish truly idle vs actively compiling/testing workers.
- [ ] Existing true-stall detection still works and flags genuinely idle workers.

## Verification
- [ ] Reproduce with a compile-heavy Rust task that runs >300s: no false stuck warning while process is active.
- [ ] Reproduce with a deliberately idle worker: stuck warning still triggers after timeout.
- [ ] Run multi-worker scenario and confirm significant reduction in manual kill/retry churn.

## Worktree
- .

## Notes

**2026-02-17T20:03:27Z**

Implemented fix: stuck warnings now require BOTH missing heartbeat/output and missing child-process activity. Added process-tree sampling (ps) to detect active child commands (rustc/cargo/etc), session-file output heartbeat tracking, configurable thresholds via PI_TEAMS_ACTIVITY_POLL_MS / PI_TEAMS_STUCK_THRESHOLD_MS / PI_TEAMS_STUCK_WARNING_COOLDOWN_MS, and richer runtime context in teams list/widget/stuck messages. Verification: bun test tests/teams/activity.test.ts tests/teams/tool-list.test.ts tests/teams/worktree.test.ts tests/teams/tickets.test.ts (all pass).
