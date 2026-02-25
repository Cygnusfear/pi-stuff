import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatRuntimeSummary } from "./activity.js";
import type { TeamLeader } from "./leader.js";

const TeamsParams = Type.Object({
  action: Type.Optional(
    Type.Union([
      Type.Literal("delegate"),
      Type.Literal("list"),
      Type.Literal("kill"),
      Type.Literal("kill_all"),
    ]),
  ),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "Task description" }),
        assignee: Type.Optional(Type.String({ description: "Worker name" })),
        model: Type.Optional(
          Type.String({
            description: "Model for this worker (see recommendations from `prompts/default.md`)",
          }),
        ),
        hasTools: Type.Optional(
          Type.Boolean({
            description: "Give worker access to teams tool for sub-delegation (default: false)",
            default: false,
          }),
        ),
      }),
    ),
  ),
  name: Type.Optional(Type.String({ description: "Worker name for kill action" })),
  useWorktree: Type.Optional(
    Type.Boolean({ description: "Give each worker its own git worktree", default: true }),
  ),
});

type TeamsActionParams = {
  action?: "delegate" | "list" | "kill" | "kill_all";
  tasks?: Array<{ text: string; assignee?: string; model?: string; hasTools?: boolean }>;
  name?: string;
  useWorktree?: boolean;
};



async function runTeamsAction(
  pi: ExtensionAPI,
  leader: TeamLeader,
  params: TeamsActionParams,
  ctx: ExtensionContext,
) {
  leader.setContext(ctx);
  const action = params.action ?? "delegate";

  if (action === "list") {
    const workers = leader.getWorkers();
    if (workers.length === 0) {
      return { content: [{ type: "text" as const, text: "No active workers." }] };
    }
    const lines = workers.map((w) => {
      const modelSuffix = w.model ? ` | model ${w.model}` : "";
      const parts = [`${w.name}: ${w.status} | ticket #${w.ticketId} | pid ${w.pid}${modelSuffix}`];
      parts.push(
        `  activity: ${formatRuntimeSummary({
          hasActiveChildProcess: w.hasActiveChildProcess,
          activeChildProcessCount: w.activeChildProcessCount,
          currentCommand: w.currentCommand,
          currentCommandElapsedSeconds: w.currentCommandElapsedSeconds,
          lastOutputAt: w.lastOutputAt,
        })}`,
      );
      if (w.lastNote) parts.push(`  last note: ${w.lastNote.slice(0, 120)}`);
      return parts.join("\n");
    });
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  if (action === "kill") {
    if (!params.name)
      return { content: [{ type: "text" as const, text: "Provide worker name." }], isError: true };
    await leader.kill(params.name);
    return { content: [{ type: "text" as const, text: `Killed worker "${params.name}"` }] };
  }

  if (action === "kill_all") {
    await leader.killAll();
    return { content: [{ type: "text" as const, text: "All workers killed." }] };
  }

  if (action === "delegate") {
    if (!params.tasks?.length) {
      return { content: [{ type: "text" as const, text: "Provide tasks array." }], isError: true };
    }

    const useWorktree = params.useWorktree ?? true;
    const results: string[] = [];
    let workerIdx = 0;

    for (const task of params.tasks) {
      const workerName = task.assignee ?? `worker-${++workerIdx}`;

      const createResult = await pi.exec(
        "tk",
        ["create", task.text, "-d", task.text, "--tags", "team", "-a", workerName],
        { cwd: ctx.cwd, timeout: 5000 },
      );

      const ticketId = (createResult.stdout ?? "").trim().split(/\s+/)[0];
      if (!ticketId || createResult.code !== 0) {
        results.push(`Failed to create ticket for "${task.text}": ${createResult.stderr}`);
        continue;
      }

      await pi.exec("tk", ["start", ticketId], { cwd: ctx.cwd, timeout: 5000 });

      try {
        const handle = await leader.delegate(ticketId, workerName, useWorktree, task.model, task.hasTools);
        const modelInfo = task.model ? ` [${task.model}]` : "";
        const toolsInfo = task.hasTools ? " [has-tools]" : "";
        results.push(
          `Spawned "${workerName}" → ticket #${ticketId} (pid ${handle.pid})${modelInfo}${toolsInfo}`,
        );
      } catch (err) {
        results.push(`Failed to spawn "${workerName}": ${err}`);
      }
    }

    leader.startPolling();
    return { content: [{ type: "text" as const, text: results.join("\n") }] };
  }

  return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
}

export function registerTeamsTool(pi: ExtensionAPI, leader: TeamLeader) {
  pi.registerTool({
    name: "teams",
    label: "Teams",
    description: `Coordinate a team of worker agents.

Actions:
- delegate: Create tickets and spawn workers. Provide "tasks" array with { text, assignee?, model?, hasTools? }.
  Each worker can use a different model via "provider/model-id" (use examples from ${"`"}prompts/default.md${"`"}).
  Set hasTools: true to give a worker the teams tool so it can delegate sub-workers.
- list: Show all active workers and their status.
- kill: Kill a specific worker by name.
- kill_all: Kill all workers.

IMPORTANT: After delegating, do NOT poll or loop-call "list" to check on workers.
You will be automatically notified via [team-event] messages when workers post progress, complete, or fail.
Just continue with other work or wait for the user. Only use "list" if the user explicitly asks for worker status.`,
    parameters: TeamsParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return runTeamsAction(pi, leader, params, ctx);
    },
  });
}

export { runTeamsAction };
