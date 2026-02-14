---
id: p-ee8a
status: in_progress
deps: []
links: []
created: 2026-02-14T07:14:37Z
type: epic
priority: 1
assignee: Alexander Mangel
tags: [totalrecall, infrastructure, architecture]
---
# TotalRecall infrastructure: Postgres on bhaktiram + simplify architecture

Move TotalRecall Postgres to bhaktiram server, eliminate worker daemon, simplify to OpenRouter-only, add memory consolidation/merging.



## Goal
Simplify TotalRecall architecture and deploy to bhaktiram for multi-machine shared memory.

## Acceptance Criteria
- [ ] Postgres runs on bhaktiram, accessible via Tailscale
- [ ] Local mac connects via DATABASE_URL pointing to bhaktiram Tailscale IP
- [ ] Dreaming runs as systemd timer on bhaktiram (no daemon, no keychain)
- [ ] OpenRouter is the only LLM provider path (remove Claude CLI/OAuth/keyring complexity)
- [ ] No background worker process — dream is a batch command
- [ ] Memory consolidation/merging implemented (new memories can UPDATE/MERGE existing nodes, not just append)
- [ ] Works across multiple projects (pi, bhaktiram, jungle) tagged by repo

## Verification
- [ ] totalrecall status works from local mac pointing at bhaktiram Postgres
- [ ] totalrecall dream runs on bhaktiram via systemd timer without keychain prompts
- [ ] No OAuth/keyring code paths remain
- [ ] New memory that duplicates existing info triggers merge rather than creating duplicate node

## Worktree
- .
