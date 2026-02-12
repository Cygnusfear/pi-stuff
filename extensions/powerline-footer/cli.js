#!/usr/bin/env node

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetDir = join(homedir(), ".pi", "agent", "extensions", "powerline-footer");

// Files to copy (TypeScript sources + docs)
const files = readdirSync(__dirname).filter(
  (f) => f.endsWith(".ts") || f === "README.md" || f === "CHANGELOG.md"
);

// Create target directory
mkdirSync(targetDir, { recursive: true });

// Copy files
let copied = 0;
for (const file of files) {
  const src = join(__dirname, file);
  const dest = join(targetDir, file);
  copyFileSync(src, dest);
  copied++;
}

console.log(`✓ Installed pi-powerline-footer to ${targetDir}`);
console.log(`  Copied ${copied} files`);
console.log(`\nRestart pi to activate the extension.`);
