import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	changelogBetween,
	compareVersions,
	ensureBundle,
	readChangelog,
	readPinnedVersion,
	resolveLatest,
} from "./lib/bundles.ts";
import { diff, hunks } from "./lib/diff.ts";
import { type NormalizedToken, normalize, tokenize } from "./lib/tokenize.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Category = { name: string; pattern: RegExp };

const WIRE_CATEGORIES: Category[] = [
	{ name: "endpoint paths", pattern: /"(\/(?:alpha|provider|internal|v1)[a-zA-Z0-9/_:-]*)"/g },
	{ name: "x- headers", pattern: /"(x-[a-z0-9-]+)"/g },
	{
		name: "NDJSON event types",
		pattern:
			/"(start-step|reasoning-start|reasoning-delta|reasoning-end|text-start|text-delta|text-end|tool-input-start|tool-input-delta|tool-input-end|tool-call|tool-result|tool-error|finish-step|cache-write-tokens|provider-metadata|start|finish|error|abort|done)"/g,
	},
	{ name: "behavior profiles", pattern: /"([a-z0-9-]+-v1)"/g },
	{ name: "effort vocabulary", pattern: /"(off|minimal|low|medium|high|xhigh|max)"/g },
	{ name: "catalog schemaVersion", pattern: /schemaVersion:(\d+)/g },
	{ name: "plan ids", pattern: /"(individual-[a-z0-9-]+|teams-pro)"/g },
	{
		name: "message part types",
		pattern: /type:"(text|image|tool-call|tool-result|reasoning|tool_use|tool_result|thinking)"/g,
	},
	{ name: "envelope keys", pattern: /[,{](config|memory|taste|skills|permissionMode|params|threadId):/g },
	{
		name: "config fields",
		pattern: /(workingDir|isGitRepo|currentBranch|mainBranch|gitStatus|recentCommits)\s*:/g,
	},
	{
		name: "usage fields",
		pattern:
			/(inputTokens|outputTokens|totalTokens|cachedInputTokens|inputTokenDetails|cacheReadTokens|cacheWriteTokens|totalUsage|prompt_cache_hit_tokens|reasoningTokens)\s*:/g,
	},
	{
		name: "providerMetadata keys",
		pattern: /"(gateway|anthropic|novita|cache_creation|ephemeral_1h_input_tokens)"/g,
	},
];

const ANCHORS = ["parseModel", "evaluateModelAccess"];

function args(): Map<string, string> {
	const map = new Map<string, string>();
	const argv = process.argv.slice(2);
	for (let index = 0; index < argv.length; index++) {
		const item = argv[index];
		if (!item.startsWith("--")) continue;
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			map.set(item.slice(2), value);
			index++;
		} else {
			map.set(item.slice(2), "true");
		}
	}
	return map;
}

function matchAll(source: string, pattern: RegExp): Set<string> {
	const set = new Set<string>();
	for (const match of source.matchAll(pattern)) set.add(match[1] ?? match[0]);
	return set;
}

function functionText(tokens: NormalizedToken[], source: string, name: string): string | null {
	for (let i = 0; i < tokens.length - 2; i++) {
		if (tokens[i].raw !== "function" || tokens[i + 1]?.raw !== name) continue;
		let depth = 0;
		let start = -1;
		for (let j = i + 2; j < tokens.length; j++) {
			const token = tokens[j];
			if (token.kind !== "punct") continue;
			if (token.raw === "{") {
				if (start < 0) start = j;
				depth++;
			} else if (token.raw === "}") {
				depth--;
				if (start >= 0 && depth === 0) return source.slice(tokens[i].start, token.start + 1);
			}
		}
	}
	return null;
}

function embeddedCatalogVersion(source: string): string {
	return /catalogVersion:"([0-9a-f]{64})"/.exec(source)?.[1] ?? "unknown";
}

function snippet(
	tokens: NormalizedToken[],
	aStart: number,
	aEnd: number,
	render: (t: NormalizedToken) => string,
): string {
	return tokens.slice(aStart, aEnd).map(render).join("").slice(0, 400);
}

const options = args();
const pinned = readPinnedVersion(path.join(REPO, "constants.ts"));
const oldVersion = options.get("old") ?? pinned;
const newVersion = options.get("new") ?? (await resolveLatest());
const cacheDir = options.get("cache-dir") ?? path.join(REPO, ".cache", "command-code");
const maxHunks = Number.parseInt(options.get("max-hunks") ?? "20", 10);

if (compareVersions(newVersion, oldVersion) === 0) {
	console.log(`command-code ${oldVersion} is already the pinned (and latest) release; nothing to diff.`);
	process.exit(0);
}

const [oldBundle, newBundle] = await Promise.all([
	ensureBundle(oldVersion, cacheDir),
	ensureBundle(newVersion, cacheDir),
]);
const oldSource = readFileSync(oldBundle.cliPath, "utf8");
const newSource = readFileSync(newBundle.cliPath, "utf8");

console.log(`wire diff: command-code ${oldVersion} -> ${newVersion}`);
console.log(`bundle bytes: ${oldSource.length} -> ${newSource.length}`);
console.log(
	`embedded catalogVersion: ${embeddedCatalogVersion(oldSource).slice(0, 12)}… -> ${embeddedCatalogVersion(newSource).slice(0, 12)}…`,
);

const changelog = changelogBetween(readChangelog(newBundle), oldVersion, newVersion);
if (changelog) console.log(`\n${changelog}`);

let wireFinding = false;
console.log("\n== wire constant sets ==");
for (const category of WIRE_CATEGORIES) {
	const before = matchAll(oldSource, category.pattern);
	const after = matchAll(newSource, category.pattern);
	const same = before.size === after.size && [...before].every((value) => after.has(value));
	if (!same) wireFinding = true;
	console.log(`${same ? "IDENTICAL" : "DIFFERS  "} ${category.name} (${before.size} -> ${after.size})`);
	if (!same) {
		const added = [...after].filter((value) => !before.has(value));
		const removed = [...before].filter((value) => !after.has(value));
		if (added.length > 0) console.log(`  added:   ${added.join(", ")}`);
		if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);
	}
}

const oldTokens = normalize(tokenize(oldSource));
const newTokens = normalize(tokenize(newSource));

console.log("\n== anchored functions ==");
for (const name of ANCHORS) {
	const before = functionText(oldTokens, oldSource, name);
	const after = functionText(newTokens, newSource, name);
	const status = before === null || after === null ? "MISSING" : before === after ? "IDENTICAL" : "DIFFERS";
	if (status === "DIFFERS") wireFinding = true;
	console.log(`${status.padEnd(9)} ${name}`);
}

console.log("\n== call-site object keys ==");
const KEY_WINDOWS: { label: string; anchor: string; before: number; after: number }[] = [
	{ label: "generate body", anchor: "/alpha/generate", before: 800, after: 6000 },
	{ label: "catalog document", anchor: "refreshAfterSeconds", before: 600, after: 900 },
	{ label: "reasoning effort", anchor: "reasoning_effort", before: 300, after: 700 },
];
function keysInWindow(source: string, anchor: string, before: number, after: number): Set<string> {
	const index = source.indexOf(anchor);
	if (index < 0) return new Set();
	const window = source.slice(Math.max(0, index - before), index + after);
	const keys = new Set<string>();
	for (const match of window.matchAll(/[,{]\s*([A-Za-z_$][\w$]*)\s*:/g)) keys.add(match[1]);
	return keys;
}
for (const window of KEY_WINDOWS) {
	const before = keysInWindow(oldSource, window.anchor, window.before, window.after);
	const after = keysInWindow(newSource, window.anchor, window.before, window.after);
	const same = before.size === after.size && [...before].every((key) => after.has(key));
	if (!same) wireFinding = true;
	console.log(`${same ? "IDENTICAL" : "DIFFERS  "} ${window.label} (${before.size} -> ${after.size})`);
	if (!same) {
		const added = [...after].filter((key) => !before.has(key));
		const removed = [...before].filter((key) => !after.has(key));
		if (added.length > 0) console.log(`  added:   ${added.join(", ")}`);
		if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);
	}
}

console.log("\n== semantic diff (identifier renames normalized) ==");
const edits = diff(
	oldTokens.map((token) => token.norm),
	newTokens.map((token) => token.norm),
);
if (!edits) {
	console.log("token diff exceeded the search limit; inspect the bundles manually.");
	process.exit(2);
}
const changes = edits.filter((edit) => edit.type !== "equal").length;
if (changes === 0) {
	console.log("NO CHANGES — the bundles differ only by identifier renames (or not at all).");
} else {
	const wireLiterals = new Set<string>();
	for (const category of WIRE_CATEGORIES) {
		for (const value of matchAll(oldSource, category.pattern)) wireLiterals.add(value);
		for (const value of matchAll(newSource, category.pattern)) wireLiterals.add(value);
	}
	const isWireToken = (token: NormalizedToken): boolean => {
		if (token.kind === "string") {
			const inner = token.raw.slice(1, -1);
			if (wireLiterals.has(inner)) return true;
			return [...wireLiterals].some((value) => inner.includes(value));
		}
		if (token.kind === "template") return [...wireLiterals].some((value) => token.raw.includes(value));
		return false;
	};
	const found = hunks(edits);
	console.log(`${changes} differing tokens in ${found.length} hunk(s)`);
	for (const hunk of found) {
		const before = snippet(oldTokens, hunk.aStart, hunk.aEnd, (token) => token.raw);
		const after = snippet(newTokens, hunk.bStart, hunk.bEnd, (token) => token.raw);
		const wireSuspect = [
			...oldTokens.slice(hunk.aStart, hunk.aEnd),
			...newTokens.slice(hunk.bStart, hunk.bEnd),
		].some(isWireToken);
		if (wireSuspect) wireFinding = true;
		console.log(
			`\n-- ${wireSuspect ? "WIRE-SUSPECT " : ""}A[${hunk.aStart}:${hunk.aEnd}] B[${hunk.bStart}:${hunk.bEnd}]`,
		);
		console.log(`   A: ${before}`);
		console.log(`   B: ${after}`);
		if (found.indexOf(hunk) + 1 >= maxHunks) {
			console.log(`\n(${found.length - maxHunks} more hunk(s); raise --max-hunks to see them)`);
			break;
		}
	}
	console.log(
		"\nHunks are localized by normalized-token offsets; identifiers print as their original names.",
	);
}

console.log("");
if (wireFinding) {
	console.log(
		`VERDICT: wire-relevant changes found. Update the extension per AGENTS.md, then bump the pin to ${newVersion}.`,
	);
	process.exit(1);
}
console.log(
	`VERDICT: no wire-relevant changes. Bump COMMAND_CODE_VERSION to ${newVersion} and refresh dated facts.`,
);
process.exit(0);
