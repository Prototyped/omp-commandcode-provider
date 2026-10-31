/**
 * Command Code provider extension for omp.
 *
 * Routes requests through https://api.commandcode.ai/alpha/generate
 * (the CLI's own endpoint), which every plan permits. The /provider/v1/*
 * OpenAI/Anthropic-compatible endpoints have been flaky/plan-gated for
 * generation, so we stick to the native /alpha/generate envelope the CLI
 * itself uses (GET /provider/v1/models is readable for the roster).
 *
 * Authentication: `/login commandcode` (validates the key against
 * /alpha/whoami, like the CLI does), or a `models.yml` `apiKey` for the
 * provider, or the COMMANDCODE_API_KEY env var as a last-resort fallback.
 * Keys are "user_..." tokens from https://commandcode.ai/settings.
 *
 * Wire contract (envelope, NDJSON events, usage/cost mapping):
 * docs/wire-protocol.md. Modules: messages.ts (harness Message→ModelMessage
 * conversion), session.ts (per-conversation identity), discovery.ts (live
 * roster + capabilities), stream.ts (the /alpha/generate stream).
 */
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BASE_URL, COMMAND_CODE_VERSION, PROVIDER_ID } from "./constants.ts";
import { discoverModels } from "./discovery.ts";
import { streamCommandCode } from "./stream.ts";
import { CLI_UPDATE_STATUS_KEY, checkCliUpdate, cliUpdateStatusText } from "./update.ts";

export { parseModelRows, readExcludedModels } from "./discovery.ts";
export { convertMessages } from "./messages.ts";
export { CLI_UPDATE_STATUS_KEY, checkCliUpdate, cliUpdateStatusText, pickLatestStable } from "./update.ts";

// Mirrors the Command Code CLI's API-key login: only an explicit 401
// rejects the key; a 403 or an unreachable endpoint keeps it.
async function login(callbacks: OAuthLoginCallbacks): Promise<string> {
	const apiKey = (
		await callbacks.onPrompt({
			message: "Command Code API key (commandcode.ai/settings)",
			placeholder: "user_...",
			secret: true,
		})
	).trim();
	if (!apiKey) throw new Error("Login cancelled");
	let response: Response | undefined;
	try {
		response = await fetch(`${BASE_URL}/alpha/whoami`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
	} catch {
		// Network failure: keep the key, like the CLI does.
	}
	if (response?.status === 401) throw new Error("Command Code rejected the API key (401)");
	return apiKey;
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		// With `oauth` present this is a last-resort fallback: a /login-saved
		// key (or a models.yml apiKey) wins over the env var.
		apiKey: "COMMANDCODE_API_KEY",
		authHeader: true,
		api: "commandcode-generate",
		streamSimple: streamCommandCode,
		oauth: {
			name: "Command Code",
			// Returns a plain API key; the harness persists it as an api-key
			// credential and feeds it to streamSimple / fetchDynamicModels.
			login,
		},
		fetchDynamicModels: async (apiKey) => discoverModels(apiKey, pi.pi.getAgentDir()),
	});

	// The pinned CLI version is this extension's protocol contract, so a newer
	// published CLI means the wire format needs re-deriving. Uses the CLI's own
	// update mechanism (newest stable npm release) — the router has none.
	// Detached: the harness awaits session_start handlers, and npm is not worth
	// stalling a session start on.
	pi.on("session_start", (_event, ctx) => {
		void checkCliUpdate(COMMAND_CODE_VERSION)
			.then((update) => {
				if (!update?.updateAvailable) return;
				ctx.ui.setStatus(
					CLI_UPDATE_STATUS_KEY,
					cliUpdateStatusText(COMMAND_CODE_VERSION, update.latestVersion),
				);
			})
			.catch(() => {});
	});
}
