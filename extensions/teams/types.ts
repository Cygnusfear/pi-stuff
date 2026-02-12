export type WorkerStatus = "spawning" | "running" | "done" | "failed" | "killed";

export interface WorkerHandle {
	name: string;
	pid: number;
	ticketId: string;
	sessionFile: string;
	worktreePath: string | null;
	status: WorkerStatus;
	spawnedAt: number;
	lastActivityAt: number;
	lastSeenCommentCount: number;
}

export interface SpawnConfig {
	ticketId: string;
	workerName: string;
	useWorktree: boolean;
	cwd: string;
	leaderSessionFile: string;
}

export type PollEvent =
	| { type: "completed"; worker: WorkerHandle; result: string }
	| { type: "failed"; worker: WorkerHandle; reason: string }
	| { type: "stuck"; worker: WorkerHandle; idleSeconds: number }
	| { type: "comment"; worker: WorkerHandle; comment: string }
	| { type: "alive"; worker: WorkerHandle };

export const POLL_INTERVAL_MS = 3000;
export const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
export const TEAMS_TAG = "team";
export const WORKER_ENV_PREFIX = "PI_TEAMS";
