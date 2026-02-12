import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { generateAndSetTitle } from "../lib/title";

interface SessionNameState {
  hasAutoNamed: boolean;
}

export function setupSessionNameHook(pi: ExtensionAPI) {
  const state: SessionNameState = {
    hasAutoNamed: false,
  };

  pi.on("session_start", async () => {
    state.hasAutoNamed = false;
  });

  pi.on("session_switch", async () => {
    state.hasAutoNamed = false;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (state.hasAutoNamed) return;

    if (pi.getSessionName()) {
      state.hasAutoNamed = true;
      return;
    }

    await generateAndSetTitle(pi, ctx);
    state.hasAutoNamed = true;
  });
}
