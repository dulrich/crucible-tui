import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseColourDirective, type ColourDirective } from "./colour";

/**
 * Generic config plumbing, shared by every mdview entry point that needs
 * user-level configuration. WP-1 needs exactly one key: the corpus manifest
 * path (see `scripts/sweep.ts`).
 *
 * WP-4 extends this same file with a `highlightAs` fence-language alias map
 * (fence language -> highlight.js language). Layering is built-in defaults
 * first, user entries layered over: `src/lang.ts` owns the built-in map
 * (`dataviewjs`/`dataview`) and merges it with whatever `highlightAs` this
 * module loads, so a user entry for a key that also has a built-in default
 * wins. `mdview highlight-as` (`src/cli.ts`) is the write path, via
 * `writeHighlightAlias` below.
 *
 * WP-11 adds `emoji`: whether `:shortcode:` substitution follows the glyph tier
 * (unset — the default) or is forced on/off regardless of tier. Unlike
 * `highlightAs`, this key is not layered over anything — it is read once in
 * `src/cli.ts`'s view path and handed to `renderDocumentDetailed` as an explicit
 * `emojiOverride` argument (`src/render.ts`), the same "config stays impure,
 * render stays pure and takes explicit values" split `glyphs`/`measure` already
 * use, rather than the module-level-state pattern `setHighlightAliases` uses —
 * see that function's own doc comment for why *its* case needs a global instead.
 *
 * WP-1 of `plans/colour-policy.md` adds `color`, on the `emoji` model rather than the
 * `highlightAs` one: read once in `src/cli.ts`'s view path, handed to `resolveColourPolicy`
 * as one input among five, never layered and never mutated into a global. Its value is a
 * directive (`auto`/`always`/`never`) rather than a boolean — see `MdviewConfig.color`.
 */
export interface MdviewConfig {
  /** Path to a corpus manifest (see `scripts/sweep.ts`'s `CorpusManifest`). */
  corpusManifest?: string;
  /**
   * User-configured fence-language aliases, keyed by fence language and
   * normalized to lowercase (matching `resolveFenceLanguage`'s own lookup).
   * Layered over — never replacing — `src/lang.ts`'s built-in map.
   */
  highlightAs?: Record<string, string>;
  /**
   * Force `:shortcode:` substitution on (`true`) or off (`false`), overriding the
   * glyph-tier default (Unicode renders glyphs, ASCII keeps the literal shortcode).
   * Unset (the common case) means "follow the tier".
   */
  emoji?: boolean;
  /**
   * The user's standing colour preference: `always`, `never`, or `auto` (follow the
   * destination). WP-1 of `plans/colour-policy.md`.
   *
   * **It is a directive, not a boolean, and that asymmetry with `emoji` above is the
   * point.** `emoji` has two states and an "unset" that means *follow the glyph tier*, so
   * `boolean | undefined` says everything there is to say. Colour has an explicit third
   * state a user may want to write down — `"auto"`, i.e. *I know this key exists and I want
   * the default behaviour* — which is not the same statement as omitting the key, and which
   * a boolean cannot spell. It sits **below** both `--color` and `MDVIEW_COLOR` in the
   * precedence table (`src/colour.ts`): a file preference loses to anything said about this
   * invocation.
   */
  color?: ColourDirective;
}

const CONFIG_DEFAULTS: MdviewConfig = {};

/** `$XDG_CONFIG_HOME/mdview/config.json`, else `~/.config/mdview/config.json`. */
export function resolveConfigPath(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : join(homedir(), ".config");
  return join(configHome, "mdview", "config.json");
}

/**
 * `record.highlightAs` -> a validated `Record<string, string>`, or `undefined`
 * if nothing usable survives. Keys and values are trimmed and lowercased so a
 * hand-edited config matches `resolveFenceLanguage`'s lookup regardless of
 * how the user cased it. Never throws: a per-entry problem is logged (naming
 * the path and the offending key) and that entry alone is dropped, so one bad
 * entry does not cost every other one, and the caller is never left silently
 * wondering why a setting had no effect.
 */
function validateHighlightAs(value: unknown, path: string): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error(
      `mdview: ignoring malformed "highlightAs" at ${path}: expected an object mapping fence language to highlighter language`,
    );
    return undefined;
  }

  const valid: Record<string, string> = {};
  const badKeys: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string" || entry.trim().length === 0 || key.trim().length === 0) {
      badKeys.push(key);
      continue;
    }
    valid[key.trim().toLowerCase()] = entry.trim().toLowerCase();
  }
  if (badKeys.length > 0) {
    console.error(
      `mdview: ignoring malformed "highlightAs" entries at ${path}: non-string or empty value(s) for ${badKeys
        .map((key) => JSON.stringify(key))
        .join(", ")}`,
    );
  }
  return Object.keys(valid).length > 0 ? valid : undefined;
}

/**
 * Load the user config.
 *
 * - Missing file -> defaults, silently. This is the common case: most
 *   installs never write one.
 * - Malformed JSON (or a non-object) -> defaults, plus **one** single-line
 *   stderr notice naming the path and the parser's message. Never a stack
 *   trace — the viewer narrates its own state, never a parser's internals.
 * - A malformed `highlightAs` (wrong shape, or individual bad entries) is the
 *   same policy at finer grain: log naming the path and the problem, keep
 *   whatever in the file is still valid, never throw.
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
    if (record.highlightAs !== undefined) {
      const highlightAs = validateHighlightAs(record.highlightAs, path);
      if (highlightAs) config.highlightAs = highlightAs;
    }
    if (record.emoji !== undefined) {
      if (typeof record.emoji === "boolean") {
        config.emoji = record.emoji;
      } else {
        console.error(`mdview: ignoring malformed "emoji" at ${path}: expected a boolean`);
      }
    }
    if (record.color !== undefined) {
      // Same read-leniently policy as every other key here: name the file and the
      // expectation, drop this entry alone, render the document anyway. A misspelt colour
      // preference is not a reason to refuse to show someone their file.
      const color = typeof record.color === "string" ? parseColourDirective(record.color) : undefined;
      if (color !== undefined) {
        config.color = color;
      } else {
        console.error(`mdview: ignoring malformed "color" at ${path}: expected auto, always or never`);
      }
    }
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`mdview: ignoring malformed config at ${path}: ${message}`);
    return { ...CONFIG_DEFAULTS };
  }
}

export interface WriteHighlightAliasResult {
  path: string;
  /** Whether the config file did not exist before this write. */
  created: boolean;
}

/**
 * Record `fence -> language` into the user's config at `path`, alongside
 * whatever else is already there.
 *
 * This edits a file the user may hand-maintain, so it is deliberately not
 * "load, merge the typed `MdviewConfig`, write it back" — `loadConfig` only
 * ever surfaces the keys this module knows about, and round-tripping through
 * it would silently drop every other key (a future WP's setting, a comment-ish
 * field the user added) the moment `highlight-as` is run once. Instead this
 * reads the raw JSON object, touches only `highlightAs[fence]`, and leaves
 * every other key and every other `highlightAs` entry exactly as it was.
 *
 * Refuses to proceed if the existing file cannot be parsed as a JSON object —
 * merging into a file it cannot understand would either clobber content this
 * function has no way to see, or silently discard it, both worse than
 * stopping and naming the problem. A missing file is not this case: it is the
 * common first-run path and starts from `{}`.
 *
 * Written atomically (temp file in the same directory, then `rename`), so a
 * failure partway through can never leave a truncated config on disk.
 */
export async function writeHighlightAlias(
  fence: string,
  language: string,
  path = resolveConfigPath(),
): Promise<WriteHighlightAliasResult> {
  const normalizedFence = fence.trim().toLowerCase();
  const normalizedLanguage = language.trim().toLowerCase();
  if (normalizedFence.length === 0) throw new Error("highlight-as: <fence> must not be empty");
  if (normalizedLanguage.length === 0) throw new Error("highlight-as: <language> must not be empty");

  let existingText: string | undefined;
  try {
    existingText = await readFile(path, "utf8");
  } catch {
    existingText = undefined; // missing file: start fresh, the common case
  }

  let raw: Record<string, unknown> = {};
  if (existingText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existingText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `refusing to update config at ${path}: existing file is not valid JSON (${message}). Fix or remove it, then re-run \`mdview highlight-as\`.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `refusing to update config at ${path}: expected a JSON object at the top level, found ${
          Array.isArray(parsed) ? "an array" : typeof parsed
        }.`,
      );
    }
    raw = parsed as Record<string, unknown>;
  }

  const existingHighlightAs = raw.highlightAs;
  const highlightAs: Record<string, string> =
    typeof existingHighlightAs === "object" && existingHighlightAs !== null && !Array.isArray(existingHighlightAs)
      ? Object.fromEntries(
          Object.entries(existingHighlightAs as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  highlightAs[normalizedFence] = normalizedLanguage;

  const merged = { ...raw, highlightAs };
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;

  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tempPath, serialized, "utf8");
  await rename(tempPath, path);

  return { path, created: existingText === undefined };
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
