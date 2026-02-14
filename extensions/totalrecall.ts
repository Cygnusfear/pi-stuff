/**
 * TotalRecall extension for pi
 *
 * Semantic memory for AI agents — search, recall, create, and unfold
 * synthesis nodes from TotalRecall's knowledge graph.
 *
 * Requires: totalrecall binary in PATH (cargo install from totalrecall-rs)
 * Requires: PostgreSQL with pgvector running (docker compose up -d postgres)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, keyHint } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { execSync } from "node:child_process";

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

interface CreateResponse {
	node_id: string;
	one_liner: string;
	node_type: string;
}

// =============================================================================
// Helpers
// =============================================================================

function runTotalRecall(args: string): string {
	try {
		const result = execSync(`totalrecall ${args}`, {
			encoding: "utf-8",
			timeout: 30_000,
			env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL || "postgresql://totalrecall:totalrecall_dev@localhost:5432/totalrecall" },
		});
		return result;
	} catch (err: any) {
		if (err.stderr) {
			throw new Error(`totalrecall error: ${err.stderr.trim()}`);
		}
		throw err;
	}
}

function escapeShell(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function formatAge(timestampMs: number): string {
	const diff = Date.now() - timestampMs;
	const hours = Math.floor(diff / 3600000);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return `${months}mo ago`;
}

function typeEmoji(nodeType: string): string {
	const map: Record<string, string> = {
		decision: "⚖️",
		learning: "💡",
		entity: "🏷️",
		event: "📅",
		task: "✅",
		summary: "📝",
	};
	return map[nodeType] || "🧠";
}

// =============================================================================
// Extension
// =============================================================================

export default function totalrecallExtension(api: ExtensionAPI) {

	// =========================================================================
	// recall — primary search with ranking
	// =========================================================================

	api.addTool({
		name: "recall",
		description:
			"Search TotalRecall semantic memory. Returns ranked synthesis nodes from the knowledge graph. " +
			"Use for recalling past decisions, learnings, patterns, entities, and events across all sessions.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query text" }),
			limit: Type.Optional(Type.Number({ description: "Max results (default: 10)", default: 10, minimum: 1, maximum: 50 })),
			nodeType: Type.Optional(StringEnum(["decision", "learning", "entity", "event", "task", "summary"], { description: "Filter by node type" })),
			minScore: Type.Optional(Type.Number({ description: "Minimum similarity score 0.0-1.0 (default: 0.0)", default: 0.0 })),
		}),
		execute: async (params) => {
			const args = [`recall -o json -l ${params.limit || 10}`];
			if (params.minScore) args.push(`-m ${params.minScore}`);
			if (params.nodeType) args.push(`-t ${params.nodeType}`);
			args.push(escapeShell(params.query));

			const raw = runTotalRecall(args.join(" "));
			const data: SearchResponse = JSON.parse(raw);
			return JSON.stringify(data, null, 2);
		},
		renderCall: (params) => {
			const parts = [`🧠 recall: "${params.query}"`];
			if (params.nodeType) parts.push(`type=${params.nodeType}`);
			if (params.limit && params.limit !== 10) parts.push(`limit=${params.limit}`);
			return Text(parts.join(" "));
		},
		renderResult: (params, result, expanded) => {
			try {
				const data: SearchResponse = JSON.parse(result);
				if (data.results.length === 0) {
					return Text("No memories found.");
				}

				const lines = data.results.map((r, i) =>
					`${typeEmoji(r.node_type)} [${r.ranking_score?.toFixed(2) || r.score.toFixed(2)}] ${r.one_liner}\n   ${r.node_id.slice(0, 8)}… | ${r.node_type}`
				);

				if (expanded) {
					return Text(`Found ${data.total} memories:\n\n${lines.join("\n\n")}`);
				}

				// Compact: just one-liners
				const compact = data.results.map((r) =>
					`${typeEmoji(r.node_type)} ${r.one_liner.slice(0, 90)}${r.one_liner.length > 90 ? "…" : ""}`
				);
				return Text(`${data.total} memories ${keyHint()}\n${compact.join("\n")}`);
			} catch {
				return Text(result);
			}
		},
	});

	// =========================================================================
	// memory_unfold — progressive disclosure
	// =========================================================================

	api.addTool({
		name: "memory_unfold",
		description:
			"Unfold a TotalRecall memory node to see more detail. Use after recall/memory_context to drill into a specific node. " +
			"Depths: summary (brief), full (complete synthesis), raw (with source content).",
		parameters: Type.Object({
			nodeId: Type.String({ description: "Node ID (from recall results)" }),
			depth: Type.Optional(StringEnum(["summary", "full", "raw"], { description: "Detail level (default: full)", default: "full" })),
		}),
		execute: async (params) => {
			const depth = params.depth || "full";
			const raw = runTotalRecall(`unfold -o json -d ${depth} ${escapeShell(params.nodeId)}`);
			return raw;
		},
		renderCall: (params) => {
			return Text(`🔍 unfold ${params.nodeId.slice(0, 8)}… (${params.depth || "full"})`);
		},
		renderResult: (params, result, expanded) => {
			try {
				const data: UnfoldResponse = JSON.parse(result);
				const age = formatAge(data.created_at);
				const header = `${typeEmoji(data.node_type)} ${data.one_liner}\n${data.node_type} | ${age} | ${data.edge_count} edges | ${data.access_count} accesses`;

				if (expanded) {
					const body = data.full_synthesis || data.summary;
					return Text(`${header}\n\n${body}`);
				}

				return Text(`${header}\n\n${data.summary.slice(0, 200)}${data.summary.length > 200 ? "…" : ""} ${keyHint()}`);
			} catch {
				return Text(result);
			}
		},
	});

	// =========================================================================
	// memory_context — get context for current task
	// =========================================================================

	api.addTool({
		name: "memory_context",
		description:
			"Get relevant memories for a task or topic. Returns context-ranked nodes from the knowledge graph. " +
			"Use at the start of work to load relevant background, or when you need to understand prior decisions.",
		parameters: Type.Object({
			task: Type.String({ description: "Task or topic description" }),
			maxNodes: Type.Optional(Type.Number({ description: "Max nodes (default: 10)", default: 10 })),
			xml: Type.Optional(Type.Boolean({ description: "Return as XML context block (default: false)", default: false })),
		}),
		execute: async (params) => {
			const args = [`context -o json -t ${escapeShell(params.task)} -n ${params.maxNodes || 10}`];
			if (params.xml) {
				// XML mode returns human-readable XML block
				const xmlArgs = `context --xml -t ${escapeShell(params.task)} -n ${params.maxNodes || 10}`;
				return runTotalRecall(xmlArgs);
			}
			const raw = runTotalRecall(args.join(" "));
			return raw;
		},
		renderCall: (params) => {
			return Text(`🧠 context: "${params.task}" (max ${params.maxNodes || 10})`);
		},
		renderResult: (params, result, expanded) => {
			if (params.xml) {
				if (expanded) return Text(result);
				const lines = result.split("\n").slice(0, 8);
				return Text(`${lines.join("\n")}${result.split("\n").length > 8 ? "\n…" : ""} ${keyHint()}`);
			}
			try {
				const data = JSON.parse(result);
				const nodes = data.nodes || data.results || [];
				if (nodes.length === 0) return Text("No relevant memories found.");

				const compact = nodes.map((r: any) =>
					`${typeEmoji(r.node_type)} ${r.one_liner?.slice(0, 90) || r.node_id}`
				);
				if (expanded) {
					const detailed = nodes.map((r: any) =>
						`${typeEmoji(r.node_type)} [${(r.score || 0).toFixed(2)}] ${r.one_liner}\n   ${r.node_id.slice(0, 8)}… | ${r.node_type}`
					);
					return Text(`${nodes.length} context nodes:\n\n${detailed.join("\n\n")}`);
				}
				return Text(`${nodes.length} memories ${keyHint()}\n${compact.join("\n")}`);
			} catch {
				return Text(result);
			}
		},
	});

	// =========================================================================
	// memory_create — create a new synthesis node
	// =========================================================================

	api.addTool({
		name: "memory_create",
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
		execute: async (params) => {
			const args = [
				`create -o json`,
				`-t ${params.nodeType}`,
				`-1 ${escapeShell(params.oneLiner)}`,
				`-s ${escapeShell(params.summary)}`,
			];
			if (params.fullSynthesis) args.push(`-f ${escapeShell(params.fullSynthesis)}`);
			if (params.entityName) args.push(`-e ${escapeShell(params.entityName)}`);
			if (params.sessionId) args.push(`--session-id ${escapeShell(params.sessionId)}`);
			if (params.repo) args.push(`--repo ${escapeShell(params.repo)}`);

			const raw = runTotalRecall(args.join(" "));
			return raw;
		},
		renderCall: (params) => {
			return Text(`${typeEmoji(params.nodeType)} create ${params.nodeType}: "${params.oneLiner.slice(0, 60)}…"`);
		},
		renderResult: (params, result, expanded) => {
			try {
				const data = JSON.parse(result);
				const id = data.node_id || data.id || "unknown";
				return Text(`${typeEmoji(params.nodeType)} Created: ${params.oneLiner}\n   ${id.slice(0, 8)}… | ${params.nodeType}`);
			} catch {
				return Text(result);
			}
		},
	});

	// =========================================================================
	// memory_status — database status
	// =========================================================================

	api.addTool({
		name: "memory_status",
		description: "Get TotalRecall database status — node count, types, and health.",
		parameters: Type.Object({}),
		execute: async () => {
			return runTotalRecall("status -o json");
		},
		renderCall: () => Text("🧠 memory status"),
		renderResult: (_params, result, expanded) => {
			try {
				const data = JSON.parse(result);
				const line = `🧠 ${data.node_count || "?"} nodes in memory`;
				if (expanded) return Text(`${line}\n\n${JSON.stringify(data, null, 2)}`);
				return Text(`${line} ${keyHint()}`);
			} catch {
				return Text(result);
			}
		},
	});
}
