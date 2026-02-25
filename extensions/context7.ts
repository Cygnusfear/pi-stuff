/**
 * Context7 - Up-to-date library documentation for any prompt.
 *
 * Calls the Context7 MCP server (https://mcp.context7.com/mcp) directly
 * over HTTP to fetch current docs and code examples for any library.
 *
 * Two tools:
 *   context7_resolve  - find the Context7 library ID for a package name
 *   context7_docs     - fetch documentation for a resolved library ID
 *
 * Set CONTEXT7_API_KEY env var for higher rate limits (free at context7.com/dashboard).
 */

import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ENDPOINT = "https://mcp.context7.com/mcp";

async function callContext7(toolName: string, args: Record<string, string>, signal?: AbortSignal): Promise<string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};

	const apiKey = process.env.CONTEXT7_API_KEY;
	if (apiKey) {
		headers["CONTEXT7_API_KEY"] = apiKey;
	}

	const body = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: { name: toolName, arguments: args },
	});

	const res = await fetch(ENDPOINT, { method: "POST", headers, body, signal });

	if (!res.ok) {
		throw new Error(`Context7 returned ${res.status}: ${await res.text()}`);
	}

	const json = (await res.json()) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };

	if (json.error) {
		throw new Error(`Context7 error: ${json.error.message ?? JSON.stringify(json.error)}`);
	}

	const text = json.result?.content?.map((c) => c.text).join("\n") ?? "";
	return text;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "context7_resolve",
		label: "Context7 Resolve",
		description:
			"Resolves a library/package name to a Context7 library ID. " +
			"Call this before context7_docs to get the right ID, unless the user already gave one (like /vercel/next.js). " +
			"Returns matching libraries ranked by relevance.",
		parameters: Type.Object({
			query: Type.String({ description: "What you need the library for (used to rank results by relevance)" }),
			libraryName: Type.String({ description: "Library or package name to search for" }),
		}),

		async execute(_toolCallId, params, signal) {
			const { query, libraryName } = params as { query: string; libraryName: string };

			try {
				const text = await callContext7("resolve-library-id", { query, libraryName }, signal);
				return {
					content: [{ type: "text", text: text || "No libraries found." }],
					details: { query, libraryName },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error resolving library: ${msg}` }],
					details: { error: msg },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "context7_docs",
		label: "Context7 Docs",
		description:
			"Fetches up-to-date documentation and code examples for a library from Context7. " +
			"Requires a Context7 library ID (e.g. /mongodb/docs, /vercel/next.js) - use context7_resolve first if you don't have one.",
		parameters: Type.Object({
			libraryId: Type.String({
				description: "Context7 library ID (e.g. /vercel/next.js, /mongodb/docs). Get this from context7_resolve.",
			}),
			query: Type.String({ description: "Specific question or topic to get documentation for" }),
		}),

		async execute(_toolCallId, params, signal) {
			const { libraryId, query } = params as { libraryId: string; query: string };

			try {
				const text = await callContext7("query-docs", { libraryId, query }, signal);
				return {
					content: [{ type: "text", text: text || "No documentation found." }],
					details: { libraryId, query },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error fetching docs: ${msg}` }],
					details: { error: msg },
					isError: true,
				};
			}
		},
	});
}
