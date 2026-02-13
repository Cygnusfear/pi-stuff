/**
 * Parse a tk ticket markdown file into structured data.
 */

export interface TicketNote {
	timestamp: string;
	text: string;
}

export interface Ticket {
	/** Raw frontmatter fields */
	id: string;
	status: string;
	tags: string[];
	priority: number;
	assignee?: string;
	created: string;
	type?: string;
	forgejoIssue?: number;
	/** Parsed from markdown */
	title: string;
	body: string;
	notes: TicketNote[];
	/** Original file content for diffing */
	raw: string;
}

export function parseTicket(content: string): Ticket {
	const raw = content;

	// Parse frontmatter
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!fmMatch) throw new Error("No frontmatter found");

	const fmBlock = fmMatch[1];
	const bodyBlock = fmMatch[2];

	const fm: Record<string, string> = {};
	for (const line of fmBlock.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		const val = line.slice(colonIdx + 1).trim();
		fm[key] = val;
	}

	const id = fm.id ?? "";
	const status = fm.status ?? "open";
	const priority = Number(fm.priority ?? "2");
	const created = fm.created ?? "";
	const type = fm.type;
	const assignee = fm.assignee || undefined;

	// Parse tags: [foo, bar]
	let tags: string[] = [];
	const tagsRaw = fm.tags ?? "[]";
	const tagsMatch = tagsRaw.match(/\[(.*)\]/);
	if (tagsMatch) {
		tags = tagsMatch[1]
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}

	// Parse forgejo-issue from frontmatter
	const forgejoIssue = fm["forgejo-issue"] ? Number(fm["forgejo-issue"]) : undefined;

	// Split body into title, description, and notes
	const notesIdx = bodyBlock.indexOf("\n## Notes");
	const prePart = notesIdx === -1 ? bodyBlock : bodyBlock.slice(0, notesIdx);
	const notesPart = notesIdx === -1 ? "" : bodyBlock.slice(notesIdx + "\n## Notes".length);

	// Title is the first # heading
	const titleMatch = prePart.match(/^#\s+(.+)$/m);
	const title = titleMatch?.[1]?.trim() ?? id;

	// Body is everything after the title line, before notes
	let body = "";
	if (titleMatch) {
		const afterTitle = prePart.slice(prePart.indexOf(titleMatch[0]) + titleMatch[0].length);
		body = afterTitle.trim();
	}

	// Parse notes: **timestamp**\ntext
	const notes: TicketNote[] = [];
	const notePattern = /\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\*\*\n([\s\S]*?)(?=\n\*\*\d{4}-|$)/g;
	let noteMatch: RegExpExecArray | null;
	while ((noteMatch = notePattern.exec(notesPart)) !== null) {
		notes.push({
			timestamp: noteMatch[1],
			text: noteMatch[2].trim(),
		});
	}

	return { id, status, tags, priority, assignee, created, type, forgejoIssue, title, body, notes, raw };
}

/**
 * Serialize a ticket back to markdown, preserving the format tk expects.
 */
export function serializeTicket(ticket: Ticket): string {
	const fmLines = [
		"---",
		`id: ${ticket.id}`,
		`status: ${ticket.status}`,
		`deps: []`,
		`links: []`,
		`created: ${ticket.created}`,
	];
	if (ticket.type) fmLines.push(`type: ${ticket.type}`);
	fmLines.push(`priority: ${ticket.priority}`);
	if (ticket.tags.length > 0) {
		fmLines.push(`tags: [${ticket.tags.join(", ")}]`);
	}
	if (ticket.assignee) fmLines.push(`assignee: ${ticket.assignee}`);
	if (ticket.forgejoIssue != null) fmLines.push(`forgejo-issue: ${ticket.forgejoIssue}`);
	fmLines.push("---");

	let md = fmLines.join("\n") + "\n";
	md += `# ${ticket.title}\n`;
	if (ticket.body) md += `\n${ticket.body}\n`;
	if (ticket.notes.length > 0) {
		md += "\n## Notes\n";
		for (const note of ticket.notes) {
			md += `\n**${note.timestamp}**\n\n${note.text}\n`;
		}
	}

	return md;
}
