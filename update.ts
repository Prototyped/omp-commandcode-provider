/**
 * Detects a stale `COMMAND_CODE_VERSION` pin.
 *
 * The Command Code CLI's own updater (`fetchVersions` / `getLatestVersion` /
 * `determineUpdateTarget` in the 1.88.2 bundle) asks npm for the package's
 * published versions (`npm view command-code versions --json`), drops
 * prereleases, and compares the semver maximum against its own version.
 *
 * This module mirrors that check against npm's dist-tags document instead of
 * the full packument (whose abbreviated form is ~1.2 MB): the same "newest
 * stable release" answer in ~90 bytes. Divergence: a stable release published
 * under no dist-tag would be invisible here; the CLI's `latest` tag advances
 * with every stable publish, so that is not observed in practice.
 */
import { COMMAND_CODE_VERSION } from "./constants.ts";

const PACKAGE = "command-code";
const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE}/dist-tags`;
const FETCH_TIMEOUT_MS = 3_000;

export type CliUpdateCheck = { latestVersion: string; updateAvailable: boolean };

/** Status-line key; the footer renders every `ctx.ui.setStatus` entry. */
export const CLI_UPDATE_STATUS_KEY = "commandcode-cli";

type Semver = { core: number[]; prerelease: string | null };

function parseSemver(value: unknown): Semver | null {
	if (typeof value !== "string") return null;
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
	if (!match) return null;
	return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? null };
}

function compareSemver(a: Semver, b: Semver): number {
	for (let i = 0; i < 3; i++) {
		if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
	}
	return 0;
}

/**
 * Newest stable version among the supplied versions (dist-tag values or a
 * version list). Prereleases are dropped, matching the CLI's
 * `isPrereleaseVersion` filter before its `getLatestVersion` max.
 */
export function pickLatestStable(tags: unknown): string | null {
	const values =
		tags !== null && typeof tags === "object" && !Array.isArray(tags)
			? Object.values(tags)
			: Array.isArray(tags)
				? tags
				: [];
	let best: { raw: string; parsed: Semver } | null = null;
	for (const value of values) {
		const parsed = parseSemver(value);
		if (!parsed || parsed.prerelease !== null) continue;
		if (!best || compareSemver(parsed, best.parsed) > 0) best = { raw: value as string, parsed };
	}
	return best?.raw ?? null;
}

/**
 * Is the pinned CLI version behind the newest published one? Returns null when
 * npm can't be asked or its answer is unparseable — a staleness notice is
 * advisory, so an unreachable registry never produces one.
 */
export async function checkCliUpdate(
	pinned: string = COMMAND_CODE_VERSION,
	fetchImpl: typeof fetch = fetch,
): Promise<CliUpdateCheck | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetchImpl(DIST_TAGS_URL, {
			headers: { accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const latestVersion = pickLatestStable(await response.json());
		if (!latestVersion) return null;
		const pinnedParsed = parseSemver(pinned);
		const latestParsed = parseSemver(latestVersion);
		if (!pinnedParsed || !latestParsed) return null;
		return {
			// Mirrors `determineUpdateTarget`: with nothing newer, the target is
			// the current version.
			latestVersion: compareSemver(latestParsed, pinnedParsed) > 0 ? latestVersion : pinned,
			updateAvailable: compareSemver(latestParsed, pinnedParsed) > 0,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Footer text: what drifted, and that the wire protocol needs re-deriving. */
export function cliUpdateStatusText(pinned: string, latest: string): string {
	return `Command Code ${latest} released · pin ${pinned} stale`;
}
