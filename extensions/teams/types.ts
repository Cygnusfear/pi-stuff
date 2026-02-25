export type WorkerStatus = "spawning" | "running" | "done" | "failed" | "killed";

export interface WorkerHandle {
	name: string;
	pid: number;
	ticketId: string;
	ticketStatus?: string;
	lastNote?: string;
	sessionDir: string;
	sessionFile: string;
	worktreePath: string | null;
	model?: string;
	hasTools?: boolean;
	status: WorkerStatus;
	spawnedAt: number;
	lastActivityAt: number;
	lastProcessActivityAt: number;
	lastOutputAt?: number;
	lastSessionMtimeMs?: number;
	hasActiveChildProcess: boolean;
	activeChildProcessCount: number;
	currentCommand?: string;
	currentCommandElapsedSeconds?: number;
	lastSeenCommentCount: number;
	lastStuckWarningAt?: number;
	exitCode?: number | null;
}

export interface SpawnConfig {
	ticketId: string;
	workerName: string;
	useWorktree: boolean;
	cwd: string;
	leaderSessionFile: string;
	model?: string;
	hasTools?: boolean;
}

export type PollEvent =
	| { type: "completed"; worker: WorkerHandle; result: string }
	| { type: "failed"; worker: WorkerHandle; reason: string }
	| { type: "stuck"; worker: WorkerHandle; idleSeconds: number }
	| { type: "comment"; worker: WorkerHandle; comment: string }
	| { type: "alive"; worker: WorkerHandle };

const pollMs = Number(process.env.PI_TEAMS_POLL_INTERVAL_MS ?? "1000");
export const POLL_INTERVAL_MS = Number.isFinite(pollMs) && pollMs >= 250 ? Math.floor(pollMs) : 1000;

const activityPollMs = Number(process.env.PI_TEAMS_ACTIVITY_POLL_MS ?? "5000");
export const ACTIVITY_POLL_INTERVAL_MS =
	Number.isFinite(activityPollMs) && activityPollMs >= 1000 ? Math.floor(activityPollMs) : 5000;

const stuckThresholdMs = Number(process.env.PI_TEAMS_STUCK_THRESHOLD_MS ?? `${5 * 60 * 1000}`);
export const STUCK_THRESHOLD_MS =
	Number.isFinite(stuckThresholdMs) && stuckThresholdMs >= 30_000
		? Math.floor(stuckThresholdMs)
		: 5 * 60 * 1000;

const stuckWarningCooldownMs = Number(process.env.PI_TEAMS_STUCK_WARNING_COOLDOWN_MS ?? "60000");
export const STUCK_WARNING_COOLDOWN_MS =
	Number.isFinite(stuckWarningCooldownMs) && stuckWarningCooldownMs >= 10_000
		? Math.floor(stuckWarningCooldownMs)
		: 60_000;

export const TEAMS_TAG = "team";
export const WORKER_ENV_PREFIX = "PI_TEAMS";
