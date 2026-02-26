/**
 * Git guardrails — shared detection functions.
 *
 * Used by git-safety.ts (tool_call interceptor) and code-mode.ts (internal function guards).
 *
 * Philosophy: WIDE NET. Any command that touches .git in a potentially destructive
 * way gets caught. False positives are fine — the human can approve via confirm dialog.
 * A nuked repo is not fine.
 */

// Safe git subcommands that only READ — never modify .git internals
const SAFE_GIT_SUBCOMMANDS =
	/^\s*git\s+(status|log|show|diff|branch|tag|remote|stash\s+list|rev-parse|describe|shortlog|reflog|config\s+--get|ls-files|ls-tree|cat-file|name-rev|for-each-ref|worktree\s+list|blame)\b/;

// Safe read-only commands that might reference .git paths
const SAFE_READ_COMMANDS =
	/^\s*(ls|cat|file|stat|head|tail|wc|test|find\s.*-print|du|tree|readlink)\b/;

// Destructive commands
const DESTRUCTIVE_COMMANDS =
	/\b(rm|rmdir|mv|cp|dd|truncate|ln|chmod|chown|chgrp|sed|perl|python[23]?|ruby|node|tee|install)\b/;

// Shell escape patterns that encode "." (0x2e / 056 octal)
const DOT_ESCAPES = /(\$'\\x2e'|\$'\\056'|\$"\\x2e"|\$"\\056"|\\x2e|\\056)/;

/**
 * Check if a bash command could dangerously affect a .git directory.
 * Returns a human-readable reason if dangerous, null if safe.
 */
export function isGitUnsafeBash(cmd: string): string | null {
	// Normalize: collapse whitespace, trim
	const normalized = cmd.replace(/\s+/g, " ").trim();

	// git init — always dangerous (can overwrite worktree pointer)
	if (/\bgit\s+init\b/.test(normalized)) {
		return "git init — can corrupt worktrees by overwriting the .git pointer file";
	}

	// Redirect overwriting .git
	if (/>\s*\S*\.git\b/.test(normalized)) {
		return "shell redirect overwriting .git";
	}

	// Check for .git reference (literal or escaped)
	const hasLiteralGit = /\.git\b/.test(normalized);
	const hasEscapedGit = DOT_ESCAPES.test(normalized) && /git\b/.test(normalized);
	const hasGlobGit = /\.(g\*|gi\?|gi\*|git\*)/.test(normalized);

	// Variable construction: D=git + rm/rmdir + $ (no literal .git but still dangerous)
	if (/\bgit\b/.test(normalized) && /\b(rm|rmdir)\b/.test(normalized) && /\$/.test(normalized)) {
		return "variable-constructed command targeting git — potential .git destruction";
	}

	// No .git reference at all — safe
	if (!hasLiteralGit && !hasEscapedGit && !hasGlobGit) return null;

	// Safe git read-only subcommands (git status, git log, etc.)
	if (hasLiteralGit && SAFE_GIT_SUBCOMMANDS.test(normalized)) {
		// But check for pipes to destructive commands
		if (!/\|/.test(normalized)) return null;
	}

	// For multi-command chains (&&, ||, ;, |), check each segment
	const segments = normalized.split(/\s*(?:&&|\|\||[;|])\s*/);
	const dangerousSegments = [];

	for (const seg of segments) {
		const trimmed = seg.trim();
		if (!trimmed) continue;

		const segHasGit = /\.git\b/.test(trimmed) || (DOT_ESCAPES.test(trimmed) && /git\b/.test(trimmed)) || /\.(g\*|gi\?|gi\*|git\*)/.test(trimmed);
		if (!segHasGit) continue;

		// Safe read-only commands
		if (SAFE_READ_COMMANDS.test(trimmed) && !/>/.test(trimmed)) continue;

		// Safe git read subcommands
		if (SAFE_GIT_SUBCOMMANDS.test(trimmed)) continue;

		// Any destructive command + .git reference = blocked
		if (DESTRUCTIVE_COMMANDS.test(trimmed)) {
			dangerousSegments.push(trimmed);
			continue;
		}

		// Catch-all: any non-safe command touching .git
		// This catches things like: D=git; rm -rf .$D (the rm segment won't have .git,
		// but the variable assignment does — handled below)
		dangerousSegments.push(trimmed);
	}

	if (dangerousSegments.length > 0) {
		return `potentially destructive command targeting .git: ${dangerousSegments[0].slice(0, 60)}`;
	}

	return null;
}

/**
 * Check if a file path is inside or IS a .git directory.
 */
export function isGitPath(filePath: string): boolean {
	const segments = filePath.replace(/\\/g, "/").split("/");
	return segments.some((s) => s === ".git");
}
