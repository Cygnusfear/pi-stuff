import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TeamLeader } from "./leader.js";
import { registerTeamsTool, runTeamsAction } from "./tool.js";
import { runWorker } from "./worker.js";

const IS_WORKER = process.env.PI_TEAMS_WORKER === "1";

export default function (pi: ExtensionAPI) {
	if (IS_WORKER) {
		runWorker(pi);
		return;
	}

	const leader = new TeamLeader(pi);
	registerTeamsTool(pi, leader);

	pi.registerCommand("team", {
		description: "Team control: /team list | /team kill <name> | /team kill_all | /team delegate <worker[@model]>:<task> | /team thinking",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			const show = (text: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(text, type);
			if (!input || input === "help") {
				show("/team list | /team kill <name> | /team kill_all | /team delegate <worker[@model]>:<task> | /team thinking");
				return;
			}

			if (input === "list") {
				const res = await runTeamsAction(pi, leader, { action: "list" }, ctx);
				show(res.content[0]?.text ?? "");
				return;
			}

			if (input.startsWith("kill ")) {
				const name = input.slice(5).trim();
				const res = await runTeamsAction(pi, leader, { action: "kill", name }, ctx);
				show(res.content[0]?.text ?? "", res.isError ? "error" : "info");
				return;
			}

			if (input === "kill_all") {
				const res = await runTeamsAction(pi, leader, { action: "kill_all" }, ctx);
				show(res.content[0]?.text ?? "", res.isError ? "error" : "info");
				return;
			}

			if (input === "thinking") {
				leader.showComments = !leader.showComments;
				show(`Worker notes ${leader.showComments ? "visible" : "hidden"}`);
				return;
			}

			if (input.startsWith("delegate ")) {
				const raw = input.slice(9).trim();
				const sep = raw.indexOf(":");
				if (sep <= 0) {
					show("Usage: /team delegate <worker[@model]>:<task>", "warning");
					return;
				}
				const workerPart = raw.slice(0, sep).trim();
				const text = raw.slice(sep + 1).trim();
				if (!workerPart || !text) {
					show("Usage: /team delegate <worker[@model]>:<task>", "warning");
					return;
				}
				// Parse worker@model syntax
				const atIdx = workerPart.indexOf("@");
				const assignee = atIdx > 0 ? workerPart.slice(0, atIdx) : workerPart;
				const model = atIdx > 0 ? workerPart.slice(atIdx + 1) : undefined;
				const res = await runTeamsAction(
					pi,
					leader,
					{ action: "delegate", tasks: [{ text, assignee, model }], useWorktree: true },
					ctx,
				);
				show(res.content[0]?.text ?? "", res.isError ? "error" : "info");
				return;
			}

			show("Unknown subcommand. Use /team help", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		leader.setContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		leader.stopPolling();
		await leader.killAll();
	});
}
