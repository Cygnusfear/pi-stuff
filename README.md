# pi-stuff

Extensions, prompts, and themes for [pi](https://github.com/badlogic/pi-mono) — a coding agent TUI.

## Install

```bash
pi install https://github.com/cygnusfear/pi-stuff
```

Updates with `pi update`. Skills live in a separate repo: [agent-skills](https://github.com/cygnusfear/agent-skills).

## Extensions

### Core tools

| Extension | What it does |
|-----------|-------------|
| `file-tools.ts` | `rg`, `fd`, and `Glob` tools with working directory support |
| `hashline-tools.ts` | Line-anchored file editing — stable hashes prevent stale edits |
| `core-read-ui.ts` | Enhanced `read` tool with image support and truncation |
| `webfetch.ts` | Fetch URLs as text, markdown, or HTML |
| `todos-tk.ts` | Ticket management via `tk` — create, list, comment, complete |
| `skills.ts` | `/skills:install`, `/skills:update`, `/skills:list`, `/skills:remove` commands |

### Workflow

| Extension | What it does |
|-----------|-------------|
| `teams/` | Spawn parallel worker agents with git worktree isolation |
| `auto-continue.ts` | Auto-continue when the agent hits output limits |
| `git-safety.ts` | Guard against destructive git operations |
| `worktree-summaries.ts` | Summarize work done in git worktrees |

### UI

| Extension | What it does |
|-----------|-------------|
| `powerline-footer/` | Powerline-style status bar — model, tokens, cost, git, context usage |
| `context.ts` | Context window viewer — token breakdown, session stats, AGENTS.md sizes |
| `notify.ts` | Desktop notifications on task completion |
| `defaults/` | Theme selector, system prompt viewer, project init wizard, session naming |

## Prompts

- `prompts/codex.md` — General-purpose system prompt

## Themes

- `themes/lipgloss.json` — Custom color theme

## License

MIT
