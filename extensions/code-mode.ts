/**
 * Code Mode extension for pi
 *
 * Provides a single `execute_code` tool that lets the LLM write JavaScript
 * calling available tools as typed async functions. More efficient than
 * direct tool calls for multi-step operations and complex logic.
 *
 * Inspired by: https://blog.cloudflare.com/code-mode/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import TurndownService from "turndown";

// =============================================================================
// Constants
// =============================================================================

const EXECUTION_TIMEOUT_MS = 120_000; // 2 minutes overall
const SYNC_TIMEOUT_MS = 5_000; // 5s for parsing/setup
const SUBPROCESS_TIMEOUT_MS = 30_000; // 30s per subprocess
const MAX_OUTPUT_LENGTH = 200_000; // 200KB output cap
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB subprocess buffer

// =============================================================================
// TypeScript Declarations (injected into system prompt)
// =============================================================================

const CODE_MODE_DECLARATIONS = `\
/**
 * Execute a bash command in the current working directory.
 * Returns stdout, stderr, and exit code.
 */
declare function Bash(input: {
  /** Bash command to execute */
  command: string;
  /** Timeout in seconds (default: 30) */
  timeout?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Read the contents of a file.
 * Returns the file text. Supports line-based offset and limit.
 */
declare function Read(input: {
  /** Path to the file (relative to cwd or absolute) */
  path: string;
  /** Line number to start reading from (1-indexed) */
  offset?: number;
  /** Maximum number of lines to read */
  limit?: number;
}): Promise<string>;

/**
 * Write content to a file.
 * Creates parent directories if needed. Overwrites if file exists.
 */
declare function Write(input: {
  /** Path to the file (relative to cwd or absolute) */
  path: string;
  /** Content to write */
  content: string;
}): Promise<void>;

/**
 * Edit a file by replacing exact text.
 * The oldText must match exactly (including whitespace).
 * Returns whether the match was found.
 */
declare function Edit(input: {
  /** Path to the file (relative to cwd or absolute) */
  path: string;
  /** Exact text to find */
  oldText: string;
  /** Replacement text */
  newText: string;
}): Promise<{ matched: boolean }>;

/**
 * Find files by glob pattern.
 * Returns an array of matching file paths (relative to search dir).
 */
declare function Glob(input: {
  /** Glob pattern (e.g., "**/*.ts", "src/**/*.test.js") */
  pattern: string;
  /** Directory to search in (default: cwd) */
  path?: string;
}): Promise<string[]>;

/**
 * Run ripgrep search. Patterns are regex by default; use -F for literal.
 * Returns the raw rg output as a string.
 */
declare function rg(input: {
  /** Arguments to pass to rg (e.g., '-n "pattern" src/') */
  args: string;
  /** Working directory override */
  cwd?: string;
}): Promise<string>;

/**
 * Find files with fd.
 * Returns the raw fd output as a string.
 */
declare function fd(input: {
  /** Arguments to pass to fd (e.g., '-e ts src/') */
  args: string;
  /** Working directory override */
  cwd?: string;
}): Promise<string>;

/**
 * Fetch a URL and return its content as text, markdown, or html.
 */
declare function WebFetch(input: {
  /** URL to fetch (must start with http:// or https://) */
  url: string;
  /** Return format: "text", "markdown", or "html" (default: "text") */
  format?: "text" | "markdown" | "html";
  /** Timeout in seconds (default: 30, max: 120) */
  timeout?: number;
}): Promise<string>;

/** Pause execution for the given number of milliseconds. */
declare function sleep(ms: number): Promise<void>;
`;

// =============================================================================
// System Prompt Addition
// =============================================================================

const CODE_MODE_SYSTEM_PROMPT = `\
# Code Mode

You have an \`execute_code\` tool that runs JavaScript with typed async functions for calling tools.

**ALWAYS prefer code mode** when you need to:
- Chain 2+ tool calls where results feed into each other
- Process, filter, or transform tool output
- Iterate over multiple files or patterns
- Apply conditional logic based on tool results
- Aggregate information from multiple sources

For single, simple tool calls (one read, one search, one edit), direct tool calls are fine.

All functions are async — use \`await\`. Use \`console.log()\` to return output.
Only console output is returned to you. If you don't log anything, you get "(no output)".

\`\`\`typescript
${CODE_MODE_DECLARATIONS}\`\`\`

### Example
\`\`\`javascript
// Find all TypeScript files with TODO comments
const result = await rg({ args: '-l "TODO" --glob "*.ts"' });
const files = result.trim().split("\\n").filter(Boolean);

for (const file of files) {
  const content = await Read({ path: file });
  const todos = content.split("\\n")
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => text.includes("TODO"));
  if (todos.length > 0) {
    console.log(\`\\n## \${file}\`);
    todos.forEach(t => console.log(\`  L\${t.line}: \${t.text}\`));
  }
}
\`\`\`

For tools not available in code mode (todos, memory, teams, hash_read, hash_edit, apply_patch, brave search, etc.), use direct tool calls as normal.`;

// =============================================================================
// Sandbox Tool Implementations
// =============================================================================

function resolvePath(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return filePath;
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return path.resolve(cwd, filePath);
}

function createToolBindings(cwd: string) {
	const turndown = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	turndown.remove(["script", "style", "meta", "link", "noscript"]);

	return {
		Bash: async ({ command, timeout }: { command: string; timeout?: number }) => {
			const timeoutMs = timeout ? timeout * 1000 : SUBPROCESS_TIMEOUT_MS;
			const result = spawnSync("sh", ["-c", command], {
				cwd,
				timeout: timeoutMs,
				maxBuffer: MAX_BUFFER,
				encoding: "utf-8",
			});
			if (result.error) {
				throw new Error(`Bash error: ${result.error.message}`);
			}
			return {
				stdout: result.stdout || "",
				stderr: result.stderr || "",
				exitCode: result.status ?? 1,
			};
		},

		Read: async ({ path: filePath, offset, limit }: { path: string; offset?: number; limit?: number }) => {
			const resolved = resolvePath(filePath, cwd);
			const content = fs.readFileSync(resolved, "utf-8");
			if (!offset && !limit) return content;
			const lines = content.split("\n");
			const start = Math.max(0, (offset || 1) - 1);
			const end = limit ? start + limit : lines.length;
			return lines.slice(start, end).join("\n");
		},

		Write: async ({ path: filePath, content }: { path: string; content: string }) => {
			const resolved = resolvePath(filePath, cwd);
			const dir = path.dirname(resolved);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(resolved, content, "utf-8");
		},

		Edit: async ({ path: filePath, oldText, newText }: { path: string; oldText: string; newText: string }) => {
			const resolved = resolvePath(filePath, cwd);
			const content = fs.readFileSync(resolved, "utf-8");
			if (!content.includes(oldText)) {
				return { matched: false };
			}
			// Replace first occurrence only
			const updated = content.replace(oldText, () => newText);
			fs.writeFileSync(resolved, updated, "utf-8");
			return { matched: true };
		},

		Glob: async ({ pattern, path: searchPath }: { pattern: string; path?: string }) => {
			const dir = searchPath ? resolvePath(searchPath, cwd) : cwd;
			const result = spawnSync("fd", ["--glob", pattern, "--type", "f", "."], {
				cwd: dir,
				encoding: "utf-8",
				timeout: SUBPROCESS_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
			});
			if (result.error) {
				throw new Error(`Glob failed: ${result.error.message}`);
			}
			return (result.stdout || "").trim().split("\n").filter(Boolean);
		},

		rg: async ({ args, cwd: explicitCwd }: { args: string; cwd?: string }) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;
			const result = spawnSync("sh", ["-c", `rg ${args}`], {
				cwd: dir,
				encoding: "utf-8",
				timeout: SUBPROCESS_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
			});
			if (result.error) {
				throw new Error(`rg error: ${result.error.message}`);
			}
			// Return stdout, or stderr if stdout is empty (e.g., no matches produces exit 1)
			return result.stdout || result.stderr || "";
		},

		fd: async ({ args, cwd: explicitCwd }: { args: string; cwd?: string }) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;
			const result = spawnSync("sh", ["-c", `fd ${args}`], {
				cwd: dir,
				encoding: "utf-8",
				timeout: SUBPROCESS_TIMEOUT_MS,
				maxBuffer: MAX_BUFFER,
			});
			if (result.error) {
				throw new Error(`fd error: ${result.error.message}`);
			}
			return result.stdout || result.stderr || "";
		},

		WebFetch: async ({ url, format = "text", timeout = 30 }: { url: string; format?: string; timeout?: number }) => {
			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				throw new Error("URL must start with http:// or https://");
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), Math.min(timeout, 120) * 1000);
			try {
				const response = await fetch(url, {
					signal: controller.signal,
					headers: {
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
						Accept: "text/html,text/plain,text/markdown,*/*",
					},
				});
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}
				const html = await response.text();

				if (format === "html") return html;
				if (format === "markdown") return turndown.turndown(html);
				// text: strip tags
				return html
					.replace(/<\s*(script|style|noscript)[^>]*>[\s\S]*?<\s*\/\1\s*>/gi, " ")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();
			} finally {
				clearTimeout(timer);
			}
		},

		sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
	};
}

// =============================================================================
// Code Execution Engine
// =============================================================================

function formatArg(arg: unknown): string {
	if (typeof arg === "string") return arg;
	if (arg === undefined) return "undefined";
	if (arg === null) return "null";
	try {
		return JSON.stringify(arg, null, 2);
	} catch {
		return String(arg);
	}
}

async function executeCode(
	code: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; error?: string; duration: number }> {
	const logs: string[] = [];
	const bindings = createToolBindings(cwd);

	const sandbox = {
		// Tool functions
		...bindings,

		// Console capture
		console: {
			log: (...args: unknown[]) => logs.push(args.map(formatArg).join(" ")),
			error: (...args: unknown[]) => logs.push("[stderr] " + args.map(formatArg).join(" ")),
			warn: (...args: unknown[]) => logs.push("[warn] " + args.map(formatArg).join(" ")),
			info: (...args: unknown[]) => logs.push(args.map(formatArg).join(" ")),
		},

		// Timers (needed for sleep and async patterns)
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
	};

	const context = vm.createContext(sandbox);
	const wrapped = `(async () => {\n${code}\n})()`;

	const start = Date.now();
	try {
		const promise = vm.runInNewContext(wrapped, context, {
			filename: "code-mode.js",
			timeout: SYNC_TIMEOUT_MS,
		});

		// Race: execution vs timeout vs abort
		const races: Promise<unknown>[] = [promise];

		// Async timeout
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`)),
				EXECUTION_TIMEOUT_MS,
			);
		});
		races.push(timeoutPromise);

		// Abort signal
		if (signal) {
			const abortPromise = new Promise<never>((_, reject) => {
				if (signal.aborted) {
					reject(new Error("Aborted"));
					return;
				}
				signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
			});
			races.push(abortPromise);
		}

		await Promise.race(races);
		if (timeoutHandle) clearTimeout(timeoutHandle);

		return {
			output: logs.join("\n"),
			duration: Date.now() - start,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return {
			output: logs.join("\n"),
			error,
			duration: Date.now() - start,
		};
	}
}

// =============================================================================
// Extension
// =============================================================================

interface CodeModeDetails {
	duration: number;
	error?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "execute_code",
		label: "Code Mode",
		description:
			"Execute JavaScript code with typed async functions for calling tools. " +
			"Use for multi-step operations, loops, data processing, and chaining tool calls. " +
			"Available functions: Bash, Read, Write, Edit, Glob, rg, fd, WebFetch, sleep. " +
			"Use console.log() to return results.",
		parameters: Type.Object({
			code: Type.String({
				description:
					"JavaScript code to execute. All tool functions are async (use await). " +
					"Use console.log() to output results. Errors are caught automatically.",
			}),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const { output, error, duration } = await executeCode(params.code, ctx.cwd, signal);

			let text = output || "";
			if (error) {
				text += (text ? "\n\n" : "") + `Error: ${error}`;
			}
			if (!text) {
				text = "(no output — use console.log() to return results)";
			}

			// Truncate if too large
			if (text.length > MAX_OUTPUT_LENGTH) {
				const tempFile = path.join(os.tmpdir(), `pi-codemode-${Date.now()}.log`);
				fs.writeFileSync(tempFile, text, "utf-8");
				text = text.slice(0, MAX_OUTPUT_LENGTH) + `\n\n[output truncated. Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { duration, error } satisfies CodeModeDetails,
			};
		},
	});

	// Inject code-mode declarations and instructions into system prompt
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + CODE_MODE_SYSTEM_PROMPT,
		};
	});
}
