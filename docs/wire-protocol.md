# `/alpha/generate` wire protocol

Command Code does not publish an API reference for this endpoint. Everything
here was reverse-engineered from the `command-code` npm CLI (currently verified
against v1.88.2) and
confirmed against the live gateway. Treat it as a snapshot that can drift —
when it breaks, re-derive from the current CLI bundle (`$(npm root -g)/command-code/dist/cli.mjs`).

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

The CLI also supports `--local` (`http://localhost:9090`) and `--staging`
(`https://staging-api.commandcode.ai`); not relevant here.

### Other endpoints the extension touches

| Path                                  | Purpose                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /alpha/whoami`                   | `/login commandcode-alpha` validates the pasted key here, mirroring the CLI; a 401 rejects the key, 403/unreachable keeps it           |
| `GET /provider/v1/models?view=client` | the CLI model catalog discovery reads at startup (public — answers unauthenticated); no static fallback in `index.ts` when unavailable |
| `GET /alpha/billing/subscriptions`    | the account plan (`data.planId`) plan gating filters against                                                                           |
| `GET /alpha/billing/credits`          | credit balances; purchased/free credits bypass the plan gate (see also `docs/caching.md`)                                              |

The plain `GET /provider/v1/models` (no query) answers unauthenticated with a
minimal OpenAI-style list (`id`, `name`, `context_length`, `supported_endpoints`
only) — the extension does not use it. `GET /alpha/lifecycle-events` is not
used either. Neither is a staleness signal: the router serves the identical
catalog body whatever `x-command-code-version` says, and it has no version
endpoint (`GET /versions` is 404).

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
own `package.json` — so the extension's pin is directly comparable to the npm
release, which is what `update.ts` relies on.

The CLI's own notion of "this client is too old for the _protocol_" is purely
local: its catalog parser maps an unknown `behaviorProfile` onto
`client-update-required`. That, plus npm's published version, is what
`update.ts` uses (see "Staleness notice" below).

### Staleness notice

`COMMAND_CODE_VERSION` is a protocol pin, not an install dependency: a newer
`command-code` release means the envelope in this document may have drifted.
At `session_start` the extension asks npm for the newest **stable** release and,
when the pin is behind, sets the status-line entry `commandcode-cli`
(`ctx.ui.setStatus`) to `Command Code <latest> released · pin <old> stale`.

This mirrors the CLI's own updater rather than inventing a new source: in the
1.88.2 bundle `fetchVersions` shells out to `npm view command-code versions
--json`, `isPrereleaseVersion` drops prereleases, `getLatestVersion` takes the
semver maximum, and `determineUpdateTarget` compares it with the CLI's own
version. `update.ts` asks npm's dist-tags document instead of the full
packument (~90 bytes versus ~1.2 MB) and applies the same prerelease filter and
semver max; `latest` advances with every stable publish, so the two agree.

The check is detached (the harness awaits `session_start` handlers) and
advisory: an unreachable registry, a non-200, an unparseable body, or a null
result paints nothing. It also fetches nothing from `api.commandcode.ai`, so it
works before login and does not depend on the key.

## Request

```
POST /alpha/generate
Authorization: Bearer user_xxxxxxxx…
Content-Type: application/json
Accept: application/x-ndjson
User-Agent: cli
x-cli-environment: production
x-command-code-version: 1.88.2
x-session-id: <uuid>
# Optional when CMD_ZDR=1:
x-cmd-zdr: 1
```

`x-session-id` is a stable per-conversation UUID (the CLI uses its session's
`crypto.randomUUID()`; the extension uses the harness `sessionId` when it is
UUID-shaped, else a deterministic UUID derived from the working directory,
system prompt, and opening user message). The same value is sent as the body's
`threadId`; the gateway validates it as a strict RFC 4122 UUID. It keys the
gateway's session state and prompt-cache affinity, so it must not change
mid-conversation.

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
		"stream": true // always true in practice
	},
	"threadId": "<uuid>" // same value as the x-session-id header
}
```

The CLI also sends top-level `mode` (a use-mode string such as
`"custom-agent"` for subagent turns) and `promptCache` (`"off"` on its
internal side-requests); both are optional — the gateway accepts the body
without them, which is what the extension sends. `params.reasoning_effort` is
the CLI's per-turn effort selection (snake_case, sent only for thinking models
with an explicit effort); the extension omits it and the model runs at its
default effort.

### The `config` envelope is schema-strict

Every field above is **required**. Omitting any one returns a `400` whose
`message` lists the exact missing paths, e.g.:

```
Validation error: expected string, received undefined at "config.workingDir";
expected array, received undefined at "config.structure"; …
```

The values are not load-bearing for routing — the gateway just splices them
into the system-prompt preamble. Neutral defaults (empty strings / arrays /
`isGitRepo:false`) work fine. A fork that wants real project context (for
Command Code's "taste" subsystem) populates them for real; see `staticConfig()`
in `index.ts`.

### `params.system` must be a string

The schema for `params.system` is a union of a plain string and an array of
objects; an array of strings is rejected by both branches (observed 400,
2026-10-31):

```
Validation error: Invalid input: expected string, received array at "params.system"
or Invalid input: expected object, received string at "params.system[0]"
```

The harness (pi-ai) hands the system prompt as parts — `Context.systemPrompt`
is `string[]` — so `systemPromptText()` in `session.ts` joins them with
`\n\n` before sending. The session-id seed uses the same canonicalization so
both prompt forms keep one identity.

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
  earlier turn's reasoning is not sent back. The CLI sends the parts on every
  turn, and so does the extension.
- Tool result `output` is `{ "type": "text", "value": "…" }` (or
  `{ "type": "error-text", "value": "…" }`), **not** a raw string.
- `toolCallId` / `toolName` (camelCase, hyphen in `tool-call` / `tool-result`),
  not Anthropic's `tool_use` / `tool_use_id` / `id`.
- Consecutive tool results merge into one `role:"tool"` message.
- There is no image output for tool results (the CLI does the same): image
  blocks that accompany a tool result ride back as their own `role:"user"`
  message with `image` content parts, immediately after the `role:"tool"`
  message.

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
| `error`              | `error` or `message`                      | `error`                                          |

**Gotcha:** the per-delta tool events use field **`id`**, but the final
redundant `tool-call` event uses **`toolCallId`**. If you key everything off
`id` you'll silently miss the `tool-call` event. `index.ts` resolves
`id ?? toolCallId` and dedupes so a doubled end event can't fire twice.

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

**Important for cost math:** `inputTokens` is the _total_ including cached
tokens, following the Vercel AI SDK convention. The harness's `Usage` shape expects
`input` and `cacheRead` to be **disjoint** (it computes
`totalTokens = input + output + cacheRead + cacheWrite` and bills each
separately). So the extension does `input = inputTokens - cachedInputTokens`.
See `docs/caching.md`.

### `providerMetadata` (in `finish-step` / terminal `provider-metadata`)

Which keys appear depends on how the gateway routed the call: Vercel AI
Gateway routing carries `gateway` metadata (routing, `generationId`); a direct
upstream carries its own key (e.g. `novita` with prediction-token stats). The
extension reads exactly one key out of `providerMetadata`:
`anthropic.usage.cache_creation.ephemeral_1h_input_tokens` on a terminal
`provider-metadata` event — the Anthropic 1-hour cache-write split.

### Cost

The gateway reports usage but no per-request USD. The extension computes cost
locally from the catalog's `pricing` rates (USD per 1M tokens, carried onto
each discovered model):

```
cost = (uncachedInput × input + output × output
        + cacheRead × cacheRead + cacheWrite × cacheWrite) / 1_000_000
```

`uncachedInput` is `inputTokens` minus the cache-read and cache-write tokens
(the usage buckets are disjoint, see above). `cacheWrite` comes from
`inputTokenDetails.cacheWriteTokens` on the terminal `usage`, is patched by
the `cache-write-tokens` event when that reported 0, and the 1-hour split is
folded in when it exceeds the reported total. The result lands in
`usage.cost` (per-bucket USD plus `total`, which the session meter reads).
These are the catalog's market rates; the Go plan's per-model credit
multipliers are not applied, so the metered number is an upstream-cost
estimate, not what the account is debited.
