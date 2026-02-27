/**
 * Context Awareness Extension
 *
 * Nudges agents when context usage gets high enough that quality degrades.
 * No enforcement — just a gentle reminder so the agent can self-assess.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const NUDGE_THRESHOLD = 0.6; // 60%
let lastNudgePercent = 0;

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage?.percent) return;

		const pct = usage.percent / 100;
		if (pct < NUDGE_THRESHOLD) return;

		// Don't spam — only nudge again if usage jumped 10%+
		if (lastNudgePercent > 0 && pct - lastNudgePercent < 0.1) return;
		lastNudgePercent = pct;

		const rounded = Math.round(usage.percent);
		pi.sendMessage(
			`[context: ${rounded}%] Are you mid-task or at a natural breakpoint? If at a breakpoint, consider summarizing progress and compacting.`,
		);
	});

	// Reset on new session / compaction
	pi.on("session_start", async () => {
		lastNudgePercent = 0;
	});

	pi.on("session_compact", async () => {
		lastNudgePercent = 0;
	});
}
