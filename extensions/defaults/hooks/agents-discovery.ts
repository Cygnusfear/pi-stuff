/**
 * Agents Discovery Hook
 *
 * Auto-discovers AGENTS.md files in subdirectories when the agent reads files.
 * Pi's built-in discovery only walks up from cwd. This hook fills the gap by
 * injecting AGENTS.md files found between cwd and the directory of the file
 * being read.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentsDiscoveryManager } from "../lib/agents-discovery";

type TextContent = { type: "text"; text: string };

export function setupAgentsDiscoveryHook(
  pi: ExtensionAPI,
  manager: AgentsDiscoveryManager,
) {
  const handleSessionChange = (_event: unknown, ctx: ExtensionContext) => {
    manager.resetSession(ctx.cwd);
  };

  pi.on("session_start", handleSessionChange);
  pi.on("session_switch", handleSessionChange);

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return undefined;

    const pathInput = event.input.path as string | undefined;
    if (!pathInput) return undefined;

    if (!manager.isInitialized) manager.resetSession(ctx.cwd);

    let discovered: Awaited<ReturnType<typeof manager.discover>>;
    try {
      discovered = await manager.discover(pathInput);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Failed to load subdirectory context: ${String(error)}`,
          "warning",
        );
      }
      return undefined;
    }

    if (!discovered) return undefined;

    const prettyPaths = discovered.map((f) => manager.prettyPath(f.path));

    const additions: TextContent[] = discovered.map((file, i) => ({
      type: "text",
      text: `Loaded subdirectory context from ${prettyPaths[i]}\n\n${file.content}`,
    }));

    // Notify UI without adding to agent context (appendEntry doesn't go to LLM)
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Loaded subdirectory context: ${prettyPaths.join(", ")}`,
        "info",
      );
    }

    const baseContent = event.content ?? [];
    return { content: [...baseContent, ...additions], details: event.details };
  });
}
