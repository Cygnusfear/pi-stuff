---
id: p-d73d
status: closed
deps: []
links: []
created: 2026-02-13T05:31:15Z
type: task
priority: 2
assignee: delphi-teams
tags: [team]
---
# Search the web for the original implementation of 'teams' / multi-agent worker systems for pi (the coding agent TUI by badlogic). We have a teams system that spawns worker agents in git worktrees, coordinated via tk (wedow/ticket). Find:
1. Any prior art or original repos for pi agent teams / subagents
2. The wedow/ticket (tk) tool that our teams system depends on
3. Multi-agent coding patterns using git worktrees
4. Whether this pattern came from somewhere specific or was built in-house

Use web_search_exa and get_code_context_exa. Try searches like 'pi coding agent teams workers worktree', 'wedow ticket tk cli', 'multi-agent coding worktree coordination', 'badlogic pi-mono teams subagents'.

Search the web for the original implementation of 'teams' / multi-agent worker systems for pi (the coding agent TUI by badlogic). We have a teams system that spawns worker agents in git worktrees, coordinated via tk (wedow/ticket). Find:
1. Any prior art or original repos for pi agent teams / subagents
2. The wedow/ticket (tk) tool that our teams system depends on
3. Multi-agent coding patterns using git worktrees
4. Whether this pattern came from somewhere specific or was built in-house

Use web_search_exa and get_code_context_exa. Try searches like 'pi coding agent teams workers worktree', 'wedow ticket tk cli', 'multi-agent coding worktree coordination', 'badlogic pi-mono teams subagents'.


## Notes

**2026-02-13T05:32:11Z**

DONE: Research complete. Here are the findings:

## 1. Prior art / original repos for pi agent teams
- Pi's README explicitly says it "skips features like sub agents and plan mode" and encourages building them via extensions. The teams system in `extensions/teams/` is a **custom extension built in-house** for this project — not upstream pi functionality.
- There's a GitHub issue #830 on pi-mono requesting native subagent support (switching AgentSession in InteractiveMode), but it's community-requested, not shipped.
- Similar multi-agent patterns exist externally: **Emdash** (generalaction/emdash, YC W26, 1.2K stars) — runs multiple coding agents in parallel git worktrees. **Letta Code** uses git-backed context repos with subagents. These are independent projects, not the source of our implementation.

## 2. wedow/ticket (tk) tool
- **wedow/ticket** (https://github.com/wedow/ticket, 523 stars, MIT license) — "The git-backed issue tracker for AI agents." A single bash script. Tickets are markdown files with YAML frontmatter in `.tickets/`. Inspired by Joe Armstrong's Minimal Viable Program. Written as a replacement for `beads`. Installed via `brew tap wedow/tools && brew install ticket`. Already installed locally at `/opt/homebrew/bin/tk`.

## 3. Multi-agent coding patterns using git worktrees
- Git worktrees are the dominant pattern for parallel agent isolation. Our `extensions/teams/worktree.ts` creates per-worker branches via `git worktree add`. This matches the pattern used by Emdash, Letta Code, and described in multiple blog posts (Medium, Moltbook). The alternative is Agent Mail + Beads (file-level advisory locks instead of worktrees).

## 4. Origin — built in-house or from somewhere?
- **Built in-house.** The teams extension (`extensions/teams/`) with leader.ts, state.ts, tool.ts, polling.ts, worktree.ts, spawner.ts, cleanup.ts is project-specific code. It combines two external open-source tools (pi coding agent + wedow/ticket) with custom orchestration logic. The git-worktree-per-worker pattern is a well-known community pattern but our specific implementation is original.
