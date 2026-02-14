---
id: p-ede3
status: in_progress
deps: []
links: []
created: 2026-02-14T06:04:22Z
type: task
priority: 2
assignee: Alexander Mangel
tags: [research, oracle]
---
# Oracle 2: Pi boot time optimization analysis

## Pi Boot Time Analysis - Oracle 2 Findings

### Measured Baseline
- `pi --version`: **1.6 seconds** (should print version and exit immediately)
- `time node -e ''`: **0ms** (Node.js itself is instant)
- Import `dist/main.js` alone: **645ms**
- `resourceLoader.reload()`: **1074ms**
- **Total: ~1.7-1.8s** end-to-end

### 1. Startup Path Map

```
1. Node.js starts, loads dist/cli.js
2. cli.js imports dist/main.js (ALL top-level imports resolved: ~645ms)
   ├── @mariozechner/pi-ai (235ms) - all providers, typebox, oauth
   ├── @mariozechner/pi-tui (46ms)
   ├── modes/index.js → interactive-mode.js (237ms incremental)
   │   └── core/agent-session.js (234ms)
   │       └── core/extensions/loader.js (276ms cold)
   │           ├── @mariozechner/jiti (122ms)
   │           ├── @mariozechner/pi-agent-core (217ms, re-imports pi-ai)
   │           ├── ../../index.js (ENTIRE pi-coding-agent package! 572ms cold)
   │           └── Virtual module pre-bundling for Bun binary support
   ├── core/tools/index.js (21ms)
   ├── core/export-html/index.js (183ms) - pulls in highlight.js
   └── migrations.js, config.js, etc. (minor)
3. main() executes:
   a. handlePackageCommand() check
   b. handleConfigCommand() check  
   c. runMigrations() (~1ms)
   d. parseArgs() first pass (~1ms)
   e. SettingsManager.create() - reads settings.json (~1ms)
   f. AuthStorage + ModelRegistry creation (~1ms)
   g. DefaultResourceLoader creation (~1ms)
   h. await resourceLoader.reload() (~1074ms) ← HUGE
      ├── packageManager.resolve() - resolves packages
      │   └── npm root -g (spawnSync! 129ms)
      ├── loadExtensions() via jiti
      │   └── Creates NEW jiti instance per extension (moduleCache: false)
      │   └── ~13 extensions in this project
      │   └── Each jiti.import() = TypeScript transpilation
      ├── loadSkills() - filesystem scan
      ├── loadPromptTemplates() - filesystem scan
      ├── loadThemes() - filesystem scan
      └── loadProjectContextFiles() - walks up directory tree for AGENTS.md
   i. Extension flag registration
   j. parseArgs() second pass with extension flags
   k. --version check (FINALLY! line 498)
   l. For interactive: createAgentSession(), model resolution, etc.
```

### 2. Bottleneck Analysis (by impact)

#### CRITICAL: extensions/loader.js circular import (~276ms import time)
- **File**: `dist/core/extensions/loader.js:12-24`
- The extension loader imports the ENTIRE pi-coding-agent package (`import * as _bundledPiCodingAgent from '../../index.js'`) at the TOP LEVEL
- Also eagerly imports `@mariozechner/pi-agent-core` (217ms), `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox`
- These are for Bun binary virtual modules but loaded even in Node.js mode
- **Impact**: ~276ms of import time, triggers cascading imports of the entire dependency tree

#### CRITICAL: resourceLoader.reload() called before --version check (~1074ms)
- **File**: `dist/main.js:475`
- `resourceLoader.reload()` is called unconditionally before simple commands like `--version`, `--help`
- This does package resolution, extension loading, filesystem scans
- **Impact**: 1074ms wasted for commands that don't need it

#### HIGH: npm root -g via spawnSync (~129ms)
- **File**: `dist/core/package-manager.js:1042`
- `getGlobalNpmRoot()` calls `spawnSync('npm', ['root', '-g'])` 
- npm itself prints deprecation warnings, adding overhead
- Called during `packageManager.resolve()` in `resourceLoader.reload()`
- **Impact**: 129ms synchronous blocking

#### HIGH: jiti loaded eagerly + no module caching (~122ms import + per-extension cost)
- **File**: `dist/core/extensions/loader.js:11, 192-201`
- `@mariozechner/jiti` takes 122ms to import
- Each call to `loadExtensionModule()` creates a NEW jiti instance with `moduleCache: false`
- With 13 extensions, this multiplies the cost
- **Impact**: 122ms + ~50-100ms per extension ≈ 750ms+

#### MEDIUM: pi-ai imports all providers eagerly (~235ms)
- **File**: `node_modules/@mariozechner/pi-ai/dist/index.js`
- Re-exports ALL providers (Anthropic, Google, OpenAI, Azure, Bedrock, Codex)
- Re-exports ALL OAuth flows (Google, GitHub Copilot, OpenAI Codex)
- Re-exports typebox (35ms)
- Most providers won't be used in a given session
- **Impact**: 235ms

#### MEDIUM: export-html loaded eagerly via agent-session.js (~183ms)
- **File**: `dist/core/agent-session.js:29-30`
- `import { exportSessionToHtml } from './export-html/index.js'`
- Pulls in highlight.js (23ms for registerLanguage calls)
- Only needed when user explicitly exports/shares
- **Impact**: 183ms (but overlaps with other imports)

#### MEDIUM: interactive-mode.js loaded for ALL modes (~237ms incremental)
- **File**: `dist/modes/index.js:3`
- `export { InteractiveMode } from './interactive/interactive-mode.js'`
- This eagerly imports the entire interactive mode with all 40+ components
- Even `pi --print 'hello'` loads the interactive TUI components
- **Impact**: ~200ms (partially overlapping with agent-session)

#### LOW: loadProjectContextFiles walks entire directory tree
- **File**: `dist/core/resource-loader.js:46-75`
- Walks from cwd to root, checking AGENTS.md and CLAUDE.md at each level
- ~2 stat calls per level × ~5 levels = ~10 stat calls
- **Impact**: ~5-10ms (small but unnecessary for --version)

### 3. Import Graph Issues

**The core problem**: `dist/core/extensions/loader.js` creates a near-circular import:
```
main.js 
  → modes/index.js 
    → interactive-mode.js 
      → agent-session.js 
        → extensions/index.js 
          → extensions/loader.js 
            → ../../index.js (THE ENTIRE PACKAGE!)
            → @mariozechner/pi-agent-core (which imports pi-ai again)
            → @mariozechner/jiti
```

This means importing `main.js` transitively loads almost everything twice through different paths.

**Heavy top-level imports in main.js:**
- `@mariozechner/pi-ai` (line 1)
- `modes/index.js` (line 14) - pulls in interactive mode
- `core/tools/index.js` (line 12) - creates all tool instances
- `core/export-html/index.js` (line 10) - highlight.js

### 4. Extension Loading Analysis

**Discovery**: Extensions come from 3 sources:
1. Package manager resolution (settings.json packages → npm/git/local)
2. CLI `--extension` flags
3. Auto-discovered from project `.pi/` directories

**Loading**: Each extension file is loaded through jiti (TypeScript transpiler):
- `loadExtensionModule()` creates a fresh `createJiti()` instance per call
- `moduleCache: false` means no cross-extension caching
- In Node.js mode, uses `alias` mapping instead of `virtualModules`
- This project has ~13 extension files → 13 jiti instances

**Optimization opportunities**:
- Share a single jiti instance across all extensions
- Enable module caching
- Parallelize extension loading (currently sequential `for...of` loop)
- Lazy-load extensions after first render

### 5. Config/Discovery Analysis

**Settings loading** (fast, ~1ms):
- Reads `~/.pi/agent/settings.json` - single file read
- Reads `.pi/settings.json` in cwd - single file read

**Package resolution** (slow, ~200ms+):
- Resolves npm packages: calls `npm root -g` via spawnSync (129ms)
- Resolves git packages: checks cloned directories
- Resolves local paths: stat checks
- Auto-discovers `.pi/` directory resources

**AGENTS.md discovery** (~5-10ms):
- Walks from cwd to root checking for AGENTS.md/CLAUDE.md
- ~10 stat calls total

### 6. Quick Wins (Easy + High Impact)

1. **Early exit for --version/--help** (~1600ms saved)
   - Check `process.argv` for `--version`/`--help` BEFORE any imports
   - Just `if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }`
   - In cli.js, before `import { main } from './main.js'`

2. **Cache npm root -g result** (~129ms saved)
   - Store result in `~/.pi/agent/.npm-root-cache` with TTL
   - Or use `process.env.NPM_CONFIG_PREFIX` / hardcode common paths
   - Or detect from Node.js `process.execPath` parent

3. **Share single jiti instance with module caching** (~300-500ms saved)
   - Create one jiti instance in loader.js and reuse across extensions
   - Set `moduleCache: true` so re-imported modules are cached
   - File: `dist/core/extensions/loader.js:192-201`

4. **Lazy import of extensions/loader.js virtual modules** (~150ms saved)
   - Only import `_bundledPiCodingAgent`, `_bundledPiAgentCore` when `isBunBinary` is true
   - In Node.js mode, these are never used (aliases are used instead)
   - Use `await import()` or conditional static imports

### 7. Medium Effort (Worthwhile)

5. **Defer resourceLoader.reload() for --version/--help/--list-models** (~1074ms saved)
   - Move the reload call after the --version/--help checks
   - Only load extensions when actually entering a session

6. **Lazy import of modes** (~200ms saved)
   - Don't import `InteractiveMode` from modes/index.js at top level
   - Use dynamic `await import()` only when entering interactive mode
   - Same for print mode and RPC mode

7. **Lazy import of export-html in agent-session.js** (~100ms saved)
   - Replace top-level import with dynamic import in the export method
   - `const { exportSessionToHtml } = await import('./export-html/index.js')`

8. **Parallelize extension loading** (~30-50% of jiti time saved)
   - Change sequential `for...of` to `Promise.all()` in `loadExtensions()`
   - File: `dist/core/extensions/loader.js:253-261`

### 8. Large Refactors (Significant Changes)

9. **Tree-shake pi-ai** (~100ms saved)
   - Split pi-ai into subpath exports: `@mariozechner/pi-ai/anthropic`, etc.
   - Only import the provider actually in use
   - Or use dynamic imports for provider modules

10. **Pre-compile extensions** (~500ms+ saved)
    - Cache jiti transpilation results to disk
    - Only re-transpile when source file mtime changes
    - Could eliminate jiti entirely for cached extensions

11. **Bundle main.js with esbuild** (~300ms saved)
    - Single-file bundle eliminates ESM resolution overhead
    - ~27ms+ spent in `compileSourceTextModule` across many small files
    - Tree-shaking would eliminate unused code paths

12. **Move to a plugin architecture with separate processes** (architectural)
    - Extensions run in worker threads or child processes
    - Main process starts fast, extensions load in background
    - First render happens before extensions are ready

### 9. Confidence & Caveats

**High confidence:**
- Import timing measurements are reproducible (ran multiple times)
- The extensions/loader.js circular import is clearly the biggest import-time issue
- `npm root -g` spawnSync is confirmed at 129ms
- resourceLoader.reload() is confirmed at ~1074ms
- --version going through full startup path is clearly wasteful

**Medium confidence:**
- jiti per-extension cost estimates (hard to isolate from general I/O)
- Parallelization savings estimate (depends on I/O vs CPU bound)
- Tree-shaking pi-ai savings (depends on actual bundle analysis)

**Caveats:**
- Measurements on Apple Silicon M-series Mac; ARM Linux or Intel may differ
- Node.js v25.2.1; older versions may have different ESM performance
- Cold vs warm filesystem cache affects all I/O measurements
- The project being analyzed has 13 extensions + 3 packages; minimal setups would be faster
- Some imports overlap in time due to shared dependencies (can't simply add all times)

### Priority Ranking (effort vs impact)

| # | Fix | Est. Savings | Effort |
|---|-----|-------------|--------|
| 1 | Early --version/--help exit | 1600ms for those commands | 5 min |
| 5 | Defer reload for simple commands | 1074ms | 30 min |
| 3 | Share jiti instance + enable caching | 300-500ms | 1 hour |
| 4 | Conditional virtual module imports | 150ms | 30 min |
| 2 | Cache npm root -g | 129ms | 30 min |
| 6 | Lazy mode imports | 200ms | 1 hour |
| 7 | Lazy export-html import | 100ms | 15 min |
| 8 | Parallelize extension loading | 200-400ms | 1 hour |
| 10 | Pre-compile extensions | 500ms+ | 1 day |
| 9 | Tree-shake pi-ai | 100ms | 1 day |
| 11 | Bundle with esbuild | 300ms | 1 day |

**To get under 1 second**: Items 1-5 alone would bring interactive startup from ~1.8s to ~0.5-0.7s.



## Goal
## Pi Boot Time Analysis - Oracle 2 Findings

### Measured Baseline
- `pi --version`: **1.6 seconds** (should print version and exit immediately)
- `time node -e ''`: **0ms** (Node.js itself is instant)
- Import `dist/main.js` alone: **645ms**
- `resourceLoader.reload()`: **1074ms**
- **Total: ~1.7-1.8s** end-to-end

### 1. Startup Path Map

```
1. Node.js starts, loads dist/cli.js
2. cli.js imports dist/main.js (ALL top-level imports resolved: ~645ms)
   ├── @mariozechner/pi-ai (235ms) - all providers, typebox, oauth
   ├── @mariozechner/pi-tui (46ms)
   ├── modes/index.js → interactive-mode.js (237ms incremental)
   │   └── core/agent-session.js (234ms)
   │       └── core/extensions/loader.js (276ms cold)
   │           ├── @mariozechner/jiti (122ms)
   │           ├── @mariozechner/pi-agent-core (217ms, re-imports pi-ai)
   │           ├── ../../index.js (ENTIRE pi-coding-agent package! 572ms cold)
   │           └── Virtual module pre-bundling for Bun binary support
   ├── core/tools/index.js (21ms)
   ├── core/export-html/index.js (183ms) - pulls in highlight.js
   └── migrations.js, config.js, etc. (minor)
3. main() executes:
   a. handlePackageCommand() check
   b. handleConfigCommand() check  
   c. runMigrations() (~1ms)
   d. parseArgs() first pass (~1ms)
   e. SettingsManager.create() - reads settings.json (~1ms)
   f. AuthStorage + ModelRegistry creation (~1ms)
   g. DefaultResourceLoader creation (~1ms)
   h. await resourceLoader.reload() (~1074ms) ← HUGE
      ├── packageManager.resolve() - resolves packages
      │   └── npm root -g (spawnSync! 129ms)
      ├── loadExtensions() via jiti
      │   └── Creates NEW jiti instance per extension (moduleCache: false)
      │   └── ~13 extensions in this project
      │   └── Each jiti.import() = TypeScript transpilation
      ├── loadSkills() - filesystem scan
      ├── loadPromptTemplates() - filesystem scan
      ├── loadThemes() - filesystem scan
      └── loadProjectContextFiles() - walks up directory tree for AGENTS.md
   i. Extension flag registration
   j. parseArgs() second pass with extension flags
   k. --version check (FINALLY! line 498)
   l. For interactive: createAgentSession(), model resolution, etc.
```

### 2. Bottleneck Analysis (by impact)

#### CRITICAL: extensions/loader.js circular import (~276ms import time)
- **File**: `dist/core/extensions/loader.js:12-24`
- The extension loader imports the ENTIRE pi-coding-agent package (`import * as _bundledPiCodingAgent from '../../index.js'`) at the TOP LEVEL
- Also eagerly imports `@mariozechner/pi-agent-core` (217ms), `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox`
- These are for Bun binary virtual modules but loaded even in Node.js mode
- **Impact**: ~276ms of import time, triggers cascading imports of the entire dependency tree

#### CRITICAL: resourceLoader.reload() called before --version check (~1074ms)
- **File**: `dist/main.js:475`
- `resourceLoader.reload()` is called unconditionally before simple commands like `--version`, `--help`
- This does package resolution, extension loading, filesystem scans
- **Impact**: 1074ms wasted for commands that don't need it

#### HIGH: npm root -g via spawnSync (~129ms)
- **File**: `dist/core/package-manager.js:1042`
- `getGlobalNpmRoot()` calls `spawnSync('npm', ['root', '-g'])` 
- npm itself prints deprecation warnings, adding overhead
- Called during `packageManager.resolve()` in `resourceLoader.reload()`
- **Impact**: 129ms synchronous blocking

#### HIGH: jiti loaded eagerly + no module caching (~122ms import + per-extension cost)
- **File**: `dist/core/extensions/loader.js:11, 192-201`
- `@mariozechner/jiti` takes 122ms to import
- Each call to `loadExtensionModule()` creates a NEW jiti instance with `moduleCache: false`
- With 13 extensions, this multiplies the cost
- **Impact**: 122ms + ~50-100ms per extension ≈ 750ms+

#### MEDIUM: pi-ai imports all providers eagerly (~235ms)
- **File**: `node_modules/@mariozechner/pi-ai/dist/index.js`
- Re-exports ALL providers (Anthropic, Google, OpenAI, Azure, Bedrock, Codex)
- Re-exports ALL OAuth flows (Google, GitHub Copilot, OpenAI Codex)
- Re-exports typebox (35ms)
- Most providers won't be used in a given session
- **Impact**: 235ms

#### MEDIUM: export-html loaded eagerly via agent-session.js (~183ms)
- **File**: `dist/core/agent-session.js:29-30`
- `import { exportSessionToHtml } from './export-html/index.js'`
- Pulls in highlight.js (23ms for registerLanguage calls)
- Only needed when user explicitly exports/shares
- **Impact**: 183ms (but overlaps with other imports)

#### MEDIUM: interactive-mode.js loaded for ALL modes (~237ms incremental)
- **File**: `dist/modes/index.js:3`
- `export { InteractiveMode } from './interactive/interactive-mode.js'`
- This eagerly imports the entire interactive mode with all 40+ components
- Even `pi --print 'hello'` loads the interactive TUI components
- **Impact**: ~200ms (partially overlapping with agent-session)

#### LOW: loadProjectContextFiles walks entire directory tree
- **File**: `dist/core/resource-loader.js:46-75`
- Walks from cwd to root, checking AGENTS.md and CLAUDE.md at each level
- ~2 stat calls per level × ~5 levels = ~10 stat calls
- **Impact**: ~5-10ms (small but unnecessary for --version)

### 3. Import Graph Issues

**The core problem**: `dist/core/extensions/loader.js` creates a near-circular import:
```
main.js 
  → modes/index.js 
    → interactive-mode.js 
      → agent-session.js 
        → extensions/index.js 
          → extensions/loader.js 
            → ../../index.js (THE ENTIRE PACKAGE!)
            → @mariozechner/pi-agent-core (which imports pi-ai again)
            → @mariozechner/jiti
```

This means importing `main.js` transitively loads almost everything twice through different paths.

**Heavy top-level imports in main.js:**
- `@mariozechner/pi-ai` (line 1)
- `modes/index.js` (line 14) - pulls in interactive mode
- `core/tools/index.js` (line 12) - creates all tool instances
- `core/export-html/index.js` (line 10) - highlight.js

### 4. Extension Loading Analysis

**Discovery**: Extensions come from 3 sources:
1. Package manager resolution (settings.json packages → npm/git/local)
2. CLI `--extension` flags
3. Auto-discovered from project `.pi/` directories

**Loading**: Each extension file is loaded through jiti (TypeScript transpiler):
- `loadExtensionModule()` creates a fresh `createJiti()` instance per call
- `moduleCache: false` means no cross-extension caching
- In Node.js mode, uses `alias` mapping instead of `virtualModules`
- This project has ~13 extension files → 13 jiti instances

**Optimization opportunities**:
- Share a single jiti instance across all extensions
- Enable module caching
- Parallelize extension loading (currently sequential `for...of` loop)
- Lazy-load extensions after first render

### 5. Config/Discovery Analysis

**Settings loading** (fast, ~1ms):
- Reads `~/.pi/agent/settings.json` - single file read
- Reads `.pi/settings.json` in cwd - single file read

**Package resolution** (slow, ~200ms+):
- Resolves npm packages: calls `npm root -g` via spawnSync (129ms)
- Resolves git packages: checks cloned directories
- Resolves local paths: stat checks
- Auto-discovers `.pi/` directory resources

**AGENTS.md discovery** (~5-10ms):
- Walks from cwd to root checking for AGENTS.md/CLAUDE.md
- ~10 stat calls total

### 6. Quick Wins (Easy + High Impact)

1. **Early exit for --version/--help** (~1600ms saved)
   - Check `process.argv` for `--version`/`--help` BEFORE any imports
   - Just `if (process.argv.includes('--version')) { console.log(VERSION); process.exit(0); }`
   - In cli.js, before `import { main } from './main.js'`

2. **Cache npm root -g result** (~129ms saved)
   - Store result in `~/.pi/agent/.npm-root-cache` with TTL
   - Or use `process.env.NPM_CONFIG_PREFIX` / hardcode common paths
   - Or detect from Node.js `process.execPath` parent

3. **Share single jiti instance with module caching** (~300-500ms saved)
   - Create one jiti instance in loader.js and reuse across extensions
   - Set `moduleCache: true` so re-imported modules are cached
   - File: `dist/core/extensions/loader.js:192-201`

4. **Lazy import of extensions/loader.js virtual modules** (~150ms saved)
   - Only import `_bundledPiCodingAgent`, `_bundledPiAgentCore` when `isBunBinary` is true
   - In Node.js mode, these are never used (aliases are used instead)
   - Use `await import()` or conditional static imports

### 7. Medium Effort (Worthwhile)

5. **Defer resourceLoader.reload() for --version/--help/--list-models** (~1074ms saved)
   - Move the reload call after the --version/--help checks
   - Only load extensions when actually entering a session

6. **Lazy import of modes** (~200ms saved)
   - Don't import `InteractiveMode` from modes/index.js at top level
   - Use dynamic `await import()` only when entering interactive mode
   - Same for print mode and RPC mode

7. **Lazy import of export-html in agent-session.js** (~100ms saved)
   - Replace top-level import with dynamic import in the export method
   - `const { exportSessionToHtml } = await import('./export-html/index.js')`

8. **Parallelize extension loading** (~30-50% of jiti time saved)
   - Change sequential `for...of` to `Promise.all()` in `loadExtensions()`
   - File: `dist/core/extensions/loader.js:253-261`

### 8. Large Refactors (Significant Changes)

9. **Tree-shake pi-ai** (~100ms saved)
   - Split pi-ai into subpath exports: `@mariozechner/pi-ai/anthropic`, etc.
   - Only import the provider actually in use
   - Or use dynamic imports for provider modules

10. **Pre-compile extensions** (~500ms+ saved)
    - Cache jiti transpilation results to disk
    - Only re-transpile when source file mtime changes
    - Could eliminate jiti entirely for cached extensions

11. **Bundle main.js with esbuild** (~300ms saved)
    - Single-file bundle eliminates ESM resolution overhead
    - ~27ms+ spent in `compileSourceTextModule` across many small files
    - Tree-shaking would eliminate unused code paths

12. **Move to a plugin architecture with separate processes** (architectural)
    - Extensions run in worker threads or child processes
    - Main process starts fast, extensions load in background
    - First render happens before extensions are ready

### 9. Confidence & Caveats

**High confidence:**
- Import timing measurements are reproducible (ran multiple times)
- The extensions/loader.js circular import is clearly the biggest import-time issue
- `npm root -g` spawnSync is confirmed at 129ms
- resourceLoader.reload() is confirmed at ~1074ms
- --version going through full startup path is clearly wasteful

**Medium confidence:**
- jiti per-extension cost estimates (hard to isolate from general I/O)
- Parallelization savings estimate (depends on I/O vs CPU bound)
- Tree-shaking pi-ai savings (depends on actual bundle analysis)

**Caveats:**
- Measurements on Apple Silicon M-series Mac; ARM Linux or Intel may differ
- Node.js v25.2.1; older versions may have different ESM performance
- Cold vs warm filesystem cache affects all I/O measurements
- The project being analyzed has 13 extensions + 3 packages; minimal setups would be faster
- Some imports overlap in time due to shared dependencies (can't simply add all times)

### Priority Ranking (effort vs impact)

| # | Fix | Est. Savings | Effort |
|---|-----|-------------|--------|
| 1 | Early --version/--help exit | 1600ms for those commands | 5 min |
| 5 | Defer reload for simple commands | 1074ms | 30 min |
| 3 | Share jiti instance + enable caching | 300-500ms | 1 hour |
| 4 | Conditional virtual module imports | 150ms | 30 min |
| 2 | Cache npm root -g | 129ms | 30 min |
| 6 | Lazy mode imports | 200ms | 1 hour |
| 7 | Lazy export-html import | 100ms | 15 min |
| 8 | Parallelize extension loading | 200-400ms | 1 hour |
| 10 | Pre-compile extensions | 500ms+ | 1 day |
| 9 | Tree-shake pi-ai | 100ms | 1 day |
| 11 | Bundle with esbuild | 300ms | 1 day |

**To get under 1 second**: Items 1-5 alone would bring interactive startup from ~1.8s to ~0.5-0.7s.

## Acceptance Criteria
- [ ] TODO

## Verification
- [ ] TODO

## Worktree
- .
