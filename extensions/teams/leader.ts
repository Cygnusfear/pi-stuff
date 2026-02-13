import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { WorkerHandle, SpawnConfig, PollEvent } from "./types.js";
import { STUCK_THRESHOLD_MS } from "./types.js";
import { spawnWorker } from "./spawner.js";
import { parseTicketShow, getNewNotes } from "./tickets.js";
import { createWorktree } from "./worktree.js";
import { cleanupWorker } from "./cleanup.js";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createTeamsWidget } from "./widget.js";

export class TeamLeader {
	private workers = new Map<string, WorkerHandle>();
	private childProcesses = new Map<string, ChildProcess>();
	private fileWatchers = new Map<string, fs.FSWatcher>();
	private stuckTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
	private pi: ExtensionAPI;
	private ctx: ExtensionContext | null = null;
	private widgetFactory = createTeamsWidget(() => this.getWorkers());
	private notifiedTerminal = new Set<string>();
	showComments = true;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	setContext(ctx: ExtensionContext) {
		this.ctx = ctx;
		this.renderWidget();
	}

	// Keep these as no-ops for backward compat with tool.ts
	startPolling() {}
	stopPolling() {}

	async delegate(ticketId: string, workerName: string, useWorktree: boolean): Promise<WorkerHandle> {
		if (!this.ctx) throw new Error("Leader context not set");

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

		// Process exit — the definitive completion signal
		child.on("close", (code) => {
			handle.exitCode = code;
			void this.handleWorkerExit(workerName, handle, code);
		});

		// Watch ticket file for progress notes
		this.watchTicketFile(workerName, handle);

		// Stuck detection
		this.resetStuckTimer(workerName, handle);

		this.renderWidget();
		return handle;
	}

	private watchTicketFile(name: string, worker: WorkerHandle) {
		if (!this.ctx) return;
		const ticketPath = path.join(this.ctx.cwd, ".tickets", `${worker.ticketId}.md`);

		try {
			const watcher = fs.watch(ticketPath, () => {
				void this.handleTicketChange(name, worker);
			});
			this.fileWatchers.set(name, watcher);
		} catch {
			// File may not exist yet — that's fine, process exit will catch completion
		}
	}

	private async handleTicketChange(name: string, worker: WorkerHandle) {
		if (!this.ctx) return;
		if (["done", "failed", "killed"].includes(worker.status)) return;

		try {
			const tkResult = await this.pi.exec("tk", ["show", worker.ticketId], {
				cwd: this.ctx.cwd,
				timeout: 5000,
			});
			const ticket = parseTicketShow(tkResult.stdout ?? "");

			worker.ticketStatus = ticket.status;
			worker.lastNote = ticket.notes.at(-1)?.text;

			if (worker.status === "spawning") {
				worker.status = "running";
			}

			// Emit new comments
			const newNotes = getNewNotes(ticket.notes, worker.lastSeenCommentCount);
			for (const note of newNotes) {
				this.notifyLLM({
					type: "comment",
					worker: { ...worker },
					comment: note.text,
				});
			}
			if (newNotes.length > 0) {
				worker.lastSeenCommentCount = ticket.notes.length;
				worker.lastActivityAt = Date.now();
				this.resetStuckTimer(name, worker);
			}

			this.renderWidget();
		} catch {
			// ticket read failed — ignore, process exit will handle it
		}
	}

	private async handleWorkerExit(name: string, worker: WorkerHandle, exitCode: number | null) {
		if (!this.ctx) return;
		if (["done", "failed", "killed"].includes(worker.status)) return;

		// Debug breadcrumb
		const debugFile = path.join(this.ctx.cwd, `.pi-teams-debug-${name}.log`);
		fs.writeFileSync(debugFile, `handleWorkerExit called at ${new Date().toISOString()}\nexit=${exitCode}\nstatus=${worker.status}\n`);

		// Stop watching
		this.unwatchWorker(name);

		// Read ticket to get final state
		let lastNote = "(no notes left by worker)";
		let ticketClosed = false;
		try {
			const tkResult = await this.pi.exec("tk", ["show", worker.ticketId], {
				cwd: this.ctx.cwd,
				timeout: 5000,
			});
			const ticket = parseTicketShow(tkResult.stdout ?? "");
			ticketClosed = ticket.status === "closed" || ticket.status === "done";
			lastNote = ticket.notes.at(-1)?.text ?? lastNote;

			if (!ticketClosed) {
				await this.pi.exec("tk", ["close", worker.ticketId], { cwd: this.ctx.cwd, timeout: 5000 }).catch(() => {});
			}
		} catch {
			// tk read failed — proceed with what we have
		}

		const isSuccess = ticketClosed || exitCode === 0;
		worker.status = isSuccess ? "done" : "failed";
		worker.ticketStatus = "closed";
		worker.lastNote = lastNote;
		worker.lastActivityAt = Date.now();

		const event: PollEvent = isSuccess
			? { type: "completed", worker: { ...worker }, result: lastNote }
			: { type: "failed", worker: { ...worker }, reason: `process exited (code ${exitCode}). Last note: ${lastNote}` };

		fs.appendFileSync(debugFile, `notifying: ${event.type}\n`);
		this.notifyLLM(event);
		fs.appendFileSync(debugFile, `notified OK\n`);

		await cleanupWorker(this.ctx.cwd, worker).catch(() => {});
		this.childProcesses.delete(name);

		const hasActive = [...this.workers.values()].some((w) => !["done", "failed", "killed"].includes(w.status));
		if (!hasActive) {
			this.scheduleCleanup();
		}
		this.renderWidget();
	}

	private resetStuckTimer(name: string, worker: WorkerHandle) {
		const existing = this.stuckTimers.get(name);
		if (existing) clearTimeout(existing);

		const timer = setTimeout(() => {
			if (["done", "failed", "killed"].includes(worker.status)) return;
			this.notifyLLM({
				type: "stuck",
				worker: { ...worker },
				idleSeconds: Math.floor(STUCK_THRESHOLD_MS / 1000),
			});
		}, STUCK_THRESHOLD_MS);
		this.stuckTimers.set(name, timer);
	}

	private unwatchWorker(name: string) {
		const watcher = this.fileWatchers.get(name);
		if (watcher) {
			watcher.close();
			this.fileWatchers.delete(name);
		}
		const timer = this.stuckTimers.get(name);
		if (timer) {
			clearTimeout(timer);
			this.stuckTimers.delete(name);
		}
	}

	async kill(workerName: string): Promise<void> {
		const worker = this.workers.get(workerName);
		if (!worker) return;
		worker.status = "killed";
		this.unwatchWorker(workerName);
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

	private scheduleCleanup() {
		if (this.cleanupTimer) return;
		this.cleanupTimer = setTimeout(() => {
			this.cleanupTimer = null;
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

	private notifyLLM(event: PollEvent) {
		if (event.type === "completed" || event.type === "failed") {
			const key = `${event.worker.name}:terminal`;
			if (this.notifiedTerminal.has(key)) return;
			this.notifiedTerminal.add(key);
		}

		if (event.type === "comment" && event.comment.startsWith("DONE:")) {
			return;
		}

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
	done: `${GREEN}\uF00C${RESET}`,
	fail: `${RED}\uF00D${RESET}`,
	warn: `${YELLOW}\uF071${RESET}`,
	comment: `${CYAN}\uF075${RESET}`,
	alive: `${DIM}\uF111${RESET}`,
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
