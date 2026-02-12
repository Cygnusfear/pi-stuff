import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const getWorktreeDir = async (pi: ExtensionAPI, cwd: string): Promise<string> => {
	try {
		const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2000 });
		const out = (r.stdout ?? "").trim();
		if (r.code === 0 && out) return out;
	} catch {
		// ignore
	}
	return cwd;
};

const buildWorktreeLine = (dir: string): string => `Current worktree directory: ${dir}`;

export default function (pi: ExtensionAPI) {
	let lastInjected: string | null = null;

	// Make worktree dir part of the *conversation history* so BOTH auto-compaction and /compact
	// summarization runs see it in the messages being summarized.
	pi.on("before_agent_start", async (_event, ctx) => {
		const worktree = await getWorktreeDir(pi, ctx.cwd);
		if (worktree === lastInjected) return;
		lastInjected = worktree;

		return {
			message: {
				customType: "worktree",
				content: buildWorktreeLine(worktree),
				display: false,
			},
		};
	});

	// Still helpful for manual /compact: append the line to any custom instructions.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };
		const text = event.text ?? "";
		if (!text.startsWith("/compact")) return { action: "continue" };

		const worktree = await getWorktreeDir(pi, ctx.cwd);
		const line = buildWorktreeLine(worktree);

		if (text.includes("Current worktree directory:")) {
			return { action: "continue" };
		}

		const rest = text.slice("/compact".length).trim();
		const next = rest ? `/compact ${rest}\n\n${line}` : `/compact ${line}`;
		return { action: "transform", text: next, images: event.images };
	});

	// /tree branch summary: we CAN override summarization instructions directly.
	pi.on("session_before_tree", async (event, ctx) => {
		const worktree = await getWorktreeDir(pi, ctx.cwd);
		const line = buildWorktreeLine(worktree);

		const existing = event.preparation.customInstructions?.trim();
		const next = existing ? `${existing}\n\n${line}` : line;

		return {
			customInstructions: next,
			replaceInstructions: false,
			label: event.preparation.label,
		};
	});
}
