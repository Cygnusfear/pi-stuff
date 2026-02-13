# Comment Classification Heuristics

Detailed rules for classifying old-format comments into human (`🙋‍♂️:`) or agent (`🤖:`) categories.

## Classification Algorithm

```
1. Check for question indicators → 🤖: (high confidence)
2. Check for imperative verbs → 🙋‍♂️: (high confidence)
3. Check for uncertainty phrases → 🤖: (medium confidence)
4. Check for action phrases → 🙋‍♂️: (medium confidence)
5. If ambiguous → manual review
```

## High Confidence: Human Task (🙋‍♂️:)

**Imperative verbs at start:**
- implement, add, create, build, write
- fix, update, change, modify, refactor
- remove, delete, deprecate
- test, verify, validate
- document, describe

**Action patterns:**
- "TODO: ..."
- "FIXME: ..."
- References specific files: "in `src/auth.ts`"
- Code references: "the `handleLogin` function"

**Examples:**
```
%% [ ] implement refresh token flow %%           → 🙋‍♂️:
%% [ ] add error handling to API calls %%        → 🙋‍♂️:
%% [ ] fix the race condition in auth %%         → 🙋‍♂️:
%% [ ] update the login component %%             → 🙋‍♂️:
```

## High Confidence: Agent Question (🤖:)

**Question words:**
- how, why, what, which, where, when
- should, could, would
- is, are, does, do

**Question indicators:**
- Contains `?`
- Starts with question word
- "need to decide", "unclear", "unsure"

**Uncertainty phrases:**
- "not sure if..."
- "might need to..."
- "consider whether..."
- "TBD", "to be determined"

**Examples:**
```
%% [ ] how should we handle OAuth? %%            → 🤖:
%% [ ] should this use JWT or sessions? %%       → 🤖:
%% [ ] unclear if this needs caching %%          → 🤖:
%% [ ] which database to use? %%                 → 🤖:
```

## Medium Confidence Cases

**Leaning human (🙋‍♂️:):**
- Verb phrases without question marks
- Technical references
- File/function names mentioned

**Leaning agent (🤖:):**
- Abstract concepts without action verbs
- Comparative statements
- Trade-off discussions

## Low Confidence: Manual Review Required

**Ambiguous patterns:**
- Single word: "check", "verify", "review"
- Very short (<3 words)
- Could be either instruction or question

**Examples needing review:**
```
%% [ ] verify approach %%          → Could be instruction OR question
%% [ ] check %%                    → Too short to classify
%% [ ] performance %%              → Unclear intent
%% [ ] auth flow %%                → Noun phrase, no verb
```

## Regex Patterns

**Detect old-format comments:**
```regex
%% \[[ x]\] ([^🙋🤖].*?) %%
```

**Already upgraded (skip):**
```regex
%% (🙋‍♂️|🤖|✅)
```

**Question indicators:**
```regex
^(how|why|what|which|where|when|should|could|would|is|are|does|do)\b|\?$
```

**Imperative verbs:**
```regex
^(implement|add|create|build|write|fix|update|change|modify|refactor|remove|delete|test|verify|document)\b
```

## Confidence Scoring

| Pattern | Confidence |
|---------|------------|
| Question mark present | 95% 🤖 |
| Starts with question word | 90% 🤖 |
| Starts with imperative verb | 90% 🙋‍♂️ |
| Contains "unclear/unsure" | 85% 🤖 |
| Contains file/code reference | 80% 🙋‍♂️ |
| 3+ words, no indicators | 60% (review) |
| <3 words | 40% (review) |

## Batch Presentation for Manual Review

When presenting ambiguous cases, group by similarity:

```markdown
### Short/Ambiguous (3 items)

1. **auth.md:45** - "check"
2. **api.md:12** - "verify"
3. **db.md:88** - "review"

For each: Is this an instruction (🙋‍♂️) or question (🤖)?

### Noun Phrases (2 items)

4. **config.md:23** - "auth flow"
5. **setup.md:67** - "database schema"

For each: Is this an instruction (🙋‍♂️) or question (🤖)?
```

This batching reduces cognitive load and speeds up manual classification.
