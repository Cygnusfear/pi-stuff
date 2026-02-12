import type { PollEvent, WorkerHandle } from "./types.js";
import type { TicketNote } from "./tickets.js";
import { getNewNotes } from "./tickets.js";
import { nextWorkerStatus } from "./state.js";
import { STUCK_THRESHOLD_MS } from "./types.js";

export interface PollInput {
	processAlive: boolean;
	ticketStatus: string;
	ticketNotes: TicketNote[];
	lastSeenCommentCount: number;
	sessionLastActivityAt: number;
}

export function computePollEvents(worker: WorkerHandle, input: PollInput): PollEvent[] {
	const events: PollEvent[] = [];

	const ticketClosed = input.ticketStatus === "closed" || input.ticketStatus === "done";
	const newStatus = nextWorkerStatus(worker.status, {
		processAlive: input.processAlive,
		ticketClosed,
	});

	if (newStatus === "done" && worker.status !== "done") {
		const lastNote = input.ticketNotes.at(-1);
		events.push({
			type: "completed",
			worker: { ...worker, status: newStatus },
			result: lastNote?.text ?? "(no result)",
		});
		return events;
	}

	if (newStatus === "failed" && worker.status !== "failed") {
		events.push({
			type: "failed",
			worker: { ...worker, status: newStatus },
			reason: input.processAlive ? "ticket failed" : "process died",
		});
		return events;
	}

	const newNotes = getNewNotes(input.ticketNotes, input.lastSeenCommentCount);
	for (const note of newNotes) {
		events.push({
			type: "comment",
			worker: { ...worker, status: newStatus },
			comment: note.text,
		});
	}

	const lastActivity = Math.max(input.sessionLastActivityAt, worker.lastActivityAt);
	if (Date.now() - lastActivity > STUCK_THRESHOLD_MS) {
		events.push({
			type: "stuck",
			worker: { ...worker, status: newStatus },
			idleSeconds: Math.floor((Date.now() - lastActivity) / 1000),
		});
	}

	return events;
}
