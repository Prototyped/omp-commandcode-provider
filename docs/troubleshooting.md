# Troubleshooting

Error responses you'll actually hit, what they mean, and the fix. The gateway
returns errors in two formats depending on the surface: `/alpha/generate` uses
`{"success":false,"error":{"code","status","message"}}`; the `/provider/v1/*`
paths use an OpenAI-style `{"error":{"message","type","code"}}`.

## 401 — `UNAUTHORIZED`

```json
{
	"success": false,
	"error": { "code": "UNAUTHORIZED", "status": 401, "message": "Invalid 'Authorization' header or token." }
}
```

The key didn't resolve. Resolution order is: `/login commandcode-alpha` credential →
`models.yml` `providers.commandcode.apiKey` → the `COMMANDCODE_API_KEY` env var.
Causes, in order of likelihood:

- You never logged in, and no fallback key is set. Run `/login commandcode-alpha`
  and paste a `user_…` key from [commandcode.ai/settings](https://commandcode.ai/settings).
- The key is wrong / rotated. Verify it directly:

  ```bash
  curl -sS https://api.commandcode.ai/alpha/whoami \
    -H "Authorization: Bearer $COMMANDCODE_API_KEY"
  # → 200 {"success":true,"user":{…}}  means the key is good
  ```
- You logged in, then rotated the key out from under the session. Re-run
  `/login commandcode-alpha` — the next request picks up the new credential.

## 403 — `upgrade_required`

```json
{
	"error": {
		"message": "Your Go plan doesn't include API access. Upgrade to Pro or higher…",
		"type": "permission_error",
		"code": "upgrade_required"
	}
}
```

### Cause 1 — you called a Pro-gated path

You hit `/provider/v1/messages` or `/provider/v1/chat/completions`, which are
Pro-gated. This extension does **not** use those — it uses `/alpha/generate`.
If you see this, something is calling the compat endpoints directly (e.g. a
`models.json` provider entry pointing at `https://api.commandcode.ai/provider/v1`).
Remove that entry; let the extension own the `commandcode-alpha` provider.

### Cause 2 — the CLI version is below the gateway's floor

`/alpha/generate` validates the `x-command-code-version` header and rejects
anything below its minimum with the _same_ `upgrade_required` code, plus a
machine-readable floor:

```json
{
	"error": {
		"code": "upgrade_required",
		"message": "Your Command Code CLI is out of date. Run `cmd update` or `npm i -g command-code` to upgrade.",
		"minVersion": "0.18.10"
	}
}
```

The check is a floor only (0.18.10 as of 2026-10-31) — there is **no upper
bound**, so an ahead-of-server version is accepted, and a leading `v` is
tolerated. `GET /alpha/whoami` and `GET /provider/v1/models` do not gate on
it.

`COMMAND_CODE_VERSION` matters beyond bookkeeping: the extension reports its
pin as the client version, so a pin below the floor breaks every turn. When
you see this, bump the pin (see the next section for re-deriving the
protocol). The status-line notice described below fires on the _reverse_
condition — a pin that is too **old relative to npm**, which also means it is
eventually too old for the gateway.

## 400 — `BAD_REQUEST` (schema mismatch)

This is the failure mode to expect when Command Code changes their CLI.

The status line warns you before this happens: when the pinned
`COMMAND_CODE_VERSION` is behind the newest published `command-code` release, a
`commandcode-cli` entry reads `Command Code <latest> released · pin <old> stale`.
That is the cue to re-derive the protocol from the new bundle (see
`AGENTS.md`). No warning means npm could not be reached or the pin is current —
the check is advisory and never blocks startup.

The check is the CLI's own updater, not an api.commandcode.ai call (`update.ts`
mirrors the 1.88.3 bundle's `fetchVersions`/`getLatestVersion`/
`determineUpdateTarget`: `npm view command-code versions --json`, drop
prereleases, semver max). `update.ts` asks npm's dist-tags document instead of
the full packument (~90 bytes versus ~1.2 MB) and applies the same prerelease
filter and semver max; `latest` advances with every stable publish, so the two
agree. It runs detached at `session_start` (the harness awaits those
handlers), fetches nothing from the gateway, and works before login.

A second notice does not depend on npm: when the fetched catalog contains a
model with a `behaviorProfile` outside the pinned CLI's known set (the set is
listed in `AGENTS.md`'s validation map — the CLI's own "this client is too old"
verdict, 1.88.3 `clientUpdateReason`), `index.ts` records the offending
profiles at discovery and, at the next `session_start`, sets the status-line
entry `commandcode-profile` to `Command Code: unknown behaviorProfile
(<profiles>) — the pinned CLI <version> may be too old`. It fires even when the
npm version is current.

### Missing `config` fields

```
Validation error: expected string, received undefined at "config.workingDir"; …
```

The strict envelope schema rejected the body. Compare your outgoing `config`
against the current required fields (see `docs/wire-protocol.md`): `workingDir`,
`date`, `environment`, `structure`, `isGitRepo`, `currentBranch`, `mainBranch`,
`gitStatus`, `recentCommits`, plus top-level `memory` (string), `taste`,
`skills`, `permissionMode`, `params`, and `threadId` (a strict RFC 4122 UUID —
the gateway rejects other shapes with `Invalid UUID at "threadId"`). If the CLI added a new required field,
add it to `staticConfig()` / the body in `index.ts`.

### Wrong message shape

```
{"type":"error","error":{"type":"server_error","message":"Invalid prompt: The messages do not match the ModelMessage[] schema."}}
```

You sent something that isn't the Vercel AI SDK `ModelMessage` shape — most
often Anthropic content blocks (`tool_use` / `tool_result` / `role:"user"` with
tool results folded in) instead of `tool-call` / `tool-result` /
`role:"tool"`. See the schema in `docs/wire-protocol.md`. If the gateway
migrates to a new message schema version, `convertMessages()` is where to fix
it.

### Missing `reasoning_content` on an assistant turn

```
{"type":"error","error":{"type":"server_error","message":"Missing required parameter: 'messages[2].reasoning_content'. This model needs the reasoning of every earlier assistant message: send back the 'reasoning_content' returned with that message. …","statusCode":400,"isRetryable":false}}
```

Some models keep no server-side copy of earlier reasoning and require it in
the request (confirmed for `reflection/beam:free`; others may behave the
same). Most reasoning models do preserve the reasoning server-side, so the
error is model-specific, not universal — but the CLI sends assistant thinking
back as `{ "type": "reasoning", "text": "…" }` parts on every turn, which the
gateway maps onto the upstream `reasoning_content` field, and the extension
matches that. The error surfaces on the _next_ request after a reasoning
turn, so a first turn can succeed and the second 400.

### `params.system` sent as an array

```
Validation error: Invalid input: expected string, received array at "params.system"
or Invalid input: expected object, received string at "params.system[0]"
```

The gateway's `params.system` schema is a string-or-object-array union; an
array of strings fails both branches. The harness passes the system prompt as
parts (`Context.systemPrompt` is `string[]` in pi-ai), so they must be joined
before sending — see `systemPromptText()` in `session.ts` and
`docs/wire-protocol.md`.

### Model not supported on this endpoint

```json
{
	"type": "error",
	"error": {
		"type": "invalid_request_error",
		"message": "Model \"deepseek/deepseek-v4-pro\" is not supported on this endpoint. Use /provider/v1/chat/completions for OpenAI and OSS models."
	}
}
```

Only relevant if you're poking `/provider/v1/messages` (Anthropic-only) by
hand. Not produced via this extension. Anthropic models → `/messages`;
OpenAI/OSS → `/chat/completions`; everything → `/alpha/generate` (what we use).

## 400 — `insufficient credits`

```json
{
	"type": "error",
	"error": {
		"type": "invalid_request_error",
		"message": "You have insufficient credits to make this request. Please purchase more credits…"
	}
}
```

Out of credits. Check the balance:

```bash
curl -sS https://api.commandcode.ai/alpha/billing/credits \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
# {"credits":{"monthlyCredits":…,"purchasedCredits":…,"freeCredits":…}}
```

Note the Go plan's per-model multipliers stretch the nominal $10 a long way on
DeepSeek / MiMo / Qwen — but reasoning-heavy models burn output tokens fast.

## Debugging stream errors

Run with `DEBUG=1` to have the extension log the raw stream error object to
stderr:

```bash
DEBUG=1 omp --model "commandcode-alpha/deepseek/deepseek-v4-pro" -p "test" 2>&1 \
  | grep '\[commandcode\]'
```

## Stream just hangs / no output

- Reasoning models (DeepSeek V4 Pro, Qwen 3.7 Max) can spend many seconds on
  `reasoning-delta` before the first `text-delta`. That's normal, not a hang.
- A dropped connection mid-stream surfaces as an `error` event or a thrown
  fetch error, both caught and reported. If it truly hangs, check network /
  the gateway status, then retry.

## Re-deriving the protocol when it breaks

Everything here came from the shipped CLI bundle. When something changes:

```bash
npm i -g command-code            # get the latest CLI
F=$(npm root -g)/command-code/dist/index.mjs
grep -o '/alpha/[a-z/]*' "$F" | sort -u          # endpoints
# search the bundle for the request-body construction + the message converter
```

The canonical model id list is always:

```bash
curl -sS https://api.commandcode.ai/provider/v1/models \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
```

## Stream error codes (`/alpha/generate`)

The stream's `error` event carries `{type, message, statusCode, isRetryable}`.
Each code means a different user action:

| `type` / code                         | Cause                                                                                       | Action                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODEL_NOT_IN_PLAN`                   | Model above the account's plan                                                              | Pick a model the plan includes; the extension drops these at discovery, so this usually means a stale picker cache — run `omp models refresh` |
| `RATE_LIMITED`                        | Free-tier daily quota exhausted                                                             | Switch to the paid id, or wait for the quota reset                                                                                            |
| `FORBIDDEN`                           | A free-tier window ended (e.g. `poolside/laguna-s-2.1-free`, `ornith/ornith-1.5-122b:free`) | Pick the paid id the message names, or another model                                                                                          |
| `CMD_ZDR_NO_PROVIDERS`                | A `zdr: false` model (e.g. `meta/muse-spark-1.3-contributor`) under `CMD_ZDR=1`             | Unset `CMD_ZDR` or pick a ZDR-capable model                                                                                                   |
| `Model '…' not found`                 | Dead id or a gateway-side rewrite                                                           | Remove from `models.yml`; `omp models refresh`                                                                                                |
| (truncated stream, no terminal event) | Network drop or gateway crash mid-stream                                                    | Retry; the harness owns retry/fallback                                                                                                        |

## Hidden models

Rows with `hidden: true` in the catalog are filtered out of discovery (they do
not appear in the picker). They are still parsed with full capability data, so
a user who manually adds a hidden id to `models.yml` (with an `apiKey` or
`auth: none` beside it) gets real capabilities instead of defaults. Hidden
models that are also dead upstream are a gateway-side condition — nothing the
extension can prevent. An expired promo answers 403 `FORBIDDEN` naming the
ended tier and its paid replacement (`poolside/laguna-s-2.1-free`,
`ornith/ornith-1.5-122b:free`, `inclusionai/ling-3.1-flash-1019:free`,
live-checked 2026-11-05).
