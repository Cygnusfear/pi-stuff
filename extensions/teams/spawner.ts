import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { SpawnConfig, WorkerHandle } from "./types.js";

export function buildWorkerPrompt(ticketId: string, workerName: string): string {
	return [
		`You are worker "${workerName}". You have been assigned ticket ${ticketId}.`,
		"",
		"Instructions:",
		`1. Read your ticket: tk show ${ticketId}`,
		"2. Do the work described in the ticket.",
		`3. Comment on the ticket as you work: tk add-note ${ticketId} "your progress"`,
		`4. When done, close the ticket with a result summary: tk add-note ${ticketId} "DONE: <summary>" && tk close ${ticketId}`,
		`5. If you are blocked, comment: tk add-note ${ticketId} "BLOCKED: <reason>"`,
		"",
		"Stay focused on the ticket. Do not ask for confirmation — just do the work.",
	].join("\n");
}

export function spawnWorker(config: SpawnConfig): { process: ChildProcess; handle: WorkerHandle } {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PI_TEAMS_WORKER: "1",
		PI_TEAMS_TICKET_ID: config.ticketId,
		PI_TEAMS_LEADER_SESSION: config.leaderSessionFile,
		PI_TEAMS_WORKER_NAME: config.workerName,
	};

	const keepSessions = process.env.PI_TEAMS_KEEP_WORKER_SESSIONS === "1";
	const baseSessionDir = keepSessions
		? path.join(config.cwd, ".pi", "sessions", "teams-workers")
		: path.join(os.tmpdir(), "pi-teams-sessions");
	const sessionDir = path.join(baseSessionDir, `team-${config.workerName}-${config.ticketId}-${Date.now()}`);

	const child = spawn("pi", ["--non-interactive", "--session-dir", sessionDir, "-p", buildWorkerPrompt(config.ticketId, config.workerName)], {
		cwd: config.cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});

	const sessionFile = path.join(sessionDir, "session.jsonl");

	const handle: WorkerHandle = {
		name: config.workerName,
		pid: child.pid!,
		ticketId: config.ticketId,
		ticketStatus: "open",
		lastNote: undefined,
		sessionDir,
		sessionFile,
		worktreePath: config.useWorktree ? config.cwd : null,
		status: "spawning",
		spawnedAt: Date.now(),
		lastActivityAt: Date.now(),
		lastSeenCommentCount: 0,
	};

	return { process: child, handle };
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function killWorker(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// already dead
	}
	setTimeout(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already dead
		}
	}, 5000);
}
