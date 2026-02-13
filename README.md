# 🦚 pi-stuff / werner

Extensions, prompts, and themes for [pi](https://github.com/badlogic/pi-mono) — a coding agent TUI.

<img width="1948" height="2378" alt="Screenshot 2026-02-13 at 06 45 40" src="https://github.com/user-attachments/assets/e5a8288c-4493-44ea-a3fa-dd04a05192da" />

## 💅 Install

Install [pi](https://github.com/badlogic/pi-mono).

Then install this:

```bash
pi install https://github.com/cygnusfear/pi-stuff
```

Workflow relies heavily on the use of [tk](https://github.com/wedow/ticket) as the main driver of inter-agent communication, coordination, task management, and archiving. Oracle & Delphi skills use `teams`, which in turns relies on `tk` for coordination. 

### 🏇 Skills

All works independently of [agent-skills](https://github.com/cygnusfear/agent-skills) but is synergistic. Skills can be installed with this command from within `pi`:

```bash
/skills:install
```

Updates with `pi update`.

## 💆‍♂️ Wat

### Core kit

Workflow relies heavily on the use of [tk](https://github.com/wedow/ticket) as the main driver of inter-agent communication, coordination, task management, and archiving. Oracle & Delphi skills use `teams`, which in turns relies on `tk` for coordination.

| Extension     | What it does                                                                          |
| ------------- | ------------------------------------------------------------------------------------- |
| `teams`       | Spawn parallel worker agents with git worktree isolation, using `tk` for coordination |
| `todos-tk.ts` | Ticket management via `tk` — create, list, comment, complete                          |

### Tools

| Extension               | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `skills.ts`             | `/skills:install`, `/skills:update`, `/skills:list`, `/skills:remove` commands |
| `file-tools.ts`         | `rg`, `fd`, and `Glob` tools with working directory support                    |
| `hashline-tools.ts`     | Line-anchored file editing — stable hashes prevent stale edits                 |
| `core-read-ui.ts`       | Enhanced `read` tool with image support and truncation                         |
| `webfetch.ts`           | Fetch URLs as text, markdown, or HTML                                          |
| `auto-continue.ts`      | Auto-continue when the agent hits output limits                                |
| `git-safety.ts`         | Guard against destructive git operations                                       |
| `worktree-summaries.ts` | Summarize work done in git worktrees                                           |

### UI

| Extension           | What it does                                                              |
| ------------------- | ------------------------------------------------------------------------- |
| `powerline-footer/` | Powerline-style status bar — model, tokens, cost, git, context usage      |
| `context.ts`        | Context window viewer — token breakdown, session stats, AGENTS.md sizes   |
| `notify.ts`         | Desktop notifications on task completion                                  |
| `defaults/`         | Theme selector, system prompt viewer, project init wizard, session naming |

## Prompts

- `prompts/codex.md` — General-purpose system prompt

## Themes

- `themes/lipgloss.json` — Custom color theme

## Provenance & Credits

Standing on the shoulders of giants — and occasionally raiding their repos.

### Core

| Project | What we owe them |
| ------- | ---------------- |
| [badlogic/pi-mono](https://github.com/badlogic/pi-mono) | Pi itself — the coding agent TUI framework everything here extends |
| [wedow/ticket](https://github.com/wedow/ticket) (`tk`) | Ticket system that drives our entire workflow: task management, inter-agent coordination, archiving |

### Hashline editing — [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)

**Can Bölük** invented hashline editing. Every line is tagged with a short content hash (`11:a3|function hello() {`), and edits reference anchors instead of reproducing content. If the file changed since last read, hashes mismatch and the edit is safely rejected.

His [benchmark](https://blog.can.ac/2026/02/12/the-harness-problem/) across 16 models showed hashline matches or beats `str_replace` and `apply_patch` for nearly every model — Grok Code Fast went from 6.7% → 68.3% just by changing the edit format. Our `hashline-tools.ts` is directly from his implementation.

### Teams — [tmustier/pi-agent-teams](https://github.com/tmustier/pi-agent-teams)

**Thomas Mustier** built the first Pi extension bringing Claude Code–style agent teams to Pi — shared task lists, auto-claim, file-based IPC, and worktree isolation. Our `teams/` extension takes the same core idea but pivots all coordination through `tk` tickets instead of file-per-task state.

### Subagents — [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) & [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)

Can Bölük built [`@oh-my-pi/subagents`](https://npmjs.com/package/@oh-my-pi/subagents) — a task delegation system with specialized agents (task, planner, explore, reviewer, browser) and structured output. **Nico Bailon** built `pi-subagents` — async subagent delegation with chains, parallel execution, and session sharing. Both informed our teams design, which reimplements these concepts around `tk` tickets and git worktree isolation.

### UI & extensions

| Project | What we took |
| ------- | ------------ |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | The `apply_patch` diff format (originally from OpenAI Codex), agent markdown patterns, and general TUI coding agent design |
| [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss) | Theme system and color palette |
| [nicobailon/pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) | Powerline status bar — vendored and extended |
| [romkatv/powerlevel10k](https://github.com/romkatv/powerlevel10k) | Powerline design language and Nerd Font auto-detection |
| [@aliou/pi-defaults](https://www.npmjs.com/package/@aliou/pi-utils-settings) | Settings system, UI utilities, theme selector, project init wizard |

## License

MIT
