# `/alpha/generate` wire protocol

Command Code does not publish an API reference for this endpoint. Everything
here was reverse-engineered from the `command-code` npm CLI (currently verified
against v1.88.5) and
confirmed against the live gateway. Treat it as a snapshot that can drift —
when it breaks, re-derive from the current CLI bundle (`$(npm root -g)/command-code/dist/cli.mjs`).

**Scope.** This document describes the **wire protocol** between the Command
Code CLI (the pinned release, `COMMAND_CODE_VERSION` in `constants.ts`) and
the provider's endpoints at `api.commandcode.ai`: the requests sent, the
responses and NDJSON stream received, and the shape of the catalog document.
CLI behavior that does not change what goes on the wire — local catalogs and
caches, picker and runner decisions, npm version checks — is out of scope, as
is the extension's implementation. The extension's code may be referenced
here **only** where it changes the wire payload relative to the CLI, and every
such reference is marked as one ("Divergence (extension):"). Do not add
sections that merely describe local behavior, of the CLI or the extension.

## Why this endpoint (and not `/provider/v1/*`)

The gateway exposes three model-traffic surfaces:

| Path                                 | Shape                       | Plan         |
| ------------------------------------ | --------------------------- | ------------ |
| `POST /provider/v1/messages`         | Anthropic Messages API      | **Pro only** |
| `POST /provider/v1/chat/completions` | OpenAI Chat Completions     | **Pro only** |
| `POST /alpha/generate`               | Custom (CLI's own envelope) | any plan     |

On the **Go** plan, both `/provider/v1/*` paths return:

```json
{
	"error": {
		"message": "Your Go plan doesn't include API access. Upgrade to Pro or higher…",
		"type": "permission_error",
		"code": "upgrade_required"
	}
}
```

`/alpha/generate` is what the `cmd` CLI itself uses for every turn, so it's not
plan-gated. That's the entire reason this extension speaks the custom envelope
instead of a standard OpenAI/Anthropic shape.

## Base URL

```
https://api.commandcode.ai
```

The CLI can also be pointed at `--local` (`http://localhost:9090`) and
`--staging` (`https://staging-api.commandcode.ai`); the default is above.

### Other endpoints of the protocol

| Path                                  | Purpose                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /alpha/whoami`                   | key validation, as the CLI's login does it: only a 401 rejects the key; 403 or unreachable keeps it |
| `GET /provider/v1/models?view=client` | the CLI model catalog, fetched at startup (public — answers unauthenticated)                        |
| `GET /alpha/billing/subscriptions`    | the account plan (`data.planId`) plan gating filters against                                        |
| `GET /alpha/billing/credits`          | credit balances; purchased/free credits bypass the plan gate (see also `docs/caching.md`)           |

The plain `GET /provider/v1/models` (no query) answers unauthenticated with a
minimal OpenAI-style list (`id`, `name`, `context_length`,
`supported_endpoints` only) — not the CLI's catalog. `GET /alpha/lifecycle-events`
exists but is not part of the model-traffic surface. Neither is a staleness
signal: the router serves the identical catalog body whatever
`x-command-code-version` says, and it has no version endpoint
(`GET /versions` is 404).

The `?view=client` document carries a `catalogVersion` (a content hash, e.g.
`d4517aa3…` as of 2026-11-07), and the gateway honors conditional GET on it:
a request with `if-none-match: "<catalogVersion>"` gets a bare `304` when the
document is unchanged, which is how the CLI revalidates its catalog
(live-verified 2026-11-07).

Catalog rows may carry `hidden: true` (14 such rows as of 2026-11-05); hidden
rows are otherwise complete — same capabilities, pricing, plan gates.
Divergence (extension): a model selected through `models.yml` carries only
the id the user wrote, so the extension looks that id up in the fetched
catalog and takes the wire-relevant fields from the row — `inputModalities`
(drives image stripping, see Messages) and `reasoningEfforts` (drives
`reasoning_effort` clamping, see Request); a configured model without a rate
card also takes the row's `pricing` for cost metering.

There is, however, a real gateway-side gate — a **floor**, not a ceiling.
`/alpha/generate` validates `x-command-code-version` and rejects anything below
its minimum with a 403 whose body carries the floor (0.18.10 as of 2026-10-31):

```json
{
	"error": {
		"code": "upgrade_required",
		"message": "Your Command Code CLI is out of date. Run `cmd update` or `npm i -g command-code` to upgrade.",
		"minVersion": "0.18.10"
	}
}
```

At and above the floor the request proceeds to body validation (400); a
leading `v` is tolerated, and an ahead-of-server version is accepted, so the
header is a deprecation floor, not a protocol check. `GET /alpha/whoami` and
`GET /provider/v1/models` ignore it.

The header value is the npm **package version** — the CLI derives it from its
own `package.json` — so the pin `COMMAND_CODE_VERSION` is directly comparable
to an npm release. (The extension's staleness notices built on that fact are
local behavior, not wire protocol; see `docs/troubleshooting.md`.)

Catalog rows carry a `behaviorProfile` — a behavior string the CLI codes
against. The pinned CLI's known set is listed in `AGENTS.md`'s validation map;
a catalog value outside it means the catalog has moved ahead of the pin (the
CLI treats that as "client too old").

## Request

```
POST /alpha/generate
Authorization: Bearer user_xxxxxxxx…
Content-Type: application/json
Accept: application/x-ndjson
User-Agent: cli
x-cli-environment: production
x-command-code-version: 1.88.5
x-session-id: <uuid>
# Optional when CMD_ZDR=1:
x-cmd-zdr: 1
```

`x-session-id` is a stable per-conversation UUID, sent with the same value as
the body's `threadId`; the gateway validates it as a strict RFC 4122 UUID. It
keys the gateway's session state and prompt-cache affinity, so it must not
change mid-conversation. The CLI's is its session's `crypto.randomUUID()` —
fresh per CLI session. Divergence (extension): the value is the harness
`sessionId` when it is UUID-shaped, else a deterministic UUID derived from the
working directory, system prompt, and opening user message, so the same
conversation keeps one id across harness restarts.

Body:

```jsonc
{
	"config": {
		"workingDir": "/path",
		"date": "2026-05-28",
		"environment": "linux-x64, Node.js v24.21.0",
		"structure": [],
		"isGitRepo": false,
		"currentBranch": "",
		"mainBranch": "",
		"gitStatus": "",
		"recentCommits": []
	},
	"memory": "", // string (NOT object — empty string is fine)
	"taste": null,
	"skills": null,
	"permissionMode": "standard",
	"params": {
		"model": "deepseek/deepseek-v4-pro", // canonical id from the catalog
		"system": "…system prompt…", // plain string — see note under the envelope
		"messages": [
			/* Vercel AI SDK ModelMessage[] — see below */
		],
		"tools": [
			/* see below */
		],
		"max_tokens": 32000,
		"temperature": 0.7, // optional
		"reasoning_effort": "high", // optional; snake_case; see the note under the envelope
		"stream": true // always true in practice
	},
	"threadId": "<uuid>" // same value as the x-session-id header
}
```

The CLI also sends top-level `mode` (a use-mode string such as
`"custom-agent"` for subagent turns) and `promptCache` (`"off"` on its
internal side-requests); both are optional — the gateway accepts the body
without them, which is what the extension sends.

`params.reasoning_effort` (snake_case) is the per-turn effort selection. The
CLI sends the user's pick verbatim and only picks it from the catalog's
`reasoningEfforts` filtered through its own effort vocabulary
(`off | low | medium | high | xhigh | max` — 1.88.5 `Vr` set), so the CLI
never sends an unlisted value. The gateway, however, _does_ accept unlisted
values — and silently disables reasoning when it gets one (measured
2026-10-31). Divergence (extension): the harness's effort scale also has
`minimal` and is not constrained per model, so the extension clamps to the
catalog list before sending — nearest by rank (`off < minimal < low < medium
< high < xhigh < max`), a tie resolving to the _lower_ effort. An explicit
effort never clamps to `"off"` (a reasoning request that silently disabled
reasoning would be worse than a slightly under-thinked one); `"off"` is sent
only for `disableReasoning`, and only when the model lists it. A model whose
id the catalog doesn't know passes the requested value through.

### The `config` envelope is schema-strict

Every field above is **required**. Omitting any one returns a `400` whose
`message` lists the exact missing paths, e.g.:

```
Validation error: expected string, received undefined at "config.workingDir";
expected array, received undefined at "config.structure"; …
```

The values are not load-bearing for routing — the gateway just splices them
into the system-prompt preamble. Neutral defaults (empty strings / arrays /
`isGitRepo:false`) work fine, which is what the sample envelope above sends.

### `params.system` must be a string

The schema for `params.system` is a union of a plain string and an array of
objects; an array of strings is rejected by both branches (observed 400,
2026-10-31):

```
Validation error: Invalid input: expected string, received array at "params.system"
or Invalid input: expected object, received string at "params.system[0]"
```

Divergence (extension): the harness's system prompt arrives as parts
(`Context.systemPrompt` is `string[]`), so it is joined with `\n\n` into the
single string the wire requires before sending.

### Messages use the Vercel AI SDK `ModelMessage` schema

This is the part that surprises people. It is **not** Anthropic content blocks
and **not** OpenAI tool messages. Sending Anthropic shape returns:

```
Invalid prompt: The messages do not match the ModelMessage[] schema.
```

The three message roles:

```jsonc
// user
{ "role": "user", "content": [
  { "type": "text", "text": "…" },
  { "type": "image", "image": "data:image/png;base64,…", "mediaType": "image/png" }
]}

// assistant (reasoning + text + tool calls)
{ "role": "assistant", "content": [
  { "type": "reasoning", "text": "…" },
  { "type": "text", "text": "…" },
  { "type": "tool-call", "toolCallId": "call_…", "toolName": "read_file", "input": { "path": "x" } }
]}

// tool results — a SEPARATE message with role:"tool", not folded into a user turn
{ "role": "tool", "content": [
  { "type": "tool-result", "toolCallId": "call_…", "toolName": "read_file",
    "output": { "type": "text", "value": "file contents" } }
]}
```

- Assistant `reasoning` parts round-trip the thinking from earlier assistant
  turns. Most reasoning models preserve it server-side, but some (e.g.
  `reflection/beam:free`) 400 with
  `Missing required parameter: 'messages[N].reasoning_content'` when an
  earlier turn's reasoning is not sent back — the CLI sends the parts on
  every turn regardless.
- Tool result `output` is `{ "type": "text", "value": "…" }` (or
  `{ "type": "error-text", "value": "…" }`), **not** a raw string.
- `toolCallId` / `toolName` (camelCase, hyphen in `tool-call` / `tool-result`),
  not Anthropic's `tool_use` / `tool_use_id` / `id`.
- Consecutive tool results merge into one `role:"tool"` message.
- There is no image output for tool results: the CLI rides image blocks that
  accompany a tool result back as their own `role:"user"` message with
  `image` content parts, immediately after the `role:"tool"` message.
- Divergence (extension): for a model whose catalog `inputModalities` lack
  `"image"` (the harness default for user-configured entries is text-only —
  see the hidden-row note above), image payloads are not sent at all. Only
  the _latest_ image-bearing message keeps a stand-in — the image block
  becomes the text part `<attached_image index="N" mediaType="M" />` (N is
  the block's position in that message's content) — and an image-only older
  message is replaced with
  `[image omitted: the active model is text-only]` so the history never
  contains an empty turn. Image blocks on tool results follow the same rule:
  their follow-on `role:"user"` message carries the placeholder (latest) or
  the omission marker (older) instead of `image` parts.

### Tools

```jsonc
"tools": [
  {
    "name": "read_file",
    "description": "Read a file.",
    "input_schema": { "type": "object", "properties": { … }, "required": [ … ] }
  }
]
```

`input_schema` (snake_case) carries a standard JSON Schema. The gateway
internally rewrites this to Vercel's `{ type:"function", name, description,
inputSchema }` — you send the snake_case form, it does the translation.

## Response — newline-delimited JSON (NOT SSE)

The response body is a stream of `\n`-separated JSON objects. There is no
`data:` prefix and no `event:` lines — parse each line as its own JSON object.
A single logical block (reasoning / text / tool call) is keyed by an `id` so
you can interleave.

Event sequence for a typical tool-using turn:

```jsonc
{"type":"start"}
{"type":"start-step","request":{"body":{ … echoes the resolved upstream request … }},"warnings":[]}

{"type":"reasoning-start","id":"reasoning-0","providerMetadata":{"gateway":{"generationId":"gen_…"}}}
{"type":"reasoning-delta","id":"reasoning-0","text":"Let me "}
{"type":"reasoning-delta","id":"reasoning-0","text":"think…"}
{"type":"reasoning-end","id":"reasoning-0"}

{"type":"text-start","id":"txt-0"}
{"type":"text-delta","id":"txt-0","text":"Here"}
{"type":"text-delta","id":"txt-0","text":"'s the answer"}
{"type":"text-end","id":"txt-0"}

{"type":"tool-input-start","id":"call_00_…","toolName":"get_weather","dynamic":false}
{"type":"tool-input-delta","id":"call_00_…","delta":"{\""}
{"type":"tool-input-delta","id":"call_00_…","delta":"location\":\"Paris\"}"}
{"type":"tool-input-end","id":"call_00_…"}
{"type":"tool-call","toolCallId":"call_00_…","toolName":"get_weather","input":{"location":"Paris"}}

{"type":"finish-step","finishReason":"tool-calls","rawFinishReason":"tool_calls","usage":{ … },"providerMetadata":{ … }}
{"type":"finish","finishReason":"stop","rawFinishReason":"stop","totalUsage":{ … }}
{"type":"provider-metadata","providerMetadata":{ … }}
```

### Event reference

| `type`               | Key fields                                | Maps to harness event                            |
| -------------------- | ----------------------------------------- | ------------------------------------------------ |
| `start`              | —                                         | `start`                                          |
| `start-step`         | `request.body` (echo of upstream request) | (ignored)                                        |
| `reasoning-start`    | `id`                                      | `thinking_start`                                 |
| `reasoning-delta`    | `id`, `text`                              | `thinking_delta`                                 |
| `reasoning-end`      | `id`                                      | `thinking_end`                                   |
| `text-start`         | `id`                                      | `text_start`                                     |
| `text-delta`         | `id`, `text`                              | `text_delta`                                     |
| `text-end`           | `id`                                      | `text_end`                                       |
| `tool-input-start`   | `id`, `toolName`                          | `toolcall_start`                                 |
| `tool-input-delta`   | `id`, `delta` (JSON string chunk)         | `toolcall_delta`                                 |
| `tool-input-end`     | `id`                                      | `toolcall_end`                                   |
| `tool-call`          | `toolCallId`, `toolName`, `input` (full)  | `toolcall_end` (fallback)                        |
| `finish-step`        | `finishReason`, `usage`                   | accumulates usage                                |
| `finish`             | `finishReason`, `totalUsage`              | finalizes `done`                                 |
| `cache-write-tokens` | `cacheWriteTokens`                        | patches `cacheWrite` when `finish` reported none |
| `provider-metadata`  | `providerMetadata` (routing-specific)     | anthropic 1h cache-write split                   |
| `error`              | `error` object or top-level `message`     | `error`                                          |

**Gotcha:** the per-delta tool events use field **`id`**, but the final
redundant `tool-call` event uses **`toolCallId`**. If you key everything off
`id` you'll silently miss the `tool-call` event; resolve `id ?? toolCallId`.

The `error` event's `error` object carries `{ type, message, statusCode,
isRetryable }` (all optional), or a top-level `message`. A truncated stream
(no terminal `finish`/`finish-step`) is a wire error in itself.

`finishReason` observed values: `"stop"`, `"length"`, `"tool-calls"`.
Current streams commonly contain both `finish-step` and `finish`; consumers
must emit one terminal result and reject EOF if neither event arrives.

### Usage shape (in `finish-step`)

```jsonc
"usage": {
  "inputTokens": 5418,                // TOTAL input (cached + uncached)
  "outputTokens": 32,
  "totalTokens": 5450,
  "cachedInputTokens": 5376,          // cache-read hits
  "inputTokenDetails": { "noCacheTokens": 42, "cacheReadTokens": 5376 },
  "outputTokenDetails": { "textTokens": 3, "reasoningTokens": 29 },
  "reasoningTokens": 29,
  "raw": {                            // raw upstream provider numbers
    "prompt_tokens": 5418,
    "completion_tokens": 32,
    "prompt_cache_hit_tokens": 5376,
    "prompt_cache_miss_tokens": 42,
    "total_tokens": 5450,
    "completion_tokens_details": { "reasoning_tokens": 29 }
  }
}
```

Field semantics: `inputTokens` is the _total_ including cached tokens,
following the Vercel AI SDK convention. A consumer that meters per-bucket
cost must first apply the `input = inputTokens - cachedInputTokens`
reduction to reach disjoint buckets (the bucket math and its effect on
metering are in `docs/caching.md`).

### `providerMetadata` (in `finish-step` / terminal `provider-metadata`)

Which keys appear depends on how the gateway routed the call: Vercel AI
Gateway routing carries `gateway` metadata (routing, `generationId`); a direct
upstream carries its own key (e.g. `novita` with prediction-token stats). The
Anthropic 1-hour cache-write split arrives as
`anthropic.usage.cache_creation.ephemeral_1h_input_tokens` on a terminal
`provider-metadata` event.

### No per-request USD on the wire

The stream reports usage, not money: no endpoint or event carries a per-turn
charge. Any USD number the harness shows is a local computation from the
catalog's `pricing` rates (USD per 1M tokens) over the turn's usage — see
`docs/caching.md` for the bucket math and the README for what the meter does
and does not measure (it estimates upstream cost; the plan's per-model credit
multipliers are not applied).
