import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@mariozechner/pi-coding-agent";

/**
 * Auto-continue watchdog.
 *
 * If the agent goes idle shortly after a tool result (sometimes happens when the
 * model stops right after tool use), we send a small nudge: "Continue.".
 */
export default function (pi: ExtensionAPI) {
	const DELAY_MS = 1200;
	const COOLDOWN_MS = 10_000;

	let timer: NodeJS.Timeout | null = null;
	let lastToolResultAt = 0;
	let lastNudgeAt = 0;
	let lastToolCallId: string | null = null;

	function clearTimer() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function getLastUserText(ctx: ExtensionContext): string {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (!leaf || leaf.type !== "message") return "";
		const msg: any = (leaf as any).message;
		if (!msg || msg.role !== "user") return "";
		// user message content is either string or blocks; handle both
		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c) => c && c.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n");
		}
		return "";
	}

	function shouldNudge(ctx: ExtensionContext, event: ToolResultEvent): boolean {
		if (!ctx.hasUI) return false;
		if (!ctx.isIdle()) return false;
		if (ctx.hasPendingMessages()) return false;
		if (Date.now() - lastToolResultAt < DELAY_MS) return false; // sanity
		if (Date.now() - lastNudgeAt < COOLDOWN_MS) return false;
		// Only one nudge per tool call id
		if (lastToolCallId && event.toolCallId === lastToolCallId && lastNudgeAt > lastToolResultAt) return false;
		// Avoid nudging if the user already typed continue
		const lastUser = getLastUserText(ctx).trim().toLowerCase();
		if (lastUser === "continue" || lastUser === "continue." || lastUser === "please continue" || lastUser === "go on") {
			return false;
		}
		return true;
	}

	async function nudge(ctx: ExtensionContext) {
		lastNudgeAt = Date.now();
		pi.sendUserMessage("Continue.", { deliverAs: "followUp" });
		ctx.ui.setStatus("auto-continue", "nudged: Continue.");
		setTimeout(() => ctx.ui.setStatus("auto-continue", undefined), 2500);
	}

	pi.on("tool_result", (event, ctx) => {
		lastToolResultAt = Date.now();
		lastToolCallId = event.toolCallId;

		clearTimer();
		timer = setTimeout(() => {
			try {
				if (shouldNudge(ctx, event)) {
					void nudge(ctx);
				}
			} catch {
				// ignore
			}
		}, DELAY_MS);
	});

	// If the agent starts streaming again, don't nudge.
	pi.on("agent_start", () => {
		clearTimer();
	});

	// If the agent ended and we *did* get an assistant message after the last tool result,
	// cancel the nudge. Otherwise keep the timer so we can prod the model.
	// Also cancel if the user aborted — never auto-continue after an abort.
	pi.on("agent_end", (event, ctx) => {
		try {
			const msgs = (event as any)?.messages as any[] | undefined;
			if (!Array.isArray(msgs)) return;

			// If the user aborted, never nudge
			const wasAborted = msgs.some((m) => m?.role === "assistant" && (m as any).stopReason === "aborted");
			if (wasAborted) {
				clearTimer();
				return;
			}

			const hasAssistantAfterTool = msgs.some((m) => {
				if (!m || m.role !== "assistant") return false;
				const ts = Number(m.timestamp ?? 0) || 0;
				if (ts && ts < lastToolResultAt) return false;
				const content = m.content;
				if (typeof content === "string") return content.trim().length > 0;
				if (!Array.isArray(content)) return false;
				return content.some((c: any) => {
					if (!c) return false;
					if (c.type === "text" && typeof c.text === "string") return c.text.trim().length > 0;
					// thinking/toolCall also count as "assistant did something"
					if (c.type === "thinking" && typeof c.thinking === "string") return c.thinking.trim().length > 0;
					if (c.type === "toolCall") return true;
					return false;
				});
			});
			if (hasAssistantAfterTool) clearTimer();
		} catch {
			// ignore
		}
	});
}
