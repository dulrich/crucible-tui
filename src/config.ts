import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Generic config plumbing, shared by every mdview entry point that needs
 * user-level configuration. WP-1 needs exactly one key: the corpus manifest
 * path (see `scripts/sweep.ts`).
 *
 * WP-4 extends this same file with a `highlightAs` fence-language alias map
 * (fence language -> highlight.js language, layered over the built-in
 * `dataviewjs`/`dataview` defaults in `src/lang.ts`) plus a `mdview
 * highlight-as` subcommand that writes it back. Do not build that now — this
 * is the extension point:
 *
 *   export interface MdviewConfig {
 *     corpusManifest?: string;
 *     // highlightAs?: Record<string, string>;  <- WP-4 adds this
 *   }
 */
export interface MdviewConfig {
  /** Path to a corpus manifest (see `scripts/sweep.ts`'s `CorpusManifest`). */
  corpusManifest?: string;
}

const CONFIG_DEFAULTS: MdviewConfig = {};

/** `$XDG_CONFIG_HOME/mdview/config.json`, else `~/.config/mdview/config.json`. */
export function resolveConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config");
  return join(configHome, "mdview", "config.json");
}

/**
 * Load the user config.
 *
 * - Missing file -> defaults, silently. This is the common case: most
 *   installs never write one.
 * - Malformed JSON (or a non-object) -> defaults, plus **one** single-line
 *   stderr notice naming the path and the parser's message. Never a stack
 *   trace — the viewer narrates its own state, never a parser's internals.
 */
export async function loadConfig(path = resolveConfigPath()): Promise<MdviewConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ...CONFIG_DEFAULTS };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    const record = parsed as Record<string, unknown>;
    const config: MdviewConfig = { ...CONFIG_DEFAULTS };
    if (typeof record.corpusManifest === "string" && record.corpusManifest.length > 0) {
      config.corpusManifest = record.corpusManifest;
    }
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mdview: ignoring malformed config at ${path}: ${message}`);
    return { ...CONFIG_DEFAULTS };
  }
}

export type ManifestSource = "env" | "config" | "bundled";

/**
 * Bundled, public-safe default manifest — ships in every clone (including a
 * fresh public `crucible-tui` checkout) with no knowledge of any local path.
 */
export const BUNDLED_DEFAULT_MANIFEST = join(import.meta.dir, "..", "corpus", "default-manifest.json");

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
  config: MdviewConfig,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: ManifestSource } {
  const fromEnv = env.MDVIEW_CORPUS_MANIFEST;
  if (fromEnv && fromEnv.length > 0) return { path: fromEnv, source: "env" };
  if (config.corpusManifest && config.corpusManifest.length > 0) {
    return { path: config.corpusManifest, source: "config" };
  }
  return { path: BUNDLED_DEFAULT_MANIFEST, source: "bundled" };
}
