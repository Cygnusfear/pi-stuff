import type { WorkerHandle } from "./types.js";
import { killWorker, isProcessAlive } from "./spawner.js";
import { removeWorktree, worktreeBranchName } from "./worktree.js";

export async function cleanupWorker(repoDir: string, worker: WorkerHandle): Promise<void> {
	if (isProcessAlive(worker.pid)) {
		killWorker(worker.pid);
	}

	if (worker.worktreePath) {
		const branch = worktreeBranchName(worker.name, worker.ticketId);
		await removeWorktree(repoDir, worker.worktreePath, branch);
	}
}

export async function cleanupAllWorkers(repoDir: string, workers: WorkerHandle[]): Promise<void> {
	await Promise.all(workers.map((w) => cleanupWorker(repoDir, w)));
}
