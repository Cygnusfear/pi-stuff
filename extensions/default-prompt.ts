/**
 * default-prompt.ts
 *
 * Loads prompts/default.md from the project root and appends it
 * to the system prompt on every agent turn via before_agent_start.
 *
 * This gives a single, editable file for extra system prompt content
 * that is always active — no slash-command invocation needed.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

export default function defaultPromptExtension(pi: ExtensionAPI) {
	let cachedContent: string | null = null;
	let cachedMtime: number = 0;

	const getPromptPath = (cwd: string): string => {
		// Walk up to find the project root (where package.json with pi config lives)
		let dir = path.resolve(cwd);
		while (true) {
			const pkgPath = path.join(dir, "package.json");
			if (existsSync(pkgPath)) {
				try {
					const pkg = JSON.parse(require("node:fs").readFileSync(pkgPath, "utf8"));
					if (pkg.pi?.prompts) {
						return path.join(dir, "prompts", "default.md");
					}
				} catch {
					// ignore parse errors
				}
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		// Fallback: relative to cwd
		return path.join(cwd, "prompts", "default.md");
	};

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const promptPath = getPromptPath(ctx.cwd);

		if (!existsSync(promptPath)) return;

		try {
			const stat = await fs.stat(promptPath);
			const mtime = stat.mtimeMs;

			// Re-read only if file changed
			if (cachedContent === null || mtime !== cachedMtime) {
				cachedContent = await fs.readFile(promptPath, "utf8");
				cachedMtime = mtime;
			}

			if (!cachedContent || cachedContent.trim().length === 0) return;

			// Strip YAML frontmatter if present (prompt template metadata)
			let content = cachedContent;
			if (content.startsWith("---")) {
				const endIdx = content.indexOf("---", 3);
				if (endIdx !== -1) {
					content = content.slice(endIdx + 3).trim();
				}
			}

			if (!content) return;

			return {
				systemPrompt: event.systemPrompt + "\n\n" + content,
			};
		} catch {
			// File read failed — silently skip
			return;
		}
	});
}
