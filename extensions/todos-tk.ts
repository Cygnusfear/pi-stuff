import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const TkToolParams = Type.Object({
	args: Type.Optional(Type.String({ description: "Arguments to pass to tk (same syntax as /tk)." })),
	cwd: Type.Optional(Type.String({ description: "Working directory (overrides repo detection)." })),
	repo: Type.Optional(Type.String({ description: "Alias for cwd." })),
});

type TkToolParamsType = Static<typeof TkToolParams>;

type TkMessageDetails = {
	command?: string;
	cwd?: string;
	exitCode?: number | null;
	truncated?: boolean;
	fullOutputPath?: string;
};

type TkToolDetails = {
	command: string;
	cwd: string;
	exitCode: number | null;
	truncated?: boolean;
	fullOutputPath?: string;
};

const isProjectRoot = (dir: string): boolean => {
	try {
		const gitPath = path.join(dir, ".git");
		if (fs.existsSync(gitPath)) return true;
		const ticketsPath = path.join(dir, ".tickets");
		return fs.existsSync(ticketsPath);
	} catch {
		return false;
	}
};

const findProjectRoot = (start: string): string | undefined => {
	let dir = path.resolve(start);
	while (true) {
		if (isProjectRoot(dir)) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
};

const resolveRepo = (cwd: string, explicitCwd?: string): string => {
	if (explicitCwd) return explicitCwd;
	return findProjectRoot(cwd) ?? cwd;
};

const splitArgs = (input: string): string[] => {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;
	let escape = false;

	for (const char of input) {
		if (escape) {
			current += char;
			escape = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escape = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "\"" || char === "'") {
			quote = char as "'" | '"';
			continue;
		}

		if (/\s/.test(char)) {
			if (current.length > 0) {
				args.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current.length > 0) {
		args.push(current);
	}

	return args;
};

const hasFlagValue = (args: string[], longFlag: string, shortFlag?: string): boolean => {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === longFlag || (shortFlag && arg === shortFlag)) {
			return i + 1 < args.length;
		}
		if (arg.startsWith(`${longFlag}=`)) {
			return true;
		}
		if (shortFlag && arg.startsWith(shortFlag) && arg.length > shortFlag.length) {
			return true;
		}
	}

	return false;
};

const validateCreateArgs = (args: string[]): string | null => {
	if (args[0] !== "create") return null;

	const missing: string[] = [];
	if (!hasFlagValue(args, "--tags")) missing.push("tags (--tags)");
	if (!hasFlagValue(args, "--priority", "-p")) missing.push("priority (-p/--priority)");
	if (!hasFlagValue(args, "--type", "-t")) missing.push("type (-t/--type)");
	if (!hasFlagValue(args, "--description", "-d")) missing.push("description (-d/--description)");

	if (missing.length === 0) return null;

	return `Ticket creation requires ${missing.join(", ")}. Example: tk create "Title" -t task -p 2 --tags process,tooling -d "Describe the work."\n\nTip: prefer the todos_oneshot tool to create + start the ticket and append the standard Goal/AC/Verification template (no printf needed).`;
};

const TodosOneshotParams = Type.Object({
	title: Type.String({ description: "Ticket title." }),
	description: Type.String({ description: "Description text (-d/--description)." }),
	tags: Type.String({ description: "Comma-separated tags (--tags)." }),
	type: Type.Optional(Type.String({ description: "Ticket type (bug|feature|task|epic|chore). Default: task." })),
	priority: Type.Optional(Type.Number({ description: "Priority 0-4, 0=highest. Default: 2." })),
	goal: Type.Optional(Type.String({ description: "Goal section text. Defaults to description." })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String({ description: "Acceptance criteria item." }))),
	verification: Type.Optional(Type.Array(Type.String({ description: "Verification item." }))),
	worktree: Type.Optional(Type.String({ description: "Worktree path. Default: ." })),
	start: Type.Optional(Type.Boolean({ description: "Start ticket immediately. Default: true." })),
	cwd: Type.Optional(Type.String({ description: "Working directory (overrides repo detection)." })),
	repo: Type.Optional(Type.String({ description: "Alias for cwd." })),
});

type TodosOneshotParamsType = Static<typeof TodosOneshotParams>;

type TodosOneshotDetails = {
	id: string;
	filePath: string;
	cwd: string;
	started: boolean;
	appendedTemplate: boolean;
};

const buildChecklist = (items: string[] | undefined): string => {
	const normalized = (items ?? []).map((item) => item.trim()).filter(Boolean);
	const effective = normalized.length > 0 ? normalized : ["TODO"];
	return effective.map((item) => `- [ ] ${item}`).join("\n");
};

const buildTicketTemplate = (params: TodosOneshotParamsType): string => {
	const goal = params.goal?.trim() || params.description.trim();
	const worktree = params.worktree?.trim() || ".";

	return `\n\n## Goal\n${goal}\n\n## Acceptance Criteria\n${buildChecklist(params.acceptanceCriteria)}\n\n## Verification\n${buildChecklist(params.verification)}\n\n## Worktree\n- ${worktree}\n`;
};

const createTicketOneshot = async (
	pi: ExtensionAPI,
	baseCwd: string,
	params: TodosOneshotParamsType,
	signal?: AbortSignal,
): Promise<{ text: string; details: TodosOneshotDetails }> => {
	const cwd = resolveRepo(baseCwd, params.cwd ?? params.repo);
	const title = params.title.trim();
	const description = params.description.trim();
	const tags = params.tags.trim();

	if (!title) throw new Error("title is required");
	if (!description) throw new Error("description is required");
	if (!tags) throw new Error("tags is required");

	const type = params.type?.trim() || "task";
	const priority = params.priority ?? 2;
	const start = params.start !== false;

	const createRes = await pi.exec(
		"tk",
		["create", title, "-t", type, "-p", String(priority), "--tags", tags, "-d", description],
		{ cwd, signal },
	);
	if (createRes.code !== 0) {
		const out = [createRes.stdout, createRes.stderr].filter(Boolean).join(createRes.stderr ? "\n" : "");
		const formatted = await formatOutput(out);
		throw new Error(formatted.text);
	}

	const id = createRes.stdout.trim().split(/\s+/)[0];
	if (!id) throw new Error("Failed to parse ticket id from tk output.");

	if (start) {
		const startRes = await pi.exec("tk", ["start", id], { cwd, signal });
		if (startRes.code !== 0) {
			const out = [startRes.stdout, startRes.stderr].filter(Boolean).join(startRes.stderr ? "\n" : "");
			const formatted = await formatOutput(out);
			throw new Error(`Failed to start ticket ${id}: ${formatted.text}`);
		}
	}

	const filePath = path.join(cwd, ".tickets", `${id}.md`);
	const template = buildTicketTemplate(params);

	let appendedTemplate = false;
	const current = await fsPromises.readFile(filePath, "utf8").catch(() => "");
	if (!current.includes("\n## Goal\n")) {
		await fsPromises.appendFile(filePath, template, "utf8");
		appendedTemplate = true;
	}

	const relative = path.relative(cwd, filePath);
	const msg = `Created ${id}${start ? " (started)" : ""}. Updated ${relative}${appendedTemplate ? " with template sections." : " (template already present)."}`;
	return {
		text: msg,
		details: {
			id,
			filePath,
			cwd,
			started: start,
			appendedTemplate,
		},
	};
};

const extractCwd = (args: string[]): { cwd?: string; rest: string[] } => {
	let cwd: string | undefined;
	const rest: string[] = [];

	for (let i = 0; i < args.length; i += 1) {
		const token = args[i];
		if (token === "--cwd" || token === "--repo" || token === "-C") {
			cwd = args[i + 1];
			i += 1;
			continue;
		}
		if (token.startsWith("--cwd=") || token.startsWith("--repo=")) {
			cwd = token.split("=")[1];
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			cwd = token.slice(2);
			continue;
		}
		rest.push(token);
	}

	return { cwd, rest };
};

const formatOutput = async (
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

	const tempFile = path.join(os.tmpdir(), `pi-tk-${Date.now()}.log`);
	await fsPromises.writeFile(tempFile, output, "utf8");

	const summary = `\n\n[output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
	return { text: truncation.content + summary, truncated: true, fullOutputPath: tempFile };
};

const renderTkMessage = (message: { content: string; details?: TkMessageDetails }, theme: Theme): Text => {
	const details = message.details;
	let header = theme.fg("toolTitle", theme.bold("tk"));
	if (details?.command) {
		header += " " + theme.fg("muted", details.command);
	}
	if (details?.cwd) {
		header += " " + theme.fg("dim", `(${details.cwd})`);
	}
	if (details?.exitCode !== undefined && details.exitCode !== null) {
		const color = details.exitCode === 0 ? "success" : "error";
		header += " " + theme.fg(color, `[${details.exitCode}]`);
	}

	return new Text(`${header}\n${message.content}`, 0, 0);
};

const runTk = async (
	pi: ExtensionAPI,
	baseCwd: string,
	args?: string,
	explicitCwd?: string,
	signal?: AbortSignal,
) => {
	const tokens = splitArgs(args ?? "");
	const { cwd: argsCwd, rest } = extractCwd(tokens);
	const cwd = resolveRepo(baseCwd, explicitCwd ?? argsCwd);
	const tkArgs = rest.length > 0 ? rest : ["ls"];
	const commandLabel = ["tk", ...tkArgs].join(" ");
	const createValidation = validateCreateArgs(tkArgs);
	if (createValidation) {
		return {
			text: createValidation,
			details: {
				command: commandLabel,
				cwd,
				exitCode: 1,
			} satisfies TkToolDetails,
		};
	}

	const result = await pi.exec("tk", tkArgs, { cwd, signal });
	const output = [result.stdout, result.stderr].filter(Boolean).join(result.stderr ? "\n" : "");
	const formatted = await formatOutput(output);

	return {
		text: formatted.text,
		details: {
			command: commandLabel,
			cwd,
			exitCode: result.code,
			truncated: formatted.truncated,
			fullOutputPath: formatted.fullOutputPath,
		} satisfies TkToolDetails,
	};
};

const runTkCommand = async (pi: ExtensionAPI, ctx: ExtensionCommandContext, args?: string) => {
	const result = await runTk(pi, ctx.cwd, args);

	pi.sendMessage({
		customType: "tk",
		content: result.text,
		display: true,
		details: result.details satisfies TkMessageDetails,
	});
};

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("tk", (message, _options, theme) => {
		return renderTkMessage(
			{
				content: typeof message.content === "string" ? message.content : "",
				details: message.details as TkMessageDetails | undefined,
			},
			theme,
		);
	});

	pi.registerTool({
		name: "todos_oneshot",
		label: "Ticket Oneshot (tk)",
		description:
			"Create a tk ticket with required metadata, start it, and append the standard Goal/Acceptance Criteria/Verification/Worktree template to .tickets/<id>.md (no shell oneshot/printf).",
		parameters: TodosOneshotParams,
		async execute(_toolCallId, params: TodosOneshotParamsType, signal, _onUpdate, ctx) {
			const result = await createTicketOneshot(pi, ctx.cwd, params, signal);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},
	});

	pi.registerTool({
		name: "todos",
		label: "Todos (tk)",
		description: "Run tk commands (uses current project root by default).",
		parameters: TkToolParams,
		async execute(_toolCallId, params: TkToolParamsType, signal, _onUpdate, ctx) {
			const explicitCwd = params.cwd ?? params.repo;
			const result = await runTk(pi, ctx.cwd, params.args, explicitCwd, signal);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todos"));
			const argLabel = args.args?.trim() ? args.args.trim() : "ls";
			text += " " + theme.fg("muted", argLabel);
			const cwdLabel = args.cwd ?? args.repo;
			if (cwdLabel) {
				text += " " + theme.fg("dim", `(${cwdLabel})`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TkToolDetails | undefined;
			if (!details) return new Text("", 0, 0);
			const ok = details.exitCode === 0 || details.exitCode === null || details.exitCode === undefined;
			let text = ok ? theme.fg("success", "✓ tk") : theme.fg("error", "tk failed");
			if (details.exitCode !== null && details.exitCode !== undefined) {
				text += " " + theme.fg(ok ? "muted" : "error", `[${details.exitCode}]`);
			}
			if (details.truncated) {
				text += " " + theme.fg("warning", "(truncated)");
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Run tk commands (uses current project root by default)",
		handler: async (args, ctx) => {
			await runTkCommand(pi, ctx, args);
		},
	});

	pi.registerCommand("tk", {
		description: "Alias for /todos (tk commands)",
		handler: async (args, ctx) => {
			await runTkCommand(pi, ctx, args);
		},
	});
}
