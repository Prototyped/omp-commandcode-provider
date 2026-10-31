import { afterEach, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import registerCommandCode, { convertMessages, parseModelRows, readExcludedModels } from "../index.ts";
import { CLI_UPDATE_STATUS_KEY, checkCliUpdate, cliUpdateStatusText, pickLatestStable } from "../update.ts";

let provider;
let agentDir;
const realFetch = globalThis.fetch;

const handlers = new Map();

registerCommandCode({
	registerProvider(name, config) {
		assert.equal(name, "commandcode");
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
	provider: "commandcode",
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
		assert.equal(init.headers["x-command-code-version"], "0.52.1");
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

// ---- Session cost from gateway metadata ---------------------------------------

test("session cost comes from providerMetadata.gateway.cost (string)", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":100,"outputTokens":5},"providerMetadata":{"gateway":{"cost":"0.000123"}}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	const done = events.at(-1);
	assert.equal(done?.type, "done");
	assert.equal(done.message.usage.input, 100);
	assert.equal(done.message.usage.output, 5);
	assert.equal(done.message.usage.cost.total, 0.000123);
});

test("per-step costs accumulate across finish-step events", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"tool-calls","usage":{"inputTokens":10,"outputTokens":2},"providerMetadata":{"gateway":{"cost":"0.0001"}}}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":20,"outputTokens":3},"providerMetadata":{"gateway":{"cost":"0.0002"}}}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":30,"outputTokens":5,"totalTokens":35}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	assert.equal(events.at(-1)?.type, "done");
	expect(events.at(-1).message.usage.cost.total).toBeCloseTo(0.0003, 12);
});

test("terminal finish cost overrides accumulated step costs", async () => {
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2},"providerMetadata":{"gateway":{"cost":"0.0001"}}}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":2},"providerMetadata":{"gateway":{"cost":"0.0005"}}}',
		]),
	);

	const events = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	assert.equal(events.at(-1)?.message?.usage?.cost?.total, 0.0005);

	// The trailing provider-metadata event is also terminal: its cost overrides
	// the accumulated step costs instead of adding to them.
	mockFetch(async () =>
		ndjsonResponse([
			'{"type":"start"}',
			'{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2},"providerMetadata":{"gateway":{"cost":"0.0001"}}}',
			'{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":2}}',
			'{"type":"provider-metadata","providerMetadata":{"gateway":{"cost":"0.0009"}}}',
		]),
	);

	const events2 = await collect(
		provider.streamSimple(model, { systemPrompt: "", messages: [], tools: [] }, { apiKey: "user_test" }),
	);

	assert.equal(events2.at(-1)?.type, "done");
	assert.equal(events2.at(-1)?.message?.usage?.cost?.total, 0.0009);
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

test("provider-metadata alone is terminal and falls back to inferenceCost", async () => {
	const events = await runStream([
		'{"type":"start"}',
		'{"type":"provider-metadata","providerMetadata":{"gateway":{"inferenceCost":"0.5"}}}',
	]);

	assert.equal(events.at(-1).type, "done");
	assert.equal(events.at(-1).message.usage.cost.total, 0.5);
});

// ---- Stream — errors & transport -------------------------------------------------

test("error events surface the gateway message; a bare error gets a generic one", async () => {
	const eventsA = await runStream(['{"type":"start"}', '{"type":"error","message":"upstream exploded"}']);
	assert.equal(eventsA.at(-1).type, "error");
	assert.equal(eventsA.at(-1).reason, "error");
	assert.match(eventsA.at(-1).error.errorMessage, /upstream exploded/);

	const eventsB = await runStream(['{"type":"start"}', '{"type":"error"}']);
	assert.equal(eventsB.at(-1).error.errorMessage, "Command Code stream error");
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

// ---- Live model discovery + exclusions ------------------------------------------

function discoveryFetch({
	roster = () => Response.json({ data: [] }),
	modelsDev = () => Response.json({ commandcode: { models: {} } }),
} = {}) {
	mockFetch(async (url) => {
		if (url === "https://api.commandcode.ai/provider/v1/models") return roster();
		if (url === "https://models.dev/api.json") return modelsDev();
		throw new Error(`unexpected fetch: ${url}`);
	});
}

test("fetchDynamicModels maps the live roster with models.dev capabilities and exclusions", async () => {
	withAgentDir(`providers:
  commandcode:
    apiKey: user_test
    excludedModels:
      - "deepseek/deepseek-v4-pro"
`);
	discoveryFetch({
		roster: () =>
			Response.json({
				data: [
					{ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", context_length: 1_000_000 },
					{ id: "moonshotai/Kimi-K3", name: "Kimi K3", context_length: 1_000_000 },
					{ id: "plain-model" },
				],
			}),
		modelsDev: () =>
			Response.json({
				commandcode: {
					models: {
						"moonshotai/Kimi-K3": { reasoning: true, attachment: true, limit: { output: 65_536 } },
						"plain-model": { reasoning: false, limit: { output: 4_096 } },
					},
				},
			}),
	});

	const models = await provider.fetchDynamicModels("user_test");

	assert.deepEqual(
		models.map((m) => m.id),
		["moonshotai/Kimi-K3", "plain-model"],
	);
	const kimi = models[0];
	assert.equal(kimi.reasoning, true);
	assert.deepEqual(kimi.input, ["text", "image"]);
	assert.equal(kimi.contextWindow, 1_000_000);
	assert.equal(kimi.maxTokens, 65_536);
	const plain = models[1];
	assert.equal(plain.reasoning, false);
	assert.deepEqual(plain.input, ["text"]);
	assert.equal(plain.contextWindow, 128_000);
	assert.equal(plain.maxTokens, 4_096);
});

test("fetchDynamicModels filters proprietary models out of the live roster", async () => {
	discoveryFetch({
		roster: () =>
			Response.json({
				data: [
					{ id: "deepseek/deepseek-v4-pro" },
					{ id: "claude-opus-4-8" },
					{ id: "gpt-5.5" },
					{ id: "google/gemini-3.5-flash" },
					{ id: "moonshotai/Kimi-K3" },
				],
			}),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["deepseek/deepseek-v4-pro", "moonshotai/Kimi-K3"],
	);
});

test("fetchDynamicModels accepts a bare-array roster body", async () => {
	discoveryFetch({
		roster: () => Response.json([{ id: "a/b", name: "A/B" }]),
		modelsDev: () => Response.json({ commandcode: { models: { "a/b": { reasoning: true } } } }),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["a/b"],
	);
	assert.equal(models[0].reasoning, true);
});

test("fetchDynamicModels returns no models when the roster endpoint fails", async () => {
	discoveryFetch({
		roster: () => new Response("{}", { status: 500 }),
	});

	assert.deepEqual(await provider.fetchDynamicModels("user_test"), []);
});

test("fetchDynamicModels returns no models on an unrecognized roster body", async () => {
	discoveryFetch({
		roster: () => Response.json({ unexpected: true }),
	});

	assert.deepEqual(await provider.fetchDynamicModels("user_test"), []);
});

test("fetchDynamicModels assumes reasoning for models models.dev does not know", async () => {
	discoveryFetch({
		roster: () => Response.json({ data: [{ id: "brand/new-model", name: "Brand New" }] }),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.equal(models.length, 1);
	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].input, ["text"]);
	assert.equal(models[0].contextWindow, 128_000);
	assert.equal(models[0].maxTokens, 8192);
});

test("fetchDynamicModels still maps the roster when models.dev is unreachable", async () => {
	discoveryFetch({
		roster: () => Response.json({ data: [{ id: "a/b", context_length: 200_000 }] }),
		modelsDev: () => {
			throw new Error("network down");
		},
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.equal(models.length, 1);
	assert.equal(models[0].id, "a/b");
	assert.equal(models[0].reasoning, true);
	assert.equal(models[0].contextWindow, 200_000);
});

test("exclusions filter the live roster", async () => {
	withAgentDir(`providers:
  commandcode:
    apiKey: user_test
    excludedModels:
      - "deepseek/deepseek-v4-pro"
`);
	discoveryFetch({
		roster: () => Response.json({ data: [{ id: "deepseek/deepseek-v4-pro" }, { id: "moonshotai/Kimi-K3" }] }),
	});

	const models = await provider.fetchDynamicModels("user_test");
	assert.deepEqual(
		models.map((m) => m.id),
		["moonshotai/Kimi-K3"],
	);
});

// ---- Pure helpers ------------------------------------------------------------------

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
	// Prior reasoning is omitted (documented divergence from the CLI); the
	// toolName comes from the assistant's tool call, not the tool result.
	assert.deepEqual(out[2].content, [
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

test("parseModelRows handles both shapes", () => {
	assert.deepEqual(parseModelRows({ data: [{ id: "x/y" }, { noId: true }] }), [
		{ id: "x/y" },
		{ noId: true },
	]);
	assert.deepEqual(parseModelRows([{ id: "x/y", name: "X" }]), [{ id: "x/y", name: "X" }]);
	assert.equal(parseModelRows("nope"), null);
	assert.equal(parseModelRows({ data: "nope" }), null);
	assert.equal(parseModelRows({}), null);
});

test("readExcludedModels tolerates missing files and bad yaml", async () => {
	withAgentDir();
	assert.deepEqual(await readExcludedModels(agentDir), new Set());

	withAgentDir("providers: [unclosed");
	assert.deepEqual(await readExcludedModels(agentDir), new Set());

	withAgentDir(`providers:
  commandcode:
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

	mockFetch(async () => distTags({ latest: "1.88.2" }));
	// Returns synchronously: the harness awaits session_start handlers, so an
	// awaited npm round-trip would delay every session start.
	assert.equal(handlers.get("session_start")({}, ctx), undefined);
	await settle();
	assert.equal(statuses.length, 1);
	const [key, text] = statuses[0];
	assert.equal(key, CLI_UPDATE_STATUS_KEY);
	assert.match(text, /1\.88\.2/);

	statuses.length = 0;
	mockFetch(async () => distTags({ latest: "0.52.1" }));
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
