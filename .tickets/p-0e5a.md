---
id: p-0e5a
status: closed
deps: []
links: []
created: 2026-02-25T17:53:01Z
type: task
priority: 3
assignee: Alexander Mangel
tags: [prompts, docs, cleanup]
---
# Audit prompts/default.md for duplicate instructions

Review prompts/default.md for duplicated guidance (internal repeats and overlap with AGENTS.md/system prompt) and suggest cleanup.



## Goal
Identify redundant or conflicting instructions in prompts/default.md and propose concrete removals.

## Acceptance Criteria
- [ ] List duplicated sections/instructions with file references
- [ ] Identify overlap with AGENTS.md that can be removed from default prompt
- [ ] Provide a minimal cleanup proposal

## Verification
- [ ] Read prompts/default.md fully
- [ ] Compare against AGENTS.md

## Worktree
- .

## Notes

**2026-02-25T17:54:17Z**

Audit complete: prompts/default.md has little exact internal duplication, but heavy conceptual duplication with prompts/codex.md and harness instructions. 47 exact shared normalized lines with prompts/codex.md. Duplicate sections: Communication (default:46 / codex:7), Subagent/task tool (72 / 18), ORACLE/DELPHI (86 / 27), Tool usage (96 / 36), Git hygiene (114 / 54), Notes (125 / 210). Also dead internal links near default:16 to missing headings. Proposed cleanup: keep only repo-specific deltas (Johnny Lookup, CLAUDE→AGENTS rule, red herring, any truly local policy), remove generic tool/git/comms blocks.
