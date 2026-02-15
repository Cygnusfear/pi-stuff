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
