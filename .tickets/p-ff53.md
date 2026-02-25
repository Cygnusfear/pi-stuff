---
id: p-ff53
status: closed
deps: []
links: []
created: 2026-02-25T17:58:52Z
type: task
priority: 2
assignee: Alexander Mangel
tags: [prompts, cleanup, playbook]
---
# Deduplicate prompts/default.md with playbook-first links

User requested deduplication within prompts/default.md. Replace repeated guidance with concise repo-specific rules and links to obsidian playbook skills.



## Goal
Keep default prompt minimal, remove repeated sections, and link to playbook skills for detailed procedures.

## Acceptance Criteria
- [ ] Johnny Lookup retained
- [ ] Duplicate guidance collapsed/removed
- [ ] Detailed workflow instructions replaced with playbook references

## Verification
- [ ] Read prompts/default.md and confirm concise structure
- [ ] Confirm referenced playbook paths/names are valid

## Worktree
- .

## Notes

**2026-02-25T17:59:17Z**

Reworked prompts/default.md for internal dedupe + playbook linking. Removed repeated guidance blocks and replaced with concise progressive-disclosure policy plus links to obsidian playbook skills (05-01-ticket, 05-00-git, 30-00-refactor-index, 40-00-architecture-index). Kept Johnny Lookup and repo-specific rules. Verified referenced playbook SKILL files exist in ~/.pi/agent/skills. Verified exact shared normalized lines with prompts/codex.md: 0.
