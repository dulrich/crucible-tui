/**
 * scripts/measure/config.ts — corpus-manifest resolution for the instruments.
 *
 * Moved from `TS_BASELINE` `src/config.ts` at WP-9 of `plans/mdview-rust-port.md` and trimmed to the one key
 * the sweep reads (`corpusManifest`). The viewer's own config — `highlightAs`, `emoji`,
 * `color`, `hyperlinks`, and the atomic `highlight-as` writer — is the Rust crate's
 * (`crates/mdview/src/config.rs`); the TypeScript original is `TS_BASELINE` (`c097c66`)
 * `src/config.ts`. Reading stays lenient: a missing or malformed file means "no key".
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MeasureConfig {
  /** Path to a corpus manifest (see `scripts/corpus.ts`'s `CorpusManifest`). */
  corpusManifest?: string;
}

/** `$XDG_CONFIG_HOME/mdview/config.json`, else `~/.config/mdview/config.json`. */
export function resolveConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config");
  return join(configHome, "mdview", "config.json");
}

/** The `corpusManifest` key, if the config file has a usable one; never throws. */
export async function loadConfig(path = resolveConfigPath()): Promise<MeasureConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const value = (parsed as Record<string, unknown>).corpusManifest;
    return typeof value === "string" && value.length > 0 ? { corpusManifest: value } : {};
  } catch {
    return {};
  }
}

export type ManifestSource = "env" | "config" | "bundled";

/**
 * Bundled, public-safe default manifest — ships in every clone (including a
 * fresh public `crucible-tui` checkout) with no knowledge of any local path.
 */
export const BUNDLED_DEFAULT_MANIFEST = join(import.meta.dir, "..", "..", "corpus", "default-manifest.json");

/**
 * Resolve the corpus manifest path. Precedence (highest first):
 *
 *   1. `MDVIEW_CORPUS_MANIFEST` environment variable
 *   2. config key `corpusManifest`
 *   3. the bundled default manifest
 *
 * A `--manifest <path>` CLI flag outranks all three of these — callers that
 * support the flag must check it themselves before falling back to this
 * function (see `scripts/sweep.ts`).
 */
export function resolveCorpusManifestPath(
  config: MeasureConfig,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: ManifestSource } {
  const fromEnv = env.MDVIEW_CORPUS_MANIFEST;
  if (fromEnv && fromEnv.length > 0) return { path: fromEnv, source: "env" };
  if (config.corpusManifest && config.corpusManifest.length > 0) {
    return { path: config.corpusManifest, source: "config" };
  }
  return { path: BUNDLED_DEFAULT_MANIFEST, source: "bundled" };
}
