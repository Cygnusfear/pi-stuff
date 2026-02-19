import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundBashManager } from "../../extensions/background-bash";

async function waitForTerminalState(
  manager: BackgroundBashManager,
  id: string,
  timeoutMs = 6_000,
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const status = manager.getStatus(id);
    if (!status) return "missing";
    if (status.status !== "running") return status.status;
    await Bun.sleep(50);
  }

  throw new Error(`Timed out waiting for terminal status for job ${id}`);
}

describe("BackgroundBashManager", () => {
  test("starts a background command and captures logs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bg-test-"));
    const manager = new BackgroundBashManager();

    try {
      const started = await manager.start({
        command: "echo hello && sleep 0.1 && echo done",
        cwd: tempDir,
      });

      expect(started.id.length).toBeGreaterThan(0);
      expect(started.status).toBe("running");

      const finalState = await waitForTerminalState(manager, started.id);
      expect(["exited", "stopped"]).toContain(finalState);

      const logs = await manager.readLogs(started.id, { offset: 1, limit: 50 });
      expect(logs.text).toContain("hello");
      expect(logs.text).toContain("done");

      const status = manager.getStatus(started.id);
      expect(status?.exitCode).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("stops a long running command", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bg-test-"));
    const manager = new BackgroundBashManager();

    try {
      const started = await manager.start({
        command: "while true; do echo tick; sleep 0.2; done",
        cwd: tempDir,
      });

      await Bun.sleep(250);
      const stopped = await manager.stop(started.id);
      expect(stopped.status).toBe("running");

      const finalState = await waitForTerminalState(manager, started.id);
      expect(finalState).toBe("stopped");

      const logs = await manager.readLogs(started.id, { offset: 1, limit: 50 });
      expect(logs.text).toContain("tick");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("supports paged log reads", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bg-test-"));
    const manager = new BackgroundBashManager();

    try {
      const started = await manager.start({
        command: "printf 'a\\nb\\nc\\n'",
        cwd: tempDir,
      });

      await waitForTerminalState(manager, started.id);

      const firstPage = await manager.readLogs(started.id, { offset: 1, limit: 1 });
      expect(firstPage.text).toContain("a");
      expect(firstPage.nextOffset).toBe(2);

      const secondPage = await manager.readLogs(started.id, {
        offset: firstPage.nextOffset,
        limit: 2,
      });
      expect(secondPage.text).toContain("b");
      expect(secondPage.text).toContain("c");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
