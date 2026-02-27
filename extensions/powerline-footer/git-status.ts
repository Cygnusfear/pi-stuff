import { spawn } from "node:child_process";
import type { GitStatus } from "./types.js";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
}

interface CachedBranch {
  branch: string | null;
}

const STALE_TTL_MS = 3 * 60 * 1000; // 3 minutes — background refresh floor

let cachedStatus: CachedGitStatus & { timestamp: number } | null = null;
let cachedBranch: CachedBranch & { timestamp: number } | null = null;
let pendingFetch: Promise<void> | null = null;
let pendingBranchFetch: Promise<void> | null = null;
let invalidationCounter = 0;
let branchInvalidationCounter = 0;

/**
 * Parse git status --porcelain output
 */
function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    if (x && x !== " " && x !== "?") {
      staged++;
    }

    if (y && y !== " ") {
      unstaged++;
    }
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

async function fetchGitBranch(): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"]);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"]);
  return sha ? `${sha} (detached)` : "detached";
}

async function fetchGitStatus(): Promise<{ staged: number; unstaged: number; untracked: number } | null> {
  const output = await runGit(["status", "--porcelain"], 1000);
  if (output === null) return null;
  return parseGitStatusOutput(output);
}

/**
 * Get the current git branch. Only fetches when cache is invalidated.
 */
export function getCurrentBranch(providerBranch: string | null): string | null {
  const branchStale = cachedBranch && (Date.now() - cachedBranch.timestamp > STALE_TTL_MS);

  // Return cached if available and not stale
  if (cachedBranch && !branchStale) return cachedBranch.branch;

  // Trigger background fetch if not already pending
  if (!pendingBranchFetch) {
    const fetchId = branchInvalidationCounter;
    pendingBranchFetch = fetchGitBranch().then((result) => {
      if (fetchId === branchInvalidationCounter) {
        cachedBranch = { branch: result, timestamp: Date.now() };
      }
      pendingBranchFetch = null;
    });
  }

  // Return stale data while fetch is in flight
  return cachedBranch ? cachedBranch.branch : providerBranch;
}

/**
 * Get git status. Only fetches when cache is invalidated.
 * Designed for synchronous render() calls — returns last known value
 * while refreshing in background.
 */
export function getGitStatus(providerBranch: string | null): GitStatus {
  const branch = getCurrentBranch(providerBranch);

  const statusStale = cachedStatus && (Date.now() - cachedStatus.timestamp > STALE_TTL_MS);

  // Return cached if available and not stale
  if (cachedStatus && !statusStale) {
    return {
      branch,
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
    };
  }

  // Trigger background fetch if not already pending
  if (!pendingFetch) {
    const fetchId = invalidationCounter;
    pendingFetch = fetchGitStatus().then((result) => {
      if (fetchId === invalidationCounter) {
        const now = Date.now();
        cachedStatus = result
          ? { staged: result.staged, unstaged: result.unstaged, untracked: result.untracked, timestamp: now }
          : { staged: 0, unstaged: 0, untracked: 0, timestamp: now };
      }
      pendingFetch = null;
    });
  }

  // Return stale data while fetch is in flight, or zeros on first load
  if (cachedStatus) {
    return { branch, staged: cachedStatus.staged, unstaged: cachedStatus.unstaged, untracked: cachedStatus.untracked };
  }
  return { branch, staged: 0, unstaged: 0, untracked: 0 };
}

/**
 * Invalidate git status cache. Next render will trigger a fresh fetch.
 */
export function invalidateGitStatus(): void {
  cachedStatus = null;
  invalidationCounter++;
}

/**
 * Invalidate git branch cache. Next render will trigger a fresh fetch.
 */
export function invalidateGitBranch(): void {
  cachedBranch = null;
  branchInvalidationCounter++;
}
