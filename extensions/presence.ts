/**
 * Presence Extension
 *
 * Drops a presence file in .pi/presence/ while a session is active.
 * Other pi agents see who's working in the repo and coordinate via tk.
 *
 * Presence file: .pi/presence/<session-short-id>.json
 * Contains: session ID, PID, worker name, cwd, last_seen (heartbeat).
 * Stale threshold: 5 minutes without heartbeat = considered dead.
 *
 * Also sets default tk assignee to pi(<short-id>) for agent-created tickets.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

interface PresenceEntry {
	session: string;
	shortId: string;
	pid: number;
	worker: string | null;
	cwd: string;
	started: string;
	last_seen: string;
	ticket: string | null;
}

function getPresenceDir(cwd: string): string {
	return path.join(cwd, ".pi", "presence");
}

function getShortId(sessionId: string): string {
	return sessionId.slice(0, 8);
}

function isAlive(entry: PresenceEntry): boolean {
	const lastSeen = new Date(entry.last_seen).getTime();
	if (Date.now() - lastSeen > STALE_THRESHOLD_MS) return false;
	// Also check PID
	try {
		process.kill(entry.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPresence(presenceDir: string): PresenceEntry[] {
	if (!fs.existsSync(presenceDir)) return [];
	const entries: PresenceEntry[] = [];
	for (const file of fs.readdirSync(presenceDir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const content = fs.readFileSync(path.join(presenceDir, file), "utf-8");
			entries.push(JSON.parse(content));
		} catch {
			// corrupt file, skip
		}
	}
	return entries;
}

function cleanStale(presenceDir: string): void {
	if (!fs.existsSync(presenceDir)) return;
	for (const file of fs.readdirSync(presenceDir)) {
		if (!file.endsWith(".json")) continue;
		try {
			const content = fs.readFileSync(path.join(presenceDir, file), "utf-8");
			const entry: PresenceEntry = JSON.parse(content);
			if (!isAlive(entry)) {
				fs.unlinkSync(path.join(presenceDir, file));
			}
		} catch {
			// corrupt — remove
			try { fs.unlinkSync(path.join(presenceDir, file)); } catch {}
		}
	}
}

export default function (pi: ExtensionAPI) {
	let presenceFile: string | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let sessionShortId: string | null = null;

	function writePresence(cwd: string, sessionId: string, worker: string | null) {
		const presenceDir = getPresenceDir(cwd);
		const shortId = getShortId(sessionId);
		sessionShortId = shortId;

		fs.mkdirSync(presenceDir, { recursive: true });

		// Ensure .pi/presence/ is in repo root .gitignore
		const gitignorePath = path.join(cwd, ".gitignore");
		try {
			const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
			if (!existing.includes(".pi/presence")) {
				fs.appendFileSync(gitignorePath, (existing.endsWith("\n") || !existing ? "" : "\n") + ".pi/presence/\n", "utf-8");
			}
		} catch {}

		const entry: PresenceEntry = {
			session: sessionId,
			shortId,
			pid: process.pid,
			worker,
			cwd,
			started: new Date().toISOString(),
			last_seen: new Date().toISOString(),
			ticket: null,
		};

		presenceFile = path.join(presenceDir, `${shortId}.json`);
		fs.writeFileSync(presenceFile, JSON.stringify(entry, null, 2), "utf-8");
	}

	function updateHeartbeat() {
		if (!presenceFile || !fs.existsSync(presenceFile)) return;
		try {
			const content = fs.readFileSync(presenceFile, "utf-8");
			const entry: PresenceEntry = JSON.parse(content);
			entry.last_seen = new Date().toISOString();
			fs.writeFileSync(presenceFile, JSON.stringify(entry, null, 2), "utf-8");
		} catch {
			// file gone or corrupt, stop trying
		}
	}

	function removePresence() {
		if (presenceFile) {
			try { fs.unlinkSync(presenceFile); } catch {}
			presenceFile = null;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	// ── Lifecycle ──

	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId?.() ?? `anon-${process.pid}`;
		const worker = process.env.PI_TEAMS_WORKER_NAME ?? null;

		// Clean stale entries first
		cleanStale(getPresenceDir(ctx.cwd));

		// Write our presence
		writePresence(ctx.cwd, sessionId, worker);

		// Start heartbeat
		heartbeatTimer = setInterval(updateHeartbeat, HEARTBEAT_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		removePresence();
	});

	// Also clean up on process exit (SIGTERM, etc.)
	process.on("exit", () => {
		if (presenceFile) {
			try { fs.unlinkSync(presenceFile); } catch {}
		}
	});

	// ── Inject presence into system prompt ──

	pi.on("before_agent_start", async (event, ctx) => {
		const presenceDir = getPresenceDir(ctx.cwd);
		cleanStale(presenceDir);
		const others = readPresence(presenceDir).filter(
			(e) => e.pid !== process.pid && isAlive(e),
		);

		if (others.length === 0) return;

		const lines = others.map((e) => {
			const name = e.worker ? `worker "${e.worker}"` : `session ${e.shortId}`;
			const ticket = e.ticket ? ` working on ${e.ticket}` : "";
			return `- pi(${e.shortId}): ${name}${ticket} in ${e.cwd}`;
		});

		const notice = [
			"",
			"## Active agents in this repo",
			"The following pi sessions are currently active:",
			...lines,
			"",
			"Coordinate with them using `tk` tickets. Do not modify files they are working on without checking first.",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + notice,
		};
	});

	// ── Update presence with current ticket ──

	pi.on("tool_result", async (event) => {
		if (!presenceFile) return;
		if (event.toolName !== "todos" && event.toolName !== "todos_oneshot") return;

		// Try to extract ticket ID from tool input
		const args: string = (event.input as any)?.args ?? "";
		const ticketMatch = args.match(/\b(start|show)\s+([\w-]+)/);
		if (ticketMatch) {
			try {
				const content = fs.readFileSync(presenceFile, "utf-8");
				const entry: PresenceEntry = JSON.parse(content);
				entry.ticket = ticketMatch[2];
				entry.last_seen = new Date().toISOString();
				fs.writeFileSync(presenceFile, JSON.stringify(entry, null, 2), "utf-8");
			} catch {}
		}
	});

	// ── Default tk assignee ──

	pi.on("tool_call", async (event) => {
		if (!sessionShortId) return;
		if (event.toolName !== "todos") return;

		const args: string = (event.input as any)?.args ?? "";
		// If creating a ticket without explicit assignee, add default
		if (/^\s*create\b/.test(args) && !/-a\b|--assignee\b/.test(args)) {
			(event.input as any).args = `${args} -a "pi(${sessionShortId})"`;
		}
	});
}
