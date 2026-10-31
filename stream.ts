/**
 * The /alpha/generate stream implementation: request construction, NDJSON
 * reader, and the event loop. Block streaming is delegated to the
 * `BlockStreams` handlers; usage, cost, and stop-reason mapping are pure
 * functions. Field-level contract: docs/wire-protocol.md.
 */

import type {
	Api,
	ApiKey,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { BASE_URL, COMMAND_CODE_VERSION, ENDPOINT, PROVIDER_ID } from "./constants.ts";
import { getCatalogModelById } from "./discovery.ts";
import { convertMessages } from "./messages.ts";
import { deriveSessionId, systemPromptText } from "./session.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.message || value.stack || "Error";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "Unknown error (non-serializable)";
	}
}

// ---- NDJSON line reader -------------------------------------------------

function parseJsonLine(line: string, lineNumber: number): unknown {
	try {
		return JSON.parse(line);
	} catch (error) {
		const preview = line.length > 240 ? `${line.slice(0, 240)}...` : line;
		throw new Error(
			`Malformed Command Code NDJSON at line ${lineNumber}: ${preview} (${stringifyUnknown(error)})`,
		);
	}
}

async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let lineNumber = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			lineNumber += 1;
			yield parseJsonLine(line, lineNumber);
			nl = buffer.indexOf("\n");
		}
	}
	buffer = buffer.trim();
	if (buffer) {
		lineNumber += 1;
		yield parseJsonLine(buffer, lineNumber);
	}
}

// Gateway field spellings accepted by this parser (observed per
// docs/wire-protocol.md). DUAL-KEY — both spellings are really sent by the
// gateway/CLI and must keep working:
//   block id:   `id` on tool-input-* events, `toolCallId` on the final
//               `tool-call` event (resolved by toolEventId)
//   usage:      `usage` on finish-step, `totalUsage` on finish
//   cache-read: `cachedInputTokens`, `inputTokenDetails.cacheReadTokens`,
//               and `raw.prompt_cache_hit_tokens` all carry the same number
// DEFENSIVE — not seen in the observed flow; prune when drift is confirmed:
//   `name` (tool name), `args` (tool input), `input_tokens`/`output_tokens`,
//   finish reason `tool_use`

// biome-ignore lint/suspicious/noExplicitAny: untyped gateway envelope by design — the schema is undocumented and deliberately permissive (docs/wire-protocol.md)
type GatewayEvent = Record<string, any>;

function toolEventId(event: GatewayEvent): string | undefined {
	return event.id ?? event.toolCallId;
}

function toolEventName(event: GatewayEvent): string {
	return event.toolName ?? event.name ?? "";
}

// ---- Request construction -------------------------------------------------

// The /alpha/generate schema is strict — all of these fields are required.
// We don't gather project context inside an extension, so we send neutral
// defaults (mirroring the CLI's getEnvironmentContext shape); the gateway
// stuffs them into the system prompt preamble and they don't affect routing.
function staticConfig() {
	return {
		workingDir: process.cwd(),
		date: new Date().toISOString().slice(0, 10),
		environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
		structure: [],
		isGitRepo: false,
		currentBranch: "",
		mainBranch: "",
		gitStatus: "",
		recentCommits: [],
	};
}

function newAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function requestHeaders(apiKey: ApiKey, sessionId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		Accept: "application/x-ndjson",
		"User-Agent": "cli",
		"x-cli-environment": "production",
		"x-command-code-version": COMMAND_CODE_VERSION,
		"x-session-id": sessionId,
		...(process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : {}),
	};
}

// A user-configured model (models.yml) carries the id the user wrote and
// harness defaults for the rest (text-only input, no reasoning, zero rates).
// Hidden catalog rows never reach discovery, so without this lookup the wire
// shape would be wrong for them: images stripped from a vision model, an
// unlisted reasoning_effort sent (silently disabling reasoning), cost metered
// at zero. Discovered models already carry the catalog's data, so the
// augmentation is idempotent for them.
function augmentFromCatalog(model: Model<Api>): Model<Api> {
	const row = getCatalogModelById(model.id);
	if (!row) return model;
	const patch: Record<string, unknown> = {
		input: row.inputModalities.includes("image") ? ["text", "image"] : ["text"],
	};
	if (row.reasoningEfforts.length > 0) {
		patch.reasoning = true;
		patch.thinking = { mode: "effort", efforts: row.reasoningEfforts };
	}
	const { input, output, cacheRead, cacheWrite } = model.cost;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && row.pricing) {
		patch.cost = {
			input: row.pricing.inputCost,
			output: row.pricing.outputCost,
			cacheRead: row.pricing.cacheReadCost,
			cacheWrite: row.pricing.cacheWriteCost ?? 0,
		};
	}
	return { ...model, ...patch } as Model<Api>;
}

function requestBody(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	sessionId: string,
): Record<string, unknown> {
	const tools = (context.tools ?? []).map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));
	// Reasoning effort: clamp to the model's supported list (catalog
	// `reasoningEfforts`). Never send an unlisted value — the gateway accepts
	// it and silently disables reasoning (measured 2026-10-31). `disableReasoning`
	// maps to "off" only when the model lists it; an explicit effort never
	// clamps to "off" (a tie between two on-efforts resolves to the lower one).
	const modelExt = model as unknown as { thinking?: { efforts?: string[] }; reasoningEfforts?: string[] };
	const efforts: string[] = modelExt.thinking?.efforts ?? modelExt.reasoningEfforts ?? [];
	const textOnly = !(model.input?.includes?.("image") ?? false);
	const effortRank: Record<string, number> = {
		off: -1,
		minimal: 0,
		low: 1,
		medium: 2,
		high: 3,
		xhigh: 4,
		max: 5,
	};
	let reasoningEffort: string | undefined;
	if (options?.disableReasoning) {
		if (efforts.includes("off")) reasoningEffort = "off";
	} else if (options?.reasoning && model.reasoning) {
		const requested = String(options.reasoning);
		if (efforts.includes(requested)) {
			reasoningEffort = requested;
		} else if (efforts.length > 0) {
			const reqRank = effortRank[requested] ?? 2;
			let best: string | null = null;
			let bestDist = Infinity;
			for (const e of efforts) {
				if (e === "off") continue;
				const dist = Math.abs((effortRank[e] ?? 2) - reqRank);
				if (dist < bestDist || (dist === bestDist && effortRank[e] < effortRank[best as string])) {
					bestDist = dist;
					best = e;
				}
			}
			reasoningEffort = best ?? undefined;
		} else {
			// No catalog list (user-configured model): pass the requested
			// value through rather than guessing.
			reasoningEffort = requested;
		}
	}

	return {
		config: staticConfig(),
		memory: "",
		taste: null,
		skills: null,
		permissionMode: "standard",
		params: {
			model: model.id,
			system: systemPromptText(context.systemPrompt),
			messages: convertMessages(context.messages, textOnly),
			tools,
			max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
			...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
			...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
			stream: true,
		},
		threadId: sessionId,
	};
}

// ---- Block streams --------------------------------------------------------
//
// The gateway streams content in id-keyed start/delta/end triples
// ("reasoning-0", "txt-0", "call_..."). Each handler appends blocks to the
// assistant message and mirrors progress onto the event stream;
// `BlockStreams` owns the shared gateway-id → content-index map and routes
// each kind to its handler.

interface BlockHandler {
	start(id: string): void;
	delta(id: string, chunk: string): void;
	end(id: string): void;
}

type StringBlockKind = "text" | "thinking";

class StringBlockStream implements BlockHandler {
	private readonly kind: StringBlockKind;
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private readonly idToIndex: Map<string, number>;

	constructor(
		kind: StringBlockKind,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
		idToIndex: Map<string, number>,
	) {
		this.kind = kind;
		this.output = output;
		this.stream = stream;
		this.idToIndex = idToIndex;
	}

	start(id: string): void {
		if (this.kind === "text") this.output.content.push({ type: "text", text: "" });
		else this.output.content.push({ type: "thinking", thinking: "" });
		const idx = this.output.content.length - 1;
		this.idToIndex.set(id, idx);
		const event: AssistantMessageEvent =
			this.kind === "text"
				? { type: "text_start", contentIndex: idx, partial: this.output }
				: { type: "thinking_start", contentIndex: idx, partial: this.output };
		this.stream.push(event);
	}

	delta(id: string, chunk: string): void {
		const idx = this.idToIndex.get(id);
		if (idx === undefined) return;
		const block = this.output.content[idx];
		if (this.kind === "text") {
			if (block.type !== "text") return;
			block.text += chunk;
		} else {
			if (block.type !== "thinking") return;
			block.thinking += chunk;
		}
		const event: AssistantMessageEvent =
			this.kind === "text"
				? { type: "text_delta", contentIndex: idx, delta: chunk, partial: this.output }
				: { type: "thinking_delta", contentIndex: idx, delta: chunk, partial: this.output };
		this.stream.push(event);
	}

	end(id: string): void {
		const idx = this.idToIndex.get(id);
		if (idx === undefined) return;
		const block = this.output.content[idx];
		if (this.kind === "text") {
			if (block.type !== "text") return;
			this.stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial: this.output });
		} else {
			if (block.type !== "thinking") return;
			this.stream.push({
				type: "thinking_end",
				contentIndex: idx,
				content: block.thinking,
				partial: this.output,
			});
		}
	}
}

class ToolCallStream {
	private readonly output: AssistantMessage;
	private readonly stream: AssistantMessageEventStream;
	private readonly idToIndex: Map<string, number>;
	// Partial tool inputs accumulate as raw JSON, keyed by content index.
	private readonly toolJsonByIndex = new Map<number, string>();
	// Some streams send both `tool-input-end` and `tool-call` for one call;
	// `toolcall_end` must fire exactly once.
	private readonly endedToolCalls = new Set<number>();

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, idToIndex: Map<string, number>) {
		this.output = output;
		this.stream = stream;
		this.idToIndex = idToIndex;
	}

	start(id: string, name: string): void {
		this.output.content.push({ type: "toolCall", id, name, arguments: {} });
		const idx = this.output.content.length - 1;
		this.idToIndex.set(id, idx);
		this.toolJsonByIndex.set(idx, "");
		this.stream.push({ type: "toolcall_start", contentIndex: idx, partial: this.output });
	}

	delta(id: string, chunk: string): void {
		const idx = this.idToIndex.get(id);
		if (idx === undefined) return;
		const block = this.output.content[idx];
		if (block.type !== "toolCall") return;
		const acc = (this.toolJsonByIndex.get(idx) ?? "") + chunk;
		this.toolJsonByIndex.set(idx, acc);
		try {
			block.arguments = JSON.parse(acc);
		} catch {
			// JSON still streaming
		}
		this.stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: this.output });
	}

	// Also serves the bare `tool-call` path: when the id has no recorded
	// `tool-input-start`, the block is created here.
	end(id: string, name: string, completeInput: unknown): void {
		let idx = this.idToIndex.get(id);
		if (idx === undefined) {
			this.output.content.push({ type: "toolCall", id, name, arguments: {} });
			idx = this.output.content.length - 1;
			this.idToIndex.set(id, idx);
			this.stream.push({ type: "toolcall_start", contentIndex: idx, partial: this.output });
		}
		const block = this.output.content[idx];
		if (block.type !== "toolCall") return;
		// Some streams send full input on "tool-call"; prefer that if present
		if (completeInput && typeof completeInput === "object") {
			block.arguments = completeInput as Record<string, unknown>;
		} else {
			const acc = this.toolJsonByIndex.get(idx) ?? "";
			if (acc) {
				try {
					block.arguments = JSON.parse(acc);
				} catch {}
			}
		}
		if (this.endedToolCalls.has(idx)) return;
		this.endedToolCalls.add(idx);
		this.stream.push({
			type: "toolcall_end",
			contentIndex: idx,
			toolCall: {
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: block.arguments,
			},
			partial: this.output,
		});
	}
}

class BlockStreams {
	readonly text: StringBlockStream;
	readonly thinking: StringBlockStream;
	readonly tools: ToolCallStream;
	private readonly output: AssistantMessage;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream) {
		this.output = output;
		const idToIndex = new Map<string, number>();
		this.text = new StringBlockStream("text", output, stream, idToIndex);
		this.thinking = new StringBlockStream("thinking", output, stream, idToIndex);
		this.tools = new ToolCallStream(output, stream, idToIndex);
	}

	sawToolCall(): boolean {
		return this.output.content.some((b) => b.type === "toolCall");
	}
}

// ---- Terminal event mapping ------------------------------------------------

type GatewayUsage = {
	inputTokens?: number;
	input_tokens?: number;
	outputTokens?: number;
	output_tokens?: number;
	cachedInputTokens?: number;
	inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
	raw?: { prompt_cache_hit_tokens?: number };
};

// The gateway reports inputTokens as the TOTAL input (cached + uncached),
// matching the Vercel AI SDK convention. Pi's Usage shape expects `input`
// and `cacheRead` to be disjoint, so leaving cached tokens inside `input`
// would double-charge them on paid models. Subtract to match the convention
// used by the built-in Anthropic provider in pi-ai.
function applyUsage(usage: AssistantMessage["usage"], raw: GatewayUsage): void {
	const totalInputTokens = raw.inputTokens ?? raw.input_tokens ?? 0;
	const cacheReadTokens =
		raw.cachedInputTokens ?? raw.inputTokenDetails?.cacheReadTokens ?? raw.raw?.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = raw.inputTokenDetails?.cacheWriteTokens ?? 0;
	usage.input = Math.max(0, totalInputTokens - cacheReadTokens - cacheWriteTokens);
	usage.output = raw.outputTokens ?? raw.output_tokens ?? 0;
	usage.cacheRead = cacheReadTokens;
	usage.cacheWrite = cacheWriteTokens;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

// The stream reports usage, not USD, so cost is the catalog's `pricing`
// rates — the same math 1.88.2 performs (`estimateCatalogCostUsd`).
// Verified live: deepseek/deepseek-v4-flash (inputCost 0.15, outputCost 0.6,
// cacheReadCost 0.003) prices a cold 762-in/1-out call at $1.149e-4, and
// $3.964e-5 with 512 cache-read tokens.
function computeCost(model: Model<Api>, usage: AssistantMessage["usage"]): number {
	// `usage.cost` holds USD amounts (the harness meter reads `.total`); the
	// per-million rates live on the discovered model, not the message.
	const { input, output, cacheRead, cacheWrite } = model.cost;
	const uncached = Math.max(0, usage.input);
	usage.cost.input = (uncached * input) / 1_000_000;
	usage.cost.output = (usage.output * output) / 1_000_000;
	usage.cost.cacheRead = (usage.cacheRead * cacheRead) / 1_000_000;
	usage.cost.cacheWrite = (usage.cacheWrite * cacheWrite) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost.total;
}

// Normalize the gateway's finishReason onto pi's stop reasons. Some OSS
// models report "stop" even when they emitted tool calls, so tool calls in
// the message override the reported reason.
function resolveStopReason(reason: string | undefined, sawToolCall: boolean): "stop" | "length" | "toolUse" {
	if (reason === "length") return "length";
	if (reason === "tool-calls" || reason === "tool_calls" || reason === "tool_use") return "toolUse";
	if (sawToolCall) return "toolUse";
	return "stop";
}

// ---- Stream implementation ----------------------------------------------

export function streamCommandCode(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	model = augmentFromCatalog(model);

	(async () => {
		const output = newAssistantMessage(model);

		try {
			const apiKey = options?.apiKey;
			if (!apiKey)
				throw new Error(
					`No Command Code API key. Use /login ${PROVIDER_ID}, or set an apiKey for the ${PROVIDER_ID} provider in models.yml, or export COMMANDCODE_API_KEY.`,
				);

			stream.push({ type: "start", partial: output });

			const sessionId =
				options?.sessionId && UUID_RE.test(options.sessionId) ? options.sessionId : deriveSessionId(context);

			const response = await fetch(`${BASE_URL}${ENDPOINT}`, {
				method: "POST",
				headers: requestHeaders(apiKey, sessionId),
				body: JSON.stringify(requestBody(model, context, options, sessionId)),
				signal: options?.signal,
			});

			if (!response.ok || !response.body) {
				let detail = "";
				try {
					detail = await response.text();
				} catch {}
				throw new Error(`Command Code ${response.status}: ${detail || response.statusText}`);
			}

			const blocks = new BlockStreams(output, stream);
			let sawTerminalEvent = false;
			// `cache-write-tokens` (top-level number) patches cacheWrite only when
			// `finish` reported 0; `provider-metadata` supplies the Anthropic 1h
			// cache-write split via providerMetadata. Both new in 1.88.2.
			let cacheWriteTokensPatch: number | undefined;
			let cacheWrite1hTokens: number | undefined;

			for await (const event of ndjsonLines(response.body)) {
				if (!event || typeof event !== "object") continue;
				const gatewayEvent = event as GatewayEvent;
				const type = gatewayEvent.type;
				if (!type) continue;

				switch (type) {
					case "reasoning-start":
						blocks.thinking.start(gatewayEvent.id);
						break;
					case "reasoning-delta":
						blocks.thinking.delta(gatewayEvent.id, gatewayEvent.text ?? "");
						break;
					case "reasoning-end":
						blocks.thinking.end(gatewayEvent.id);
						break;
					case "text-start":
						blocks.text.start(gatewayEvent.id);
						break;
					case "text-delta":
						blocks.text.delta(gatewayEvent.id, gatewayEvent.text ?? "");
						break;
					case "text-end":
						blocks.text.end(gatewayEvent.id);
						break;
					case "tool-input-start": {
						const id = toolEventId(gatewayEvent);
						if (id) blocks.tools.start(id, toolEventName(gatewayEvent));
						break;
					}
					case "tool-input-delta": {
						const id = toolEventId(gatewayEvent);
						if (id) blocks.tools.delta(id, gatewayEvent.delta ?? "");
						break;
					}
					case "tool-input-end":
					case "tool-call": {
						const id = toolEventId(gatewayEvent);
						if (id)
							blocks.tools.end(id, toolEventName(gatewayEvent), gatewayEvent.input ?? gatewayEvent.args);
						break;
					}
					case "finish-step":
					case "finish": {
						sawTerminalEvent = true;
						const usage = gatewayEvent.usage ?? gatewayEvent.totalUsage;
						if (usage) applyUsage(output.usage, usage);
						output.stopReason = resolveStopReason(
							gatewayEvent.finishReason ?? gatewayEvent.rawFinishReason,
							blocks.sawToolCall(),
						);
						break;
					}
					case "cache-write-tokens": {
						const n = gatewayEvent.cacheWriteTokens;
						if (typeof n === "number" && Number.isFinite(n) && n >= 0) cacheWriteTokensPatch = n;
						break;
					}
					case "provider-metadata": {
						const anthropic = gatewayEvent.providerMetadata?.anthropic;
						const n = anthropic?.usage?.cache_creation?.ephemeral_1h_input_tokens;
						if (typeof n === "number" && Number.isFinite(n) && n >= 0) cacheWrite1hTokens = n;
						break;
					}
					case "error": {
						const err = gatewayEvent.error;
						let detail: string;
						if (err && typeof err === "object") {
							const e = err as Record<string, unknown>;
							const type = typeof e.type === "string" ? e.type : "error";
							const message = typeof e.message === "string" ? e.message : stringifyUnknown(err);
							const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
							const isRetryable = typeof e.isRetryable === "boolean" ? e.isRetryable : undefined;
							detail = `${type}: ${message}`;
							if (statusCode !== undefined) detail += ` (status ${statusCode})`;
							if (isRetryable !== undefined) detail += ` [retryable=${isRetryable}]`;
						} else {
							detail =
								gatewayEvent.message ??
								(gatewayEvent.error === undefined
									? "Command Code stream error"
									: stringifyUnknown(gatewayEvent.error));
						}
						throw new Error(`Command Code stream error: ${detail}`);
					}
				}
			}
			// The session meter reads cost.total. The gateway reports no per-request
			// USD on /alpha/generate, so the cost is the catalog rate math.
			if (cacheWrite1hTokens !== undefined) {
				// The 1h split is a subset of cacheWrite; keep them disjoint for pi's
				// usage shape by folding 1h into cacheWrite and pricing separately
				// is unnecessary — catalog cacheWriteCost applies to both tiers.
				output.usage.cacheWrite += Math.max(0, cacheWrite1hTokens - output.usage.cacheWrite);
				output.usage.totalTokens += Math.max(0, cacheWrite1hTokens - output.usage.cacheWrite);
			}
			if (cacheWriteTokensPatch !== undefined && output.usage.cacheWrite === 0) {
				output.usage.cacheWrite = cacheWriteTokensPatch;
				output.usage.totalTokens += cacheWriteTokensPatch;
			}
			output.usage.cost.total = computeCost(model, output.usage);
			if (!sawTerminalEvent) {
				throw new Error("Command Code stream ended before a terminal event");
			}

			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = stringifyUnknown(error);
			if (process.env.DEBUG) {
				console.error("[commandcode] stream error:", error);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
