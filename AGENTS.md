# AGENTS.md

Quick operator notes for agents working in this repo 🐲

## Memory (TotalRecall)

You have persistent semantic memory across sessions via TotalRecall tools. **Use them.**

- **Start of session**: Use `memory_context` to load relevant background for your current task
- **After decisions**: Use `memory_create` (type: `decision`) to record architectural choices and rationale
- **After learnings**: Use `memory_create` (type: `learning`) to record debugging insights, gotchas, patterns
- **When stuck**: Use `recall` to search for prior work, decisions, or context on the topic
- **Key entities**: Use `memory_create` (type: `entity`) for important people, systems, or concepts

Don't over-capture — dreaming consolidation handles deduplication, but be intentional about recording things a future agent session would benefit from knowing.

### Subscriptions (pub/sub)

You can **subscribe** to nodes, entities, or topics — and get notified when new related memories appear. This is how multi-agent collaboration works without explicit coordination.

- `memory_subscribe({ entity: "TotalRecall" })` — watch an entity across sessions
- `memory_subscribe({ topic: "embedding pipeline" })` — watch a semantic topic
- `memory_subscribe({ nodeId: "abc123..." })` — watch a specific decision node
- `memory_check_updates()` — manually poll for unread notifications

Updates auto-inject into the conversation every 30s via background polling. When a notification arrives, you'll see a `[memory-update]` message — act on it (unfold, respond, relay).

**Subscribe** when starting deep work on a shared topic. **Don't subscribe** to vague/broad things — you'll get noise.
