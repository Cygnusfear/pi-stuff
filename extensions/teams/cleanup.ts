import { rm } from "node:fs/promises";
import type { WorkerHandle } from "./types.js";
import { killWorker, isProcessAlive } from "./spawner.js";
import { branchHasNewCommits, removeWorktree, worktreeBranchName } from "./worktree.js";

export interface CleanupResult {
	/** True if the branch was kept alive because it has unmerged commits */
	branchPreserved: boolean;
}

/**
 * Clean up a worker: kill process, remove worktree directory.
 *
 * @param preserveBranch - If true, check for unmerged commits and keep the branch alive.
 *                         The coordinator is responsible for merging. Set to true for
 *                         successful workers so their work isn't lost.
 */
export async function cleanupWorker(
	repoDir: string,
	worker: WorkerHandle,
	preserveBranch = false,
): Promise<CleanupResult> {
	if (isProcessAlive(worker.pid)) {
		killWorker(worker.pid);
	}

	let branchPreserved = false;

	if (worker.worktreePath) {
		const branch = worktreeBranchName(worker.name, worker.ticketId);

		if (preserveBranch) {
			const hasWork = await branchHasNewCommits(repoDir, branch);
			branchPreserved = hasWork;
			await removeWorktree(repoDir, worker.worktreePath, branch, hasWork);
		} else {
			await removeWorktree(repoDir, worker.worktreePath, branch);
		}
	}

	if (process.env.PI_TEAMS_KEEP_WORKER_SESSIONS !== "1") {
		await rm(worker.sessionDir, { recursive: true, force: true }).catch(() => undefined);
	}

	return { branchPreserved };
}

export async function cleanupAllWorkers(
	repoDir: string,
	workers: WorkerHandle[],
	preserveBranches = false,
): Promise<CleanupResult[]> {
	return Promise.all(workers.map((w) => cleanupWorker(repoDir, w, preserveBranches)));
}
