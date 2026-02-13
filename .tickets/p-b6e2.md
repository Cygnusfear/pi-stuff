---
id: p-b6e2
status: in_progress
deps: []
links: []
created: 2026-02-12T07:35:04Z
type: task
priority: 2
assignee: Alexander Mangel
tags: [skills, pi-package, symlink]
---
# Hook up external skills dir into pi-stuff

Expose ~/Node/claude-stuff/skills to Pi via this package, using a local symlink and pi.skills manifest entry.



## Goal
Expose ~/Node/claude-stuff/skills to Pi via this package, using a local symlink and pi.skills manifest entry.

## Acceptance Criteria
- [ ] Pi loads skills from ~/Node/claude-stuff/skills when this package is installed/loaded locally
- [ ] No shell printf oneshot needed; setup is reproducible

## Verification
- [ ] /reload then confirm /skill:... commands appear (or pi shows skills loaded)

## Worktree
- .
