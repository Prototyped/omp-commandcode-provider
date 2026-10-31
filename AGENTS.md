# AGENTS.md

Agent instructions for working on this repository.

## Project overview

An extension for the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent that adds [Command Code](https://commandcode.ai) as a model provider by speaking the undocumented `/alpha/generate` endpoint that Command Code's own CLI uses.

- The extension is a small module set, all loaded through `index.ts` (the entry point omp loads):
  - `index.ts` — entry point: provider registration, `/login` flow, re-exports for tests.
  - `constants.ts` — gateway endpoints and the `COMMAND_CODE_VERSION` pin.
  - `messages.ts` — harness `Message[]` → gateway ModelMessage conversion.
  - `session.ts` — per-conversation session/thread identity (deterministic UUID fallback).
  - `discovery.ts` — live roster + models.dev capabilities, exclusions, `discoverModels`.
  - `stream.ts` — the `/alpha/generate` request envelope, NDJSON reader, block-stream handlers (`BlockStreams`), and the event dispatcher.
- `docs/wire-protocol.md` — the authoritative field-by-field contract for the endpoint. **Keep it in lockstep with `stream.ts`/`messages.ts`**; when one changes, so does the other.
- `docs/caching.md`, `docs/troubleshooting.md` — measured caching behavior and the error-mode guide.
- The upstream schema is undocumented and changes without notice. `COMMAND_CODE_VERSION` in `constants.ts` pins the CLI release whose wire protocol this implementation matches (currently `0.52.1`) — it is not a dependency version, it is a protocol-version marker.

## Toolchain

Bun only — the harness runs on bun and `bun.lock` is the lockfile. Do not introduce npm or `package-lock.json`.

```bash
bun install       # install deps (bun.lock)
bun run check     # typecheck (tsrs --noEmit)
bun run lint      # biome check
bun test          # unit tests (bun:test, mocked fetch)
```

No build step: omp loads `index.ts` directly; its local relative imports resolve through bun (the loader tags the whole extension module graph with a cache-buster).

## Testing conventions

- Tests live in `test/provider.test.mjs` (bun:test). Outbound HTTP is mocked by swapping `globalThis.fetch`; NDJSON responses are built with the `ndjsonResponse` helper.
- Before implementing a change, build the minimal test matrix from the existing suite (don't duplicate covered cases; extend existing tests over near-identical new ones). Make new tests fail first, then implement.
- Tests must exercise observable behavior (stream events, usage/cost math, discovery mapping, converted message shapes) — not stub echoes or source text.
- When the wire protocol changes, verify against the **live gateway** with a real key (ask the user; the key is provided out-of-band — never print it, pass it via env/file in bash). A live smoke test is part of "done" for any protocol change, not just the unit suite.

## Updating to a new Command Code CLI revision

When a new `command-code` CLI release lands (or an undocumented 400/drift appears), re-derive the protocol from the new bundle and update the extension. The pin `COMMAND_CODE_VERSION` is bumped to the new CLI version **as part of this work** — it marks the protocol this code implements.

### Getting the bundle

```bash
npm i -g command-code          # or: npm pack command-code && tar -xzf command-code-*.tgz
F=$(npm root -g)/command-code/dist/cli.mjs
```

Everything below is a `rg` search in `"$F"` (minified single file; use wide `-{80,400}` context windows).

### Validation map — extension area → where to check in the CLI

| Extension area (module)                                                                                | Check in the CLI bundle                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stream.ts` — Request envelope: body keys, `config` fields (`staticConfig`)                            | Body construction: search `config:` next to `memory:` + `taste:` + `permissionMode` + `params:`. `config` value shape: `function getEnvironmentContext()` (workingDir, date, environment, structure, isGitRepo, branches, gitStatus, recentCommits). New required fields surface as `400 … expected X, received undefined at "config.…"`                                                                                                                                                    |
| `session.ts` — `threadId` / `x-session-id`                                                             | `addGenerateSessionHeader` (reads `body.threadId`, falls back to a generated id) and `Tt.SESSION_ID` (`"x-session-id"`). Session ids are `crypto.randomUUID()` created per session (SessionManager constructor: `this.sessionId=e                                                                                                                                                                                                                                                           |     | crypto.randomUUID()`) — the gateway validates `threadId` as a strict RFC 4122 UUID |
| `stream.ts` — Request headers (User-Agent, `x-cli-environment`, `x-command-code-version`, `x-cmd-zdr`) | Header construction next to `User-Agent":xt` (find `xt="cli"`), `Tt.CLI_ENVIRONMENT`, `Tt.CLI_VERSION`, `Tt.CMD_ZDR`                                                                                                                                                                                                                                                                                                                                                                        |
| `messages.ts` — Message conversion (`convertMessages`)                                                 | ModelMessage shaping: search `type:"tool-call"`, `type:"tool-result"`, `type:"reasoning"` in the stream consumer (`consumeSSEStream`) — internal history uses exactly these part types. Image handling in tool results: the Anthropic-block converter that pushes `{type:"image"}` blocks into a following user message. Note: the CLI round-trips prior reasoning as `reasoning` parts; this extension deliberately omits them (token cost) — a divergence documented in `convertMessages` |
| `stream.ts` — NDJSON event vocabulary (the `switch` in `streamCommandCode`)                            | Event emission: search `"type":"` in the generate response consumer (`consumeSSEStream` and the alpha-path stream reader). New event types are additive — unknown types are ignored, which is the intended drift-tolerance                                                                                                                                                                                                                                                                  |
| `stream.ts` — Usage/cost mapping (`finish-step`/`finish`/`provider-metadata` handling)                 | Usage fields in `finish-step` events; `providerMetadata` keys are routing-dependent (`gateway.cost` on Vercel AI Gateway routing, direct-upstream keys like `novita` otherwise)                                                                                                                                                                                                                                                                                                             |
| `constants.ts` (plus `index.ts` whoami, `discovery.ts` roster) — Endpoint set                          | `At.ALPHA` / `At.INTERNAL` endpoint tables (search `endpoint table` shapes like `GENERATE:V1:`). `/alpha/whoami` for the login validation, `/provider/v1/models` for the roster (public), `/alpha/billing/credits` + `/alpha/billing/subscriptions` for plan checks                                                                                                                                                                                                                         |
| `discovery.ts` — Model capability data (reasoning/vision, output caps)                                 | The CLI's hardcoded `Kt` model registry (per-model `reasoning`, `inputModalities`, `contextWindow`) — for reference only. This extension does **not** mirror it; capabilities come live from the models.dev `commandcode` catalog. Compare new `Kt` entries against models.dev to spot what the catalog is missing                                                                                                                                                                          |
| `index.ts` — Login flow (`oauth.login`)                                                                | The API-key login component: browser OAuth that saves a key to `~/.commandcode/auth.json` with a manual paste fallback (`manual_entry`). Validation is `GET /alpha/whoami`: only 401 rejects; 403/unreachable keeps the key                                                                                                                                                                                                                                                                 |
| Plan gating knowledge                                                                                  | `GET /alpha/billing/subscriptions` → `data.planId` (e.g. `individual-go-v1`); `/provider/v1/*` **generation** endpoints are gated above the Go plan, `/provider/v1/models` is public                                                                                                                                                                                                                                                                                                        |

### Live smoke sequence (real key, small `max_tokens`)

1. `GET /alpha/whoami` → 200 (key good).
2. `GET /provider/v1/models` (with and without auth — should be identical) → count rows, diff ids against the previous run.
3. `POST /alpha/generate` minimal text turn (the extension's own `streamSimple`, not a hand-built body — the probe script pattern from the test suite) → expect `start … finish-step finish provider-metadata`, `done`, correct usage.
4. A turn with a tool call + tool result (verify `tool-input-*` events and stopReason `toolUse`).
5. A vision turn: assistant `tool-call` → tool result containing an image block → the model must describe the image (verifies the image-as-user-message conversion end-to-end on a vision model, e.g. `moonshotai/Kimi-K3`).

### After the protocol diff

1. Update the affected modules (`stream.ts`, `messages.ts`, `session.ts`, `discovery.ts`; `COMMAND_CODE_VERSION` in `constants.ts`).
2. Update `docs/wire-protocol.md` (envelope, event table, usage/metadata), `docs/troubleshooting.md` (the required-fields list under 400), and README sections that quote the envelope.
3. Extend `test/provider.test.mjs` for changed behavior; run the full gate (`check`, `lint`, `test`) plus the live smoke sequence.

## Design guardrails (decisions not to relitigate)

- **No retries in the extension.** The harness owns retry/fallback for inference.
- **Error policy: wire errors are fatal, config errors are lenient.** A truncated or malformed stream throws (never emit a partial terminal result), and an unrecognized roster shape registers zero models. Config-side inputs degrade leniently instead: an unreadable or malformed `models.yml` yields no exclusions, and a models.dev entry that's missing yields the defaults (assumed reasoning, text-only, 128K context). Don't flip either side without a live-gateway reason.
- **No static model fallback and no hardcoded model maps.** Roster and capabilities are fetched live at startup; discovery failure means no models, by design. The harness caches the discovered catalog (`omp models refresh` forces a refetch), so no local cache of models.dev.
- **Model ids with the `claude-`, `gpt-`, `google/gemini-` prefixes are filtered** (proprietary frontier models, `PROPRIETARY_PREFIXES`) plus `models.yml` `excludedModels`.
- **Costs**: per-model rates are $0 (plan multipliers don't map to token pricing); the session meter reads `providerMetadata.gateway.cost` when the routing provides it.
- **`authHeader: true` stays**: it documents that the wire protocol authenticates via bearer token, and the extension sets its own `Authorization` header in `streamSimple`.

## Style

- Search with `rg`. No comments except where the code's form doesn't explain a non-obvious behavior (wire-protocol quirks, divergences from the CLI, gateway validation rules).
- Comments that quote the CLI or a live observation should say _where_ the fact came from (bundle function name, endpoint, date).
