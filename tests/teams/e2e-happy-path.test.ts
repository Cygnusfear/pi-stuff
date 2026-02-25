import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { createWorktree, removeWorktree, worktreeBranchName } from "../../extensions/teams/worktree";
import { parseTicketShow } from "../../extensions/teams/tickets";
import { buildWorkerPrompt } from "../../extensions/teams/spawner";

let tmpDir: string;

function initTestRepo(): string {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "teams-e2e-"));
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

describe("e2e: ticket lifecycle", () => {
	test("create ticket, add notes, close, parse", () => {
		const repo = initTestRepo();

		// Create ticket
		const id = execSync("tk create 'Implement auth' -d 'Add JWT middleware' --tags team -a alice", {
			cwd: repo,
			encoding: "utf8",
		}).trim();
		expect(id).toBeTruthy();

		// Start it
		execSync(`tk start ${id}`, { cwd: repo, stdio: "pipe" });

		// Add notes (simulating worker communication)
		execSync(`tk add-note ${id} "Started working on JWT middleware"`, { cwd: repo, stdio: "pipe" });
		execSync(`tk add-note ${id} "BLOCKED: need signing key format"`, { cwd: repo, stdio: "pipe" });
		execSync(`tk add-note ${id} "DONE: JWT middleware implemented"`, { cwd: repo, stdio: "pipe" });

		// Close
		execSync(`tk close ${id}`, { cwd: repo, stdio: "pipe" });

		// Parse
		const raw = execSync(`tk show ${id}`, { cwd: repo, encoding: "utf8" });
		const ticket = parseTicketShow(raw);

		expect(ticket.id).toBe(id);
		expect(ticket.status).toBe("closed");
		expect(ticket.assignee).toBe("alice");
		expect(ticket.subject).toBe("Implement auth");
		expect(ticket.notes).toHaveLength(3);
		expect(ticket.notes[0].text).toContain("Started working");
		expect(ticket.notes[1].text).toContain("BLOCKED");
		expect(ticket.notes[2].text).toContain("DONE");
	});

	test("list team tickets", () => {
		const repo = initTestRepo();

		execSync("tk create 'Task A' --tags team", { cwd: repo, stdio: "pipe" });
		execSync("tk create 'Task B' --tags team", { cwd: repo, stdio: "pipe" });
		execSync("tk create 'Task C' --tags other", { cwd: repo, stdio: "pipe" });

		const output = execSync("tk ls --tags team", { cwd: repo, encoding: "utf8" });
		expect(output).toContain("Task A");
		expect(output).toContain("Task B");
	});
});

describe("e2e: worktree lifecycle", () => {
	test("full create → work → cleanup cycle", async () => {
		const repo = initTestRepo();
		const wtPath = path.join(tmpDir, ".worktrees", "teams", "alice");

		// Create
		const result = await createWorktree(repo, "alice", "p-test", wtPath);
		expect(result.success).toBe(true);
		expect(existsSync(wtPath)).toBe(true);

		// Verify it's a real git worktree
		const branch = execSync("git branch --show-current", { cwd: wtPath, encoding: "utf8" }).trim();
		expect(branch).toBe("teams/alice/p-test");

		// Simulate work: create a file in worktree
		execSync("echo 'hello' > hello.txt && git add hello.txt && git commit -m 'add hello'", {
			cwd: wtPath,
			stdio: "pipe",
		});

		// Cleanup
		const branchName = worktreeBranchName("alice", "p-test");
		const rmResult = await removeWorktree(repo, wtPath, branchName);
		expect(rmResult.success).toBe(true);
		expect(existsSync(wtPath)).toBe(false);
	});
});

describe("e2e: worker prompt", () => {
	test("builds coherent prompt with ticket ID", () => {
		const prompt = buildWorkerPrompt("p-abc1", "alice");
		expect(prompt).toContain("alice");
		expect(prompt).toContain("p-abc1");
		expect(prompt).toContain("tk show p-abc1");
		expect(prompt).toContain("tk add-note p-abc1");
		expect(prompt).toContain("tk close p-abc1");
		expect(prompt).toContain("GUARD PROTOCOL: AFTER WORK, UPDATE TICKET AND CLOSE");
	});
});
