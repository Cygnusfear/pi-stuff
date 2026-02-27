import type { ExtensionAPI, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { visibleWidth } from "@mariozechner/pi-tui";


import type { ColorScheme, SegmentContext, StatusLinePreset, StatusLineSegmentId } from "./types.js";
import { getPreset, PRESETS } from "./presets.js";
import { getSeparator } from "./separators.js";
import { renderSegment } from "./segments.js";
import { getGitStatus, invalidateGitStatus, invalidateGitBranch } from "./git-status.js";
import { getDefaultColors, ansi, getFgAnsiCode } from "./theme.js";

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

interface PowerlineConfig {
  preset: StatusLinePreset;
}

let config: PowerlineConfig = {
  preset: "default",
};

const MSTRA_MODE_ENV = "TOTALRECALL_MSTRA_MODE";
const MSTRA_MEMORY_TOKENS_ENV = "TOTALRECALL_MSTRA_MEMORY_TOKENS";
const MSTRA_MEMORY_THRESHOLD_ENV = "TOTALRECALL_MSTRA_MEMORY_THRESHOLD_TOKENS";
const MSTRA_MESSAGE_TARGET_TOKENS = 30_000;
const MSTRA_MEMORY_TARGET_TOKENS = 40_000;

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
}

function extractMstraMemoryTokensFromSessionEvents(events: any[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    if (entry?.type !== "message") continue;

    const role = entry?.message?.role;
    if (role !== "user" && role !== "custom") continue;

    const textBlocks = extractTextBlocks(entry?.message?.content);
    for (const text of textBlocks) {
      const observerMatch = text.match(/<observer[^>]*active_tokens="(\d+)"/);
      if (observerMatch) {
        return Number.parseInt(observerMatch[1], 10);
      }

      const guidanceMatch = text.match(/active_observation_tokens:\s*(\d+)/);
      if (guidanceMatch) {
        return Number.parseInt(guidanceMatch[1], 10);
      }
    }
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Status Line Builder
// ═══════════════════════════════════════════════════════════════════════════

/** Render a single segment and return its content with width */
function renderSegmentWithWidth(
  segId: StatusLineSegmentId,
  ctx: SegmentContext
): { content: string; width: number; visible: boolean } {
  const rendered = renderSegment(segId, ctx);
  if (!rendered.visible || !rendered.content) {
    return { content: "", width: 0, visible: false };
  }
  return { content: rendered.content, width: visibleWidth(rendered.content), visible: true };
}

/** Build content string from pre-rendered parts */
function buildContentFromParts(
  parts: string[],
  presetDef: ReturnType<typeof getPreset>
): string {
  if (parts.length === 0) return "";
  const separatorDef = getSeparator(presetDef.separator);
  const sepAnsi = getFgAnsiCode("sep");
  const sep = separatorDef.left;
  return " " + parts.join(` ${sepAnsi}${sep}${ansi.reset} `) + ansi.reset + " ";
}

/**
 * Responsive segment layout - fits segments into top bar, overflows to secondary row.
 * When terminal is wide enough, secondary segments move up to top bar.
 * When narrow, top bar segments overflow down to secondary row.
 */
function computeResponsiveLayout(
  ctx: SegmentContext,
  presetDef: ReturnType<typeof getPreset>,
  availableWidth: number
): { topContent: string; secondaryContent: string } {
  const separatorDef = getSeparator(presetDef.separator);
  const sepWidth = visibleWidth(separatorDef.left) + 2; // separator + spaces around it
  
  // Get all segments: primary first, then secondary
  const primaryIds = [...presetDef.leftSegments, ...presetDef.rightSegments];
  const secondaryIds = presetDef.secondarySegments ?? [];
  const allSegmentIds = [...primaryIds, ...secondaryIds];
  
  // Render all segments and get their widths
  const renderedSegments: { id: StatusLineSegmentId; content: string; width: number }[] = [];
  for (const segId of allSegmentIds) {
    const { content, width, visible } = renderSegmentWithWidth(segId, ctx);
    if (visible) {
      renderedSegments.push({ id: segId, content, width });
    }
  }
  
  if (renderedSegments.length === 0) {
    return { topContent: "", secondaryContent: "" };
  }
  
  // Calculate how many segments fit in top bar
  // Account for: leading space (1) + trailing space (1) = 2 chars overhead
  const baseOverhead = 2;
  let currentWidth = baseOverhead;
  let topSegments: string[] = [];
  let secondarySegments: string[] = [];
  let overflow = false;
  
  for (let i = 0; i < renderedSegments.length; i++) {
    const seg = renderedSegments[i];
    // Width needed: segment width + separator (except for first segment)
    const neededWidth = seg.width + (topSegments.length > 0 ? sepWidth : 0);
    
    if (!overflow && currentWidth + neededWidth <= availableWidth) {
      // Fits in top bar
      topSegments.push(seg.content);
      currentWidth += neededWidth;
    } else {
      // Overflow to secondary row
      overflow = true;
      secondarySegments.push(seg.content);
    }
  }
  
  return {
    topContent: buildContentFromParts(topSegments, presetDef),
    secondaryContent: buildContentFromParts(secondarySegments, presetDef),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function powerlineFooter(pi: ExtensionAPI) {
  let enabled = true;
  let sessionStartTime = Date.now();
  let currentCtx: any = null;
  let footerDataRef: ReadonlyFooterDataProvider | null = null;
  let getThinkingLevelFn: (() => string) | null = null;
  let isStreaming = false;
  let tuiRef: any = null; // Store TUI reference for forcing re-renders
  
  // Cache for responsive layout (shared between editor and widget for consistency)
  let lastLayoutWidth = 0;
  let lastLayoutResult: { topContent: string; secondaryContent: string } | null = null;
  let lastLayoutTimestamp = 0;

  // Track session start
  pi.on("session_start", async (_event, ctx) => {
    sessionStartTime = Date.now();
    currentCtx = ctx;
    
    // Store thinking level getter if available
    if (typeof ctx.getThinkingLevel === 'function') {
      getThinkingLevelFn = () => ctx.getThinkingLevel();
    }
    
    if (enabled && ctx.hasUI) {
      setupCustomEditor(ctx);
    }
  });

  // Check if a bash command might change git branch
  const mightChangeGitBranch = (cmd: string): boolean => {
    const gitBranchPatterns = [
      /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
      /\bgit\s+stash\s+(pop|apply)/,
    ];
    return gitBranchPatterns.some(p => p.test(cmd));
  };

  // Only invalidate on branch-changing commands (rare) — status refreshes via 3-min stale TTL
  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName === "bash" && event.input?.command && mightChangeGitBranch(String(event.input.command))) {
      invalidateGitBranch();
      invalidateGitStatus();
    }
  });

  pi.on("user_bash", async (event, _ctx) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitBranch();
      invalidateGitStatus();
    }
  });

  // Track streaming state
  pi.on("agent_start", async (_event, _ctx) => {
    isStreaming = true;
  });

  pi.on("agent_end", async (_event, _ctx) => {
    isStreaming = false;
  });

  // Command to toggle/configure
  pi.registerCommand("powerline", {
    description: "Configure powerline status (toggle, preset)",
    handler: async (args, ctx) => {
      // Update context reference (command ctx may have more methods)
      currentCtx = ctx;
      
      if (!args) {
        // Toggle
        enabled = !enabled;
        if (enabled) {
          setupCustomEditor(ctx);
          ctx.ui.notify("Powerline enabled", "info");
        } else {
          // Clear all custom UI components
          ctx.ui.setEditorComponent(undefined);
          ctx.ui.setFooter(undefined);
          ctx.ui.setHeader(undefined);
          ctx.ui.setWidget("powerline-secondary", undefined);
          ctx.ui.setWidget("powerline-status", undefined);
          footerDataRef = null;
          tuiRef = null;
          // Clear layout cache
          lastLayoutResult = null;
          ctx.ui.notify("Defaults restored", "info");
        }
        return;
      }

      // Check if args is a preset name
      const preset = args.trim().toLowerCase() as StatusLinePreset;
      if (preset in PRESETS) {
        config.preset = preset;
        // Invalidate layout cache since preset changed
        lastLayoutResult = null;
        if (enabled) {
          setupCustomEditor(ctx);
        }
        ctx.ui.notify(`Preset set to: ${preset}`, "info");
        return;
      }

      // Show available presets
      const presetList = Object.keys(PRESETS).join(", ");
      ctx.ui.notify(`Available presets: ${presetList}`, "info");
    },
  });

  function buildSegmentContext(ctx: any, width: number, theme: Theme): SegmentContext {
    const presetDef = getPreset(config.preset);
    const colors: ColorScheme = presetDef.colors ?? getDefaultColors();

    // Build usage stats and get thinking level from session
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    let lastAssistant: AssistantMessage | undefined;
    let thinkingLevelFromSession = "off";
    
    const sessionEvents = ctx.sessionManager?.getBranch?.() ?? [];
    for (const e of sessionEvents) {
      // Check for thinking level change entries
      if (e.type === "thinking_level_change" && e.thinkingLevel) {
        thinkingLevelFromSession = e.thinkingLevel;
      }
      if (e.type === "message" && e.message.role === "assistant") {
        const m = e.message as AssistantMessage;
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          continue;
        }
        input += m.usage.input;
        output += m.usage.output;
        cacheRead += m.usage.cacheRead;
        cacheWrite += m.usage.cacheWrite;
        cost += m.usage.cost.total;
        lastAssistant = m;
      }
    }

    // Prefer live estimated context usage from runtime. Fall back to last assistant usage if unavailable.
    let usageContext;
    try {
      usageContext = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    } catch {
      // estimateTokens can crash on malformed messages
    }
    const fallbackContextTokens = lastAssistant
      ? lastAssistant.usage.input +
        lastAssistant.usage.output +
        lastAssistant.usage.cacheRead +
        lastAssistant.usage.cacheWrite
      : 0;
    const contextTokens = typeof usageContext?.tokens === "number" ? usageContext.tokens : fallbackContextTokens;
    const contextWindow = usageContext?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const contextPercent =
      typeof usageContext?.percent === "number"
        ? usageContext.percent
        : contextWindow > 0
          ? (contextTokens / contextWindow) * 100
          : 0;

    const mstraEnabled = process.env[MSTRA_MODE_ENV] === "on";
    const mstraMessageTargetTokens = MSTRA_MESSAGE_TARGET_TOKENS;
    const mstraMemoryTargetTokens =
      parsePositiveInt(process.env[MSTRA_MEMORY_THRESHOLD_ENV]) ?? MSTRA_MEMORY_TARGET_TOKENS;
    const mstraMemoryTokens =
      extractMstraMemoryTokensFromSessionEvents(sessionEvents) ??
      parsePositiveInt(process.env[MSTRA_MEMORY_TOKENS_ENV]) ??
      0;

    // Git status is lazy — fetched only when the git segment renders
    const gitBranch = footerDataRef?.getGitBranch() ?? null;

    // Check if using OAuth subscription
    const usingSubscription = ctx.model
      ? ctx.modelRegistry?.isUsingOAuth?.(ctx.model) ?? false
      : false;

    return {
      model: ctx.model,
      thinkingLevel: thinkingLevelFromSession || getThinkingLevelFn?.() || "off",
      sessionId: ctx.sessionManager?.getSessionId?.(),
      sessionName: pi.getSessionName(),
      usageStats: { input, output, cacheRead, cacheWrite, cost },
      contextTokens,
      contextPercent,
      contextWindow,
      autoCompactEnabled: ctx.settingsManager?.getCompactionSettings?.()?.enabled ?? true,
      mstraEnabled,
      mstraMessageTargetTokens,
      mstraMemoryTokens,
      mstraMemoryTargetTokens,
      usingSubscription,
      sessionStartTime,
      git: { branch: gitBranch, staged: 0, unstaged: 0, untracked: 0 },
      getGitStatus: () => getGitStatus(gitBranch),
      extensionStatuses: footerDataRef?.getExtensionStatuses() ?? new Map(),
      options: presetDef.segmentOptions ?? {},
      width,
      theme,
      colors,
    };
  }

  /**
   * Get cached responsive layout or compute fresh one.
   * Layout is cached per render cycle (same width = same layout).
   */
  function getResponsiveLayout(width: number, theme: Theme): { topContent: string; secondaryContent: string } {
    const now = Date.now();
    // Cache is valid if same width and within 50ms (same render cycle)
    if (lastLayoutResult && lastLayoutWidth === width && now - lastLayoutTimestamp < 50) {
      return lastLayoutResult;
    }
    
    const presetDef = getPreset(config.preset);
    const segmentCtx = buildSegmentContext(currentCtx, width, theme);
    // Available width for status bar content (no fill, full width)
    const topBarAvailable = width;
    
    lastLayoutWidth = width;
    lastLayoutResult = computeResponsiveLayout(segmentCtx, presetDef, topBarAvailable);
    lastLayoutTimestamp = now;
    
    return lastLayoutResult;
  }

  function setupCustomEditor(ctx: any) {
    // Import CustomEditor dynamically and create wrapper
    import("@mariozechner/pi-coding-agent").then(({ CustomEditor }) => {
      let currentEditor: any = null;
      let autocompleteFixed = false;

      const editorFactory = (tui: any, editorTheme: any, keybindings: any) => {
        // Create custom editor that overrides render for status bar below content
        const editor = new CustomEditor(tui, editorTheme, keybindings);
        currentEditor = editor;
        
        const originalHandleInput = editor.handleInput.bind(editor);
        editor.handleInput = (data: string) => {
          if (!autocompleteFixed && !(editor as any).autocompleteProvider) {
            autocompleteFixed = true;
            ctx.ui.setEditorComponent(editorFactory);
            currentEditor?.handleInput(data);
            return;
          }
          originalHandleInput(data);
        };
        
        // Store original render
        const originalRender = editor.render.bind(editor);
        
        // Override render: status bar, top rule, prompted content, bottom rule
        //  status content
        //  ──────────────────────────────────────
        //  > first line of input
        //    continuation lines
        //  ──────────────────────────────────────
        // + autocomplete items (if showing)
        editor.render = (width: number): string[] => {
          // Fall back to original render on extremely narrow terminals
          if (width < 10) {
            return originalRender(width);
          }
          
          const bc = (s: string) => `${getFgAnsiCode("sep")}${s}${ansi.reset}`;
          const prompt = `${ansi.getFgAnsi(200, 200, 200)}>${ansi.reset}`;
          
          // Content area: 3 chars for prompt prefix (" > " / "   ")
          const promptPrefix = ` ${prompt} `;
          const contPrefix = "   ";
          const contentWidth = Math.max(1, width - 3);
          const lines = originalRender(contentWidth);
          
          if (lines.length === 0 || !currentCtx) return lines;
          
          // Find bottom border (plain ─ or scroll indicator ─── ↓ N more)
          // Lines after it are autocomplete items
          let bottomBorderIndex = lines.length - 1;
          for (let i = lines.length - 1; i >= 1; i--) {
            const stripped = lines[i]?.replace(/\x1b\[[0-9;]*m/g, "") || "";
            if (stripped.length > 0 && /^─{3,}/.test(stripped)) {
              bottomBorderIndex = i;
              break;
            }
          }
          
          const result: string[] = [];
          
          // Status bar above top border
          const layout = getResponsiveLayout(width, ctx.ui.theme);
          result.push(layout.topContent);
          
          // Top border (plain rule, 1-char margins)
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Content lines: first line gets "> " prompt, rest indented to match
          for (let i = 1; i < bottomBorderIndex; i++) {
            const prefix = i === 1 ? promptPrefix : contPrefix;
            result.push(`${prefix}${lines[i] || ""}`);
          }
          
          // If only had top/bottom borders (empty editor), show prompt
          if (bottomBorderIndex === 1) {
            result.push(`${promptPrefix}${" ".repeat(contentWidth)}`);
          }
          
          // Bottom border
          result.push(" " + bc("─".repeat(width - 2)));
          
          // Append any autocomplete lines that come after the bottom border
          for (let i = bottomBorderIndex + 1; i < lines.length; i++) {
            result.push(lines[i] || "");
          }
          
          return result;
        };
        
        return editor;
      };

      ctx.ui.setEditorComponent(editorFactory);

      // Set up footer data provider access (needed for git branch, extension statuses)
      // Status bar is rendered inside the editor override, footer is empty
      ctx.ui.setFooter((tui: any, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
        footerDataRef = footerData;
        tuiRef = tui; // Store TUI reference for re-renders on git branch changes
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      });

      // Set up secondary row as a widget below editor (above sub bar)
      // Shows overflow segments when top bar is too narrow
      ctx.ui.setWidget("powerline-secondary", (_tui: any, theme: Theme) => {
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx) return [];
            
            // Use responsive layout - secondary row shows overflow from top bar
            const layout = getResponsiveLayout(width, theme);
            
            // Only show secondary row if there's overflow content that fits
            if (layout.secondaryContent) {
              const contentWidth = visibleWidth(layout.secondaryContent);
              // Don't render if content exceeds terminal width (graceful degradation)
              if (contentWidth <= width) {
                return [layout.secondaryContent];
              }
            }
            
            return [];
          },
        };
      }, { placement: "belowEditor" });

      // Set up status notifications widget above editor
      // Shows extension status messages that look like notifications (e.g., "[pi-annotate] Received: CANCEL")
      // Compact statuses (e.g., "MCP: 6 servers") stay in the powerline bar via extension_statuses segment
      ctx.ui.setWidget("powerline-status", () => {
        return {
          dispose() {},
          invalidate() {},
          render(width: number): string[] {
            if (!currentCtx || !footerDataRef) return [];
            
            const statuses = footerDataRef.getExtensionStatuses();
            if (!statuses || statuses.size === 0) return [];
            
            // Collect notification-style statuses (those starting with "[extensionName]")
            const notifications: string[] = [];
            for (const value of statuses.values()) {
              if (value && value.trimStart().startsWith('[')) {
                // Account for leading space when checking width
                const lineContent = ` ${value}`;
                const contentWidth = visibleWidth(lineContent);
                if (contentWidth <= width) {
                  notifications.push(lineContent);
                }
              }
            }
            
            return notifications;
          },
        };
      }, { placement: "aboveEditor" });
    });
  }

}
