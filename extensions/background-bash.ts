import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 2000;

type BackgroundJobStatus = "running" | "exited" | "stopped";
type BashCompatAction = "run" | "start" | "status" | "logs" | "stop" | "list";

export type BackgroundBashJob = {
	id: string;
	command: string;
	cwd: string;
	pid: number;
	logPath: string;
	status: BackgroundJobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string;
};

export type BackgroundLogsResult = {
	text: string;
	offset: number;
	limit: number;
	nextOffset: number;
	totalLines: number;
	hasMore: boolean;
	status: BackgroundJobStatus;
};

const toSignalName = (signal: NodeJS.Signals | number | null): string | undefined => {
	if (typeof signal === "number") return `SIG${signal}`;
	if (typeof signal === "string") return signal;
	return undefined;
};

const cloneJob = (job: BackgroundBashJob): BackgroundBashJob => ({ ...job });

const isProcessAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "EPERM") return true;
		return false;
	}
};

const sendSignal = (pid: number, signal: NodeJS.Signals): void => {
	try {
		process.kill(-pid, signal);
		return;
	} catch (_error) {
		process.kill(pid, signal);
	}
};

const resolveWorkingDirectory = (baseCwd: string, explicitCwd?: string): string => {
	if (!explicitCwd) return baseCwd;
	if (path.isAbsolute(explicitCwd)) return explicitCwd;
	return path.resolve(baseCwd, explicitCwd);
};

const createJobId = (): string => `bg-${randomBytes(4).toString("hex")}`;

const sanitizeLineNumber = (value: number | undefined, fallback: number, max: number): number => {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	const normalized = Math.floor(value);
	if (normalized < 1) return 1;
	return Math.min(max, normalized);
};

const formatJobLine = (job: BackgroundBashJob): string => {
	const runtime = job.endedAt
		? `${Math.max(0, Math.floor((job.endedAt - job.startedAt) / 1000))}s`
		: `${Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000))}s`;
	const code = job.exitCode === undefined ? "" : ` exit=${job.exitCode}`;
	const signal = job.signal ? ` signal=${job.signal}` : "";
	return `${job.id} ${job.status} pid=${job.pid}${code}${signal} runtime=${runtime} cwd=${job.cwd}\n  cmd: ${job.command}`;
};

const formatForegroundOutput = async (
	output: string,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> => {
	if (!output.trim()) {
		return { text: "(no output)", truncated: false };
	}

	const truncation = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}

	const tempFile = path.join(os.tmpdir(), `pi-bash-fg-${Date.now()}.log`);
	await fs.writeFile(tempFile, output, "utf8");

	const summary = `\n\n[output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
		truncation.outputBytes,
	)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;

	return {
		text: truncation.content + summary,
		truncated: true,
		fullOutputPath: tempFile,
	};
};

const errorResult = (message: string) => ({
	content: [{ type: "text" as const, text: `Error: ${message}` }],
	isError: true,
});

export class BackgroundBashManager {
	private readonly jobs = new Map<string, BackgroundBashJob>();
	private readonly children = new Map<string, ChildProcess>();
	private readonly logRoot: string;

	constructor(options?: { logRoot?: string }) {
		this.logRoot = options?.logRoot ?? os.tmpdir();
	}

	async start(input: { command: string; cwd: string; id?: string }): Promise<BackgroundBashJob> {
		const command = input.command.trim();
		if (!command) {
			throw new Error("Command must not be empty.");
		}

		const cwd = path.resolve(input.cwd);
		const stats = await fs.stat(cwd).catch(() => null);
		if (!stats || !stats.isDirectory()) {
			throw new Error(`Working directory does not exist: ${cwd}`);
		}

		const id = input.id ?? createJobId();
		if (this.jobs.has(id)) {
			throw new Error(`Background job already exists: ${id}`);
		}

		const logPath = path.join(this.logRoot, `pi-bg-${id}.log`);
		const logFd = openSync(logPath, "a");
		let child: ChildProcess;

		try {
			child = spawn("sh", ["-c", command], {
				cwd,
				detached: true,
				stdio: ["ignore", logFd, logFd],
				env: process.env,
			});

			await new Promise<void>((resolve, reject) => {
				child.once("spawn", resolve);
				child.once("error", reject);
			});
		} finally {
			closeSync(logFd);
		}

		if (!child.pid) {
			throw new Error("Failed to start background job.");
		}

		const now = Date.now();
		const job: BackgroundBashJob = {
			id,
			command,
			cwd,
			pid: child.pid,
			logPath,
			status: "running",
			startedAt: now,
		};

		this.jobs.set(id, job);
		this.children.set(id, child);

		child.on("exit", (exitCode, signal) => {
			const current = this.jobs.get(id);
			if (!current) return;
			current.status = signal ? "stopped" : "exited";
			current.exitCode = exitCode;
			current.signal = toSignalName(signal);
			current.endedAt = Date.now();
			this.children.delete(id);
		});

		child.unref();
		return cloneJob(job);
	}

	getStatus(id: string): BackgroundBashJob | null {
		const job = this.jobs.get(id);
		if (!job) return null;
		this.refreshJob(job);
		return cloneJob(job);
	}

	list(): BackgroundBashJob[] {
		const jobs = [...this.jobs.values()];
		for (const job of jobs) this.refreshJob(job);
		return jobs
			.sort((a, b) => b.startedAt - a.startedAt)
			.map((job) => cloneJob(job));
	}

	async stop(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<BackgroundBashJob> {
		const job = this.jobs.get(id);
		if (!job) {
			throw new Error(`Background job not found: ${id}`);
		}

		this.refreshJob(job);
		if (job.status !== "running") {
			return cloneJob(job);
		}

		try {
			sendSignal(job.pid, signal);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ESRCH") throw error;
		}

		this.refreshJob(job);
		return cloneJob(job);
	}

	async readLogs(id: string, options?: { offset?: number; limit?: number }): Promise<BackgroundLogsResult> {
		const job = this.jobs.get(id);
		if (!job) {
			throw new Error(`Background job not found: ${id}`);
		}

		this.refreshJob(job);
		const offset = sanitizeLineNumber(options?.offset, 1, Number.MAX_SAFE_INTEGER);
		const limit = sanitizeLineNumber(options?.limit, DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);

		let content = "";
		try {
			content = await fs.readFile(job.logPath, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "ENOENT") throw error;
		}

		const normalized = content.replace(/\r/g, "");
		const lines = normalized ? normalized.split("\n") : [];
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		const startIndex = Math.min(lines.length, offset - 1);
		const selected = lines.slice(startIndex, startIndex + limit);
		const nextOffset = startIndex + selected.length + 1;
		const hasMore = startIndex + selected.length < lines.length;

		const text =
			selected.length === 0
				? "(no output yet)"
				: selected.map((line, index) => `${startIndex + index + 1}: ${line}`).join("\n");

		return {
			text,
			offset: startIndex + 1,
			limit,
			nextOffset,
			totalLines: lines.length,
			hasMore,
			status: job.status,
		};
	}

	private refreshJob(job: BackgroundBashJob): void {
		if (job.status !== "running") return;
		if (!isProcessAlive(job.pid)) {
			job.status = "exited";
			job.endedAt ??= Date.now();
			job.exitCode ??= null;
			this.children.delete(job.id);
		}
	}
}

const StartParams = Type.Object({
	command: Type.String({ description: "Bash command to run in the background." }),
	cwd: Type.Optional(
		Type.String({ description: "Working directory (absolute or relative to current session cwd)." }),
	),
	repo: Type.Optional(Type.String({ description: "Alias for cwd." })),
});

const StatusParams = Type.Object({
	id: Type.String({ description: "Background job ID." }),
});

const LogsParams = Type.Object({
	id: Type.String({ description: "Background job ID." }),
	offset: Type.Optional(
		Type.Number({
			description: "1-indexed log line to start from (default: 1).",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum lines to return (default: 200, max: 2000).",
		}),
	),
});

const StopParams = Type.Object({
	id: Type.String({ description: "Background job ID." }),
	signal: Type.Optional(
		Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")], {
			description: "Signal to send. Defaults to SIGTERM.",
		}),
	),
});

const ListParams = Type.Object({});

const BashCompatParams = Type.Object({
	command: Type.Optional(Type.String({ description: "Bash command to execute." })),
	timeout: Type.Optional(
		Type.Number({ description: "Timeout in seconds for foreground execution (same as built-in bash)." }),
	),
	background: Type.Optional(
		Type.Boolean({ description: "Start command in background (equivalent to action='start')." }),
	),
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("run"),
				Type.Literal("start"),
				Type.Literal("status"),
				Type.Literal("logs"),
				Type.Literal("stop"),
				Type.Literal("list"),
			],
			{ description: "Lifecycle action: run (foreground), start/status/logs/stop/list for background jobs." },
		),
	),
	id: Type.Optional(Type.String({ description: "Background job ID for status/logs/stop." })),
	offset: Type.Optional(Type.Number({ description: "1-indexed line offset for logs action." })),
	limit: Type.Optional(Type.Number({ description: "Max lines for logs action." })),
	signal: Type.Optional(
		Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")], {
			description: "Signal used by stop action.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (absolute or relative to current session cwd)." })),
	repo: Type.Optional(Type.String({ description: "Alias for cwd." })),
});

type StartParamsType = Static<typeof StartParams>;
type StatusParamsType = Static<typeof StatusParams>;
type LogsParamsType = Static<typeof LogsParams>;
type StopParamsType = Static<typeof StopParams>;
export type BashCompatParamsType = Static<typeof BashCompatParams>;

const resolveAction = (params: BashCompatParamsType): BashCompatAction => {
	if (params.action) return params.action;
	if (params.background) return "start";
	return "run";
};

const requireCommand = (params: BashCompatParamsType): string | null => {
	const command = params.command?.trim();
	return command && command.length > 0 ? command : null;
};

const requireJobId = (params: BashCompatParamsType): string | null => {
	const id = params.id?.trim();
	return id && id.length > 0 ? id : null;
};

async function runForegroundCommand(
	pi: ExtensionAPI,
	params: BashCompatParamsType,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
) {
	const command = requireCommand(params);
	if (!command) {
		return errorResult("Command is required for foreground execution.");
	}

	const cwd = resolveWorkingDirectory(ctx.cwd, params.cwd ?? params.repo);
	const timeoutSeconds = params.timeout;
	const timeoutMs =
		timeoutSeconds !== undefined && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
			? Math.floor(timeoutSeconds * 1000)
			: undefined;

	try {
		const result = await pi.exec("sh", ["-c", command], {
			cwd,
			signal,
			timeout: timeoutMs,
		});

		const output = [result.stdout, result.stderr].filter(Boolean).join(result.stderr ? "\n" : "");
		const formatted = await formatForegroundOutput(output);

		if (result.code !== 0) {
			return {
				content: [{ type: "text" as const, text: `${formatted.text}\n\nCommand exited with code ${result.code}` }],
				isError: true,
				details: {
					command,
					cwd,
					exitCode: result.code,
					truncated: formatted.truncated,
					fullOutputPath: formatted.fullOutputPath,
				},
			};
		}

		return {
			content: [{ type: "text" as const, text: formatted.text }],
			details: {
				command,
				cwd,
				exitCode: result.code,
				truncated: formatted.truncated,
				fullOutputPath: formatted.fullOutputPath,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return errorResult(message);
	}
}

export async function runBashToolAction(
	pi: ExtensionAPI,
	manager: BackgroundBashManager,
	params: BashCompatParamsType,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
) {
	const action = resolveAction(params);

	if (action === "run") {
		return runForegroundCommand(pi, params, signal, ctx);
	}

	if (action === "start") {
		const command = requireCommand(params);
		if (!command) {
			return errorResult("Command is required for start action.");
		}

		try {
			const cwd = resolveWorkingDirectory(ctx.cwd, params.cwd ?? params.repo);
			const job = await manager.start({ command, cwd });
			return {
				content: [
					{
						type: "text" as const,
						text: `Started background job ${job.id}\nPID: ${job.pid}\nCWD: ${job.cwd}\nLog: ${job.logPath}`,
					},
				],
				details: job,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResult(message);
		}
	}

	if (action === "list") {
		const jobs = manager.list();
		if (jobs.length === 0) {
			return {
				content: [{ type: "text" as const, text: "No background bash jobs." }],
				details: { jobs: [] },
			};
		}

		return {
			content: [{ type: "text" as const, text: jobs.map(formatJobLine).join("\n\n") }],
			details: { jobs },
		};
	}

	const id = requireJobId(params);
	if (!id) {
		return errorResult(`${action} action requires id.`);
	}

	if (action === "status") {
		const status = manager.getStatus(id);
		if (!status) {
			return errorResult(`Background job not found: ${id}`);
		}

		return {
			content: [{ type: "text" as const, text: formatJobLine(status) }],
			details: status,
		};
	}

	if (action === "logs") {
		try {
			const result = await manager.readLogs(id, {
				offset: params.offset,
				limit: params.limit,
			});

			const header = `Job ${id} (${result.status}) lines ${result.offset}-${Math.max(result.offset, result.nextOffset - 1)} of ${result.totalLines}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${result.text}` }],
				details: result,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResult(message);
		}
	}

	if (action === "stop") {
		try {
			const status = await manager.stop(id, params.signal ?? "SIGTERM");
			return {
				content: [{ type: "text" as const, text: `Stop signal sent to ${id}\n${formatJobLine(status)}` }],
				details: status,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResult(message);
		}
	}

	return errorResult(`Unknown action: ${String(action)}`);
}

export default function (pi: ExtensionAPI) {
	const manager = new BackgroundBashManager();

	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command. Default action runs in foreground. Set background=true (or action='start') to run in background. Use action=status|logs|stop|list with id to manage background jobs.",
		parameters: BashCompatParams,
		async execute(_toolCallId, params: BashCompatParamsType, signal, _onUpdate, ctx) {
			return runBashToolAction(pi, manager, params, signal, ctx);
		},
	});

	pi.registerTool({
		name: "bash_bg_start",
		label: "bash-bg-start",
		description:
			"Start a bash command in the background and return immediately with a job ID. Use bash_bg_status/bash_bg_logs/bash_bg_stop to manage it.",
		parameters: StartParams,
		async execute(_toolCallId, params: StartParamsType, signal, _onUpdate, ctx) {
			return runBashToolAction(
				pi,
				manager,
				{ action: "start", command: params.command, cwd: params.cwd, repo: params.repo },
				signal,
				ctx,
			);
		},
	});

	pi.registerTool({
		name: "bash_bg_status",
		label: "bash-bg-status",
		description: "Get status for a background bash job.",
		parameters: StatusParams,
		async execute(_toolCallId, params: StatusParamsType, signal, _onUpdate, ctx) {
			return runBashToolAction(pi, manager, { action: "status", id: params.id }, signal, ctx);
		},
	});

	pi.registerTool({
		name: "bash_bg_logs",
		label: "bash-bg-logs",
		description: "Read logs from a background bash job.",
		parameters: LogsParams,
		async execute(_toolCallId, params: LogsParamsType, signal, _onUpdate, ctx) {
			return runBashToolAction(
				pi,
				manager,
				{ action: "logs", id: params.id, offset: params.offset, limit: params.limit },
				signal,
				ctx,
			);
		},
	});

	pi.registerTool({
		name: "bash_bg_stop",
		label: "bash-bg-stop",
		description: "Stop a background bash job.",
		parameters: StopParams,
		async execute(_toolCallId, params: StopParamsType, signal, _onUpdate, ctx) {
			return runBashToolAction(
				pi,
				manager,
				{ action: "stop", id: params.id, signal: params.signal },
				signal,
				ctx,
			);
		},
	});

	pi.registerTool({
		name: "bash_bg_list",
		label: "bash-bg-list",
		description: "List all background bash jobs started in this session.",
		parameters: ListParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			return runBashToolAction(pi, manager, { action: "list" }, signal, ctx);
		},
	});
}
