import { describe, expect, test } from "bun:test";
import {
  deriveWorkerProcessSnapshot,
  evaluateIdleState,
  formatRuntimeSummary,
  parseElapsedSeconds,
  parseProcessTable,
} from "../../extensions/teams/activity";

describe("parseElapsedSeconds", () => {
  test("parses mm:ss", () => {
    expect(parseElapsedSeconds("09:30")).toBe(570);
  });

  test("parses hh:mm:ss", () => {
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
  });

  test("parses dd-hh:mm:ss", () => {
    expect(parseElapsedSeconds("2-01:02:03")).toBe(176523);
  });
});

describe("deriveWorkerProcessSnapshot", () => {
  test("marks worker busy when active non-zombie child processes exist", () => {
    const rows = parseProcessTable([
      "100 1 0.0 00:11:00 S pi",
      "200 100 175.4 00:10:59 R rustc",
      "201 100 1.2 00:10:59 S cargo",
      "202 200 45.0 00:01:30 R cc",
      "203 100 0.0 00:00:05 Z rustc",
    ].join("\n"));

    const snapshot = deriveWorkerProcessSnapshot(rows, 100);

    expect(snapshot.rootAlive).toBe(true);
    expect(snapshot.hasActiveChildProcess).toBe(true);
    expect(snapshot.activeChildProcessCount).toBe(3);
    expect(snapshot.currentCommand).toBe("rustc");
    expect(snapshot.currentCommandElapsedSeconds).toBe(659);
    expect(snapshot.maxChildCpuPercent).toBe(175.4);
  });

  test("marks worker idle when only root process is present", () => {
    const rows = parseProcessTable("100 1 0.0 00:05:00 S pi");
    const snapshot = deriveWorkerProcessSnapshot(rows, 100);

    expect(snapshot.rootAlive).toBe(true);
    expect(snapshot.hasActiveChildProcess).toBe(false);
    expect(snapshot.activeChildProcessCount).toBe(0);
    expect(snapshot.currentCommand).toBeUndefined();
  });
});

describe("evaluateIdleState", () => {
  test("requires missing heartbeat and missing process activity", () => {
    const now = 1_000_000;
    const thresholdMs = 300_000;

    expect(
      evaluateIdleState({
        now,
        thresholdMs,
        hasActiveChildProcess: false,
        lastHeartbeatAt: now - thresholdMs - 1,
        lastProcessActivityAt: now - thresholdMs - 1,
      }).shouldWarnStuck,
    ).toBe(true);

    expect(
      evaluateIdleState({
        now,
        thresholdMs,
        hasActiveChildProcess: true,
        lastHeartbeatAt: now - thresholdMs - 1,
        lastProcessActivityAt: now - thresholdMs - 1,
      }).shouldWarnStuck,
    ).toBe(false);

    expect(
      evaluateIdleState({
        now,
        thresholdMs,
        hasActiveChildProcess: false,
        lastHeartbeatAt: now - 1_000,
        lastProcessActivityAt: now - thresholdMs - 1,
      }).shouldWarnStuck,
    ).toBe(false);
  });
});

describe("formatRuntimeSummary", () => {
  test("shows busy command and last output age", () => {
    const now = 1_000_000;
    const summary = formatRuntimeSummary(
      {
        hasActiveChildProcess: true,
        activeChildProcessCount: 2,
        currentCommand: "rustc",
        currentCommandElapsedSeconds: 620,
        lastOutputAt: now - 12_000,
      },
      now,
    );

    expect(summary).toContain("busy");
    expect(summary).toContain("rustc");
    expect(summary).toContain("10m");
    expect(summary).toContain("last output 12s ago");
  });
});
