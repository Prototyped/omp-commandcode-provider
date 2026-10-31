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

The key didn't resolve. Resolution order is: `/login commandcode` credential →
`models.yml` `providers.commandcode.apiKey` → the `COMMANDCODE_API_KEY` env var.
Causes, in order of likelihood:

- You never logged in, and no fallback key is set. Run `/login commandcode`
  and paste a `user_…` key from [commandcode.ai/settings](https://commandcode.ai/settings).
- The key is wrong / rotated. Verify it directly:

  ```bash
  curl -sS https://api.commandcode.ai/alpha/whoami \
    -H "Authorization: Bearer $COMMANDCODE_API_KEY"
  # → 200 {"success":true,"user":{…}}  means the key is good
  ```
- You logged in, then rotated the key out from under the session. Re-run
  `/login commandcode` — the next request picks up the new credential.

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

You hit `/provider/v1/messages` or `/provider/v1/chat/completions`, which are
Pro-gated. This extension does **not** use those — it uses `/alpha/generate`.
If you see this, something is calling the compat endpoints directly (e.g. a
`models.json` provider entry pointing at `https://api.commandcode.ai/provider/v1`).
Remove that entry; let the extension own the `commandcode` provider.

## 400 — `BAD_REQUEST` (schema mismatch)

This is the failure mode to expect when Command Code changes their CLI.

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

## `Error: [object Object]`

Old symptom (fixed). Was a non-`Error` throwable getting `String()`-ed. If you
ever see it again, run with `DEBUG=1` — the extension logs the raw error object
to stderr:

```bash
DEBUG=1 omp --model "commandcode/deepseek/deepseek-v4-pro" -p "test" 2>&1 \
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
