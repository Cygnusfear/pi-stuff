import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createReadTool } from "@mariozechner/pi-coding-agent";

import { attachTiming, renderToolResult } from "./lib/tool-ui-utils";

export default function (pi: ExtensionAPI) {
	// Override the built-in `read` tool *only for rendering* (UI collapse/expand)
	// and to attach timing metadata. Execution is delegated to the stock tool.
	const base = createReadTool(process.cwd());

	pi.registerTool({
		...base,
		name: "read",
		renderResult(result, options, theme) {
			return renderToolResult(result, !!options.expanded, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = createReadTool(ctx.cwd);
			const startedAt = Date.now();
			const res = await tool.execute(toolCallId, params as any, signal, onUpdate, ctx);
			const endedAt = Date.now();
			return {
				...res,
				details: attachTiming((res as any).details, { startedAt, endedAt, durationMs: endedAt - startedAt }),
			} as any;
		},
	});
}
