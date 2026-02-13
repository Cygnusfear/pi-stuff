# Postmortems

When things go wrong — agent mistakes, system failures, expensive debugging loops — capture the incident so future sessions don't repeat it.

## Storage

Postmortems are stored as tickets tagged `postmortem`. Create with:

```
todos_oneshot(
  title: "Postmortem: <topic>",
  description: "<postmortem content>",
  tags: "postmortem",
  type: "task"
)
```

## Postmortem AGENTS.md

```markdown
# Agent Instructions: docs/postmortems

Purpose: incident postmortems and learnings.

Naming:
- `YYYY-MM-DD-HHMM-topic.md` (24h time, local).

Rules:
- Follow `/AGENTS.md` and `docs/AGENTS.md`.
- Include a `tk` ticket ID in the header when available.
- Cover summary, timeline, root cause, fix, and prevention.
```

## Postmortem Template

```markdown
# Post Mortem: [Title] ([Date])

## What Was Requested
What was the intended outcome.

## What Actually Happened
### Phase 1: [Name] (Good/Bad)
Chronological narrative of what occurred.

### Phase N: [Name]
Continue phases as needed.

## Root Causes
### 1. [Root Cause Title]
Explain the root cause with specifics. Include code examples showing the wrong vs right approach.

## Cost
- Compute/time spent
- Work lost or reverted
- Impact on schedule

## Lessons
1. **[Lesson title]** - Specific, actionable takeaway
2. **[Lesson title]** - Another takeaway

## Prevention
What changes to process, tooling, or rules prevent recurrence.
```

## When to Write a Postmortem

- Agent destroyed work through incorrect cleanup (deletion, revert)
- Agent bypassed existing systems (duplicated instead of reusing)
- Expensive debugging loop (>30 minutes on something avoidable)
- Feature shipped broken because verification was skipped
- Parallel agent coordination failure

## Referencing Postmortems

Link postmortems from the relevant AGENTS.md or spec to ensure agents encounter the lesson at the point of danger:

```markdown
## SpacetimeDB: Search Before You Implement (CRITICAL)

> **Post-mortem:** See postmortem ticket — Agent skipped codebase exploration, directly mutated velocity, broke physics.
```
