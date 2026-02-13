#!/usr/bin/env bun
/**
 * Push sync: .tickets/*.md → Forgejo issues
 *
 * Run on push when .tickets/ changes.
 * Creates/updates/closes Forgejo issues to mirror tk tickets.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseTicket, serializeTicket, type Ticket } from "./parse-ticket.js";
import {
	type ForgejoConfig,
	createIssue,
	updateIssue,
	getIssue,
	listComments,
	createComment,
	ensureLabel,
	checkUserExists,
} from "./forgejo-api.js";

const PRIORITY_COLORS: Record<number, string> = {
	0: "#e11d48", // critical - red
	1: "#f97316", // high - orange
	2: "#3b82f6", // medium - blue
	3: "#22c55e", // low - green
	4: "#6b7280", // minimal - gray
};

const SYNC_MARKER = "<!-- tk-sync -->";

async function getConfig(): Promise<{ cfg: ForgejoConfig; ticketsDir: string; repoDir: string }> {
	const url = process.env.FORGEJO_URL;
	const token = process.env.FORGEJO_TOKEN;
	const repo = process.env.REPO; // owner/repo
	const repoDir = process.env.REPO_DIR ?? process.cwd();

	if (!url || !token || !repo) {
		throw new Error("Missing FORGEJO_URL, FORGEJO_TOKEN, or REPO env vars");
	}

	const [owner, repoName] = repo.split("/");
	return {
		cfg: { url, token, owner, repo: repoName },
		ticketsDir: join(repoDir, ".tickets"),
		repoDir,
	};
}

function ticketState(status: string): "open" | "closed" {
	return status === "closed" || status === "done" ? "closed" : "open";
}

function buildIssueBody(ticket: Ticket): string {
	let body = ticket.body || "";
	// Add metadata footer
	const meta: string[] = [];
	if (ticket.assignee) meta.push(`**Assignee:** ${ticket.assignee}`);
	if (ticket.type) meta.push(`**Type:** ${ticket.type}`);
	meta.push(`**tk:** \`${ticket.id}\``);
	if (meta.length > 0) {
		body += `\n\n---\n${meta.join(" · ")}\n${SYNC_MARKER}`;
	}
	return body;
}

async function resolveLabelIds(cfg: ForgejoConfig, ticket: Ticket): Promise<number[]> {
	const ids: number[] = [];
	for (const tag of ticket.tags) {
		const label = await ensureLabel(cfg, tag);
		ids.push(label.id);
	}
	// Priority label
	const prioLabel = await ensureLabel(cfg, `priority/${ticket.priority}`, PRIORITY_COLORS[ticket.priority] ?? "#6b7280");
	ids.push(prioLabel.id);
	return ids;
}

async function syncTicket(cfg: ForgejoConfig, ticket: Ticket, ticketPath: string, repoDir: string): Promise<boolean> {
	let fileChanged = false;
	const state = ticketState(ticket.status);

	if (ticket.forgejoIssue == null) {
		// Create new issue
		const labelIds = await resolveLabelIds(cfg, ticket);
		let assignee: string | undefined;
		if (ticket.assignee) {
			const exists = await checkUserExists(cfg, ticket.assignee);
			if (exists) assignee = ticket.assignee;
		}

		const issue = await createIssue(cfg, {
			title: ticket.title,
			body: buildIssueBody(ticket),
			labels: labelIds,
			assignee,
		});

		// Sync existing notes as comments
		for (const note of ticket.notes) {
			await createComment(cfg, issue.number, `**${note.timestamp}**\n\n${note.text}\n\n${SYNC_MARKER}`);
		}

		if (state === "closed") {
			await updateIssue(cfg, issue.number, { state: "closed" });
		}

		// Write back the forgejo-issue link
		ticket.forgejoIssue = issue.number;
		await writeFile(ticketPath, serializeTicket(ticket));
		fileChanged = true;

		console.log(`✅ Created issue #${issue.number} for ${ticket.id}`);
	} else {
		// Update existing issue
		const issue = await getIssue(cfg, ticket.forgejoIssue);
		const updates: Record<string, string> = {};

		if (issue.title !== ticket.title) updates.title = ticket.title;

		const newBody = buildIssueBody(ticket);
		if (issue.body !== newBody) updates.body = newBody;

		const issueState = issue.state === "open" ? "open" : "closed";
		if (issueState !== state) updates.state = state;

		if (Object.keys(updates).length > 0) {
			await updateIssue(cfg, ticket.forgejoIssue, updates);
			console.log(`📝 Updated issue #${ticket.forgejoIssue} for ${ticket.id}: ${Object.keys(updates).join(", ")}`);
		}

		// Sync new notes as comments
		const existingComments = await listComments(cfg, ticket.forgejoIssue);
		const syncedTimestamps = new Set<string>();
		for (const c of existingComments) {
			// Extract timestamp from synced comments
			const tsMatch = c.body.match(/\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\*\*/);
			if (tsMatch) syncedTimestamps.add(tsMatch[1]);
		}

		for (const note of ticket.notes) {
			if (!syncedTimestamps.has(note.timestamp)) {
				await createComment(cfg, ticket.forgejoIssue, `**${note.timestamp}**\n\n${note.text}\n\n${SYNC_MARKER}`);
				console.log(`💬 Added comment to #${ticket.forgejoIssue} for note ${note.timestamp}`);
			}
		}
	}

	return fileChanged;
}

async function main() {
	const { cfg, ticketsDir, repoDir } = await getConfig();

	const files = await readdir(ticketsDir).catch(() => []);
	const ticketFiles = files.filter((f) => f.endsWith(".md"));

	let anyFileChanged = false;

	for (const file of ticketFiles) {
		const ticketPath = join(ticketsDir, file);
		const content = await readFile(ticketPath, "utf-8");
		try {
			const ticket = parseTicket(content);
			const changed = await syncTicket(cfg, ticket, ticketPath, repoDir);
			if (changed) anyFileChanged = true;
		} catch (err) {
			console.error(`⚠️ Failed to sync ${file}: ${err}`);
		}
	}

	// Commit back any changes (forgejo-issue links added)
	if (anyFileChanged) {
		try {
			execSync("git add .tickets/", { cwd: repoDir, stdio: "pipe" });
			execSync('git commit -m "tk-sync: link tickets to Forgejo issues [skip ci]"', {
				cwd: repoDir,
				stdio: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "tk-sync",
					GIT_AUTHOR_EMAIL: "tk-sync@noreply",
					GIT_COMMITTER_NAME: "tk-sync",
					GIT_COMMITTER_EMAIL: "tk-sync@noreply",
				},
			});
			execSync("git push", { cwd: repoDir, stdio: "pipe" });
			console.log("📌 Committed forgejo-issue links back to repo");
		} catch (err) {
			console.error(`⚠️ Failed to commit back: ${err}`);
		}
	}

	console.log(`Done. Synced ${ticketFiles.length} tickets.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
