# Prompt caching

**Short version: caching works through `/alpha/generate`, and it's big — a
warm 5.4K-token prefix cost ~36× less than the cold call.** Agentic loops with
a stable system prompt + tool definitions cache very well on this provider.

## How it works here

The gateway (Vercel AI Gateway) forwards the upstream provider's native prompt
caching. For DeepSeek that's automatic prefix caching — repeated leading
context (system prompt, early turns, tool defs) is served from cache on
subsequent requests. You don't send any `cache_control` markers; it just
happens for stable prefixes above the provider's minimum (DeepSeek caches in
blocks; very short prefixes won't hit).

The hit count comes back in `finish-step.usage` under three equivalent fields:

- `usage.cachedInputTokens` — Vercel AI SDK convention (the extension reads this first)
- `usage.inputTokenDetails.cacheReadTokens` — same number
- `usage.raw.prompt_cache_hit_tokens` — DeepSeek-native

## Measured (DeepSeek V4 Pro, 2026-05)

Same ~5.4K-token system prefix, two calls. Round 1 used a fresh nonce so the
prefix had never been seen; Round 2 reused it.

| Round            | `inputTokens` | `cachedInputTokens` | gateway cost (USD) |
| ---------------- | ------------- | ------------------- | ------------------ |
| 1 (cold)         | 5418          | 0                   | $0.00238           |
| 2 (warm, reused) | 5418          | 5376                | $0.000066          |

~36× cheaper on the cached portion. Only the 42 non-prefix tokens (the changed
user message) were billed at full rate on the warm call.

Observed separately: a prefix can hit cache even on what you think is the
"first" call, because the upstream cache persists for a while across nearby
requests. So real-world agentic sessions tend to hit cache even more than this
synthetic test suggests.

## Why the extension subtracts cached tokens from `input`

The gateway reports `inputTokens` as the **total** input (cached + uncached).
The harness's `Usage` type (from `@oh-my-pi/pi-ai`) expects `input` and `cacheRead` to be **disjoint** — its
`calculateCost()` multiplies each by a separate per-million rate, and computes
`totalTokens = input + output + cacheRead + cacheWrite`. The built-in Anthropic
provider in `@oh-my-pi/pi-ai` follows the same disjoint convention.

So leaving cached tokens inside `input` would **double-count** them and
over-bill on any model with a non-zero `cost.input`. The extension does:

```ts
const totalInputTokens = usage.inputTokens ?? 0;
const cacheReadTokens =
	usage.cachedInputTokens ??
	usage.inputTokenDetails?.cacheReadTokens ??
	usage.raw?.prompt_cache_hit_tokens ??
	0;

output.usage.input = Math.max(0, totalInputTokens - cacheReadTokens);
output.usage.cacheRead = cacheReadTokens;
```

On the Go plan this is cosmetic (all bundled models use `cost: 0` because the
plan's credit multipliers don't map to per-token pricing), but it keeps the
numbers honest for any fork that wires up real per-token costs.

## Reproducing the test

```bash
KEY=user_…
NONCE=$(uuidgen)
# Build a body with a big stable system prompt prefixed by $NONCE, send twice
# with different final user messages, and compare usage.cachedInputTokens in
# each finish-step event. (Full scratch scripts aren't shipped; the table above
# is what they produced.)
```

Real credit balance (the session meter's `usage.cost` is a local estimate
from the catalog's `pricing` rates, not what the account is debited):

```bash
curl -sS https://api.commandcode.ai/alpha/billing/credits \
  -H "Authorization: Bearer $COMMANDCODE_API_KEY"
```
