/**
 * Live eval: spawns a real pi agent with openai-codex/gpt-5.3-codex,
 * gives it a simple task, and verifies the full worker lifecycle:
 *
 *   spawn → agent does work → commits → cleanup auto-commits dirty files
 *   → worktree removed → branch renamed to .done
 *
 * Gate: only runs when PI_EVAL=1 is set (skipped otherwise).
 * Timeout: 90s per test — codex finishes simple file tasks in <15s
 * but we leave headroom for cold-start and network.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
	createWorktree,
	worktreeBranchName,
	workerWorktreePath,
	branchHasNewCommits,
} from "../../extensions/teams/worktree";
import { cleanupWorker } from "../../extensions/teams/cleanup";
import type { WorkerHandle } from "../../extensions/teams/types";

const EVAL_ENABLED = process.env.PI_EVAL === "1";
const MODEL = process.env.PI_EVAL_MODEL ?? "openai-codex/gpt-5.3-codex";
const TIMEOUT_MS = 90_000;

const describeEval = EVAL_ENABLED ? describe : describe.skip;

let tmpDir: string;

function initRepo(): string {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "teams-eval-"));
	execSync("git init && git commit --allow-empty -m 'init'", { cwd: tmpDir, stdio: "pipe" });
	return tmpDir;
}

function spawnPiDirect(
	cwd: string,
	prompt: string,
): { child: ReturnType<typeof spawn>; sessionDir: string } {
	const sessionDir = path.join(os.tmpdir(), `pi-eval-session-${Date.now()}`);

	const child = spawn(
		"pi",
		["--non-interactive", "--session-dir", sessionDir, "--model", MODEL, "-p", prompt],
		{ cwd, env: process.env as Record<string, string>, stdio: "ignore" },
	);

	return { child, sessionDir };
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Worker timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

afterEach(() => {
	if (tmpDir) {
		try {
			execSync("git worktree prune", { cwd: tmpDir, stdio: "pipe" });
		} catch {}
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

function makeHandle(
	name: string,
	pid: number,
	ticketId: string,
	sessionDir: string,
	wtPath: string,
): WorkerHandle {
	return {
		name,
		pid,
		ticketId,
		sessionDir,
		sessionFile: path.join(sessionDir, "session.jsonl"),
		worktreePath: wtPath,
		model: MODEL,
		status: "done",
		spawnedAt: Date.now() - 60_000,
		lastActivityAt: Date.now(),
		lastProcessActivityAt: Date.now(),
		hasActiveChildProcess: false,
		activeChildProcessCount: 0,
		lastSeenCommentCount: 0,
	};
}

describeEval("eval: worker lifecycle with real agent", () => {
	test(
		"agent does work, commits, cleanup produces .done branch with auto-committed leftovers",
		async () => {
			const repo = initRepo();
			const workerName = "eval-worker";
			const ticketId = "eval-0001";

			const wtPath = workerWorktreePath(repo, workerName);
			const wtResult = await createWorktree(repo, workerName, ticketId, wtPath);
			expect(wtResult.success).toBe(true);

			// Give the agent a dead-simple task: create a file and commit
			const { child, sessionDir } = spawnPiDirect(
				wtPath,
				"Create a file called hello.txt containing 'Hello from eval test'. " +
					"Then git add and git commit it with message 'add hello'. Then stop.",
			);

			console.log(`[eval] pid=${child.pid} model=${MODEL} wt=${wtPath}`);

			const exitCode = await waitForExit(child, TIMEOUT_MS);
			console.log(`[eval] exit=${exitCode}`);

			const branch = worktreeBranchName(workerName, ticketId);
			const hasCommits = await branchHasNewCommits(repo, branch);
			console.log(`[eval] branch "${branch}" hasCommits=${hasCommits}`);
			expect(hasCommits).toBe(true);

			// Drop a dirty file AFTER the agent exits — simulates leftover uncommitted work
			writeFileSync(path.join(wtPath, "dirty-leftover.txt"), "uncommitted");

			// Run cleanup: auto-commit dirty file → remove worktree → rename branch to .done
			const handle = makeHandle(workerName, child.pid!, ticketId, sessionDir, wtPath);
			const result = await cleanupWorker(repo, handle, true);
			console.log(`[eval] branchPreserved=${result.branchPreserved}`);

			expect(existsSync(wtPath)).toBe(false);
			expect(result.branchPreserved).toBe(true);

			const doneBranch = `${branch}.done`;
			const branches = execSync("git branch", { cwd: repo, encoding: "utf-8" });
			console.log(`[eval] branches:\n${branches}`);

			// .done branch exists
			expect(branches).toContain(doneBranch);
			// original name is gone
			const originalPattern = new RegExp(
				branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?!\\.done)\\b",
			);
			expect(branches).not.toMatch(originalPattern);

			// .done branch contains both the agent's file AND the auto-committed leftover
			const files = execSync(`git ls-tree --name-only ${doneBranch}`, {
				cwd: repo,
				encoding: "utf-8",
			});
			console.log(`[eval] files in ${doneBranch}: ${files.trim()}`);
			expect(files).toContain("hello.txt");
			expect(files).toContain("dirty-leftover.txt");

			// Verify hello.txt content
			const content = execSync(`git show ${doneBranch}:hello.txt`, {
				cwd: repo,
				encoding: "utf-8",
			});
			expect(content.toLowerCase()).toContain("hello from eval test");

			console.log("[eval] PASS");
		},
		TIMEOUT_MS + 10_000,
	);

	test(
		"cleanup auto-commits and renames even when agent leaves only dirty files (no commits)",
		async () => {
			const repo = initRepo();
			const workerName = "eval-dirty";
			const ticketId = "eval-0002";

			const wtPath = workerWorktreePath(repo, workerName);
			await createWorktree(repo, workerName, ticketId, wtPath);

			// Tell the agent to write a file but NOT commit
			const { child, sessionDir } = spawnPiDirect(
				wtPath,
				"Write a file called output.txt containing 'task complete'. " +
					"Do NOT run git add or git commit. Just write the file and stop.",
			);

			console.log(`[eval-dirty] pid=${child.pid}`);

			const exitCode = await waitForExit(child, TIMEOUT_MS);
			console.log(`[eval-dirty] exit=${exitCode}`);

			const branch = worktreeBranchName(workerName, ticketId);

			// The agent should NOT have committed (we told it not to)
			// but even if it did, the cleanup flow should still work.
			// Add another dirty file to ensure auto-commit kicks in
			writeFileSync(path.join(wtPath, "extra.txt"), "leftover");

			const handle = makeHandle(workerName, child.pid!, ticketId, sessionDir, wtPath);
			const result = await cleanupWorker(repo, handle, true);
			console.log(`[eval-dirty] branchPreserved=${result.branchPreserved}`);

			expect(result.branchPreserved).toBe(true);

			const doneBranch = `${branch}.done`;
			const branches = execSync("git branch", { cwd: repo, encoding: "utf-8" });
			expect(branches).toContain(doneBranch);

			const files = execSync(`git ls-tree --name-only ${doneBranch}`, {
				cwd: repo,
				encoding: "utf-8",
			});
			console.log(`[eval-dirty] files in ${doneBranch}: ${files.trim()}`);
			expect(files).toContain("extra.txt");
			expect(files).toContain("output.txt");

			console.log("[eval-dirty] PASS");
		},
		TIMEOUT_MS + 10_000,
	);
});
