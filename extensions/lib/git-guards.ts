/**
 * Git guardrails — shared detection functions.
 *
 * Used by git-safety.ts (tool_call interceptor) and code-mode.ts (internal function guards).
 *
 * Philosophy: WIDE NET. Any command that touches .git gets caught.
 * False positives are fine — the human can approve via confirm dialog.
 * A nuked repo is not fine.
 */

// Shell escape patterns that encode "." (0x2e / 056 octal)
const DOT_ESCAPES = /(\$'\\x2e'|\$'\\056'|\$"\\x2e"|\$"\\056"|\\x2e|\\056)/;

/**
 * Check if a bash command could dangerously affect a .git directory.
 * Returns a human-readable reason if dangerous, null if safe.
 */
export function isGitUnsafeBash(cmd: string): string | null {
	// Normalize: collapse whitespace, trim
	const normalized = cmd.replace(/\s+/g, " ").trim();

	// git init as an actual command at segment start
	for (const seg of normalized.split(/\s*(?:&&|\|\||[;|])\s*/)) {
		if (/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?git\s+init\b/.test(seg.trim())) {
			return "git init — can corrupt worktrees by overwriting the .git pointer file";
		}
	}

	// Redirect overwriting .git
	if (/>\s*\S*\.git\b/.test(normalized)) {
		return "shell redirect overwriting .git";
	}

	// Check for .git reference (literal or escaped or globbed)
	const hasLiteralGit = /\.git\b/.test(normalized);
	const hasEscapedGit = DOT_ESCAPES.test(normalized) && /git\b/.test(normalized);
	const hasGlobGit = /\.(g\*|gi\?|gi\*|git\*)/.test(normalized);

	// Variable construction: X=git + rm/rmdir $X
	if (/=git\b/.test(normalized) && /\b(rm|rmdir)\b.*\$/.test(normalized)) {
		return "variable-constructed command targeting git — potential .git destruction";
	}

	// No .git reference at all — safe
	if (!hasLiteralGit && !hasEscapedGit && !hasGlobGit) return null;

	// git clone urls end in .git — that's not a threat
	if (/^\s*git\s+clone\b/.test(normalized)) return null;

	// Any other .git reference = blocked. Human decides.
	return "command references .git";
}

/**
 * Check if a file path is inside or IS a .git directory.
 */
export function isGitPath(filePath: string): boolean {
	const segments = filePath.replace(/\\/g, "/").split("/");
	return segments.some((s) => s === ".git");
}
