import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TurndownService from "turndown";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT_MS = 30 * 1000; // 30 seconds
const MAX_TIMEOUT_MS = 120 * 1000; // 2 minutes

const WebFetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch content from" }),
	format: StringEnum(["text", "markdown", "html"] as const, {
		description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
		default: "markdown",
	}),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds (max 120)." })),
});

type WebFetchParamsType = Static<typeof WebFetchParams>;

type WebFetchDetails = {
	url: string;
	format: "text" | "markdown" | "html";
	contentType?: string;
	exit: "ok" | "error";
	error?: string;
	truncated?: boolean;
	fullOutputPath?: string;
};

const createAcceptHeader = (format: WebFetchDetails["format"]): string => {
	switch (format) {
		case "markdown":
			return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
		case "text":
			return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
		case "html":
			return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1";
		default:
			return "*/*";
	}
};

const createHeaders = (format: WebFetchDetails["format"]) => ({
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
	Accept: createAcceptHeader(format),
	"Accept-Language": "en-US,en;q=0.9",
	"Accept-Encoding": "identity",
});

const stripHtml = (html: string): string => {
	const withoutBlocks = html
		.replace(/<\s*(script|style|noscript|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\1\s*>/gi, " ")
		.replace(/<\s*(script|style|noscript|iframe|object|embed)[^>]*\/\s*>/gi, " ");
	const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
	return withoutTags.replace(/\s+/g, " ").trim();
};

const convertHTMLToMarkdown = (html: string): string => {
	const turndownService = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	turndownService.remove(["script", "style", "meta", "link", "noscript"]);
	return turndownService.turndown(html);
};

const applyTruncation = async (content: string): Promise<{ text: string; details: Partial<WebFetchDetails> }> => {
	const truncation = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return { text: truncation.content, details: { truncated: false } };
	}

	const tempFile = path.join(os.tmpdir(), `pi-webfetch-${Date.now()}.log`);
	await fs.writeFile(tempFile, content, "utf8");
	const summary = `\n\n[output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;

	return {
		text: truncation.content + summary,
		details: { truncated: true, fullOutputPath: tempFile },
	};
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "webfetch",
		label: "WebFetch",
		description: "Fetch a URL and return content as text, markdown, or html (max 5MB).",
		parameters: WebFetchParams,

		async execute(_toolCallId, params: WebFetchParamsType, signal) {
			if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
				return {
					content: [{ type: "text", text: "Error: URL must start with http:// or https://" }],
					details: {
						url: params.url,
						format: params.format ?? "markdown",
						exit: "error",
						error: "invalid url",
					} satisfies WebFetchDetails,
					isError: true,
				};
			}

			const format = params.format ?? "markdown";
			const timeoutMs = Math.min((params.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS);

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

			const abortListener = () => controller.abort();
			signal?.addEventListener("abort", abortListener);

			try {
				const headers = createHeaders(format);
				const initial = await fetch(params.url, { signal: controller.signal, headers });
				const response =
					initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge"
						? await fetch(params.url, {
							signal: controller.signal,
							headers: { ...headers, "User-Agent": "pi-webfetch" },
						})
						: initial;

				if (!response.ok) {
					return {
						content: [{ type: "text", text: `Error: Request failed with status ${response.status}` }],
						details: {
							url: params.url,
							format,
							exit: "error",
							error: `status ${response.status}`,
						} satisfies WebFetchDetails,
						isError: true,
					};
				}

				const contentLength = response.headers.get("content-length");
				if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
					return {
						content: [{ type: "text", text: "Error: Response too large (exceeds 5MB limit)" }],
						details: {
							url: params.url,
							format,
							exit: "error",
							error: "response too large",
						} satisfies WebFetchDetails,
						isError: true,
					};
				}

				const arrayBuffer = await response.arrayBuffer();
				if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
					return {
						content: [{ type: "text", text: "Error: Response too large (exceeds 5MB limit)" }],
						details: {
							url: params.url,
							format,
							exit: "error",
							error: "response too large",
						} satisfies WebFetchDetails,
						isError: true,
					};
				}

				const content = new TextDecoder().decode(arrayBuffer);
				const contentType = response.headers.get("content-type") || "";

				const isMarkdown = contentType.includes("text/markdown") || contentType.includes("text/x-markdown");
				const isHtml = contentType.includes("text/html");
				const markdownTokens = response.headers.get("x-markdown-tokens");

				let output = content;
				if (format === "markdown") {
					output = isMarkdown ? content : isHtml ? convertHTMLToMarkdown(content) : content;
				} else if (format === "text") {
					output = isHtml ? stripHtml(content) : content;
				}

				const truncated = await applyTruncation(output);
				return {
					content: [{ type: "text", text: truncated.text }],
					details: {
						url: params.url,
						format,
						contentType,
						exit: "ok",
						...truncated.details,
					} satisfies WebFetchDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					details: {
						url: params.url,
						format: params.format ?? "markdown",
						exit: "error",
						error: message,
					} satisfies WebFetchDetails,
					isError: true,
				};
			} finally {
				clearTimeout(timeoutId);
				signal?.removeEventListener("abort", abortListener);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("webfetch ")) + theme.fg("muted", args.url);
			text += ` ${theme.fg("dim", `(${args.format ?? "markdown"})`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as WebFetchDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.exit === "error") {
				return new Text(theme.fg("error", `Error: ${details.error ?? "request failed"}`), 0, 0);
			}
			let text = theme.fg("success", "✓ fetched");
			if (details.contentType) text += ` ${theme.fg("dim", details.contentType)}`;
			if (details.truncated) text += ` ${theme.fg("warning", "(truncated)")}`;
			return new Text(text, 0, 0);
		},
	});
}
