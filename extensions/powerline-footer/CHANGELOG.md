# Changelog

## [Unreleased]

## [0.2.23] - 2026-02-06

### Fixed
- **Slash command autocomplete not appearing** — Custom editor created during `session_start` never received the autocomplete provider because pi v0.52.7 moved `setupAutocomplete()` to run after extensions load. The `handleInput` override now detects the missing provider on first keystroke, re-triggers `setEditorComponent` (which succeeds because the provider exists by then), and forwards the keystroke to the new editor. Users without editor-replacing extensions were unaffected.

## [0.2.22] - 2026-01-31

### Fixed
- **Detached HEAD flickering** — Git branch segment no longer oscillates between showing "detached" and hiding every 500ms when HEAD is detached
  - Root cause: two competing branch detection methods (provider reads `.git/HEAD` → `"detached"`, extension runs `git branch --show-current` → empty/null) fought via a `??` fallback that leaked the provider value on every cache expiry
  - Branch cache now returns stale value while refreshing instead of falling through to provider
  - Detached HEAD now shows the short commit SHA (e.g., `abc1234 (detached)`) instead of bare "detached"

### Changed
- **Extracted `runGit` helper** — Consolidated duplicated process-spawning logic from `fetchGitBranch` and `fetchGitStatus` into a shared helper
- `fetchGitBranch` now distinguishes "not a git repo" (null, early exit) from "detached HEAD" (empty string, SHA lookup) — avoids spawning a wasteful second process for non-git directories

## [0.2.21] - 2026-01-31

### Changed
- **Status bar moved above editor** — Powerline segments now render above the top border instead of below the bottom border, keeping the input prompt closer to the conversation
- **Removed blank line below editor** — Eliminated extra spacing after the status bar
- **Default segment order** — Model and thinking level now appear before path for better at-a-glance info (π → model → think → path → ...)

## [0.2.20] - 2026-01-30

### Changed
- **Editor layout redesign** — Replaced rounded box (`╭╮│╰╯`) with clean open layout:
  - Subtle grey `─` top/bottom borders with 1-char margins
  - `>` input prompt on first content line (light gray), continuation lines indented to match
  - Status bar moved below the bottom border as a standalone line
  - Status bar no longer has trailing `─` fill
- **Softer border colors** — Borders use muted grey (`sep`) instead of bright blue (`border`)

### Fixed
- **Scroll indicator detection** — Bottom border regex now matches editor scroll indicators (`─── ↓ N more`) in addition to plain borders, preventing broken rendering when editor content is scrollable
- **Segment overflow** — `topBarAvailable` no longer wastes 4 chars on removed box corners, giving segments the full terminal width for layout calculation

## [0.2.19] - 2026-01-28

### Added
- **File-based vibe mode** — Pre-generate vibes once, pull from file at runtime (zero cost, instant)
  - `/vibe generate <theme> [count]` — Generate and save vibes to `~/.pi/agent/vibes/{theme}.txt`
  - `/vibe mode file` — Switch to file-based mode
  - `/vibe mode generate` — Switch back to on-demand generation
  - Uses seed-based deterministic shuffle for no-repeat selection
  - Works offline, no API key needed at runtime

### Improved
- **Better vibe variety in generate mode** — Tracks last 5 vibes and excludes them from generation
- **Updated prompt** — Now emphasizes creativity and avoiding clichéd phrases
- **Richer tool call context** — Uses agent's response text instead of just "reading file: X" for more contextual vibes
- **Configurable max message length** — `workingVibeMaxLength` setting (default: 65 chars, up from 50)

## [0.2.18] - 2026-01-28

### Fixed
- **Race condition in vibe generation** — Fixed bug where stale vibe generations could overwrite newer ones by capturing AbortController in local variable

## [0.2.17] - 2026-01-28

### Added
- **Working Vibes** — AI-generated themed loading messages that match your preferred style
  - Set a theme with `/vibe star trek` and loading messages become "Running diagnostics..." instead of "Working..."
  - Configure via `settings.json`: `"workingVibe": "pirate"` for nautical-themed messages
  - Supports any theme: star trek, pirate, zen, noir, cowboy, etc.
  - Shows "Channeling {theme}..." placeholder, then updates when AI responds (within 3s timeout)
  - **Auto-refresh on tool calls** — Generates new vibes during long tasks (rate-limited, default 30s)
  - Configurable refresh interval via `workingVibeRefreshInterval` (in seconds)
  - Custom prompt templates via `workingVibePrompt` with `{theme}` and `{task}` variables
  - Uses claude-haiku-4-5 by default (~$0.000015/generation), configurable via `/vibe model` or `workingVibeModel` setting

### Fixed
- **Event handlers now use correct events** — Replaced non-existent `stream_start`/`stream_end` with `agent_start`/`agent_end`
- **Removed duplicate powerline bar** — Footer no longer renders redundant status during streaming

## [0.2.16] - 2026-01-28

### Fixed
- **Model and path colors restored** — Fixed color regression from v0.2.13 theme refactor:
  - Model segment now uses original pink (`#d787af`) instead of white/gray (`text`)
  - Path segment now uses original cyan (`#00afaf`) instead of muted gray

## [0.2.15] - 2026-01-27

### Added
- **Status notifications above editor** — Extension status messages that look like notifications (e.g., `[pi-annotate] Received: CANCEL`) now appear on a separate line above the editor input
- Notification-style statuses (starting with `[`) appear above editor
- Compact statuses (e.g., `MCP: 6 servers`) remain in the powerline bar

## [0.2.14] - 2026-01-26

### Fixed
- **Theme type mismatch crash** — Fixed `TypeError: theme.fg is not a function` caused by passing `EditorTheme` (from pi-tui) instead of `Theme` (from pi-coding-agent) to segment rendering
- **Invalid theme color** — Changed `"primary"` to `"text"` in default colors since `"primary"` is not a valid `ThemeColor`

## [0.2.13] - 2026-01-27

### Added
- **Theme system** — Colors now integrate with pi's theme system instead of hardcoded values
- Each preset defines its own color scheme with semantic color names
- Optional `theme.json` file for user customization (power user feature)
- Colors can be theme names (`accent`, `primary`, `muted`) or hex values (`#ff5500`)
- Added `theme.example.json` documenting all available color options

### Changed
- Segments now use pi's `Theme` object for color rendering
- Removed hardcoded ANSI color codes in favor of theme-based colors
- Presets include both layout AND color scheme for cohesive looks
- Simplified thinking level colors to use semantic `thinking` color (rainbow preserved for high/xhigh)

## [0.2.12] - 2026-01-27

### Added
- **Responsive segment layout** — Segments dynamically flow between top bar and secondary row based on terminal width
- When terminal is wide: all segments fit in top bar, secondary row hidden
- When terminal is narrow: overflow segments move to secondary row automatically

### Changed
- **Default preset reordered** — New order: π → folder → model → think → git → context% → cache → cost
- Path now appears before model name for better visual hierarchy
- Thinking level now appears right after model name
- Added git, cache_read, and cost to primary row in default preset
- **Thinking label shortened** — `thinking:level` → `think:level` to save 3 characters

### Fixed
- **Narrow terminal crash** — Welcome screen now gracefully skips rendering on terminals < 44 columns wide
- **Editor crash on very narrow terminals** — Falls back to original render when width < 10
- **Streaming footer crash** — Truncation now properly handles edge cases and won't render content that exceeds terminal width
- **Secondary widget crash** — Content width is now validated before rendering
- **Layout cache invalidation** — Cache now properly clears when preset changes or powerline is toggled off

## [0.2.11] - 2026-01-26

### Changed
- Added `pi` manifest to package.json for pi v0.50.0 package system compliance
- Added `pi-package` keyword for npm discoverability

## [0.2.10] - 2026-01-17

### Fixed
- Welcome overlay now properly dismisses for `p "command"` case by:
  - Adding `tool_call` event listener (fires before stream_start)
  - Checking `isStreaming` flag when overlay is about to show
  - Checking session for existing activity (assistant messages, tool calls)
- Refactored dismissal logic into `dismissWelcome()` helper

## [0.2.9] - 2026-01-17

### Fixed
- Welcome overlay/header now dismisses when agent starts streaming (fixes `p "command"` case where welcome would briefly flash)
- Race condition where dismissal request could be lost due to 100ms setup delay in overlay

## [0.2.8] - 2026-01-16

### Changed
- `quietStartup: true` → shows welcome as header (dismisses on first input)
- `quietStartup: false` or not set → shows welcome as centered overlay (dismisses on key/timeout)
- Both modes use same two-column layout: logo, model info, tips, loaded counts, recent sessions
- Refactored welcome.ts to share rendering logic between header and overlay

### Fixed
- `/powerline` toggle off now clears all custom UI (editor, footer, header)

## [0.2.6] - 2026-01-16

### Fixed
- Removed invalid `?` keyboard shortcut tip, replaced with `Shift+Tab` for cycling thinking level

## [0.2.5] - 2026-01-16

### Added
- **Welcome overlay** — Branded "pi agent" splash screen shown as centered overlay on startup
- Two-column boxed layout with gradient PI logo (magenta → cyan)
- Shows current model name and provider
- Keyboard tips section (?, /, !)
- Loaded counts: context files (AGENTS.md), extensions, skills, and prompt templates
- Recent sessions list (up to 3, with time ago)
- Auto-dismisses after 30 seconds or on any key press
- Version now reads from package.json instead of being hardcoded
- Context file discovery now checks `.claude/AGENTS.md` paths (matching pi-mono)

## [0.2.4] - 2026-01-15

### Fixed
- Compatible with pi-tui 0.47.0 breaking change: CustomEditor constructor now requires `tui` as first argument

## [0.2.3] - 2026-01-15

### Fixed
- npm bin entry now works correctly with `npx pi-powerline-footer`

## [0.2.2] - 2026-01-15

### Changed
- **Path segment defaults to basename** — Shows just the directory name (e.g., `powerline-footer`) instead of full path to save space
- **New path modes** — `basename` (default), `abbreviated` (truncated full path), `full` (complete path)
- Simplified path options: replaced `abbreviate`, `stripWorkPrefix` with cleaner `mode` option
- Full/nerd presets use `abbreviated` mode, default/minimal/compact use `basename`
- Thinking segment now uses dedicated gradient colors (thinkingOff → thinkingMedium)

### Fixed
- Path basename extraction now uses `path.basename()` for Windows compatibility
- Git branch cache now stores `null` results, preventing repeated git calls in non-git directories
- Git status cache now stores empty results for non-git directories (was also spawning repeatedly)
- Removed dead `footerDispose` variable (cleanup handled by pi internally)

## [0.2.1] - 2026-01-10

### Added
- **Live git branch updates** — Branch now updates in real-time when switching via `git checkout`, `git switch`, etc.
- **Own branch fetching** — Extension fetches branch directly via `git branch --show-current` instead of relying solely on FooterDataProvider
- **Branch cache with 500ms TTL** — Faster refresh cycle for branch changes
- **Staggered re-renders for escape commands** — Multiple re-renders at 100/300/500ms to catch updates from `!` commands

### Fixed
- Git branch not updating after `git checkout` to existing branches
- Race condition where FooterDataProvider's branch cache wasn't updating in time

## [0.2.0] - 2026-01-10

### Added
- **Extension statuses segment** — Displays status text from other extensions (e.g., rewind checkpoint count)
- **Thinking level segment** — Live-updating display of current thinking level (`thinking:off`, `thinking:med`, etc.)
- **Rainbow effect** — High and xhigh thinking levels display with rainbow gradient inspired by Claude Code's ultrathink
- **Color gradient** — Thinking levels use progressive colors: gray → purple-gray → blue → teal → rainbow
- **Streaming visibility** — Status bar now renders in footer during streaming so it's always visible

### Changed
- Extension statuses appear at end of status bar (last item in default/full/nerd presets)
- Default preset now includes `thinking` segment after model
- Thinking level reads from session branch entries for live updates
- Footer invalidate() now triggers re-render for settings changes
- Responsive truncation — progressively removes segments on narrow windows instead of hiding status

### Fixed
- ANSI color reset after status content to prevent color bleeding
- ANSI color reset after rainbow text

### Removed
- Unused brain icon definitions

## [0.1.0] - 2026-01-10

### Added
- Initial release
- Rounded box design rendering in editor top border
- 18 segment types: pi, model, thinking, path, git, subagents, token_in, token_out, token_total, cost, context_pct, context_total, time_spent, time, session, hostname, cache_read, cache_write
- 6 presets: default, minimal, compact, full, nerd, ascii
- 10 separator styles: powerline, powerline-thin, slash, pipe, dot, chevron, star, block, none, ascii
- Git integration with async status fetching and 1s cache TTL
- Nerd Font auto-detection for common terminals
- oh-my-pi dark theme color matching
- Context percentage warnings at 70%/90%
- Auto-compact indicator
- Subscription detection
