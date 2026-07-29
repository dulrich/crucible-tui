/**
 * Defect detectors — the gates that can see what a width gate cannot.
 *
 * `--check` and both corpus sweeps only ever test whether a line *exceeds* the
 * target width. Every list-wrap defect this tool has shipped was **under** the
 * target width, which is why ~44.5k-file sweeps ran green through all of them.
 * The detectors here are the instrumentation for that class, and they live in
 * `src/` (not in a test file) so the test suite and `scripts/sweep.ts` measure
 * with one implementation rather than two that drift.
 *
 * ## The counts here are load-bearing history
 *
 * `findListOrphans` is the metric every number WP-2, WP-2b and WP-2c recorded was
 * measured with. It was moved here from `tests/render.test.ts` **unchanged** — if
 * you edit its body, every dated figure in the private archive's `measurements/`
 * silently stops being comparable, and because the numbers only ever go down, a
 * drift looks exactly like a fix. Add a new detector instead of loosening this one.
 *
 * ## Fenced code is exempt, opt-in
 *
 * Fences are never rewritten, so their shape is not ours to guarantee, and both
 * width gates exempt `codeRanges` for that reason. Both detectors take an optional
 * `codeRanges` and exempt those lines when it is supplied. It is **opt-in and
 * defaults to off** deliberately: passing it would change `findListOrphans`'
 * historical counts, and the guardrail on that function is that it does not move.
 * New callers (the regression tier) pass it; the WP-2 test suite does not.
 */
import { NARROW_MEASURE, type Measure } from "./width";

/** Inclusive 1-based `[startLine, endLine]` pairs, as `renderDocumentDetailed` returns. */
export type CodeRanges = Array<[number, number]>;

export interface DetectorOptions {
  /** When supplied, lines inside these ranges are not reported. See the module note. */
  codeRanges?: CodeRanges;
  /**
   * Display-width ruler (WP-3). **Defaults to `NARROW_MEASURE`, and that default is a
   * guardrail rather than a convenience**: every dated figure in the private archive's
   * `measurements/` was taken with the narrow ruler, and a detector that silently
   * measured wide because the machine's terminal happened to answer wide would move
   * those numbers with no code change to blame — the exact "a drift looks like a fix"
   * failure mode the freeze on `findListOrphans` exists to prevent. A caller grading a
   * *wide* render passes the wide measure explicitly and knows it is producing a
   * different series.
   */
  measure?: Measure;
}

// Deliberately matching the ESC control character to strip ANSI SGR codes, so a
// detector measures the text a reader sees rather than the escape bytes.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

/**
 * A rendered list marker line: at least two columns of indent, a bullet or an
 * ordered marker, then the item's text. The bullet class covers both glyph tiers
 * (`•◦‣` unicode, `-` ascii) plus the `*`/`+` the library can still emit.
 */
export const LIST_BULLET = /^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/;

/** Same, but capturing the full marker prefix so the item's text column is derivable. */
const LIST_MARKER_PREFIX = /^(\s{2,}(?:[•*\-◦‣+]|\d+\.)\s+)/;

/** A rendered line that is inside some list item — indented, and carrying text. */
export const isIndentedLine = (line: string): boolean => /^\s{2,}\S/.test(line);

const isExempt = (lineNumber: number, codeRanges: CodeRanges | undefined): boolean =>
  codeRanges !== undefined && codeRanges.some(([start, end]) => lineNumber >= start && lineNumber <= end);

/** One open list item on an innermost-last stack: where its marker sits, where its text starts. */
export interface OpenListItem {
  /** Display column the marker glyph itself sits at. */
  markerColumn: number;
  /** Display column the item's text starts at — where its continuations belong. */
  textColumn: number;
}

/**
 * Advance an innermost-last stack of open list items by one rendered line, and report
 * which item that line is a **continuation** of (`null` when it is not a continuation:
 * a blank line, a marker line, or a line that closed every open list).
 *
 * This is the one implementation of "which item does this rendered line belong to".
 * `findContinuationOverIndent` measures with it and `render.ts`'s re-alignment pass
 * (WP-2e) rewrites with it, deliberately: a detector and the fix it grades must not be
 * able to disagree about what an item's text column is.
 *
 * Callers pass ANSI-stripped lines and own the stack array, which is mutated in place.
 */
export function trackListLine(
  line: string,
  open: OpenListItem[],
  measure: Measure = NARROW_MEASURE,
): OpenListItem | null {
  if (line.trim() === "") return null; // a loose item's blank line does not close it

  const marker = LIST_MARKER_PREFIX.exec(line);
  if (marker) {
    const prefix = marker[1] as string;
    const markerColumn = measure(prefix.slice(0, prefix.length - prefix.trimStart().length));
    const textColumn = measure(prefix);
    // a marker at or left of the top of the stack closes every level it is not inside
    while (open.length > 0 && (open[open.length - 1] as OpenListItem).markerColumn >= markerColumn) {
      open.pop();
    }
    open.push({ markerColumn, textColumn });
    return null;
  }

  if (!isIndentedLine(line)) {
    open.length = 0; // back at column 0 with real text — every list is closed
    return null;
  }

  return open[open.length - 1] ?? null;
}

/**
 * Orphaned lines inside rendered list items — the WP-2/2b/2c metric, moved here
 * verbatim from `tests/render.test.ts`.
 *
 * An orphan is: a line inside a rendered list item that carries <= 2 words, whose
 * preceding line is nearly full (>= width - 10), and which is *followed by more
 * prose in the same item*. That last clause matters — without it the metric also
 * flags the natural short final line of any wrapped item (a tight item ending
 * "...being fixed."), which is not a defect and is present either way.
 *
 * **Known blind spot, do not "fix" it by loosening the metric.** `marked-terminal`
 * drops the blank line between two paragraphs of the same loose item
 * (`bulletPointLines`' `.filter(identity)`), so in rendered text a paragraph
 * boundary and a shear are the same shape and the first paragraph's short last line
 * reads as an orphan. No line-based metric can separate them; the multi-paragraph
 * case is asserted structurally instead, on its own inline source.
 *
 * Returns the trimmed text of each orphaned line, in document order.
 */
export function findListOrphans(rendered: string, width: number, options: DetectorOptions = {}): string[] {
  // The one WP-3 change to this frozen function: the ruler is now a parameter with the
  // historical value as its default, instead of a hardcoded `stringWidth` import. The
  // detection logic below is untouched — see `DetectorOptions.measure`.
  const measure = options.measure ?? NARROW_MEASURE;
  const lines = rendered.split("\n").map(stripAnsi);
  const orphans: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    // the bullet line itself has to be seen to open the list, so this runs from i = 0
    if (LIST_BULLET.test(line)) inList = true;
    else if (line.trim() !== "" && !isIndentedLine(line)) inList = false;

    if (i === 0) continue;
    if (!inList || line.trim() === "" || !isIndentedLine(line) || LIST_BULLET.test(line)) continue;
    if (isExempt(i + 1, options.codeRanges)) continue;

    const previous = lines[i - 1] as string;
    if (previous.trim() === "") continue;
    if (line.trim().split(/\s+/).filter(Boolean).length > 2) continue;
    if (measure(previous) < width - 10) continue;

    // must continue into more prose in the same item, not simply end it
    const next = lines[i + 1];
    if (next === undefined || next.trim() === "" || !isIndentedLine(next) || LIST_BULLET.test(next)) continue;

    orphans.push(line.trim());
  }
  return orphans;
}

export interface ContinuationOverIndent {
  /** 1-based line number in the rendered output. */
  line: number;
  /** Display column the continuation line's text actually starts at. */
  actualColumn: number;
  /** Display column its own item's first line starts its text at. */
  expectedColumn: number;
  /** `actualColumn - expectedColumn`, always >= 1. */
  drift: number;
  /** Trimmed text of the offending line, for a repro to be recognisable by. */
  text: string;
}

/**
 * Continuation lines indented deeper than their own item's text column.
 *
 * Mechanism (measured in WP-2c, promoted to WP-2e): each ancestor list level's
 * `bulletPointLines` adds 2 columns to a *non-marker* line before `indentLines`
 * adds 4, so a nested item's continuation lines drift 2-4 columns per level past
 * the column its own marker line started its text at. The visible symptom is both
 * the misalignment and the orphan it induces once the shallower pass re-splits the
 * now-over-budget line — which is why this is the dominant orphan source at the
 * user's real widths (64-72% of the width-116 residual) rather than a cosmetic nit.
 *
 * A well-formed item looks like this, every continuation at the marker's text column:
 *
 * ```text
 *     • first line of the item
 *       continuation at the same column
 * ```
 *
 * The detector is width-independent by construction — it compares two columns of the
 * same item against each other, not against a target — which is what makes it usable
 * as a dense-width-sweep signal without the width itself confounding the result.
 */
export function findContinuationOverIndent(rendered: string, options: DetectorOptions = {}): ContinuationOverIndent[] {
  const measure = options.measure ?? NARROW_MEASURE;
  const lines = rendered.split("\n").map(stripAnsi);
  const found: ContinuationOverIndent[] = [];
  // Innermost-last stack of open items, advanced by the shared `trackListLine` model.
  const open: OpenListItem[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    const item = trackListLine(line, open, measure);
    if (item === null) continue;
    if (isExempt(i + 1, options.codeRanges)) continue;

    const actualColumn = measure(line.slice(0, line.length - line.trimStart().length));
    if (actualColumn <= item.textColumn) continue;

    found.push({
      line: i + 1,
      actualColumn,
      expectedColumn: item.textColumn,
      drift: actualColumn - item.textColumn,
      text: line.trim(),
    });
  }

  return found;
}

/**
 * A rendered list marker sitting at **column 0** — the same marker shapes `LIST_BULLET`
 * recognizes, both glyph tiers, but with no indent in front of them at all.
 */
export const COLUMN_ZERO_MARKER = /^(?:[•*\-◦‣+]|\d+\.)\s/;

export interface ColumnZeroMarker {
  /** 1-based line number in the rendered output. */
  line: number;
  /** Trimmed text of the offending line, for a repro to be recognisable by. */
  text: string;
}

/**
 * List markers that escaped the block they belong to — WP-2g's instrument, and the only
 * one that can see that defect class at all.
 *
 * **A rendered list marker at column 0 is never correct output.** `marked-terminal`'s
 * `list` blanket-indents its whole composed body by `tab` before returning it, so the
 * shallowest marker this tool can emit sits at column 4, and one inside a blockquote at
 * column 8. A marker at column 0 therefore means some later pass moved the line left —
 * which is exactly what `wrapOverBudgetLines` did to every over-budget line of a
 * blockquote until WP-2g, re-wrapping it with no indent at all and putting the quoted
 * list's bullets outside the quote.
 *
 * **The two existing detectors are structurally blind to it.** `findListOrphans` and
 * `findContinuationOverIndent` both require `isIndentedLine`, so a line that collapsed
 * to column 0 is skipped by each of them — the fast tier cannot grade this class, and
 * removing the collapse makes previously invisible lines *newly* measurable, which reads
 * as an increase. Measured over the 95 corpus files that put a list inside a blockquote,
 * at widths 40/80/116/346: **471 hits across 62 files before, 4 across 1 after** — and
 * on the tier-pure sub-count (a `•`/`◦`/`‣` glyph, which only `substituteBullets` can
 * emit), **406 before and 0 after**.
 *
 * **The adjacency clause is what makes this countable rather than noise, and it is not
 * a free zero.** Authored prose legitimately starts a line with `-` or `1.` at column 0
 * — a numbered paragraph, a wrapped sentence beginning `2025.` — so the shape alone
 * reports 30 hits over 599 blockquote-free corpus files. Requiring the nearest non-blank
 * neighbour above or below (outside `codeRanges`, when those are supplied) to be
 * *indented* — i.e. the marker sits against content it has fallen out of — takes that to
 * 2, both of them the same authored numbered paragraph following a real list. **Pass
 * `codeRanges`**: without them an indented fenced block under an authored `1.` paragraph
 * reads as adjacency, which is the whole of the residual 4 above.
 */
export function findColumnZeroMarkers(rendered: string, options: DetectorOptions = {}): ColumnZeroMarker[] {
  const lines = rendered.split("\n").map(stripAnsi);
  const found: ColumnZeroMarker[] = [];

  const neighbour = (from: number, step: number): string | undefined => {
    for (let i = from + step; i >= 0 && i < lines.length; i += step) {
      if (isExempt(i + 1, options.codeRanges)) continue;
      const line = lines[i] as string;
      if (line.trim() !== "") return line;
    }
    return undefined;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (isExempt(i + 1, options.codeRanges)) continue;
    const line = lines[i] as string;
    if (!COLUMN_ZERO_MARKER.test(line)) continue;

    const before = neighbour(i, -1);
    const after = neighbour(i, 1);
    if (!(before !== undefined && isIndentedLine(before)) && !(after !== undefined && isIndentedLine(after))) continue;

    found.push({ line: i + 1, text: line.trim() });
  }

  return found;
}

/**
 * Does this rendered line belong to a table?
 *
 * Used to split width overflow into "the accepted-by-design many-column table case"
 * and everything else. **This classification is not cosmetic** — many-column tables
 * overflow below a width floor by arithmetic, decided at `plans/mdview.md:64` before
 * the tool was built, and a dense low-width sweep lights up every table-heavy note in
 * the corpus. Left unclassified they dominate the curve and a difficulty profile ends
 * up measuring table width instead of difficulty.
 */
export function isTableLine(line: string): boolean {
  const bare = stripAnsi(line);
  // box-drawing border row, or a body row with at least two column separators
  if (/^[\s]*[┌┬┐├┼┤└┴┘─╭╮╰╯]/.test(bare)) return true;
  if (/^[\s]*\+[-+]+\+\s*$/.test(bare)) return true;
  const separators = (bare.match(/[│|]/g) ?? []).length;
  return separators >= 2;
}
