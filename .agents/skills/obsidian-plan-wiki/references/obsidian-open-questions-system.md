## Open Questions System

Track open questions in Obsidian comments so they are searchable, linkable, and resolved in context.

- Reply inline until resolved.
- Multi-line is OK when it improves clarity.
- You can use the same markers in code comments (syntax varies by language).

## Comment Format

```
%% 🙋‍♂️ Human question/task %% ^q-scope-topic

%% 🤖 Agent question waiting on human %% ^q-scope-topic

%% 🤖 Agent question waiting on human 🙋‍♂️ human answers %% ^q-scope-topic

%% 🤖 Agent question waiting on human 🙋‍♂️ human answers 🤖 asks more 🙋‍♂️ sure why not %% ^q-scope-topic
```

When done, mark it resolved in place (optionally copy it to a question archive note such as `docs/handbook/10-docs/10.02-question-archive.md`).

```
%% ✅ Question here → Answer here %% ^q-scope-topic
```

## Markers

| Marker | Meaning          | Who acts next  |
| ------ | ---------------- | -------------- |
| 🙋‍♂️  | Human wrote this | Agent acts     |
| 🤖     | Agent wrote this | Human responds |
| ✅      | Resolved         | -              |

## Rules

1. Blank line between questions (Obsidian merges adjacent comments).
2. Every question needs a block ID (`^q-scope-topic`).
3. Last emoji decides whose turn it is.
4. `✅` means resolved.

## Finding Questions

Terminal search:

```
rg "🙋‍♂️" docs/
rg "🤖" docs/
rg "✅" docs/
rg "%% .*%%$" docs/  # missing block IDs (lines ending with %%)
rg "🙋‍♂️" src/
```

Obsidian search:
- `🙋‍♂️` for human tasks
- `🤖` for agent questions

## Linking to a Question

```
[[features/10-core/10.06-client-prediction-spec#^q-prediction-fixed-tick|Prediction tick question]]
```

## Open Questions Index (Dataview)

Use this in `docs/open-questions.md` to group open questions by who responds next.

```dataviewjs
const pages = dv.pages('"features" or "reference" or "handbook"');
const results = [];

function getLastResponder(text) {
  const emojis = [...text.matchAll(/🙋‍♂️|🤖/g)];
  if (emojis.length === 0) return null;
  return emojis[emojis.length - 1][0];
}

function listItem(r) {
  return `[[${r.page.file.path}#^${r.blockId}|${r.page.file.name}]] - ${r.question}`;
}

const ignored = ['open-questions-system', 'AGENTS'];

for (const page of pages) {
  if (ignored.some(pattern => page.file.path.includes(pattern))) continue;
  const content = await dv.io.load(page.file.path);
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    if (line.includes('✅')) return;
    const match = line.match(/%%\s*(🙋‍♂️|🤖)\s+(.+?)\s+%%\s+\^(q-[\w-]+)/);
    if (match) {
      const question = match[2];
      const blockId = match[3];
      const lastResponder = getLastResponder(line);
      results.push({ page, question, blockId, line: idx + 1, lastResponder });
    }
  });
}

const needsHuman = results.filter(r => r.lastResponder === '🤖');
const needsAgent = results.filter(r => r.lastResponder === '🙋‍♂️');

if (needsHuman.length > 0) {
  dv.header(3, "🤖 Last: Needs Human Response");

  const now = dv.date("today");
  const recent = new Map();
  const older = new Map();

  for (const r of needsHuman) {
    const m = r.page.file.mtime ?? now;
    const daysAgo = Math.floor(now.diff(m, "days").days);
    if (daysAgo <= 6) {
      const key = m.toFormat("yyyy-LL-dd");
      if (!recent.has(key)) recent.set(key, { date: m, items: [] });
      recent.get(key).items.push(r);
    } else {
      const weekKey = `${m.weekYear}-W${String(m.weekNumber).padStart(2, '0')}`;
      if (!older.has(weekKey)) older.set(weekKey, { date: m, items: [] });
      older.get(weekKey).items.push(r);
    }
  }

  const recentGroups = Array.from(recent.values()).sort((a, b) => b.date - a.date);
  recentGroups.forEach((group, index) => {
    dv.header(4, group.date.toFormat("ccc yyyy-LL-dd"));
    dv.list(group.items.map(listItem));
    if (index < recentGroups.length - 1) dv.el("hr", "");
  });

  if (recentGroups.length > 0 && older.size > 0) dv.el("hr", "");

  const olderGroups = Array.from(older.values()).sort((a, b) => b.date - a.date);
  olderGroups.forEach((group, index) => {
    const start = group.date.startOf("week");
    const end = group.date.endOf("week");
    const weekLabel = `${group.date.weekYear}-W${String(group.date.weekNumber).padStart(2, '0')}`;
    dv.header(4, `Week ${weekLabel} (${start.toFormat('LLL dd')}–${end.toFormat('LLL dd')})`);
    dv.list(group.items.map(listItem));
    if (index < olderGroups.length - 1) dv.el("hr", "");
  });
}

if (needsAgent.length > 0) {
  dv.header(3, "🙋‍♂️ Last: Agent Should Pick Up");
  dv.list(needsAgent.map(listItem));
}
```
