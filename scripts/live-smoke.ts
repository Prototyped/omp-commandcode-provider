import { parseCatalog } from "../catalog.ts";
import { BASE_URL, COMMAND_CODE_VERSION } from "../constants.ts";
import registerCommandCode from "../index.ts";

const key = process.env.CC_KEY ?? process.env.COMMANDCODE_API_KEY;
if (!key) {
	console.error(
		"live-smoke: set CC_KEY, e.g. CC_KEY=$(omp token commandcode-alpha) bun scripts/live-smoke.ts",
	);
	process.exit(2);
}

type ProviderConfig = {
	streamSimple: (
		model: unknown,
		context: unknown,
		options: unknown,
	) => AsyncIterable<{ type: string; [key: string]: unknown }>;
};
let provider: ProviderConfig | undefined;
registerCommandCode({
	registerProvider(_name: string, config: ProviderConfig) {
		provider = config;
	},
	on() {},
} as never);
if (!provider) {
	console.error("live-smoke: provider registration failed");
	process.exit(2);
}
const registered: ProviderConfig = provider;

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = ""): void => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

console.log(`live-smoke: pin ${COMMAND_CODE_VERSION}`);

const whoami = await fetch(`${BASE_URL}/alpha/whoami`, { headers: { Authorization: `Bearer ${key}` } });
check(whoami.status === 200, `whoami 200`, `HTTP ${whoami.status}`);

const catalogResponse = await fetch(`${BASE_URL}/provider/v1/models?view=client`, {
	headers: { accept: "application/json" },
});
const catalog = (await catalogResponse.json()) as { catalogVersion?: string; data?: unknown[] };
const parsed = catalogResponse.ok ? parseCatalog(catalog) : [];
check(
	catalogResponse.ok && Array.isArray(catalog.data) && parsed.length === catalog.data.length,
	`catalog parsed`,
	`HTTP ${catalogResponse.status}, ${parsed.length}/${catalog.data?.length ?? 0} rows`,
);

if (catalog.catalogVersion) {
	const revalidated = await fetch(`${BASE_URL}/provider/v1/models?view=client`, {
		headers: { accept: "application/json", "if-none-match": `"${catalog.catalogVersion}"` },
	});
	check(revalidated.status === 304, "conditional GET 304", `HTTP ${revalidated.status}`);
}

const realFetch = globalThis.fetch;
let sentVersion: string | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	if (String(input).endsWith("/alpha/generate")) {
		sentVersion = new Headers((init?.headers as HeadersInit) ?? {}).get("x-command-code-version");
	}
	return realFetch(input, init);
}) as typeof fetch;

type DoneEvent = { type: string; message?: { stopReason?: unknown; usage?: Record<string, unknown> } };
const events: string[] = [];
let done: DoneEvent | null = null;
let failed: string | null = null;
try {
	for await (const event of registered.streamSimple(
		{
			id: "deepseek/deepseek-v4-flash",
			name: "smoke",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		{
			systemPrompt: "You are a protocol smoke test.",
			messages: [{ role: "user", content: "Reply with the single word: pong" }],
			tools: [],
		},
		{ apiKey: key, maxTokens: 32, temperature: 0 },
	)) {
		events.push(event.type);
		if (event.type === "error") failed = JSON.stringify(event.error ?? event).slice(0, 300);
		if (event.type === "done") done = event as unknown as DoneEvent;
	}
} catch (error) {
	failed = String(error).slice(0, 300);
} finally {
	globalThis.fetch = realFetch;
}

check(sentVersion === COMMAND_CODE_VERSION, `generate header = pin`, `sent ${sentVersion}`);
check(failed === null && done !== null, `generate turn completed`, failed ?? events.join(" "));
check(
	done !== null && typeof done.message?.stopReason === "string",
	`terminal stopReason`,
	String(done?.message?.stopReason),
);
const usage = done?.message?.usage;
check(
	usage !== null &&
		usage !== undefined &&
		typeof usage.input === "number" &&
		typeof usage.output === "number",
	`usage reported`,
	JSON.stringify(usage),
);

console.log(failures.length === 0 ? "live-smoke: ok" : `live-smoke: ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
