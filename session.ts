/**
 * Session identity.
 *
 * x-session-id and the body's threadId key the gateway's session state and
 * prompt-cache affinity, so a stable id per conversation matters for cost.
 * The gateway validates threadId as a strict RFC 4122 UUID (the CLI sends
 * its session's crypto.randomUUID()), so the fallback id is a deterministic
 * UUID derived from the working directory, system prompt, and opening user
 * message — the same convention other omp provider extensions use (e.g. the
 * GitLab Duo provider) — so the same conversation keeps its identity across
 * restarts while distinct conversations stay apart. Only the version (4) and
 * variant (8) nibbles are pinned; the remaining 124 bits are FNV-1a hash
 * output.
 */
import type { Context } from "@oh-my-pi/pi-ai";

/**
 * The harness hands the system prompt as parts (pi-ai `Context.systemPrompt`
 * is `string[]`). The gateway's `params.system` schema rejects an array of
 * strings (observed 400 "expected string, received array at params.system",
 * 2026-10-31 — the union's other branch is an array of objects), so the
 * parts canonicalize to one "\n\n"-joined string. Shared by the request
 * body (stream.ts) and the session seed below so both agree.
 */
export function systemPromptText(systemPrompt: string | string[] | undefined): string {
	const parts = typeof systemPrompt === "string" ? [systemPrompt] : (systemPrompt ?? []);
	return parts.join("\n\n");
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(input: string, seed: number): number {
	let hash = seed >>> 0;
	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index);
		// Math.imul keeps the multiply in 32-bit space; a plain `*` would lose
		// precision past 2^53 and make the hash platform-dependent.
		hash = Math.imul(hash, FNV_PRIME) >>> 0;
	}
	return hash >>> 0;
}

function sessionDigest(seed: string): string {
	const lanes = [
		fnv1a(seed, FNV_OFFSET),
		fnv1a(seed, FNV_PRIME),
		fnv1a(`${seed}\u00002`, FNV_OFFSET),
		fnv1a(`${seed}\u00003`, FNV_PRIME),
	];
	return lanes.map((lane) => lane.toString(16).padStart(8, "0")).join("");
}

export function deriveSessionId(context: Context): string {
	let firstUser = "";
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") firstUser = message.content;
		else
			firstUser = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("");
		if (firstUser.length > 0) break;
	}
	const seed = `${process.cwd()}\u0000${systemPromptText(context.systemPrompt)}\u0000${firstUser}`;
	const hex = sessionDigest(seed);
	// The gateway validates threadId as a strict RFC 4122 UUID (the CLI sends
	// crypto.randomUUID() session ids), so pin the version (4) and variant (8)
	// nibbles; everything else is hash output.
	const digits = hex.split("");
	digits[12] = "4";
	digits[16] = "8";
	const versioned = digits.join("");
	return `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20, 32)}`;
}
