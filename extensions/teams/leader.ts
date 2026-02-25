import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateIdleState,
  formatRuntimeSummary,
  sampleWorkerProcessSnapshot,
} from "./activity.js";
import { cleanupWorker } from "./cleanup.js";
import { spawnWorker } from "./spawner.js";
import { getNewNotes, parseTicketShow } from "./tickets.js";
import type { PollEvent, SpawnConfig, WorkerHandle } from "./types.js";
import {
  ACTIVITY_POLL_INTERVAL_MS,
  STUCK_THRESHOLD_MS,
  STUCK_WARNING_COOLDOWN_MS,
} from "./types.js";
import { createTeamsWidget } from "./widget.js";
import { createWorktree, workerWorktreePath } from "./worktree.js";

export class TeamLeader {
  private workers = new Map<string, WorkerHandle>();
  private childProcesses = new Map<string, ChildProcess>();
  private fileWatchers = new Map<string, fs.FSWatcher>();
  private activityTimers = new Map<string, ReturnType<typeof setInterval>>();
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private pi: ExtensionAPI;
  private ctx: ExtensionContext | null = null;
  private widgetFactory = createTeamsWidget(() => this.getWorkers());
  private notifiedTerminal = new Set<string>();
  private notifyQueue: Array<{ msg: string; triggerTurn: boolean }> = [];
  private notifyDraining = false;
  showComments = true;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  setContext(ctx: ExtensionContext) {
    this.ctx = ctx;
    this.renderWidget();
  }

  // Keep these for backward compat with tool.ts
  startPolling() {}

  stopPolling() {
    for (const timer of this.activityTimers.values()) {
      clearInterval(timer);
    }
    this.activityTimers.clear();
  }

  async delegate(
    ticketId: string,
    workerName: string,
    useWorktree: boolean,
    model?: string,
    hasTools?: boolean,
  ): Promise<WorkerHandle> {
    if (!this.ctx) throw new Error("Leader context not set");

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const isNestedWorker = process.env.PI_TEAMS_WORKER === "1";

    // Worker-leaders must not create worktrees — sub-workers share the parent's working directory.
    // Creating nested worktrees off a worktree causes git confusion and cleanup headaches.
    if (isNestedWorker && useWorktree) {
      useWorktree = false;
    }

    const repoDir = this.ctx.cwd;
    let cwd = repoDir;

    if (useWorktree) {
      const wtPath = workerWorktreePath(repoDir, workerName);
      const result = await createWorktree(repoDir, workerName, ticketId, wtPath);
      if (!result.success) throw new Error(`Worktree creation failed: ${result.error}`);
      cwd = wtPath;
    }

    // Resolve effective model: verify requested model is available, fall back to leader's
    const effectiveModel = this.resolveWorkerModel(model);

    const sessionFile = this.ctx.sessionManager.getSessionFile() ?? "";
    const config: SpawnConfig = {
      ticketId,
      workerName,
      useWorktree,
      cwd,
      leaderSessionFile: sessionFile,
      model: effectiveModel,
      hasTools,
    };

    const { process: child, handle } = spawnWorker(config);
    this.workers.set(workerName, handle);
    this.childProcesses.set(workerName, child);

    // Process exit — the definitive completion signal
    child.on("exit", (code) => {
      handle.exitCode = code;
      void this.handleWorkerExit(workerName, handle, code);
    });

    // Watch ticket file for progress notes
    this.watchTicketFile(workerName, handle);

    // Activity + stuck detection
    this.startActivityMonitor(workerName, handle);

    this.renderWidget();
    return handle;
  }

  private watchTicketFile(name: string, worker: WorkerHandle) {
    if (!this.ctx) return;
    const ticketPath = path.join(this.ctx.cwd, ".tickets", `${worker.ticketId}.md`);

    try {
      const watcher = fs.watch(ticketPath, () => {
        void this.handleTicketChange(worker);
      });
      this.fileWatchers.set(name, watcher);
    } catch {
      // File may not exist yet — that's fine, process exit will catch completion
    }
  }

  private async handleTicketChange(worker: WorkerHandle) {
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

      // Re-check after async gap — worker may have exited while we were reading the ticket
      if (["done", "failed", "killed"].includes(worker.status)) return;

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
        const now = Date.now();
        worker.lastSeenCommentCount = ticket.notes.length;
        worker.lastActivityAt = now;
        worker.lastOutputAt = now;
      }

      this.renderWidget();
    } catch {
      // ticket read failed — ignore, process exit will handle it
    }
  }

  private async handleWorkerExit(name: string, worker: WorkerHandle, exitCode: number | null) {
    if (!this.ctx) return;
    if (["done", "failed", "killed"].includes(worker.status)) return;

    // Stop watching FIRST — before any async work — to prevent race with handleTicketChange
    this.unwatchWorker(name);

    // Mark as exiting immediately so in-flight handleTicketChange calls bail out
    worker.status = exitCode === 0 ? "done" : "failed";

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
        await this.pi
          .exec("tk", ["close", worker.ticketId], { cwd: this.ctx.cwd, timeout: 5000 })
          .catch(() => {});
      }
    } catch {
      // tk read failed — proceed with what we have
    }

    const isSuccess = ticketClosed || exitCode === 0;
    worker.status = isSuccess ? "done" : "failed";
    worker.ticketStatus = "closed";
    worker.lastNote = lastNote;
    worker.lastActivityAt = Date.now();

    // Cleanup: auto-commit dirty files, remove worktree, rename branch to .done
    const preserveBranch = isSuccess && worker.worktreePath !== null;
    const cleanupResult = await cleanupWorker(this.ctx.cwd, worker, preserveBranch).catch(() => undefined);

    if (isSuccess) {
      const branch = `teams/${worker.name}/${worker.ticketId}`;
      const doneBranch = `${branch}.done`;
      const hasBranch = cleanupResult?.branchPreserved;
      const mergeHint = hasBranch
        ? `\n📌 Branch "${doneBranch}" preserved — merge when ready: git merge ${doneBranch}`
        : "";
      this.notifyLLM({
        type: "completed",
        worker: { ...worker },
        result: `${lastNote}${mergeHint}`,
      });
    } else {
      // Try to read stderr log for diagnostic info
      let stderr = "";
      try {
        const stderrPath = path.join(worker.sessionDir, "stderr.log");
        const raw = fs.readFileSync(stderrPath, "utf-8").trim();
        if (raw) stderr = `\nstderr: ${raw.slice(-500)}`;
      } catch {
        // no stderr log available
      }
      this.notifyLLM({
        type: "failed",
        worker: { ...worker },
        reason: `process exited (code ${exitCode}). Last note: ${lastNote}${stderr}`,
      });
    }
    this.childProcesses.delete(name);

    const hasActive = [...this.workers.values()].some(
      (w) => !["done", "failed", "killed"].includes(w.status),
    );
    if (!hasActive) {
      this.scheduleCleanup();
    }
    this.renderWidget();
  }

  private startActivityMonitor(name: string, worker: WorkerHandle) {
    this.stopActivityMonitor(name);

    const tick = () => {
      this.refreshWorkerActivity(name, worker);
    };

    tick();
    const timer = setInterval(tick, ACTIVITY_POLL_INTERVAL_MS);
    this.activityTimers.set(name, timer);
  }

  private stopActivityMonitor(name: string) {
    const timer = this.activityTimers.get(name);
    if (!timer) return;
    clearInterval(timer);
    this.activityTimers.delete(name);
  }

  private refreshSessionActivity(worker: WorkerHandle) {
    // Resolve the actual session file on first call — pi names files
    // as `${timestamp}_${sessionId}.jsonl`, not the hardcoded `session.jsonl`
    // from spawner.ts.
    if (!fs.existsSync(worker.sessionFile)) {
      try {
        const files = fs.readdirSync(worker.sessionDir)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => path.join(worker.sessionDir, f));
        if (files.length === 1) {
          worker.sessionFile = files[0];
        } else if (files.length > 1) {
          // Pick the most recently modified one
          const sorted = files
            .map(f => ({ f, mtime: fs.statSync(f).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          worker.sessionFile = sorted[0].f;
        } else {
          return; // no session file yet
        }
      } catch {
        return; // session dir may not exist yet
      }
    }

    try {
      const stat = fs.statSync(worker.sessionFile);
      const mtimeMs = stat.mtimeMs;
      if (!Number.isFinite(mtimeMs)) return;
      if (worker.lastSessionMtimeMs && mtimeMs <= worker.lastSessionMtimeMs) return;

      worker.lastSessionMtimeMs = mtimeMs;
      worker.lastOutputAt = mtimeMs;
      worker.lastActivityAt = Math.max(worker.lastActivityAt, mtimeMs);
    } catch {
      // Session file may not exist yet.
    }
  }

  private refreshWorkerActivity(name: string, worker: WorkerHandle) {
    if (["done", "failed", "killed"].includes(worker.status)) {
      this.stopActivityMonitor(name);
      return;
    }

    const now = Date.now();
    this.refreshSessionActivity(worker);

    const snapshot = sampleWorkerProcessSnapshot(worker.pid);
    if (!snapshot.rootAlive) {
      return;
    }

    if (worker.status === "spawning") {
      worker.status = "running";
    }

    worker.hasActiveChildProcess = snapshot.hasActiveChildProcess;
    worker.activeChildProcessCount = snapshot.activeChildProcessCount;
    worker.currentCommand = snapshot.currentCommand;
    worker.currentCommandElapsedSeconds = snapshot.currentCommandElapsedSeconds;

    if (snapshot.hasActiveChildProcess) {
      worker.lastProcessActivityAt = now;
    }

    const idle = evaluateIdleState({
      now,
      thresholdMs: STUCK_THRESHOLD_MS,
      hasActiveChildProcess: snapshot.hasActiveChildProcess,
      lastHeartbeatAt: worker.lastActivityAt,
      lastProcessActivityAt: worker.lastProcessActivityAt,
    });

    if (idle.shouldWarnStuck) {
      const cooldownExpired =
        !worker.lastStuckWarningAt || now - worker.lastStuckWarningAt >= STUCK_WARNING_COOLDOWN_MS;
      if (cooldownExpired) {
        worker.lastStuckWarningAt = now;
        this.notifyLLM({
          type: "stuck",
          worker: { ...worker },
          idleSeconds: Math.floor(Math.min(idle.heartbeatIdleMs, idle.processIdleMs) / 1000),
        });
      }
    } else {
      worker.lastStuckWarningAt = undefined;
    }

    this.renderWidget();
  }

  private unwatchWorker(name: string) {
    const watcher = this.fileWatchers.get(name);
    if (watcher) {
      watcher.close();
      this.fileWatchers.delete(name);
    }
    this.stopActivityMonitor(name);
  }

  async kill(workerName: string): Promise<void> {
    const worker = this.workers.get(workerName);
    if (!worker) return;
    worker.status = "killed";
    this.unwatchWorker(workerName);
    if (this.ctx) {
      await this.pi.exec("tk", ["close", worker.ticketId], { cwd: this.ctx.cwd, timeout: 5000 }).catch(() => {});
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

  /**
   * Resolve the effective model for a worker.
   * If the requested model is available, use it. Otherwise fall back to the leader's current model.
   * If neither is set, returns undefined (worker inherits pi's default).
   */
  private resolveWorkerModel(requested?: string): string | undefined {
    if (!requested || !this.ctx) return requested;

    const available = this.ctx.modelRegistry.getAvailable();
    const needle = requested.toLowerCase();
    const found = available.some(m =>
      `${m.provider}/${m.id}`.toLowerCase() === needle || m.id.toLowerCase() === needle,
    );

    if (found) return requested;

    // Fall back to leader's current model
    const leader = this.ctx.model;
    const fallback = leader ? `${leader.provider}/${leader.id}` : undefined;

    this.pi.sendMessage(
      {
        customType: "team-event",
        content: `⚠ Model "${requested}" not available — falling back to ${fallback ?? "default"}.`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );

    return fallback;
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
    const triggerTurn = event.type === "stuck" ? false : true;
    this.notifyQueue.push({ msg, triggerTurn });
    void this.drainNotifyQueue();
  }

  private async drainNotifyQueue() {
    if (this.notifyDraining) return;
    this.notifyDraining = true;
    try {
      while (this.notifyQueue.length > 0) {
        const { msg, triggerTurn } = this.notifyQueue.shift()!;
        this.pi.sendMessage(
          {
            customType: "team-event",
            content: msg,
            display: true,
          },
          { deliverAs: "followUp", triggerTurn },
        );
        // Yield between sends so the agent can process each message
        // and set isStreaming before the next one arrives
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      this.notifyDraining = false;
    }
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
      return `${ICONS.done} • Worker "${event.worker.name}" completed ticket #${event.worker.ticketId}:\n${event.result}`;
    case "failed":
      return `${ICONS.fail} • Worker "${event.worker.name}" failed on ticket #${event.worker.ticketId}: ${event.reason}`;
    case "stuck":
      return `${ICONS.warn} • Worker "${event.worker.name}" may be stuck on ticket #${event.worker.ticketId} (${event.idleSeconds}s idle) · ${formatRuntimeSummary({
        hasActiveChildProcess: event.worker.hasActiveChildProcess,
        activeChildProcessCount: event.worker.activeChildProcessCount,
        currentCommand: event.worker.currentCommand,
        currentCommandElapsedSeconds: event.worker.currentCommandElapsedSeconds,
        lastOutputAt: event.worker.lastOutputAt,
      })}`;
    case "comment":
      return `${ICONS.comment} • Worker "${event.worker.name}" on ticket #${event.worker.ticketId}: ${event.comment}`;
    case "alive":
      return `${ICONS.alive} • Worker "${event.worker.name}" is alive, working on ticket #${event.worker.ticketId}`;
  }
}
