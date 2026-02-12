import { describe, test, expect } from "bun:test";
import { nextWorkerStatus } from "../../extensions/teams/state";

describe("nextWorkerStatus", () => {
	test("running + ticket closed → done", () => {
		expect(nextWorkerStatus("running", { processAlive: true, ticketClosed: true })).toBe("done");
	});

	test("running + process dead + ticket open → failed", () => {
		expect(nextWorkerStatus("running", { processAlive: false, ticketClosed: false })).toBe("failed");
	});

	test("running + process alive + ticket open → running", () => {
		expect(nextWorkerStatus("running", { processAlive: true, ticketClosed: false })).toBe("running");
	});

	test("spawning + process alive → running", () => {
		expect(nextWorkerStatus("spawning", { processAlive: true, ticketClosed: false })).toBe("running");
	});

	test("spawning + process dead → failed", () => {
		expect(nextWorkerStatus("spawning", { processAlive: false, ticketClosed: false })).toBe("failed");
	});

	test("done stays done", () => {
		expect(nextWorkerStatus("done", { processAlive: false, ticketClosed: true })).toBe("done");
	});

	test("failed stays failed", () => {
		expect(nextWorkerStatus("failed", { processAlive: false, ticketClosed: false })).toBe("failed");
	});

	test("killed stays killed", () => {
		expect(nextWorkerStatus("killed", { processAlive: false, ticketClosed: false })).toBe("killed");
	});
});
