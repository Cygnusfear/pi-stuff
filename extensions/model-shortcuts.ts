import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findLatest } from "./lib/model-utils.ts";

/**
 * /opus, /sonnet, /haiku, /codex - quick model switching.
 * Resolves latest from registry dynamically. Zero maintenance.
 */

const SHORTCUTS = [
	{ command: "opus", provider: "anthropic", family: /^claude-opus-/, label: "Opus" },
	{ command: "sonnet", provider: "anthropic", family: /^claude-sonnet-/, label: "Sonnet" },
	{ command: "haiku", provider: "anthropic", family: /^claude-haiku-/, label: "Haiku" },
	{ command: "codex", provider: "openai-codex", family: /^gpt-.*-codex$/, label: "Codex" },
] as const;

export default function (pi: ExtensionAPI) {
	for (const shortcut of SHORTCUTS) {
		pi.registerCommand(shortcut.command, {
			description: `Switch to latest ${shortcut.label}`,
			handler: async (_args, ctx) => {
				const model = findLatest(ctx.modelRegistry.getAll(), shortcut.provider, shortcut.family);

				if (!model) {
					ctx.ui.notify(`No ${shortcut.label} model found`, "error");
					return;
				}

				const resolved = ctx.modelRegistry.find(model.provider, model.id);
				if (!resolved) {
					ctx.ui.notify(`Model ${model.id} disappeared from registry`, "error");
					return;
				}

				const ok = await pi.setModel(resolved);
				if (ok) {
					ctx.ui.notify(`Switched to ${model.provider}/${model.id}`, "info");
				} else {
					ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "warning");
				}
			},
		});
	}
}
