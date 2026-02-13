import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { renderToolResult } from "./lib/tool-ui-utils";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Hashline format: "<line>:<hash>|<content>"
// Anchor format used in edits: "<line>:<hash>"

const HASHLINE_TOOL_DESCRIPTION = `Hashline tools provide stable, verifiable anchors for file editing.

- hash_read returns file content with each line prefixed as: LINENUM:HASH|LINE
- hash_edit applies structured edits referencing anchors of the form: LINENUM:HASH

If the file changed since last read (hash mismatch), the edit is rejected.`;

const HashReadParams = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative to the current working directory)." }),
	startLine: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed start line (inclusive). Defaults to 1." })),
	endLine: Type.Optional(
		Type.Integer({ minimum: 1, description: "1-indexed end line (inclusive). Defaults to end of file." }),
	),
});

type HashReadParamsType = Static<typeof HashReadParams>;

const Anchor = Type.String({
	description: "Anchor in the form <line>:<hash>, e.g. 12:af",
});

type HashlineEdit =
	| { set_line: { anchor: string; new_text: string } }
	| { replace_lines: { start_anchor: string; end_anchor: string; new_text: string } }
	| { insert_after: { anchor: string; text: string } };

const HashlineEditSchema = Type.Union([
	Type.Object({
		set_line: Type.Object({
			anchor: Anchor,
			new_text: Type.String({ description: "Replacement text for the line (may contain newlines)." }),
		}),
	}),
	Type.Object({
		replace_lines: Type.Object({
			start_anchor: Anchor,
			end_anchor: Anchor,
			new_text: Type.String({ description: "Replacement text for the range (may contain newlines)." }),
		}),
	}),
	Type.Object({
		insert_after: Type.Object({
			anchor: Anchor,
			text: Type.String({ description: "Text to insert after the referenced line (may contain newlines)." }),
		}),
	}),
]);

const HashEditParams = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative to the current working directory)." }),
	edits: Type.Array(HashlineEditSchema, { description: "List of hashline edits to apply, in order." }),
});

type HashEditParamsType = Static<typeof HashEditParams>;

function normalizeForHash(line: string): string {
	// Mirror can1357's whitespace-normalization: remove all whitespace.
	return line.replace(/\s+/g, "");
}

export function computeLineHash(line: string): string {
	// Deterministic 2-hex-digit tag.
	// Note: collisions are possible; the line number in anchors reduces practical risk.
	const normalized = normalizeForHash(line.endsWith("\r") ? line.slice(0, -1) : line);
	const digest = crypto.createHash("sha1").update(normalized).digest();
	return digest.subarray(0, 1).toString("hex");
}

function parseAnchor(anchor: string): { line: number; hash: string } {
	const m = /^(\d+):([0-9a-fA-F]+)$/.exec(anchor.trim());
	if (!m) throw new Error(`Invalid anchor '${anchor}'. Expected '<line>:<hash>'.`);
	const line = Number(m[1]);
	if (!Number.isInteger(line) || line < 1) throw new Error(`Invalid anchor '${anchor}': line must be >= 1.`);
	return { line, hash: m[2].toLowerCase() };
}

function formatHashLines(content: string, startLine = 1, endLine?: number): string {
	const lines = content.split("\n");
	const startIdx = Math.max(0, startLine - 1);
	const endIdx = endLine === undefined ? lines.length - 1 : Math.min(lines.length - 1, endLine - 1);
	const out: string[] = [];
	for (let i = startIdx; i <= endIdx; i += 1) {
		const lineNum = i + 1;
		const line = lines[i] ?? "";
		out.push(`${lineNum}:${computeLineHash(line)}|${line}`);
	}
	return out.join("\n");
}

function assertAnchorMatches(fileLines: string[], ref: { line: number; hash: string }, which: string) {
	if (ref.line < 1 || ref.line > fileLines.length) {
		throw new Error(
			`${which} anchor line out of range: ${ref.line}. File has ${fileLines.length} line(s). Re-read the file.`,
		);
	}
	const actual = computeLineHash(fileLines[ref.line - 1] ?? "");
	if (actual !== ref.hash) {
		throw new Error(
			`${which} anchor mismatch at line ${ref.line}: expected ${ref.hash}, got ${actual}. Re-read the file and retry.`,
		);
	}
}

function applyEditsToText(original: string, edits: HashlineEdit[]): { updated: string; appliedEdits: number } {
	// Preserve trailing newline if present in original.
	const hasTrailingNewline = original.endsWith("\n");
	let lines = original.split("\n");
	// If text ends with \n, split produces last empty string; keep it as a real line.
	// Hashlines in can's implementation treat that as an empty final line.

	let applied = 0;
	for (const edit of edits) {
		if ("set_line" in edit) {
			const { line, hash } = parseAnchor(edit.set_line.anchor);
			assertAnchorMatches(lines, { line, hash }, "set_line");
			const replacement = edit.set_line.new_text;
			const replacementLines = replacement.split("\n");
			// Replace exactly that one line with replacement (may be multiple lines).
			lines.splice(line - 1, 1, ...replacementLines);
			applied += 1;
			continue;
		}

		if ("replace_lines" in edit) {
			const start = parseAnchor(edit.replace_lines.start_anchor);
			const end = parseAnchor(edit.replace_lines.end_anchor);
			if (end.line < start.line) {
				throw new Error(`replace_lines invalid range: end line ${end.line} < start line ${start.line}.`);
			}
			assertAnchorMatches(lines, start, "replace_lines(start)");
			assertAnchorMatches(lines, end, "replace_lines(end)");
			const replacementLines = edit.replace_lines.new_text.split("\n");
			lines.splice(start.line - 1, end.line - start.line + 1, ...replacementLines);
			applied += 1;
			continue;
		}

		if ("insert_after" in edit) {
			const { line, hash } = parseAnchor(edit.insert_after.anchor);
			assertAnchorMatches(lines, { line, hash }, "insert_after");
			const insertLines = edit.insert_after.text.split("\n");
			lines.splice(line, 0, ...insertLines);
			applied += 1;
			continue;
		}
	}

	let updated = lines.join("\n");
	// Preserve original trailing newline semantics as best-effort.
	if (hasTrailingNewline && !updated.endsWith("\n")) updated += "\n";
	if (!hasTrailingNewline && updated.endsWith("\n")) updated = updated.slice(0, -1);
	return { updated, appliedEdits: applied };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "hash_read",
		label: "Hash Read",
		description: HASHLINE_TOOL_DESCRIPTION,
		parameters: HashReadParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: HashReadParamsType, _signal, _onUpdate, ctx) {
			const fullPath = path.resolve(ctx.cwd, params.path);
			const content = await fs.readFile(fullPath, "utf-8");
			const startLine = params.startLine ?? 1;
			const formatted = formatHashLines(content, startLine, params.endLine);
			return {
				content: [{ type: "text", text: formatted }],
				details: { path: fullPath, startLine, endLine: params.endLine ?? null },
			};
		},
	});

	pi.registerTool({
		name: "hash_edit",
		label: "Hash Edit",
		description: HASHLINE_TOOL_DESCRIPTION,
		parameters: HashEditParams,
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(_toolCallId, params: HashEditParamsType, _signal, _onUpdate, ctx) {
			const fullPath = path.resolve(ctx.cwd, params.path);
			const before = await fs.readFile(fullPath, "utf-8");
			const { updated, appliedEdits } = applyEditsToText(before, params.edits as unknown as HashlineEdit[]);
			const changed = updated !== before;
			let diffText = "";
			if (changed) {
				// Generate unified diff before writing
				const tmpDir = os.tmpdir();
				const tmpBefore = path.join(tmpDir, `hash_edit_before_${Date.now()}`);
				const tmpAfter = path.join(tmpDir, `hash_edit_after_${Date.now()}`);
				try {
					await fs.writeFile(tmpBefore, before, "utf-8");
					await fs.writeFile(tmpAfter, updated, "utf-8");
					diffText = execFileSync(
						"diff",
						["-u", "--label", `a/${params.path}`, "--label", `b/${params.path}`, tmpBefore, tmpAfter],
						{ encoding: "utf-8", timeout: 5000 },
					);
				} catch (e: any) {
					// diff exits 1 when files differ — that's expected
					if (e.stdout) diffText = e.stdout;
				} finally {
					await fs.unlink(tmpBefore).catch(() => {});
					await fs.unlink(tmpAfter).catch(() => {});
				}
				await fs.writeFile(fullPath, updated, "utf-8");
			}
			const summary = `Applied ${appliedEdits} edit(s) to ${params.path}.`;
			return {
				content: [
					{
						type: "text",
						text: diffText ? `${summary}\n\n${diffText}` : summary,
					},
				],
				details: { path: fullPath, appliedEdits, changed },
			};
		},
	});
}
