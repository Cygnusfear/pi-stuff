#!/usr/bin/env bun
/**
 * Webhook handler: Forgejo issue events → .tickets/*.md
 *
 * Receives Forgejo webhook payloads for issue edits, comments, and state changes.
 * Commits changes back to the repo.
 *
 * Run as: bun run src/webhook.ts
 * Or deploy as a Forgejo Action triggered by issue events.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseTicket, serializeTicket, type Ticket, type TicketNote } from "./parse-ticket.js";

const SYNC_MARKER = "<!-- tk-sync -->";
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();
const TICKETS_DIR = join(REPO_DIR, ".tickets");

interface WebhookPayload {
	action: string;
	issue: {
		number: number;
		title: string;
		body: string;
		state: "open" | "closed";
		user: { login: string };
	};
	comment?: {
		id: number;
		body: string;
		created_at: string;
		user: { login: string };
	};
	sender: { login: string };
}

async function findTicketByIssue(issueNumber: number): Promise<{ ticket: Ticket; path: string } | null> {
	const files = await readdir(TICKETS_DIR).catch(() => []);
	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(TICKETS_DIR, file);
		const content = await readFile(filePath, "utf-8");
		try {
			const ticket = parseTicket(content);
			if (ticket.forgejoIssue === issueNumber) {
				return { ticket, path: filePath };
			}
		} catch {
			continue;
		}
	}
	return null;
}

function isSyncComment(body: string): boolean {
	return body.includes(SYNC_MARKER);
}

async function handleIssueEdit(payload: WebhookPayload): Promise<boolean> {
	const found = await findTicketByIssue(payload.issue.number);
	if (!found) {
		console.log(`No ticket found for issue #${payload.issue.number}, skipping`);
		return false;
	}

	const { ticket, path } = found;
	let changed = false;

	// Update title if changed
	if (payload.issue.title !== ticket.title) {
		ticket.title = payload.issue.title;
		changed = true;
	}

	// Update status if changed
	const newStatus = payload.issue.state === "closed" ? "closed" : ticket.status === "closed" ? "open" : ticket.status;
	if (newStatus !== ticket.status) {
		ticket.status = newStatus;
		changed = true;
	}

	if (changed) {
		await writeFile(path, serializeTicket(ticket));
		console.log(`📝 Updated ticket ${ticket.id} from issue #${payload.issue.number}`);
	}

	return changed;
}

async function handleComment(payload: WebhookPayload): Promise<boolean> {
	if (!payload.comment) return false;

	// Skip comments we created (avoid loops)
	if (isSyncComment(payload.comment.body)) return false;

	const found = await findTicketByIssue(payload.issue.number);
	if (!found) {
		console.log(`No ticket found for issue #${payload.issue.number}, skipping comment`);
		return false;
	}

	const { ticket, path } = found;

	const timestamp = payload.comment.created_at.replace(/\.\d+Z$/, "Z"); // normalize
	const author = payload.comment.user.login;
	const text = `[${author}] ${payload.comment.body}`;

	// Check if note already exists (by timestamp)
	const exists = ticket.notes.some((n) => n.timestamp === timestamp);
	if (exists) return false;

	ticket.notes.push({ timestamp, text });
	await writeFile(path, serializeTicket(ticket));
	console.log(`💬 Added note to ${ticket.id} from issue #${payload.issue.number} comment`);

	return true;
}

async function handleIssueClosed(payload: WebhookPayload): Promise<boolean> {
	const found = await findTicketByIssue(payload.issue.number);
	if (!found) return false;

	const { ticket, path } = found;
	if (ticket.status === "closed") return false;

	ticket.status = "closed";
	await writeFile(path, serializeTicket(ticket));
	console.log(`🔒 Closed ticket ${ticket.id} from issue #${payload.issue.number}`);
	return true;
}

async function handleIssueReopened(payload: WebhookPayload): Promise<boolean> {
	const found = await findTicketByIssue(payload.issue.number);
	if (!found) return false;

	const { ticket, path } = found;
	if (ticket.status !== "closed") return false;

	ticket.status = "open";
	await writeFile(path, serializeTicket(ticket));
	console.log(`🔓 Reopened ticket ${ticket.id} from issue #${payload.issue.number}`);
	return true;
}

function commitAndPush(message: string) {
	try {
		execSync("git add .tickets/", { cwd: REPO_DIR, stdio: "pipe" });
		// Check if there are actual changes
		const status = execSync("git status --porcelain .tickets/", { cwd: REPO_DIR, encoding: "utf-8" });
		if (!status.trim()) return;

		execSync(`git commit -m "${message} [skip ci]"`, {
			cwd: REPO_DIR,
			stdio: "pipe",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "tk-sync",
				GIT_AUTHOR_EMAIL: "tk-sync@noreply",
				GIT_COMMITTER_NAME: "tk-sync",
				GIT_COMMITTER_EMAIL: "tk-sync@noreply",
			},
		});
		execSync("git push", { cwd: REPO_DIR, stdio: "pipe" });
		console.log(`📌 Committed: ${message}`);
	} catch (err) {
		console.error(`⚠️ Commit failed: ${err}`);
	}
}

/**
 * Process a webhook payload. Can be called from an HTTP server or a Forgejo Action.
 */
export async function processWebhook(payload: WebhookPayload): Promise<void> {
	let changed = false;

	switch (payload.action) {
		case "edited":
			changed = await handleIssueEdit(payload);
			break;
		case "closed":
			changed = await handleIssueClosed(payload);
			break;
		case "reopened":
			changed = await handleIssueReopened(payload);
			break;
		case "created":
			// Comment created
			if (payload.comment) {
				changed = await handleComment(payload);
			}
			break;
	}

	if (changed) {
		commitAndPush(`tk-sync: update from Forgejo issue #${payload.issue.number}`);
	}
}

// If run directly, read payload from stdin (for Forgejo Actions)
if (import.meta.main) {
	const input = await Bun.stdin.text();
	const payload: WebhookPayload = JSON.parse(input);
	await processWebhook(payload);
}
