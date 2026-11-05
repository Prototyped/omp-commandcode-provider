# omp-commandcode-provider

An extension for the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) coding agent that adds [Command Code](https://commandcode.ai) as a model provider — DeepSeek V4 Pro/Flash, Kimi K3, GLM 5.2, MiniMax M3, Qwen 3.7 Max, Inkling, and the rest of the open-weight roster, all routable from inside omp.

> **Fork.** This is a hard fork of [safzanpirani/pi-commandcode-provider](https://github.com/safzanpirani/pi-commandcode-provider), retargeted from the original pi harness to the [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) harness.

> **Unofficial.** Reverse-engineered from the `command-code` npm CLI (currently verified against v1.88.3). Not affiliated with or endorsed by Command Code / Langbase. Schema is undocumented and can change without notice.

## Why this exists

Command Code's `/provider/v1/messages` and `/provider/v1/chat/completions` **generation** endpoints require the **Provider plan or higher**. The **Go plan** ($1/month with $10 of credits and per-model multipliers, e.g. ~$40 of DeepSeek V4 Pro) doesn't expose them. (`GET /provider/v1/models` is public — it answers unauthenticated — but generation is gated.)

This extension instead talks to `/alpha/generate`, the endpoint the Command Code CLI (`cmd`) uses for every model call. It's not plan-gated, so any account that can run `cmd` can use it. The trade-off is that the request/response shape is undocumented and Vercel-AI-SDK-flavored, not OpenAI- or Anthropic-shaped — hence the extension.

## Configure

Log in with your Command Code API key (mint one at [commandcode.ai/settings](https://commandcode.ai/settings), it looks like `user_…`):

```
/login commandcode-alpha
```

The key is validated against `GET /alpha/whoami` (the same check the `cmd` CLI makes) and stored in the harness credential store. A 401 rejects the key; a 403 or an unreachable endpoint keeps it, matching CLI behavior.

Fallbacks, in order: an `apiKey` on the `commandcode-alpha` provider entry in your `models.yml`, then the `COMMANDCODE_API_KEY` environment variable:

```yaml
# models.yml
providers:
  commandcode-alpha:
    apiKey: user_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

```bash
# or
export COMMANDCODE_API_KEY=user_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A saved `/login` key wins over both fallbacks.

Optional: set `CMD_ZDR=1` to send Command Code's strict zero-data-retention
header. Models without a ZDR-capable upstream will fail with `422` instead of
falling back.

## Install

```bash
omp install git+https://github.com/Prototyped/omp-commandcode-provider
```

Or try it for one run without installing — clone the repo, `bun install`, then
`omp -e .` (see [Development](#development)).

## Use

```bash
omp --model "commandcode-alpha/deepseek/deepseek-v4-pro" -p "what is 17 * 23?"
omp --model "commandcode-alpha/moonshotai/Kimi-K2.6" -p "draft a haiku about caching"
```

`omp models commandcode-alpha` shows everything registered.

## Models

There is no model list in this extension. At startup the catalog is discovered live from `GET /provider/v1/models?view=client` (public — no auth required): the same versioned CLI catalog the `cmd` CLI consumes, with per-model context windows, output caps, input modalities, reasoning efforts, pricing, and plan gates. The harness caches the discovered catalog across startups; run `omp models refresh` to force a re-fetch.

- **Reasoning/vision** flags, output caps, and context windows all come from the catalog row (`reasoningEfforts`, `inputModalities`, `maxOutputTokens`, `context_length`). The parser is strict on purpose: a model whose row the catalog schema gate rejects is dropped, and an unrecognized catalog document (unsupported `schemaVersion` or malformed shape) is a discovery failure rather than a guess.
- **Plan gating.** Models above the account's plan are dropped at discovery, mirroring the CLI's `evaluateModelAccess`: purchased or free credits bypass the gate; otherwise the model's `minimumPlan` must rank at or below the account plan (`individual-go` → `individual-goat` → `individual-pro` → `individual-provider` → `individual-max` → `individual-ultra`), falling back to a category gate (`opensource` vs `premium`) when no `minimumPlan` is set. Billing is read from `GET /alpha/billing/subscriptions` + `/alpha/billing/credits`; a billing failure fails open (all models kept). Premium-category models therefore only appear on Pro and above.
- **Hide a model:** list its id under `excludedModels` in `models.yml`:

  ```yaml
  providers:
    commandcode-alpha:
      excludedModels:
        - "Qwen/Qwen3.7-Max"
  ```
- **If discovery fails** (endpoint down, or its response shape changed), the failure is reported to the harness, which keeps the catalog from the last successful discovery (a first startup with no cached catalog shows nothing). There is deliberately no static fallback to serve stale. `omp models refresh` forces a re-fetch.

## How it works

- Resolves the key as `/login` credential → `models.yml` `apiKey` → `COMMANDCODE_API_KEY`, discovers models from the CLI catalog at `GET /provider/v1/models?view=client` (a discovery failure is thrown so the harness keeps its cached catalog), and filters models above the account plan (the CLI's `evaluateModelAccess` port — billing from `/alpha/billing/*`, fail-open on billing failure) plus `models.yml` `excludedModels`
- POST `https://api.commandcode.ai/alpha/generate` with `Authorization: Bearer <key>`
- Body is a wrapped envelope: `{ config, memory, taste, skills, permissionMode, params, threadId }` where `params` carries the actual `{ model, system, messages, tools, max_tokens, stream }`. `threadId` (a strict RFC 4122 UUID, mirrored in the `x-session-id` header) is stable per conversation — the harness `sessionId` when available, else derived deterministically from the working directory, system prompt, and opening message — so the gateway's prompt-cache affinity holds across turns
- `config`, `memory`, `taste`, and `skills` are static neutral defaults in `index.ts`. A fork that wants Command Code's workspace/taste context can replace `staticConfig()` and those sidecar fields without touching message or stream parsing.
- Messages use the [Vercel AI SDK `ModelMessage` schema](https://sdk.vercel.ai/docs) — `tool-call` parts on assistant messages, `role: "tool"` + `tool-result` parts for tool outputs (not Anthropic content blocks, not OpenAI tool messages)
- Response is **NDJSON** (newline-delimited JSON), not SSE — events like `reasoning-start/delta/end`, `text-start/delta/end`, `tool-input-start/delta/end`, `finish-step`
- The extension translates the harness's native message format ↔ that wire shape and maps stream events onto the harness's `thinking_*` / `text_*` / `toolcall_*` events
- Per-call cost is computed locally from the catalog's `pricing` rates (USD per 1M tokens) over the final usage — disjoint input/output/cacheRead/cacheWrite buckets — and written to the session usage meter (`usage.cost`). The rates are upstream market costs, not the Go plan's credit debits
- At startup it compares the pinned CLI version against npm's newest stable `command-code` release (the same source the CLI's own updater reads) and, when the pin is behind, shows `Command Code <latest> released · pin <old> stale` in the status line — the cue that the wire protocol needs re-deriving. The check is advisory: npm unreachable or current means no notice, and it never delays session start

For the full, field-by-field contract, see the docs below.

## Docs

Reverse-engineered reference for the undocumented endpoint this extension speaks — useful if you're forking, extending, or the schema drifts and something starts 400ing:

- [`docs/wire-protocol.md`](docs/wire-protocol.md) — the complete `/alpha/generate` request/response contract: config envelope, Vercel-AI-SDK `ModelMessage` schema, tool format, every NDJSON event type, usage shape.
- [`docs/caching.md`](docs/caching.md) — prompt caching behavior + measured numbers (~36× cheaper on a warm prefix), and why the extension subtracts cached tokens from `input`.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — the 401 / 403 / 400 error modes, what each means, how to fix, and how to re-derive the protocol from the CLI bundle when it changes.

## Caveats

- **Discovery is live and uncached here.** The CLI catalog is fetched each startup from the public `GET /provider/v1/models?view=client` (plus the billing endpoints for plan gating when a key is available). If the fetch or its document fails, the failure is reported to the harness, which serves its cached catalog from the last successful discovery (a first startup has nothing cached, so it shows no models) — there is no bundled fallback to serve stale. Run `omp models refresh` to re-fetch.
- **Undocumented endpoint.** `/alpha/generate` isn't a published API surface. Command Code can change the schema at any time. If they tighten the request shape, expect 400 errors until the extension is updated. For request-schema 400s, first compare the outgoing body in `index.ts` against the current CLI envelope: `config.{workingDir, date, environment, structure, isGitRepo, currentBranch, mainBranch, gitStatus, recentCommits}`, `memory: string`, `taste`, `skills`, `permissionMode`, and `params.{model, system, messages, tools, max_tokens, stream}`.
- **Tier policy.** This extension uses an endpoint the official CLI uses, on credentials your plan grants. Command Code may consider that fair game or may not; their published "API access" feature still requires the Pro plan. If your account gets flagged or rate-limited, that's the realistic downside.
- **Vision depends on the model.** Image input comes from the catalog row's `inputModalities`; a row without `image` is text-only.
- **The session meter meters upstream cost, not plan debits.** Per-call cost is the catalog's `pricing` rates (USD per 1M tokens) applied to the turn's usage — an estimate of what the upstream model costs, not what the Go plan debits (the plan applies per-model credit multipliers). Real balance: `curl -H "Authorization: Bearer $COMMANDCODE_API_KEY" https://api.commandcode.ai/alpha/billing/credits`.
- **Reasoning is heavy.** DeepSeek V4 Pro and Qwen 3.7 Max emit a lot of reasoning tokens by default. A short answer can cost 10–30× the input. Budget accordingly on the Go plan.

## Development

```bash
git clone https://github.com/Prototyped/omp-commandcode-provider
cd omp-commandcode-provider

# Test it without installing
omp -e . -p "say pong"     # with an interactive session: /login commandcode-alpha when it asks for a key
# (COMMANDCODE_API_KEY still works as a fallback)

# Install deps, type-check, lint+format, test (all via bun)
bun install
bun run check
bun run lint
bun test
```

The omp harness runs on bun, so that's the toolchain here too. omp loads `.ts` files directly, so there's no build step.

## License

MIT — see [LICENSE](LICENSE).
