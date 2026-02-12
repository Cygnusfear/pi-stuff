import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { TeamLeader } from "./leader.js";

const TeamsParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("delegate"), Type.Literal("list"), Type.Literal("kill"), Type.Literal("kill_all")]),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ description: "Task description" }),
				assignee: Type.Optional(Type.String({ description: "Worker name" })),
			}),
		),
	),
	name: Type.Optional(Type.String({ description: "Worker name for kill action" })),
	useWorktree: Type.Optional(Type.Boolean({ description: "Give each worker its own git worktree", default: true })),
});

export function registerTeamsTool(pi: ExtensionAPI, leader: TeamLeader) {
	pi.registerTool({
		name: "teams",
		label: "Teams",
		description: `Coordinate a team of worker agents.

Actions:
- delegate: Create tickets and spawn workers. Provide "tasks" array with { text, assignee? }.
- list: Show all active workers and their status.
- kill: Kill a specific worker by name.
- kill_all: Kill all workers.`,
		parameters: TeamsParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			leader.setContext(ctx);
			const action = params.action ?? "delegate";

			if (action === "list") {
				const workers = leader.getWorkers();
				if (workers.length === 0) {
					return { content: [{ type: "text" as const, text: "No active workers." }] };
				}
				const lines = workers.map((w) => `${w.name}: ${w.status} | ticket #${w.ticketId} | pid ${w.pid}`);
				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			}

			if (action === "kill") {
				if (!params.name)
					return { content: [{ type: "text" as const, text: "Provide worker name." }], isError: true };
				await leader.kill(params.name);
				return { content: [{ type: "text" as const, text: `Killed worker "${params.name}"` }] };
			}

			if (action === "kill_all") {
				await leader.killAll();
				return { content: [{ type: "text" as const, text: "All workers killed." }] };
			}

			if (action === "delegate") {
				if (!params.tasks?.length) {
					return { content: [{ type: "text" as const, text: "Provide tasks array." }], isError: true };
				}

				const useWorktree = params.useWorktree ?? true;
				const results: string[] = [];
				let workerIdx = 0;

				for (const task of params.tasks) {
					const workerName = task.assignee ?? `worker-${++workerIdx}`;

					const createResult = await pi.exec(
						"tk",
						["create", task.text, "-d", task.text, "--tags", "team", "-a", workerName],
						{ cwd: ctx.cwd, timeout: 5000 },
					);

					const ticketId = (createResult.stdout ?? "").trim();
					if (!ticketId || createResult.code !== 0) {
						results.push(`Failed to create ticket for "${task.text}": ${createResult.stderr}`);
						continue;
					}

					await pi.exec("tk", ["start", ticketId], { cwd: ctx.cwd, timeout: 5000 });

					try {
						const handle = await leader.delegate(ticketId, workerName, useWorktree);
						results.push(`Spawned "${workerName}" → ticket #${ticketId} (pid ${handle.pid})`);
					} catch (err) {
						results.push(`Failed to spawn "${workerName}": ${err}`);
					}
				}

				leader.startPolling();
				return { content: [{ type: "text" as const, text: results.join("\n") }] };
			}

			return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
		},
	});
}
