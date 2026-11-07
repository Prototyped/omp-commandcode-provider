# AGENTS.md

Agent instructions for working on this repository.

## Project overview

An extension for the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent that adds [Command Code](https://commandcode.ai) as a model provider by speaking the undocumented `/alpha/generate` endpoint that Command Code's own CLI uses.

- The extension is a small module set, all loaded through `index.ts` (the entry point omp loads):
  - `index.ts` — entry point: provider registration, `/login` flow, plan-gated `fetchDynamicModels`, staleness status line, re-exports for tests.
  - `constants.ts` — gateway endpoints and the `COMMAND_CODE_VERSION` pin.
  - `messages.ts` — harness `Message[]` → gateway ModelMessage conversion (including assistant `reasoning` parts).
  - `session.ts` — per-conversation session/thread identity (deterministic UUID fallback).
  - `catalog.ts` — strict parser for the gateway's CLI catalog (`GET /provider/v1/models?view=client`).
  - `discovery.ts` — catalog discovery: parse (fail-closed) → plan gate → exclusions.
  - `plan.ts` — billing fetch (`/alpha/billing/subscriptions` + `/alpha/billing/credits`) and the plan gate (`evaluateModelAccess`, a port of the CLI's).
  - `exclusions.ts` — `models.yml` `excludedModels`.
  - `stream.ts` — the `/alpha/generate` request envelope, NDJSON reader, block-stream handlers (`BlockStreams`), and the event dispatcher.
  - `update.ts` — `COMMAND_CODE_VERSION` staleness check (npm newest-stable, the CLI's own updater source) and the status-line text.
- `docs/wire-protocol.md` — the authoritative field-by-field contract for the endpoint. **Keep it in lockstep with `stream.ts`/`messages.ts`**; when one changes, so does the other. It documents the **wire** only: what the pinned CLI puts on the wire (requests, responses, NDJSON events, the catalog document shape) and how the gateway answers. CLI-local behavior (catalog caching, picker/runner decisions, npm update checks) and the extension's implementation are out of scope. The extension appears only as marked `Divergence (extension):` notes where it sends a different payload than the CLI — never as description of its own code.
- `docs/caching.md`, `docs/troubleshooting.md` — measured caching behavior and the error-mode guide.
- The upstream schema is undocumented and changes without notice. `COMMAND_CODE_VERSION` in `constants.ts` pins the CLI release whose wire protocol this implementation matches (currently `1.88.5`) — it is not a dependency version, it is a protocol-version marker.

## Toolchain

Bun only — the harness runs on bun and `bun.lock` is the lockfile. Do not introduce npm or `package-lock.json`.

```bash
bun install       # install deps (bun.lock)
bun run check     # typecheck (tsrs --noEmit)
bun run lint      # biome check
bun test          # unit tests (bun:test, mocked fetch)
bun run wire-diff # compare the pinned CLI release with npm latest (scripts/wire-diff.ts)
bun run live-smoke # live gateway checks; needs CC_KEY (see below)
```

Bundles fetched by `wire-diff` are cached under `.cache/command-code/<version>/` (gitignored).

No build step: omp loads `index.ts` directly; its local relative imports resolve through bun (the loader tags the whole extension module graph with a cache-buster).

## Testing conventions

- Tests live in `test/provider.test.mjs` (bun:test). Outbound HTTP is mocked by swapping `globalThis.fetch`; NDJSON responses are built with the `ndjsonResponse` helper.
- Before implementing a change, build the minimal test matrix from the existing suite (don't duplicate covered cases; extend existing tests over near-identical new ones). Make new tests fail first, then implement.
- Tests must exercise observable behavior (stream events, usage/cost math, discovery mapping, converted message shapes) — not stub echoes or source text.
- Tooling tests live in `test/wire-diff.test.mjs`: the bundle tokenizer (strings, templates, regex-vs-division, comments, identifier normalization) and the token diff/hunk grouping.
- When the wire protocol changes, verify against the **live gateway** (key: `omp token commandcode-alpha` — use it as a bash substitution, never print it; or run the harness directly: `omp --model commandcode-alpha/<model> -p "…"` — the extension is installed as a linked plugin (`omp install .`); add `-e .` only when developing without installing). Set the thinking level with `--thinking <level>`, not a `:level` suffix on `--model` (the CLI suffix form does not resolve for this provider in omp 18.14.1; the config `modelRoles` parser is a different code path — do not assume the two parse identically). Model ids containing a colon (e.g. `reflection/beam:free`) cannot be referenced via `--model` at all — select them with `/model` in the TUI. A live smoke test is part of "done" for any protocol change, not just the unit suite.

## Keeping the extension in step with the CLI

`COMMAND_CODE_VERSION` pins the CLI release whose wire protocol this implementation matches. When a new `command-code` release lands (or a live 400/drift appears), determine whether the wire changed, apply changes if it did, and always bump the pin.

### 1. Diff the bundles

```bash
bun run wire-diff                       # pinned version -> npm latest
bun run wire-diff --old 1.88.3 --new 1.88.7
bun run wire-diff --new <version> --max-hunks 40
```

`scripts/wire-diff.ts` downloads both tarballs (registry, cached), prints each release's CHANGELOG, then compares the two `dist/cli.mjs` bundles:

- **Wire constant sets** — endpoint paths, `x-*` headers, NDJSON event types, behavior profiles, effort vocabulary, catalog `schemaVersion`, plan ids, message part types, envelope keys, `config` fields, usage fields, `providerMetadata` keys.
- **Anchored functions** — `parseModel` and `evaluateModelAccess`, byte-compared.
- **Call-site object keys** — the `/alpha/generate` body, the catalog document, and the reasoning-effort handling.
- **Semantic diff** — tokenizes both bundles with `scripts/lib/tokenize.ts` and normalizes every identifier to `#` while preserving literals, so minifier renames vanish; it then prints the remaining hunks (`scripts/lib/diff.ts`).

Exit codes: `0` no wire-relevant changes, `1` wire-relevant changes (or wire-suspect hunks), `2` tool error. Hunks are tagged `WIRE-SUSPECT` when they contain known wire strings. Treat the verdict as a filter, not an oracle: identifier normalization hides renamed object keys outside the call-site checks, and a brand-new wire field has no category until it is added to `WIRE_CATEGORIES`. A changelog that mentions protocol work, or any live 400, means the validation map below decides.

### 2. If the wire changed

Update the affected modules using the validation map, keep `docs/wire-protocol.md` in lockstep (envelope, event table, usage/metadata), update `docs/troubleshooting.md` (required-fields list), and extend `test/provider.test.mjs` for the changed behavior. Then run `live-smoke` plus the manual checks below.

### 3. Bump the pin (always)

- `COMMAND_CODE_VERSION` in `constants.ts`.
- Every version citation: `rg -n '<old-version>'` across `README.md`, `docs/*.md`, `AGENTS.md`, and source docstrings. Version claims describe the protocol this code implements; keep them current.
- Dated observations (`catalogVersion`, row counts, hidden-row counts, "as of <date>") change only to values actually observed on that date.

### Getting a bundle by hand

The cache has the extracted bundle; for a version not yet fetched:

```bash
npm i -g command-code          # or: npm pack command-code && tar -xzf command-code-*.tgz
F=$(npm root -g)/command-code/dist/cli.mjs
```

Searches below are `rg` runs in `"$F"` (minified single file; use wide `-{80,400}` context windows).

### Validation map — extension area → where to check in the CLI

| Extension area (module)                                                                                     | Check in the CLI bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream.ts` — Request envelope: body keys, `config` fields (`staticConfig`)                                 | Body construction: search `config:` next to `memory:` + `taste:` + `permissionMode` + `params:`. `config` value shape: `function getEnvironmentContext()` (workingDir, date, environment, structure, isGitRepo, branches, gitStatus, recentCommits). New required fields surface as `400 … expected X, received undefined at "config.…"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `session.ts` — `threadId` / `x-session-id`                                                                  | `addGenerateSessionHeader` (reads `body.threadId`, falls back to a generated id) and `Tt.SESSION_ID` (`"x-session-id"`). Session ids are `crypto.randomUUID()` created per session (SessionManager constructor: `this.sessionId=e                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |     | crypto.randomUUID()`) — the gateway validates `threadId` as a strict RFC 4122 UUID |
| `stream.ts` — Request headers (User-Agent, `x-cli-environment`, `x-command-code-version`, `x-cmd-zdr`)      | Header construction next to `User-Agent":xt` (find `xt="cli"`), `Tt.CLI_ENVIRONMENT`, `Tt.CLI_VERSION`, `Tt.CMD_ZDR`. The version header is the npm package version (`getPackageJson().version`) and `/alpha/generate` enforces a **floor** on it: below `minVersion` (0.18.10 as of 2026-10-31) → 403 `upgrade_required` with `error.minVersion`; above is accepted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `messages.ts` — Message conversion (`convertMessages`)                                                      | ModelMessage shaping: search `type:"tool-call"`, `type:"tool-result"`, `type:"reasoning"` in the stream consumer (`consumeSSEStream`) — internal history uses exactly these part types. The assistant `thinking` block maps to a `reasoning` part (`if("thinking"===e.type&&e.thinking)`) — the extension does the same (the CLI sends the parts on every turn); some models (e.g. `reflection/beam:free`) 400 with `Missing required parameter: 'messages[N].reasoning_content'` when an earlier turn's reasoning is not sent back — most reasoning models preserve it server-side. Image handling in tool results: the converter that pushes `{type:"image"}` blocks into a following user message                                                                                                                    …                                                     |
| `stream.ts` — NDJSON event vocabulary (the `switch` in `streamCommandCode`)                                 | Event emission: search `"type":"` in the generate response consumer (`consumeSSEStream` and the alpha-path stream reader). New event types are additive — unknown types are ignored, which is the intended drift-tolerance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `stream.ts` — Usage/cost mapping (`finish-step`/`finish`/`cache-write-tokens`/`provider-metadata` handling) | Usage fields in `finish-step` / `finish` events (`inputTokens` is the total including cached; `inputTokenDetails.cacheReadTokens`/`cacheWriteTokens`, top-level `cachedInputTokens`, `raw.prompt_cache_hit_tokens`). `providerMetadata` keys are routing-dependent (`gateway.*` on Vercel AI Gateway routing, direct-upstream keys like `novita` otherwise); the extension only reads the Anthropic 1h cache-write split (`anthropic.usage.cache_creation.ephemeral_1h_input_tokens`). The gateway reports no per-request USD — cost is computed locally from the catalog `pricing` rates (the CLI does the same, `estimateCatalogCostUsd`)                                                                                                                                                                                                                                 … |
| `constants.ts` (plus `index.ts` whoami, `discovery.ts` roster) — Endpoint set                               | `At.ALPHA` / `At.INTERNAL` endpoint tables (search `endpoint table` shapes like `GENERATE:V1:`). `/alpha/whoami` for the login validation, `/provider/v1/models?view=client` for the model catalog (public; the no-query variant answers a minimal OpenAI-style list), `/alpha/billing/credits` + `/alpha/billing/subscriptions` for plan checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `discovery.ts` — Model capability data (reasoning/vision, output caps)                                      | The CLI's catalog parser `parseModel` (1.88.5 bundle): `id`, `name`, `display` (label), `aliases`, `hidden`, `context_length`, `maxOutputTokens`, `inputModalities`, `reasoningEfforts`, `behaviorProfile`, `zdr`, `category`, `minimumPlan`, `pricing` — a malformed row is dropped, an unsupported `schemaVersion` rejects the whole document. Capabilities come from the same `?view=client` catalog the extension reads (`catalog.ts` mirrors this validation)                                                                                                                                                                                                                                                                                                                                                                                                            |
| `update.ts` — Staleness notice for `COMMAND_CODE_VERSION`                                                   | The CLI's updater: `fetchVersions` (`rI` = `npm view ${nI} versions --json`), `isPrereleaseVersion`, `getLatestVersion` (`r.max(e => r.rcompare)`)→`determineUpdateTarget`, and `shouldSkipUpdateSystem` (`CI`, `COMMANDCODE_SKIP_UPDATES`). Also `clientUpdateReason` + the `Fn` behavior-profile map (`standard-v1`, `no-deferred-tools-v1`, `private-reasoning-v1`, `anthropic-interleaved-v1`, `anthropic-prefix-bound-v1`, `anthropic-prefix-bound-forced-v1`): an unknown profile is the CLI's own "this client is too old" verdict. Router-side there is no version endpoint (`GET /versions` → 404) and `?view=client` returns the same catalog for any `x-command-code-version`                                                                                                                                                                                      |
| `index.ts` — Login flow (`oauth.login`)                                                                     | The API-key login component: browser OAuth that saves a key to `~/.commandcode/auth.json` with a manual paste fallback (`manual_entry`). Validation is `GET /alpha/whoami`: only 401 rejects; 403/unreachable keeps the key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Plan gating knowledge                                                                                       | `GET /alpha/billing/subscriptions` → `data.planId` (e.g. `individual-go-v1`); `/alpha/billing/credits` → `credits.{purchasedCredits,freeCredits}`. The gate is the CLI's `evaluateModelAccess` ported to `plan.ts`: credits bypass everything; absent/unknown plan or unknown category (`knownCategory` — only `premium`/`opensource`) fails open; absent `minimumPlan` → category gate (go/goat get `opensource` only, `premium` from pro); explicit `null` `minimumPlan` → top-tier-only; known `minimumPlan` → rank compare over `individual-go → … → individual-ultra`, falling back to the category gate on unknown plan ids. `/provider/v1/*` **generation** endpoints are gated above the Go plan, `/provider/v1/models` is public                                                                                                                                     |

### Live verification

```bash
CC_KEY=$(omp token commandcode-alpha) bun run live-smoke
```

`scripts/live-smoke.ts` runs against the live gateway through the extension's own `streamSimple`: whoami 200, catalog fetch and parse, conditional GET → 304, a minimal generate turn whose outgoing `x-command-code-version` must equal the pin, a terminal `done` with a stop reason, and reported usage. It exits non-zero on any failure.

Two checks stay manual, required on any wire-change release:

1. A tool-call turn: expect `tool-input-*` events and stopReason `toolUse`.
2. A vision turn: assistant `tool-call` → tool result containing an image → the model must describe the image (verifies the image-as-user-message conversion end-to-end on a vision model, e.g. `moonshotai/Kimi-K3`).

### 4. Finish

Run the full gate (`bun run check`, `bun run lint`, `bun test`) and `live-smoke`. A release with no wire changes needs only the pin bump, the citation refresh, and the automated smoke.

## Design guardrails (decisions not to relitigate)

- **No retries in the extension.** The harness owns retry/fallback for inference.
- **Error policy: wire errors are fatal, config errors are lenient.** A truncated or malformed stream throws (never emit a partial terminal result). Catalog parsing is fail-closed, mirroring the CLI's `parseModel`: a structurally invalid document (unsupported `schemaVersion`, missing metadata, malformed JSON) throws as a discovery failure, while per-row validation drops only the bad rows. Config-side inputs degrade leniently instead: an unreadable or malformed `models.yml` yields no exclusions, and a billing failure fails open (all models kept). Don't flip either side without a live-gateway reason.
- **No static model fallback and no hardcoded model maps.** The catalog is fetched live at startup; a discovery failure (network error, non-200, unsupported `schemaVersion`, malformed document) is thrown so the harness keeps its cached catalog from the last successful discovery — a first startup with nothing cached then yields no models, by design. The harness caches the discovered catalog (`omp models refresh` forces a refetch), so no local catalog cache.
- **Models above the account's plan are dropped at discovery**, mirroring the CLI's `evaluateModelAccess` (credits bypass, category gate, rank compare; fail open on billing failure), plus `models.yml` `excludedModels`. Premium-category models therefore only appear on Pro and above — there is no id-prefix filtering.
- **Costs are computed locally**: the catalog's `pricing` rates (USD per 1M tokens) applied to the turn's disjoint usage buckets in `stream.ts`. The gateway reports no per-request USD on `/alpha/generate`; the metered number is an upstream market estimate, not the plan's credit debits.
- **Assistant reasoning is always echoed back** as `reasoning` parts, matching the CLI: some models (e.g. `reflection/beam:free`) 400 without it, most preserve it server-side, and the CLI sends it regardless.
- **`authHeader: true` stays**: it documents that the wire protocol authenticates via bearer token, and the extension sets its own `Authorization` header in `streamSimple`.

## Style

- Search with `rg`. No comments except where the code's form doesn't explain a non-obvious behavior (wire-protocol quirks, divergences from the CLI, gateway validation rules).
- Comments that quote the CLI or a live observation should say _where_ the fact came from (bundle function name, endpoint, date).
- Documentation, docstrings, and comments describe the repository's **current** state — never the shape it had before, what a change replaced, or what was checked and found absent. No "used to", "previously", "old symptom (fixed)", check-logs ("X was verified not to exist"), or references to symbols, fields, and files that no longer exist. If a sentence is only meaningful as a history of the code, delete it.
- Don't comment on what the code is _not_ doing when that not-doing was its previous behavior; state what it does. Drop comments with no bearing on the current code, however true they once were.
