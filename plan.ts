/**
 * Plan access, ported from the CLI's `evaluateModelAccess` (1.88.3 bundle).
 *
 * The gateway 403s (`MODEL_NOT_IN_PLAN`) any model above the account's plan;
 * the CLI never offers those in the first place. It fetches
 * `/alpha/billing/subscriptions` (planId) and `/alpha/billing/credits`
 * (purchasedCredits, freeCredits), then filters:
 *
 *   - purchased or free credits bypass the plan entirely;
 *   - no planId → allowed (unknown account state fails open);
 *   - otherwise the model's `minimumPlan` must rank at or below the plan;
 *   - a model with no minimumPlan falls back to category access:
 *     `individual-go*` plans get `opensource` only; higher plans get both.
 *
 * Billing failure fails open (`fetchFailed` in the CLI's shape): an outage
 * must not empty the picker.
 */

const PLAN_RANK = [
	"individual-go",
	"individual-go-v1",
	"individual-goat",
	"individual-pro",
	"individual-pro-v1",
	"individual-provider",
	"individual-max",
	"individual-ultra",
	"teams-pro",
] as const;

/** Categories each plan tier may use; `opensource`-only up to goat. */
const PLAN_CATEGORIES: Record<string, readonly string[]> = {
	"individual-go": ["opensource"],
	"individual-go-v1": ["opensource"],
	"individual-goat": ["opensource"],
	"individual-pro": ["premium", "opensource"],
	"individual-pro-v1": ["premium", "opensource"],
	"individual-provider": ["premium", "opensource"],
	"individual-max": ["premium", "opensource"],
	"individual-ultra": ["premium", "opensource"],
	"teams-pro": ["premium", "opensource"],
};

export type PlanAccessInput = {
	planId: string | null;
	purchasedCredits: number;
	freeCredits: number;
	fetchFailed: boolean;
};

export type ModelPlanMeta = {
	minimumPlan?: string | null;
	category?: string | null;
};

export type AccessResult = { allowed: boolean; minimumPlan?: string };

const ALLOWED: AccessResult = { allowed: true };

// The CLI's `knownCategory` only recognizes these two; any other category is
// unknown and fails open.
const KNOWN_CATEGORIES: Record<string, true> = { premium: true, opensource: true };

function lockedUntil(minimumPlanId: string | null): AccessResult {
	return { allowed: false, minimumPlan: minimumPlanId ?? "individual-ultra" };
}

// Lowest plan rank that admits a category (CLI's `getMinimumPlanForModel`).
function minimumPlanForCategory(category: string): string | null {
	for (const planId of PLAN_RANK) {
		if (PLAN_CATEGORIES[planId]?.includes(category)) return planId;
	}
	return null;
}

function categoryAccess(allowedCategories: readonly string[], category: string): AccessResult {
	return allowedCategories.includes(category) ? ALLOWED : lockedUntil(minimumPlanForCategory(category));
}

function rankedAccess(planId: string, minimumPlan: string): AccessResult | undefined {
	const have = PLAN_RANK.indexOf(planId as (typeof PLAN_RANK)[number]);
	const need = PLAN_RANK.indexOf(minimumPlan as (typeof PLAN_RANK)[number]);
	if (have === -1 || need === -1) return undefined;
	return have >= need ? ALLOWED : lockedUntil(minimumPlan);
}

/**
 * Faithful port of the CLI's `evaluateModelAccess` (1.88.3 bundle): credits
 * bypass everything; absent/unknown plan or category fails open; an absent
 * `minimumPlan` falls back to the category gate; an explicit `null` is the
 * CLI's top-tier-only gate; a known `minimumPlan` ranks against the account
 * plan, falling back to the category gate when either plan id is unknown.
 * The CLI's `embeddedAccess` re-resolves the model against its built-in
 * snapshot catalog first — unreachable from an extension, and identity
 * against the single live catalog we read, so the port collapses to the
 * category-gate fallback.
 */
export function evaluateModelAccess(billing: PlanAccessInput, model: ModelPlanMeta): AccessResult {
	if (billing.fetchFailed) return ALLOWED;
	if (billing.purchasedCredits > 0 || billing.freeCredits > 0) return ALLOWED;
	if (!billing.planId) return ALLOWED;
	const access = PLAN_CATEGORIES[billing.planId];
	if (!access) return ALLOWED;
	const { category, minimumPlan } = model;
	if (!category || !(category in KNOWN_CATEGORIES)) return ALLOWED;
	if (minimumPlan === undefined) return categoryAccess(access, category);
	if (minimumPlan === null) return lockedUntil(null);
	return rankedAccess(billing.planId, minimumPlan) ?? categoryAccess(access, category);
}

type BillingBody = Record<string, unknown>;

async function fetchJson(url: string, apiKey: string, timeoutMs: number): Promise<BillingBody | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const body: unknown = await response.json();
		return body !== null && typeof body === "object" ? (body as BillingBody) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

const BILLING_TIMEOUT_MS = 8_000;

export type Billing = PlanAccessInput;

/** Fetch the account's plan state; any failure yields fetchFailed (fail open). */
export async function fetchBilling(apiKey: string, baseUrl: string): Promise<Billing> {
	const [subs, credits] = await Promise.all([
		fetchJson(`${baseUrl}/alpha/billing/subscriptions`, apiKey, BILLING_TIMEOUT_MS),
		fetchJson(`${baseUrl}/alpha/billing/credits`, apiKey, BILLING_TIMEOUT_MS),
	]);
	if (subs === null || credits === null) {
		return { planId: null, purchasedCredits: 0, freeCredits: 0, fetchFailed: true };
	}
	// shapes (2026-10-31): {success,data:{planId,…}} / {credits:{monthlyCredits,purchasedCredits,freeCredits,…}}
	const subsData = isRecord(subs.data) ? subs.data : {};
	const creditsObj = isRecord(credits.credits) ? credits.credits : {};
	return {
		planId: typeof subsData.planId === "string" ? subsData.planId : null,
		purchasedCredits: num(creditsObj.purchasedCredits),
		freeCredits: num(creditsObj.freeCredits),
		fetchFailed: false,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
