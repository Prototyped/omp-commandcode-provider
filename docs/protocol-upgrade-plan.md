# Protocol upgrade plan — 0.52.1 → 1.88.2

Status: proposal, not yet implemented. Everything below was verified on
2026-10-31 against the live gateway with a real key, or read out of one of the
two CLI bundles (`command-code@0.52.1` — the current pin — and
`command-code@1.88.2`, the current npm `latest`). Inference is marked
`[INFERENCE]`. `docs/wire-protocol.md` is **not** treated as evidence anywhere
here; §1 audits it.

## Verdict

The **request/response wire contract did not break.** An unmodified 0.52.1-shaped
body still returns 200 and the same NDJSON event sequence. What changed is
everything around the body:

1. **Cost must be computed client-side.** `providerMetadata.gateway.cost` /
   `.inferenceCost` were never observed on any stream (5 consecutive calls,
   4 models, ZDR on and off). The extension meters `$0.00` per call today
   (measured). Those fields appear to have been inferred from the Vercel AI SDK
   rather than observed on this gateway; treat them as non-existent and do not
   keep an override path for them. 1.88.2 computes USD from the catalog's
   `pricing` rates (`estimateCatalogCostUsd`), and that is the only sound source.
2. **Capabilities come from the gateway catalog.** 1.88.2 replaced its hardcoded
   registry (`Kt`) with `GET /provider/v1/models?view=client`: a versioned
   document carrying `context_length`, `maxOutputTokens`, `inputModalities`,
   `reasoningEfforts`, `pricing`, `hidden`, `category`, `minimumPlan`, `zdr`,
   `aliases`, `roles`, and a per-model `behaviorProfile`.
3. **Per-model quirks became data.** Six `behaviorProfile` values drive deferred
   tools, interleaved thinking, thinking-prefix binding, and forced tool choice.
4. **Several models fail through this extension's shape but not the CLI's** —
   see §3. Three distinct causes, all fixable, none of them a broken protocol.

The CLI version floor (`minVersion: 0.18.10`) still admits the pin, so nothing
is broken _now_; the pin simply no longer describes what the gateway is doing.

## 1. `docs/wire-protocol.md` audit

"True" = reproduced live on 2026-10-31.

| Claim in the doc                                                                                                                                    | Verdict              | Evidence                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Response is newline-delimited JSON, not SSE                                                                                                         | **True**             | One JSON object per `\n`, no `data:`/`event:` prefixes                                                                                               |
| Event vocabulary `start`, `start-step`, `reasoning-*`, `text-*`, `tool-input-*`, `tool-call`, `finish-step`, `finish`, `provider-metadata`, `error` | **True**             | All observed in one tool-calling turn                                                                                                                |
| Tool deltas key on `id`, final `tool-call` keys on `toolCallId`                                                                                     | **True**             | `{"type":"tool-input-start","id":"call_00_…"}` … `{"type":"tool-call","toolCallId":"call_00_…"}`                                                     |
| `params.system` must be a string; `string[]` is rejected                                                                                            | **True**             | `["a","b"]` → 400 `expected object, received string at "params.system[0]"`. `"a"`, `[{type:"text",text:"a"}]`, and blocks with `cache_control` → 200 |
| Every `config.*` field is required                                                                                                                  | **True**             | Deleting any one of the nine → 400 naming that path                                                                                                  |
| `memory` is a required string                                                                                                                       | **True**             | Missing → 400; `""` → 200; `null` → 200; `{}` → 400                                                                                                  |
| `taste`, `skills`, `permissionMode`, `threadId`, `mode` are required                                                                                | **False**            | Each omits cleanly → 200                                                                                                                             |
| `threadId` must be a strict RFC 4122 UUID                                                                                                           | **True**             | `"not-a-uuid"` → 400 `Invalid UUID at "threadId"`; omission → 200                                                                                    |
| Messages are Vercel `ModelMessage[]`; Anthropic shape returns 400                                                                                   | **False**            | A user message containing an Anthropic `tool_result` block → 200. Roles are limited to `user`/`assistant`(+`tool`): `role:"system"` → 400            |
| Tool-result `output` must be `{type:"text"\|"error-text", value}`                                                                                   | **Overstated**       | An arbitrary `output.type` (`{type:"nope"}`) → 200; a bare string → 200                                                                              |
| `tool-result` requires `toolName`                                                                                                                   | **True**             | Missing → 400 (the error text misreports it as a role/content failure)                                                                               |
| Images ride as their own `role:"user"` message; no images in tool-result output                                                                     | **False**            | `output:{type:"content",value:[{type:"media",data,mediaType}]}` → 200; 1.88.2's `toolResultOutput` emits exactly that                                |
| Tools are `{name,description,input_schema}` (snake_case)                                                                                            | **True**             | `parameters`/`inputSchema` → 400                                                                                                                     |
| Cost is in `providerMetadata.gateway.cost` / `.inferenceCost`                                                                                       | **False — remove**   | Never observed in any stream; `providerMetadata` only ever carried `{novita:{…}}` or `{deepseek:{…}}`                                                |
| `finish-step.usage` and `finish.totalUsage`                                                                                                         | **True**             | Both present, same numbers                                                                                                                           |
| `usage.cachedInputTokens`, `.inputTokenDetails.cacheReadTokens`, `.raw.prompt_cache_hit_tokens`                                                     | **True**             | All three present and equal on a warm prefix                                                                                                         |
| `finishReason` ∈ `stop`/`length`/`tool-calls`                                                                                                       | **True, incomplete** | 1.88.2's own mapper also produces `refusal`                                                                                                          |

## 2. Live-verified protocol facts

- **Model id rewriting.** Requesting `deepseek/deepseek-v4-flash` returns
  `response.modelId: "deepseek/deepseek-v4.1-flash"`. Never assume the requested
  id is the served one.
- **Prompt caching is content-addressed, not thread-addressed.** A _fresh_
  `threadId` with a previously-seen prefix still reported 1024–1536
  `cacheReadTokens` on its first call; a mismatched body/header `threadId` did
  not disturb the hit. The README's affinity claim is wrong.
- **`x-command-code-version` changes nothing above the floor.** `0.18.10`,
  `0.52.1` and `1.88.2` produced byte-identical event sequences. Below the floor
  (`0.18.10` today): 403 `upgrade_required` with `error.minVersion`.
- **`params.system` accepts a plain string _or_ text blocks** — but not the
  harness's `string[]`, which is why `session.ts` joins first. Text blocks
  additionally accept `cache_control: {type:"ephemeral"}`.
- **Reasoning effort is unvalidated and silently degrades.** On a model whose
  catalog `reasoningEfforts` is `["off","low","high","max"]`, the values
  `medium`/`xhigh`/`minimal`/`bogus` all produced **0** reasoning tokens, while
  `low`/`high`/`max` produced 70/90/103.
- **Two failure channels.** Pre-flight failures are HTTP errors with a JSON
  body (403 `MODEL_NOT_IN_PLAN`, 403 `Model/provider not recognized`, 429
  `RATE_LIMITED`, 422 `CMD_ZDR_NO_PROVIDERS`). A recognised-but-down model
  returns **200** and streams `{"type":"error",…}` with no `finish`.

## 3. Why some models fail here but work in the CLI

Sampled all 69 `opensource`-category roster models plus the `:free` entries
through the extension's own `streamSimple` and a hand-built body. Result: 20 OK,
14 plan-gated, 1 quota-limited, 4 stream errors. Four independent causes:

### 3.1 Plan gating is enforced client-side by the CLI (14 models)

The gateway returns 403 `MODEL_NOT_IN_PLAN` for models above the account's plan.
1.88.2 never sends those requests: it fetches `/alpha/billing/subscriptions`
(`planId`, e.g. `individual-go-v1`) and `/alpha/billing/credits`
(`purchasedCredits`, `freeCredits`), then filters the picker with
`evaluateModelAccess`:

```
if (purchasedCredits > 0 || freeCredits > 0) return allowed;
if (!planId) return allowed;
const n = Qr[planId];                       // { allowedCategories }
const o = getCatalogModelAccess(model);     // { minimumPlan, category }
if (!o?.category) return allowed;
if (o.minimumPlan === undefined) return categoryAccess(n, o.category);
return rankedAccess(planId, o.minimumPlan) ?? embeddedAccess(…) ?? categoryAccess(…);
```

with the rank order `["individual-go","individual-go-v1","individual-goat",
"individual-pro","individual-pro-v1","individual-provider","individual-max",
"individual-ultra","teams-pro"]` and category access `individual-go*` →
`opensource` only; `individual-pro`/`-provider`/`-max`/`-ultra`/`teams-pro` →
`opensource` + `premium`.

The extension performs no such filter, so it registers and offers models that
can only fail. Replaying that rule offline against the live catalog reproduces
**every** observed 403 exactly (e.g. `meta/muse-spark-1.3` → `individual-goat`,
`claude-opus-5` → `individual-provider`, `gpt-5.6-sol` → `individual-goat`).

Note the trap: `category` is not a plan signal. `claude-sonnet-5-5`,
`gpt-5.6-sol` and `meta/muse-spark-1.3` are all `category: "opensource"` yet need
`individual-goat`; the existing `PROPRIETARY_PREFIXES` filter happens to catch
the first two and misses the third.

### 3.2 Retired and dead ids (roster/catalog disagree with upstream)

- `poolside/laguna-s-2.1-free` → `Model 'poolside/laguna-s-2.1-free' not found.
  If you were using its free tier, that has ended.` It is **still present in the
  plain roster** (`GET /provider/v1/models`), so trusting that endpoint alone
  yields a dead model.
- `Qwen/Qwen3.6-Max-Preview` → `Model 'alibaba/qwen-3.6-max-preview' not found`
  (the gateway rewrites to an id no upstream serves).
- `inclusionai/ling-3.1-flash:free` → `The free Ling 3.1 Flash tier has been
  retired`. It is `hidden: true` in the catalog and absent from the plain
  roster — a hidden row that still resolves.
- `thinkingmachines/inkling*`, `zai-org/GLM-5.1`, `MiniMaxAI/MiniMax-M2.7` →
  `This model is temporarily unavailable` (transient; nothing to fix).

These are gateway-side reality. The extension cannot prevent them, but it can
report them as a model-level failure instead of a generic stream error, and it
can stop hiding `hidden` rows from its own filter logic (`hidden` means "not in
the picker", not "does not exist").

### 3.3 Per-model output-token floor

`gpt-6-luna` / `gpt-5.6-luna` return 200 then stream
`Invalid 'max_output_tokens': integer below minimum value. Expected a value >=
16, but got 8`. `max_tokens: 16` and `64` succeed. The extension's default is
`options?.maxTokens ?? model.maxTokens ?? 8192`, which is safe — but the
per-request floor varies by model and is not in the catalog, so a tiny
`maxTokens` request (subagent/title roles) can fail on some models only.

### 3.4 `CMD_ZDR=1` excludes non-ZDR models (422)

`meta/muse-spark-1.3-contributor` has `zdr: false` in the catalog (its cheapness
comes from Meta using the data for training) and answers
`422 CMD_ZDR_NO_PROVIDERS … has no zero-data-retention upstream`. With ZDR off
it returns 200 through the extension. This is working as intended and matches
the README; the only gap is that the failure mode is a 422 the extension reports
as a bare HTTP error.

### 3.5 The "Go subscription does not permit API access" 403

Not reproducible on this account through `/alpha/generate` — every probe of
`meta/muse-spark-1.3-contributor` (and every other model) returns 200 or a
`MODEL_NOT_IN_PLAN` 403, never the API-access message. That exact wording is
emitted **only** by the Pro-gated compat endpoints; measured live:

```
POST /provider/v1/chat/completions
403 {"error":{"message":"Your Go plan doesn't include API access. Upgrade to
Provider or higher at https://commandcode.ai/billing to use these endpoints.",
"type":"permission_error","code":"upgrade_required"}}
```

and `/provider/v1/messages` for that same model returns
`Model "meta/muse-spark-1.3-contributor" is not supported on this endpoint.`

Two candidate explanations, both consistent with the evidence `[INFERENCE]`:

1. The request went out over a `/provider/v1/*` path rather than
   `/alpha/generate` — a second `models.yml` provider pointing at
   `https://api.commandcode.ai/provider/v1`, or a compat-mode client. Worth
   checking `models.yml` before anything else; the extension is not the only
   thing that can address this gateway.
2. It predates the current subscription row
   (`currentPeriodStart: 2026-10-30T19:51:08Z`); a request made before that had
   no plan, and no plan fails closed on some paths.

Either way, header fingerprinting is not implicated: dropping `User-Agent`,
`x-session-id`, and `x-cli-environment` from the request each still returned 200
for this model. If it recurs, capture the failing request's URL and headers
before retrying.

### 3.6 Consequence for the extension

The `smol` role is configured as `commandcode/inclusionai/ling-3.1-flash-1019:free`,
which now returns `429 RATE_LIMITED — You've used all 100 free Ling 3.1 Flash
1019 requests for today`. The paid id `inclusionai/ling-3.1-flash` answers 200.
The `task`/`tiny`/`commit` roles point at `poolside/laguna-s-2.1-free`, which is
dead (§3.2). Both are user configuration, not extension bugs — but both were
only discoverable by hand, which is what Phase 4 fixes.

## 4. Plan

Each phase is independently shippable. "Delete" items are code that exists only
to serve a path this plan removes.

### Phase 1 — Cost from catalog rates, nothing else

1. Set each model's `cost` (`input`, `output`, `cacheRead`, `cacheWrite`) from
   the catalog `pricing` fields (`inputCost`, `outputCost`, `cacheReadCost`,
   `cacheWriteCost`, `cacheWrite1hCost`; USD per 1M tokens, pi's convention).
2. Compute `usage.cost` locally in `stream.ts`; **delete**
   `updateGatewayCost` and every `providerMetadata.gateway` /
   `inferenceCost` reference, including the `finish`/`provider-metadata`
   override path. Do not add a fallback that reads those fields.
3. Honour `pricing.contextTiers` when present (none in today's catalog; the
   schema allows an ordered tier list keyed by `maxContext`).

   Validated live for `deepseek/deepseek-v4-flash` (`inputCost 0.15`,
   `outputCost 0.6`, `cacheReadCost 0.003`): a cold 762-in/1-out call prices at
   $1.149e-4; the same call with 512 cache-read tokens at $3.964e-5.
4. Read `usage.cacheWrite` from `finish.totalUsage.inputTokenDetails.cacheWriteTokens`
   instead of hardcoding 0, plus the two 1.88.2 events: `provider-metadata` →
   `providerMetadata.anthropic.usage.cache_creation.ephemeral_1h_input_tokens`;
   `cache-write-tokens` → top-level `cacheWriteTokens`, applied only when
   `finish` reported 0.
5. Tests: rate math for cold / cache-read / 1h-cache-write turns; tier
   selection; `cache-write-tokens` precedence.

Verification: one live turn meters non-zero, within ~1% of the
`/alpha/usage/summary` delta for the same model.

### Phase 2 — One capability source: the gateway catalog

**Delete models.dev entirely** — `MODELS_DEV_URL`, `fetchModelDevCaps`,
`ModelDevEntry`, the `dev ? … : …` fallbacks in `mapDiscoveredModel`, and every
comment describing the join. Replace `fetchLiveModelRows` with a catalog fetch.

1. Fetch `GET /provider/v1/models?view=client`; parse
   `{schemaVersion, catalogVersion, refreshAfterSeconds, roles, data[]}`. Reject
   `schemaVersion !== 1` and register zero models rather than guessing —
   the same fail-closed rule the extension already uses for roster failure, and
   the same rule `parseModelCatalog` applies.
2. Map each row 1:1, no cross-source merging:
   `context_length` → `contextWindow`; `maxOutputTokens` → `maxTokens` (fall
   back to a fixed default when `null` — 96 of 107 rows are `null`);
   `inputModalities.includes("image")` → `input`; `reasoningEfforts.length > 0`
   → `reasoning`; `pricing` → `cost` (Phase 1); `aliases` → id resolution;
   `zdr`/`category`/`minimumPlan`/`hidden`/`behaviorProfile` → kept in a typed
   model record (§3.1, Phase 3).
3. Conditional GET with `if-none-match: "<catalogVersion>"` and respect
   `refreshAfterSeconds` (900 today); honour `CMD_DISABLE_REMOTE_MODEL_CATALOG`
   as the CLI does. `omp models refresh` must still force a fetch. The harness
   already caches the discovered catalog, so no second cache.
4. Drop the id-prefix heuristics (`PROPRIETARY_PREFIXES`) in favour of
   `minimumPlan` filtering (§3.1): a prefix list is a guess that misses
   `meta/muse-spark-1.3` and would wrongly hide a premium model if its id
   changed. `excludedModels` stays — it is user intent, not a capability guess.

Deleting models.dev removes an entire network dependency, a whole fallback
ladder, and the two live disagreements it currently causes (13 reasoning flags,
4 context windows). Nothing in the catalog requires a second opinion: for the
72 ids both sources know, **vision flags agree 100%** and pricing agrees 100%
(per-token rates are identical across all 72).

### Phase 3 — Plan-aware model registration (§3.1)

1. Fetch `/alpha/billing/subscriptions` and `/alpha/billing/credits` once per
   discovery run, alongside the catalog.
2. Port `evaluateModelAccess` faithfully: credits bypass, missing plan allows,
   category access, `minimumPlan` rank order, and the `individual-go` family
   limited to `opensource`.
3. Drop models the account cannot use, instead of registering them to fail.
   This is a behaviour change: `/model` will show only usable models. Keep the
   drop silent per model but log one summary line (count by `minimumPlan`).
4. Fail open when billing cannot be fetched (`fetchFailed` in the CLI's shape):
   register everything and let the gateway reject, so an outage does not empty
   the picker. This mirrors `as = {allowed: true}` in 1.88.2.
5. Tests: the rank order, the credits bypass, category-only fallbacks, and the
   fail-open path.

### Phase 4 — Surface per-model failure reasons

§3.2 and §3.3 are gateway reality; the extension should not make them look like
unknown breakage.

1. Parse the stream `error` event's real shape
   (`{type, message, statusCode, isRetryable}`) and distinguish it from a
   truncated stream ("no terminal event").
2. Keep HTTP bodies verbatim: `MODEL_NOT_IN_PLAN`, `RATE_LIMITED`,
   `CMD_ZDR_NO_PROVIDERS`, and the `Model '…' not found` stream error each
   mean a different user action. A one-line mapping table in
   `docs/troubleshooting.md` (status/code → cause → action) — the four causes in
   §3 are the section.
3. Honour `hidden`: hidden rows stay out of discovery, but keep the catalog
   record so a user-supplied id still resolves with real capabilities.
4. Document that a model absent from the roster but present in the catalog, or
   dead in both, is a gateway-side condition (`poolside/laguna-s-2.1-free` is in
   the plain roster today and dead), and recommend `omp models refresh`.

### Phase 5 — Per-model quirks (`behaviorProfile`)

| profile                            | deferred tools | interleaved thinking | binds thinking to prefix | forced tool choice |
| ---------------------------------- | -------------- | -------------------- | ------------------------ | ------------------ |
| `standard-v1`                      | yes            | no                   | no                       | yes                |
| `no-deferred-tools-v1`             | no             | no                   | no                       | yes                |
| `private-reasoning-v1`             | no             | yes                  | no                       | yes                |
| `anthropic-interleaved-v1`         | yes            | yes                  | no                       | yes                |
| `anthropic-prefix-bound-v1`        | yes            | yes                  | yes                      | no                 |
| `anthropic-prefix-bound-forced-v1` | yes            | yes                  | yes                      | yes                |

1. Store the profile per model; an **unknown** profile is the CLI's own "this
   client is too old" signal (`clientUpdateReason` → `client-update-required`) —
   surface it in the status line rather than ignoring it.
2. _interleaved thinking_: reasoning may arrive between text/tool blocks.
   `BlockStreams` keys by id, so this is likely already correct — add a test with
   an interleaved stream rather than new code.
3. _binds thinking to prefix_: `[INFERENCE]` prior reasoning must be replayed on
   assistant history or the prefix stops matching. This is the one divergence
   worth revisiting, and it trades input tokens against cache hits — measure
   before changing.
4. _deferred tools_ / _forced tool choice_: no wire fields exist for either
   (`tool_choice` has zero occurrences in both bundles). Document the divergence;
   send nothing.

### Phase 6 — Reasoning effort

1. Map `SimpleStreamOptions.reasoning` (`minimal|low|medium|high|xhigh|max` →
   wire) and **clamp to the model's catalog `reasoningEfforts`**, picking the
   nearest supported value. Never send an unlisted value: the gateway accepts it
   and silently disables reasoning (measured).
2. `disableReasoning: true` → `"off"` when listed, else omit. Models with
   `reasoning: false` → omit.
3. Smoke-test per family that the chosen effort actually yields reasoning
   tokens — the mapping is server-side and silent when wrong.

### Phase 7 — Vision correctness

1. Add `mimeType` to image parts; the gateway accepts both spellings, 1.88.2
   sends it.
2. Implement `stripImages` for text-only models, driven by catalog
   `inputModalities`: keep the newest image-bearing user message's images as
   `<attached_image index="N">…` text, drop images from older user messages, use
   `[image omitted: the active model is text-only]` when a message would empty.
   Today this silently degrades — a red PNG to text-only
   `deepseek/deepseek-v4-flash` answered "no image was provided".
3. Tool-result images as `output:{type:"content",value:[{type:"text"},
   {type:"media",data,mediaType}]}` (accepted live) where the harness surfaces
   them.

### Phase 8 — Docs and pin

1. Rewrite the two misleading `docs/wire-protocol.md` sections (cost, "every
   field required") and append the §1 audit with method and date.
2. Correct the README's cache-affinity claim (§2) and the `CMD_ZDR` guidance
   with the `meta/muse-spark-1.3-contributor` example.
3. Bump `COMMAND_CODE_VERSION` to `1.88.2` last; the status-line notice clears
   itself.

## 5. Deliberate non-goals

- **No `mode` / `promptCache` on the wire.** `mode` is a CLI request class
  (`tool-desc`, `compact`, `custom-agent`, …); `promptCache` currently validates
  only as `"off"`. Neither buys anything for a chat turn; `mode` omission is
  verified 200.
- **No reasoning round-trip by default.** Replaying prior reasoning inflates
  every request's input. Revisit only if Phase 5's measurement shows a cache
  regression on `bindsThinkingToPrefix` models.
- **No retries.** The harness owns retry/fallback.
- **No client-side model probing.** The extension will not call each model to
  discover `max_tokens` floors (§3.3); it clamps to a safe default instead.

## 6. Verification gates

Per phase: `bun run check`, `bun run lint`, `bun test`, then a live smoke through
the extension's own `streamSimple` (not a hand-built body) against a cheap model.
For anything touching request bytes, a second call on a warm prefix must still
show a cache hit. For Phase 3, replay the §3 enumeration: every model the
extension now registers must answer 200, and the 14 plan-gated ids must be
absent.
