import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import defaultPromptExtension from "../extensions/default-prompt";

type BeforeStartHandler = (event: any, ctx: any) => Promise<any> | any;

const GLOBAL_PROMPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prompts/default.md",
);

function stripFrontmatter(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) return trimmed;
  return trimmed.slice(match[0].length).trim();
}

function setupExtension() {
  let handler: BeforeStartHandler | null = null;

  const pi = {
    on(eventName: string, fn: BeforeStartHandler) {
      if (eventName === "before_agent_start") {
        handler = fn;
      }
    },
  };

  defaultPromptExtension(pi as any);

  if (!handler) {
    throw new Error("default-prompt extension did not register before_agent_start handler");
  }

  return handler;
}

describe("default-prompt extension", () => {
  test("always injects the bundled global prompt", async () => {
    const handler = setupExtension();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-global-prompt-"));

    try {
      await mkdir(path.join(tempDir, ".git"));

      const result = await handler({ systemPrompt: "BASE" }, { cwd: tempDir });
      const globalPrompt = stripFrontmatter(await readFile(GLOBAL_PROMPT_PATH, "utf8"));

      expect(result?.systemPrompt).toContain("BASE");
      expect(result?.systemPrompt).toContain(globalPrompt);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("additively injects repo-local .prompts/default.md from git root", async () => {
    const handler = setupExtension();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-local-prompt-"));

    try {
      await mkdir(path.join(tempDir, ".git"));
      await mkdir(path.join(tempDir, ".prompts"));
      await mkdir(path.join(tempDir, "apps", "demo"), { recursive: true });

      await writeFile(
        path.join(tempDir, ".prompts", "default.md"),
        [
          "---",
          "description: local overlay",
          "---",
          "",
          "LOCAL_PROMPT_SENTINEL",
        ].join("\n"),
        "utf8",
      );

      const result = await handler(
        { systemPrompt: "BASE" },
        { cwd: path.join(tempDir, "apps", "demo") },
      );

      const merged = result?.systemPrompt ?? "";
      const globalPrompt = stripFrontmatter(await readFile(GLOBAL_PROMPT_PATH, "utf8"));

      expect(merged).toContain("BASE");
      expect(merged).toContain(globalPrompt);
      expect(merged).toContain("LOCAL_PROMPT_SENTINEL");
      expect(merged.indexOf(globalPrompt)).toBeLessThan(merged.indexOf("LOCAL_PROMPT_SENTINEL"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
