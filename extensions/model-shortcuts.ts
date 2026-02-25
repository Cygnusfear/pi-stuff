import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * /opus, /sonnet, /codex - quick model switching.
 *
 * Walks a candidate list newest-first so the commands
 * stay correct as new model versions land in pi-ai.
 */

interface ModelShortcut {
  command: string;
  provider: string;
  candidates: string[];
  label: string;
}

const SHORTCUTS: ModelShortcut[] = [
  {
    command: "opus",
    provider: "anthropic",
    candidates: [
      "claude-opus-4-6",
      "claude-opus-4-5",
      "claude-opus-4-1",
      "claude-opus-4-0",
    ],
    label: "Opus",
  },
  {
    command: "sonnet",
    provider: "anthropic",
    candidates: [
      "claude-sonnet-4-5",
      "claude-sonnet-4-0",
      "claude-3-7-sonnet-latest",
    ],
    label: "Sonnet",
  },
  {
    command: "codex",
    provider: "openai-codex",
    candidates: [
      "gpt-5.3-codex",
      "gpt-5.2-codex",
      "gpt-5.1-codex",
    ],
    label: "Codex",
  },
];

function resolveFirst(
  registry: { find(provider: string, modelId: string): any },
  provider: string,
  candidates: string[],
) {
  for (const id of candidates) {
    const model = registry.find(provider, id);
    if (model) return model;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  for (const shortcut of SHORTCUTS) {
    pi.registerCommand(shortcut.command, {
      description: `Switch to latest ${shortcut.label} (${shortcut.provider})`,
      handler: async (_args, ctx) => {
        const model = resolveFirst(
          ctx.modelRegistry,
          shortcut.provider,
          shortcut.candidates,
        );

        if (!model) {
          ctx.ui.notify(
            `No ${shortcut.label} model found for ${shortcut.provider}`,
            "error",
          );
          return;
        }

        const ok = await pi.setModel(model);
        if (ok) {
          ctx.ui.notify(`Switched to ${shortcut.provider}/${model.id}`, "info");
        } else {
          ctx.ui.notify(`No API key for ${shortcut.provider}/${model.id}`, "warning");
        }
      },
    });
  }
}
