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
import stringWidth from "string-width";

/** Inclusive 1-based `[startLine, endLine]` pairs, as `renderDocumentDetailed` returns. */
export type CodeRanges = Array<[number, number]>;

export interface DetectorOptions {
  /** When supplied, lines inside these ranges are not reported. See the module note. */
  codeRanges?: CodeRanges;
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
    if (stringWidth(previous) < width - 10) continue;

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
  const lines = rendered.split("\n").map(stripAnsi);
  const found: ContinuationOverIndent[] = [];
  // Innermost-last stack of open items: the column their marker sits at, and the
  // column their text starts at.
  const open: Array<{ markerColumn: number; textColumn: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    if (line.trim() === "") continue; // a loose item's blank line does not close it

    const marker = LIST_MARKER_PREFIX.exec(line);
    if (marker) {
      const prefix = marker[1] as string;
      const markerColumn = stringWidth(prefix.slice(0, prefix.length - prefix.trimStart().length));
      const textColumn = stringWidth(prefix);
      // a marker at or left of the top of the stack closes every level it is not inside
      while (open.length > 0 && (open[open.length - 1] as { markerColumn: number }).markerColumn >= markerColumn) {
        open.pop();
      }
      open.push({ markerColumn, textColumn });
      continue;
    }

    if (!isIndentedLine(line)) {
      open.length = 0; // back at column 0 with real text — every list is closed
      continue;
    }

    const item = open[open.length - 1];
    if (item === undefined) continue;
    if (isExempt(i + 1, options.codeRanges)) continue;

    const actualColumn = stringWidth(line.slice(0, line.length - line.trimStart().length));
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
