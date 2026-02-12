import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

export type Timing = {
	startedAt: number;
	endedAt: number;
	durationMs: number;
};

const UI_COLLAPSE_MAX_LINES = 40;

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatClock = (ts: number): string => {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(2)}s`;
	const m = Math.floor(s / 60);
	const rem = s - m * 60;
	return `${m}m${rem.toFixed(0)}s`;
};

const textFromToolContent = (content: any): string => {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && c.type === "text" ? String(c.text ?? "") : ""))
		.filter(Boolean)
		.join("")
		.trimEnd();
};

export const renderToolResult = (result: any, expanded: boolean, theme: any): Text => {
	const hint = keyHint("expandTools", "ctrl+o to expand");
	const timing: Timing | undefined = result?.details?.timing;

	const header = timing
		? theme.fg(
				"dim",
				`${formatClock(timing.startedAt)} → ${formatClock(timing.endedAt)} (${formatDuration(timing.durationMs)})`,
			)
		: "";

	const full = textFromToolContent(result?.content);
	let body = full;

	if (!expanded) {
		const lines = full.split(/\r?\n/);
		if (lines.length > UI_COLLAPSE_MAX_LINES) {
			const shown = lines.slice(0, UI_COLLAPSE_MAX_LINES).join("\n");
			const remaining = lines.length - UI_COLLAPSE_MAX_LINES;
			const footer = theme.fg("dim", `... (${remaining} more lines, ${hint})`);
			body = `${shown}\n${footer}`;
		}
	}

	const out = [header, body].filter(Boolean).join("\n");
	return new Text(out, 0, 0);
};

export const attachTiming = <TDetails extends Record<string, any>>(
	details: TDetails | undefined,
	timing: Timing,
): TDetails & { timing: Timing } => {
	return {
		...(details ?? ({} as any)),
		timing,
	};
};
