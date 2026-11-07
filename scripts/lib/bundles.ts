import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REGISTRY = "https://registry.npmjs.org";

export type Bundle = {
	version: string;
	cliPath: string;
	changelogPath: string;
	dir: string;
};

export async function resolveLatest(): Promise<string> {
	const response = await fetch(`${REGISTRY}/-/package/command-code/dist-tags`);
	if (!response.ok) throw new Error(`npm dist-tags: HTTP ${response.status}`);
	const tags = (await response.json()) as { latest?: string };
	if (!tags.latest) throw new Error("npm dist-tags: no latest tag");
	return tags.latest;
}

export function readPinnedVersion(constantsPath: string): string {
	const match = /COMMAND_CODE_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(constantsPath, "utf8"));
	if (!match) throw new Error(`no COMMAND_CODE_VERSION in ${constantsPath}`);
	return match[1];
}

export async function ensureBundle(version: string, cacheDir: string): Promise<Bundle> {
	const dir = path.join(cacheDir, version);
	const cliPath = path.join(dir, "package", "dist", "cli.mjs");
	const changelogPath = path.join(dir, "package", "CHANGELOG.md");
	if (!existsSync(cliPath)) {
		const metaResponse = await fetch(`${REGISTRY}/command-code/${version}`);
		if (!metaResponse.ok) throw new Error(`registry metadata for ${version}: HTTP ${metaResponse.status}`);
		const meta = (await metaResponse.json()) as { dist?: { tarball?: string } };
		const tarball = meta.dist?.tarball;
		if (!tarball) throw new Error(`no tarball published for command-code ${version}`);
		const tgzResponse = await fetch(tarball);
		if (!tgzResponse.ok) throw new Error(`tarball ${version}: HTTP ${tgzResponse.status}`);
		mkdirSync(dir, { recursive: true });
		const tgzPath = path.join(dir, "package.tgz");
		writeFileSync(tgzPath, Buffer.from(await tgzResponse.arrayBuffer()));
		execFileSync("tar", ["-xzf", tgzPath, "-C", dir], { stdio: "inherit" });
	}
	if (!existsSync(cliPath)) throw new Error(`no dist/cli.mjs in command-code ${version}`);
	return {
		version,
		cliPath,
		changelogPath,
		dir,
	};
}

export function readChangelog(bundle: Bundle): string {
	return existsSync(bundle.changelogPath) ? readFileSync(bundle.changelogPath, "utf8") : "";
}

export function changelogBetween(changelog: string, oldVersion: string, newVersion: string): string {
	const sections = changelog.split(/^## /m).slice(1);
	const picked: string[] = [];
	for (const section of sections) {
		const version = section.slice(0, section.search(/\s|$/));
		if (compareVersions(version, oldVersion) > 0 && compareVersions(version, newVersion) <= 0) {
			picked.push(`## ${section.trimEnd()}`);
		}
	}
	return picked.join("\n\n");
}

export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10));
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}
