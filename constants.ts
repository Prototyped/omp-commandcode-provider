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
export const ENDPOINT = "/alpha/generate";
// Mirrors the `x-command-code-version` the CLI sends (its package version).
// Keep in step with the installed `command-code` package; stale values risk
// being rejected or flagged by the gateway.
export const COMMAND_CODE_VERSION = "0.52.1";
