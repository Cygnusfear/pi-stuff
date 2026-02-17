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
import { spawn } from "node:child_process";
import crypto from "node:crypto";
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

/**
 * Run tk (ticket) CLI commands.
 */
declare function tk(input: {
  /** Arguments to pass to tk CLI (default: "ls") */
  args?: string;
  /** Working directory override */
  cwd?: string;
}): Promise<{ stdout: string; exitCode: number }>;

/**
 * Create a tk ticket, start it, and append the Goal/AC/Verification template.
 */
declare function tkOneshot(input: {
  title: string;
  description: string;
  tags: string;
  type?: string;
  priority?: number;
  goal?: string;
  acceptanceCriteria?: string[];
  verification?: string[];
  worktree?: string;
  start?: boolean;
  cwd?: string;
}): Promise<{ id: string; filePath: string; started: boolean; appendedTemplate: boolean; message: string }>;

/**
 * Search TotalRecall semantic memory. Returns JSON string with ranked results.
 */
declare function recall(input: {
  query: string;
  limit?: number;
  nodeType?: "decision" | "learning" | "entity" | "event" | "task" | "summary";
  minScore?: number;
}): Promise<string>;

/**
 * Get relevant memories for a task/topic. Returns JSON string.
 */
declare function memoryContext(input: {
  task: string;
  maxNodes?: number;
}): Promise<string>;

/**
 * Create a new memory node in TotalRecall. Returns JSON string.
 */
declare function memoryCreate(input: {
  nodeType: "decision" | "learning" | "entity" | "event" | "task" | "summary";
  oneLiner: string;
  summary: string;
  fullSynthesis?: string;
  entityName?: string;
  repo?: string;
}): Promise<string>;

/**
 * Unfold a memory node for more detail. Returns JSON string.
 */
declare function memoryUnfold(input: {
  nodeId: string;
  depth?: "summary" | "full" | "raw";
}): Promise<string>;

/**
 * Get TotalRecall database status. Returns JSON string.
 */
declare function memoryStatus(): Promise<string>;

/**
 * Search the web via Brave Search API. Returns formatted text results.
 */
declare function braveSearch(input: {
  query: string;
  numResults?: number;
  type?: "llm_context" | "web";
}): Promise<string>;

/**
 * Search for code/docs via Brave Search. Returns formatted text results.
 */
declare function braveCodeSearch(input: {
  query: string;
  numResults?: number;
}): Promise<string>;

/**
 * Get the current date and time.
 */
declare function getCurrentTime(format?: string): Promise<{
  formatted: string;
  date: string;
  time: string;
  timezone: string;
  day_of_week: string;
  unix: number;
}>;

/**
 * Read a file with hashline anchors (LINENUM:HASH|LINE per line).
 * Use with hashEdit for anchor-verified editing.
 */
declare function hashRead(input: {
  path: string;
  startLine?: number;
  endLine?: number;
}): Promise<string>;

/**
 * Edit a file using hashline anchors for verification.
 * Rejects if file changed since last hashRead (hash mismatch).
 */
declare function hashEdit(input: {
  path: string;
  edits: Array<
    | { set_line: { anchor: string; new_text: string } }
    | { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
    | { insert_after: { anchor: string; text: string } }
  >;
}): Promise<{ appliedEdits: number; changed: boolean; summary: string }>;

/**
 * Apply a patch in pi's stripped-down diff format.
 * Supports Add File, Delete File, Update File with context-based matching.
 */
declare function applyPatch(input: {
  patchText: string;
}): Promise<string>;
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

For tools not available in code mode (teams), use direct tool calls as normal.`;

// =============================================================================
// Sandbox Tool Implementations
// =============================================================================

function shellEsc(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

const TOTALRECALL_ENV = {
	...process.env,
	DATABASE_URL: process.env.DATABASE_URL || "postgresql://totalrecall:totalrecall_dev@localhost:5432/totalrecall",
};

// =============================================================================
// Hashline Engine (shared logic from hashline-tools.ts)
// =============================================================================

type HashlineEdit =
	| { set_line: { anchor: string; new_text: string } }
	| { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
	| { insert_after: { anchor: string; text: string } };

function computeLineHash(line: string): string {
	const normalized = (line.endsWith("\r") ? line.slice(0, -1) : line).replace(/\s+/g, "");
	return crypto.createHash("sha1").update(normalized).digest().subarray(0, 1).toString("hex");
}

function formatHashLines(content: string, startLine = 1, endLine?: number): string {
	const lines = content.split("\n");
	const startIdx = Math.max(0, startLine - 1);
	const endIdx = endLine === undefined ? lines.length - 1 : Math.min(lines.length - 1, endLine - 1);
	const out: string[] = [];
	for (let i = startIdx; i <= endIdx; i += 1) {
		const line = lines[i] ?? "";
		out.push(`${i + 1}:${computeLineHash(line)}|${line}`);
	}
	return out.join("\n");
}

function parseAnchor(anchor: string): { line: number; hash: string } {
	const m = /^(\d+):([0-9a-fA-F]+)$/.exec(anchor.trim());
	if (!m) throw new Error(`Invalid anchor '${anchor}'. Expected '<line>:<hash>'.`);
	const line = Number(m[1]);
	if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid anchor '${anchor}': line must be >= 1.`);
	return { line, hash: m[2].toLowerCase() };
}

function assertAnchorMatches(fileLines: string[], ref: { line: number; hash: string }, which: string) {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(`${which} anchor line out of range: ${ref.line}. File has ${fileLines.length} line(s). Re-read the file.`);
	}
	const actual = computeLineHash(fileLines[ref.line - 1] ?? "");
	if (actual !== ref.hash) {
		throw new Error(`${which} anchor mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual}. Re-read the file and retry.`);
	}
}

function applyHashEdits(original: string, edits: HashlineEdit[]): { updated: string; appliedEdits: number } {
	const hasTrailingNewline = original.endsWith("\n");
	const lines = original.split("\n");
	let applied = 0;

	for (const edit of edits) {
		if ("set_line" in edit) {
			const { line, hash } = parseAnchor(edit.set_line.anchor);
			assertAnchorMatches(lines, { line, hash }, "set_line");
			lines.splice(line - 1, 1, ...edit.set_line.new_text.split("\n"));
			applied += 1;
		} else if ("replace_lines" in edit) {
			const start = parseAnchor(edit.replace_lines.start_anchor);
			const end = parseAnchor(edit.replace_lines.end_anchor);
			if (end.line < start.line) throw new Error(`replace_lines invalid range: end ${end.line} < start ${start.line}.`);
			assertAnchorMatches(lines, start, "replace_lines(start)");
			assertAnchorMatches(lines, end, "replace_lines(end)");
			lines.splice(start.line - 1, end.line - start.line + 1, ...edit.replace_lines.new_text.split("\n"));
			applied += 1;
		} else if ("insert_after" in edit) {
			const { line, hash } = parseAnchor(edit.insert_after.anchor);
			assertAnchorMatches(lines, { line, hash }, "insert_after");
			lines.splice(line, 0, ...edit.insert_after.text.split("\n"));
			applied += 1;
		}
	}

	let updated = lines.join("\n");
	if (hasTrailingNewline && !updated.endsWith("\n")) updated += "\n";
	if (!hasTrailingNewline && updated.endsWith("\n")) updated = updated.slice(0, -1);
	return { updated, appliedEdits: applied };
}

// =============================================================================
// Patch Engine (shared logic from file-tools.ts)
// =============================================================================

type PatchUpdateChunk = {
	old_lines: string[];
	new_lines: string[];
	change_context?: string;
	is_end_of_file?: boolean;
};

type PatchHunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; move_path?: string; chunks: PatchUpdateChunk[] };

function parsePatchHeader(lines: string[], startIdx: number): { filePath: string; movePath?: string; nextIdx: number } | null {
	const line = lines[startIdx];
	if (line.startsWith("*** Add File:")) {
		const filePath = line.split(":", 2)[1]?.trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}
	if (line.startsWith("*** Delete File:")) {
		const filePath = line.split(":", 2)[1]?.trim();
		return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
	}
	if (line.startsWith("*** Update File:")) {
		const filePath = line.split(":", 2)[1]?.trim();
		let movePath: string | undefined;
		let nextIdx = startIdx + 1;
		if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
			movePath = lines[nextIdx].split(":", 2)[1]?.trim();
			nextIdx += 1;
		}
		return filePath ? { filePath, movePath, nextIdx } : null;
	}
	return null;
}

function parseUpdateChunks(lines: string[], startIdx: number): { chunks: PatchUpdateChunk[]; nextIdx: number } {
	const chunks: PatchUpdateChunk[] = [];
	let i = startIdx;
	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("@@")) {
			const contextLine = lines[i].substring(2).trim();
			i += 1;
			const oldLines: string[] = [];
			const newLines: string[] = [];
			let isEndOfFile = false;
			while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
				const cl = lines[i];
				if (cl === "*** End of File") { isEndOfFile = true; i += 1; break; }
				if (cl.startsWith(" ")) { const c = cl.substring(1); oldLines.push(c); newLines.push(c); }
				else if (cl.startsWith("-")) { oldLines.push(cl.substring(1)); }
				else if (cl.startsWith("+")) { newLines.push(cl.substring(1)); }
				i += 1;
			}
			chunks.push({ old_lines: oldLines, new_lines: newLines, change_context: contextLine || undefined, is_end_of_file: isEndOfFile || undefined });
		} else { i += 1; }
	}
	return { chunks, nextIdx: i };
}

function parseAddContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
	let content = "";
	let i = startIdx;
	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("+")) content += lines[i].substring(1) + "\n";
		i += 1;
	}
	if (content.endsWith("\n")) content = content.slice(0, -1);
	return { content, nextIdx: i };
}

function parsePatchText(patchText: string): PatchHunk[] {
	const cleaned = patchText.trim();
	// Strip heredoc wrapper if present
	const heredocMatch = cleaned.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	const text = heredocMatch ? heredocMatch[2] : cleaned;
	const lines = text.split("\n");

	const beginIdx = lines.findIndex((l) => l.trim() === "*** Begin Patch");
	const endIdx = lines.findIndex((l) => l.trim() === "*** End Patch");
	if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}

	const hunks: PatchHunk[] = [];
	let i = beginIdx + 1;
	while (i < endIdx) {
		const header = parsePatchHeader(lines, i);
		if (!header) { i += 1; continue; }
		if (lines[i].startsWith("*** Add File:")) {
			const { content, nextIdx } = parseAddContent(lines, header.nextIdx);
			hunks.push({ type: "add", path: header.filePath, contents: content });
			i = nextIdx;
		} else if (lines[i].startsWith("*** Delete File:")) {
			hunks.push({ type: "delete", path: header.filePath });
			i = header.nextIdx;
		} else if (lines[i].startsWith("*** Update File:")) {
			const { chunks, nextIdx } = parseUpdateChunks(lines, header.nextIdx);
			hunks.push({ type: "update", path: header.filePath, move_path: header.movePath, chunks });
			i = nextIdx;
		} else { i += 1; }
	}
	return hunks;
}

function patchNormalizeUnicode(value: string): string {
	return value
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010-\u2015]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\u00A0/g, " ");
}

function patchSeekSequence(lines: string[], pattern: string[], startIndex: number, eof = false): number {
	if (pattern.length === 0) return -1;
	const comparators: Array<(a: string, b: string) => boolean> = [
		(a, b) => a === b,
		(a, b) => a.trimEnd() === b.trimEnd(),
		(a, b) => a.trim() === b.trim(),
		(a, b) => patchNormalizeUnicode(a.trim()) === patchNormalizeUnicode(b.trim()),
	];
	for (const compare of comparators) {
		if (eof) {
			const fromEnd = lines.length - pattern.length;
			if (fromEnd >= startIndex) {
				let ok = true;
				for (let j = 0; j < pattern.length; j++) { if (!compare(lines[fromEnd + j], pattern[j])) { ok = false; break; } }
				if (ok) return fromEnd;
			}
		}
		for (let i = startIndex; i <= lines.length - pattern.length; i++) {
			let ok = true;
			for (let j = 0; j < pattern.length; j++) { if (!compare(lines[i + j], pattern[j])) { ok = false; break; } }
			if (ok) return i;
		}
	}
	return -1;
}

function patchComputeReplacements(originalLines: string[], filePath: string, chunks: PatchUpdateChunk[]): Array<[number, number, string[]]> {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;
	for (const chunk of chunks) {
		if (chunk.change_context) {
			const idx = patchSeekSequence(originalLines, [chunk.change_context], lineIndex);
			if (idx === -1) throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
			lineIndex = idx + 1;
		}
		if (chunk.old_lines.length === 0) {
			const ins = originalLines.length > 0 && originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
			replacements.push([ins, 0, chunk.new_lines]);
			continue;
		}
		let pattern = chunk.old_lines;
		let newSlice = chunk.new_lines;
		let found = patchSeekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") newSlice = newSlice.slice(0, -1);
			found = patchSeekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
		}
		if (found !== -1) {
			replacements.push([found, pattern.length, newSlice]);
			lineIndex = found + pattern.length;
			continue;
		}
		throw new Error(`Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}`);
	}
	replacements.sort((a, b) => a[0] - b[0]);
	return replacements;
}

function patchApplyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
	const result = [...lines];
	for (let i = replacements.length - 1; i >= 0; i--) {
		const [startIdx, oldLen, newSegment] = replacements[i];
		result.splice(startIdx, oldLen);
		for (let j = 0; j < newSegment.length; j++) result.splice(startIdx + j, 0, newSegment[j]);
	}
	return result;
}

function patchDeriveNewContent(filePath: string, chunks: PatchUpdateChunk[]): string {
	let originalContent: string;
	try { originalContent = fs.readFileSync(filePath, "utf-8"); }
	catch (error) { throw new Error(`Failed to read file ${filePath}: ${error}`); }
	let originalLines = originalContent.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") originalLines.pop();
	const replacements = patchComputeReplacements(originalLines, filePath, chunks);
	let newLines = patchApplyReplacements(originalLines, replacements);
	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") newLines.push("");
	return newLines.join("\n");
}

// =============================================================================
// Sandbox Helpers
// =============================================================================

function resolvePath(filePath: string, cwd: string): string {
	if (path.isAbsolute(filePath)) return filePath;
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return path.resolve(cwd, filePath);
}

interface SpawnAsyncOptions {
	cmd: string;
	args: string[];
	cwd?: string;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
}

interface SpawnAsyncResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error;
}

/**
 * Async spawn that doesn't block the event loop.
 * Drop-in replacement for spawnSync with the same result shape.
 */
function spawnAsync({
	cmd,
	args,
	cwd: spawnCwd,
	timeout = SUBPROCESS_TIMEOUT_MS,
	env,
}: SpawnAsyncOptions): Promise<SpawnAsyncResult> {
	return new Promise((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutLen = 0;
		let stderrLen = 0;
		let settled = false;

		const child = spawn(cmd, args, {
			cwd: spawnCwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill("SIGKILL");
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					status: null,
					error: new Error(`Timed out after ${timeout}ms`),
				});
			}
		}, timeout);

		child.stdout!.on("data", (chunk: Buffer) => {
			stdoutLen += chunk.length;
			if (stdoutLen <= MAX_BUFFER) stdoutChunks.push(chunk);
		});

		child.stderr!.on("data", (chunk: Buffer) => {
			stderrLen += chunk.length;
			if (stderrLen <= MAX_BUFFER) stderrChunks.push(chunk);
		});

		child.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					status: null,
					error: err,
				});
			}
		});

		child.on("close", (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
					stderr: Buffer.concat(stderrChunks).toString("utf-8"),
					status: code,
				});
			}
		});
	});
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
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", command],
				cwd,
				timeout: timeoutMs,
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
			const result = await spawnAsync({
				cmd: "fd",
				args: ["--glob", pattern, "--type", "f", "."],
				cwd: dir,
			});
			if (result.error) {
				throw new Error(`Glob failed: ${result.error.message}`);
			}
			return (result.stdout || "").trim().split("\n").filter(Boolean);
		},

		rg: async ({ args, cwd: explicitCwd }: { args: string; cwd?: string }) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `rg ${args}`],
				cwd: dir,
			});
			if (result.error) {
				throw new Error(`rg error: ${result.error.message}`);
			}
			// Return stdout, or stderr if stdout is empty (e.g., no matches produces exit 1)
			return result.stdout || result.stderr || "";
		},

		fd: async ({ args, cwd: explicitCwd }: { args: string; cwd?: string }) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `fd ${args}`],
				cwd: dir,
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
			const signal = AbortSignal.timeout(Math.min(timeout, 120) * 1000);
			const response = await fetch(url, {
				signal,
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
		},

		sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),

		// =====================================================================
		// Ticket management (tk CLI)
		// =====================================================================

		tk: async ({ args = "ls", cwd: explicitCwd }: { args?: string; cwd?: string }) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `tk ${args}`],
				cwd: dir,
			});
			if (result.error) throw new Error(`tk error: ${result.error.message}`);
			const stdout = (result.stdout || "") + (result.stderr ? "\n" + result.stderr : "");
			return { stdout: stdout.trim(), exitCode: result.status ?? 1 };
		},

		tkOneshot: async ({
			title,
			description,
			tags,
			type = "task",
			priority = 2,
			goal,
			acceptanceCriteria,
			verification,
			worktree = ".",
			start = true,
			cwd: explicitCwd,
		}: {
			title: string;
			description: string;
			tags: string;
			type?: string;
			priority?: number;
			goal?: string;
			acceptanceCriteria?: string[];
			verification?: string[];
			worktree?: string;
			start?: boolean;
			cwd?: string;
		}) => {
			const dir = explicitCwd ? resolvePath(explicitCwd, cwd) : cwd;

			// Create ticket
			const createResult = await spawnAsync({
				cmd: "tk",
				args: ["create", title, "-t", type, "-p", String(priority), "--tags", tags, "-d", description],
				cwd: dir,
			});
			if (createResult.error) throw new Error(`tk create error: ${createResult.error.message}`);
			if (createResult.status !== 0) {
				throw new Error(`tk create failed: ${(createResult.stderr || createResult.stdout || "").trim()}`);
			}

			const id = (createResult.stdout || "").trim().split(/\s+/)[0];
			if (!id) throw new Error("Failed to parse ticket id from tk output");

			// Start ticket
			let started = false;
			if (start) {
				const startResult = await spawnAsync({
					cmd: "tk",
					args: ["start", id],
					cwd: dir,
				});
				started = startResult.status === 0;
			}

			// Append template
			const filePath = path.join(dir, ".tickets", `${id}.md`);
			const buildChecklist = (items?: string[]) => {
				const filtered = (items ?? []).filter((s) => s.trim());
				const effective = filtered.length > 0 ? filtered : ["TODO"];
				return effective.map((item) => `- [ ] ${item}`).join("\n");
			};

			const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
			let appendedTemplate = false;
			if (!current.includes("\n## Goal\n")) {
				const goalText = (goal || description).trim();
				const template = `\n\n## Goal\n${goalText}\n\n## Acceptance Criteria\n${buildChecklist(acceptanceCriteria)}\n\n## Verification\n${buildChecklist(verification)}\n\n## Worktree\n- ${worktree}\n`;
				fs.appendFileSync(filePath, template, "utf-8");
				appendedTemplate = true;
			}

			return {
				id,
				filePath,
				started,
				appendedTemplate,
				message: `Created ${id}${started ? " (started)" : ""}. ${appendedTemplate ? "Template appended." : ""}`,
			};
		},

		// =====================================================================
		// TotalRecall memory tools
		// =====================================================================

		recall: async ({
			query,
			limit = 10,
			nodeType,
			minScore,
		}: {
			query: string;
			limit?: number;
			nodeType?: string;
			minScore?: number;
		}) => {
			const args = [`recall -o json -l ${limit}`];
			if (minScore) args.push(`-m ${minScore}`);
			if (nodeType) args.push(`-t ${nodeType}`);
			args.push(shellEsc(query));
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `totalrecall ${args.join(" ")}`],
				env: TOTALRECALL_ENV,
			});
			if (result.error) throw new Error(`totalrecall error: ${result.error.message}`);
			if (result.status !== 0)
				throw new Error(`totalrecall error: ${(result.stderr || result.stdout || "").trim()}`);
			return result.stdout || "";
		},

		memoryContext: async ({ task, maxNodes = 10 }: { task: string; maxNodes?: number }) => {
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `totalrecall context -o json -t ${shellEsc(task)} -n ${maxNodes}`],
				env: TOTALRECALL_ENV,
			});
			if (result.error) throw new Error(`totalrecall error: ${result.error.message}`);
			if (result.status !== 0)
				throw new Error(`totalrecall error: ${(result.stderr || result.stdout || "").trim()}`);
			return result.stdout || "";
		},

		memoryCreate: async ({
			nodeType,
			oneLiner,
			summary,
			fullSynthesis,
			entityName,
			repo,
		}: {
			nodeType: string;
			oneLiner: string;
			summary: string;
			fullSynthesis?: string;
			entityName?: string;
			repo?: string;
		}) => {
			const args = [
				`create -o json`,
				`-t ${nodeType}`,
				`-1 ${shellEsc(oneLiner)}`,
				`-s ${shellEsc(summary)}`,
			];
			if (fullSynthesis) args.push(`-f ${shellEsc(fullSynthesis)}`);
			if (entityName) args.push(`-e ${shellEsc(entityName)}`);
			if (repo) args.push(`--repo ${shellEsc(repo)}`);

			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `totalrecall ${args.join(" ")}`],
				env: TOTALRECALL_ENV,
			});
			if (result.error) throw new Error(`totalrecall error: ${result.error.message}`);
			if (result.status !== 0)
				throw new Error(`totalrecall error: ${(result.stderr || result.stdout || "").trim()}`);
			return result.stdout || "";
		},

		memoryUnfold: async ({ nodeId, depth = "full" }: { nodeId: string; depth?: string }) => {
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", `totalrecall unfold -o json -d ${depth} ${shellEsc(nodeId)}`],
				env: TOTALRECALL_ENV,
			});
			if (result.error) throw new Error(`totalrecall error: ${result.error.message}`);
			if (result.status !== 0)
				throw new Error(`totalrecall error: ${(result.stderr || result.stdout || "").trim()}`);
			return result.stdout || "";
		},

		memoryStatus: async () => {
			const result = await spawnAsync({
				cmd: "sh",
				args: ["-c", "totalrecall status -o json"],
				env: TOTALRECALL_ENV,
			});
			if (result.error) throw new Error(`totalrecall error: ${result.error.message}`);
			if (result.status !== 0)
				throw new Error(`totalrecall error: ${(result.stderr || result.stdout || "").trim()}`);
			return result.stdout || "";
		},

		// =====================================================================
		// Brave Search
		// =====================================================================

		braveSearch: async ({
			query,
			numResults = 5,
			type = "llm_context",
		}: {
			query: string;
			numResults?: number;
			type?: string;
		}) => {
			const apiKey = process.env.BRAVE_API_KEY;
			if (!apiKey) throw new Error("BRAVE_API_KEY not set");

			const url =
				type === "web"
					? "https://api.search.brave.com/res/v1/web/search"
					: "https://api.search.brave.com/res/v1/llm/context";

			const params = new URLSearchParams({ q: query, count: String(numResults) });
			const r = await fetch(`${url}?${params}`, {
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
					"X-Subscription-Token": apiKey,
				},
				signal: AbortSignal.timeout(15_000),
			});

			if (!r.ok) throw new Error(`Brave API ${r.status}: ${(await r.text()).slice(0, 200)}`);
			const data = (await r.json()) as Record<string, any>;

			if (type !== "web") {
				const results = (data.grounding?.generic ?? []) as Array<{
					title: string;
					url: string;
					snippets: string[];
				}>;
				return (
					results
						.map(
							(res) =>
								`### ${res.title}\n${res.url}\n\n${res.snippets?.slice(0, 3).join("\n\n") || ""}`,
						)
						.join("\n\n---\n\n") || "No results."
				);
			}

			const results = (data.web?.results ?? []) as Array<{
				title: string;
				url: string;
				description?: string;
			}>;
			return (
				results
					.map(
						(res, i) =>
							`${i + 1}. ${res.title}\n   ${res.url}\n   ${(res.description || "").replace(/<\/?strong>/g, "**")}`,
					)
					.join("\n\n") || "No results."
			);
		},

		braveCodeSearch: async ({
			query,
			numResults = 5,
		}: {
			query: string;
			numResults?: number;
		}) => {
			const apiKey = process.env.BRAVE_API_KEY;
			if (!apiKey) throw new Error("BRAVE_API_KEY not set");

			const params = new URLSearchParams({ q: query, count: String(numResults) });
			const r = await fetch(
				`https://api.search.brave.com/res/v1/llm/context?${params}`,
				{
					headers: {
						Accept: "application/json",
						"Accept-Encoding": "identity",
						"X-Subscription-Token": apiKey,
					},
					signal: AbortSignal.timeout(15_000),
				},
			);

			if (!r.ok) throw new Error(`Brave API ${r.status}: ${(await r.text()).slice(0, 200)}`);
			const data = (await r.json()) as Record<string, any>;
			const results = (data.grounding?.generic ?? []) as Array<{
				title: string;
				url: string;
				snippets: string[];
			}>;
			return (
				results
					.map(
						(res) =>
							`### ${res.title}\n${res.url}\n\n${res.snippets?.slice(0, 3).join("\n\n") || ""}`,
					)
					.join("\n\n---\n\n") || "No results."
			);
		},

		// =====================================================================
		// Time
		// =====================================================================

		getCurrentTime: async (format?: string) => {
			const now = new Date();
			const fmt = (format || "iso8601").toLowerCase();

			let formatted: string;
			switch (fmt) {
				case "iso8601":
				case "iso":
					formatted = now.toISOString();
					break;
				case "unix":
					formatted = String(Math.floor(now.getTime() / 1000));
					break;
				case "date":
					formatted = now.toLocaleDateString();
					break;
				case "time":
					formatted = now.toLocaleTimeString();
					break;
				default:
					formatted = now.toISOString();
			}

			const offsetMin = -now.getTimezoneOffset();
			const h = Math.floor(Math.abs(offsetMin) / 60);
			const m = Math.abs(offsetMin) % 60;
			const sign = offsetMin >= 0 ? "+" : "-";

			return {
				formatted,
				date: now.toLocaleDateString("en-CA"),
				time: now.toLocaleTimeString("en-GB", { hour12: false }),
				timezone: `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
				day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }),
				unix: Math.floor(now.getTime() / 1000),
			};
		},

		// =====================================================================
		// Hashline tools
		// =====================================================================

		hashRead: async ({
			path: filePath,
			startLine,
			endLine,
		}: {
			path: string;
			startLine?: number;
			endLine?: number;
		}) => {
			const resolved = resolvePath(filePath, cwd);
			const content = fs.readFileSync(resolved, "utf-8");
			return formatHashLines(content, startLine ?? 1, endLine);
		},

		hashEdit: async ({
			path: filePath,
			edits,
		}: {
			path: string;
			edits: HashlineEdit[];
		}) => {
			const resolved = resolvePath(filePath, cwd);
			const before = fs.readFileSync(resolved, "utf-8");
			const { updated, appliedEdits } = applyHashEdits(before, edits);
			const changed = updated !== before;
			if (changed) {
				fs.writeFileSync(resolved, updated, "utf-8");
			}
			return {
				appliedEdits,
				changed,
				summary: `Applied ${appliedEdits} edit(s) to ${filePath}.${changed ? "" : " (no changes)"}`,
			};
		},

		// =====================================================================
		// Apply Patch
		// =====================================================================

		applyPatch: async ({ patchText }: { patchText: string }) => {
			if (!patchText) throw new Error("patchText is required");

			const hunks = parsePatchText(patchText);
			if (hunks.length === 0) throw new Error("apply_patch: no hunks found");

			const results: string[] = [];

			for (const hunk of hunks) {
				const filePath = path.resolve(cwd, hunk.path);

				switch (hunk.type) {
					case "add": {
						const content = hunk.contents.length === 0 || hunk.contents.endsWith("\n")
							? hunk.contents
							: `${hunk.contents}\n`;
						fs.mkdirSync(path.dirname(filePath), { recursive: true });
						fs.writeFileSync(filePath, content, "utf-8");
						results.push(`A ${hunk.path}`);
						break;
					}
					case "delete": {
						fs.unlinkSync(filePath);
						results.push(`D ${hunk.path}`);
						break;
					}
					case "update": {
						const newContent = patchDeriveNewContent(filePath, hunk.chunks);
						const movePath = hunk.move_path ? path.resolve(cwd, hunk.move_path) : undefined;
						if (movePath) {
							fs.mkdirSync(path.dirname(movePath), { recursive: true });
							fs.writeFileSync(movePath, newContent, "utf-8");
							fs.unlinkSync(filePath);
							results.push(`M ${hunk.move_path} (moved from ${hunk.path})`);
						} else {
							fs.writeFileSync(filePath, newContent, "utf-8");
							results.push(`M ${hunk.path}`);
						}
						break;
					}
				}
			}

			return `Success. Updated the following files:\n${results.join("\n")}`;
		},
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
			"Available functions: Bash, Read, Write, Edit, Glob, rg, fd, WebFetch, sleep, " +
			"tk, tkOneshot, recall, memoryContext, memoryCreate, memoryUnfold, memoryStatus, " +
			"braveSearch, braveCodeSearch, getCurrentTime, hashRead, hashEdit, applyPatch. " +
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
