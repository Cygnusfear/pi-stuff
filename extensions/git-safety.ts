import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const REBASE_CONTINUE_RE = /\bgit\s+rebase\s+--continue\b/;
const HAS_GIT_EDITOR_RE = /\bGIT_EDITOR\s*=/;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const cmd: string = (event.input as any)?.command ?? "";
		if (!REBASE_CONTINUE_RE.test(cmd)) return;
		if (HAS_GIT_EDITOR_RE.test(cmd)) return;

		// Rewrite: prepend GIT_EDITOR=true so the rebase doesn't hang waiting for an editor.
		(event.input as any).command = cmd.replace(
			REBASE_CONTINUE_RE,
			"GIT_EDITOR=true git rebase --continue",
		);
	});
}
