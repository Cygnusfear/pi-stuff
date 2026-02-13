# Core Principles

## 1. Progressive Disclosure

Load only what's needed:

```
User asks about auth → Read features/10-core/README.md
User asks about login → Read features/10-core/10.01-auth-spec.md
User asks for overview → Read README.md only
```

## 2. Johnny Decimal Structure

Organize **features**, **handbook**, and **reference** docs using Johnny Decimal (johnnydecimal.com).

**Hard rules (avoid drift):**
- Use **two-digit decimals everywhere**: `NN.NN` (NOT `NN.N`, NOT `NN`, NOT `01` without `.01`).
- **Features:** folder `docs/features/NN-name/`, files `NN.NN-*-spec.md` and `NN.NN-*-plan.md`.
- **Handbook:** folder `docs/handbook/NN-area/`, files `NN.NN-topic.md`.
- **Reference:** folder `docs/reference/NN-area/`, files `NN.NN-topic.md`.

**Johnny lookup flow (common):**
- If the human says `20.01` (or `2001`) with no other context, interpret it as "open handbook section 20.01".
- Locate it by filename prefix (do not guess the topic slug):
  - `docs/handbook/**/20.01-*.md`
  - If multiple matches exist, pick the closest match by area/README context and link to the others.

Example:
```
docs/features/10-core/
├── README.md
├── 10.01-auth-spec.md
└── 10.01-auth-plan.md
```

**Example handbook/reference naming:**

```text
docs/handbook/20-git/
├── 20.01-methodic-rebase-merge.md
└── 20.04-post-merge-hygiene.md

docs/reference/01-design/
├── 01.07-game-design.md
└── 01.16-ticket-metadata-audit.md
```

**Johnny decimal drift to watch for:**
- Feature specs named `10.01` but reference docs named `01` (missing decimals) → fix reference docs to `01.NN-*`.
- Inconsistent padding (`1.01` vs `01.01`) → always pad to 2 digits.

**Migration: fixing `01`-only reference files:**
1. Create a `tk` ticket for the migration (renames touch many links).
2. Rename files to `NN.NN-topic.md` (choose an unused `.NN` in that area).
3. Update all Obsidian wiki links (`[[...]]`) that referenced the old filename/path.
4. Add `tinychange -k docs` entry for the rename.

**Migration rule:** If you rename docs for Johnny compliance, update all wiki links, record a `tk` ticket, and add a `tinychange` entry (usually `docs` kind).

**Quick audit (optional):**

```bash
# Find reference/handbook files missing an NN.NN prefix (heuristic)
rg --files docs/reference docs/handbook | rg -v "/[0-9]{2}\.[0-9]{2}-"

# Find feature docs missing an NN.NN prefix (heuristic)
rg --files docs/features | rg -v "/[0-9]{2}\.[0-9]{2}-"
```

## 3. Wiki Links Everywhere

All references use `[[wiki-links]]`. Broken links = sync signal.

```markdown
[[features/10-core/10.01-auth-spec|Login Flow]]
[[reference/architecture#auth-middleware|Auth Middleware]]
```

## 4. Task Tracking with Obsidian Comments

Track open questions using hidden comments with emoji prefixes and block references. Multi-line is allowed if it improves readability.

```markdown
%% 🙋‍♂️ Human question/task %% ^q-scope-descriptor

%% 🤖 Agent question waiting on human %% ^q-scope-question

%% ✅ Question here → Answer here %% ^q-scope-resolved
```

**CRITICAL: Separate each question with a blank line.** Obsidian treats consecutive lines as a single block; only the last block ID works.

**Format components:**
- `🙋‍♂️` = **human wrote this** → AGENTS SHOULD ACTION/ANSWER
- `🤖` = **agent wrote this** → AGENTS MUST SKIP (waiting for human)
- `✅` = **resolved** → no action needed
- `^q-{scope}-{descriptor}` = block ID for Obsidian navigation

**WHO ANSWERS WHAT:**
| Emoji | Who wrote it | Who should answer/action |
|-------|--------------|--------------------------|
| 🙋‍♂️ | Human | **Agent** (this is work for you!) |
| 🤖 | Agent | **Human** (skip this, you asked it) |
| ✅ | Resolved | **No one** |

**Conversation threading:** Questions can have inline replies. The **LAST emoji** determines whose turn:
```
%% 🤖 Should we cache? 🙋‍♂️ yes 🤖 what limit? %% ^q-cache
```
Last emoji is 🤖 → Human's turn. When `✅` → Done.

**Block ID convention:** `^q-{scope}-{descriptor}`
- `^q-auth-oauth` (auth feature, OAuth question)
- `^q-tabs-persist` (tabs feature, persistence question)

**Workflow:**
- Agent adds `🤖` question → human answers (agent skips these)
- Human answers → convert to `🙋‍♂️` (now actionable by agent) or `✅` (resolved)
- Human adds `🙋‍♂️` task → agent should action this
- Resolved format: `%% ✅ question → answer %% ^q-id`

**Linking to questions:**
```markdown
[[features/10-core/10.01-auth-spec#^q-auth-oauth|OAuth question]]
```

**Search in Obsidian:** Search for the emoji.

**Find via terminal:**
```bash
rg "🙋‍♂️" docs/                 # human tasks
rg "🤖" docs/                    # agent questions
rg "✅" docs/                    # resolved
rg "%% .*%%$" docs/              # missing block IDs (lines ending with %%)
```

**Agent responsibility:** Add block IDs to any question missing one. Generate the ID from the file's feature/spec and the question topic:
```
%% 🤖 how to handle OAuth? %%           → missing block ID
%% 🤖 how to handle OAuth? %% ^q-auth-oauth   → fixed
```

## 5. Changelog Protocol

Update `changelog.md` via `tinychange`. Do not hand-edit.

Setup (once):
```bash
tinychange init
```

Add entry (interactive):
```bash
tinychange
```

Add entry (scripted — preferred for agents):
```bash
tinychange -I new -k <fix|test|chore|security|feat|docs|refactor|perf> -m "Your change message" -a AUTHOR
```

Include the `tk` ticket ID in the message when available (e.g., "t-9cdc: Add feature X").

Merge entries into `docs/changelog.md`:
```bash
tinychange merge
```

Ensure `tinychange.toml` points to `docs/changelog.md` and uses Keep a Changelog format.

## 6. Task Tracking with tk

All non-trivial work is tracked via `tk` (https://github.com/wedow/ticket). A `tk` ticket is the execution-level unit of work.

**Small-change exemption** (all must be true): one file, 10 lines or fewer (excluding whitespace-only), and docs-only or comment/typo-only changes. Otherwise, create a ticket.

**One-liner to create + start + template a ticket:**

```bash
ID=$(tk create "Short description of work" -t task -p 1 --tags tag1,tag2 -d "Longer description") && tk start $ID && printf '\n## Goal\nWhat outcome must be achieved.\n\n## Acceptance Criteria\n- [ ] Observable completion conditions\n\n## Verification\n- [ ] Commands, checks, or manual steps\n\n## Worktree\n- .\n' >> .tickets/$ID.md
```

**Ticket body template:**

```markdown
## Goal
What outcome must be achieved.

## Scope
What is included.

## Out of Scope
What is explicitly excluded.

## Acceptance Criteria
- [ ] Observable completion conditions.

## Verification
- [ ] Commands, checks, or manual steps.

## Risks
- [ ] Risk and mitigation.

## Related Files
- `path/to/file`

## Links
- [label](url)

## Worktree
- `.` or `.worktrees/the-tree`
```

**Lifecycle:**
- `tk create` → `tk start <id>` → work → `tk close <id>` before committing
- Include ticket IDs in spec/plan headers and in `tinychange` messages
- `tk list` to see open tickets, `tk list --status closed` for closed

**Linking conventions:**
- Spec header includes related tk ticket IDs
- tinychange messages include tk ID (e.g., `t-9cdc: add salvage system`)
