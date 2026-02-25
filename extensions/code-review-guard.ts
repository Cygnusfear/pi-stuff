/**
 * Code review guard.
 *
 * Appends prompts/codehealth.md to the output of every code-reading
 * tool result. Sits right after the code the LLM just saw.
 */

import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CODE_READ_TOOLS = new Set([
  "read",
  "hash_read",
  "grep",
  "find",
  "ls",
  "execute_code",
]);

export default function (pi: ExtensionAPI) {
  // Load once at init, relative to this extension's package root
  const promptPath = join(dirname(__dirname), "prompts", "codehealth.md");
  const guard = "\n---\n" + readFileSync(promptPath, "utf-8").trim();

  pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | void => {
    if (event.isError) return;
    if (!CODE_READ_TOOLS.has(event.toolName)) return;

    const last = event.content[event.content.length - 1];
    if (!last || last.type !== "text") return;

    return {
      content: [
        ...event.content.slice(0, -1),
        { type: "text" as const, text: last.text + guard },
      ],
    };
  });
}
