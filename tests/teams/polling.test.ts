import { describe, test, expect } from "bun:test";
import { computePollEvents } from "../../extensions/teams/polling";
import type { WorkerHandle } from "../../extensions/teams/types";

const makeWorker = (overrides?: Partial<WorkerHandle>): WorkerHandle => ({
	name: "alice",
	pid: 1234,
	ticketId: "p-abc1",
	sessionDir: "/tmp/pi-teams-sessions/team-alice-p-abc1",
	sessionFile: "/tmp/session.jsonl",
	worktreePath: null,
	status: "running",
	spawnedAt: Date.now() - 10000,
	lastActivityAt: Date.now(),
	lastSeenCommentCount: 0,
	...overrides,
});

describe("computePollEvents", () => {
	test("ticket closed + alive → completed", () => {
		const events = computePollEvents(makeWorker(), {
			processAlive: true,
			ticketStatus: "closed",
			ticketNotes: [{ timestamp: "t", text: "done: result here" }],
			lastSeenCommentCount: 0,
			sessionLastActivityAt: Date.now(),
		});
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("completed");
		if (events[0].type === "completed") {
			expect(events[0].result).toBe("done: result here");
		}
	});

	test("process dead + ticket open → failed", () => {
		const events = computePollEvents(makeWorker(), {
			processAlive: false,
			ticketStatus: "open",
			ticketNotes: [],
			lastSeenCommentCount: 0,
			sessionLastActivityAt: Date.now(),
		});
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("failed");
		if (events[0].type === "failed") {
			expect(events[0].reason).toBe("process died");
		}
	});

	test("new comments → comment events", () => {
		const events = computePollEvents(makeWorker({ lastSeenCommentCount: 1 }), {
			processAlive: true,
			ticketStatus: "in_progress",
			ticketNotes: [
				{ timestamp: "t1", text: "old" },
				{ timestamp: "t2", text: "new comment" },
			],
			lastSeenCommentCount: 1,
			sessionLastActivityAt: Date.now(),
		});
		const comments = events.filter((e) => e.type === "comment");
		expect(comments).toHaveLength(1);
		if (comments[0].type === "comment") {
			expect(comments[0].comment).toBe("new comment");
		}
	});

	test("no activity for long time → stuck", () => {
		const longAgo = Date.now() - 10 * 60 * 1000;
		const events = computePollEvents(makeWorker({ lastActivityAt: longAgo }), {
			processAlive: true,
			ticketStatus: "in_progress",
			ticketNotes: [],
			lastSeenCommentCount: 0,
			sessionLastActivityAt: longAgo,
		});
		const stuck = events.filter((e) => e.type === "stuck");
		expect(stuck).toHaveLength(1);
		if (stuck[0].type === "stuck") {
			expect(stuck[0].idleSeconds).toBeGreaterThan(500);
		}
	});

	test("completed is terminal — no comment/stuck events", () => {
		const events = computePollEvents(makeWorker(), {
			processAlive: true,
			ticketStatus: "closed",
			ticketNotes: [
				{ timestamp: "t1", text: "progress" },
				{ timestamp: "t2", text: "done" },
			],
			lastSeenCommentCount: 0,
			sessionLastActivityAt: Date.now() - 10 * 60 * 1000,
		});
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("completed");
	});

	test("already done worker → no events", () => {
		const events = computePollEvents(makeWorker({ status: "done" }), {
			processAlive: false,
			ticketStatus: "closed",
			ticketNotes: [],
			lastSeenCommentCount: 0,
			sessionLastActivityAt: Date.now(),
		});
		expect(events).toHaveLength(0);
	});
});
