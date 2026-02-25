import { execFileSync } from "node:child_process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  elapsedSeconds: number;
  state: string;
  command: string;
}

export interface WorkerProcessSnapshot {
  rootAlive: boolean;
  hasActiveChildProcess: boolean;
  activeChildProcessCount: number;
  currentCommand?: string;
  currentCommandElapsedSeconds?: number;
  maxChildCpuPercent: number;
}

export interface IdleStateInput {
  now?: number;
  thresholdMs: number;
  hasActiveChildProcess: boolean;
  lastHeartbeatAt: number;
  lastProcessActivityAt: number;
}

export interface IdleState {
  shouldWarnStuck: boolean;
  heartbeatIdleMs: number;
  processIdleMs: number;
}

export interface RuntimeSummaryInput {
  hasActiveChildProcess: boolean;
  activeChildProcessCount?: number;
  currentCommand?: string;
  currentCommandElapsedSeconds?: number;
  lastOutputAt?: number;
}

export function parseElapsedSeconds(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  let days = 0;
  let clock = trimmed;

  if (trimmed.includes("-")) {
    const [dayPart, rest] = trimmed.split("-", 2);
    const parsedDays = Number(dayPart);
    if (!Number.isFinite(parsedDays)) return 0;
    days = parsedDays;
    clock = rest;
  }

  const parts = clock.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;

  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return days * 86400 + minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  return 0;
}

export function parseProcessTable(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ps -o pid=,ppid=,pcpu=,etime=,state=,comm=
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9:-]+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, pidRaw, ppidRaw, cpuRaw, etimeRaw, state, commandRaw] = match;

    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    const cpuPercent = Number(cpuRaw);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(cpuPercent)) continue;

    rows.push({
      pid,
      ppid,
      cpuPercent,
      elapsedSeconds: parseElapsedSeconds(etimeRaw),
      state,
      command: commandRaw.trim(),
    });
  }

  return rows;
}

function isZombie(state: string): boolean {
  return state.toUpperCase().startsWith("Z");
}

export function deriveWorkerProcessSnapshot(rows: ProcessRow[], workerPid: number): WorkerProcessSnapshot {
  const byPid = new Map<number, ProcessRow>(rows.map((row) => [row.pid, row]));
  const root = byPid.get(workerPid);
  if (!root) {
    return {
      rootAlive: false,
      hasActiveChildProcess: false,
      activeChildProcessCount: 0,
      maxChildCpuPercent: 0,
    };
  }

  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const existing = childrenByParent.get(row.ppid) ?? [];
    existing.push(row);
    childrenByParent.set(row.ppid, existing);
  }

  const subtree: ProcessRow[] = [root];
  const seen = new Set<number>([workerPid]);
  const stack = [workerPid];

  while (stack.length > 0) {
    const currentPid = stack.pop()!;
    const directChildren = childrenByParent.get(currentPid) ?? [];

    for (const child of directChildren) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      subtree.push(child);
      stack.push(child.pid);
    }
  }

  const activeChildren = subtree.filter((row) => row.pid !== workerPid && !isZombie(row.state));
  const busiestChild = activeChildren.reduce<ProcessRow | undefined>((best, row) => {
    if (!best) return row;
    if (row.cpuPercent > best.cpuPercent) return row;
    if (row.cpuPercent < best.cpuPercent) return best;
    return row.elapsedSeconds > best.elapsedSeconds ? row : best;
  }, undefined);

  return {
    rootAlive: !isZombie(root.state),
    hasActiveChildProcess: activeChildren.length > 0,
    activeChildProcessCount: activeChildren.length,
    currentCommand: busiestChild?.command,
    currentCommandElapsedSeconds: busiestChild?.elapsedSeconds,
    maxChildCpuPercent: activeChildren.reduce((max, row) => Math.max(max, row.cpuPercent), 0),
  };
}

export function sampleWorkerProcessSnapshot(workerPid: number): WorkerProcessSnapshot {
  try {
    const output = execFileSync("ps", ["-ax", "-o", "pid=,ppid=,pcpu=,etime=,state=,comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows = parseProcessTable(output);
    return deriveWorkerProcessSnapshot(rows, workerPid);
  } catch {
    return {
      rootAlive: false,
      hasActiveChildProcess: false,
      activeChildProcessCount: 0,
      maxChildCpuPercent: 0,
    };
  }
}

export function evaluateIdleState(input: IdleStateInput): IdleState {
  const now = input.now ?? Date.now();
  const heartbeatIdleMs = Math.max(0, now - input.lastHeartbeatAt);
  const processIdleMs = Math.max(0, now - input.lastProcessActivityAt);

  const shouldWarnStuck =
    !input.hasActiveChildProcess &&
    heartbeatIdleMs >= input.thresholdMs &&
    processIdleMs >= input.thresholdMs;

  return {
    shouldWarnStuck,
    heartbeatIdleMs,
    processIdleMs,
  };
}

function formatDuration(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  if (clamped < 60) return `${clamped}s`;

  if (clamped < 3600) {
    const m = Math.floor(clamped / 60);
    const s = clamped % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatAge(timestampMs: number | undefined, now: number): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "n/a";
  const seconds = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** How recently lastOutputAt must be to count as "thinking" rather than "idle" */
const THINKING_THRESHOLD_MS = 120_000;

export function formatRuntimeSummary(input: RuntimeSummaryInput, now = Date.now()): string {
  const children = input.activeChildProcessCount ?? 0;

  let state: string;
  if (input.hasActiveChildProcess) {
    state = "busy";
  } else if (
    input.lastOutputAt &&
    Number.isFinite(input.lastOutputAt) &&
    now - input.lastOutputAt < THINKING_THRESHOLD_MS
  ) {
    state = "thinking";
  } else {
    state = "idle";
  }

  let commandPart = "";
  if (input.hasActiveChildProcess && input.currentCommand) {
    const elapsed =
      typeof input.currentCommandElapsedSeconds === "number"
        ? ` (${formatDuration(input.currentCommandElapsedSeconds)})`
        : "";
    commandPart = ` ${input.currentCommand}${elapsed}`;
  }

  const processPart = `${state}${input.hasActiveChildProcess ? ` (${children} child${children === 1 ? "" : "ren"})` : ""}${commandPart}`;
  const outputPart = `last output ${formatAge(input.lastOutputAt, now)}`;

  return `${processPart} · ${outputPart}`;
}
