/**
 * Git Safety Extension
 *
 * Wide net: any tool call that touches .git triggers a user confirmation prompt.
 * Interactive sessions get an APPROVE/DENY dialog. Non-interactive (workers) get hard-blocked.
 *
 * Covers: bash, write, edit, apply_patch tools.
 * (code-mode internal functions are guarded separately inside code-mode.ts — those always hard-block.)
 *
 * Also: injects GIT_EDITOR=true for `git rebase --continue` to prevent hanging.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isGitUnsafeBash, isGitPath } from "./lib/git-guards.js";

const REBASE_CONTINUE_RE = /\bgit\s+rebase\s+--continue\b/;
const HAS_GIT_EDITOR_RE = /\bGIT_EDITOR\s*=/;

const GUARD = "🛡️ GIT SAFETY BLOCK";
const GUARD_PROTOCOL = "GUARD PROTOCOL: ASK FOR HOOMAN TO CONFIRM THIS ACTION FIRST WITH [OK]";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// ── bash: inject GIT_EDITOR for rebase --continue ──
		if (event.toolName === "bash") {
			const cmd: string = (event.input as any)?.command ?? "";
			if (REBASE_CONTINUE_RE.test(cmd) && !HAS_GIT_EDITOR_RE.test(cmd)) {
				(event.input as any).command = cmd.replace(
					REBASE_CONTINUE_RE,
					"GIT_EDITOR=true git rebase --continue",
				);
			}
		}

		// ── detect dangerous .git operations ──
		let reason: string | null = null;

		if (event.toolName === "bash") {
			reason = isGitUnsafeBash((event.input as any)?.command ?? "");
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const p: string = (event.input as any)?.path ?? "";
			if (isGitPath(p)) reason = `${event.toolName} to .git path: ${p}`;
		}

		if (event.toolName === "apply_patch") {
			const patch: string = (event.input as any)?.patchText ?? "";
			const fileHeaders = patch.match(/\*\*\*\s+(?:Add|Delete|Update)\s+File:\s*(.+)/g);
			if (fileHeaders) {
				for (const h of fileHeaders) {
					const p = h.replace(/\*\*\*\s+(?:Add|Delete|Update)\s+File:\s*/, "").trim();
					if (isGitPath(p)) {
						reason = `patch targets .git path: ${p}`;
						break;
					}
				}
			}
		}

		if (!reason) return undefined;

		// ── permission gate ──
		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"⚠️ .git operation detected",
				`${reason}\n\nThis can permanently destroy your repository. Allow?`,
			);
			if (ok) return undefined; // user approved
		}

		// No UI (worker) or user denied → hard block
		return {
			block: true,
			reason: `${GUARD}: ${reason}. ${GUARD_PROTOCOL}`,
		};
	});
}
