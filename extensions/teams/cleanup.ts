import { rm } from "node:fs/promises";
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

	if (process.env.PI_TEAMS_KEEP_WORKER_SESSIONS !== "1") {
		await rm(worker.sessionDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function cleanupAllWorkers(repoDir: string, workers: WorkerHandle[]): Promise<void> {
	await Promise.all(workers.map((w) => cleanupWorker(repoDir, w)));
}
