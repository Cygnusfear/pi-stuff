import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const TASK_DESCRIPTION = `Run a focused sub-task in an isolated subagent and return its result.

Use this when you want to delegate investigation or drafting to a separate agent instance without polluting the main conversation.

Guidelines:
- Give the subagent a narrow goal and clear deliverable.
- Prefer returning concise, actionable output (bullets, JSON, or patch plan).
- The subagent runs without access to your main conversation state.`;

const TaskParams = Type.Object({
	prompt: Type.String({ description: "The sub-task instructions for the subagent." }),
	role: Type.Optional(
		Type.Union([
			Type.Literal("research"),
			Type.Literal("plan"),
			Type.Literal("implement"),
			Type.Literal("review"),
			Type.Literal("debug"),
			Type.String(),
		]),
	),
	// Future: add model selection, tool allowlist, file/context injection.
});

type TaskParamsType = Static<typeof TaskParams>;

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "task",
		label: "Task (Subagent)",
		description: TASK_DESCRIPTION,
		parameters: TaskParams,
		async execute(_toolCallId, params: TaskParamsType) {
			// In-memory, isolated session.
			const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });

			let output = "";
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					output += event.assistantMessageEvent.delta;
				}
			});

			try {
				const header = params.role ? `Role: ${params.role}\n\n` : "";
				await session.prompt(
					`${header}${params.prompt}\n\nReturn only the result. Be concise and action-oriented.`,
				);
			} finally {
				unsubscribe();
				session.dispose();
			}

			return {
				content: [{ type: "text", text: output.trim() || "(no output)" }],
				details: { role: params.role ?? null },
			};
		},
	});
}
