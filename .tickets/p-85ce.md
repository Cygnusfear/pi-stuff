---
id: p-85ce
status: in_progress
deps: []
links: []
created: 2026-02-14T06:04:48Z
type: task
priority: 2
assignee: Alexander Mangel
tags: [research, oracle]
---
# Oracle 3: Pi boot time optimization analysis

# Pi Boot Time Optimization Analysis - Oracle 3

## Methodology
Traced the entire startup path from `#!/usr/bin/env node` entry through `main()` to ready state. Measured import costs, runtime operations, and identified bottlenecks using Node.js timing and isolated module loading tests.

## Current Measurements
- `pi --version`: **1.6s** (should exit nearly instantly)
- `pi --print "hi"`: **3.7s** (includes API call ~2s)
- Module import cost (just loading main.js): **~500ms**
- Runtime cost before version check exits: **~1.1s additional**

## 1. Startup Path Map

```
1. Node.js starts, loads /opt/homebrew/bin/pi (cli.js)
2. `import { main } from "./main.js"` → triggers ENTIRE module graph load (~500ms)
   - main.js top-level imports:
     - @mariozechner/pi-ai (~200ms) - all provider SDKs
     - chalk (3ms)
     - cli/args.js, cli/config-selector.js, cli/file-processor.js, etc.
     - config.js (5ms)
     - core/auth-storage.js
     - core/defaults.js
     - core/export-html/index.js
     - core/keybindings.js
     - core/model-registry.js (~220ms, pulls in pi-ai)
     - core/model-resolver.js
     - core/package-manager.js
     - core/resource-loader.js (~560ms, pulls in theme.js → cli-highlight 100ms)
     - core/sdk.js (~580ms, pulls in everything)
     - core/session-manager.js
     - core/settings-manager.js
     - core/tools/index.js (70ms)
     - migrations.js
     - modes/index.js (~490ms) → interactive-mode.js (~445ms)
       → imports pi-tui, ALL UI components, clipboard, etc.
     - modes/interactive/theme/theme.js (~110ms, cli-highlight 100ms)
3. main(argv) called:
   a. handlePackageCommand(args) - fast check
   b. handleConfigCommand(args) - fast check  
   c. runMigrations(cwd) - sync, fast
   d. parseArgs(args) - first pass, fast
   e. SettingsManager.create(cwd, agentDir) - reads settings.json files
   f. new AuthStorage() - fast
   g. new ModelRegistry(authStorage, modelsPath) - fast
   h. new DefaultResourceLoader({...}) - construction, fast
   i. await resourceLoader.reload() ← **THE BIG ONE (~800-1000ms)**
      i.1. packageManager.resolve():
           - For each npm package: npmNeedsUpdate() → HTTP GET to registry.npmjs.org
           - 2 npm packages × ~300ms each = **~600ms of network I/O**
           - These are SERIALIZED in a for-loop
      i.2. loadExtensions(paths):
           - Each extension: new jiti instance (moduleCache: false) + dynamic import
           - Extensions loaded SERIALLY in for-loop
           - brave-search.ts: **~600ms** (imports @mariozechner/pi-ai via jiti with no cache)
           - context.ts: **~850ms** first load (imports DynamicBorder from SDK)
           - All other extensions: ~5-50ms each
           - Total extension loading: **~200-1500ms** depending on cache state
      i.3. loadSkills() - filesystem scan, moderate
      i.4. loadPromptTemplates() - filesystem scan, fast
      i.5. loadThemeFromPath() - fast
      i.6. loadProjectContextFiles() - AGENTS.md walk cwd→root, ~10 existsSync calls, fast
   j. Extension flag processing - fast
   k. parseArgs second pass - fast
   l. >>> parsed.version check HERE ← **version exits only after ALL the above**
   m. ... more work for non-version paths ...
```

## 2. Bottleneck Analysis

### Bottleneck 1: npm Registry Checks on Every Startup (~600ms)
**File:** `dist/core/package-manager.js:816-848` (`npmNeedsUpdate`)
**Impact:** ~600ms (2 HTTP requests × ~300ms each, serialized)
**Cause:** For unpinned npm packages, `getLatestNpmVersion()` fetches from `https://registry.npmjs.org/{pkg}/latest` on EVERY startup to check if an update is available.
**Evidence:** Measured 283ms and 390ms for the two npm packages.

### Bottleneck 2: Module Import Graph (~500ms)
**File:** `dist/main.js` top-level imports
**Impact:** ~500ms before `main()` even starts
**Cause:** All imports are eager/top-level. `modes/index.js` re-exports `InteractiveMode` which pulls in the entire TUI, all UI components, pi-tui, clipboard utils, etc. Even `--version` or `--help` pays this cost.
**Key heavy imports:**
- `@mariozechner/pi-ai`: 200ms (all AI provider clients)
- `modes/interactive/interactive-mode.js`: 445ms (pi-tui, all components)
- `cli-highlight`: 100ms (pulled in by theme.js, used for syntax highlighting)

### Bottleneck 3: Extension Loading via jiti (~200-1500ms)
**File:** `dist/core/extensions/loader.js:192-204` (`loadExtensionModule`)
**Impact:** Variable, 200-1500ms depending on what extensions import
**Cause:** Each extension creates a NEW jiti instance with `moduleCache: false`. jiti transpiles TypeScript at runtime. Extensions that import runtime values from `@mariozechner/pi-coding-agent` force jiti to re-resolve the full SDK module graph.
**Evidence:** `brave-search.ts` takes 600ms alone (imports runtime values needing full SDK resolution through jiti).

### Bottleneck 4: Version/Help Check Too Late
**File:** `dist/main.js:442-505`
**Impact:** Makes `--version` and `--help` take 1.6s instead of <100ms
**Cause:** `parsed.version` check is at line ~505, but SettingsManager, ResourceLoader, and full `resourceLoader.reload()` (with npm checks, extension loading) all run before it.

### Bottleneck 5: Serial Extension Loading
**File:** `dist/core/extensions/loader.js:253-260`
**Impact:** Extensions loaded one-by-one in a for-loop with `await`
**Cause:** `for (const extPath of paths) { await loadExtension(extPath, ...) }` - no parallelism.

## 3. Import Graph Issues

### Heavy Top-Level Imports That Could Be Lazy
1. **`modes/index.js`** - re-exports `InteractiveMode`, `runPrintMode`, `runRpcMode`. Only ONE mode is ever used per invocation, but all are imported.
2. **`core/export-html/index.js`** - only used for `--export` flag, imported always.
3. **`core/keybindings.js`** - only needed for interactive mode.
4. **`cli/session-picker.js`** - only needed for `--resume`.
5. **`cli/list-models.js`** - only needed for `--list-models`.
6. **`@mariozechner/pi-ai`** - imported at top of main.js for `modelsAreEqual`, `supportsXhigh` type checks.
7. **`cli-highlight`** (via theme.js via resource-loader.js) - 100ms, only needed for rendering code blocks.

### Circular/Transitive Import Issues
- `resource-loader.js` imports `theme.js` (from `modes/interactive/`) which pulls in `cli-highlight` (100ms) just for `loadThemeFromPath`. Theme loading at resource-loader level should not require the full highlighting engine.

## 4. Extension Loading Analysis

### Current Approach
- Extensions discovered by scanning `~/.pi/agent/extensions/`, `.pi/extensions/`, and package-declared paths
- Each extension is a TypeScript file loaded via jiti (runtime TypeScript transpilation)
- Each load creates a fresh jiti instance with `moduleCache: false`
- Extensions are loaded serially
- The extension factory function is called immediately (not deferred)

### Optimization Opportunities
1. **Share a single jiti instance** with module caching enabled across all extensions
2. **Parallelize extension loading** with `Promise.all(paths.map(p => loadExtension(p, ...)))`
3. **Pre-compile extensions** to JavaScript at install time so jiti only does ESM→CJS interop, not full TS transpilation
4. **Lazy-load extensions** - register metadata eagerly but defer factory execution until actually needed
5. **Cache extension transpilation results** to disk (jiti supports `fsCache`)

## 5. Config/Discovery Analysis

### File I/O at Startup
- `~/.pi/agent/settings.json` - read once (fast)
- `.pi/settings.json` - read once (fast, usually doesn't exist)
- AGENTS.md/CLAUDE.md walk from cwd to root - ~10 `existsSync` calls (~5 dirs × 2 candidates)
- Auto-discovery scans `~/.pi/agent/{extensions,skills,prompts,themes}/` and `.pi/{extensions,skills,prompts,themes}/` - 8 directory reads
- Each npm package: `existsSync` + read package.json + HTTP registry check
- Skills: filesystem scan of skill directories
- These are all sync `existsSync`/`readdirSync`/`readFileSync` calls

### Network I/O at Startup  
- **npm registry checks**: 1 HTTP request per unpinned npm package per startup
- No caching/TTL on these checks

## 6. Quick Wins (Easy, High Impact)

### QW1: Move --version/--help check before resource loading (~1s saved for those commands)
Move the version and help checks right after the first `parseArgs` call, before SettingsManager and ResourceLoader. This is trivial.

### QW2: Cache npm registry checks with TTL (~600ms saved)
Store `{version, checkedAt}` and skip registry HTTP calls if checked within last N hours (e.g., 24h). Or use `--no-update-check` flag. File: `package-manager.js:816`.

### QW3: Parallelize npm registry checks (~300ms saved)
Change the serial for-loop in `resolvePackageSources` to use `Promise.all` for the HTTP calls.

### QW4: Pin npm package versions in settings (~600ms saved)
User-facing: encourage pinning versions (e.g., `"npm:pi-subdir-context@1.0.0"`) which skips the registry check entirely (line 832: if pinnedVersion, just compare strings).

## 7. Medium Effort (Worthwhile, More Work)

### ME1: Lazy-import modes (save ~300-400ms of import time)
In `main.js`, don't import `InteractiveMode`, `runPrintMode`, `runRpcMode` at top level. Use dynamic `import()` only when the mode is determined. Same for `export-html`, `session-picker`, `list-models`.

### ME2: Share jiti instance with module caching across extensions (~200-500ms saved)
Create ONE jiti instance with `moduleCache: true` (or use a shared Map) and reuse it for all extension loads. This avoids re-resolving `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` for each extension.

### ME3: Parallelize extension loading (~100-300ms saved)
Change `loadExtensions` from serial for-loop to `Promise.all`. Extensions don't depend on each other's load order.

### ME4: Lazy-import cli-highlight (save ~100ms)
`theme.js` imports `cli-highlight` at top level. This could be a dynamic import, loaded only when syntax highlighting is first needed.

### ME5: Lazy-import @mariozechner/pi-ai (save ~200ms)
Currently imported at main.js top level for `modelsAreEqual` and `supportsXhigh`. These could be dynamic imports or the functions could be moved.

## 8. Large Refactors (Significant Changes for Significant Gains)

### LR1: Pre-compile extensions to JavaScript at install/first-run
Instead of jiti transpiling TypeScript on every startup, compile extensions to .js at `pi install` time or first load. Cache in `~/.pi/agent/cache/compiled/`. This eliminates jiti overhead entirely.

### LR2: Bundle the CLI with tree-shaking
Use esbuild/rollup to bundle the entire CLI into a single file with tree-shaking. This eliminates the 500ms module graph resolution cost. The pi-ai package especially benefits since only the used provider would be included.

### LR3: Two-phase startup
Phase 1 (sync, fast): Parse args, show version/help, basic config.
Phase 2 (async, deferred): Load extensions, resolve packages, initialize TUI.
This architecture ensures simple commands respond instantly.

### LR4: Extension metadata caching
Cache extension discovery results (paths, flags, tools metadata) and only re-scan when mtimes change. Skip loading extension code entirely if only metadata is needed.

## 9. Confidence & Caveats

### High Confidence
- npm registry checks are ~600ms serialized - measured directly
- Module import graph is ~500ms - measured directly
- Extension loading via jiti with no cache is slow for SDK-importing extensions - measured directly
- Version/help check placement is clearly suboptimal - visible in source

### Medium Confidence
- Parallelizing extension loading would save 100-300ms - depends on how many are CPU-bound vs I/O-bound
- Shared jiti cache would help significantly - depends on jiti internals

### Lower Confidence
- Exact savings from lazy imports depend on what the user's actual startup path is (interactive vs print vs rpc)
- Bundling would help but exact savings depend on tree-shaking effectiveness
- Extension pre-compilation feasibility depends on jiti's caching mechanisms

### Caveats
- All measurements taken on Apple Silicon Mac with warm disk cache
- Network latency for npm registry varies by location/connection
- Only analyzed the installed dist/ (no source access), so some internal details may differ
- The current project has 15+ extensions and 2 npm packages; projects with fewer would be faster

## Summary: Path to Sub-1-Second Startup

| Optimization | Est. Savings | Effort |
|---|---|---|
| QW1: Move --version/--help early | ~1s (for those cmds) | Trivial |
| QW2: Cache npm checks with TTL | ~600ms | Easy |
| QW3: Parallelize npm checks | ~300ms | Easy |
| ME1: Lazy-import modes | ~300ms | Medium |
| ME2: Share jiti instance | ~300ms | Medium |
| ME4: Lazy cli-highlight | ~100ms | Easy |
| ME5: Lazy pi-ai | ~200ms | Medium |
| **Combined** | **~800ms+** | |

With QW2 + ME1 + ME2 + ME4 alone, startup should drop from ~1.6s to ~0.6-0.8s for the common interactive case. The npm registry check caching is the single highest-impact change.



## Goal
# Pi Boot Time Optimization Analysis - Oracle 3

## Methodology
Traced the entire startup path from `#!/usr/bin/env node` entry through `main()` to ready state. Measured import costs, runtime operations, and identified bottlenecks using Node.js timing and isolated module loading tests.

## Current Measurements
- `pi --version`: **1.6s** (should exit nearly instantly)
- `pi --print "hi"`: **3.7s** (includes API call ~2s)
- Module import cost (just loading main.js): **~500ms**
- Runtime cost before version check exits: **~1.1s additional**

## 1. Startup Path Map

```
1. Node.js starts, loads /opt/homebrew/bin/pi (cli.js)
2. `import { main } from "./main.js"` → triggers ENTIRE module graph load (~500ms)
   - main.js top-level imports:
     - @mariozechner/pi-ai (~200ms) - all provider SDKs
     - chalk (3ms)
     - cli/args.js, cli/config-selector.js, cli/file-processor.js, etc.
     - config.js (5ms)
     - core/auth-storage.js
     - core/defaults.js
     - core/export-html/index.js
     - core/keybindings.js
     - core/model-registry.js (~220ms, pulls in pi-ai)
     - core/model-resolver.js
     - core/package-manager.js
     - core/resource-loader.js (~560ms, pulls in theme.js → cli-highlight 100ms)
     - core/sdk.js (~580ms, pulls in everything)
     - core/session-manager.js
     - core/settings-manager.js
     - core/tools/index.js (70ms)
     - migrations.js
     - modes/index.js (~490ms) → interactive-mode.js (~445ms)
       → imports pi-tui, ALL UI components, clipboard, etc.
     - modes/interactive/theme/theme.js (~110ms, cli-highlight 100ms)
3. main(argv) called:
   a. handlePackageCommand(args) - fast check
   b. handleConfigCommand(args) - fast check  
   c. runMigrations(cwd) - sync, fast
   d. parseArgs(args) - first pass, fast
   e. SettingsManager.create(cwd, agentDir) - reads settings.json files
   f. new AuthStorage() - fast
   g. new ModelRegistry(authStorage, modelsPath) - fast
   h. new DefaultResourceLoader({...}) - construction, fast
   i. await resourceLoader.reload() ← **THE BIG ONE (~800-1000ms)**
      i.1. packageManager.resolve():
           - For each npm package: npmNeedsUpdate() → HTTP GET to registry.npmjs.org
           - 2 npm packages × ~300ms each = **~600ms of network I/O**
           - These are SERIALIZED in a for-loop
      i.2. loadExtensions(paths):
           - Each extension: new jiti instance (moduleCache: false) + dynamic import
           - Extensions loaded SERIALLY in for-loop
           - brave-search.ts: **~600ms** (imports @mariozechner/pi-ai via jiti with no cache)
           - context.ts: **~850ms** first load (imports DynamicBorder from SDK)
           - All other extensions: ~5-50ms each
           - Total extension loading: **~200-1500ms** depending on cache state
      i.3. loadSkills() - filesystem scan, moderate
      i.4. loadPromptTemplates() - filesystem scan, fast
      i.5. loadThemeFromPath() - fast
      i.6. loadProjectContextFiles() - AGENTS.md walk cwd→root, ~10 existsSync calls, fast
   j. Extension flag processing - fast
   k. parseArgs second pass - fast
   l. >>> parsed.version check HERE ← **version exits only after ALL the above**
   m. ... more work for non-version paths ...
```

## 2. Bottleneck Analysis

### Bottleneck 1: npm Registry Checks on Every Startup (~600ms)
**File:** `dist/core/package-manager.js:816-848` (`npmNeedsUpdate`)
**Impact:** ~600ms (2 HTTP requests × ~300ms each, serialized)
**Cause:** For unpinned npm packages, `getLatestNpmVersion()` fetches from `https://registry.npmjs.org/{pkg}/latest` on EVERY startup to check if an update is available.
**Evidence:** Measured 283ms and 390ms for the two npm packages.

### Bottleneck 2: Module Import Graph (~500ms)
**File:** `dist/main.js` top-level imports
**Impact:** ~500ms before `main()` even starts
**Cause:** All imports are eager/top-level. `modes/index.js` re-exports `InteractiveMode` which pulls in the entire TUI, all UI components, pi-tui, clipboard utils, etc. Even `--version` or `--help` pays this cost.
**Key heavy imports:**
- `@mariozechner/pi-ai`: 200ms (all AI provider clients)
- `modes/interactive/interactive-mode.js`: 445ms (pi-tui, all components)
- `cli-highlight`: 100ms (pulled in by theme.js, used for syntax highlighting)

### Bottleneck 3: Extension Loading via jiti (~200-1500ms)
**File:** `dist/core/extensions/loader.js:192-204` (`loadExtensionModule`)
**Impact:** Variable, 200-1500ms depending on what extensions import
**Cause:** Each extension creates a NEW jiti instance with `moduleCache: false`. jiti transpiles TypeScript at runtime. Extensions that import runtime values from `@mariozechner/pi-coding-agent` force jiti to re-resolve the full SDK module graph.
**Evidence:** `brave-search.ts` takes 600ms alone (imports runtime values needing full SDK resolution through jiti).

### Bottleneck 4: Version/Help Check Too Late
**File:** `dist/main.js:442-505`
**Impact:** Makes `--version` and `--help` take 1.6s instead of <100ms
**Cause:** `parsed.version` check is at line ~505, but SettingsManager, ResourceLoader, and full `resourceLoader.reload()` (with npm checks, extension loading) all run before it.

### Bottleneck 5: Serial Extension Loading
**File:** `dist/core/extensions/loader.js:253-260`
**Impact:** Extensions loaded one-by-one in a for-loop with `await`
**Cause:** `for (const extPath of paths) { await loadExtension(extPath, ...) }` - no parallelism.

## 3. Import Graph Issues

### Heavy Top-Level Imports That Could Be Lazy
1. **`modes/index.js`** - re-exports `InteractiveMode`, `runPrintMode`, `runRpcMode`. Only ONE mode is ever used per invocation, but all are imported.
2. **`core/export-html/index.js`** - only used for `--export` flag, imported always.
3. **`core/keybindings.js`** - only needed for interactive mode.
4. **`cli/session-picker.js`** - only needed for `--resume`.
5. **`cli/list-models.js`** - only needed for `--list-models`.
6. **`@mariozechner/pi-ai`** - imported at top of main.js for `modelsAreEqual`, `supportsXhigh` type checks.
7. **`cli-highlight`** (via theme.js via resource-loader.js) - 100ms, only needed for rendering code blocks.

### Circular/Transitive Import Issues
- `resource-loader.js` imports `theme.js` (from `modes/interactive/`) which pulls in `cli-highlight` (100ms) just for `loadThemeFromPath`. Theme loading at resource-loader level should not require the full highlighting engine.

## 4. Extension Loading Analysis

### Current Approach
- Extensions discovered by scanning `~/.pi/agent/extensions/`, `.pi/extensions/`, and package-declared paths
- Each extension is a TypeScript file loaded via jiti (runtime TypeScript transpilation)
- Each load creates a fresh jiti instance with `moduleCache: false`
- Extensions are loaded serially
- The extension factory function is called immediately (not deferred)

### Optimization Opportunities
1. **Share a single jiti instance** with module caching enabled across all extensions
2. **Parallelize extension loading** with `Promise.all(paths.map(p => loadExtension(p, ...)))`
3. **Pre-compile extensions** to JavaScript at install time so jiti only does ESM→CJS interop, not full TS transpilation
4. **Lazy-load extensions** - register metadata eagerly but defer factory execution until actually needed
5. **Cache extension transpilation results** to disk (jiti supports `fsCache`)

## 5. Config/Discovery Analysis

### File I/O at Startup
- `~/.pi/agent/settings.json` - read once (fast)
- `.pi/settings.json` - read once (fast, usually doesn't exist)
- AGENTS.md/CLAUDE.md walk from cwd to root - ~10 `existsSync` calls (~5 dirs × 2 candidates)
- Auto-discovery scans `~/.pi/agent/{extensions,skills,prompts,themes}/` and `.pi/{extensions,skills,prompts,themes}/` - 8 directory reads
- Each npm package: `existsSync` + read package.json + HTTP registry check
- Skills: filesystem scan of skill directories
- These are all sync `existsSync`/`readdirSync`/`readFileSync` calls

### Network I/O at Startup  
- **npm registry checks**: 1 HTTP request per unpinned npm package per startup
- No caching/TTL on these checks

## 6. Quick Wins (Easy, High Impact)

### QW1: Move --version/--help check before resource loading (~1s saved for those commands)
Move the version and help checks right after the first `parseArgs` call, before SettingsManager and ResourceLoader. This is trivial.

### QW2: Cache npm registry checks with TTL (~600ms saved)
Store `{version, checkedAt}` and skip registry HTTP calls if checked within last N hours (e.g., 24h). Or use `--no-update-check` flag. File: `package-manager.js:816`.

### QW3: Parallelize npm registry checks (~300ms saved)
Change the serial for-loop in `resolvePackageSources` to use `Promise.all` for the HTTP calls.

### QW4: Pin npm package versions in settings (~600ms saved)
User-facing: encourage pinning versions (e.g., `"npm:pi-subdir-context@1.0.0"`) which skips the registry check entirely (line 832: if pinnedVersion, just compare strings).

## 7. Medium Effort (Worthwhile, More Work)

### ME1: Lazy-import modes (save ~300-400ms of import time)
In `main.js`, don't import `InteractiveMode`, `runPrintMode`, `runRpcMode` at top level. Use dynamic `import()` only when the mode is determined. Same for `export-html`, `session-picker`, `list-models`.

### ME2: Share jiti instance with module caching across extensions (~200-500ms saved)
Create ONE jiti instance with `moduleCache: true` (or use a shared Map) and reuse it for all extension loads. This avoids re-resolving `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` for each extension.

### ME3: Parallelize extension loading (~100-300ms saved)
Change `loadExtensions` from serial for-loop to `Promise.all`. Extensions don't depend on each other's load order.

### ME4: Lazy-import cli-highlight (save ~100ms)
`theme.js` imports `cli-highlight` at top level. This could be a dynamic import, loaded only when syntax highlighting is first needed.

### ME5: Lazy-import @mariozechner/pi-ai (save ~200ms)
Currently imported at main.js top level for `modelsAreEqual` and `supportsXhigh`. These could be dynamic imports or the functions could be moved.

## 8. Large Refactors (Significant Changes for Significant Gains)

### LR1: Pre-compile extensions to JavaScript at install/first-run
Instead of jiti transpiling TypeScript on every startup, compile extensions to .js at `pi install` time or first load. Cache in `~/.pi/agent/cache/compiled/`. This eliminates jiti overhead entirely.

### LR2: Bundle the CLI with tree-shaking
Use esbuild/rollup to bundle the entire CLI into a single file with tree-shaking. This eliminates the 500ms module graph resolution cost. The pi-ai package especially benefits since only the used provider would be included.

### LR3: Two-phase startup
Phase 1 (sync, fast): Parse args, show version/help, basic config.
Phase 2 (async, deferred): Load extensions, resolve packages, initialize TUI.
This architecture ensures simple commands respond instantly.

### LR4: Extension metadata caching
Cache extension discovery results (paths, flags, tools metadata) and only re-scan when mtimes change. Skip loading extension code entirely if only metadata is needed.

## 9. Confidence & Caveats

### High Confidence
- npm registry checks are ~600ms serialized - measured directly
- Module import graph is ~500ms - measured directly
- Extension loading via jiti with no cache is slow for SDK-importing extensions - measured directly
- Version/help check placement is clearly suboptimal - visible in source

### Medium Confidence
- Parallelizing extension loading would save 100-300ms - depends on how many are CPU-bound vs I/O-bound
- Shared jiti cache would help significantly - depends on jiti internals

### Lower Confidence
- Exact savings from lazy imports depend on what the user's actual startup path is (interactive vs print vs rpc)
- Bundling would help but exact savings depend on tree-shaking effectiveness
- Extension pre-compilation feasibility depends on jiti's caching mechanisms

### Caveats
- All measurements taken on Apple Silicon Mac with warm disk cache
- Network latency for npm registry varies by location/connection
- Only analyzed the installed dist/ (no source access), so some internal details may differ
- The current project has 15+ extensions and 2 npm packages; projects with fewer would be faster

## Summary: Path to Sub-1-Second Startup

| Optimization | Est. Savings | Effort |
|---|---|---|
| QW1: Move --version/--help early | ~1s (for those cmds) | Trivial |
| QW2: Cache npm checks with TTL | ~600ms | Easy |
| QW3: Parallelize npm checks | ~300ms | Easy |
| ME1: Lazy-import modes | ~300ms | Medium |
| ME2: Share jiti instance | ~300ms | Medium |
| ME4: Lazy cli-highlight | ~100ms | Easy |
| ME5: Lazy pi-ai | ~200ms | Medium |
| **Combined** | **~800ms+** | |

With QW2 + ME1 + ME2 + ME4 alone, startup should drop from ~1.6s to ~0.6-0.8s for the common interactive case. The npm registry check caching is the single highest-impact change.

## Acceptance Criteria
- [ ] TODO

## Verification
- [ ] TODO

## Worktree
- .
