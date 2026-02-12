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
	private pi: ExtensionAPI;
	private ctx: ExtensionContext | null = null;
	private widgetFactory = createTeamsWidget(() => this.getWorkers());

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	setContext(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.renderWidget();
	}

	startPolling() {
		if (this.pollTimer) return;
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
				worker.status = nextWorkerStatus(worker.status, {
					processAlive: alive,
					ticketClosed: ticket.status === "closed" || ticket.status === "done",
				});

				const events = computePollEvents(worker, input);

				for (const event of events) {
					worker.status = event.worker.status;
					worker.lastActivityAt = Date.now();

					if (event.type === "comment") {
						worker.lastSeenCommentCount = ticket.notes.length;
					}

					this.notifyLLM(event);

					if (event.type === "completed" || event.type === "failed") {
						await cleanupWorker(this.ctx.cwd, worker);
						this.workers.delete(name);
						this.childProcesses.delete(name);
						break;
					}
				}
			} catch {
				// Polling error; skip, try next cycle
			}
		}

		// Stop polling if no active workers remain
		const hasActive = [...this.workers.values()].some((w) => !["done", "failed", "killed"].includes(w.status));
		if (!hasActive && this.workers.size === 0) {
			this.stopPolling();
		}
		this.renderWidget();
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

	private notifyLLM(event: PollEvent) {
		const msg = formatPollEvent(event);
		this.pi.sendMessage(
			{
				customType: "team-event",
				content: msg,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	}
}

function formatPollEvent(event: PollEvent): string {
	switch (event.type) {
		case "completed":
			return `✅ Worker "${event.worker.name}" completed ticket #${event.worker.ticketId}:\n${event.result}`;
		case "failed":
			return `❌ Worker "${event.worker.name}" failed on ticket #${event.worker.ticketId}: ${event.reason}`;
		case "stuck":
			return `⚠️ Worker "${event.worker.name}" may be stuck on ticket #${event.worker.ticketId} (${event.idleSeconds}s idle)`;
		case "comment":
			return `💬 Worker "${event.worker.name}" on ticket #${event.worker.ticketId}: ${event.comment}`;
		case "alive":
			return `Worker "${event.worker.name}" is alive, working on ticket #${event.worker.ticketId}`;
	}
}
