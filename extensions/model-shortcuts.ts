import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * /opus, /sonnet, /haiku, /codex - quick model switching.
 *
 * Dynamically finds the latest model per family from the registry.
 * No hardcoded candidate lists to maintain.
 */

interface ShortcutDef {
	command: string;
	provider: string;
	family: RegExp;
	label: string;
}

const SHORTCUTS: ShortcutDef[] = [
	{ command: "opus", provider: "anthropic", family: /^claude-opus-/, label: "Opus" },
	{ command: "sonnet", provider: "anthropic", family: /^claude-sonnet-/, label: "Sonnet" },
	{ command: "haiku", provider: "anthropic", family: /^claude-haiku-/, label: "Haiku" },
	{ command: "codex", provider: "openai-codex", family: /^gpt-.*-codex$/, label: "Codex" },
];

function extractVersion(modelId: string): number | null {
	// Skip dated (pinned) models like claude-sonnet-4-20250514
	if (/\d{8}/.test(modelId)) return null;
	// Skip -latest aliases
	if (modelId.endsWith("-latest")) return null;
	// Skip -thinking variants
	if (modelId.endsWith("-thinking")) return null;

	// claude-opus-4-6 → 4.6, gpt-5.3-codex → 5.3
	const match = modelId.match(/(\d+)[-.](\d+)/);
	if (match) return parseFloat(`${match[1]}.${match[2]}`);

	// Single version: claude-haiku-4 → 4
	const single = modelId.match(/-(\d+)(?:-|$)/);
	if (single) return parseInt(single[1]);

	return null;
}

function findLatest(
	registry: { getAll(): any[] },
	provider: string,
	family: RegExp,
): any | null {
	let best: any = null;
	let bestVersion = -1;

	for (const m of registry.getAll()) {
		if (m.provider !== provider) continue;
		if (!family.test(m.id)) continue;

		const v = extractVersion(m.id);
		if (v !== null && v > bestVersion) {
			bestVersion = v;
			best = m;
		}
	}

	return best;
}

export default function (pi: ExtensionAPI) {
	for (const shortcut of SHORTCUTS) {
		pi.registerCommand(shortcut.command, {
			description: `Switch to latest ${shortcut.label}`,
			handler: async (_args, ctx) => {
				const model = findLatest(ctx.modelRegistry, shortcut.provider, shortcut.family);

				if (!model) {
					ctx.ui.notify(`No ${shortcut.label} model found`, "error");
					return;
				}

				const ok = await pi.setModel(model);
				if (ok) {
					ctx.ui.notify(`Switched to ${model.provider}/${model.id}`, "info");
				} else {
					ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "warning");
				}
			},
		});
	}
}
