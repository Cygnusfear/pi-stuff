import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { WorkerHandle, SpawnConfig, PollEvent } from "./types.js";
import { POLL_INTERVAL_MS } from "./types.js";
import { spawnWorker, isProcessAlive } from "./spawner.js";
import { computePollEvents, type PollInput } from "./polling.js";
import { parseTicketShow } from "./tickets.js";
import { createWorktree } from "./worktree.js";
import { cleanupWorker } from "./cleanup.js";
import { nextWorkerStatus } from "./state.js";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { createTeamsWidget } from "./widget.js";

export class TeamLeader {
	private workers = new Map<string, WorkerHandle>();
	private childProcesses = new Map<string, ChildProcess>();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
	private pi: ExtensionAPI;
	private ctx: ExtensionContext | null = null;
	private widgetFactory = createTeamsWidget(() => this.getWorkers());
	private pollInFlight = false;
	/** Workers whose process just exited — next poll handles them immediately */
	private processExitQueue = new Set<string>();
	/** When false, suppress progress comment events (toggle via /team thinking) */
	showComments = true;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	setContext(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.renderWidget();
	}

	startPolling() {
		if (this.pollTimer) return;
		void this.poll();
		this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
	}

	stopPolling() {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	async delegate(ticketId: string, workerName: string, useWorktree: boolean): Promise<WorkerHandle> {
		if (!this.ctx) throw new Error("Leader context not set");

		// Cancel pending cleanup — new work starting
		if (this.cleanupTimer) {
			clearTimeout(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		const repoDir = this.ctx.cwd;
		let cwd = repoDir;

		if (useWorktree) {
			const wtPath = path.join(repoDir, ".pi-teams", workerName);
			const result = await createWorktree(repoDir, workerName, ticketId, wtPath);
			if (!result.success) throw new Error(`Worktree creation failed: ${result.error}`);
			cwd = wtPath;
		}

		const sessionFile = this.ctx.sessionManager.getSessionFile() ?? "";
		const config: SpawnConfig = {
			ticketId,
			workerName,
			useWorktree,
			cwd,
			leaderSessionFile: sessionFile,
		};

		const { process: child, handle } = spawnWorker(config);
		this.workers.set(workerName, handle);
		this.childProcesses.set(workerName, child);

		// Listen for process exit — this is the real-time signal, not polling.
		child.on("close", (code) => {
			handle.exitCode = code;
			this.processExitQueue.add(workerName);
			// Trigger immediate poll to handle the exit
			void this.poll();
		});

		this.renderWidget();
		return handle;
	}

	async kill(workerName: string): Promise<void> {
		const worker = this.workers.get(workerName);
		if (!worker) return;
		worker.status = "killed";
		if (this.ctx) {
			await cleanupWorker(this.ctx.cwd, worker);
		}
		this.workers.delete(workerName);
		this.childProcesses.delete(workerName);
		this.processExitQueue.delete(workerName);
		this.renderWidget();
	}

	async killAll(): Promise<void> {
		for (const name of [...this.workers.keys()]) {
			await this.kill(name);
		}
		this.renderWidget();
	}

	getWorkers(): WorkerHandle[] {
		return [...this.workers.values()];
	}

	getWorker(name: string): WorkerHandle | undefined {
		return this.workers.get(name);
	}

	private async poll() {
		if (!this.ctx) return;
		if (this.pollInFlight) return;
		this.pollInFlight = true;
		try {

		for (const [name, worker] of this.workers) {
			if (["done", "failed", "killed"].includes(worker.status)) continue;

			try {
				const alive = isProcessAlive(worker.pid);

				const tkResult = await this.pi.exec("tk", ["show", worker.ticketId], {
					cwd: this.ctx.cwd,
					timeout: 5000,
				});
				const ticket = parseTicketShow(tkResult.stdout ?? "");

				let sessionLastActivity = worker.spawnedAt;
				try {
					const sm = SessionManager.open(worker.sessionFile);
					const leaf = sm.getLeafEntry();
					if (leaf?.timestamp) sessionLastActivity = leaf.timestamp;
				} catch {
					// session file may not exist yet
				}

				const input: PollInput = {
					processAlive: alive,
					ticketStatus: ticket.status,
					ticketNotes: ticket.notes,
					lastSeenCommentCount: worker.lastSeenCommentCount,
					sessionLastActivityAt: sessionLastActivity,
				};

				worker.ticketStatus = ticket.status;
				worker.lastNote = ticket.notes.at(-1)?.text;
				const projected = nextWorkerStatus(worker.status, {
					processAlive: alive,
					ticketClosed: ticket.status === "closed" || ticket.status === "done",
				});
				if (worker.status === "spawning" && projected === "running") {
					worker.status = "running";
				}

				// Process exited but ticket still open — worker forgot to close.
				// Close it on their behalf and surface whatever they left behind.
				if (!alive && ticket.status !== "closed" && ticket.status !== "done") {
					const lastNote = ticket.notes.at(-1)?.text;
					const exitCode = worker.exitCode ?? null;

					// Close the ticket so it doesn't dangle
					await this.pi.exec("tk", ["close", worker.ticketId], { cwd: this.ctx.cwd, timeout: 5000 }).catch(() => {});

					const resultText = lastNote ?? "(no notes left by worker)";
					const isSuccess = exitCode === 0;

					worker.status = isSuccess ? "done" : "failed";
					worker.ticketStatus = "closed";
					worker.lastActivityAt = Date.now();

					if (isSuccess) {
						this.notifyLLM({
							type: "completed",
							worker: { ...worker },
							result: resultText,
						});
					} else {
						this.notifyLLM({
							type: "failed",
							worker: { ...worker },
							reason: `process exited (code ${exitCode}), ticket was still open. Last note: ${resultText}`,
						});
					}

					await cleanupWorker(this.ctx.cwd, worker);
					this.childProcesses.delete(name);
					this.processExitQueue.delete(name);
					// Keep worker in map so widget shows final status
					continue;
				}

				const events = computePollEvents(worker, input);

				for (const event of events) {
					worker.status = event.worker.status;
					worker.ticketStatus = ticket.status;
					worker.lastActivityAt = Date.now();

					if (event.type === "comment") {
						worker.lastSeenCommentCount = ticket.notes.length;
					}

					this.notifyLLM(event);

					if (event.type === "completed" || event.type === "failed") {
						await cleanupWorker(this.ctx.cwd, worker);
						this.childProcesses.delete(name);
						this.processExitQueue.delete(name);
						// Keep worker in map so widget shows final status
						break;
					}
				}
			} catch {
				// Polling error; skip, try next cycle
			}
		}

		this.processExitQueue.clear();

		// Stop polling if no active workers remain
		const hasActive = [...this.workers.values()].some((w) => !["done", "failed", "killed"].includes(w.status));
		if (!hasActive) {
			this.stopPolling();
			this.scheduleCleanup();
		}
		this.renderWidget();
		} finally {
			this.pollInFlight = false;
		}
	}

	private scheduleCleanup() {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setTimeout(() => {
			this.cleanupTimer = null;
			// Remove terminal workers from map
			for (const [name, w] of this.workers) {
				if (["done", "failed", "killed"].includes(w.status)) {
					this.workers.delete(name);
				}
			}
			this.renderWidget();
		}, 60_000);
	}

	clearWidget() {
		this.ctx?.ui.setWidget("pi-teams", undefined);
	}

	private renderWidget() {
		if (!this.ctx) return;
		if (this.workers.size === 0) {
			this.ctx.ui.setWidget("pi-teams", undefined);
			return;
		}
		this.ctx.ui.setWidget("pi-teams", this.widgetFactory);
	}

	/** Track which completed/failed events we've already sent to avoid duplicates */
	private notifiedTerminal = new Set<string>();

	private notifyLLM(event: PollEvent) {
		// Dedupe: only send one terminal notification per worker
		if (event.type === "completed" || event.type === "failed") {
			const key = `${event.worker.name}:terminal`;
			if (this.notifiedTerminal.has(key)) return;
			this.notifiedTerminal.add(key);
		}

		// Dedupe: skip DONE-prefixed comment events — that text is already in the completed event
		if (event.type === "comment" && event.comment.startsWith("DONE:")) {
			return;
		}

		// Suppress progress comments when thinking is toggled off
		if (event.type === "comment" && !this.showComments) {
			return;
		}

		const msg = formatPollEvent(event);
		this.pi.sendMessage(
			{
				customType: "team-event",
				content: msg,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);


	}
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ICONS = {
	done: `${GREEN}\uF00C${RESET}`,     // nf-fa-check
	fail: `${RED}\uF00D${RESET}`,       // nf-fa-times
	warn: `${YELLOW}\uF071${RESET}`,    // nf-fa-warning
	comment: `${CYAN}\uF075${RESET}`,   // nf-fa-comment
	alive: `${DIM}\uF111${RESET}`,      // nf-fa-circle
};

function formatPollEvent(event: PollEvent): string {
	switch (event.type) {
		case "completed":
			return `${ICONS.done} Worker "${event.worker.name}" completed ticket #${event.worker.ticketId}:\n${event.result}`;
		case "failed":
			return `${ICONS.fail} Worker "${event.worker.name}" failed on ticket #${event.worker.ticketId}: ${event.reason}`;
		case "stuck":
			return `${ICONS.warn} Worker "${event.worker.name}" may be stuck on ticket #${event.worker.ticketId} (${event.idleSeconds}s idle)`;
		case "comment":
			return `${ICONS.comment} Worker "${event.worker.name}" on ticket #${event.worker.ticketId}: ${event.comment}`;
		case "alive":
			return `${ICONS.alive} Worker "${event.worker.name}" is alive, working on ticket #${event.worker.ticketId}`;
	}
}
