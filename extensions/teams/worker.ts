import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export function runWorker(pi: ExtensionAPI): void {
	const ticketId = process.env.PI_TEAMS_TICKET_ID;
	const workerName = process.env.PI_TEAMS_WORKER_NAME ?? "worker";

	if (!ticketId) {
		console.error("[teams-worker] PI_TEAMS_TICKET_ID not set");
		return;
	}

	const CommentParams = Type.Object({
		message: Type.String({ description: "Your comment" }),
	});

	pi.registerTool({
		name: "team_comment",
		label: "Team Comment",
		description: `Comment on your assigned ticket (${ticketId}). Use this to report progress, ask questions, or flag blockers.`,
		parameters: CommentParams,
		async execute(_id, params: { message: string }, _signal, _onUpdate, ctx) {
			const result = await pi.exec("tk", ["add-note", ticketId, params.message], {
				cwd: ctx.cwd,
				timeout: 5000,
			});
			if (result.code !== 0) {
				return {
					content: [{ type: "text" as const, text: `Failed to comment: ${result.stderr}` }],
					isError: true,
				};
			}
			return { content: [{ type: "text" as const, text: `Commented on ticket #${ticketId}` }] };
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		try {
			await pi.exec("tk", ["add-note", ticketId, "DONE: Task completed."], { cwd: ctx.cwd, timeout: 5000 });
			await pi.exec("tk", ["close", ticketId], { cwd: ctx.cwd, timeout: 5000 });
		} catch {
			// best effort
		}
	});
}
