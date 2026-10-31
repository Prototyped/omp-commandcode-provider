import { afterEach, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_CODE_VERSION } from "../constants.ts";
import { getCatalogModelById, hasUnknownBehaviorProfile } from "../discovery.ts";
import registerCommandCode, {
	convertMessages,
	evaluateModelAccess,
	parseCatalog,
	readExcludedModels,
} from "../index.ts";
import { CLI_UPDATE_STATUS_KEY, checkCliUpdate, cliUpdateStatusText, pickLatestStable } from "../update.ts";

let provider;
let agentDir;
const realFetch = globalThis.fetch;

const handlers = new Map();

registerCommandCode({
	registerProvider(name, config) {
		assert.equal(name, "commandcode-alpha");
		provider = config;
	},
	on(event, handler) {
		handlers.set(event, handler);
	},
	pi: {
		getAgentDir: () => agentDir,
	},
});

afterEach(() => {
	globalThis.fetch = realFetch;
	if (agentDir) {
		rmSync(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	}
});

function mockFetch(impl) {
	globalThis.fetch = mock(impl);
}

function withAgentDir(modelsYaml) {
	agentDir = path.join(tmpdir(), `cmdcc-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(agentDir, { recursive: true });
	if (modelsYaml !== undefined) writeFileSync(path.join(agentDir, "models.yml"), modelsYaml);
	return agentDir;
}

function ndjsonResponse(lines) {
	return new Response(lines.join("\n"), {
		status: 200,
		headers: { "content-type": "application/x-ndjson" },
	});
}

const model = {
	id: "deepseek/deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "commandcode-generate",
	provider: "commandcode-alpha",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function runStream(
	lines,
	context = { systemPrompt: "", messages: [], tools: [] },
	options = { apiKey: "user_test" },
) {
	mockFetch(async () => ndjsonResponse(lines));
	return collect(provider.streamSimple(model, context, options));
}

// Builds one NDJSON frame; nested payloads are stringified at each level so no
// fixture ever hand-escapes quotes.
const frame = JSON.stringify;

// ---- Stream behavior ---------------------------------------------------------

test("truncated NDJSON stream fails instead of emitting done", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"text-start","id":"txt-0"}',
			'{"type":"text-delta","id":"txt-0","text":"partial"}',
		]),
	);

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	assert.equal(events.at(-1)?.type, "error");
	assert.match(events.at(-1)?.error?.errorMessage ?? "", /terminal event/i);
});

test("tool-call accepts the current args fallback", async () => {
	mockFetch(async (_input, init) => {
		assert.equal(init.headers["x-command-code-version"], "1.88.2");
		return ndjsonResponse([
			'{"type":"start"}',
			'{"type":"tool-call","toolCallId":"call_1","toolName":"get_weather","args":{"location":"Paris"}}',
			'{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":3,"totalTokens":13}}',
		]);
	});

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	const toolEnd = events.find((event) => event.type === "toolcall_end");
	assert.deepEqual(toolEnd?.toolCall?.arguments, { location: "Paris" });
	assert.equal(events.at(-1)?.message?.usage?.output, 3);
});

test("CMD_ZDR enables the strict zero-retention header", async () => {
	const previous = process.env.CMD_ZDR;
	process.env.CMD_ZDR = "1";
	try {
		let zdrHeader;
		mockFetch(async (_input, init) => {
			zdrHeader = init.headers["x-cmd-zdr"];
			return ndjsonResponse(['{"type":"finish","finishReason":"stop","totalUsage":{"totalTokens":0}}']);
		});

		const events = await collect(
			provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
		);

		assert.equal(zdrHeader, "1");
		assert.equal(events.at(-1)?.type, "done");
	} finally {
		if (previous === undefined) delete process.env.CMD_ZDR;
		else process.env.CMD_ZDR = previous;
	}
});

// ---- Stream — content blocks ---------------------------------------------------

test("text block streams start/delta/end into one accumulated text block", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"text-start","id":"txt-0"}',
		'{"type":"text-delta","id":"txt-0","text":"Hel"}',
		'{"type":"text-delta","id":"txt-0","text":"lo"}',
		'{"type":"text-end","id":"txt-0"}',
		'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":2,"outputTokens":1}}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).reason, "stop");
	assert.deepEqual(events.at(-1).message.content, [{ type: "text", text: "Hello" }]);
	assert.equal(
		events
			.filter((e) => e.type === "text_delta")
			.map((e) => e.delta)
			.join(""),
		"Hello",
	);
	const end = events.find((e) => e.type === "text_end");
	assert.equal(end.contentIndex, 0);
	assert.equal(end.content, "Hello");
	assert.equal(
		events.some((e) => e.type === "text_start"),
		true,
	);
});

test("consecutive text blocks keep per-id content separate", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"text-start","id":"txt-0"}',
		'{"type":"text-delta","id":"txt-0","text":"a"}',
		'{"type":"text-end","id":"txt-0"}',
		'{"type":"text-start","id":"txt-1"}',
		'{"type":"text-delta","id":"txt-1","text":"bc"}',
		'{"type":"text-end","id":"txt-1"}',
		'{"type":"finish","finishReason":"stop"}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.deepEqual(events.at(-1).message.content, [
		{ type: "text", text: "a" },
		{ type: "text", text: "bc" },
	]);
	const ends = events.filter((e) => e.type === "text_end");
	assert.equal(ends[0].contentIndex, 0);
	assert.equal(ends[0].content, "a");
	assert.equal(ends[1].contentIndex, 1);
	assert.equal(ends[1].content, "bc");
});

test("reasoning events stream into a thinking block", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"reasoning-start","id":"r-0"}',
		'{"type":"reasoning-delta","id":"r-0","text":"I "}',
		'{"type":"reasoning-delta","id":"r-0","text":"think"}',
		'{"type":"reasoning-end","id":"r-0"}',
		'{"type":"text-start","id":"txt-0"}',
		'{"type":"text-delta","id":"txt-0","text":"done"}',
		'{"type":"text-end","id":"txt-0"}',
		'{"type":"finish","finishReason":"stop"}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.deepEqual(events.at(-1).message.content, [
		{ type: "thinking", thinking: "I think" },
		{ type: "text", text: "done" },
	]);
	assert.equal(
		events
			.filter((e) => e.type === "thinking_delta")
			.map((e) => e.delta)
			.join(""),
		"I think",
	);
	const end = events.find((e) => e.type === "thinking_end");
	assert.equal(end.contentIndex, 0);
	assert.equal(end.content, "I think");
});

test("full turn: reasoning, text, and interleaved tool calls route per id", async () => {
	const events = await runStream([
		frame({ type: "start" }),
		frame({ type: "reasoning-start", id: "r-0" }),
		frame({ type: "reasoning-delta", id: "r-0", text: "pick" }),
		frame({ type: "reasoning-end", id: "r-0" }),
		frame({ type: "text-start", id: "txt-0" }),
		frame({ type: "text-delta", id: "txt-0", text: "calling" }),
		frame({ type: "text-end", id: "txt-0" }),
		frame({ type: "tool-input-start", toolCallId: "call_1", toolName: "fetch" }),
		frame({ type: "tool-input-start", toolCallId: "call_2", toolName: "grep" }),
		frame({ type: "tool-input-delta", toolCallId: "call_1", delta: JSON.stringify({ u: "a" }) }),
		frame({ type: "tool-input-delta", toolCallId: "call_2", delta: JSON.stringify({ p: "b" }) }),
		frame({ type: "tool-input-end", toolCallId: "call_1" }),
		frame({ type: "tool-input-end", toolCallId: "call_2" }),
		frame({ type: "finish", finishReason: "tool-calls" }),
	]);

	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).reason, "toolUse");
	assert.deepEqual(events.at(-1).message.content, [
		{ type: "thinking", thinking: "pick" },
		{ type: "text", text: "calling" },
		{ type: "toolCall", id: "call_1", name: "fetch", arguments: { u: "a" } },
		{ type: "toolCall", id: "call_2", name: "grep", arguments: { p: "b" } },
	]);
	const ends = events.filter((e) => e.type === "toolcall_end");
	assert.equal(ends.length, 2);
	assert.deepEqual(ends[0].toolCall, {
		type: "toolCall",
		id: "call_1",
		name: "fetch",
		arguments: { u: "a" },
	});
	assert.deepEqual(ends[1].toolCall, {
		type: "toolCall",
		id: "call_2",
		name: "grep",
		arguments: { p: "b" },
	});
});

// ---- Stream — tool-call parsing -------------------------------------------------

test("tool-input-delta accumulates partial JSON across chunks", async () => {
	const payload = JSON.stringify({ location: "Paris" });
	const events = await runStream([
		frame({ type: "start" }),
		frame({ type: "tool-input-start", toolCallId: "call_1", toolName: "get_weather" }),
		frame({ type: "tool-input-delta", toolCallId: "call_1", delta: payload.slice(0, 4) }),
		frame({ type: "tool-input-delta", toolCallId: "call_1", delta: payload.slice(4, 13) }),
		frame({ type: "tool-input-delta", toolCallId: "call_1", delta: payload.slice(13) }),
		frame({ type: "tool-input-end", toolCallId: "call_1" }),
		frame({ type: "finish", finishReason: "tool-calls" }),
	]);

	// The deltas the harness receives must reassemble to the exact payload.
	const deltas = events.filter((e) => e.type === "toolcall_delta").map((e) => e.delta);
	assert.deepEqual(JSON.parse(deltas.join("")), { location: "Paris" });

	const end = events.find((e) => e.type === "toolcall_end");
	assert.deepEqual(end.toolCall, {
		type: "toolCall",
		id: "call_1",
		name: "get_weather",
		arguments: { location: "Paris" },
	});
});

test("a trailing tool-call for an ended id does not double-emit toolcall_end", async () => {
	const events = await runStream([
		frame({ type: "start" }),
		frame({ type: "tool-input-start", toolCallId: "call_1", toolName: "t" }),
		frame({ type: "tool-input-delta", toolCallId: "call_1", delta: '{"a":1}' }),
		frame({ type: "tool-input-end", toolCallId: "call_1" }),
		frame({ type: "tool-call", toolCallId: "call_1", toolName: "t", input: { a: 2 } }),
		frame({ type: "finish", finishReason: "tool-calls" }),
	]);

	assert.equal(events.at(-1).type, "done");
	const ends = events.filter((e) => e.type === "toolcall_end");
	assert.equal(ends.length, 1);
	// The end event was already emitted at tool-input-end with the accumulated
	// deltas; the trailing tool-call updates the final message's arguments only.
	assert.deepEqual(ends[0].toolCall, { type: "toolCall", id: "call_1", name: "t", arguments: { a: 1 } });
	const toolBlock = events.at(-1).message.content.find((b) => b.type === "toolCall");
	assert.deepEqual(toolBlock.arguments, { a: 2 });
	assert.equal(events.at(-1).message.content.filter((b) => b.type === "toolCall").length, 1);
});

test("a bare tool-call event accepts the id and name spellings", async () => {
	const events = await runStream([
		frame({ type: "start" }),
		frame({ type: "tool-call", id: "call_x", name: "lookup", input: { q: 1 } }),
		frame({ type: "finish", finishReason: "tool-calls" }),
	]);

	assert.equal(
		events.some((e) => e.type === "toolcall_start"),
		true,
	);
	const end = events.find((e) => e.type === "toolcall_end");
	assert.deepEqual(end.toolCall, { type: "toolCall", id: "call_x", name: "lookup", arguments: { q: 1 } });
});

test("deltas for unknown block ids are ignored", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"text-delta","id":"ghost","text":"x"}',
		'{"type":"reasoning-delta","id":"ghost","text":"x"}',
		'{"type":"tool-input-delta","toolCallId":"ghost","delta":"{}"}',
		'{"type":"finish","finishReason":"stop"}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.deepEqual(events.at(-1).message.content, []);
});

// ---- Stream — stop reasons -------------------------------------------------------

test("finishReason length maps to stopReason length", async () => {
	const events = await runStream(['{"type":"start"}', '{"type":"finish","finishReason":"length"}']);

	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).reason, "length");
	assert.deepEqual(events.at(-1).message.usage, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});

test("finishReason tool_calls and tool_use spellings map to toolUse", async () => {
	const eventsA = await runStream(['{"type":"start"}', '{"type":"finish","finishReason":"tool_calls"}']);
	assert.equal(eventsA.at(-1).reason, "toolUse");

	const eventsB = await runStream(['{"type":"start"}', '{"type":"finish","finishReason":"tool_use"}']);
	assert.equal(eventsB.at(-1).reason, "toolUse");
});

test("stop with emitted tool calls still routes as tool use", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"tool-input-start","toolCallId":"call_1","toolName":"t"}',
		'{"type":"tool-input-end","toolCallId":"call_1"}',
		'{"type":"finish","finishReason":"stop"}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).reason, "toolUse");
});

test("rawFinishReason is used when finishReason is absent", async () => {
	const events = await runStream(['{"type":"start"}', '{"type":"finish","rawFinishReason":"tool_use"}']);

	assert.equal(events.at(-1).reason, "toolUse");
});

// ---- Session cost from catalog rates -------------------------------------------
// The stream reports usage, not USD; cost is the catalog's pricing rates.

const catalogPricedModel = {
	...model,
	cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
};

test("cost is computed from the model rates over final usage", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":762,"outputTokens":1}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(
			catalogPricedModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test" },
		),
	);

	const done = events.at(-1);
	assert.equal(done?.type, "done");
	assert.equal(done.message.usage.input, 762);
	// 762 * 0.15 / 1e6 + 1 * 0.6 / 1e6
	expect(done.message.usage.cost.total).toBeCloseTo(762 * 0.15e-6 + 0.6e-6, 15);
});

test("cache reads price at the cacheRead rate and shrink the billed input", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":762,"inputTokenDetails":{"cacheReadTokens":512},"outputTokens":1}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(
			catalogPricedModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test" },
		),
	);

	const usage = events.at(-1).message.usage;
	assert.equal(usage.input, 250);
	assert.equal(usage.cacheRead, 512);
	// 250 * 0.15 + 1 * 0.6 + 512 * 0.003, per 1M
	expect(usage.cost.total).toBeCloseTo((250 * 0.15 + 0.6 + 512 * 0.003) / 1e6, 15);
});

test("cache-write-tokens patches usage when finish reported none", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":100,"outputTokens":2}}',
			'{"type":"cache-write-tokens","cacheWriteTokens":30}',
		]),
	);

	const events = await collect(
		provider.streamSimple(
			catalogPricedModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test" },
		),
	);

	const usage = events.at(-1).message.usage;
	assert.equal(usage.cacheWrite, 30);
	// (100+2 out) priced + 30 written at cacheWrite rate 0
	assert.equal(usage.cost.total, (100 * 0.15 + 2 * 0.6) / 1e6);
});

test("provider-metadata supplies the anthropic 1h cache-write split", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":100,"inputTokenDetails":{"cacheWriteTokens":40},"outputTokens":2}}',
			'{"type":"provider-metadata","providerMetadata":{"anthropic":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":25}}}}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(
			catalogPricedModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test" },
		),
	);

	// 1h (25) is a subset of the reported cacheWrite (40) — nothing added.
	assert.equal(events.at(-1).message.usage.cacheWrite, 40);
});

// ---- Stream — usage & terminal events ------------------------------------------

test("usage splits total input into disjoint input and cacheRead (snake_case input_tokens)", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"finish","finishReason":"stop","totalUsage":{"input_tokens":100,"cachedInputTokens":40,"outputTokens":5}}',
	]);

	const usage = events.at(-1).message.usage;
	assert.equal(usage.input, 60);
	assert.equal(usage.cacheRead, 40);
	assert.equal(usage.output, 5);
	assert.equal(usage.totalTokens, 105);
});

test("cacheRead falls back to inputTokenDetails then raw prompt_cache_hit_tokens", async () => {
	const eventsA = await runStream([
		'{"type":"start"}',
		'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":100,"inputTokenDetails":{"cacheReadTokens":10},"outputTokens":2}}',
	]);
	assert.equal(eventsA.at(-1).message.usage.input, 90);
	assert.equal(eventsA.at(-1).message.usage.cacheRead, 10);

	const eventsB = await runStream([
		'{"type":"start"}',
		'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":100,"raw":{"prompt_cache_hit_tokens":25},"outputTokens":2}}',
	]);
	assert.equal(eventsB.at(-1).message.usage.input, 75);
	assert.equal(eventsB.at(-1).message.usage.cacheRead, 25);
});

test("provider-metadata without a finish event is not terminal", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"provider-metadata","providerMetadata":{"novita":{}}}',
	]);

	assert.equal(events.at(-1).type, "error");
	assert.match(events.at(-1).error.errorMessage, /ended before a terminal event/);
});

// ---- Stream — errors & transport -------------------------------------------------

test("error events surface the gateway message; a bare error gets a generic one", async () => {
	const eventsA = await runStream(['{"type":"start"}', '{"type":"error","message":"upstream exploded"}']);
	assert.equal(eventsA.at(-1).type, "error");
	assert.equal(eventsA.at(-1).reason, "error");
	assert.match(eventsA.at(-1).error.errorMessage, /upstream exploded/);

	const eventsB = await runStream([
		'{"type":"start"}',
		'{"type":"error","error":{"type":"server_error","message":"model down","statusCode":400}}',
	]);
	assert.equal(
		eventsB.at(-1).error.errorMessage,
		"Command Code stream error: server_error: model down (status 400)",
	);

	const eventsD = await runStream([
		'{"type":"start"}',
		'{"type":"error","error":{"type":"rate_limited","message":"slow down","statusCode":429,"isRetryable":true}}',
	]);
	assert.equal(
		eventsD.at(-1).error.errorMessage,
		"Command Code stream error: rate_limited: slow down (status 429) [retryable=true]",
	);

	const eventsC = await runStream(['{"type":"start"}', '{"type":"error"}']);
	assert.equal(eventsC.at(-1).error.errorMessage, "Command Code stream error: Command Code stream error");
});

test("non-OK responses surface status and body detail", async () => {
	mockFetch(async () => new Response("rate limited", { status: 500 }));

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);
	assert.equal(events.at(-1).type, "error");
	assert.equal(events.at(-1).error.stopReason, "error");
	assert.match(events.at(-1).error.errorMessage, /Command Code 500: rate limited/);
});

test("a 200 response without a body fails as a protocol error", async () => {
	mockFetch(async () => new Response(null));

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);
	assert.equal(events.at(-1).type, "error");
	assert.match(events.at(-1).error.errorMessage, /Command Code 200/);
});

test("an already-aborted signal maps to stopReason aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	mockFetch(async () => {
		throw new Error("The operation was aborted.");
	});

	const events = await collect(
		provider.streamSimple(
			model,
			{ systemPrompt: "", messages: [], tools: [] },
			{ apiKey: "user_test", signal: controller.signal },
		),
	);
	assert.equal(events.at(-1).type, "error");
	assert.equal(events.at(-1).reason, "aborted");
	assert.equal(events.at(-1).error.stopReason, "aborted");
});

// ---- Request envelope --------------------------------------------------------------

test("request body is the full /alpha/generate envelope", async () => {
	let body;
	let headers;
	const sessionId = "11111111-2222-4333-8444-555555555555";
	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		headers = init.headers;
		return ndjsonResponse(['{"type":"finish","finishReason":"stop"}']);
	});

	const context = {
		systemPrompt: "sys",
		messages: [{ role: "user", content: "hi" }],
		tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
	};
	await collect(provider.streamSimple(model, context, { apiKey: "user_test", sessionId }));

	assert.deepEqual(Object.keys(body).sort(), [
		"config",
		"memory",
		"params",
		"permissionMode",
		"skills",
		"taste",
		"threadId",
	]);
	assert.equal(body.memory, "");
	assert.equal(body.taste, null);
	assert.equal(body.skills, null);
	assert.equal(body.permissionMode, "standard");
	assert.equal(body.threadId, sessionId);
	assert.equal(headers["x-session-id"], sessionId);
	assert.equal(headers.Authorization, "Bearer user_test");
	assert.equal(headers["Content-Type"], "application/json");
	assert.equal(headers.Accept, "application/x-ndjson");
	assert.equal(headers["User-Agent"], "cli");
	assert.equal(headers["x-cli-environment"], "production");

	assert.equal(body.config.workingDir, process.cwd());
	assert.equal(body.config.isGitRepo, false);
	assert.match(body.config.date, /^\d{4}-\d{2}-\d{2}$/);
	assert.deepEqual(Object.keys(body.config).sort(), [
		"currentBranch",
		"date",
		"environment",
		"gitStatus",
		"isGitRepo",
		"mainBranch",
		"recentCommits",
		"structure",
		"workingDir",
	]);
	assert.deepEqual(body.params, {
		model: model.id,
		system: "sys",
		messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
		max_tokens: model.maxTokens,
		stream: true,
	});
	assert.equal("temperature" in body.params, false);
	assert.equal("reasoning_effort" in body.params, false);

	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return ndjsonResponse(['{"type":"finish","finishReason":"stop"}']);
	});
	await collect(
		provider.streamSimple(model, context, {
			apiKey: "user_test",
			sessionId,
			temperature: 0.2,
			maxTokens: 1234,
		}),
	);
	assert.equal(body.params.temperature, 0.2);
	assert.equal(body.params.max_tokens, 1234);

	// reasoning_effort: sent only when the caller asks (and the model reasons),
	// clamped to the catalog's supported list; never an unlisted value, never
	// "off" for an explicit effort; disableReasoning maps to "off" when listed.
	const thinkingModel = { ...model, thinking: { mode: "effort", efforts: ["off", "low", "high", "max"] } };
	const runReasoning = (opts) =>
		collect(
			provider.streamSimple(
				thinkingModel,
				{ systemPrompt: "", messages: [], tools: [] },
				{
					apiKey: "user_test",
					...opts,
				},
			),
		).then(() => body.params.reasoning_effort);
	assert.equal(await runReasoning({ reasoning: "high" }), "high"); // listed, passes through
	assert.equal(await runReasoning({ reasoning: "minimal" }), "low"); // nearest on-effort (never clamps to off)
	assert.equal(await runReasoning({ reasoning: "medium" }), "low"); // tie between low/high resolves lower
	assert.equal(await runReasoning({ reasoning: "xhigh" }), "high"); // nearest below
	assert.equal(await runReasoning({ disableReasoning: true }), "off"); // listed, sent
	assert.equal(await runReasoning({}), undefined); // no request, no field
	// disableReasoning with no "off" in the list is omitted, not sent
	const noOffModel = { ...model, thinking: { mode: "effort", efforts: ["low", "high"] } };
	await collect(
		provider.streamSimple(
			noOffModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{
				apiKey: "user_test",
				disableReasoning: true,
			},
		),
	);
	assert.equal("reasoning_effort" in body.params, false);
	// a non-reasoning model never gets a reasoning_effort
	const nonReasoningModel = { ...model, reasoning: false, thinking: { mode: "effort", efforts: ["low"] } };
	await collect(
		provider.streamSimple(
			nonReasoningModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{
				apiKey: "user_test",
				reasoning: "high",
			},
		),
	);
	assert.equal("reasoning_effort" in body.params, false);

	// pi-ai hands the system prompt as parts (string[]); the gateway's
	// params.system schema rejects an array (400 "expected string, received
	// array", observed 2026-10-31) — the parts must go out joined.
	mockFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return ndjsonResponse(['{"type":"finish","finishReason":"stop"}']);
	});
	await collect(
		provider.streamSimple(
			model,
			{ ...context, systemPrompt: ["part one", "part two"] },
			{ apiKey: "user_test", sessionId },
		),
	);
	assert.equal(body.params.system, "part one\n\npart two");
});

test("x-session-id is a stable RFC 4122 UUID per conversation", async () => {
	const seen = [];
	mockFetch(async (_url, init) => {
		seen.push({ sessionId: init.headers["x-session-id"], threadId: JSON.parse(init.body).threadId });
		return ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1}}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":1,"outputTokens":1}}',
		]);
	});

	const context = { systemPrompt: "sys", messages: [{ role: "user", content: "first question" }], tools: [] };
	await collect(provider.streamSimple(model, context, { apiKey: "user_test" }));
	await collect(provider.streamSimple(model, context, { apiKey: "user_test" }));
	const other = { ...context, messages: [{ role: "user", content: "a different conversation" }] };
	await collect(provider.streamSimple(model, other, { apiKey: "user_test" }));

	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
	assert.match(seen[0].sessionId, uuid);
	assert.equal(seen[1].sessionId, seen[0].sessionId);
	assert.notEqual(seen[2].sessionId, seen[0].sessionId);

	// A harness-supplied sessionId wins when it is a UUID...
	await collect(
		provider.streamSimple(model, context, {
			apiKey: "user_test",
			sessionId: "11111111-2222-4333-8444-555555555555",
		}),
	);
	assert.equal(seen[3].sessionId, "11111111-2222-4333-8444-555555555555");

	// ...a non-UUID one is ignored in favor of the derived id.
	await collect(provider.streamSimple(model, context, { apiKey: "user_test", sessionId: "not-a-uuid" }));
	assert.equal(seen[4].sessionId, seen[0].sessionId);

	// Array prompt parts canonicalize the same way as the request body's
	// joined string, so both forms of the same prompt keep one identity.
	await collect(
		provider.streamSimple(
			model,
			{ ...context, systemPrompt: ["first line", "second line"] },
			{ apiKey: "user_test" },
		),
	);
	await collect(
		provider.streamSimple(
			model,
			{ ...context, systemPrompt: "first line\n\nsecond line" },
			{ apiKey: "user_test" },
		),
	);
	assert.match(seen[5].sessionId, uuid);
	assert.equal(seen[6].sessionId, seen[5].sessionId);
	assert.notEqual(seen[5].sessionId, seen[0].sessionId);

	// The body's threadId mirrors the header on every call.
	for (const call of seen) assert.equal(call.threadId, call.sessionId);
});

// ---- /login flow ----------------------------------------------------------------

test("login returns the trimmed key after a successful whoami check", async () => {
	let whoamiUrl;
	let whoamiAuth;
	mockFetch(async (url, init) => {
		whoamiUrl = url;
		whoamiAuth = init?.headers?.Authorization;
		return new Response("{}", { status: 200 });
	});

	const key = await provider.oauth.login({
		onPrompt: async () => "  user_test123  ",
	});

	assert.equal(key, "user_test123");
	assert.equal(whoamiUrl, "https://api.commandcode.ai/alpha/whoami");
	assert.equal(whoamiAuth, "Bearer user_test123");
});

test("login rejects a key that whoami answers 401 for", async () => {
	mockFetch(async () => new Response("{}", { status: 401 }));

	await expect(provider.oauth.login({ onPrompt: async () => "user_bad" })).rejects.toThrow(/401/);
});

test("login keeps the key on 403, like the CLI does", async () => {
	mockFetch(async () => new Response("{}", { status: 403 }));

	await expect(provider.oauth.login({ onPrompt: async () => "user_test123" })).resolves.toBe("user_test123");
});

test("login keeps the key when the whoami check is unreachable", async () => {
	mockFetch(async () => {
		throw new Error("ENOTFOUND");
	});

	await expect(provider.oauth.login({ onPrompt: async () => "user_test123" })).resolves.toBe("user_test123");
});

test("login rejects an empty prompt", async () => {
	await expect(provider.oauth.login({ onPrompt: async () => "   " })).rejects.toThrow(/Login cancelled/);
});

// ---- Live model discovery from the gateway catalog -------------------------------

function catalogRow(overrides = {}) {
	return {
		id: "deepseek/deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		display: { label: "DeepSeek V4 Flash" },
		aliases: [],
		hidden: null,
		context_length: 1_000_000,
		maxOutputTokens: null,
		inputModalities: ["text"],
		reasoningEfforts: ["off", "low", "high", "max"],
		behaviorProfile: "standard-v1",
		zdr: true,
		category: "opensource",
		minimumPlan: "individual-go",
		pricing: { inputCost: 0.15, outputCost: 0.6, cacheReadCost: 0.003 },
		...overrides,
	};
}

function catalogBody(rows) {
	return Response.json({
		schemaVersion: 1,
		catalogVersion: "c1",
		refreshAfterSeconds: 900,
		roles: {},
		data: rows,
	});
}

function discoveryFetch({ catalog = () => catalogBody([]) } = {}) {
	mockFetch(async (url) => {
		if (url === "https://api.commandcode.ai/provider/v1/models?view=client") return catalog();
		throw new Error(`unexpected fetch: ${url}`);
	});
}

test("fetchDynamicModels maps catalog rows to harness models with rates", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			catalogBody([
				catalogRow(),
				catalogRow({
					id: "moonshotai/Kimi-K3",
					inputModalities: ["text", "image"],
					reasoningEfforts: [],
					maxOutputTokens: 131_072,
				}),
			]),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["deepseek/deepseek-v4-flash", "moonshotai/Kimi-K3"],
	);
	const flash = models[0];
	assert.equal(flash.reasoning, true);
	// The harness reads `thinking.efforts` for the effort picker; without it
	// the request's reasoning effort can't be clamped to the catalog list.
	assert.deepEqual(flash.thinking, { mode: "effort", efforts: ["off", "low", "high", "max"] });
	assert.deepEqual(flash.input, ["text"]);
	assert.equal(flash.contextWindow, 1_000_000);
	// null maxOutputTokens clamps to the gateway's hard cap
	assert.equal(flash.maxTokens, 200_000);
	assert.deepEqual(flash.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
	const kimi = models[1];
	assert.equal(kimi.reasoning, false);
	assert.equal(kimi.thinking, undefined);
	assert.deepEqual(kimi.input, ["text", "image"]);
	assert.equal(kimi.maxTokens, 131_072);
});

test("fetchDynamicModels drops hidden rows and honors excludedModels", async () => {
	withAgentDir(`providers:
  commandcode-alpha:
    apiKey: user_test
    excludedModels:
      - "deepseek/deepseek-v4-flash"
`);
	discoveryFetch({
		catalog: () =>
			catalogBody([
				catalogRow(),
				catalogRow({ id: "secret/model", hidden: true }),
				catalogRow({ id: "moonshotai/Kimi-K3" }),
			]),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["moonshotai/Kimi-K3"],
	);
	// Hidden rows are excluded from discovery but their catalog records are
	// kept so a user-supplied id still resolves to real capabilities.
	const hidden = getCatalogModelById("secret/model");
	assert.equal(hidden.hidden, true);
	assert.equal(hidden.contextLength, 1_000_000);
	assert.deepEqual(hidden.reasoningEfforts, ["off", "low", "high", "max"]);
	assert.equal(getCatalogModelById("never/listed"), undefined);
});

test("getCatalogModelById resolves by id or alias from the full catalog", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			catalogBody([
				catalogRow({ id: "moonshotai/Kimi-K3", hidden: true, aliases: ["kimi-k3"] }),
				catalogRow({ id: "visible/model" }),
			]),
	});
	await provider.fetchDynamicModels("user_test");
	const byId = getCatalogModelById("moonshotai/Kimi-K3");
	assert.equal(byId.hidden, true);
	assert.equal(byId.aliases.includes("kimi-k3"), true);
	assert.equal(getCatalogModelById("kimi-k3"), byId); // alias resolves to the same record
	// The full catalog (not just hidden rows) is the lookup domain.
	assert.equal(getCatalogModelById("visible/model")?.hidden, false);
	assert.equal(getCatalogModelById("never/listed"), undefined);
});

test("catalog fetch failures reject, so the harness keeps its cached catalog", async () => {
	withAgentDir();
	discoveryFetch({ catalog: () => new Response("{}", { status: 500 }) });
	await assert.rejects(provider.fetchDynamicModels("user_test"), /HTTP 500/);
	mockFetch(async () => {
		throw new Error("offline");
	});
	await assert.rejects(provider.fetchDynamicModels("user_test"), /offline/);
});

test("an unsupported schema version rejects, so the harness keeps its cached catalog", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			Response.json({ schemaVersion: 2, catalogVersion: "x", refreshAfterSeconds: 1, data: [catalogRow()] }),
	});
	await assert.rejects(provider.fetchDynamicModels("user_test"), /schemaVersion 2/);
});

test("a valid empty catalog registers no models without reporting a failure", async () => {
	withAgentDir();
	discoveryFetch({ catalog: () => catalogBody([]) });
	assert.deepEqual(await provider.fetchDynamicModels("user_test"), []);
});

test("fetchDynamicModels drops malformed rows but keeps good ones", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			catalogBody([
				{ id: "bad/row" },
				catalogRow({ context_length: -5 }),
				catalogRow({ id: "moonshotai/Kimi-K3" }),
			]),
	});
	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["moonshotai/Kimi-K3"],
	);
});

test("catalog fetch uses conditional GET and honors a 304 with the cached body", async () => {
	withAgentDir();
	const seenHeaders = [];
	mockFetch(async (url, init) => {
		// Billing fetches fail open; only the catalog request is observed here.
		if (url !== "https://api.commandcode.ai/provider/v1/models?view=client") {
			throw new Error(`unexpected fetch: ${url}`);
		}
		seenHeaders.push(init?.headers ?? {});
		if (init?.headers?.["if-none-match"] === '"c-cond"') return new Response(null, { status: 304 });
		return Response.json({
			schemaVersion: 1,
			catalogVersion: "c-cond",
			refreshAfterSeconds: 900,
			roles: {},
			data: [catalogRow({ id: "cond/model", context_length: 50_000, maxOutputTokens: 8_192 })],
		});
	});

	const first = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		first.map((m) => m.id),
		["cond/model"],
	);
	// The second call sends the etag back; the 304 answer serves the cached body.
	const second = await provider.fetchDynamicModels("user_test");
	assert.equal(seenHeaders.length, 2);
	assert.equal(seenHeaders[1]["if-none-match"], '"c-cond"');
	assert.equal(second.length, 1);
	assert.equal(second[0].id, "cond/model");
	// Cached rows keep their real capabilities (not a bare etag stub).
	assert.equal(second[0].contextWindow, 50_000);
	assert.equal(second[0].maxTokens, 8_192);
});

test("a user-configured model is augmented from the catalog", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			catalogBody([
				// Same id as the shared `model` below: a models.yml entry for a
				// catalog model.
				catalogRow({
					inputModalities: ["text", "image"],
					reasoningEfforts: ["off", "low", "high"],
					pricing: { inputCost: 1, outputCost: 2, cacheReadCost: 0.1 },
				}),
			]),
	});
	await provider.fetchDynamicModels("user_test");

	// What the harness passes for a models.yml entry: the id the user wrote,
	// harness defaults for the rest (text-only, no reasoning, zero rates).
	const bare = {
		...model,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let body;
	mockFetch(async (url, init) => {
		if (!url.includes("/alpha/generate")) throw new Error(`unexpected fetch: ${url}`);
		body = JSON.parse(init.body);
		return ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":3000,"outputTokens":1000,"cachedInputTokens":2000}}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":3000,"outputTokens":1000,"cachedInputTokens":2000}}',
		]);
	});
	const events = await collect(
		provider.streamSimple(
			bare,
			{
				systemPrompt: "",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "see" },
							{ type: "image", data: "AAA=", mimeType: "image/png" },
						],
					},
				],
				tools: [],
			},
			{ apiKey: "user_test", reasoning: "max" },
		),
	);
	// Vision per the catalog: the image rides along instead of being stripped.
	assert.match(JSON.stringify(body.params.messages), /data:image\/png;base64,AAA=/);
	// The catalog says the model reasons: effort is sent, clamped to the list.
	assert.equal(body.params.reasoning_effort, "high");
	// Catalog rates meter the turn: 1000 uncached in, 2000 cache-read, 1000 out.
	const cost = events.at(-1).message.usage.cost;
	assert.ok(Math.abs(cost.total - 0.0032) < 1e-12);
});

// ---- Plan gating -------------------------------------------------------------------

test("evaluateModelAccess ports the CLI rank rule", async () => {
	const go = { planId: "individual-go-v1", purchasedCredits: 0, freeCredits: 0, fetchFailed: false };
	assert.equal(
		evaluateModelAccess(go, { minimumPlan: "individual-go", category: "opensource" }).allowed,
		true,
	);
	assert.equal(
		evaluateModelAccess(go, { minimumPlan: "individual-goat", category: "opensource" }).allowed,
		false,
	);
	// an absent minimumPlan falls back to the category gate
	assert.equal(evaluateModelAccess(go, { category: "opensource" }).allowed, true);
	// premium is out of reach for Go even without a minimumPlan
	assert.equal(evaluateModelAccess(go, { category: "premium" }).allowed, false);
	// an explicit null minimumPlan is the CLI's top-tier-only gate
	assert.equal(evaluateModelAccess(go, { minimumPlan: null, category: "opensource" }).allowed, false);
	// unknown categories fail open, like the CLI's knownCategory
	assert.equal(
		evaluateModelAccess(go, { minimumPlan: "individual-max", category: "experimental" }).allowed,
		true,
	);
	const goat = { planId: "individual-goat", purchasedCredits: 0, freeCredits: 0, fetchFailed: false };
	assert.equal(
		evaluateModelAccess(goat, { minimumPlan: "individual-go", category: "opensource" }).allowed,
		true,
	);
	assert.equal(evaluateModelAccess(goat, { category: "premium" }).allowed, false);
});

test("credits bypass the plan and billing failure fails open", async () => {
	const withCredits = {
		planId: "individual-go-v1",
		purchasedCredits: 1.5,
		freeCredits: 0,
		fetchFailed: false,
	};
	assert.equal(
		evaluateModelAccess(withCredits, { minimumPlan: "individual-max", category: "premium" }).allowed,
		true,
	);
	const failed = { planId: null, purchasedCredits: 0, freeCredits: 0, fetchFailed: true };
	assert.equal(
		evaluateModelAccess(failed, { minimumPlan: "individual-max", category: "premium" }).allowed,
		true,
	);
});

test("fetchDynamicModels filters models above the account plan", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () =>
			catalogBody([
				catalogRow(),
				catalogRow({ id: "meta/muse-spark-1.3", minimumPlan: "individual-goat" }),
				catalogRow({ id: "claude-opus-5", category: "premium", minimumPlan: "individual-provider" }),
			]),
	});
	// billing endpoints answer the Go plan
	mockFetch(async (url) => {
		if (url === "https://api.commandcode.ai/provider/v1/models?view=client") {
			return catalogBody([
				catalogRow(),
				catalogRow({ id: "meta/muse-spark-1.3", minimumPlan: "individual-goat" }),
				catalogRow({ id: "claude-opus-5", category: "premium", minimumPlan: "individual-provider" }),
			]);
		}
		if (url === "https://api.commandcode.ai/alpha/billing/subscriptions") {
			return Response.json({ success: true, data: { planId: "individual-go-v1", status: "active" } });
		}
		if (url === "https://api.commandcode.ai/alpha/billing/credits") {
			return Response.json({ credits: { monthlyCredits: 8.7, purchasedCredits: 0, freeCredits: 0 } });
		}
		throw new Error(`unexpected fetch: ${url}`);
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["deepseek/deepseek-v4-flash"],
	);
});

// ---- Pure helpers ------------------------------------------------------------------

test("convertMessages round-trips assistant thinking as reasoning parts", () => {
	const out = convertMessages([
		{ role: "user", content: "work it out" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "step one" },
				{ type: "text", text: "42" },
			],
		},
		{ role: "user", content: "and more" },
	]);
	assert.deepEqual(out[1], {
		role: "assistant",
		content: [
			{ type: "reasoning", text: "step one" },
			{ type: "text", text: "42" },
		],
	});
	// empty thinking is dropped, like the CLI's `if (e.thinking)` guard
	const empty = convertMessages([
		{ role: "user", content: "x" },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "text", text: "42" },
			],
		},
	]);
	assert.deepEqual(empty[1].content, [{ type: "text", text: "42" }]);
});

test("convertMessages moves tool-result image blocks into their own user message", () => {
	const out = convertMessages([
		{ role: "user", content: "describe the image" },
		{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "view_image", arguments: {} }] },
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "view_image",
			isError: false,
			content: [
				{ type: "text", text: "the image" },
				{ type: "image", data: "AAA=", mimeType: "image/png" },
			],
		},
	]);

	assert.deepEqual(
		out.map((m) => m.role),
		["user", "assistant", "tool", "user"],
	);
	assert.equal(out[2].content.length, 1);
	assert.deepEqual(out[2].content[0].output, { type: "text", value: "the image" });
	assert.equal(out[3].content.length, 1);
	assert.equal(out[3].content[0].type, "image");
	assert.equal(out[3].content[0].image, "data:image/png;base64,AAA=");
	assert.equal(out[3].content[0].mediaType, "image/png");
});

test("convertMessages stripsImages: only the latest image message survives, as a placeholder", () => {
	const out = convertMessages(
		[
			{
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "image", data: "QQ==", mimeType: "image/png" },
				],
			},
			{ role: "user", content: [{ type: "image", data: "RR==", mimeType: "image/jpeg" }] },
			{ role: "user", content: "and a text-only message" },
		],
		true,
	);
	assert.deepEqual(
		out.map((m) => m.role),
		["user", "user", "user"],
	);
	// Older image-bearing message: image dropped, text kept.
	assert.deepEqual(out[0].content, [{ type: "text", text: "first" }]);
	// The latest image-bearing message: placeholder (index counts that message's
	// content, mediaType preserved for context).
	assert.deepEqual(out[1].content, [
		{ type: "text", text: `<attached_image index="0" mediaType="image/jpeg" />` },
	]);
	// A text-only message is untouched (string content normalizes to parts).
	assert.deepEqual(out[2].content, [{ type: "text", text: "and a text-only message" }]);
});

test("convertMessages stripsImages: an older image-only message is replaced with an omission marker", () => {
	const out = convertMessages(
		[
			{ role: "user", content: [{ type: "image", data: "QQ==", mimeType: "image/png" }] },
			{
				role: "user",
				content: [
					{ type: "text", text: "newer" },
					{ type: "image", data: "RR==", mimeType: "image/png" },
				],
			},
		],
		true,
	);
	// No text left after the strip -> an explicit marker, not an empty message.
	assert.deepEqual(out[0].content, [
		{ type: "text", text: "[image omitted: the active model is text-only]" },
	]);
	assert.deepEqual(out[1].content, [
		{ type: "text", text: "newer" },
		{ type: "text", text: `<attached_image index="1" mediaType="image/png" />` },
	]);
});

test("convertMessages stripsImages: tool-result images follow the same rules", () => {
	// Latest image lives in a tool result -> placeholder user message, like the
	// vision path but without the image payload.
	const out = convertMessages(
		[
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "view_image", arguments: {} }] },
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "view_image",
				isError: false,
				content: [
					{ type: "text", text: "img" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
			},
		],
		true,
	);
	assert.deepEqual(
		out.map((m) => m.role),
		["user", "assistant", "tool", "user"],
	);
	assert.equal(out[2].content.length, 1);
	assert.equal(out[2].content[0].output.value, "img");
	assert.deepEqual(out[3].content, [
		{ type: "text", text: `<attached_image index="0" mediaType="image/png" />` },
	]);

	// An earlier tool-result image is replaced with the omission marker inside
	// its own tool message.
	const out2 = convertMessages(
		[
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "c1", name: "view_image", arguments: {} },
					{ type: "toolCall", id: "c2", name: "view_image", arguments: {} },
				],
			},
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "view_image",
				isError: false,
				content: [
					{ type: "text", text: "old" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
			},
			{
				role: "toolResult",
				toolCallId: "c2",
				toolName: "view_image",
				isError: false,
				content: [
					{ type: "text", text: "new" },
					{ type: "image", data: "BB==", mimeType: "image/png" },
				],
			},
		],
		true,
	);
	// Each image-bearing toolResult still gets its own placeholder user message
	// (the schema has no tool-result image output); older ones carry the
	// omission marker.
	assert.deepEqual(
		out2.map((m) => m.role),
		["user", "assistant", "tool", "user", "tool", "user"],
	);
	assert.deepEqual(out2[2].content, [
		{ type: "tool-result", toolCallId: "c1", toolName: "view_image", output: { type: "text", value: "old" } },
	]);
	assert.deepEqual(out2[3].content, [
		{ type: "text", text: "[image omitted: the active model is text-only]" },
	]);
	assert.deepEqual(out2[4].content, [
		{ type: "tool-result", toolCallId: "c2", toolName: "view_image", output: { type: "text", value: "new" } },
	]);
	assert.deepEqual(out2[5].content, [
		{ type: "text", text: `<attached_image index="0" mediaType="image/png" />` },
	]);
});

test("convertMessages maps a full conversation: strings, images, tool calls, error results, merges", () => {
	const out = convertMessages([
		{ role: "user", content: "hi" },
		{
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "B0C0=", mimeType: "image/png" },
			],
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hmm" },
				{ type: "text", text: "let me" },
				{ type: "toolCall", id: "tc1", name: "a", arguments: { x: 1 } },
				{ type: "toolCall", id: "tc2", name: "b", arguments: { y: 2 } },
			],
		},
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "renamed",
			isError: true,
			content: [{ type: "text", text: "boom" }],
		},
		{
			role: "toolResult",
			toolCallId: "tc2",
			toolName: "b",
			isError: false,
			content: [{ type: "text", text: "ok" }],
		},
		{ role: "user", content: [] },
	]);

	assert.deepEqual(
		out.map((m) => m.role),
		["user", "user", "assistant", "tool"],
	);
	assert.deepEqual(out[1].content, [
		{ type: "text", text: "look" },
		{ type: "image", image: "data:image/png;base64,B0C0=", mediaType: "image/png" },
	]);
	// Prior reasoning rides back as a reasoning part (the CLI does the same;
	// the gateway 400s stateful reasoning models without it); the toolName
	// comes from the assistant's tool call, not the tool result.
	assert.deepEqual(out[2].content, [
		{ type: "reasoning", text: "hmm" },
		{ type: "text", text: "let me" },
		{ type: "tool-call", toolCallId: "tc1", toolName: "a", input: { x: 1 } },
		{ type: "tool-call", toolCallId: "tc2", toolName: "b", input: { y: 2 } },
	]);
	// Consecutive tool results merge into one tool message.
	assert.deepEqual(out[3].content, [
		{ type: "tool-result", toolCallId: "tc1", toolName: "a", output: { type: "error-text", value: "boom" } },
		{ type: "tool-result", toolCallId: "tc2", toolName: "b", output: { type: "text", value: "ok" } },
	]);
});

test("parseCatalog drops bad and duplicate rows from a valid document", () => {
	assert.deepEqual(
		parseCatalog({
			schemaVersion: 1,
			catalogVersion: "abc",
			refreshAfterSeconds: 900,
			data: [
				{
					id: "x/y",
					context_length: 1_000_000,
					behaviorProfile: "standard-v1",
					zdr: true,
					category: "opensource",
				},
				{ id: "bad/row" },
				{
					id: "x/y",
					context_length: 1_000_000,
					behaviorProfile: "standard-v1",
					zdr: true,
					category: "opensource",
				},
			],
		}).map((m) => m.id),
		["x/y"],
	);
	// A structurally valid document with no rows parses to an empty list —
	// a successful empty catalog, not a failure.
	assert.deepEqual(
		parseCatalog({ schemaVersion: 1, catalogVersion: "x", refreshAfterSeconds: 1, data: [] }),
		[],
	);
});

test("parseCatalog throws on a structurally invalid document", () => {
	assert.throws(
		() => parseCatalog({ schemaVersion: 2, catalogVersion: "x", refreshAfterSeconds: 1, data: [] }),
		/unsupported model catalog schemaVersion 2/,
	);
	assert.throws(() => parseCatalog("nope"), /not a JSON object/);
	assert.throws(() => parseCatalog({}), /schemaVersion/);
	assert.throws(() => parseCatalog({ schemaVersion: 1, refreshAfterSeconds: 1, data: [] }), /catalogVersion/);
	assert.throws(
		() => parseCatalog({ schemaVersion: 1, catalogVersion: "x", data: [] }),
		/refreshAfterSeconds/,
	);
	assert.throws(
		() => parseCatalog({ schemaVersion: 1, catalogVersion: "x", refreshAfterSeconds: 1 }),
		/data array/,
	);
});

test("readExcludedModels tolerates missing files and bad yaml", async () => {
	withAgentDir();
	assert.deepEqual(await readExcludedModels(agentDir), new Set());

	withAgentDir("providers: [unclosed");
	assert.deepEqual(await readExcludedModels(agentDir), new Set());

	withAgentDir(`providers:
  commandcode-alpha:
    apiKey: user_test
    excludedModels:
      - "a/b"
      - 42
      - ""
`);
	assert.deepEqual(await readExcludedModels(agentDir), new Set(["a/b"]));
});

// ---- CLI staleness notice ----------------------------------------------------

const distTags = (tags) => new Response(JSON.stringify(tags), { status: 200 });

// Mirrors the CLI's own updater: npm dist-tags, prereleases dropped, semver max.
test("pickLatestStable drops prereleases and picks the semver max", () => {
	assert.equal(pickLatestStable({ latest: "1.88.2", next: "2.0.0-rc.1" }), "1.88.2");
	assert.equal(pickLatestStable({ latest: "1.9.0", rc: "1.10.0-rc.3", beta: "2.0.0-beta.0" }), "1.9.0");
	assert.equal(pickLatestStable({ latest: "1.88.2-rc.0" }), null);
	assert.equal(pickLatestStable({}), null);
	assert.equal(pickLatestStable(null), null);
});

test("checkCliUpdate reports a newer release and stays silent when current", async () => {
	mockFetch(async () => distTags({ latest: "1.88.2" }));
	assert.deepEqual(await checkCliUpdate("0.52.1"), { latestVersion: "1.88.2", updateAvailable: true });

	mockFetch(async () => distTags({ latest: "0.52.1" }));
	assert.deepEqual(await checkCliUpdate("0.52.1"), { latestVersion: "0.52.1", updateAvailable: false });

	mockFetch(async () => distTags({ latest: "0.51.0" }));
	assert.deepEqual(await checkCliUpdate("0.52.1"), { latestVersion: "0.52.1", updateAvailable: false });
});

test("checkCliUpdate degrades to null on registry failure", async () => {
	mockFetch(async () => new Response("nope", { status: 500 }));
	assert.equal(await checkCliUpdate("0.52.1"), null);

	mockFetch(async () => {
		throw new Error("ENOTFOUND");
	});
	assert.equal(await checkCliUpdate("0.52.1"), null);

	mockFetch(async () => new Response("<html>", { status: 200 }));
	assert.equal(await checkCliUpdate("0.52.1"), null);

	mockFetch(async () => distTags({ latest: "1.88.2-rc.0" }));
	assert.equal(await checkCliUpdate("0.52.1"), null);
});

test("cliUpdateStatusText names both versions and the fix", () => {
	const text = cliUpdateStatusText("0.52.1", "1.88.2");
	assert.match(text, /0\.52\.1/);
	assert.match(text, /1\.88\.2/);
	assert.match(text, /stale/i);
});

test("session_start paints the status line only when the pin is stale", async () => {
	const statuses = [];
	const ctx = { ui: { setStatus: (key, text) => statuses.push([key, text]) } };

	// session_start must not block startup on npm, so the handler returns before
	// the check settles; drain the detached promise before asserting.
	const settle = async () => {
		for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	};

	mockFetch(async () => distTags({ latest: "1.89.0" }));
	// Returns synchronously: the harness awaits session_start handlers, so an
	// awaited npm round-trip would delay every session start.
	assert.equal(handlers.get("session_start")({}, ctx), undefined);
	await settle();
	assert.equal(statuses.length, 1);
	const [key, text] = statuses[0];
	assert.equal(key, CLI_UPDATE_STATUS_KEY);
	assert.match(text, /1\.89\.0/);

	statuses.length = 0;
	mockFetch(async () => distTags({ latest: "1.88.1" }));
	await handlers.get("session_start")({}, ctx);
	await settle();
	assert.deepEqual(statuses, []);

	statuses.length = 0;
	mockFetch(async () => {
		throw new Error("offline");
	});
	await handlers.get("session_start")({}, ctx);
	await settle();
	assert.deepEqual(statuses, []);
});

// ---- Unknown behaviorProfile (the CLI's "client too old" verdict) --------------

test("hasUnknownBehaviorProfile flags profiles outside the pinned CLI's set", () => {
	assert.equal(hasUnknownBehaviorProfile([]), false);
	assert.equal(hasUnknownBehaviorProfile([{ behaviorProfile: "standard-v1" }]), false);
	assert.equal(
		hasUnknownBehaviorProfile([
			{ behaviorProfile: "standard-v1" },
			{ behaviorProfile: "anthropic-prefix-bound-v1" },
		]),
		false,
	);
	assert.equal(hasUnknownBehaviorProfile([{ behaviorProfile: "brand-new-v2" }]), true);
});

test("an unknown behaviorProfile in the catalog sets a status line at session start", async () => {
	withAgentDir();
	discoveryFetch({
		catalog: () => catalogBody([catalogRow({ behaviorProfile: "brand-new-v2" })]),
	});
	// Billing fetches are not mocked; the fail-open path keeps the model.
	await provider.fetchDynamicModels("user_test");

	const statuses = [];
	const ctx = { ui: { setStatus: (key, text) => statuses.push([key, text]) } };
	// dist-tags mocked at the pinned version so only the profile notice fires.
	mockFetch(async () => distTags({ latest: COMMAND_CODE_VERSION }));
	await handlers.get("session_start")({}, ctx);
	assert.equal(statuses.length, 1);
	const [key, text] = statuses[0];
	assert.equal(key, "commandcode-profile");
	assert.match(text, /brand-new-v2/);
	assert.match(text, new RegExp(COMMAND_CODE_VERSION.replace(/\./g, "\\.")));
});
