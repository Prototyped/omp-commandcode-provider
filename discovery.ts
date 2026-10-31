/**
 * Live model discovery.
 *
 * There is no static model list in this extension. At startup the roster is
 * discovered live from the public GET /provider/v1/models endpoint (verified
 * to answer unauthenticated; a key is sent when one is available in case the
 * gateway ever requires it), and capability flags (reasoning/vision, output
 * limits) come from the models.dev "commandcode" catalog — fetched per
 * discovery run; the harness caches the discovered model catalog above this
 * extension, so no local copy is kept. If the roster call fails the provider
 * registers with no models rather than serving a stale fallback.
 *
 * cost is all zeros on purpose: per-model rates don't map cleanly to plan
 * credit multipliers. The session meter instead reads the gateway's reported
 * upstream USD cost (providerMetadata.gateway.cost), see stream.ts.
 *
 * Proprietary frontier models (ids starting with claude-, gpt-, or
 * google/gemini-) are served by the same endpoint but bill real plan credits
 * and are available far more cheaply elsewhere, so discovery filters them by
 * prefix (see PROPRIETARY_PREFIXES). To hide any other model, list its id
 * under `excludedModels` in the harness's user-level models.yml (see
 * readExcludedModels).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { BASE_URL, MODELS_ENDPOINT, PROVIDER_ID } from "./constants.ts";

// ---- Models -------------------------------------------------------------
// There is no static model list in this extension. At startup the roster is
// discovered live from the public GET /provider/v1/models endpoint (no auth
// required), and capability flags (reasoning/vision, output limits) come from
// the models.dev "commandcode" catalog, cached locally with a TTL — see the
// discovery section below. If both sources are unreachable the provider
// registers with no models rather than serving a stale fallback.
//
// Proprietary frontier models (ids starting with claude-, gpt-, or
// google/gemini-) are served by the same endpoint but bill real plan credits
// and are available far more cheaply elsewhere, so discovery filters them by
// prefix (see PROPRIETARY_PREFIXES). To hide any other model, list its id
// under `excludedModels` in models.yml (see the exclusions section).
//
// cost is all zeros on purpose: per-model rates don't map cleanly to plan
// credit multipliers. The session meter instead reads the gateway's reported
// upstream USD cost (providerMetadata.gateway.cost), see streamCommandCode.
//
// maxTokens is the per-call output cap pi sends as max_tokens; the gateway
// clamps anything larger to the model's true limit.

type ModelDef = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---- User-level model exclusions ------------------------------------------
// Excluded models are configured in the harness's user-level models.yml,
// under this provider's entry:
//
//   providers:
//     commandcode:
//       excludedModels:
//         - "some/model-id"
//
// The harness schema rejects provider entries that carry no recognized field,
// so the entry needs one (an `apiKey`, `auth: none`, `baseUrl`, ...) beside
// `excludedModels`. The parser keeps unknown keys, so the host ignores
// `excludedModels` while this extension reads it from the raw file.

type ModelsYaml = { providers?: Record<string, { excludedModels?: unknown }> };

export async function readExcludedModels(agentDir: string): Promise<Set<string>> {
	try {
		const raw = await readFile(path.join(agentDir, "models.yml"), "utf8");
		const data = (loadYaml(raw) ?? null) as ModelsYaml | null;
		const list = data?.providers?.[PROVIDER_ID]?.excludedModels;
		if (!Array.isArray(list)) return new Set();
		return new Set(list.filter((id): id is string => typeof id === "string" && id !== ""));
	} catch {
		return new Set();
	}
}

// ---- Live model discovery ---------------------------------------------------
// The roster comes from the public GET /provider/v1/models endpoint (verified
// to answer unauthenticated; a key is sent when one is available in case the
// gateway ever requires it). Rows carry only id/name/context_length/
// supported_endpoints, so reasoning/vision flags and output limits come from
// the models.dev "commandcode" catalog below. If the roster call fails the
// provider registers with no models — no stale fallback is served.

// Strict: catalog fields (roster rows, models.dev) arrive as numbers. The
// gateway's cost field arrives as a numeric string and is handled by
// `toFiniteNumber` (stream.ts) instead.
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Proprietary frontier models the gateway also serves. Excluded by default:
// they bill real plan credits and are available far more cheaply elsewhere
// (see README "Proprietary models (omitted by default)"). The live endpoint
// lists them alongside the OSS roster, so discovery filters them by id prefix.
const PROPRIETARY_PREFIXES = ["claude-", "gpt-", "google/gemini-"];

// ---- Capability data (models.dev) -------------------------------------------
// The public models.dev catalog carries the capability data the roster
// endpoint lacks. It is fetched per discovery run; the harness caches the
// discovered model catalog above this extension, so no local copy is kept.
// A model the catalog doesn't know about (or an unreachable catalog) is
// assumed reasoning-capable (most new models are) and text-only.

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_PROVIDER = "commandcode";
const MODELS_DEV_FETCH_TIMEOUT_MS = 10_000;

type ModelDevEntry = {
	reasoning?: boolean;
	attachment?: boolean;
	limit?: { context?: number; output?: number };
};

async function fetchModelDevCaps(): Promise<Record<string, ModelDevEntry>> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODELS_DEV_FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(MODELS_DEV_URL, { signal: controller.signal });
		if (!response.ok) return {};
		const body = (await response.json()) as Record<string, { models?: Record<string, ModelDevEntry> }>;
		return body[MODELS_DEV_PROVIDER]?.models ?? {};
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
}

async function fetchLiveModelRows(apiKey: string | undefined): Promise<unknown[] | null> {
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const response = await fetch(`${BASE_URL}${MODELS_ENDPOINT}`, { headers });
		if (!response.ok) return null;
		return parseModelRows(await response.json());
	} catch {
		return null;
	}
}

function mapDiscoveredModel(
	row: Record<string, unknown>,
	caps: Record<string, ModelDevEntry>,
): ModelDef | null {
	const id = typeof row.id === "string" && row.id !== "" ? row.id : null;
	if (!id) return null;
	if (PROPRIETARY_PREFIXES.some((prefix) => id.startsWith(prefix))) return null;
	const name = typeof row.name === "string" && row.name !== "" ? row.name : id;
	const dev = caps[id];
	return {
		id,
		name,
		// Models the catalog doesn't know about are assumed reasoning-capable
		// (most new models are) and text-only until it catches up.
		reasoning: dev ? dev.reasoning === true : true,
		input: dev?.attachment === true ? ["text", "image"] : ["text"],
		contextWindow: finiteNumber(row.context_length) ?? finiteNumber(dev?.limit?.context) ?? 128_000,
		maxTokens: finiteNumber(dev?.limit?.output) ?? 8192,
		cost: ZERO_COST,
	};
}

/** Extract raw model rows from a /provider/v1/models body; null when unrecognized. */
export function parseModelRows(body: unknown): unknown[] | null {
	if (Array.isArray(body)) return body;
	if (body !== null && typeof body === "object" && "data" in body && Array.isArray(body.data)) {
		return body.data;
	}
	return null;
}

/**
 * The provider's model catalog for this startup: live roster × models.dev
 * capabilities, filtered by proprietary prefixes and the user's
 * `excludedModels`. Discovery failure means no models — no stale fallback.
 */
export async function discoverModels(apiKey: string | undefined, agentDir: string): Promise<ModelDef[]> {
	const [rows, caps] = await Promise.all([fetchLiveModelRows(apiKey), fetchModelDevCaps()]);
	// No roster and no fallback: discovery failing leaves the provider
	// with no models until the next startup.
	if (rows === null) return [];
	const models = rows
		.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
		.map((row) => mapDiscoveredModel(row, caps))
		.filter((m): m is ModelDef => m !== null);
	const excluded = await readExcludedModels(agentDir);
	if (excluded.size === 0) return models;
	return models.filter((m) => !excluded.has(m.id));
}
