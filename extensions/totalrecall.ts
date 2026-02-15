/**
 * TotalRecall extension for pi
 *
 * Semantic memory for AI agents — search, recall, create, and unfold
 * synthesis nodes from TotalRecall's knowledge graph.
 *
 * Gracefully dormant if `totalrecall` binary is not in PATH.
 *
 * Auto-capture: on session compaction, saves the summary as a memory node.
 * Auto-context: on agent start, injects relevant memories into the system prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { execSync, spawn } from "node:child_process";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

interface SearchResult {
	node_id: string;
	one_liner: string;
	score: number;
	node_type: string;
	ranking_score?: number;
}

interface SearchResponse {
	results: SearchResult[];
	total: number;
	query: string;
}

interface UnfoldResponse {
	id: string;
	node_type: string;
	one_liner: string;
	summary: string;
	full_synthesis?: string;
	source_session_id?: string;
	source_repo?: string;
	created_at: number;
	access_count: number;
	edge_count: number;
}

interface RecallDetails {
	query: string;
	resultCount: number;
	exit: "ok" | "error";
	error?: string;
	summaryLines: string[];
	fullText: string;
}

interface UnfoldDetails {
	nodeId: string;
	depth: string;
	nodeType: string;
	exit: "ok" | "error";
	error?: string;
	summaryLines: string[];
	fullText: string;
}

interface ContextDetails {
	task: string;
	nodeCount: number;
	exit: "ok" | "error";
	error?: string;
	summaryLines: string[];
	fullText: string;
}

interface CreateDetails {
	nodeId: string;
	nodeType: string;
	oneLiner: string;
	exit: "ok" | "error";
	error?: string;
}

// =============================================================================
// Helpers
// =============================================================================

const DB_URL = "postgresql://totalrecall:totalrecall_dev@localhost:5432/totalrecall";

/** Check if totalrecall binary is available */
function isTotalRecallAvailable(): boolean {
	try {
		execSync("which totalrecall", { encoding: "utf-8", timeout: 1_000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function runTotalRecall(args: string): string {
	const result = execSync(`totalrecall ${args}`, {
		encoding: "utf-8",
		timeout: 30_000,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || DB_URL },
	});
	return result;
}

/** Fire-and-forget — doesn't block the event loop */
function runTotalRecallAsync(args: string): void {
	const child = spawn("sh", ["-c", `totalrecall ${args}`], {
		stdio: "ignore",
		detached: true,
		env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || DB_URL },
	});
	child.unref();
}

function esc(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function formatAge(timestampMs: number): string {
	const diff = Date.now() - timestampMs;
	const hours = Math.floor(diff / 3600000);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

function typeEmoji(nodeType: string): string {
	const map: Record<string, string> = {
		decision: "⚖️", learning: "💡", entity: "🏷️",
		event: "📅", task: "✅", summary: "📝",
	};
	return map[nodeType] || "🧠";
}

/** Get repo name from a directory path */
function getRepoName(cwd: string): string {
	return path.basename(cwd);
}

// =============================================================================
// Extension
// =============================================================================

export default function totalrecallExtension(pi: ExtensionAPI) {

	// Check if totalrecall binary exists — skip everything if not
	if (!isTotalRecallAvailable()) {
		return;
	}

	// =========================================================================
	// Auto-context: graft recent memories + semantic refresh mid-session
	// =========================================================================

	let memoriesBlock: string | null = null;
	let turnCount = 0;
	let turnContent: string[] = [];

	/** Async fetch helper — resolves to formatted block or null */
	function asyncFetch(cmd: string): void {
		const child = spawn("sh", ["-c", cmd], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || DB_URL },
		});
		let out = "";
		child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
		child.on("close", () => {
			try {
				const data = JSON.parse(out);
				const nodes = data.nodes || data.results || [];
				if (nodes.length > 0) {
					const repo = getRepoName(process.cwd());
					const memories = nodes.map((n: any) =>
						`- [${n.node_type}] ${n.one_liner}`
					).join("\n");
					memoriesBlock = `\n\n<relevant_memories repo="${repo}">\n${memories}\n</relevant_memories>`;
				}
			} catch { /* silent */ }
		});
	}

	// Phase 1: fetch 10 most recent nodes at load (graft)
	asyncFetch(`totalrecall recent -o json -l 10`);

	pi.on("before_agent_start", async (event: any, _ctx: any) => {
		if (!memoriesBlock) return;
		const block = memoriesBlock;
		memoriesBlock = null;
		return { systemPrompt: event.systemPrompt + block };
	});

	// =========================================================================
	// Auto-capture: save compaction summaries as memory nodes
	// =========================================================================

	pi.on("session_compact", async (event: any, ctx: any) => {
		try {
			const entry = event.compactionEntry;
			if (!entry) return;

			const summary = typeof entry === "string"
				? entry
				: entry.summary || entry.content || JSON.stringify(entry);

			if (!summary || summary.length < 50) return;

			const repo = getRepoName(ctx.cwd);

			// Create a one-liner from first meaningful line
			const firstLine = summary.split("\n").find((l: string) => l.trim().length > 10)?.trim() || "Session compaction";
			const oneLiner = firstLine.slice(0, 120);

			// Truncate summary for the CLI arg (keep under shell limits)
			const truncatedSummary = summary.length > 2000
				? summary.slice(0, 2000) + "\n\n[truncated]"
				: summary;

			runTotalRecallAsync([
				`create -o json`,
				`-t summary`,
				`-1 ${esc(oneLiner)}`,
				`-s ${esc(truncatedSummary)}`,
				`--repo ${esc(repo)}`,
			].join(" "));
		} catch {
			// Silently fail — don't break compaction
		}
	});

	// =========================================================================
	// Auto-capture on shutdown: save last turn context if no compaction happened
	// =========================================================================

	let turnCount = 0;

	pi.on("turn_end", async (event: any, ctx: any) => {
		try {
			turnCount++;
			const msg = event.message;
			if (!msg || typeof msg !== "object" || !msg.content) return;

			const text = Array.isArray(msg.content)
				? msg.content.map((c: any) => c.text || "").join("\n")
				: typeof msg.content === "string" ? msg.content : "";

			if (text.length < 50) return;

			// Phase 2: after turn 3, do semantic refresh based on session content
			if (turnCount === 3 && turnContent.length > 0) {
				const query = turnContent.join(" ").slice(0, 200);
				asyncFetch(`totalrecall context -o json -t ${esc(query)} -n 10`);
			}
			turnContent.push(text.slice(0, 300));

			const repo = getRepoName(ctx.cwd);
			const firstLine = text.split("\n").find((l: string) => l.trim().length > 10)?.trim() || `Turn ${turnCount}`;
			const oneLiner = firstLine.slice(0, 120);
			const summary = text.length > 2000 ? text.slice(0, 2000) + "\n\n[truncated]" : text;

			runTotalRecallAsync([
				`create -o json`,
				`-t summary`,
				`-1 ${esc(oneLiner)}`,
				`-s ${esc(summary)}`,
				`--repo ${esc(repo)}`,
			].join(" "));
		} catch {
			// Silent — don't break the session
		}
	});

	// =========================================================================
	// recall — primary search with ranking
	// =========================================================================

	pi.registerTool({
		name: "recall",
		label: "TotalRecall Search",
		description:
			"Search TotalRecall semantic memory. Returns ranked synthesis nodes from the knowledge graph. " +
			"Use for recalling past decisions, learnings, patterns, entities, and events across all sessions.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query text" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10)", default: 10, minimum: 1, maximum: 50 })),
			nodeType: Type.Optional(StringEnum(["decision", "learning", "entity", "event", "task", "summary"], { description: "Filter by node type" })),
			minScore: Type.Optional(Type.Number({ description: "Minimum similarity score 0.0-1.0 (default: 0.0)", default: 0.0 })),
		}),

		async execute(_toolCallId, params: any, _signal) {
			try {
				const args = [`recall -o json -l ${params.limit || 10}`];
				if (params.minScore) args.push(`-m ${params.minScore}`);
				if (params.nodeType) args.push(`-t ${params.nodeType}`);
				args.push(esc(params.query));

				const raw = runTotalRecall(args.join(" "));
				const data: SearchResponse = JSON.parse(raw);

				const summaryLines = data.results.map((r) =>
					`${typeEmoji(r.node_type)} ${r.one_liner.slice(0, 90)}${r.one_liner.length > 90 ? "…" : ""}`
				);

				const fullText = data.results.map((r) =>
					`${typeEmoji(r.node_type)} [${(r.ranking_score ?? r.score).toFixed(2)}] ${r.one_liner}\n   ${r.node_id} | ${r.node_type}`
				).join("\n\n");

				return {
					content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
					details: {
						query: params.query,
						resultCount: data.total,
						exit: "ok",
						summaryLines,
						fullText,
					} satisfies RecallDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `TotalRecall error: ${message}` }],
					details: { query: params.query, resultCount: 0, exit: "error", error: message, summaryLines: [], fullText: "" } satisfies RecallDetails,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			const parts = [`🧠 recall`];
			if (args.nodeType) parts.push(`[${args.nodeType}]`);
			return new Text(
				`${theme.fg("toolTitle", theme.bold(parts.join(" ")))} ${theme.fg("muted", args.query ?? "")}`,
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const details = result.details as RecallDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error ?? "search failed"}`), 0, 0);
			}

			let text = theme.fg("success", "✓");
			text += ` ${details.resultCount} memories`;

			if (expanded && details.fullText) {
				text += "\n\n" + details.fullText;
			} else if (details.summaryLines?.length) {
				for (const line of details.summaryLines) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
				text += `\n  ${theme.fg("dim", `(${keyHint("expandTools", "to expand")})`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// =========================================================================
	// memory_unfold — progressive disclosure
	// =========================================================================

	pi.registerTool({
		name: "memory_unfold",
		label: "TotalRecall Unfold",
		description:
			"Unfold a TotalRecall memory node to see more detail. Use after recall/memory_context to drill into a specific node. " +
			"Depths: summary (brief), full (complete synthesis), raw (with source content).",
		parameters: Type.Object({
			nodeId: Type.String({ description: "Node ID (from recall results). Supports short prefixes like 'df415780' — will resolve to full UUID." }),
			depth: Type.Optional(StringEnum(["summary", "full", "raw"], { description: "Detail level (default: full)" })),
		}),

		async execute(_toolCallId, params: any, _signal) {
			try {
				const depth = params.depth || "full";
				const raw = runTotalRecall(`unfold -o json -d ${depth} ${esc(params.nodeId)}`);
				const data: UnfoldResponse = JSON.parse(raw);

				const age = formatAge(data.created_at);
				const header = `${typeEmoji(data.node_type)} ${data.one_liner}\n${data.node_type} | ${age} | ${data.edge_count} edges | ${data.access_count} accesses`;
				const body = data.full_synthesis || data.summary;
				const fullText = `${header}\n\n${body}`;

				return {
					content: [{ type: "text" as const, text: raw }],
					details: {
						nodeId: params.nodeId,
						depth,
						nodeType: data.node_type,
						exit: "ok",
						summaryLines: [header.split("\n")[0]],
						fullText,
					} satisfies UnfoldDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `TotalRecall error: ${message}` }],
					details: { nodeId: params.nodeId, depth: params.depth || "full", nodeType: "", exit: "error", error: message, summaryLines: [], fullText: "" } satisfies UnfoldDetails,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("🔍 unfold"))} ${theme.fg("muted", `${(args.nodeId ?? "").slice(0, 8)}… (${args.depth || "full"})`)}`,
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const details = result.details as UnfoldDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let text = theme.fg("success", "✓");
			text += ` ${details.nodeType}`;

			if (expanded && details.fullText) {
				text += "\n\n" + details.fullText;
			} else if (details.summaryLines?.length) {
				for (const line of details.summaryLines) {
					text += `\n  ${line}`;
				}
				text += `\n  ${theme.fg("dim", `(${keyHint("expandTools", "to expand")})`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// =========================================================================
	// memory_context — get context for current task
	// =========================================================================

	pi.registerTool({
		name: "memory_context",
		label: "TotalRecall Context",
		description:
			"Get relevant memories for a task or topic. Returns context-ranked nodes from the knowledge graph. " +
			"Use at the start of work to load relevant background, or when you need to understand prior decisions.",
		parameters: Type.Object({
			task: Type.String({ description: "Task or topic description" }),
			maxNodes: Type.Optional(Type.Number({ description: "Max nodes (default: 10)", default: 10 })),
		}),

		async execute(_toolCallId, params: any, _signal) {
			try {
				const raw = runTotalRecall(`context -o json -t ${esc(params.task)} -n ${params.maxNodes || 10}`);
				const data = JSON.parse(raw);
				const nodes = data.nodes || data.results || [];

				const summaryLines = nodes.map((r: any) =>
					`${typeEmoji(r.node_type)} ${(r.one_liner || r.node_id).slice(0, 90)}`
				);

				const fullText = nodes.map((r: any) =>
					`${typeEmoji(r.node_type)} [${(r.score || 0).toFixed(2)}] ${r.one_liner}\n   ${r.node_id} | ${r.node_type}`
				).join("\n\n");

				return {
					content: [{ type: "text" as const, text: raw }],
					details: {
						task: params.task,
						nodeCount: nodes.length,
						exit: "ok",
						summaryLines,
						fullText,
					} satisfies ContextDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `TotalRecall error: ${message}` }],
					details: { task: params.task, nodeCount: 0, exit: "error", error: message, summaryLines: [], fullText: "" } satisfies ContextDetails,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("🧠 context"))} ${theme.fg("muted", args.task ?? "")}`,
				0, 0,
			);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const details = result.details as ContextDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let text = theme.fg("success", "✓");
			text += ` ${details.nodeCount} memories`;

			if (expanded && details.fullText) {
				text += "\n\n" + details.fullText;
			} else if (details.summaryLines?.length) {
				for (const line of details.summaryLines) {
					text += `\n  ${theme.fg("dim", line)}`;
				}
				text += `\n  ${theme.fg("dim", `(${keyHint("expandTools", "to expand")})`)}`;
			}

			return new Text(text, 0, 0);
		},
	});

	// =========================================================================
	// memory_create — create a new synthesis node
	// =========================================================================

	pi.registerTool({
		name: "memory_create",
		label: "TotalRecall Create",
		description:
			"Create a new memory in TotalRecall's knowledge graph. Use to persist important decisions, learnings, " +
			"patterns, or events that should be remembered across sessions. Types: decision, learning, entity, event, task, summary.",
		parameters: Type.Object({
			nodeType: StringEnum(["decision", "learning", "entity", "event", "task", "summary"], { description: "Type of memory node" }),
			oneLiner: Type.String({ description: "Brief one-line summary" }),
			summary: Type.String({ description: "Medium summary (2-3 sentences)" }),
			fullSynthesis: Type.Optional(Type.String({ description: "Complete detailed content (defaults to summary)" })),
			entityName: Type.Optional(Type.String({ description: "Entity name (required for entity type)" })),
			sessionId: Type.Optional(Type.String({ description: "Session ID" })),
			repo: Type.Optional(Type.String({ description: "Source repository" })),
		}),

		async execute(_toolCallId, params: any, _signal) {
			try {
				const args = [
					`create -o json`,
					`-t ${params.nodeType}`,
					`-1 ${esc(params.oneLiner)}`,
					`-s ${esc(params.summary)}`,
				];
				if (params.fullSynthesis) args.push(`-f ${esc(params.fullSynthesis)}`);
				if (params.entityName) args.push(`-e ${esc(params.entityName)}`);
				if (params.sessionId) args.push(`--session-id ${esc(params.sessionId)}`);
				if (params.repo) args.push(`--repo ${esc(params.repo)}`);

				const raw = runTotalRecall(args.join(" "));
				const data = JSON.parse(raw);

				return {
					content: [{ type: "text" as const, text: raw }],
					details: {
						nodeId: data.node_id || data.id || "",
						nodeType: params.nodeType,
						oneLiner: params.oneLiner,
						exit: "ok",
					} satisfies CreateDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `TotalRecall error: ${message}` }],
					details: { nodeId: "", nodeType: params.nodeType, oneLiner: params.oneLiner, exit: "error", error: message } satisfies CreateDetails,
					isError: true,
				};
			}
		},

		renderCall(args: any, theme: any) {
			const emoji = typeEmoji(args.nodeType);
			return new Text(
				`${theme.fg("toolTitle", theme.bold(`${emoji} create ${args.nodeType}`))} ${theme.fg("muted", (args.oneLiner ?? "").slice(0, 60))}`,
				0, 0,
			);
		},

		renderResult(result: any, _options: any, theme: any) {
			const details = result.details as CreateDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			return new Text(
				`${theme.fg("success", "✓")} ${typeEmoji(details.nodeType)} ${details.oneLiner}\n  ${theme.fg("dim", details.nodeId.slice(0, 8) + "…")}`,
				0, 0,
			);
		},
	});

	// =========================================================================
	// memory_status — database status
	// =========================================================================

	pi.registerTool({
		name: "memory_status",
		label: "TotalRecall Status",
		description: "Get TotalRecall database status — node count and health.",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params: any, _signal) {
			try {
				const raw = runTotalRecall("status -o json");
				const data = JSON.parse(raw);
				return {
					content: [{ type: "text" as const, text: raw }],
					details: { nodeCount: data.node_count, exit: "ok" as const },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `TotalRecall error: ${message}` }],
					details: { nodeCount: 0, exit: "error" as const, error: message },
					isError: true,
				};
			}
		},

		renderCall(_args: any, theme: any) {
			return new Text(theme.fg("toolTitle", theme.bold("🧠 memory status")), 0, 0);
		},

		renderResult(result: any, { expanded }: any, theme: any) {
			const details = result.details as { nodeCount: number; exit: string; error?: string } | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let text = `${theme.fg("success", "✓")} 🧠 ${details.nodeCount} nodes in memory`;
			if (expanded) {
				try {
					const content = result.content?.[0]?.text;
					if (content) text += "\n\n" + content;
				} catch {}
			}
			return new Text(text, 0, 0);
		},
	});
}
