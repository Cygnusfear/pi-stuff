import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { findLatestPerFamily } from "./lib/model-utils.ts";

/**
 * Injects "latest available models" into the system prompt so agents
 * don't pick stale pinned model IDs.
 */

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const models = ctx.modelRegistry.getAvailable();
		if (models.length === 0) return;

		const latest = findLatestPerFamily(models);
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
