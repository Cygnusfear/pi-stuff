import { describe, expect, test } from "bun:test";
import { TeamLeader } from "../../extensions/teams/leader";

describe("teams stuck notifications", () => {
  test("stuck events do not trigger an automatic coordinator turn", () => {
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const fakePi = {
      sendMessage(message: unknown, options: unknown) {
        sent.push({ message, options });
      },
    } as any;

    const leader = new TeamLeader(fakePi);

    (leader as any).notifyLLM({
      type: "stuck",
      idleSeconds: 301,
      worker: {
        name: "oracle-2",
        pid: 4242,
        ticketId: "tg-198d",
        sessionDir: "/tmp/session",
        sessionFile: "/tmp/session/session.jsonl",
        worktreePath: null,
        status: "running",
        spawnedAt: Date.now() - 1000,
        lastActivityAt: Date.now() - 301000,
        lastProcessActivityAt: Date.now() - 301000,
        lastOutputAt: Date.now() - 301000,
        hasActiveChildProcess: false,
        activeChildProcessCount: 0,
        lastSeenCommentCount: 0,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({
      deliverAs: "followUp",
      triggerTurn: false,
    });
  });
});
