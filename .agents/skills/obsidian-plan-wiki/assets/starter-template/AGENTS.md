# Agent Instructions: [Project Name]

## 00.00 Johnny Lookup

If the human gives you only an ID like `20.01` (or `2001`), treat it as a handbook call:

1. Check `docs/handbook/**/20.01-*.md` — if it exists, read and follow it (local override).
2. If no local file, read `handbook/20-git/20.01-*.md` from the `obsidian-plan-wiki` skill.
3. Follow the instructions literally.

---

## Wiki Operations

### Progressive Disclosure

Read only what you need.

- Overview → `docs/README.md`
- Feature area → `docs/features/NN-area/README.md`
- Spec/plan → `docs/features/NN-area/NN.NN-*-spec.md` / `NN.NN-*-plan.md`
- Architecture/research → `docs/reference/`
- Process/tooling → `docs/handbook/`

### Open Questions

Use Obsidian comments with emoji + block IDs:

```markdown
%% 🙋‍♂️ Human task/question %% ^q-scope-topic

%% 🤖 Agent question (waiting on human) %% ^q-scope-topic

%% ✅ Question → Answer %% ^q-scope-topic
```

Rules:
- Blank line between questions (Obsidian merges adjacent comments).
- Every question needs a block ID (`^q-scope-topic`).
- Last emoji decides whose turn it is.

### Ticketing (tk)

Use `tk` for non-trivial work. Close the ticket before committing.

**Small-change exemption** (all must be true): one file, ≤10 lines, docs-only or comment/typo-only. Otherwise, create a ticket.

```bash
ID=$(tk create "Short description" -t task -p 1 --tags tag1,tag2 -d "Details") && tk start $ID
```

Lifecycle: `tk create` → `tk start <id>` → work → `tk close <id>` → commit.

### Rebase Strategy

Read and follow the handbook in `20-git`. Use critical sanity check if circumstances deviate. In case of doubt, ask the Hooman.

1. `20.01` Rebase Preparations
2. `20.02` Rebase

ALWAYS CONFIRM REBASE WITH EXPLICIT `[R]`.

### Merge Strategy

ONLY MERGE IF THIS IS EXPLICITLY REQUESTED.

1. `20.03` Merge
2. `20.04` Post-Merge

ALWAYS CONFIRM MERGE WITH EXPLICIT `[M]`.

### Changelog (tinychange)

Log changes with `tinychange`.

```bash
tinychange -I new -k <fix|feat|docs|refactor|...> -m "t-XXXX: message" -a AUTHOR
tinychange merge
```
