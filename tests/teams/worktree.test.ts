import { describe, test, expect, afterEach } from "bun:test";
import {
	createWorktree,
	removeWorktree,
	worktreeBranchName,
	branchHasNewCommits,
} from "../../extensions/teams/worktree";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
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

	test("keepBranch=true preserves branch after worktree removal", async () => {
		const repo = initRepo();
		const wtPath = path.join(tmpDir, ".pi-teams", "bob");
		await createWorktree(repo, "bob", "p-xyz", wtPath);

		const branch = worktreeBranchName("bob", "p-xyz");
		await removeWorktree(repo, wtPath, branch, true);
		expect(existsSync(wtPath)).toBe(false);

		// Branch should still exist
		const branches = execSync("git branch", { cwd: repo, encoding: "utf-8" });
		expect(branches).toContain("teams/bob/p-xyz");
	});

	test("returns error on invalid repo", async () => {
		const result = await createWorktree("/nonexistent", "bob", "p-xyz", "/tmp/nope");
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});

describe("branchHasNewCommits", () => {
	test("returns false when branch has no new commits", async () => {
		const repo = initRepo();
		const wtPath = path.join(tmpDir, ".pi-teams", "carol");
		await createWorktree(repo, "carol", "p-123", wtPath);

		const branch = worktreeBranchName("carol", "p-123");
		const hasWork = await branchHasNewCommits(repo, branch);
		expect(hasWork).toBe(false);

		await removeWorktree(repo, wtPath, branch);
	});

	test("returns true when branch has commits ahead of HEAD", async () => {
		const repo = initRepo();
		const wtPath = path.join(tmpDir, ".pi-teams", "dave");
		await createWorktree(repo, "dave", "p-456", wtPath);

		// Make a commit in the worktree
		writeFileSync(path.join(wtPath, "work.txt"), "worker output");
		execSync("git add . && git commit -m 'worker did stuff'", { cwd: wtPath, stdio: "pipe" });

		const branch = worktreeBranchName("dave", "p-456");
		const hasWork = await branchHasNewCommits(repo, branch);
		expect(hasWork).toBe(true);

		await removeWorktree(repo, wtPath, branch);
	});

	test("returns false for nonexistent branch", async () => {
		const repo = initRepo();
		const hasWork = await branchHasNewCommits(repo, "nonexistent-branch");
		expect(hasWork).toBe(false);
	});
});
