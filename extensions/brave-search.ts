/**
 * Brave Search extension for pi
 *
 * Uses Brave's LLM Context API for high-quality, relevance-ranked search results
 * optimized for LLM consumption. Falls back to Web Search API when needed.
 *
 * Setup: export BRAVE_API_KEY="your-key" in your shell profile.
 * Pricing: $5/1k requests, $5 free credit/month.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, keyHint } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// =============================================================================
// Types
// =============================================================================

interface BraveSource {
	title: string;
	hostname: string;
	age?: string[];
}

interface BraveGenericResult {
	url: string;
	title: string;
	snippets: string[];
}

interface BraveLLMContextResponse {
	grounding: {
		generic: BraveGenericResult[];
		map?: unknown[];
	};
	sources: Record<string, BraveSource>;
}

interface BraveWebResult {
	title: string;
	url: string;
	description?: string;
	age?: string;
}

interface BraveWebSearchResponse {
	web?: { results: BraveWebResult[] };
	query?: { original: string };
}

interface BraveSearchDetails {
	query: string;
	endpoint: string;
	resultCount: number;
	sourceCount: number;
	exit: string;
	error?: string;
	truncated?: boolean;
	fullOutputPath?: string;
	/** Compact lines for collapsed view: "Title — url (age)" */
	summaryLines?: string[];
	/** Full formatted text for expanded view */
	fullText?: string;
}

// =============================================================================
// Parameters
// =============================================================================

const webSearchParams = Type.Object({
	query: Type.String({ description: "Search query." }),
	numResults: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, default: 5, description: "Number of results (1-20, default 5)." }),
	),
	type: Type.Optional(
		StringEnum(["llm_context", "web"], {
			description:
				"Search type: 'llm_context' (default) returns relevance-ranked smart chunks optimized for LLMs. 'web' returns standard search results.",
			default: "llm_context",
		}),
	),
	maxTokens: Type.Optional(
		Type.Integer({
			minimum: 500,
			maximum: 16000,
			description: "Token budget for LLM Context results (default: ~4000). Controls response size.",
		}),
	),
});

type WebSearchParams = Static<typeof webSearchParams>;

const codeSearchParams = Type.Object({
	query: Type.String({ description: "Code/documentation search query." }),
	numResults: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, default: 5, description: "Number of results (1-10, default 5)." }),
	),
});

type CodeSearchParams = Static<typeof codeSearchParams>;

// =============================================================================
// API helpers
// =============================================================================

const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 15_000;

function getApiKey(): string | undefined {
	if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
	try {
		const configPath = path.join(path.dirname(new URL(import.meta.url).pathname), "brave-search.config.json");
		const config = JSON.parse(require("fs").readFileSync(configPath, "utf8"));
		return config.apiKey || undefined;
	} catch {
		return undefined;
	}
}

async function braveRequest<T>(url: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
	const apiKey = getApiKey();
	if (!apiKey) throw new Error("BRAVE_API_KEY not set. Get one at https://api-dashboard.search.brave.com/");

	const qs = new URLSearchParams(params).toString();
	const fullUrl = `${url}?${qs}`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort);

	try {
		const r = await fetch(fullUrl, {
			headers: {
				Accept: "application/json",
				"Accept-Encoding": "identity",
				"X-Subscription-Token": apiKey,
			},
			signal: controller.signal,
		});

		if (!r.ok) {
			const text = await r.text();
			throw new Error(`Brave API ${r.status}: ${text.slice(0, 200)}`);
		}

		return (await r.json()) as T;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

// =============================================================================
// Formatting
// =============================================================================

function formatLLMContext(data: BraveLLMContextResponse): {
	text: string;
	resultCount: number;
	sourceCount: number;
	summaryLines: string[];
} {
	const results = data.grounding?.generic ?? [];
	const sources = data.sources ?? {};

	if (results.length === 0) {
		return { text: "No results found.", resultCount: 0, sourceCount: 0, summaryLines: [] };
	}

	const parts: string[] = [];
	const summaryLines: string[] = [];

	for (const result of results) {
		const source = sources[result.url];
		const age = source?.age?.[2] ?? "";
		const header = `### ${result.title}`;
		const meta = `**Source:** ${result.url}${age ? ` (${age})` : ""}`;

		// Take the top snippets — they're already relevance-ranked
		const snippets = result.snippets.slice(0, 3).join("\n\n");

		parts.push(`${header}\n${meta}\n\n${snippets}`);
		summaryLines.push(`${result.title} — ${result.url}${age ? ` (${age})` : ""}`);
	}

	return {
		text: parts.join("\n\n---\n\n"),
		resultCount: results.length,
		sourceCount: Object.keys(sources).length,
		summaryLines,
	};
}

function formatWebResults(data: BraveWebSearchResponse): {
	text: string;
	resultCount: number;
	summaryLines: string[];
} {
	const results = data.web?.results ?? [];

	if (results.length === 0) {
		return { text: "No results found.", resultCount: 0, summaryLines: [] };
	}

	const parts: string[] = [];
	const summaryLines: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const desc = (r.description ?? "").replace(/<\/?strong>/g, "**");
		const age = r.age ? ` (${r.age})` : "";
		parts.push(`**${i + 1}. [${r.title}](${r.url})**${age}\n${desc}`);
		summaryLines.push(`${r.title} — ${r.url}${age}`);
	}

	return { text: parts.join("\n\n"), resultCount: results.length, summaryLines };
}

async function applyTruncation(
	content: string,
): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
	const truncation = truncateHead(content, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

	if (!truncation.truncated) {
		return { text: truncation.content, truncated: false };
	}

	const tempFile = path.join(os.tmpdir(), `pi-brave-search-${Date.now()}.log`);
	await fs.writeFile(tempFile, content, "utf8");
	const summary = `\n\n[output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;

	return { text: truncation.content + summary, truncated: true, fullOutputPath: tempFile };
}

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	// web_search_brave — primary search tool using LLM Context API
	pi.registerTool({
		name: "web_search_brave",
		label: "Brave Search",
		description:
			"Web search via Brave's LLM Context API. Returns relevance-ranked smart chunks optimized for LLMs. Best for up-to-date info, research, and general questions.",
		parameters: webSearchParams,

		async execute(_toolCallId, params: WebSearchParams, signal) {
			const query = params.query;
			const searchType = params.type ?? "llm_context";
			const count = String(params.numResults ?? 5);

			try {
				if (searchType === "llm_context") {
					const apiParams: Record<string, string> = { q: query, count };
					if (params.maxTokens) apiParams.maximum_number_of_tokens = String(params.maxTokens);

					const data = await braveRequest<BraveLLMContextResponse>(BRAVE_LLM_CONTEXT_URL, apiParams, signal);
					const { text, resultCount, sourceCount, summaryLines } = formatLLMContext(data);
					const truncated = await applyTruncation(text);

					return {
						content: [{ type: "text", text: truncated.text }],
						details: {
							query,
							endpoint: "llm_context",
							resultCount,
							sourceCount,
							exit: "ok",
							truncated: truncated.truncated,
							fullOutputPath: truncated.fullOutputPath,
							summaryLines,
							fullText: truncated.text,
						},
					};
				}
				// web search fallback
				const data = await braveRequest<BraveWebSearchResponse>(BRAVE_WEB_SEARCH_URL, { q: query, count }, signal);
				const { text, resultCount, summaryLines } = formatWebResults(data);
				const truncated = await applyTruncation(text);

				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						query,
						endpoint: "web_search",
						resultCount,
						sourceCount: resultCount,
						exit: "ok",
						truncated: truncated.truncated,
						fullOutputPath: truncated.fullOutputPath,
						summaryLines,
						fullText: truncated.text,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Brave Search error: ${message}` }],
					details: {
						query,
						endpoint: searchType as "llm_context" | "web_search",
						resultCount: 0,
						sourceCount: 0,
						exit: "error",
						error: message,
					},
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			const type = args.type ?? "llm_context";
			const label = type === "llm_context" ? "🔍 brave search" : "🌐 brave web";
			return new Text(
				`${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("muted", args.query ?? "")}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as BraveSearchDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error ?? "request failed"}`), 0, 0);
			}

			let text = theme.fg("success", "✓");
			text += ` ${details.resultCount} results from ${details.sourceCount} sources`;
			text += theme.fg("dim", ` (${details.endpoint})`);
			if (details.truncated) text += ` ${theme.fg("warning", "(truncated)")}`;

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

	// code_search_brave — code-focused search
	pi.registerTool({
		name: "code_search_brave",
		label: "Brave Code Search",
		description:
			"Search for code examples, API docs, and technical documentation via Brave. Optimized for programming questions.",
		parameters: codeSearchParams,

		async execute(_toolCallId, params: CodeSearchParams, signal) {
			const query = params.query;
			const count = String(params.numResults ?? 5);

			try {
				const data = await braveRequest<BraveLLMContextResponse>(
					BRAVE_LLM_CONTEXT_URL,
					{ q: query, count },
					signal,
				);
				const { text, resultCount, sourceCount, summaryLines } = formatLLMContext(data);
				const truncated = await applyTruncation(text);

				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						query,
						endpoint: "llm_context",
						resultCount,
						sourceCount,
						exit: "ok",
						truncated: truncated.truncated,
						fullOutputPath: truncated.fullOutputPath,
						summaryLines,
						fullText: truncated.text,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Brave Search error: ${message}` }],
					details: {
						query,
						endpoint: "llm_context",
						resultCount: 0,
						sourceCount: 0,
						exit: "error",
						error: message,
					},
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("💻 brave code"))} ${theme.fg("muted", args.query ?? "")}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as BraveSearchDetails | undefined;
			if (!details) return new Text("", 0, 0);

			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error ?? "request failed"}`), 0, 0);
			}

			let text = theme.fg("success", "✓");
			text += ` ${details.resultCount} results from ${details.sourceCount} sources`;
			if (details.truncated) text += ` ${theme.fg("warning", "(truncated)")}`;

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
}
