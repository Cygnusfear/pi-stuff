import { afterEach, describe, expect, test } from "bun:test";
import { runWorker } from "../../extensions/teams/worker";

type Handler = (event: unknown, ctx: { cwd: string }) => Promise<unknown> | unknown;

const envSnapshot = {
  ticketId: process.env.PI_TEAMS_TICKET_ID,
  workerName: process.env.PI_TEAMS_WORKER_NAME,
};

afterEach(() => {
  process.env.PI_TEAMS_TICKET_ID = envSnapshot.ticketId;
  process.env.PI_TEAMS_WORKER_NAME = envSnapshot.workerName;
});

describe("teams worker heartbeat wiring", () => {
  test("registers lifecycle hooks and emits heartbeat entries", async () => {
    process.env.PI_TEAMS_TICKET_ID = "p-1234";
    process.env.PI_TEAMS_WORKER_NAME = "oracle-2";

    const handlers = new Map<string, Handler>();
    const appended: Array<{ customType: string; data: unknown }> = [];

    const fakePi = {
      registerTool() {},
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      appendEntry(customType: string, data: unknown) {
        appended.push({ customType, data });
      },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as any;

    runWorker(fakePi);

    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("tool_call")).toBe(true);

    const turnStart = handlers.get("turn_start");
    const toolCall = handlers.get("tool_call");

    expect(turnStart).toBeDefined();
    expect(toolCall).toBeDefined();

    await turnStart?.({}, { cwd: "/tmp" });
    await toolCall?.({ toolName: "bash" }, { cwd: "/tmp" });
    await handlers.get("session_shutdown")?.({}, { cwd: "/tmp" });

    const heartbeatTypes = appended.map((entry) => entry.customType);
    expect(heartbeatTypes).toContain("teams-worker-heartbeat");
  });
});
