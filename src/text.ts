import { NARROW_MEASURE, type Measure } from "./width";

/**
 * Display-width text primitives, shared by the table emitter (`src/table.ts`) and the
 * ANSI-safe prose wrapper (`src/wrap.ts`).
 *
 * These three functions were previously exported from `src/table.ts`, which meant
 * `wrap.ts` — a *prose* module that knows nothing about tables — imported from the
 * table module purely to reach `graphemes`/`splitToken`. WP-3 needed a third consumer
 * (the owned table emitter's padding), so the primitives moved here and the inverted
 * dependency went with them. Nothing about their behaviour changed: `graphemes` and
 * `splitToken` are byte-for-byte the functions that were in `table.ts`, and every
 * public entry point still defaults to `NARROW_MEASURE`, so a caller that passes no
 * `Measure` makes exactly the `string-width` call it made before.
 *
 * Pure: no I/O, no globals, no environment reads. `Measure` arrives as an argument
 * for the reason `src/glyphs.ts` states about `GlyphSet` — a process-global ruler
 * makes every test's result depend on what ran before it.
 */

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Split a string into grapheme clusters, so emoji sequences are never cut apart. */
export function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (segment) => segment.segment);
}

/**
 * Hard-split one unbreakable token into chunks no wider than `width` display columns.
 *
 * This is the step that makes the output lossless and is the specific advantage over
 * `rich-cli` and `cli-table3`'s own behaviour, both of which would ellipsize here.
 * `splitToken(t, w).join("") === t` for every `t` — nothing is ever dropped.
 */
export function splitToken(token: string, width: number, measure: Measure = NARROW_MEASURE): string[] {
  const limit = Math.max(1, width);
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const grapheme of graphemes(token)) {
    const graphemeWidth = measure(grapheme);
    if (currentWidth > 0 && currentWidth + graphemeWidth > limit) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += graphemeWidth;
  }
  if (current !== "") chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

/** Which side of a cell the slack goes on. Mirrors markdown's `:---` / `:---:` / `---:`. */
export type Align = "left" | "center" | "right";

/**
 * Pad `text` out to `width` **display** columns, putting the slack on the side `align`
 * asks for.
 *
 * Three properties, each of which a table emitter depends on:
 *
 * - **It measures with the caller's `Measure`, never with `.length`.** That is the
 *   whole point of WP-3: `cli-table3` padded with its own bundled `string-width@4`,
 *   which has no `ambiguousIsNarrow` option at all, so under `MDVIEW_AMBIGUOUS=wide`
 *   its count and this repo's count could not be made to agree per cell and the
 *   table's right edge went ragged by up to *k* columns for *k* ambiguous characters.
 *   Padding with the same ruler the allocation used makes that disagreement
 *   impossible by construction.
 * - **It is ANSI-safe** — `Measure` is `string-width`, which ignores SGR sequences, so
 *   a styled cell is padded by what it *shows*. (Table cells are flattened to plain
 *   text upstream by `flattenInline`, but the padding must not become the reason that
 *   stays true.)
 * - **It never truncates and never ellipsizes.** A string already at or over `width`
 *   comes back untouched rather than cut — `cli-table3`'s `pad()` deferred to its
 *   `truncate()`, which appends `…`, and this repo's rendering policy is that nothing
 *   is ever ellipsized. Over-wide content overflows visibly instead.
 *
 * The centre case splits an odd column to the **right**, matching `cli-table3`'s
 * `pad()` (`right = ceil(padlen / 2)`), so a centred cell's bytes are unchanged.
 */
export function padToWidth(
  text: string,
  width: number,
  align: Align = "left",
  measure: Measure = NARROW_MEASURE,
): string {
  const slack = Math.max(0, width - measure(text));
  if (slack === 0) return text;
  switch (align) {
    case "right":
      return " ".repeat(slack) + text;
    case "center": {
      const right = Math.ceil(slack / 2);
      return " ".repeat(slack - right) + text + " ".repeat(right);
    }
    default:
      return text + " ".repeat(slack);
  }
}
