---
id: p-b9a3
status: closed
deps: []
links: []
created: 2026-02-25T17:55:46Z
type: task
priority: 2
assignee: Alexander Mangel
tags: [prompts, cleanup, obsidian]
---
# Trim prompts/default.md to repo-specific progressive disclosure

Remove duplicated generic instructions from prompts/default.md and keep only repo-specific guidance, especially Johnny Lookup and progressive disclosure into obsidian playbook skills.



## Goal
Make default prompt minimal and non-duplicative by keeping local deltas and referencing playbook skills for detailed instructions.

## Acceptance Criteria
- [ ] prompts/default.md no longer duplicates generic communication/tool/git guidance
- [ ] Johnny Lookup section remains and points to playbook resolution path
- [ ] File explains progressive disclosure policy for obsidian playbook content

## Verification
- [ ] Read updated prompts/default.md and confirm removed sections

## Worktree
- .

## Notes

**2026-02-25T17:56:16Z**

Updated prompts/default.md to minimal repo-specific content only. Kept Johnny Lookup + ticket playbook pointer, added progressive disclosure policy (playbook-first, no duplicated generic rules), kept CLAUDE->AGENTS reminder. Removed duplicated communication/tool/git/task/oracle/model instructions. Verification: exact shared normalized lines with prompts/codex.md reduced from 47 to 0.
