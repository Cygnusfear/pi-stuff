import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { setupGetCurrentTimeTool } from "../tools/get-current-time";

export function setupTools(pi: ExtensionAPI): void {
	// Disabled here because this package already overrides `read` in extensions/core-read-ui.ts.
	// Registering another `read` tool would conflict and prevent extension load.
	setupGetCurrentTimeTool(pi);
}
