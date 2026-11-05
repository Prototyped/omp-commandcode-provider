/**
 * Wire endpoints for the Command Code gateway and the CLI version pin.
 */
export const BASE_URL = "https://api.commandcode.ai";
// Distinct from the CLI's own `commandcode` provider id, which omp bundles
// pointing at the Go-gated /provider/v1 compat endpoints. Sharing the id let
// the harness route turns there and answer "Your Go plan doesn't include API
// access" for models this extension serves fine over /alpha/generate.
export const PROVIDER_ID = "commandcode-alpha";
export const MODELS_ENDPOINT = "/provider/v1/models";
// `view=client` returns the CLI's model catalog: per-model capabilities,
// pricing, plan gates and aliases.
export const CATALOG_ENDPOINT = `${MODELS_ENDPOINT}?view=client`;
export const ENDPOINT = "/alpha/generate";
// Mirrors the `x-command-code-version` the CLI sends (its package version).
// Keep in step with the `command-code` npm release whose wire protocol this
// implementation matches — it is a protocol-version marker, not a dependency.
export const COMMAND_CODE_VERSION = "1.88.3";
// The gateway rejects params.max_tokens above this with 400 "Too big:
// expected number to be <=200000" (verified 2026-10-31 for deepseek, glm and
// kimi models alike) — the CLI never sends more (its default is 64e3).
export const MAX_OUTPUT_TOKENS_CAP = 200_000;
export const DEFAULT_OUTPUT_TOKENS = 64_000;
