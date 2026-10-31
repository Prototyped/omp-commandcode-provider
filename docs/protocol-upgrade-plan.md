# Protocol upgrade plan — 0.52.1 → 1.88.2

Status: proposal, not yet implemented. Every statement below was verified on 2026-10-31 against the
live gateway with a real key, or read out of one of the two CLI bundles
(`command-code@0.52.1` — the current pin — and `command-code@1.88.2`, the
current npm `latest`). Claims that are inference are marked `[INFERENCE]`.
`docs/wire-protocol.md` is **not** treated as evidence anywhere in this
document; §1 audits it.

## Verdict

The **request/response wire contract did not break.** An unmodified 0.52.1-shaped
body still returns 200 and the same NDJSON event sequence from the live gateway.
The 400/401/403 error surface is unchanged.

Four things did change, and three of them are the extension's responsibility:

1. **Cost reporting regressed.** `providerMetadata.gateway.cost` — the field
   `stream.ts` meters from — is **gone**. No probe of any model returned it.
   The extension therefore meters `$0.00` for every call today (measured).
   The gateway now reports usage only; cost must be derived client-side from
   the catalog's `pricing` rates, which is what 1.88.2 does
   (`estimateCatalogCostUsd`).
2. **Capability sourcing moved to the gateway.** 1.88.2 replaces its hardcoded
   model registry (`Kt`) with `GET /provider/v1/models?view=client`, a versioned
   catalog carrying `context_length`, `maxOutputTokens`, `inputModalities`,
   `reasoningEfforts`, `pricing`, `hidden`, `category`, `minimumPlan`, `zdr`,
   `aliases`, `roles`, and a per-model `behaviorProfile`. The extension still
   guesses all of this from models.dev.
3. **Per-model protocol quirks became data.** Six `behaviorProfile` values now
   drive deferred tools, interleaved thinking, thinking-prefix binding, and
   forced tool choice. The extension sends none of the corresponding request
   fields (`reasoning_effort`, `promptCache`, `mode`) and has no equivalent of
   the vision-stripping preprocessing.
4. **The CLI version floor moved.** The pinned `0.52.1` is still above the
   gateway floor (`minVersion: 0.18.10`), so nothing is broken _now_ — but the
   pin no longer describes what the gateway is actually doing.

## 1. `docs/wire-protocol.md` audit

Verified claim by claim. "True" = reproduced live on 2026-10-31.

| Claim in the doc                                                                                                                                    | Verdict               | Evidence                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Response is newline-delimited JSON, not SSE                                                                                                         | **True**              | One JSON object per `\n`, no `data:`/`event:` prefixes                                                                                                 |
| Event vocabulary `start`, `start-step`, `reasoning-*`, `text-*`, `tool-input-*`, `tool-call`, `finish-step`, `finish`, `provider-metadata`, `error` | **True**              | All observed in one tool-calling turn                                                                                                                  |
| Tool deltas key on `id`, final `tool-call` keys on `toolCallId`                                                                                     | **True**              | `{"type":"tool-input-start","id":"call_00_…"}` … `{"type":"tool-call","toolCallId":"call_00_…"}`                                                       |
| `params.system` must be a string; `string[]` is rejected                                                                                            | **True**              | `["a","b"]` → 400 `expected object, received string at "params.system[0]"`. `"a"` and `[{type:"text",text:"a"}]` and blocks with `cache_control` → 200 |
| Every `config.*` field is required                                                                                                                  | **True**              | Deleting any one of the nine → 400 naming that path                                                                                                    |
| `memory` is a required string                                                                                                                       | **True**              | Missing → 400; `""` → 200; `null` also accepted; `{}` → 400                                                                                            |
| `taste`, `skills`, `permissionMode`, `threadId`, `mode` are required                                                                                | **False**             | Each omits cleanly → 200. (`skills`/`memory` reject non-strings; `taste` accepts a string)                                                             |
| `threadId` must be a strict RFC 4122 UUID                                                                                                           | **True**              | `"not-a-uuid"` → 400 `Invalid UUID at "threadId"`; omission → 200                                                                                      |
| Messages are Vercel `ModelMessage[]`; Anthropic shape returns 400                                                                                   | **False**             | A user message containing an Anthropic `tool_result` block → 200. Roles are restricted to `user`/`assistant`(+`tool`): `role:"system"` → 400           |
| Tool result `output` must be `{type:"text"                                                                                                          | "error-text", value}` | **Overstated**                                                                                                                                         | An arbitrary `output` type (`{type:"nope"}`) → 200; a bare string → 200 |
| `tool-result` requires `toolName`                                                                                                                   | **True**              | Missing → 400 (the error message misreports it as a role/content failure)                                                                              |
| Images ride as their own `role:"user"` message; no images in tool-result output                                                                     | **False**             | `output:{type:"content",value:[{type:"media",data,mediaType}]}` → 200. 1.88.2's own `toolResultOutput` emits exactly that shape                        |
| Tools are `{name,description,input_schema}` (snake_case)                                                                                            | **True**              | `parameters`/`inputSchema` → 400                                                                                                                       |
| Cost is read from `providerMetadata.gateway.cost` / `.inferenceCost`                                                                                | **False**             | Absent from every probe (5 consecutive calls, 4 models, ZDR on/off). `providerMetadata` only carried `{novita:{...}}` or `{deepseek:{...}}`            |
| `finish-step.usage` and `finish.totalUsage`                                                                                                         | **True**              | Both present; `finish` carries the same numbers                                                                                                        |
| `usage.cachedInputTokens`, `.inputTokenDetails.cacheReadTokens`, `.raw.prompt_cache_hit_tokens`                                                     | **True**              | All three present and equal on a warm prefix (1536)                                                                                                    |
| `finishReason` values `stop`/`length`/`tool-calls`                                                                                                  | **True**, incomplete  | Also `refusal` in 1.88.2's own mapper (`consumedStopReason`)                                                                                           |

Net: the structural claims hold. The two that mislead are the **cost field** and
**"everything is required"**; both are corrected by this plan.

## 2. Live-verified protocol facts (the basis for the work below)

- **Model id rewriting.** Requesting `deepseek/deepseek-v4-flash` returns
  `response.modelId: "deepseek/deepseek-v4.1-flash"`. Requests must not assume
  `model.id` is what served the turn.
- **Reasoning effort is advisory and unvalidated.** The gateway accepts any
  string. On a model whose catalog `reasoningEfforts` is
  `["off","low","high","max"]`, efforts `medium`/`xhigh`/`minimal`/`bogus` all
  yield **0 reasoning tokens**, while `low`/`high`/`max` produce 70/90/103.
  Omitting the field yields 0 for that model. Only the CLI's client-side guard
  (`supportsThinking && isThinkingEffort`) keeps it inside the supported set.
- **Vision is gated by the model, silently.** A red 64×64 PNG with
  `deepseek/deepseek-v4.1-flash` → _"This image is red."_; the same image with
  text-only `deepseek/deepseek-v4-flash` → _"no image was provided"_. No error.
  1.88.2 therefore strips images client-side for non-vision models
  (`stripImages` + `hasImage2`), replacing the last user message's images with
  `<attached_image index="N">…` text and earlier ones with
  `[image omitted: the active model is text-only]`.
- **Prompt caching is content-addressed, not thread-addressed.** A fresh
  `threadId` with a previously-seen prefix still reported
  `cacheReadTokens: 1536` on its first call; a mismatched body/header
  `threadId` did not disturb the hit. The README's claim that `threadId` holds
  cache affinity is wrong; caching depends on prefix bytes (and is worth
  measuring again after any change to `staticConfig()` or the system prompt).
- **`x-command-code-version` does not change behaviour above the floor.** The
  same request under `0.18.10`, `0.52.1`, and `1.88.2` produced byte-identical
  event type sequences. Below the floor: 403 `upgrade_required` with
  `error.minVersion` (`0.18.10` as of today).
- **Two distinct failure channels.** Pre-flight problems are HTTP errors with
  a JSON body: an unknown model id and a plan-gated model both return 403
  (`Model/provider not recognized: …`, `MODEL_NOT_IN_PLAN: …`). A model that is
  recognised but currently down returns **200** and streams
  `{"type":"start"}` then
  `{"type":"error","error":{"type":"server_error","message":"This model is
  temporarily unavailable.","statusCode":400,"isRetryable":false}}` with no
  `finish`. A client that only reports "stream ended before a terminal event"
  describes the wrong cause.
- **`pause_turn`.** 1.88.2 loops up to 5 times (`vS=5`) re-POSTing the identical
  body when `rawFinishReason === "pause_turn"`, appending content. The event is
  not reachable from the streams observed here; treat as tolerance, not a
  feature to build `[INFERENCE]`.
- **Catalog ≠ roster.** `GET /provider/v1/models` (plain) returns 95 rows with
  only `id/name/context_length/supported_endpoints`; `?view=client` returns the
  107-row catalog with capabilities and pricing. Every roster id is in the
  catalog; the 12 extras are `:free`/stealth/hidden models. Twelve catalog rows
  carry `hidden: true` and none of those appear in the plain roster.

## 3. Plan

Ordered by user-visible value per unit of risk. Each phase is independently
shippable and testable; nothing depends on a phase landing after it except
where stated.

### Phase 1 — Cost: stop metering zero (highest value, self-contained)

Today `applyUsage` is right (verified against live numbers: `input` excludes
cache reads, `cacheRead` matches `inputTokenDetails.cacheReadTokens`) but
`updateGatewayCost` can never fire, so `usage.cost.total` is always 0.

1. Add `pricing` to discovery output and set the model's `cost` rates from it
   (`inputCost`, `outputCost`, `cacheReadCost`, `cacheWriteCost`,
   `cacheWrite1hCost` — USD per 1M tokens, matching pi's rate convention).
2. Keep `providerMetadata.gateway.cost` as a _first-class override_ when
   present (some routing may restore it) and fall back to local rate math
   otherwise: `uncached*input + output*output + cacheRead*cacheRead +
   cacheWrite5m*cacheWrite + cacheWrite1h*cacheWrite1h`, with
   `uncached = max(0, input - cacheRead - cacheWrite)`.
3. Honour `pricing.contextTiers` when present (none in today's catalog; the
   schema allows an ordered tier list keyed by `maxContext`).

   The formula is already validated against live usage for
   `deepseek/deepseek-v4-flash` (`inputCost 0.15`, `outputCost 0.6`,
   `cacheReadCost 0.003`): a cold 762-in/1-out call prices at $1.149e-4, the
   same call with 512 cache-read tokens at $3.964e-5 — the ~2.9× saving the
   caching doc predicts.
4. Add `usage.cacheWrite` from `finish.totalUsage.inputTokenDetails.cacheWriteTokens`
   (currently hardcoded 0) and read the two new 1.88.2 events:
   `provider-metadata` → `providerMetadata.anthropic.usage.cache_creation.ephemeral_1h_input_tokens`
   into `cacheWrite1h`; `cache-write-tokens` → top-level `cacheWriteTokens`,
   applied only when `finish` reported 0 (mirror the CLI's precedence).
5. Tests: rate math for an uncached, a cache-read, and a 1h-cache-write turn;
   override precedence; tier selection.

Verification: a single live turn must meter a non-zero cost within ~1% of
`/alpha/usage/summary` deltas for the same model.

### Phase 2 — Discovery: authoritative capabilities from the catalog

Replace the models.dev join with `GET /provider/v1/models?view=client`, keeping
models.dev only as a fallback for ids the catalog omits (currently: zero).

1. Parse `{schemaVersion, catalogVersion, refreshAfterSeconds, roles, data[]}`.
   Reject `schemaVersion !== 1` and fall back rather than guessing
   (`parseModelCatalog`'s rule). Reuse `cachedInputTokens`-style leniency
   nowhere here: catalog fields are strict numbers.
2. Map each row: `context_length` → `contextWindow`; `maxOutputTokens` →
   `maxTokens` (fall back to the models.dev `limit.output`, then the current
   8192, when `null` — 96 of 107 rows are `null`); `inputModalities.includes("image")`
   → `input`; `reasoningEfforts.length > 0` → `reasoning`; `pricing` → `cost`
   (Phase 1); `hidden` → drop; `aliases` → resolution; `zdr`/`category`/
   `minimumPlan` → keep for filtering/reporting.
3. Fix two live discrepancies the models.dev join creates today: it marks 13
   models reasoning-capable whose catalog says they expose no effort control,
   and it advertises `limit.output` 384000 for `deepseek/deepseek-v4-flash`
   where the catalog says "unknown".
4. Keep the existing `excludedModels` filter and the proprietary-prefix filter.
   Re-check the prefix filter against `category: "premium"` (26 rows) — that
   flag is the gateway's own "bills real credits" marker and is a better
   filter than id prefixes `[INFERENCE on intent]`.
5. Honour `roles` when choosing a default: `roles.default` plus
   `roles.features.{vision,compaction,titleGeneration,toolDescription,…}`.
   At minimum, use `roles.features.vision` to pick the model for image turns
   `[INFERENCE]` — the extension cannot submit a second request, so this is
   only actionable as a user-facing notice.
6. Cache with the ETag (`if-none-match: "<catalogVersion>"` → 304) and respect
   `refreshAfterSeconds` (currently 900) instead of refetching per startup;
   `omp models refresh` must still force a refetch. Honour
   `CMD_DISABLE_REMOTE_MODEL_CATALOG=1` as the CLI does.

### Phase 3 — Per-model wire quirks (`behaviorProfile`)

1. Implement the table, keyed by the profile string on each catalog row:

   | profile                            | deferred tools | interleaved thinking | binds thinking to prefix | forced tool choice |
   | ---------------------------------- | -------------- | -------------------- | ------------------------ | ------------------ |
   | `standard-v1`                      | yes            | no                   | no                       | yes                |
   | `no-deferred-tools-v1`             | no             | no                   | no                       | yes                |
   | `private-reasoning-v1`             | no             | yes                  | no                       | yes                |
   | `anthropic-interleaved-v1`         | yes            | yes                  | no                       | yes                |
   | `anthropic-prefix-bound-v1`        | yes            | yes                  | yes                      | no                 |
   | `anthropic-prefix-bound-forced-v1` | yes            | yes                  | yes                      | yes                |

   An unknown profile is the CLI's own "too old for the protocol" signal —
   surface it in the status line rather than silently ignoring it.
2. What each flag must change here:
   - _interleaved thinking_: reasoning blocks may arrive **between** text/tool
     blocks rather than only first. `BlockStreams` already keys blocks by id, so
     this is likely already handled — add a test with an interleaved stream
     rather than new code.
   - _binds thinking to prefix_: prior reasoning must be replayed on assistant
     history or the prefix stops matching `[INFERENCE from
     `bindsThinkingToPrefix`]`. This is the one that interacts with the current
     deliberate omission of reasoning from `convertMessages`.
   - _deferred tools_: the CLI loads a `search_tools` meta-tool instead of
     every schema. Not applicable — the harness owns tool selection; document
     the divergence.
   - _forced tool choice_: no `tool_choice` field exists anywhere in either
     bundle (0 hits), so this flag is server-side only. Nothing to send.
3. Tests: profile lookup, unknown-profile notice, interleaved stream ordering.

### Phase 4 — Reasoning effort plumbing

1. Map `SimpleStreamOptions.reasoning` (`minimal|low|medium|high|xhigh|max`)
   → `params.reasoning_effort`, clamped to the model's catalog
   `reasoningEfforts`. Never send a value the model doesn't list — the gateway
   accepts it and silently disables reasoning (measured).
2. `disableReasoning: true` → send `"off"` when the model lists it, else omit.
3. `reasoning: false` models: omit the field entirely.
4. Live check per model family that the chosen effort actually produces
   reasoning tokens; add a smoke script (not a unit test) because the mapping is
   server-side.

### Phase 5 — Vision correctness

1. Add `mimeType` to image parts (`{type:"image", image:"data:<mt>;base64,…",
   mimeType:<mt>}`) — 1.88.2 adds it; the gateway accepts both.
2. Implement `stripImages` for text-only models, driven by catalog
   `inputModalities`: keep the newest image-bearing user message's images as
   `<attached_image index="N">…image_index=N…` text, drop images from older user
   messages, and use `[image omitted: the active model is text-only]` when a
   message would otherwise empty. This replaces today's silent mis-description.
3. Images in tool results: emit `output:{type:"content",value:[{type:"text"},
   {type:"media",data,mediaType}]}` (accepted live) instead of the current
   text-only `toWireToolOutput`-equivalent, if the harness surfaces them.

### Phase 6 — Terminal-event and error handling

1. Handle the `error` event's real shape
   (`{type:"error",error:{type,message,statusCode,isRetryable}}`) and keep the
   existing rule that a stream without a terminal event throws; the message
   should distinguish "gateway reported an error" from "truncated stream".
2. Accept `refusal` in `resolveStopReason` (map to `stop` plus a surfaced
   error message, since pi has no refusal reason).
3. Consume `systemPromptTokens` from `finish` — additive to input accounting,
   currently ignored `[INFERENCE: pi has no slot; decide display vs usage]`.
4. Treat `pause_turn` as a tolerated terminal: if it ever appears, fail loudly
   rather than reporting a truncated answer.

### Phase 7 — Docs and pin

1. Rewrite the two misleading sections of `docs/wire-protocol.md` (cost, "every
   field required") and add the audit table from §1, with the date and method
   for each verdict.
2. Correct the README's cache-affinity claim (§2).
3. Bump `COMMAND_CODE_VERSION` to `1.88.2` **last**, once the above lands; the
   status-line notice clears itself when the pin matches npm.

## 4. Deliberate non-goals

- **No `mode` / `promptCache` on the wire.** `mode` is a CLI-side request class
  (`tool-desc`, `compact`, `custom-agent`, …) and `promptCache` currently only
  validates as `"off"` — sending either buys nothing for a chat turn. `mode`
  omission is verified 200.
- **No reasoning round-trip by default.** Replaying prior reasoning inflates
  every request's input tokens. Revisit only if a `bindsThinkingToPrefix` model
  shows a cache regression in Phase 3's measurements.
- **No retries.** Unchanged guardrail; the harness owns retry/fallback.

## 5. Verification gates

Per phase: `bun run check`, `bun run lint`, `bun test`, then a live smoke with
the extension's own `streamSimple` (not a hand-built body) against a cheap model,
checking usage/cost, and — for anything touching request bytes — a second call
on a warm prefix to confirm the cache still hits.
