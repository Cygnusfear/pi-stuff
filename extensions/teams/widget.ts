import type { Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Component, TUI } from "@mariozechner/pi-tui";
import type { WorkerHandle, WorkerStatus } from "./types.js";

type WidgetColor = "warning" | "success" | "error" | "muted";

const STATUS_COLOR: Record<WorkerStatus, WidgetColor> = {
	spawning: "warning",
	running: "success",
	done: "success",
	failed: "error",
	killed: "muted",
};

const STATUS_ICON: Record<WorkerStatus, string> = {
	spawning: "◐",
	running: "●",
	done: "✓",
	failed: "✕",
	killed: "○",
};

function padRight(s: string, w: number): string {
	const n = Math.max(0, w - visibleWidth(s));
	return s + " ".repeat(n);
}

export function createTeamsWidget(getWorkers: () => WorkerHandle[]) {
	return (_tui: TUI, theme: Theme): Component => ({
		render(width: number): string[] {
			const workers = getWorkers();
			if (!workers.length) return [];

			const lines: string[] = [];
			lines.push(truncateToWidth(" " + theme.bold(theme.fg("accent", "Teams")), width));

			const nameW = Math.max(...workers.map((w) => visibleWidth(w.name)));
			const ticketW = Math.max(...workers.map((w) => visibleWidth(w.ticketId)));
			for (const w of workers) {
				const icon = theme.fg(STATUS_COLOR[w.status], STATUS_ICON[w.status]);
				const name = theme.bold(padRight(w.name, nameW));
				const status = theme.fg(STATUS_COLOR[w.status], padRight(w.status, 8));
				const ticketStatus = w.ticketStatus ?? "unknown";
				const row = ` ${icon} ${name} ${status} · ticket ${padRight(w.ticketId, ticketW)} · ${theme.fg("muted", ticketStatus)} · pid ${w.pid}`;
				lines.push(truncateToWidth(row, width));
				if (w.lastNote) {
					const note = w.lastNote.replace(/\s+/g, " ").trim();
					const noteRow = `   ${theme.fg("dim", "↳")} ${theme.fg("muted", note)}`;
					lines.push(truncateToWidth(noteRow, width));
				}
			}

			const pending = workers.filter((w) => w.status === "spawning" || w.status === "running").length;
			const done = workers.filter((w) => w.status === "done").length;
			const failed = workers.filter((w) => w.status === "failed").length;
			lines.push(truncateToWidth(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))), width));
			lines.push(
				truncateToWidth(
					` ${theme.bold("Total")} ${theme.fg("muted", `· ${pending} pending · ${done} done · ${failed} failed`)}`,
					width,
				),
			);
			lines.push(truncateToWidth(" " + theme.fg("dim", "/team list · /team kill <name> · /team kill_all"), width));

			return lines;
		},
		invalidate() {},
	});
}
