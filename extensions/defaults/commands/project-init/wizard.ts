/**
 * TUI wizard for /project:init.
 *
 * Phase 1: Loading spinner while scanning catalog/project/scout.
 * Phase 2: Multi-select list with scout recommendations highlighted.
 *
 * Ctrl+S to apply, Esc to cancel.
 */

import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import type { CatalogEntry } from "./catalog";
import { scanCatalog } from "./catalog";
import { getInstalled, readSettings } from "./installer";
import { type ProjectStack, scanProject } from "./scanner";

export interface WizardItem {
  entry: CatalogEntry | null; // null for the AGENTS.md option
  label: string;
  description: string;
  checked: boolean;
  recommended: boolean;
  locked: boolean;
  lockedBy?: string;
}

export interface WizardResult {
  selectedEntries: CatalogEntry[];
  unselectedEntries: CatalogEntry[];
  generateAgents: boolean;
  /** Scout response text, if available. */
  scoutAnalysis: string | undefined;
  stack: ProjectStack;
}

/** Event name for cross-extension scout calls. */
const SCOUT_EXECUTE_EVENT = "scout:execute";

interface ScoutExecutePayload {
  input: { prompt: string; query?: string };
  resolve: (result: { content: string } | null) => void;
}

function callScout(
  pi: ExtensionAPI,
  prompt: string,
): Promise<{ content: string } | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 60_000);

    const payload: ScoutExecutePayload = {
      input: { prompt },
      resolve: (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
    };

    pi.events.emit(SCOUT_EXECUTE_EVENT, payload);
  });
}

function parseRecommendations(
  scoutResponse: string | null,
  catalog: CatalogEntry[],
): Set<string> {
  if (!scoutResponse) return new Set();

  const names = new Set<string>();
  const lower = scoutResponse.toLowerCase();

  for (const entry of catalog) {
    if (lower.includes(entry.name.toLowerCase())) {
      names.add(entry.name);
    }
  }

  return names;
}

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

function buildItems(
  catalog: CatalogEntry[],
  installedSkills: Set<string>,
  installedPackages: Set<string>,
  recommendations: Set<string>,
): WizardItem[] {
  const items: WizardItem[] = [];

  const sorted = [...catalog].sort((a, b) => {
    const aRec = recommendations.has(a.name);
    const bRec = recommendations.has(b.name);
    if (aRec !== bRec) return aRec ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    const installed =
      entry.type === "skill"
        ? installedSkills.has(entry.path)
        : installedPackages.has(entry.path);
    const recommended = recommendations.has(entry.name);

    items.push({
      entry,
      label: entry.name,
      description: entry.description,
      checked: installed || recommended,
      recommended,
      locked: false,
    });
  }

  items.push({
    entry: null,
    label: "Generate AGENTS.md",
    description:
      "Analyze the project and generate/update AGENTS.md with build commands, architecture, and style guidelines",
    checked: true,
    recommended: false,
    locked: false,
  });

  return items;
}

/** Compute locks: skills included in checked packages are locked. */
function computeLocks(items: WizardItem[]): void {
  // Reset all locks
  for (const item of items) {
    item.locked = false;
    item.lockedBy = undefined;
  }

  // Find checked packages with skills
  for (const item of items) {
    if (
      !item.entry ||
      item.entry.type !== "package" ||
      !item.checked ||
      item.entry.skillPaths.length === 0
    ) {
      continue;
    }

    const pkg = item.entry;
    const pkgName = item.label;

    // Lock all skills that are in this package's skillPaths
    for (const skillItem of items) {
      if (
        !skillItem.entry ||
        skillItem.entry.type !== "skill" ||
        !pkg.skillPaths.includes(skillItem.entry.path)
      ) {
        continue;
      }

      skillItem.locked = true;
      skillItem.lockedBy = pkgName;
      skillItem.checked = true; // Ensure it's checked
    }
  }
}

class ProjectInitWizard extends Container implements Focusable {
  private phase: "loading" | "ready" = "loading";
  private loadingMessage = "Scanning catalog...";
  private spinnerIndex = 0;

  private stack: ProjectStack = {
    languages: [],
    frameworks: [],
    tools: [],
    summary: "Scanning...",
  };
  private items: WizardItem[] = [];
  private filteredItems: WizardItem[] = [];
  private cursor = 0;
  private scrollOffset = 0;
  private readonly maxVisible = 15;
  private recommendations = new Set<string>();
  private scoutAnalysis: string | undefined;

  private searchInput: Input;
  private listContainer: Container;
  private footerText: Text;
  private theme: Theme;

  // Focusable implementation - propagate to searchInput for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  private onDone: (result: WizardResult | null) => void;
  private spinnerTimer: NodeJS.Timeout;

  constructor(theme: Theme, onDone: (result: WizardResult | null) => void) {
    super();
    this.theme = theme;
    this.onDone = onDone;

    // Header
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    // Search input (will be added later when ready)
    this.searchInput = new Input();

    // List container
    this.listContainer = new Container();

    // Footer
    this.footerText = new Text("", 0, 0);

    // Spinner timer
    this.spinnerTimer = setInterval(() => {
      if (this.phase === "loading") {
        this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      }
    }, 100);
  }

  async initialize(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    catalogDirs: string[],
    catalogDepth: number,
  ): Promise<void> {
    // Scan catalog
    const catalog = await scanCatalog(catalogDirs, catalogDepth);
    if (catalog.length === 0) {
      clearInterval(this.spinnerTimer);
      this.onDone(null);
      ctx.ui.notify(
        "No skills or packages found in catalog directories.",
        "warning",
      );
      return;
    }

    // Scan project
    this.loadingMessage = "Detecting project stack...";
    this.stack = await scanProject(ctx.cwd);

    // Read settings
    const settings = await readSettings(ctx.cwd);
    const installed = getInstalled(settings);
    const installedSkills = installed.skills;
    const installedPackages = installed.packages;

    // Show wizard immediately (no recommendations yet)
    this.items = buildItems(
      catalog,
      installedSkills,
      installedPackages,
      this.recommendations,
    );
    computeLocks(this.items);
    this.phase = "ready";
    clearInterval(this.spinnerTimer);
    this.rebuild();

    // Call scout in background
    const catalogSummary = catalog
      .map((e) => `- ${e.name} (${e.type}): ${e.description}`)
      .join("\n");

    const scoutPrompt = [
      `Project stack: ${this.stack.summary}`,
      "",
      "Available skills and packages:",
      catalogSummary,
      "",
      "Which of these skills and packages would be most useful for this project?",
      "List only the names of recommended items, one per line.",
    ].join("\n");

    const scoutResult = await callScout(pi, scoutPrompt);
    const content = scoutResult?.content ?? null;
    if (typeof content === "string" && content) {
      this.scoutAnalysis = content;
      this.recommendations = parseRecommendations(content, catalog);

      // Rebuild items preserving user's manual toggles
      const checkedByUser = new Set<string>();
      const uncheckedByUser = new Set<string>();
      for (const item of this.items) {
        if (!item.entry) continue;
        const wasAutoChecked =
          item.entry.type === "skill"
            ? installedSkills.has(item.entry.path)
            : installedPackages.has(item.entry.path);
        if (item.checked && !wasAutoChecked) checkedByUser.add(item.label);
        if (!item.checked && wasAutoChecked) uncheckedByUser.add(item.label);
      }

      this.items = buildItems(
        catalog,
        installedSkills,
        installedPackages,
        this.recommendations,
      );

      // Re-apply user toggles
      for (const item of this.items) {
        if (checkedByUser.has(item.label)) item.checked = true;
        if (uncheckedByUser.has(item.label)) item.checked = false;
      }

      computeLocks(this.items);
      this.refresh();
    }
  }

  private refresh(): void {
    const query = this.searchInput.getValue();
    this.filteredItems = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.label} ${item.description}`,
        )
      : this.items;
    this.cursor = Math.min(
      this.cursor,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
    this.footerText.setText(this.getFooterText());
  }

  private rebuild(): void {
    this.clear();

    // Top border
    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));

    if (this.phase === "loading") {
      this.addChild(
        new Text(
          this.theme.fg("accent", this.theme.bold("Project Init")),
          1,
          0,
        ),
      );
      const frame = SPINNER_FRAMES[this.spinnerIndex] ?? "|";
      this.addChild(
        new Text(this.theme.fg("dim", `${frame} ${this.loadingMessage}`), 1, 0),
      );
      this.addChild(
        new DynamicBorder((s: string) => this.theme.fg("accent", s)),
      );
      return;
    }

    // Title
    this.addChild(
      new Text(this.theme.fg("accent", this.theme.bold("Project Init")), 1, 0),
    );

    // Stack summary
    this.addChild(new Text(this.theme.fg("dim", this.stack.summary), 1, 0));

    // Selection count (always display to prevent UI jump)
    const selectedPackages = this.items.filter(
      (item) => item.checked && item.entry?.type === "package",
    ).length;
    const selectedSkills = this.items.filter(
      (item) => item.checked && item.entry?.type === "skill",
    ).length;
    const lockedSkills = this.items.filter(
      (item) => item.checked && item.entry?.type === "skill" && item.locked,
    ).length;

    const countParts: string[] = [];
    countParts.push(
      `${selectedPackages} package${selectedPackages !== 1 ? "s" : ""}`,
    );

    const skillText = `${selectedSkills} skill${selectedSkills !== 1 ? "s" : ""}`;
    if (lockedSkills > 0) {
      countParts.push(`${skillText} (${lockedSkills} from packages)`);
    } else {
      countParts.push(skillText);
    }

    this.addChild(new Text(this.theme.fg("dim", countParts.join(", ")), 1, 0));

    this.addChild(new Spacer(1));

    // Search input
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    // List container
    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.updateList();

    // Footer
    this.addChild(new Spacer(1));
    this.footerText = new Text(this.getFooterText(), 0, 0);
    this.addChild(this.footerText);

    // Bottom border
    this.addChild(new DynamicBorder((s: string) => this.theme.fg("accent", s)));
  }

  private getFooterText(): string {
    const parts = ["Space toggle", "^A all", "^X clear", "^S apply"];
    if (this.recommendations.size > 0) {
      parts.push("* = scout");
    }
    return this.theme.fg("dim", `  ${parts.join(" · ")}`);
  }

  private updateList(): void {
    this.listContainer.clear();

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  No matching items"), 0, 0),
      );
      return;
    }

    const visibleEnd = Math.min(
      this.scrollOffset + this.maxVisible,
      this.filteredItems.length,
    );

    const itemLines: string[] = [];
    for (let i = this.scrollOffset; i < visibleEnd; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;
      const isCursor = i === this.cursor;
      const checkbox = item.checked ? "[x]" : "[ ]";
      const prefix = isCursor ? "> " : "  ";
      const rec = item.recommended ? " *" : "";

      // Scope or package tag
      let tag = "";
      if (item.entry) {
        if (item.entry.type === "skill" && item.entry.scope) {
          tag = this.theme.fg("dim", ` (${item.entry.scope})`);
        } else if (item.entry.type === "package") {
          tag = this.theme.fg("dim", " (package)");
        }
      }

      // Locked indicator
      const lockedText =
        item.locked && item.lockedBy
          ? this.theme.fg("dim", ` (via ${item.lockedBy})`)
          : "";

      let line = `${prefix}${checkbox} ${item.label}${rec}${tag}${lockedText}`;

      if (isCursor) {
        line = this.theme.fg("accent", line);
      } else if (item.locked) {
        line = this.theme.fg("dim", line);
      }

      itemLines.push(line);
    }

    if (itemLines.length > 0) {
      this.listContainer.addChild(new Text(itemLines.join("\n"), 1, 0));
    }

    if (this.filteredItems.length > this.maxVisible) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg(
            "dim",
            `(${this.cursor + 1}/${this.filteredItems.length})`,
          ),
          1,
          0,
        ),
      );
    }

    // Current item description
    const current = this.filteredItems[this.cursor];
    if (current?.description) {
      this.listContainer.addChild(new Spacer(1));
      this.listContainer.addChild(
        new Text(this.theme.fg("dim", current.description), 2, 0),
      );
    }
  }

  handleInput(data: string): void {
    if (this.phase === "loading") {
      if (matchesKey(data, Key.escape)) {
        clearInterval(this.spinnerTimer);
        this.onDone(null);
      }
      return;
    }

    // Navigation
    if (matchesKey(data, Key.up)) {
      if (this.filteredItems.length === 0) return;
      this.cursor =
        this.cursor === 0 ? this.filteredItems.length - 1 : this.cursor - 1;
      if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
      if (this.cursor >= this.scrollOffset + this.maxVisible)
        this.scrollOffset = this.cursor - this.maxVisible + 1;
      this.updateList();
      return;
    }

    if (matchesKey(data, Key.down)) {
      if (this.filteredItems.length === 0) return;
      this.cursor =
        this.cursor === this.filteredItems.length - 1 ? 0 : this.cursor + 1;
      if (this.cursor >= this.scrollOffset + this.maxVisible)
        this.scrollOffset = this.cursor - this.maxVisible + 1;
      if (this.cursor < this.scrollOffset) this.scrollOffset = this.cursor;
      this.updateList();
      return;
    }

    // Toggle on Space
    if (data === " ") {
      const item = this.filteredItems[this.cursor];
      if (item && !item.locked) {
        item.checked = !item.checked;
        // Recompute locks if this was a package toggle
        if (item.entry?.type === "package") {
          computeLocks(this.items);
        }
        this.updateList();
      }
      return;
    }

    // Ctrl+A - Select all (filtered if search active)
    if (matchesKey(data, Key.ctrl("a"))) {
      const targets = this.searchInput.getValue()
        ? this.filteredItems
        : this.items;
      for (const item of targets) {
        if (!item.locked) {
          item.checked = true;
        }
      }
      computeLocks(this.items);
      this.updateList();
      return;
    }

    // Ctrl+X - Clear all (filtered if search active)
    if (matchesKey(data, Key.ctrl("x"))) {
      const targets = this.searchInput.getValue()
        ? this.filteredItems
        : this.items;
      for (const item of targets) {
        if (!item.locked) {
          item.checked = false;
        }
      }
      computeLocks(this.items);
      this.updateList();
      return;
    }

    // Ctrl+S - Apply
    if (matchesKey(data, Key.ctrl("s"))) {
      clearInterval(this.spinnerTimer);
      const selected: CatalogEntry[] = [];
      const unselected: CatalogEntry[] = [];
      let generateAgents = false;

      for (const item of this.items) {
        if (!item.entry) {
          generateAgents = item.checked;
          continue;
        }
        if (item.checked) {
          selected.push(item.entry);
        } else {
          unselected.push(item.entry);
        }
      }

      this.onDone({
        selectedEntries: selected,
        unselectedEntries: unselected,
        generateAgents,
        scoutAnalysis: this.scoutAnalysis,
        stack: this.stack,
      });
      return;
    }

    // Ctrl+C - clear search or cancel if empty
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue("");
        this.refresh();
      } else {
        clearInterval(this.spinnerTimer);
        this.onDone(null);
      }
      return;
    }

    // Escape - cancel
    if (matchesKey(data, Key.escape)) {
      clearInterval(this.spinnerTimer);
      this.onDone(null);
      return;
    }

    // Pass everything else to search input
    this.searchInput.handleInput(data);
    this.refresh();
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }

  dispose(): void {
    clearInterval(this.spinnerTimer);
  }
}

export async function showWizard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  catalogDirs: string[],
  catalogDepth: number,
): Promise<WizardResult | null> {
  return ctx.ui.custom<WizardResult | null>((_tui, theme, _kb, done) => {
    const wizard = new ProjectInitWizard(theme, done);

    // Initialize asynchronously
    wizard.initialize(pi, ctx, catalogDirs, catalogDepth).catch((error) => {
      ctx.ui.notify(`Initialization failed: ${error}`, "error");
      done(null);
    });

    return wizard;
  });
}
