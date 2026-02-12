import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

import { attachTiming, renderToolResult } from "./lib/tool-ui-utils";
import { createTwoFilesPatch, diffLines } from "diff";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APPLY_PATCH_DESCRIPTION = `Use the \`apply_patch\` tool to edit files. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations.
You MUST include a header to specify the action you are taking.
Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

Example patch:

\`\`\`
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch
\`\`\`

It is important to remember:

- You must include a header with your intended action (Add/Delete/Update)
- You must prefix new lines with \`+\` even when creating a new file`;

const GLOB_DESCRIPTION = `Find files by glob pattern.

Notes:
- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"
- The pattern is matched relative to the search path
- Results are limited to 100 files`;

const CommandToolParams = Type.Object({
	args: Type.Optional(Type.String({ description: "Arguments to pass to the command." })),
	cwd: Type.Optional(Type.String({ description: "Working directory (overrides repo detection)." })),
	repo: Type.Optional(Type.String({ description: "Alias for cwd." })),
});

type CommandToolParamsType = Static<typeof CommandToolParams>;

const GlobParams = Type.Object({
	pattern: Type.String({ description: "The glob pattern to match files against." }),
	path: Type.Optional(
		Type.String({
			description:
				"The directory to search in. If not specified, the current project root will be used. Must be a valid directory path if provided.",
		}),
	),
});

type GlobParamsType = Static<typeof GlobParams>;

const ApplyPatchParams = Type.Object({
	patchText: Type.String({ description: "The full patch text that describes all changes to be made" }),
});

type ApplyPatchParamsType = Static<typeof ApplyPatchParams>;

type UpdateFileChunk = {
	old_lines: string[];
	new_lines: string[];
	change_context?: string;
	is_end_of_file?: boolean;
};

type Hunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] };

const isProjectRoot = (dir: string): boolean => {
	try {
		const gitPath = path.join(dir, ".git");
		if (fs.existsSync(gitPath)) return true;
		const ticketsPath = path.join(dir, ".tickets");
		return fs.existsSync(ticketsPath);
	} catch {
		return false;
	}
};

const findProjectRoot = (start: string): string | undefined => {
	let dir = path.resolve(start);
	while (true) {
		if (isProjectRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
};

const resolveRepo = (cwd: string, explicitCwd?: string): string => {
	if (explicitCwd) return explicitCwd;
	return findProjectRoot(cwd) ?? cwd;
};

const splitArgs = (input: string): string[] => {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escape = false;

	for (const char of input) {
		if (escape) {
			current += char;
			escape = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escape = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "\"" || char === "'") {
			quote = char as "'" | '"';
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current.length > 0) {
		args.push(current);
	}

	return args;
};

const extractCwd = (args: string[]): { cwd?: string; rest: string[] } => {
	let cwd: string | undefined;
	const rest: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (token === "--cwd" || token === "--repo" || token === "-C") {
			cwd = args[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--cwd=") || token.startsWith("--repo=")) {
			cwd = token.split("=")[1];
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			cwd = token.slice(2);
			continue;
		}
		rest.push(token);
	}

	return { cwd, rest };
};

const formatOutput = async (
	output: string,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> => {
	if (!output.trim()) {
		return { text: "(no output)", truncated: false };
	}

	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}

	const tempFile = path.join(os.tmpdir(), `pi-tool-${Date.now()}.log`);
	await fsPromises.writeFile(tempFile, output, "utf8");

	const summary = `\n\n[output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
	return { text: truncation.content + summary, truncated: true, fullOutputPath: tempFile };
};

const runCommand = async (
	pi: ExtensionAPI,
	baseCwd: string,
	command: string,
	args?: string,
	explicitCwd?: string,
	signal?: AbortSignal,
) => {
	const tokens = splitArgs(args ?? "");
	const { cwd: argsCwd, rest } = extractCwd(tokens);
	const cwd = resolveRepo(baseCwd, explicitCwd ?? argsCwd);
	const commandArgs = rest;
	const commandLabel = [command, ...commandArgs].join(" ");

	const result = await pi.exec(command, commandArgs, { cwd, signal });
	const output = [result.stdout, result.stderr].filter(Boolean).join(result.stderr ? "\n" : "");
	const formatted = await formatOutput(output);

	return {
		text: formatted.text,
		details: {
			command: commandLabel,
			cwd,
			exitCode: result.code,
			truncated: formatted.truncated,
			fullOutputPath: formatted.fullOutputPath,
		},
	};
};

const parsePatchHeader = (
	lines: string[],
	startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null => {
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
};

const parseUpdateFileChunks = (
	lines: string[],
	startIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } => {
	const chunks: UpdateFileChunk[] = [];
	let i = startIdx;

	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("@@")) {
			const contextLine = lines[i].substring(2).trim();
			i += 1;

			const oldLines: string[] = [];
			const newLines: string[] = [];
			let isEndOfFile = false;

			while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
				const changeLine = lines[i];

				if (changeLine === "*** End of File") {
					isEndOfFile = true;
					i += 1;
					break;
				}

				if (changeLine.startsWith(" ")) {
					const content = changeLine.substring(1);
					oldLines.push(content);
					newLines.push(content);
				} else if (changeLine.startsWith("-")) {
					oldLines.push(changeLine.substring(1));
				} else if (changeLine.startsWith("+")) {
					newLines.push(changeLine.substring(1));
				}

				i += 1;
			}

			chunks.push({
				old_lines: oldLines,
				new_lines: newLines,
				change_context: contextLine || undefined,
				is_end_of_file: isEndOfFile || undefined,
			});
		} else {
			i += 1;
		}
	}

	return { chunks, nextIdx: i };
};

const parseAddFileContent = (lines: string[], startIdx: number): { content: string; nextIdx: number } => {
	let content = "";
	let i = startIdx;

	while (i < lines.length && !lines[i].startsWith("***")) {
		if (lines[i].startsWith("+")) {
			content += lines[i].substring(1) + "\n";
		}
		i += 1;
	}

	if (content.endsWith("\n")) {
		content = content.slice(0, -1);
	}

	return { content, nextIdx: i };
};

const stripHeredoc = (input: string): string => {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2];
	}
	return input;
};

const parsePatch = (patchText: string): { hunks: Hunk[] } => {
	const cleaned = stripHeredoc(patchText.trim());
	const lines = cleaned.split("\n");
	const hunks: Hunk[] = [];
	let i = 0;

	const beginMarker = "*** Begin Patch";
	const endMarker = "*** End Patch";

	const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
	const endIdx = lines.findIndex((line) => line.trim() === endMarker);

	if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}

	i = beginIdx + 1;

	while (i < endIdx) {
		const header = parsePatchHeader(lines, i);
		if (!header) {
			i += 1;
			continue;
		}

		if (lines[i].startsWith("*** Add File:")) {
			const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
			hunks.push({
				type: "add",
				path: header.filePath,
				contents: content,
			});
			i = nextIdx;
			continue;
		}

		if (lines[i].startsWith("*** Delete File:")) {
			hunks.push({
				type: "delete",
				path: header.filePath,
			});
			i = header.nextIdx;
			continue;
		}

		if (lines[i].startsWith("*** Update File:")) {
			const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
			hunks.push({
				type: "update",
				path: header.filePath,
				move_path: header.movePath,
				chunks,
			});
			i = nextIdx;
			continue;
		}

		i += 1;
	}

	return { hunks };
};

const normalizeUnicode = (value: string): string => {
	return value
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\u00A0/g, " ");
};

type Comparator = (a: string, b: string) => boolean;

const tryMatch = (lines: string[], pattern: string[], startIndex: number, compare: Comparator, eof: boolean): number => {
	if (eof) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex) {
			let matches = true;
			for (let j = 0; j < pattern.length; j += 1) {
				if (!compare(lines[fromEnd + j], pattern[j])) {
					matches = false;
					break;
				}
			}
			if (matches) return fromEnd;
		}
	}

	for (let i = startIndex; i <= lines.length - pattern.length; i += 1) {
		let matches = true;
		for (let j = 0; j < pattern.length; j += 1) {
			if (!compare(lines[i + j], pattern[j])) {
				matches = false;
				break;
			}
		}
		if (matches) return i;
	}

	return -1;
};

const seekSequence = (lines: string[], pattern: string[], startIndex: number, eof = false): number => {
	if (pattern.length === 0) return -1;

	const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
	if (exact !== -1) return exact;

	const rstrip = tryMatch(lines, pattern, startIndex, (a, b) => a.trimEnd() === b.trimEnd(), eof);
	if (rstrip !== -1) return rstrip;

	const trim = tryMatch(lines, pattern, startIndex, (a, b) => a.trim() === b.trim(), eof);
	if (trim !== -1) return trim;

	return tryMatch(lines, pattern, startIndex, (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()), eof);
};

const applyReplacements = (lines: string[], replacements: Array<[number, number, string[]]>): string[] => {
	const result = [...lines];

	for (let i = replacements.length - 1; i >= 0; i -= 1) {
		const [startIdx, oldLen, newSegment] = replacements[i];
		result.splice(startIdx, oldLen);
		for (let j = 0; j < newSegment.length; j += 1) {
			result.splice(startIdx + j, 0, newSegment[j]);
		}
	}

	return result;
};

const computeReplacements = (
	originalLines: string[],
	filePath: string,
	chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> => {
	const replacements: Array<[number, number, string[]]> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.change_context) {
			const contextIdx = seekSequence(originalLines, [chunk.change_context], lineIndex);
			if (contextIdx === -1) {
				throw new Error(`Failed to find context '${chunk.change_context}' in ${filePath}`);
			}
			lineIndex = contextIdx + 1;
		}

		if (chunk.old_lines.length === 0) {
			const insertionIdx =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			replacements.push([insertionIdx, 0, chunk.new_lines]);
			continue;
		}

		let pattern = chunk.old_lines;
		let newSlice = chunk.new_lines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);

		if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			found = seekSequence(originalLines, pattern, lineIndex, chunk.is_end_of_file);
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
};

const generateUnifiedDiff = (oldContent: string, newContent: string): string => {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	let diff = "@@ -1 +1 @@\n";
	const maxLen = Math.max(oldLines.length, newLines.length);
	let hasChanges = false;

	for (let i = 0; i < maxLen; i += 1) {
		const oldLine = oldLines[i] || "";
		const newLine = newLines[i] || "";

		if (oldLine !== newLine) {
			if (oldLine) diff += `-${oldLine}\n`;
			if (newLine) diff += `+${newLine}\n`;
			hasChanges = true;
		} else if (oldLine) {
			diff += ` ${oldLine}\n`;
		}
	}

	return hasChanges ? diff : "";
};

const deriveNewContentsFromChunks = (filePath: string, chunks: UpdateFileChunk[]) => {
	let originalContent: string;
	try {
		originalContent = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read file ${filePath}: ${error}`);
	}

	let originalLines = originalContent.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}

	const replacements = computeReplacements(originalLines, filePath, chunks);
	let newLines = applyReplacements(originalLines, replacements);

	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}

	const newContent = newLines.join("\n");
	const unifiedDiff = generateUnifiedDiff(originalContent, newContent);

	return {
		unified_diff: unifiedDiff,
		content: newContent,
	};
};

const trimDiff = (diff: string): string => {
	const lines = diff.split("\n");
	const contentLines = lines.filter(
		(line) =>
			(line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
			!line.startsWith("---") &&
			!line.startsWith("+++"),
	);

	if (contentLines.length === 0) return diff;

	let min = Infinity;
	for (const line of contentLines) {
		const content = line.slice(1);
		if (content.trim().length > 0) {
			const match = content.match(/^(\s*)/);
			if (match) min = Math.min(min, match[1].length);
		}
	}
	if (min === Infinity || min === 0) return diff;

	const trimmedLines = lines.map((line) => {
		if (
			(line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
			!line.startsWith("---") &&
			!line.startsWith("+++")
		) {
			const prefix = line[0];
			const content = line.slice(1);
			return prefix + content.slice(min);
		}
		return line;
	});

	return trimmedLines.join("\n");
};

const applyPatch = async (baseCwd: string, patchText: string) => {
	if (!patchText) {
		throw new Error("patchText is required");
	}

	let hunks: Hunk[];
	try {
		const parseResult = parsePatch(patchText);
		hunks = parseResult.hunks;
	} catch (error) {
		throw new Error(`apply_patch verification failed: ${error}`);
	}

	if (hunks.length === 0) {
		const normalized = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
		if (normalized === "*** Begin Patch\n*** End Patch") {
			throw new Error("patch rejected: empty patch");
		}
		throw new Error("apply_patch verification failed: no hunks found");
	}

	const fileChanges: Array<{
		filePath: string;
		oldContent: string;
		newContent: string;
		type: "add" | "update" | "delete" | "move";
		movePath?: string;
		diff: string;
		additions: number;
		deletions: number;
	}> = [];

	let totalDiff = "";

	for (const hunk of hunks) {
		const filePath = path.resolve(baseCwd, hunk.path);

		switch (hunk.type) {
			case "add": {
				const oldContent = "";
				const newContent =
					hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`;
				const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));

				let additions = 0;
				let deletions = 0;
				for (const change of diffLines(oldContent, newContent)) {
					if (change.added) additions += change.count || 0;
					if (change.removed) deletions += change.count || 0;
				}

				fileChanges.push({
					filePath,
					oldContent,
					newContent,
					type: "add",
					diff,
					additions,
					deletions,
				});

				totalDiff += diff + "\n";
				break;
			}

			case "update": {
				const stats = await fsPromises.stat(filePath).catch(() => null);
				if (!stats || stats.isDirectory()) {
					throw new Error(`apply_patch verification failed: Failed to read file to update: ${filePath}`);
				}

				const oldContent = await fsPromises.readFile(filePath, "utf-8");
				let newContent = oldContent;

				try {
					const fileUpdate = deriveNewContentsFromChunks(filePath, hunk.chunks);
					newContent = fileUpdate.content;
				} catch (error) {
					throw new Error(`apply_patch verification failed: ${error}`);
				}

				const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent));

				let additions = 0;
				let deletions = 0;
				for (const change of diffLines(oldContent, newContent)) {
					if (change.added) additions += change.count || 0;
					if (change.removed) deletions += change.count || 0;
				}

				const movePath = hunk.move_path ? path.resolve(baseCwd, hunk.move_path) : undefined;

				fileChanges.push({
					filePath,
					oldContent,
					newContent,
					type: hunk.move_path ? "move" : "update",
					movePath,
					diff,
					additions,
					deletions,
				});

				totalDiff += diff + "\n";
				break;
			}

			case "delete": {
				const contentToDelete = await fsPromises.readFile(filePath, "utf-8").catch((error) => {
					throw new Error(`apply_patch verification failed: ${error}`);
				});
				const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""));
				const deletions = contentToDelete.split("\n").length;

				fileChanges.push({
					filePath,
					oldContent: contentToDelete,
					newContent: "",
					type: "delete",
					diff: deleteDiff,
					additions: 0,
					deletions,
				});

				totalDiff += deleteDiff + "\n";
				break;
			}
		}
	}

	for (const change of fileChanges) {
		switch (change.type) {
			case "add":
				await fsPromises.mkdir(path.dirname(change.filePath), { recursive: true });
				await fsPromises.writeFile(change.filePath, change.newContent, "utf-8");
				break;

			case "update":
				await fsPromises.writeFile(change.filePath, change.newContent, "utf-8");
				break;

			case "move":
				if (change.movePath) {
					await fsPromises.mkdir(path.dirname(change.movePath), { recursive: true });
					await fsPromises.writeFile(change.movePath, change.newContent, "utf-8");
					await fsPromises.unlink(change.filePath);
				}
				break;

			case "delete":
				await fsPromises.unlink(change.filePath);
				break;
		}
	}

	const summaryLines = fileChanges.map((change) => {
		if (change.type === "add") {
			return `A ${path.relative(baseCwd, change.filePath)}`;
		}
		if (change.type === "delete") {
			return `D ${path.relative(baseCwd, change.filePath)}`;
		}
		const target = change.movePath ?? change.filePath;
		return `M ${path.relative(baseCwd, target)}`;
	});

	const output = `Success. Updated the following files:\n${summaryLines.join("\n")}`;

	return {
		output,
		diff: totalDiff,
		files: fileChanges.map((change) => ({
			filePath: change.filePath,
			relativePath: path.relative(baseCwd, change.movePath ?? change.filePath),
			type: change.type,
			diff: change.diff,
			before: change.oldContent,
			after: change.newContent,
			additions: change.additions,
			deletions: change.deletions,
			movePath: change.movePath,
		})),
	};
};

const runGlob = async (pi: ExtensionAPI, baseCwd: string, params: GlobParamsType, signal?: AbortSignal) => {
	let search = params.path ?? baseCwd;
	search = path.isAbsolute(search) ? search : path.resolve(baseCwd, search);

	const result = await pi.exec("rg", ["--files", "-g", params.pattern], { cwd: search, signal });
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();
	if (result.code !== 0 && !stdout) {
		const formatted = await formatOutput([stdout, stderr].filter(Boolean).join("\n"));
		return {
			text: formatted.text,
			details: { cwd: search, exitCode: result.code, truncated: formatted.truncated },
		};
	}

	const lines = stdout ? stdout.split(/\r?\n/).filter(Boolean) : [];
	const files: Array<{ path: string; mtime: number }> = [];
	let truncated = false;
	const limit = 100;

	for (const line of lines) {
		if (files.length >= limit) {
			truncated = true;
			break;
		}
		const full = path.resolve(search, line);
		const stats = await fsPromises
			.stat(full)
			.then((value) => value.mtime.getTime())
			.catch(() => 0);
		files.push({ path: full, mtime: stats });
	}

	files.sort((a, b) => b.mtime - a.mtime);

	const output: string[] = [];
	if (files.length === 0) {
		output.push("No files found");
	} else {
		output.push(...files.map((item) => item.path));
		if (truncated) {
			output.push("");
			output.push(`(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`);
		}
	}

	return {
		text: output.join("\n"),
		details: {
			cwd: search,
			count: files.length,
			truncated,
		},
	};
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description: APPLY_PATCH_DESCRIPTION,
		parameters: ApplyPatchParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: ApplyPatchParamsType, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const baseCwd = resolveRepo(ctx.cwd);
			const result = await applyPatch(baseCwd, params.patchText);
			const endedAt = Date.now();
			return {
				content: [{ type: "text", text: result.output }],
				details: attachTiming(
					{
						diff: result.diff,
						files: result.files,
						cwd: baseCwd,
					},
					{ startedAt, endedAt, durationMs: endedAt - startedAt },
				),
			};
		},
	});

	pi.registerTool({
		name: "glob",
		label: "Glob",
		description: GLOB_DESCRIPTION,
		parameters: GlobParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: GlobParamsType, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const baseCwd = resolveRepo(ctx.cwd);
			const result = await runGlob(pi, baseCwd, params, signal);
			const endedAt = Date.now();
			return {
				content: [{ type: "text", text: result.text }],
				details: attachTiming(result.details, { startedAt, endedAt, durationMs: endedAt - startedAt }),
			};
		},
	});

	pi.registerTool({
		name: "rg",
		label: "rg",
		description: "Run ripgrep (rg) commands.",
		parameters: CommandToolParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: CommandToolParamsType, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const result = await runCommand(pi, ctx.cwd, "rg", params.args, params.cwd ?? params.repo, signal);
			const endedAt = Date.now();
			return {
				content: [{ type: "text", text: result.text }],
				details: attachTiming(result.details, { startedAt, endedAt, durationMs: endedAt - startedAt }),
			};
		},
	});

	pi.registerTool({
		name: "fd",
		label: "fd",
		description: "Run fd commands.",
		parameters: CommandToolParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: CommandToolParamsType, signal, _onUpdate, ctx) {
			const startedAt = Date.now();
			const result = await runCommand(pi, ctx.cwd, "fd", params.args, params.cwd ?? params.repo, signal);
			const endedAt = Date.now();
			return {
				content: [{ type: "text", text: result.text }],
				details: attachTiming(result.details, { startedAt, endedAt, durationMs: endedAt - startedAt }),
			};
		},
	});
}
