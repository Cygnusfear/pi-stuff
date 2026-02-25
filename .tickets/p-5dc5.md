---
id: p-5dc5
status: closed
deps: []
links: []
created: 2026-02-18T17:24:19Z
type: bug
priority: 0
assignee: Alexander Mangel
tags: [teams, bug, reliability]
---
# Make teams stuck warnings event-driven and non-destructive

Stuck warnings fire during legitimate worker activity and can trigger leader turns that kill/restart healthy workers. Replace heartbeat inference with explicit worker heartbeat events and ensure stuck warnings do not auto-trigger coordinator turns.



## Goal
Eliminate false-positive stuck warnings during legitimate worker execution and prevent warning messages from cascading into unnecessary worker terminations.

## Acceptance Criteria
- [ ] Worker sessions emit explicit heartbeat activity during active execution, including long model/tool waits.
- [ ] Leader stuck detection uses heartbeat activity so legitimate running workers are not flagged idle.
- [ ] Stuck team-event notifications do not auto-trigger a new coordinator turn.

## Verification
- [ ] Run teams unit tests and confirm stuck detection logic still passes.
- [ ] Add/adjust tests proving worker heartbeats are emitted and stuck notifications are non-triggering.

## Worktree
- .

## Notes

**2026-02-18T17:26:16Z**

Implemented event-driven worker heartbeat entries + made stuck team-event notifications non-triggering. Added tests: leader-notify + worker-heartbeat; verified with bun test tests/teams/activity.test.ts tests/teams/tool-list.test.ts tests/teams/leader-notify.test.ts tests/teams/worker-heartbeat.test.ts
