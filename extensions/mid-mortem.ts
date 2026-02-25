/**
 * Mid-mortem extension.
 *
 * Before compaction discards old context, fires off an ephemeral pi session
 * that reads the about-to-be-lost conversation and writes a mid-mortem ticket
 * capturing decisions, progress, open threads, and gotchas.
 *
 * Fully async — does not block compaction.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function serializeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (text.trim()) lines.push(`## User\n${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) lines.push(`## Assistant\n${text}`);
    } else if (msg.role === "toolResult") {
      const text = (msg as any).content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      if (text?.trim()) {
        const truncated =
          text.length > 500 ? text.slice(0, 500) + "\n[truncated]" : text;
        lines.push(`## Tool (${(msg as any).toolName})\n${truncated}`);
      }
    }
  }
  return lines.join("\n\n");
}

const MIDMORTEM_PROMPT = `You are writing a mid-mortem — a checkpoint document capturing the state of an ongoing session right before context compaction wipes the old messages.

You will receive a conversation transcript. Your job:

1. Read it carefully.
2. Create a tk ticket that captures the session state as a mid-mortem.

The ticket should contain:
- **What was being worked on** — the goal and current task
- **Decisions made** — any architectural, design, or implementation choices with rationale
- **Progress** — what's done, what's partially done
- **Open threads** — anything left hanging, unresolved questions, next steps
- **Gotchas & learnings** — bugs hit, surprising findings, things a future agent should know

Run this command to create the ticket:
tk create "Mid-mortem: <brief topic>" -d "<one-line summary>" -t task --tags mid-mortem,compaction -p 3

Then write the full mid-mortem content to the ticket file using the write tool.

Be concise but complete. This is for a future agent picking up the work.
After creating and writing the ticket, close it immediately (tk close <id>).
Then exit.`;

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const messages = event.preparation.messagesToSummarize;
      if (!messages || messages.length < 4) return;

      const transcript = serializeMessages(messages);
      if (transcript.length < 200) return;

      // Write transcript to a temp file so we don't blow shell arg limits
      const tmpDir = join(tmpdir(), "pi-mid-mortem");
      mkdirSync(tmpDir, { recursive: true });
      const tmpFile = join(tmpDir, `transcript-${Date.now()}.md`);
      writeFileSync(tmpFile, transcript, "utf-8");

      const prompt = [
        MIDMORTEM_PROMPT,
        "",
        "Here is the conversation transcript:",
        "",
        `<transcript file="${tmpFile}">`,
        "Read this file with the read tool to see the full transcript.",
        "</transcript>",
      ].join("\n");

      // Fire and forget — detached pi process
      const child = spawn(
        "pi",
        [
          "-p",
          "--no-session",
          "--no-tools",
          "--tools",
          "read,bash,write",
          prompt,
        ],
        {
          cwd: ctx.cwd,
          stdio: "ignore",
          detached: true,
        },
      );

      child.unref();
    } catch {
      // Never break compaction
    }
  });
}
