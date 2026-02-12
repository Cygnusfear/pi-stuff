# The Dumb Zone

Detects when an AI session is degrading and shows a warning overlay.

Inspired by [this video](https://www.youtube.com/watch?v=rmvDxxNubIg).

## Detection Methods

### Context Window Utilization (Primary)

Monitors token usage relative to the model's context window. High utilization correlates with degraded response quality.

| Threshold | Default | Post-Compaction |
|-----------|---------|-----------------|
| Warning   | 30%     | 21%             |
| Danger    | 35%     | 24.5%           |
| Critical  | 50%     | 35%             |

After compaction, thresholds are stricter (0.7x multiplier) since hitting high usage after compaction indicates the session should be reset.

### Phrase Patterns (Supplementary)

Detects sycophantic/concerning phrases that indicate the model is in "please the user" mode rather than "be accurate" mode:

- "excellent catch"
- "good catch"
- "you are absolutely right"

## Features

- **Hook**: Runs after each agent turn, triggers overlay when violations detected
- **Overlay**: Shows "YOU HAVE ENTERED THE DUMB ZONE" with context details (30s cooldown)
- **Command**: `/dumb-zone-status` - shows current utilization with a progress bar

## Configuration

Edit `constants.ts` to adjust thresholds:

```ts
export const CONTEXT_THRESHOLDS = {
  WARNING: 30,
  DANGER: 35,
  CRITICAL: 50,
} as const;

export const POST_COMPACTION_MULTIPLIER = 0.7;

export const DUMB_ZONE_PATTERNS: readonly RegExp[] = [
  /excellent catch/i,
  /good\s+catch/i,
  /you are absolutely right/i,
];

export const OVERLAY_COOLDOWN_MS = 30000;
```

## Dependencies

- `@aliou/tui-utils` - for themed box rendering
