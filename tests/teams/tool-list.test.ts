import { describe, expect, test } from "bun:test";
import { runTeamsAction } from "../../extensions/teams/tool";

describe("teams tool list output", () => {
  test("includes runtime activity context", async () => {
    const fakeLeader = {
      setContext() {},
      getWorkers() {
        return [
          {
            name: "worker-1",
            pid: 123,
            ticketId: "p-1234",
            status: "running",
            hasActiveChildProcess: true,
            activeChildProcessCount: 2,
            currentCommand: "rustc",
            currentCommandElapsedSeconds: 620,
            lastOutputAt: Date.now() - 12_000,
            lastActivityAt: Date.now() - 12_000,
            lastProcessActivityAt: Date.now() - 1_000,
            sessionDir: "/tmp/s",
            sessionFile: "/tmp/s/session.jsonl",
            worktreePath: null,
            spawnedAt: Date.now() - 100_000,
            lastSeenCommentCount: 0,
            ticketStatus: "in_progress",
          },
        ];
      },
    } as any;

    const fakePi = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as any;

    const fakeCtx = {
      cwd: "/tmp",
      modelRegistry: { getAvailable: () => [] },
    } as any;

    const result = await runTeamsAction(fakePi, fakeLeader, { action: "list" }, fakeCtx);
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("activity:");
    expect(text).toContain("busy");
    expect(text).toContain("rustc");
    expect(text).toContain("last output");
  });
});
