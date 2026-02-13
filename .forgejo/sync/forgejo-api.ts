/**
 * Minimal Forgejo/Gitea API client.
 */

export interface ForgejoConfig {
	url: string; // e.g. https://forgejo.example.com
	token: string;
	owner: string;
	repo: string;
}

export interface ForgejoIssue {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	labels: { name: string }[];
	assignee?: { login: string } | null;
	user: { login: string };
}

export interface ForgejoComment {
	id: number;
	body: string;
	created_at: string;
	user: { login: string };
}

export interface ForgejoLabel {
	id: number;
	name: string;
	color: string;
}

async function api(cfg: ForgejoConfig, method: string, path: string, body?: unknown): Promise<Response> {
	const url = `${cfg.url}/api/v1/repos/${cfg.owner}/${cfg.repo}${path}`;
	const headers: Record<string, string> = {
		Authorization: `token ${cfg.token}`,
		"Content-Type": "application/json",
	};
	return fetch(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});
}

export async function listIssues(cfg: ForgejoConfig, state: "open" | "closed" | "all" = "all"): Promise<ForgejoIssue[]> {
	const issues: ForgejoIssue[] = [];
	let page = 1;
	while (true) {
		const res = await api(cfg, "GET", `/issues?state=${state}&type=issues&limit=50&page=${page}`);
		if (!res.ok) throw new Error(`listIssues failed: ${res.status} ${await res.text()}`);
		const batch: ForgejoIssue[] = await res.json();
		if (batch.length === 0) break;
		issues.push(...batch);
		page++;
	}
	return issues;
}

export async function getIssue(cfg: ForgejoConfig, number: number): Promise<ForgejoIssue> {
	const res = await api(cfg, "GET", `/issues/${number}`);
	if (!res.ok) throw new Error(`getIssue ${number} failed: ${res.status}`);
	return res.json();
}

export async function createIssue(
	cfg: ForgejoConfig,
	opts: { title: string; body: string; labels?: number[]; assignee?: string },
): Promise<ForgejoIssue> {
	const res = await api(cfg, "POST", "/issues", {
		title: opts.title,
		body: opts.body,
		labels: opts.labels,
		assignee: opts.assignee,
	});
	if (!res.ok) throw new Error(`createIssue failed: ${res.status} ${await res.text()}`);
	return res.json();
}

export async function updateIssue(
	cfg: ForgejoConfig,
	number: number,
	opts: { title?: string; body?: string; state?: "open" | "closed"; assignee?: string },
): Promise<ForgejoIssue> {
	const res = await api(cfg, "PATCH", `/issues/${number}`, opts);
	if (!res.ok) throw new Error(`updateIssue ${number} failed: ${res.status}`);
	return res.json();
}

export async function listComments(cfg: ForgejoConfig, number: number): Promise<ForgejoComment[]> {
	const res = await api(cfg, "GET", `/issues/${number}/comments`);
	if (!res.ok) throw new Error(`listComments ${number} failed: ${res.status}`);
	return res.json();
}

export async function createComment(cfg: ForgejoConfig, number: number, body: string): Promise<ForgejoComment> {
	const res = await api(cfg, "POST", `/issues/${number}/comments`, { body });
	if (!res.ok) throw new Error(`createComment ${number} failed: ${res.status}`);
	return res.json();
}

export async function ensureLabel(cfg: ForgejoConfig, name: string, color = "#0075ca"): Promise<ForgejoLabel> {
	// Check existing
	const listRes = await api(cfg, "GET", `/labels?limit=50`);
	if (listRes.ok) {
		const labels: ForgejoLabel[] = await listRes.json();
		const existing = labels.find((l) => l.name === name);
		if (existing) return existing;
	}
	// Create
	const res = await api(cfg, "POST", `/labels`, { name, color });
	if (!res.ok) throw new Error(`ensureLabel "${name}" failed: ${res.status}`);
	return res.json();
}

export async function searchIssueByTkId(cfg: ForgejoConfig, tkId: string): Promise<ForgejoIssue | null> {
	// Search for issues containing the tk ID marker in body
	const res = await api(cfg, "GET", `/issues?state=all&type=issues&limit=5&q=${encodeURIComponent(`tk: \`${tkId}\``)}`);
	if (!res.ok) return null;
	const issues: ForgejoIssue[] = await res.json();
	// Verify the body actually contains the marker (search can be fuzzy)
	return issues.find((i) => i.body?.includes(`\`${tkId}\``)) ?? null;
}

export async function checkUserExists(cfg: ForgejoConfig, username: string): Promise<boolean> {
	const url = `${cfg.url}/api/v1/users/${username}`;
	const res = await fetch(url, {
		headers: { Authorization: `token ${cfg.token}` },
	});
	return res.ok;
}
