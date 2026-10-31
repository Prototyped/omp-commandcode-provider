/**
 * Live model discovery from the gateway's own CLI catalog.
 *
 * `GET /provider/v1/models?view=client` is what the `command-code` CLI
 * consumes (bundle constant `Oo`): a versioned document with per-model
 * capabilities (`inputModalities`, `reasoningEfforts`, `maxOutputTokens`),
 * pricing, plan gates (`minimumPlan`/`category`), `zdr`, aliases and a
 * `behaviorProfile`. That makes models.dev and the plain roster redundant —
 * both deleted. A catalog the schema gate rejects registers zero models, the
 * same fail-closed rule `parseModelCatalog` applies (unsupported
 * `schemaVersion` → no models, no fallback).
 *
 * The harness caches the discovered catalog above this extension, so no local
 * cache is kept; `omp models refresh` forces a re-fetch.
 */

import { type CatalogModel, parseCatalog } from "./catalog.ts";
import { BASE_URL, CATALOG_ENDPOINT, PROVIDER_ID } from "./constants.ts";
import { readExcludedModels } from "./exclusions.ts";

export type { CatalogModel } from "./catalog.ts";
export { parseCatalog, parseCatalogVersion } from "./catalog.ts";

/** Model definition the harness registers. */
export type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
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

const CATALOG_FETCH_TIMEOUT_MS = 10_000;

async function fetchCatalog(): Promise<unknown | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE_URL}${CATALOG_ENDPOINT}`, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function mapCatalogModel(model: CatalogModel): ModelDef {
	return {
		id: model.id,
		name: model.display ?? model.id,
		reasoning: model.reasoningEfforts.length > 0,
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
 * filtered by the user's `excludedModels`. Discovery failure means no models —
 * no stale fallback.
 */
export async function discoverModels(agentDir: string): Promise<ModelDef[]> {
	const body = await fetchCatalog();
	if (body === null) return [];
	const models = parseCatalog(body);
	if (models.length === 0) return [];
	const excluded = await readExcludedModels(agentDir);
	return models
		.filter((m) => !m.hidden)
		.map(mapCatalogModel)
		.filter((m) => !excluded.has(m.id));
}

export { PROVIDER_ID };
