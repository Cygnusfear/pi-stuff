import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BackgroundBashManager, runBashToolAction } from "../../extensions/background-bash";

describe("runBashToolAction", () => {
  test("runs foreground commands through pi.exec", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const fakePi = {
      exec: async (command: string, args: string[], options: unknown) => {
        calls.push({ command, args, options });
        return { stdout: "hello\n", stderr: "", code: 0, killed: false };
      },
    } as any;

    const manager = new BackgroundBashManager();
    const result = await runBashToolAction(
      fakePi,
      manager,
      { command: "echo hello" },
      undefined,
      { cwd: "/tmp" } as any,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("sh");
    expect(calls[0]?.args).toEqual(["-c", "echo hello"]);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("hello");
    expect(result.isError).toBeUndefined();
  });

  test("supports single-tool background lifecycle", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-bg-tool-"));
    const fakePi = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } as any;

    const manager = new BackgroundBashManager();

    try {
      const started = await runBashToolAction(
        fakePi,
        manager,
        { command: "echo from-bg", background: true },
        undefined,
        { cwd: tempDir } as any,
      );

      const id = (started.details as { id: string } | undefined)?.id;
      expect(id).toBeTruthy();

      await Bun.sleep(120);

      const status = await runBashToolAction(
        fakePi,
        manager,
        { action: "status", id },
        undefined,
        { cwd: tempDir } as any,
      );
      expect(status.content[0]?.text).toContain(String(id));

      const logs = await runBashToolAction(
        fakePi,
        manager,
        { action: "logs", id, offset: 1, limit: 20 },
        undefined,
        { cwd: tempDir } as any,
      );
      expect(logs.content[0]?.text).toContain("from-bg");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns error for job action without id", async () => {
    const fakePi = {
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    } as any;

    const manager = new BackgroundBashManager();
    const result = await runBashToolAction(
      fakePi,
      manager,
      { action: "status" },
      undefined,
      { cwd: "/tmp" } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("requires id");
  });
});
