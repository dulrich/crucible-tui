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
  /**
   * Border-glyph override for `src/table.ts`'s emitter, keyed by `cli-table3`'s
   * kebab-cased slot names (the emitter kept that vocabulary when it took the job
   * over in WP-3 of `plans/tn-review-remediation.md`). `undefined` selects the
   * emitter's `UNICODE_BORDER` set, which reproduces the old library default exactly.
   */
  readonly tableChars: Readonly<Record<string, string>> | undefined;
  /** When false, Obsidian checkbox states render literally (`[x]`). */
  readonly rewriteTaskStates: boolean;
}

// Bullet correction over the plan: `▪` (U+25AA) and `▫` both measure 2 display columns
// under string-width@7.2.0 (the version `--check` enforces), which would break the
// `chromeWidth`-stays-`3N+1` invariant this WP exists to preserve. The user was asked
// and chose `‣` (U+2023 TRIANGULAR BULLET) instead, which measures 1 column exactly
// like `•` and `◦`. See the WP-2 execution brief for the measurement.
//
// **"Exactly 1 column" is a narrow-measurement statement, and WP-3 found out how narrow.**
// `•` and `─` and the whole box-drawing charset below are East Asian *Ambiguous*: under
// `MDVIEW_AMBIGUOUS=wide` they measure 2 and this tier's width contract collapses. That
// is why `resolveGlyphs` refuses to hand this set out in wide mode — see
// `wideForcesAscii`. Of this whole tier only `◦`, `‣` and `✓` are 1 column either way.
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
 * 0. **`ambiguous === "wide"` forces ASCII, ahead of everything including the flags.**
 *    See `wideForcesAscii` below — this is arithmetic, not taste.
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
  ambiguous?: "narrow" | "wide",
): GlyphSet {
  if (ambiguous === "wide") return ASCII_GLYPHS;

  if (override === "ascii") return ASCII_GLYPHS;
  if (override === "unicode") return UNICODE_GLYPHS;

  if (env.MDVIEW_GLYPHS === "ascii") return ASCII_GLYPHS;
  if (env.MDVIEW_GLYPHS === "unicode") return UNICODE_GLYPHS;

  return detectTier(env) === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/**
 * Whether the resolved ambiguous-width setting has taken the tier out of the caller's
 * hands — so `cli.ts` can say so on stderr rather than silently ignoring `--unicode`.
 *
 * **Deliberately the flag only, not `MDVIEW_GLYPHS=unicode`.** A flag is a request made
 * about *this* invocation and going unmet is news; an exported environment variable is
 * ambient, and a notice for it would print on every single render for the rest of that
 * shell's life. The env var's own resolution is documented in `src/AGENTS.md` and in the
 * probe's output, which is where an ambient setting belongs.
 *
 * **Why wide mode forces ASCII (WP-3).** This tier's whole width contract, stated at
 * the top of this file and depended on by `chromeWidth()`'s `3N+1`, is *"every Unicode
 * substitute is exactly 1 column, so the tier has no width impact"*. That sentence is
 * true only under narrow measurement. Under wide measurement it is false for **most of
 * the set**: `•` (U+2022), `─` (U+2500) and the entire box-drawing charset `│ ┌ ┬ ┼ …`
 * are East Asian *Ambiguous* and measure 2. Only `◦`, `‣` and `✓` survive.
 *
 * The consequence is not cosmetic and it is not repairable in the allocator:
 *
 * - **A table's border row cannot be made to fit.** A horizontal rule is one `─` per
 *   column of cell width, so the border row is exactly *twice* the content rows.
 *   No amount of allocation fixes that: the overage *is* the entire budget, and
 *   `allocateWidths` correctly reports `fits: false` rather than collapsing the table.
 *   Measured on `tests/fixtures/wide-table.md`: 160 columns rendered at a target of 80,
 *   200 at 100 — exactly 2x, at every width tried. **This is the one wide-mode table
 *   defect WP-3 of `plans/tn-review-remediation.md` did *not* close** — that package
 *   fixed the per-cell *padding* (the ragged right edge), which is a measurement
 *   problem; this is a glyph-choice problem and the choice is made right here.
 * - **A substituted bullet silently widens its own item.** `substituteBullets` swaps
 *   `"* "` for `"• "` *after* the budget arithmetic has run on the source marker, so
 *   every unordered item is one column over budget per level.
 *
 * Measured over the bundled corpus at all five sweep widths: **wide + Unicode tier =
 * 35 overflows of 60 combos; wide + ASCII tier = 0.**
 *
 * So this is not "we think ASCII looks better in a CJK locale". It is: in a terminal
 * that draws ambiguous characters at two columns, this tool cannot lay out a table with
 * box-drawing characters at all, and the ASCII charset — every glyph of which is
 * unambiguously 1 column in both modes — is the one that works. It outranks `--unicode`
 * because `--unicode` asserts a *capability* ("this terminal can draw these"), which is
 * still true and is simply not the constraint that binds. `MDVIEW_AMBIGUOUS=narrow` is
 * the escape hatch for anyone who wants the box drawing back and will accept the
 * overflow.
 */
export function wideForcesAscii(override: GlyphTier | undefined, ambiguous: "narrow" | "wide"): boolean {
  return ambiguous === "wide" && override === "unicode";
}
