/**
 * Shared model resolution utilities.
 *
 * Used by model-shortcuts (slash commands) and model-hints (system prompt injection).
 */

export interface ModelLike {
	id: string;
	name: string;
	provider: string;
}

export interface RegistryLike {
	getAll(): ModelLike[];
	getAvailable(): ModelLike[];
}

// Model families — regex → human label
export const FAMILY_PATTERNS: [RegExp, string][] = [
	[/^claude-opus-/, "claude-opus"],
	[/^claude-sonnet-/, "claude-sonnet"],
	[/^claude-haiku-/, "claude-haiku"],
	[/^gpt-.*-codex$/, "gpt-codex"],
	[/^gpt-5/, "gpt-5"],
	[/^gpt-4/, "gpt-4"],
	[/^o[1-9]/, "o-series"],
	[/^gemini-2/, "gemini-2"],
	[/^gemini-1/, "gemini-1"],
];

/** Get the family label for a model ID, or null if unrecognized. */
export function getFamily(modelId: string): string | null {
	for (const [re, family] of FAMILY_PATTERNS) {
		if (re.test(modelId)) return family;
	}
	return null;
}

/**
 * Extract a comparable version number from a model ID.
 *
 * Returns null for dated/pinned models (20250514), -latest aliases,
 * and -thinking variants — those shouldn't be picked as "latest".
 */
export function extractVersion(modelId: string): number | null {
	if (/\d{8}/.test(modelId)) return null;
	if (modelId.endsWith("-latest")) return null;
	if (modelId.endsWith("-thinking")) return null;

	// claude-opus-4-6 → 4.6, gpt-5.3-codex → 5.3
	const match = modelId.match(/(\d+)[-.](\d+)/);
	if (match) return parseFloat(`${match[1]}.${match[2]}`);

	// Single version: claude-haiku-4 → 4
	const single = modelId.match(/-(\d+)(?:-|$)/);
	if (single) return parseInt(single[1]);

	return null;
}

export interface LatestModel {
	provider: string;
	id: string;
	name: string;
	family: string;
	version: number;
}

/**
 * Find the latest (highest version) model per provider+family.
 *
 * @param models - Array of models to scan
 * @returns Map keyed by "provider/family" → latest model info
 */
export function findLatestPerFamily(models: ModelLike[]): Map<string, LatestModel> {
	const latest = new Map<string, LatestModel>();

	for (const m of models) {
		const family = getFamily(m.id);
		if (!family) continue;

		const version = extractVersion(m.id);
		if (version === null) continue;

		const key = `${m.provider}/${family}`;
		const current = latest.get(key);
		if (!current || version > current.version) {
			latest.set(key, { provider: m.provider, id: m.id, name: m.name, family, version });
		}
	}

	return latest;
}

/**
 * Find the single latest model matching a provider + family regex.
 */
export function findLatest(models: ModelLike[], provider: string, family: RegExp): ModelLike | null {
	let best: ModelLike | null = null;
	let bestVersion = -1;

	for (const m of models) {
		if (m.provider !== provider) continue;
		if (!family.test(m.id)) continue;

		const v = extractVersion(m.id);
		if (v !== null && v > bestVersion) {
			bestVersion = v;
			best = m;
		}
	}

	return best;
}
