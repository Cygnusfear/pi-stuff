import { describe, test, expect, afterEach } from "bun:test";
import { createWorktree, removeWorktree, worktreeBranchName } from "../../extensions/teams/worktree";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

function initRepo(): string {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "teams-wt-"));
	execSync("git init && git commit --allow-empty -m init", { cwd: tmpDir, stdio: "pipe" });
	return tmpDir;
}

afterEach(() => {
	if (tmpDir) {
		try {
			execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
		} catch {}
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

describe("worktreeBranchName", () => {
	test("generates deterministic name", () => {
		expect(worktreeBranchName("alice", "p-abc1")).toBe("teams/alice/p-abc1");
	});
});

describe("createWorktree + removeWorktree", () => {
	test("creates and removes worktree", async () => {
		const repo = initRepo();
		const wtPath = path.join(tmpDir, ".pi-teams", "alice");
		const result = await createWorktree(repo, "alice", "p-abc1", wtPath);
		expect(result.success).toBe(true);
		expect(result.path).toBe(wtPath);
		expect(existsSync(wtPath)).toBe(true);

		const branch = worktreeBranchName("alice", "p-abc1");
		const rmResult = await removeWorktree(repo, wtPath, branch);
		expect(rmResult.success).toBe(true);
		expect(existsSync(wtPath)).toBe(false);
	});

	test("returns error on invalid repo", async () => {
		const result = await createWorktree("/nonexistent", "bob", "p-xyz", "/tmp/nope");
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});
