import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function worktreeBranchName(workerName: string, ticketId: string): string {
	return `teams/${workerName}/${ticketId}`;
}

export async function createWorktree(
	repoDir: string,
	workerName: string,
	ticketId: string,
	worktreePath: string,
): Promise<{ success: boolean; path: string; error?: string }> {
	const branch = worktreeBranchName(workerName, ticketId);
	try {
		await exec("git", ["worktree", "add", worktreePath, "-b", branch, "HEAD"], { cwd: repoDir });
		return { success: true, path: worktreePath };
	} catch (err) {
		return { success: false, path: worktreePath, error: String(err) };
	}
}

export async function removeWorktree(
	repoDir: string,
	worktreePath: string,
	branch: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoDir });
	} catch {
		// worktree may already be gone
	}
	try {
		await exec("git", ["branch", "-D", branch], { cwd: repoDir });
	} catch {
		// branch may already be gone
	}
	return { success: true };
}
