/**
 * Model Hints Extension
 *
 * Injects "latest available models" into the system prompt so agents
 * don't pick stale pinned model IDs like claude-sonnet-4-20250514
 * when claude-sonnet-4-6 exists.
 *
 * Groups available models by provider+family, picks the highest version
 * (non-dated alias), and tells the agent which ones are latest.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Model families we care about — maps regex to family name
const FAMILY_PATTERNS: [RegExp, string][] = [
	[/^claude-opus-/, "claude-opus"],
	[/^claude-sonnet-/, "claude-sonnet"],
	[/^claude-haiku-/, "claude-haiku"],
	[/^gpt-5/, "gpt-5"],
	[/^gpt-4/, "gpt-4"],
	[/^o[1-9]/, "o-series"],
	[/^gemini-2/, "gemini-2"],
	[/^gemini-1/, "gemini-1"],
];

function getFamily(modelId: string): string | null {
	for (const [re, family] of FAMILY_PATTERNS) {
		if (re.test(modelId)) return family;
	}
	return null;
}

// Extract version number from non-dated model IDs like claude-sonnet-4-6 → 4.6
function extractVersion(modelId: string): number | null {
	// Skip dated models (contain 8-digit date like 20250514)
	if (/\d{8}/.test(modelId)) return null;
	// Skip -latest aliases
	if (modelId.endsWith("-latest")) return null;
	// Skip -thinking variants
	if (modelId.endsWith("-thinking")) return null;

	// Extract version digits: claude-opus-4-6 → [4, 6], gpt-5.3-codex → [5, 3]
	const match = modelId.match(/(\d+)[-.](\d+)/);
	if (match) return parseFloat(`${match[1]}.${match[2]}`);

	// Single version: claude-opus-4 → 4
	const single = modelId.match(/(\d+)$/);
	if (single) return parseInt(single[1]);

	return null;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) return;

		// Group by provider + family, find highest version alias
		const latest = new Map<string, { provider: string; id: string; name: string; version: number }>();

		for (const m of models) {
			const family = getFamily(m.id);
			if (!family) continue;

			const version = extractVersion(m.id);
			if (version === null) continue;

			const key = `${m.provider}/${family}`;
			const current = latest.get(key);
			if (!current || version > current.version) {
				latest.set(key, { provider: m.provider, id: m.id, name: m.name, version });
			}
		}

		if (latest.size === 0) return;

		const lines = Array.from(latest.values())
			.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))
			.map((m) => `- ${m.provider}/${m.id} (${m.name})`);

		const hint = [
			"",
			"## Latest available models",
			"When delegating to workers or switching models, prefer these (newest per family):",
			...lines,
		].join("\n");

		return { systemPrompt: event.systemPrompt + hint };
	});
}
