import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function worktreeBranchName(workerName: string, ticketId: string): string {
  return `teams/${workerName}/${ticketId}`;
}

export function workerWorktreePath(repoDir: string, workerName: string): string {
  return path.join(repoDir, ".worktrees", "teams", workerName);
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

/**
 * Check if a branch has commits ahead of the current HEAD.
 * Returns true if the branch has work that needs merging.
 */
export async function branchHasNewCommits(repoDir: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["rev-list", "--count", `HEAD..${branch}`], {
      cwd: repoDir,
    });
    return parseInt(stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Commit any uncommitted changes in a worktree so nothing is lost on cleanup.
 * Returns true if a commit was made.
 */
export async function autoCommitWorktreeChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktreePath });
    if (!stdout.trim()) return false;

    await exec("git", ["add", "-A"], { cwd: worktreePath });
    await exec("git", ["commit", "-m", "auto-commit: uncommitted work preserved on worker close"], {
      cwd: worktreePath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Rename a git branch. Used to mark finished worker branches as `.done`.
 */
export async function renameBranch(
  repoDir: string,
  oldName: string,
  newName: string,
): Promise<boolean> {
  try {
    await exec("git", ["branch", "-m", oldName, newName], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  keepBranch = true,
): Promise<{ success: boolean; error?: string }> {
  try {
    await exec("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoDir });
  } catch {
    // worktree may already be gone
  }
  if (!keepBranch) {
    try {
      await exec("git", ["branch", "-D", branch], { cwd: repoDir });
    } catch {
      // branch may already be gone
    }
  }
  return { success: true };
}
