---
id: p-de1d
status: closed
deps: []
links: []
created: 2026-02-13T05:34:50Z
type: task
priority: 2
assignee: test-worker
tags: [team]
---
# Read extensions/skills.ts and report back what commands it registers. Just list them with one-line descriptions.

Read extensions/skills.ts and report back what commands it registers. Just list them with one-line descriptions.


## Notes

**2026-02-13T05:35:07Z**

DONE: extensions/skills.ts registers 5 commands:
1. skills:install — Install skills from a source (default: cygnusfear/agent-skills), with optional --skill and --global flags.
2. skills:check — Check for available skill updates and show status.
3. skills:update — Update all installed skills to their latest versions.
4. skills:list — List installed skills, with optional --global flag.
5. skills:remove — Remove skills by name, or remove all with --all.
Also listens to session_start event to auto-check for skill and package updates.
