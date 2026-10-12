import stringWidth from "string-width";

// Moved from `TS_BASELINE` `src/width.ts` at WP-9 of `plans/mdview-rust-port.md` and trimmed to the measure
// the instruments read; the probe, its cache and the resolution ladder are the Rust crate's
// (`crates/mdview/src/width.rs`, `probe.rs`). The prose below is as of `TS_BASELINE` (`c097c66`).

/**
 * Display-width measurement, and the East Asian **Ambiguous** question (WP-3).
 *
 * ## Why this module exists at all
 *
 * Almost every non-ASCII character this corpus actually contains — `—` `–` `→` `←`
 * `…` `≥` `×` `•` `○` `─` `│` — is East Asian **Ambiguous** (Unicode TR11). An
 * ambiguous character is one that a terminal renders at *either* 1 or 2 columns
 * depending on its own configuration and locale, and there is no way to know which
 * from the byte alone. `string-width` defaults to narrow (`ambiguousIsNarrow:
 * true` — in `@7`, where this was written, and still in the `@8.2.2` pinned since
 * WP-3 of `plans/pictograph-width.md`), which is also what TR11 itself recommends when
 * the context cannot be established — and until this WP that default was hardcoded at 26 call sites across
 * 7 modules, because `string-width` takes the setting as a **per-call option** and
 * offers no global switch.
 *
 * So this module is now the **only** file in `src/` or `scripts/` that imports
 * `string-width`. That is a checkable property, and `tests/width.test.ts` checks it:
 * if a future edit reaches for `stringWidth` directly, half the renderer silently
 * stops honouring the resolved mode and the tool measures itself two different ways
 * at once — the exact class of bug `TS_BASELINE` `src/table.ts`'s v4/v7 reconciliation loop exists
 * to paper over, and one that no width gate can see, because a gate that measures
 * with the wrong ruler passes.
 *
 * ## The mode is threaded, never a module-level global
 *
 * `TS_BASELINE` `src/glyphs.ts` states the precedent in its own header: it is the only module that
 * reads the environment, and `render.ts`/`table.ts` stay pure and take a `GlyphSet`
 * argument so every test is deterministic regardless of the machine. A process-global
 * `ambiguousIsNarrow` here would be smaller but is precisely what that comment was
 * written to prevent: it makes every test's result depend on whatever ran before it,
 * and it makes the sweep's numbers depend on the machine that ran it.
 *
 * A `Measure` is therefore a value, passed alongside the `GlyphSet` on the same
 * channel (`cli.ts` → `renderDocumentDetailed` → `renderTable`), and defaulting to
 * `NARROW_MEASURE` at every public entry point. The default is not a convenience: it
 * *is* rule 4 of the resolution order below, so a caller that says nothing gets the
 * documented fallback rather than an unset. And because the narrow path calls
 * `stringWidth(text)` with no options at all — byte-for-byte the call every one of
 * those 26 sites used to make — every existing caller is unchanged **by
 * construction**, not by measurement.
 *
 * ## The per-cluster cache
 *
 * `fn` segments the string once and sums a per-cluster `Map`, calling `stringWidth`
 * only on a miss. Measured 2026-09-12 on a 443-line plan in a sibling repo (4,042
 * calls / 68,267 chars): `string-width@8.2.2` takes `Measure` from **15 ms to 439 ms**
 * uncached, and the cache brings it back to **33.6 ms** colourless / **37.2 ms** under
 * `FORCE_COLOR=3`. That is what the cache is for; it lands here first on 7.2.0, where
 * it moves no byte, because 7.2.0's `stringWidth` is itself a per-cluster loop.
 *
 * The ANSI strip is the local transcription below, not a bail to whole-string
 * `stringWidth`: the bail is correct but re-segments every SGR-bearing string, which
 * left colour-on `Measure` at 90.5 ms against a 63.7 ms ceiling. It cannot use
 * `TS_BASELINE` `src/ansi.ts`'s scanner either — that module imports *this* one, and
 * `tests/scripts-acyclic.test.ts` forbids the cycle.
 *
 * Narrow and wide never share a map: they disagree on every Ambiguous cluster, so one
 * shared entry for `—` would hand whichever ruler asked second the other's answer.
 *
 * ## Resolution order (highest first) — mirrors `resolveGlyphs`
 *
 * 1. `MDVIEW_AMBIGUOUS=narrow|wide` in the environment. Any other value — including
 *    unset, empty, or a typo — is ignored and falls through. Never throws on a bad
 *    env var; that is the `MDVIEW_GLYPHS` contract and this matches it exactly.
 * 2. A cached probe result for **this terminal identity** (see `terminalIdentity`).
 * 3. A live DSR probe, if and only if stdin *and* stdout are TTYs and the caller
 *    allowed probing. Never in `--check`, never in the sweep, never headless — those
 *    have to stay deterministic and subprocess-free.
 * 4. **Narrow.** Every headless, redirected, piped, timed-out and unparseable case,
 *    and TR11's own recommendation when the context cannot be established.
 *
 * ## What wide mode does *not* fix
 *
 * Not the per-cell table padding — that residual is **closed**. It existed because
 * `cli-table3` assembled the finished table and pads with its own bundled
 * `string-width@4`, which has no `ambiguousIsNarrow` option at all; `TS_BASELINE` `src/table.ts`
 * now emits its own borders and pads with the `Measure` it was given, so there is
 * nothing left to reconcile.
 *
 * What remains is the glyph-choice problem: `─ │ ┌ ┬ ┼ …` are themselves Ambiguous and
 * measure 2 under wide, so the Unicode tier's border row is exactly twice its content
 * rows however carefully it is padded. That is handled by refusing the tier —
 * `wideForcesAscii` in `TS_BASELINE` `src/glyphs.ts` — not by measurement. See `crates/mdview/AGENTS.md`'s
 * "Ambiguous width (WP-3)".
 */

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

export type AmbiguousWidth = "narrow" | "wide";

/**
 * A display-width function that knows which ambiguous-width convention it applies.
 *
 * Callable, so a call site reads `measure(text)` exactly where it used to read
 * `stringWidth(text)` — the swap is mechanical and reviewable — while the `ambiguous`
 * tag keeps a `Measure` self-describing for diagnostics and for tests that need to
 * assert *which* ruler a code path was handed.
 */
export interface Measure {
  (text: string): number;
  readonly ambiguous: AmbiguousWidth;
}

/**
 * Terminal sequences, stripped before measuring — transcribed from `ansi-regex@6.2.2`,
 * which is the pattern `string-width`'s own `strip-ansi` applies, so this module removes
 * exactly the bytes `stringWidth` would have removed and the two agree by construction.
 * Transcribed rather than imported for the reason above: the repo's own grammar lives in
 * `TS_BASELINE` `src/ansi.ts`, which imports this module.
 */
const ANSI_SEQUENCE = /(?:\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g; // eslint-disable-line no-control-regex

/**
 * Grapheme segmentation for the per-cluster width cache below.
 *
 * Duplicated from `TS_BASELINE` `src/text.ts`'s `GRAPHEMES` rather than imported: `text.ts` imports
 * *this* module, so the reverse import would close the two-node cycle
 * `tests/scripts-acyclic.test.ts` forbids. The one-liner is the cheaper of the two
 * duplications (the alternative is moving `GRAPHEMES`/`graphemes` here and re-exporting
 * from `text.ts`, which moves a prose primitive into the ruler module for no gain).
 */
const WIDTH_GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Cluster-cache bound. Distinct clusters are a property of the *script* being rendered,
 * not of document length: the measured peak is **103 distinct clusters in any single
 * render**, across the two WP-1 timing files and every fixture in `tests/fixtures/`
 * (2026-09-12), and 4096 is ≥40× that headroom. So this bound is never reached on real
 * corpora and exists only so a pathological input (generated CJK, dense emoji) cannot
 * grow the map without end.
 * On overflow the map is cleared wholesale rather than evicted one entry at a time — the
 * next render re-warms it in a few hundred `stringWidth` calls, which is cheaper than
 * carrying LRU bookkeeping on every hit.
 */
const WIDTH_CACHE_LIMIT = 4096;

function makeMeasure(ambiguous: AmbiguousWidth): Measure {
  // The narrow branch deliberately passes **no options object**: `{ ambiguousIsNarrow:
  // true }` is string-width@7's documented default, but "identical to the default" and
  // "the default" are not the same claim, and this WP's binding acceptance criterion is
  // that narrow-mode output is byte-identical to the parent commit. Calling exactly the
  // function the parent commit called makes that true by construction.
  const raw =
    ambiguous === "wide"
      ? (text: string): number => stringWidth(text, { ambiguousIsNarrow: false })
      : (text: string): number => stringWidth(text);

  // One cache per `Measure`, never shared: the two rulers disagree by construction on
  // every East Asian Ambiguous cluster, so a shared map would hand `WIDE_MEASURE` the
  // narrow answer for `—` the moment `NARROW_MEASURE` saw it first.
  const cache = new Map<string, number>();

  const fn = (text: string): number => {
    // ANSI: strip locally, then measure the plain text through the cache. Bailing to a
    // whole-string `stringWidth` instead (the first design) is correct but costs the
    // whole colour-on budget — measured 2026-09-12, it left `Measure` at 90.5 ms on the
    // 443-line plan under `FORCE_COLOR=3` against a 63.7 ms ceiling, because 139 of the
    // measured strings carry SGR and each one pays full segmentation. The strip cannot
    // go through `TS_BASELINE` `src/ansi.ts`'s scanner: `ansi.ts` imports *this* module, and
    // `tests/scripts-acyclic.test.ts` forbids the cycle.
    const plain =
      text.includes("\u001B") || text.includes("\u009B") ? text.replace(ANSI_SEQUENCE, "") : text;

    let total = 0;
    for (const { segment } of WIDTH_GRAPHEMES.segment(plain)) {
      const hit = cache.get(segment);
      if (hit !== undefined) {
        total += hit;
        continue;
      }
      const width = raw(segment);
      if (cache.size >= WIDTH_CACHE_LIMIT) cache.clear();
      cache.set(segment, width);
      total += width;
    }
    return total;
  };

  return Object.assign(fn, { ambiguous }) as Measure;
}

/** East Asian Ambiguous characters measure 1 column. The default, and TR11's own advice. */
export const NARROW_MEASURE: Measure = makeMeasure("narrow");

/** East Asian Ambiguous characters measure 2 columns. */
export const WIDE_MEASURE: Measure = makeMeasure("wide");

export function measureFor(ambiguous: AmbiguousWidth): Measure {
  return ambiguous === "wide" ? WIDE_MEASURE : NARROW_MEASURE;
}

/** Parse an `MDVIEW_AMBIGUOUS`-shaped value; anything unrecognized is `undefined`. */
export function parseAmbiguousWidth(value: string | undefined): AmbiguousWidth | undefined {
  if (value === "narrow") return "narrow";
  if (value === "wide") return "wide";
  return undefined;
}
