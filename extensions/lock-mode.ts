/**
 * Lock Mode — /lock disables all write tools, /unlock restores them.
 *
 * In lock mode agents can only read, search, and think. No writes, no bash,
 * no code execution, no patches. For when you want to let an agent explore
 * without any risk of it changing anything.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const WRITE_TOOLS = new Set([
	"bash",
	"bash_bg_start",
	"write",
	"edit",
	"apply_patch",
	"execute_code",
	"hash_edit",
	"teams",
	"todos_oneshot",
]);

export default function (pi: ExtensionAPI) {
	let savedTools: string[] | null = null;

	pi.registerCommand("lock", {
		description: "Read-only mode — disable all write tools",
		handler: async (_args, ctx) => {
			if (savedTools) {
				ctx.ui.notify("Already locked", "warning");
				return;
			}
			savedTools = pi.getActiveTools();
			const readOnly = savedTools.filter((name) => !WRITE_TOOLS.has(name));
			pi.setActiveTools(readOnly);
			ctx.ui.notify(`🔒 Locked — ${savedTools.length - readOnly.length} write tools disabled`, "info");
		},
	});

	pi.registerCommand("unlock", {
		description: "Restore write tools",
		handler: async (_args, ctx) => {
			if (!savedTools) {
				ctx.ui.notify("Not locked", "warning");
				return;
			}
			pi.setActiveTools(savedTools);
			ctx.ui.notify(`🔓 Unlocked — all tools restored`, "info");
			savedTools = null;
		},
	});
}
