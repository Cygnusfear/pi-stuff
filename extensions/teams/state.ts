import type { WorkerStatus } from "./types.js";

export interface StatusInput {
	processAlive: boolean;
	ticketClosed: boolean;
}

const TERMINAL: WorkerStatus[] = ["done", "failed", "killed"];

export function nextWorkerStatus(current: WorkerStatus, input: StatusInput): WorkerStatus {
	if (TERMINAL.includes(current)) return current;
	if (input.ticketClosed) return "done";
	if (!input.processAlive) return "failed";
	if (current === "spawning") return "running";
	return "running";
}
