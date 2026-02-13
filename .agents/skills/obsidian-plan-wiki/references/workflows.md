# Workflow Patterns

## Creating a New Wiki

Copy the starter template to `docs/` and customize:

```bash
cp -r <skill-path>/assets/starter-template/* docs/
```

Or create manually:

1. Create `docs/` directory structure
2. Write README.md with feature area table (Johnny Decimal)
3. Create AGENTS.md with agent instructions
4. Create AGENTS.md as a symlink: `ln -s AGENTS.md AGENTS.md`
5. Initialize changelog via `tinychange init`
6. Create feature area folders with README.md (e.g., `features/10-core/`)
7. Create `plans/` with AGENTS.md
8. Use tickets tagged `postmortem` for incident learnings
9. Create `reference/` with AGENTS.md and README.md
10. Create `handbook/` with AGENTS.md and README.md
11. Keep `research/` with index.md
12. Add specs as needed

## Adding a Spec

1. Create `NN.NN-spec-name.md` in feature area folder
2. Add `tk` ticket in the header if applicable
3. Fill in Behavior (contract + scenarios)
4. Document Decisions (ADRs)
5. Map Integration (dependencies + consumers with wiki links)
6. Update feature area README table
7. Update changelog via CLI

## Adding a Plan

1. Create `NN.NN-plan-name.md` in feature area folder
2. Link to related spec if one exists
3. Add `tk` ticket in the header if applicable
4. Fill in Implementation Steps with checkboxes
5. List Files to Modify
6. Document Risks & Mitigations
7. Update feature area README plans table
8. Update changelog via CLI

## Research Workflow

When a `%% 🙋‍♂️ ... %%` or `%% 🤖 ... %%` comment needs research:

**Simple question:** Launch oracle agent
**Complex/uncertain:** Use Delphi (3 parallel oracles + synthesis)

Store results in `research/`, link from spec:
```markdown
%% ✅ question → see [[research/topic]] %% ^q-scope-topic
```

## Keeping Specs and Code in Sync

Specs and code are updated together. If you discover drift:
1. Open or link a `tk` ticket.
2. Decide the intended behavior (document in spec or ADR).
3. Update spec/plan and code to match that decision.
4. Add a `tinychange` entry.

## Updating Specs During Implementation

**Before:** Read the spec's Assumptions and Failure Modes.

**During implementation:**
- Add implementation notes to the spec
- Mark open questions as resolved: `%% ✅ Decided → [outcome] %%`
- Note any discovered failure modes

**After completing:**
- Update Success Criteria checkboxes
- Add commit hash if significant
- Update feature area README status if needed

## Link Format

Use relative markdown links (Obsidian-compatible):

| Target | Link Format |
|--------|-------------|
| Same directory | `[text](filename.md)` |
| Parent directory | `[text](../README.md)` |
| Subdirectory | `[text](reference/file.md)` |
| Cross-feature area | `[text](../20-context-menu/README.md)` |
| Heading anchor | `[text](file.md#section-name)` |

## When to Create New Documentation

| Situation | Action |
|-----------|--------|
| New feature area | Create new feature area directory |
| New behavior to document | Create numbered spec file (`NN.NN-spec.md`) |
| New implementation approach | Create numbered plan file (`NN.NN-plan.md`) |
| Deep technical topic | Add to `reference/` subdirectory |
| Research question | Use Oracle, save to `research/` |
| Feature-area-specific rules | Create `AGENTS.md` in feature area |
| New code/source folder | Create `AGENTS.md` in that folder |
| Agent mistake or system failure | Create postmortem ticket (tagged `postmortem`) |
| Recurring agent situation | Create handler in `handbook/80-agent-behaviour/` |
| Spec drifted from code | Run spec divergence audit |
| Tickets drifted from reality | Run ticket divergence audit |
