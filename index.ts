/**
 * Command Code provider extension for omp.
 *
 * Routes requests through https://api.commandcode.ai/alpha/generate — the
 * endpoint the `cmd` CLI itself uses, which every plan permits (the
 * /provider/v1/* OpenAI/Anthropic-compatible endpoints are Pro-gated). omp's
 * own bundled `commandcode` provider points at those, which is why this
 * extension registers under a distinct id.
 *
 * Provider id: commandcode-alpha. Models, capabilities, pricing and plan
 * gates come from the gateway's CLI catalog
 * (`GET /provider/v1/models?view=client`) — the same source the CLI uses.
 *
 * Authentication: `/login commandcode-alpha` (validates the key against
 * /alpha/whoami, like the CLI does), or a `models.yml` `apiKey` for the
 * provider, or the COMMANDCODE_API_KEY env var as a last-resort fallback.
 * Keys are "user_..." tokens from https://commandcode.ai/settings.
 *
 * Wire contract (envelope, NDJSON events, usage mapping): docs/wire-protocol.md.
 * Modules: messages.ts (harness Message→ModelMessage conversion), session.ts
 * (per-conversation identity), catalog.ts (catalog parser), discovery.ts
 * (catalog → harness models), plan.ts (plan gating), stream.ts (the stream).
 */
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BASE_URL, COMMAND_CODE_VERSION, PROVIDER_ID } from "./constants.ts";
import { discoverModels, KNOWN_BEHAVIOR_PROFILES } from "./discovery.ts";
import { evaluateModelAccess, fetchBilling } from "./plan.ts";
import { streamCommandCode } from "./stream.ts";
import { CLI_UPDATE_STATUS_KEY, checkCliUpdate, cliUpdateStatusText } from "./update.ts";

let unknownProfiles: string[] = [];

export { parseCatalog } from "./catalog.ts";
export { readExcludedModels } from "./exclusions.ts";
export { convertMessages } from "./messages.ts";
export { evaluateModelAccess } from "./plan.ts";
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
		fetchDynamicModels: async (apiKey) => {
			const [models, billing] = await Promise.all([
				discoverModels(pi.pi.getAgentDir()),
				apiKey ? fetchBilling(apiKey, BASE_URL) : Promise.resolve(null),
			]);
			const unknown = models.filter((m) => !KNOWN_BEHAVIOR_PROFILES.has(m.behaviorProfile));
			if (unknown.length > 0) {
				unknownProfiles = [...new Set(unknown.map((m) => m.behaviorProfile))];
				console.error(
					`[commandcode-alpha] unknown behaviorProfile (${unknownProfiles.join(", ")}) — client may be too old`,
				);
			}
			if (!billing || billing.fetchFailed) return models;
			const kept = models.filter((m) => evaluateModelAccess(billing, m).allowed);
			const dropped = models.length - kept.length;
			if (dropped > 0) {
				console.error(`[commandcode-alpha] dropped ${dropped} model(s) above plan ${billing.planId}`);
			}
			return kept;
		},
	});

	// The pinned CLI version is this extension's protocol contract, so a newer
	// published CLI means the wire format needs re-deriving. Uses the CLI's own
	// update mechanism (newest stable npm release) — the router has none.
	// Detached: the harness awaits session_start handlers, and npm is not worth
	// stalling a session start on.
	pi.on("session_start", (_event, ctx) => {
		void checkCliUpdate(COMMAND_CODE_VERSION)
			.then((update) => {
				if (update?.updateAvailable) {
					ctx.ui.setStatus(
						CLI_UPDATE_STATUS_KEY,
						cliUpdateStatusText(COMMAND_CODE_VERSION, update.latestVersion),
					);
				}
			})
			.catch(() => {});
		if (unknownProfiles.length > 0) {
			ctx.ui.setStatus(
				"commandcode-profile",
				`Command Code: unknown behaviorProfile (${unknownProfiles.join(", ")}) — the pinned CLI ${COMMAND_CODE_VERSION} may be too old`,
			);
		}
	});
}
