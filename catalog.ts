/**
 * Strict parser for the gateway's CLI model catalog
 * (`GET /provider/v1/models?view=client`), mirroring the CLI's
 * `parseModelCatalog`: unknown `schemaVersion` → no models; per-row validation
 * failures drop that row, not the document.
 *
 * Row schema per `parseModel` in the 1.88.2 bundle: id, name, display,
 * aliases, hidden, context_length (required positive int), maxOutputTokens
 * (positive int or null), inputModalities (string[] or null),
 * reasoningEfforts (string[] or null), behaviorProfile (required string), zdr
 * (required bool), category, minimumPlan, pricing.
 */

export type CatalogPricing = {
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
	cacheWriteCost?: number;
	cacheWrite1hCost?: number;
};

export type CatalogModel = {
	id: string;
	aliases: string[];
	hidden: boolean;
	contextLength: number;
	maxOutputTokens: number | null;
	inputModalities: string[];
	reasoningEfforts: string[];
	behaviorProfile: string;
	zdr: boolean;
	category: string | null;
	/** Optional in the wire row: `undefined` (absent) and `null` gate differently. */
	minimumPlan?: string | null;
	display: string | null;
	pricing: CatalogPricing | null;
};

export type Catalog = {
	catalogVersion: string;
	refreshAfterSeconds: number;
	models: CatalogModel[];
};

export const CATALOG_SCHEMA_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => isNonEmptyString(v));
}

function isStringArrayOrNull(value: unknown): value is string[] | null {
	return value === null || value === undefined || isStringArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseRates(value: unknown): CatalogPricing | null {
	if (!isRecord(value)) return null;
	const { inputCost, outputCost, cacheReadCost } = value;
	const rate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
	if (!rate(inputCost) || !rate(outputCost) || !rate(cacheReadCost)) return null;
	const out: CatalogPricing = { inputCost, outputCost, cacheReadCost };
	if (rate(value.cacheWriteCost)) out.cacheWriteCost = value.cacheWriteCost;
	if (rate(value.cacheWrite1hCost)) out.cacheWrite1hCost = value.cacheWrite1hCost;
	return out;
}

function parseDisplay(value: unknown): string | null {
	if (!isRecord(value)) return null;
	return isNonEmptyString(value.label) ? value.label : null;
}

function parseModelRow(row: unknown): CatalogModel | null {
	if (!isRecord(row)) return null;
	const { id, context_length: contextLength, behavior_profile: _bp, behaviorProfile } = row;
	if (!isNonEmptyString(id) || !isPositiveInteger(contextLength) || !isNonEmptyString(behaviorProfile)) {
		return null;
	}
	const maxOutputTokens = row.maxOutputTokens;
	if (maxOutputTokens !== null && maxOutputTokens !== undefined && !isPositiveInteger(maxOutputTokens)) {
		return null;
	}
	const inputModalities = row.inputModalities;
	if (inputModalities !== null && inputModalities !== undefined && !isStringArray(inputModalities)) {
		return null;
	}
	const reasoningEfforts = row.reasoningEfforts;
	if (!isStringArrayOrNull(reasoningEfforts)) return null;
	if (typeof row.zdr !== "boolean") return null;
	// `category` is required string|null in the CLI's `parseModel`; a missing
	// category invalidates the row (fail-closed), it does not fail open.
	if (!isStringOrNull(row.category)) return null;
	// `minimumPlan` is optional in the CLI's parser: absent and explicit null
	// are different gates downstream (category access vs top-tier-only).
	const minimumPlan =
		"minimumPlan" in row ? (isNonEmptyString(row.minimumPlan) ? row.minimumPlan : null) : undefined;
	const aliases = isStringArray(row.aliases) ? row.aliases : [];
	return {
		id,
		aliases,
		hidden: row.hidden === true,
		contextLength,
		maxOutputTokens: maxOutputTokens ?? null,
		inputModalities: inputModalities ?? [],
		reasoningEfforts: reasoningEfforts ?? [],
		behaviorProfile,
		zdr: row.zdr,
		category: isNonEmptyString(row.category) ? row.category : null,
		minimumPlan,
		display: parseDisplay(row.display),
		pricing: parseRates(row.pricing),
	};
}

/**
 * Parse a catalog body. Throws when the document is structurally a catalog
 * failure (unsupported schemaVersion, missing metadata) — the caller reports
 * that as a discovery failure so the harness can keep its cached catalog.
 * Returns the (possibly empty) row list for a structurally valid document;
 * malformed rows are dropped, never guessed.
 */
export function parseCatalog(body: unknown): CatalogModel[] {
	if (!isRecord(body)) throw new Error("model catalog is not a JSON object");
	if (body.schemaVersion !== CATALOG_SCHEMA_VERSION) {
		throw new Error(`unsupported model catalog schemaVersion ${JSON.stringify(body.schemaVersion)}`);
	}
	if (!isNonEmptyString(body.catalogVersion)) throw new Error("model catalog is missing catalogVersion");
	if (!isPositiveInteger(body.refreshAfterSeconds)) {
		throw new Error("model catalog is missing a valid refreshAfterSeconds");
	}
	if (!Array.isArray(body.data)) throw new Error("model catalog is missing its data array");
	const models: CatalogModel[] = [];
	const seen = new Set<string>();
	for (const row of body.data) {
		const model = parseModelRow(row);
		if (model === null || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}
