/**
 * User-level model exclusions, read from the harness's user models.yml under
 * the `commandcode-alpha` provider entry:
 *
 *   providers:
 *     commandcode-alpha:
 *       excludedModels:
 *         - "some/model-id"
 *
 * The harness schema rejects provider entries that carry no recognized field,
 * so the entry needs one (an `apiKey`, `auth: none`, `baseUrl`, ...) beside
 * `excludedModels`. The parser keeps unknown keys, so the host ignores
 * `excludedModels` while this extension reads it from the raw file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { PROVIDER_ID } from "./constants.ts";

type ModelsYaml = { providers?: Record<string, { excludedModels?: unknown }> };

export async function readExcludedModels(agentDir: string): Promise<Set<string>> {
	try {
		const raw = await readFile(path.join(agentDir, "models.yml"), "utf8");
		const data = (loadYaml(raw) ?? null) as ModelsYaml | null;
		const list = data?.providers?.[PROVIDER_ID]?.excludedModels;
		if (!Array.isArray(list)) return new Set();
		return new Set(list.filter((id): id is string => typeof id === "string" && id !== ""));
	} catch {
		return new Set();
	}
}
