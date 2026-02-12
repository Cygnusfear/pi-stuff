import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands";
import { generateAndSetTitle } from "./lib/title";

export function setupCommands(pi: ExtensionAPI) {
  registerCommands(pi);

  pi.registerCommand("ad-name", {
    description: "Set or generate session name",
    handler: async (args, ctx) => {
      const input = args.trim();

      // /ad-name auto -- force regenerate
      if (input === "auto" || !input) {
        const currentName = pi.getSessionName();

        // /ad-name (no args) with existing name -- just display it
        if (!input && currentName) {
          ctx.ui.notify(
            `Session: ${currentName} (use /ad-name <text> to change)`,
            "info",
          );
          return;
        }

        // Auto-generate (either explicit "auto" or no args + no name)
        await generateAndSetTitle(pi, ctx);
        return;
      }

      // /ad-name <text> -- set manually
      pi.setSessionName(input);
      ctx.ui.notify(`Session: ${input}`, "info");
    },
  });
}
