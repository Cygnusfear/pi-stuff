import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function cleanOutput(raw: string): string {
	return raw
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		.replace(/\x1b\[\?25[hl]/g, "")
		.replace(/\[999D\[J/g, "")
		.replace(/[█▓░╔╗╚╝║═╠╣╬╦╩├┤┬┴┼┌┐└┘│─╮╯╰╭◇◆●◒◐◓◑]/g, "")
		.replace(/[✓✗]/g, (m) => m === "✓" ? "OK" : "FAIL")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function runSkills(pi: ExtensionAPI, args: string[], cwd: string, signal?: AbortSignal) {
	return pi.exec("bunx", ["--bun", "skills", ...args], { cwd, signal });
}

export default function skillsExtension(pi: ExtensionAPI) {

	// Check for skill + package updates on session start
	pi.on("session_start", async (_event, ctx) => {
		const updates: string[] = [];

		// Check skills
		try {
			const r = await runSkills(pi, ["check"], ctx.cwd);
			if (r.code === 0 && cleanOutput(r.stdout).match(/update|available|new version/i)) {
				updates.push("skills");
			}
		} catch {}

		// Check this package (compare local HEAD to remote)
		try {
			const pkgDir = new URL(".", import.meta.url).pathname.replace(/\/extensions\/$/, "");
			await pi.exec("git", ["fetch", "--quiet"], { cwd: pkgDir });
			const r = await pi.exec("git", ["rev-list", "HEAD..@{u}", "--count"], { cwd: pkgDir });
			if (r.code === 0 && parseInt(r.stdout.trim(), 10) > 0) {
				updates.push("package");
			}
		} catch {}

		if (updates.length > 0) {
			ctx.ui.setStatus("skills", `⬆ ${updates.join(" + ")} updates available`);
		}
	});

	pi.registerCommand("skills:install", {
		description: "Install skills: /skills:install [source] [--skill name] [--global]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const source = parts[0] || "cygnusfear/agent-skills";
			const extra = parts.slice(1);

			ctx.ui.notify(`Installing skills from ${source}...`, "info");

			const r = await runSkills(pi, ["add", source, "-a", "pi", "-y", ...extra], ctx.cwd, ctx.signal);

			if (r.code !== 0) {
				ctx.ui.notify(`Install failed (exit ${r.code}): ${r.stderr}`, "error");
			} else {
				ctx.ui.setStatus("skills", undefined);
				ctx.ui.notify(cleanOutput(r.stdout) || "Skills installed", "info");
			}
		},
	});

	pi.registerCommand("skills:check", {
		description: "Check for available skill updates",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Checking for skill updates...", "info");

			const r = await runSkills(pi, ["check"], ctx.cwd, ctx.signal);

			if (r.code !== 0) {
				ctx.ui.notify(`Check failed (exit ${r.code}): ${r.stderr}`, "error");
			} else {
				const out = cleanOutput(r.stdout);
				if (out.match(/update|available|new version/i)) {
					ctx.ui.setStatus("skills", "⬆ updates available");
				} else {
					ctx.ui.setStatus("skills", undefined);
				}
				ctx.ui.notify(out || "All skills up to date", "info");
			}
		},
	});

	pi.registerCommand("skills:update", {
		description: "Update all installed skills to latest versions",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Updating skills...", "info");

			const r = await runSkills(pi, ["update"], ctx.cwd, ctx.signal);

			if (r.code !== 0) {
				ctx.ui.notify(`Update failed (exit ${r.code}): ${r.stderr}`, "error");
			} else {
				ctx.ui.setStatus("skills", undefined);
				ctx.ui.notify(cleanOutput(r.stdout) || "Skills updated", "info");
			}
		},
	});

	pi.registerCommand("skills:list", {
		description: "List installed skills: /skills:list [--global]",
		handler: async (args, ctx) => {
			const extra = args.trim().split(/\s+/).filter(Boolean);

			const r = await runSkills(pi, ["list", "-a", "pi", ...extra], ctx.cwd, ctx.signal);

			if (r.code !== 0) {
				ctx.ui.notify(`List failed (exit ${r.code}): ${r.stderr}`, "error");
			} else {
				ctx.ui.notify(cleanOutput(r.stdout) || "No skills installed", "info");
			}
		},
	});

	pi.registerCommand("skills:remove", {
		description: "Remove skills: /skills:remove <name...> or /skills:remove --all",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0) {
				ctx.ui.notify("Usage: /skills:remove <name> or /skills:remove --all", "warning");
				return;
			}

			const r = await runSkills(pi, ["remove", ...parts, "-a", "pi", "-y"], ctx.cwd, ctx.signal);

			if (r.code !== 0) {
				ctx.ui.notify(`Remove failed (exit ${r.code}): ${r.stderr}`, "error");
			} else {
				ctx.ui.notify(cleanOutput(r.stdout) || "Skills removed", "info");
			}
		},
	});
}
