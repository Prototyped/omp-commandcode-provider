/**
 * Live model discovery from the gateway's own CLI catalog.
 *
 * `GET /provider/v1/models?view=client` is what the `command-code` CLI
 * consumes (bundle constant `Oo`): a versioned document with per-model
 * capabilities (`inputModalities`, `reasoningEfforts`, `maxOutputTokens`),
 * pricing, plan gates (`minimumPlan`/`category`), `zdr`, aliases and a
 * `behaviorProfile` — the sole source of the capability, pricing and plan
 * data the harness needs.
 *
 * Discovery failure is reported by throwing: the harness catches it, marks the
 * provider's discovery state, and — because the fetch is non-authoritative —
 * keeps its cached catalog from the last successful discovery. A structurally
 * valid catalog with zero rows is a success that registers no models.
 */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type CatalogModel, parseCatalog } from "./catalog.ts";
import { BASE_URL, CATALOG_ENDPOINT, PROVIDER_ID } from "./constants.ts";
import { readExcludedModels } from "./exclusions.ts";

export type { CatalogModel } from "./catalog.ts";
export { parseCatalog } from "./catalog.ts";

/** Model definition the harness registers. */
export type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	thinking?: { mode: "effort"; efforts: Effort[] };
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	// Plan/quirk metadata kept for filtering and wire decisions; not part of
	// the harness's Model shape but consumed by stream.ts and index.ts.
	behaviorProfile: string;
	reasoningEfforts: string[];
	minimumPlan?: string | null;
	category: string | null;
	zdr: boolean;
};

export const KNOWN_BEHAVIOR_PROFILES = new Set([
	"standard-v1",
	"no-deferred-tools-v1",
	"private-reasoning-v1",
	"anthropic-interleaved-v1",
	"anthropic-prefix-bound-v1",
	"anthropic-prefix-bound-forced-v1",
]);

export function hasUnknownBehaviorProfile(models: ModelDef[]): boolean {
	return models.some((m) => !KNOWN_BEHAVIOR_PROFILES.has(m.behaviorProfile));
}

const CATALOG_FETCH_TIMEOUT_MS = 10_000;

// In-memory cache for conditional GET (the harness holds the persisted cache).
let cachedCatalogBody: unknown | null = null;
let cachedCatalogVersion: string | null = null;
// Full catalog including hidden rows (for user-supplied IDs that bypass discovery)
let allCatalogModels: CatalogModel[] = [];

async function fetchCatalog(): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { accept: "application/json" };
		if (cachedCatalogVersion) headers["if-none-match"] = `"${cachedCatalogVersion}"`;
		const response = await fetch(`${BASE_URL}${CATALOG_ENDPOINT}`, {
			headers,
			signal: controller.signal,
		});
		if (response.status === 304) {
			// if-none-match is only sent when a body is cached, so this is
			// unreachable in practice; treat it as a failure either way.
			if (cachedCatalogBody === null) throw new Error("model catalog 304 with no cached body");
			return cachedCatalogBody;
		}
		if (!response.ok) throw new Error(`model catalog fetch failed: HTTP ${response.status}`);
		const body = await response.json();
		const version = (body as Record<string, unknown>)?.catalogVersion;
		if (typeof version === "string") {
			cachedCatalogBody = body;
			cachedCatalogVersion = version;
		}
		return body;
	} finally {
		clearTimeout(timer);
	}
}

function mapCatalogModel(model: CatalogModel): ModelDef {
	return {
		id: model.id,
		name: model.display ?? model.id,
		reasoning: model.reasoningEfforts.length > 0,
		thinking:
			model.reasoningEfforts.length > 0
				? { mode: "effort", efforts: model.reasoningEfforts as Effort[] }
				: undefined,
		input: model.inputModalities.includes("image") ? ["text", "image"] : ["text"],
		contextWindow: model.contextLength,
		// `maxOutputTokens` is null for most rows; the gateway rejects anything
		// above 200000 outright, so cap at that and let per-request values win.
		maxTokens: model.maxOutputTokens ?? 200_000,
		cost: {
			input: model.pricing?.inputCost ?? 0,
			output: model.pricing?.outputCost ?? 0,
			cacheRead: model.pricing?.cacheReadCost ?? 0,
			cacheWrite: model.pricing?.cacheWriteCost ?? 0,
		},
		behaviorProfile: model.behaviorProfile,
		reasoningEfforts: model.reasoningEfforts,
		minimumPlan: model.minimumPlan,
		category: model.category,
		zdr: model.zdr,
	};
}

/**
 * The provider's model catalog for this startup: the gateway's CLI catalog,
 * filtered by the user's `excludedModels`. Throws on fetch or schema failure
 * (the harness keeps its cached catalog); a valid empty catalog yields [].
 */
export async function discoverModels(agentDir: string): Promise<ModelDef[]> {
	const body = await fetchCatalog();
	const models = parseCatalog(body);
	allCatalogModels = models;
	if (models.length === 0) return [];
	const excluded = await readExcludedModels(agentDir);
	return models
		.filter((m) => !m.hidden)
		.map(mapCatalogModel)
		.filter((m) => !excluded.has(m.id));
}

export { PROVIDER_ID };

/** Look up a model by id from the full catalog (including hidden). */
export function getCatalogModelById(id: string): CatalogModel | undefined {
	return allCatalogModels.find((m) => m.id === id || m.aliases.includes(id));
}
