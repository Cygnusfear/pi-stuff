/**
 * Settings command for the defaults extension.
 * Provides /ad:settings to edit the catalog array.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PathArrayEditor,
  registerSettingsCommand,
} from "@aliou/pi-utils-settings";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
  configLoader,
  type DefaultsConfig,
  type ResolvedDefaultsConfig,
} from "../config";

function expandTilde(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

export function registerDefaultsSettings(pi: ExtensionAPI): void {
  registerSettingsCommand<DefaultsConfig, ResolvedDefaultsConfig>(pi, {
    commandName: "defaults:settings",
    commandDescription: "Configure defaults extension settings",
    title: "Defaults Settings",
    configStore: configLoader,
    onSettingChange: (id, newValue, config) => {
      const updated = structuredClone(config);
      if (id === "catalogDepth") {
        updated.catalogDepth = Number.parseInt(newValue, 10);
      }
      return updated;
    },
    buildSections: (tabConfig, resolved, ctx) => {
      const catalog = tabConfig?.catalog ?? resolved.catalog;

      const catalogDepth = tabConfig?.catalogDepth ?? resolved.catalogDepth;
      const agentsIgnorePaths =
        tabConfig?.agentsIgnorePaths ?? resolved.agentsIgnorePaths;

      return [
        {
          label: "Catalog",
          items: [
            {
              id: "catalog",
              label: "Skill/Package directories",
              currentValue:
                catalog.length === 0
                  ? "none"
                  : `${catalog.length} director${catalog.length === 1 ? "y" : "ies"}`,
              description:
                "Directories to scan for skills and packages. Each directory is searched for subdirectories containing SKILL.md (skills) or package.json with a pi key (packages).",
              submenu: (_current, done) => {
                const currentConfig = tabConfig ?? ({} as DefaultsConfig);
                const currentArray = currentConfig.catalog ?? resolved.catalog;

                return new PathArrayEditor({
                  label: "Catalog Directories",
                  items: [...currentArray],
                  theme: getSettingsListTheme(),
                  onSave: (items: string[]) => {
                    const updated = { ...currentConfig, catalog: items };
                    ctx.setDraft(updated);
                    done(
                      items.length === 0
                        ? "none"
                        : `${items.length} director${items.length === 1 ? "y" : "ies"}`,
                    );
                  },
                  onDone: () => done(undefined),
                });
              },
            },
            {
              id: "catalogDepth",
              label: "Scan depth",
              currentValue: String(catalogDepth),
              values: ["1", "2", "3", "4", "5"],
              description:
                "How many directory levels deep to scan for skills and packages.",
            },
          ],
        },
        {
          label: "AGENTS Discovery",
          items: [
            {
              id: "agentsIgnorePaths",
              label: "Ignore paths",
              currentValue:
                agentsIgnorePaths.length === 0
                  ? "none"
                  : `${agentsIgnorePaths.length} path${agentsIgnorePaths.length === 1 ? "" : "s"}`,
              description:
                "Absolute/relative paths to ignore for AGENTS.md discovery. File path ignores one file; directory path ignores AGENTS.md files under that directory.",
              submenu: (_current, done) => {
                const currentConfig = tabConfig ?? ({} as DefaultsConfig);
                const currentArray =
                  currentConfig.agentsIgnorePaths ?? resolved.agentsIgnorePaths;

                return new PathArrayEditor({
                  label: "Ignored AGENTS Paths",
                  items: [...currentArray],
                  theme: getSettingsListTheme(),
                  validatePath: (value) => {
                    const resolved = path.resolve(
                      process.cwd(),
                      expandTilde(value),
                    );
                    if (!fs.existsSync(resolved)) {
                      return "Path must exist";
                    }
                    if (path.basename(resolved) !== "AGENTS.md") {
                      return "Path must point to AGENTS.md";
                    }
                    return null;
                  },
                  onSave: (items: string[]) => {
                    const updated = {
                      ...currentConfig,
                      agentsIgnorePaths: items,
                    };
                    ctx.setDraft(updated);
                    done(
                      items.length === 0
                        ? "none"
                        : `${items.length} path${items.length === 1 ? "" : "s"}`,
                    );
                  },
                  onDone: () => done(undefined),
                });
              },
            },
          ],
        },
      ];
    },
  });
}
