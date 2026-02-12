/**
 * Theme system for powerline-footer
 *
 * Colors are resolved in order:
 * 1. User overrides from theme.json (if exists)
 * 2. Preset colors
 * 3. Default colors
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ColorScheme, ColorValue, SemanticColor } from "./types.js";

// Default color scheme (uses pi theme colors)
const DEFAULT_COLORS: Required<ColorScheme> = {
  pi: "accent",
  model: "#7D56F4", // Pink/mauve (matching original colors.ts)
  path: "#7D56F4", // Teal/cyan (matching original colors.ts)
  git: "success",
  gitDirty: "warning",
  gitClean: "success",
  thinking: "muted",
  thinkingHigh: "accent",
  context: "dim",
  contextWarn: "warning",
  contextError: "error",
  cost: "text",
  tokens: "muted",
  separator: "dim",
  border: "borderMuted",
};

// Rainbow colors for high thinking levels
const RAINBOW_COLORS = [
  "#b281d6",
  "#d787af",
  "#febc38",
  "#e4c00f",
  "#89d281",
  "#00afaf",
  "#178fb9",
  "#b281d6",
];

// Cache for user theme overrides
let userThemeCache: ColorScheme | null = null;
let userThemeCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds

/**
 * Get the path to the theme.json file
 */
function getThemePath(): string {
  const extDir = dirname(fileURLToPath(import.meta.url));
  return join(extDir, "theme.json");
}

/**
 * Load user theme overrides from theme.json
 */
function loadUserTheme(): ColorScheme {
  const now = Date.now();
  if (userThemeCache && now - userThemeCacheTime < CACHE_TTL) {
    return userThemeCache;
  }

  const themePath = getThemePath();
  try {
    if (existsSync(themePath)) {
      const content = readFileSync(themePath, "utf-8");
      const parsed = JSON.parse(content);
      userThemeCache = parsed.colors ?? {};
      userThemeCacheTime = now;
      return userThemeCache;
    }
  } catch {
    // Ignore errors, use defaults
  }

  userThemeCache = {};
  userThemeCacheTime = now;
  return userThemeCache;
}

/**
 * Resolve a semantic color to an actual color value
 */
export function resolveColor(semantic: SemanticColor, presetColors?: ColorScheme): ColorValue {
  const userTheme = loadUserTheme();

  // Priority: user overrides > preset colors > defaults
  return userTheme[semantic] ?? presetColors?.[semantic] ?? DEFAULT_COLORS[semantic];
}

/**
 * Check if a color value is a hex color
 */
function isHexColor(color: ColorValue): color is `#${string}` {
  return typeof color === "string" && color.startsWith("#");
}

/**
 * Convert hex color to ANSI escape code
 */
function hexToAnsi(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Apply a color to text using the pi theme or custom hex
 */
export function applyColor(theme: Theme, color: ColorValue, text: string): string {
  if (isHexColor(color)) {
    return `${hexToAnsi(color)}${text}\x1b[0m`;
  }
  return theme.fg(color as ThemeColor, text);
}

/**
 * Apply a semantic color to text
 */
export function fg(
  theme: Theme,
  semantic: SemanticColor,
  text: string,
  presetColors?: ColorScheme,
): string {
  const color = resolveColor(semantic, presetColors);
  return applyColor(theme, color, text);
}

/**
 * Apply rainbow gradient to text (for high thinking levels)
 */
export function rainbow(text: string): string {
  let result = "";
  let colorIndex = 0;
  for (const char of text) {
    if (char === " " || char === ":") {
      result += char;
    } else {
      result += hexToAnsi(RAINBOW_COLORS[colorIndex % RAINBOW_COLORS.length]) + char;
      colorIndex++;
    }
  }
  return result + "\x1b[0m";
}

/**
 * Get the default color scheme
 */
export function getDefaultColors(): Required<ColorScheme> {
  return { ...DEFAULT_COLORS };
}

/**
 * Clear the user theme cache (for reloading)
 */
export function clearThemeCache(): void {
  userThemeCache = null;
  userThemeCacheTime = 0;
}
