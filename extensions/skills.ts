import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function skillsExtension(pi: ExtensionAPI) {
	pi.registerCommand("skills:install", {
		description: "Install agent skills from a repo (e.g. cygnusfear/agent-skills)",
		handler: async (args, ctx) => {
			const source = args.trim() || "cygnusfear/agent-skills";
			ctx.ui.notify(`Installing skills from ${source}...`, "info");

			const result = await pi.exec("bunx", ["skills", "add", source, "-a", "pi", "-y"], {
				cwd: pi.getCwd(),
				signal: ctx.signal,
			});

			if (result.exitCode === 0) {
				ctx.ui.notify("Skills installed successfully", "info");
			} else {
				ctx.ui.notify(`Failed to install skills: ${result.stderr || result.stdout}`, "error");
			}
		},
	});

	pi.registerCommand("skills:update", {
		description: "Update all installed agent skills to latest versions",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Updating skills...", "info");

			const result = await pi.exec("bunx", ["skills", "update"], {
				cwd: pi.getCwd(),
				signal: ctx.signal,
			});

			if (result.exitCode === 0) {
				ctx.ui.notify("Skills updated successfully", "info");
			} else {
				ctx.ui.notify(`Failed to update skills: ${result.stderr || result.stdout}`, "error");
			}
		},
	});

	pi.registerCommand("skills:list", {
		description: "List installed agent skills",
		handler: async (_args, ctx) => {
			const result = await pi.exec("bunx", ["skills", "list"], {
				cwd: pi.getCwd(),
				signal: ctx.signal,
			});

			if (result.exitCode === 0) {
				ctx.ui.notify(result.stdout || "No skills installed", "info");
			} else {
				ctx.ui.notify(`Failed to list skills: ${result.stderr || result.stdout}`, "error");
			}
		},
	});

	pi.registerCommand("skills:remove", {
		description: "Remove installed agent skills",
		handler: async (args, ctx) => {
			const skillName = args.trim();
			const cmdArgs = skillName
				? ["skills", "remove", skillName, "-y"]
				: ["skills", "remove"];

			const result = await pi.exec("bunx", cmdArgs, {
				cwd: pi.getCwd(),
				signal: ctx.signal,
			});

			if (result.exitCode === 0) {
				ctx.ui.notify("Skills removed", "info");
			} else {
				ctx.ui.notify(`Failed to remove skills: ${result.stderr || result.stdout}`, "error");
			}
		},
	});
}
