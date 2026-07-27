/**
 * Terminal glyph capability tier.
 *
 * One detected tier drives bullets, horizontal rules, table borders, and task-state
 * glyphs together — a terminal that cannot render `•` cannot render `┌` or `✓` either
 * (plan decision 1, `plans/vault-readiness.md`). This module is the *only* place that
 * reads the environment; `render.ts` and `table.ts` stay pure and take a `GlyphSet`
 * argument so every test is deterministic regardless of the machine's `TERM` or locale.
 */

export type GlyphTier = "unicode" | "ascii";

export interface GlyphSet {
  readonly tier: GlyphTier;
  /** Per-nesting-level unordered bullets; cycles with `%` past the end. */
  readonly bullets: readonly string[];
  /** Single character repeated to draw a horizontal rule. */
  readonly rule: string;
  /** `cli-table3` `chars` override; `undefined` keeps the library's Unicode default. */
  readonly tableChars: Readonly<Record<string, string>> | undefined;
  /** When false, Obsidian checkbox states render literally (`[x]`). */
  readonly rewriteTaskStates: boolean;
}

// Bullet correction over the plan: `▪` (U+25AA) and `▫` both measure 2 display columns
// under string-width@7.2.0 (the version `--check` enforces), which would break the
// `chromeWidth`-stays-`3N+1` invariant this WP exists to preserve. The user was asked
// and chose `‣` (U+2023 TRIANGULAR BULLET) instead, which measures 1 column exactly
// like `•` and `◦`. See the WP-2 execution brief for the measurement.
export const UNICODE_GLYPHS: GlyphSet = {
  tier: "unicode",
  bullets: ["•", "◦", "‣"],
  rule: "─",
  tableChars: undefined,
  rewriteTaskStates: true,
};

// Every ASCII substitute is 1 display column, identical to the Unicode glyph it
// replaces, so `chromeWidth()`/`allocateWidths()` in `table.ts` need no changes for
// this tier either.
const ASCII_TABLE_CHARS: Record<string, string> = {
  top: "-",
  "top-mid": "+",
  "top-left": "+",
  "top-right": "+",
  bottom: "-",
  "bottom-mid": "+",
  "bottom-left": "+",
  "bottom-right": "+",
  left: "|",
  "left-mid": "+",
  mid: "-",
  "mid-mid": "+",
  right: "|",
  "right-mid": "+",
  middle: "|",
};

export const ASCII_GLYPHS: GlyphSet = {
  tier: "ascii",
  bullets: ["-"],
  rule: "-",
  tableChars: ASCII_TABLE_CHARS,
  // Per the plan's locked decision: the ASCII tier leaves task states literal
  // (`- [x] done` stays `- [x] done`) rather than inventing ASCII substitutes.
  rewriteTaskStates: false,
};

/** `TERM` values that cannot be trusted to render Unicode glyphs even under a UTF-8 locale. */
const DUMB_TERMS = new Set(["linux", "dumb", "vt100", "vt220", "ansi"]);

function hasUtf8Locale(env: Record<string, string | undefined>): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return /utf-?8/i.test(locale);
}

function detectTier(env: Record<string, string | undefined>): GlyphTier {
  // Treat a missing/empty TERM as not-in-the-list, so locale alone decides.
  const term = env.TERM ?? "";
  if (DUMB_TERMS.has(term)) return "ascii";
  return hasUtf8Locale(env) ? "unicode" : "ascii";
}

/**
 * Resolve the active `GlyphSet`.
 *
 * Precedence, highest first:
 * 1. `override` (the CLI's `--ascii` / `--unicode`).
 * 2. `env.MDVIEW_GLYPHS` when it is exactly `"ascii"` or `"unicode"`. Any other value
 *    (including unset) is ignored and falls through to detection — this never throws
 *    on a bad env var.
 * 3. Auto-detect: Unicode iff the locale looks like UTF-8 *and* `TERM` is not a known
 *    glyph-incapable terminal.
 */
export function resolveGlyphs(
  env: Record<string, string | undefined>,
  override?: GlyphTier,
): GlyphSet {
  if (override === "ascii") return ASCII_GLYPHS;
  if (override === "unicode") return UNICODE_GLYPHS;

  if (env.MDVIEW_GLYPHS === "ascii") return ASCII_GLYPHS;
  if (env.MDVIEW_GLYPHS === "unicode") return UNICODE_GLYPHS;

  return detectTier(env) === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS;
}
