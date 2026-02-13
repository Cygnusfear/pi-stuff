# AGENTS.md and AGENTS.md Templates

These templates help you set up a repo wiki that agents can follow.

## AGENTS.md (Symlink)

Make `AGENTS.md` a symlink to `AGENTS.md`:

```bash
# From within docs/
ln -s AGENTS.md AGENTS.md
```

Why: some tools ignore `AGENTS.md` when it contains `@AGENTS.md`. A symlink avoids this.

## docs/AGENTS.md (Actual Instructions)

Copy and customize:

```markdown
# Agent Instructions: [Project Name]

## 00.00 Johnny Lookup

If the human gives you only an ID like `20.01` (or `2001`), treat it as a handbook call:

- Find `docs/handbook/**/20.01-*.md`
- Read it
- Follow it literally

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

```bash
ID=$(tk create "Short description" -t task -p 1 --tags tag1,tag2 -d "Details") && tk start $ID
```

### Changelog (tinychange)

Log changes with `tinychange`.

```bash
tinychange -I new -k <fix|feat|docs|refactor|...> -m "t-XXXX: message" -a AUTHOR
tinychange merge
```
```
