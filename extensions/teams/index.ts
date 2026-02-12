import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TeamLeader } from "./leader.js";
import { registerTeamsTool } from "./tool.js";
import { runWorker } from "./worker.js";

const IS_WORKER = process.env.PI_TEAMS_WORKER === "1";

export default function (pi: ExtensionAPI) {
	if (IS_WORKER) {
		runWorker(pi);
		return;
	}

	const leader = new TeamLeader(pi);
	registerTeamsTool(pi, leader);

	pi.on("session_start", (_event, ctx) => {
		leader.setContext(ctx);
	});

	pi.on("session_shutdown", async () => {
		leader.stopPolling();
		await leader.killAll();
	});
}
