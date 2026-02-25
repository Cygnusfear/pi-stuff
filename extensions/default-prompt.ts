/**
 * default-prompt.ts
 *
 * Additive prompt layering:
 * 1) Always load bundled global prompt from this package: prompts/default.md
 * 2) If present, also load repo-local overlay: .prompts/default.md
 *
 * Both are appended to the system prompt on every agent turn via
 * before_agent_start.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default function defaultPromptExtension(pi: ExtensionAPI) {
	const cache = new Map<string, { mtime: number; content: string }>();

	const bundledPromptPath = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"prompts",
		"default.md",
	);

	const findRepoRoot = (cwd: string): string => {
		let dir = path.resolve(cwd);
		while (true) {
			if (existsSync(path.join(dir, ".git"))) {
				return dir;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		return path.resolve(cwd);
	};

	const getRepoPromptPath = (cwd: string): string => {
		const repoRoot = findRepoRoot(cwd);
		return path.join(repoRoot, ".prompts", "default.md");
	};

	const stripFrontmatter = (content: string): string => {
		const trimmed = content.trim();
		const match = trimmed.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
		if (!match) return trimmed;
		return trimmed.slice(match[0].length).trim();
	};

	const loadPromptContent = async (promptPath: string): Promise<string | null> => {
		if (!existsSync(promptPath)) return null;

		try {
			const stat = await fs.stat(promptPath);
			const cached = cache.get(promptPath);

			if (!cached || cached.mtime !== stat.mtimeMs) {
				const raw = await fs.readFile(promptPath, "utf8");
				const content = stripFrontmatter(raw);
				cache.set(promptPath, { mtime: stat.mtimeMs, content });
			}

			const loaded = cache.get(promptPath)?.content?.trim() ?? "";
			return loaded.length > 0 ? loaded : null;
		} catch {
			return null;
		}
	};

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const globalPrompt = await loadPromptContent(bundledPromptPath);
		const repoPromptPath = getRepoPromptPath(ctx.cwd);
		const repoPrompt =
			repoPromptPath === bundledPromptPath
				? null
				: await loadPromptContent(repoPromptPath);

		const additions = [globalPrompt, repoPrompt].filter(
			(content): content is string => Boolean(content && content.trim().length > 0),
		);

		if (additions.length === 0) return;

		const baseSystemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";

		return {
			systemPrompt: [baseSystemPrompt, ...additions].filter(Boolean).join("\n\n"),
		};
	});
}
