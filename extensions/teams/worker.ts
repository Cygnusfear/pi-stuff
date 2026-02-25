import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const HEARTBEAT_ENTRY_TYPE = "teams-worker-heartbeat";

function resolveHeartbeatIntervalMs(): number {
	const raw = Number(process.env.PI_TEAMS_WORKER_HEARTBEAT_MS ?? "5000");
	if (!Number.isFinite(raw) || raw < 1000) return 5000;
	return Math.floor(raw);
}

export function runWorker(pi: ExtensionAPI): void {
	const ticketId = process.env.PI_TEAMS_TICKET_ID;
	const workerName = process.env.PI_TEAMS_WORKER_NAME ?? "worker";

	if (!ticketId) {
		console.error("[teams-worker] PI_TEAMS_TICKET_ID not set");
		return;
	}

	const writeHeartbeat = (event: string, details?: Record<string, unknown>) => {
		try {
			pi.appendEntry(HEARTBEAT_ENTRY_TYPE, {
				event,
				ticketId,
				workerName,
				timestamp: Date.now(),
				...(details ?? {}),
			});
		} catch {
			// best effort
		}
	};

	writeHeartbeat("worker_init");
	const heartbeatTimer = setInterval(() => {
		writeHeartbeat("tick");
	}, resolveHeartbeatIntervalMs());

	const stopHeartbeat = () => {
		clearInterval(heartbeatTimer);
	};

	pi.on("session_shutdown", () => {
		stopHeartbeat();
	});

	pi.on("agent_start", () => {
		writeHeartbeat("agent_start");
	});

	pi.on("turn_start", () => {
		writeHeartbeat("turn_start");
	});

	pi.on("tool_call", (event) => {
		writeHeartbeat("tool_call", { toolName: event.toolName });
	});

	pi.on("tool_result", (event) => {
		writeHeartbeat("tool_result", { toolName: event.toolName, isError: event.isError });
	});

	pi.on("turn_end", () => {
		writeHeartbeat("turn_end");
	});

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
		stopHeartbeat();
		writeHeartbeat("agent_end");
		try {
			await pi.exec("tk", ["add-note", ticketId, "DONE: Task completed."], { cwd: ctx.cwd, timeout: 5000 });
			await pi.exec("tk", ["close", ticketId], { cwd: ctx.cwd, timeout: 5000 });
		} catch {
			// best effort
		}
	});
}
