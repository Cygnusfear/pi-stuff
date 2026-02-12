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

	return `Ticket creation requires ${missing.join(", ")}. Example: tk create "Title" -t task -p 2 --tags process,tooling -d "Describe the work."`;
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
