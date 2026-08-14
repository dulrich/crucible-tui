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
 * ## The line primitives live next door, in `src/list-lines.ts`
 *
 * `stripAnsi`, the marker regexes, `isIndentedLine`, `OpenListItem` and `trackListLine`
 * were this module's until WP-5 of `plans/tn-review-remediation.md`. They are production
 * code — `src/render.ts`'s re-alignment pass rewrites with `trackListLine` while
 * `findContinuationOverIndent` below grades that pass with the same function — so they
 * moved to a module `render.ts` can import without also importing this one, which puts a
 * second `Marked` instantiation, the block-end probe and the shear classifier into the
 * import graph the shipped binary is compiled from — a cohesion win, **not** a size one:
 * the bundler tree-shakes nearly all of it, and the measured delta is 151 bytes on a
 * 2.68 MB bundle (`src/list-lines.ts` records the measurement). **They were relocated,
 * not copied**: a detector and the fix it
 * measures must not be able to disagree about where an item's text column is, and no gate
 * here could see them drift apart. Import them from `./list-lines`; do not re-declare one.
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
 *
 * ## `findShearOrphans` is the additive answer to that freeze
 *
 * WP-8 adds a second orphan reading rather than changing the first. It takes the same
 * candidate set `findListOrphans` reports and labels each hit `shear`,
 * `paragraph-boundary`, `block-boundary` or `unmapped`, using knowledge the rendered
 * string does not contain — see `probeBlockEnds`. Both readings are published side by
 * side; neither replaces the other.
 */
import { Marked, type Token, type Tokens } from "marked";
import { splitFrontmatter } from "./frontmatter";
import { NARROW_MEASURE, type Measure } from "./width";
import { isLineExempt, type CodeRanges } from "./overflow";
import {
  LIST_BULLET,
  isIndentedLine,
  stripAnsi,
  trackListLine,
  type OpenListItem,
} from "./list-lines";

// `CodeRanges` moved to `src/overflow.ts` with the exemption predicate itself (WP-2) and
// is re-exported here so this module's existing surface is unchanged.
export type { CodeRanges };

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

/**
 * The detector-side adapter over the one exemption predicate (`src/overflow.ts`'s
 * `isLineExempt`). The `undefined` case is **this module's** API, not the predicate's:
 * `DetectorOptions.codeRanges` is opt-in and defaults to off (see the module note
 * above), because supplying it would move `findListOrphans`' historical counts — so
 * here, and only here, "no ranges given" has to mean "exempt nothing". Both width gates
 * always have ranges to pass and call `isLineExempt` directly.
 */
const isExempt = (lineNumber: number, codeRanges: CodeRanges | undefined): boolean =>
  codeRanges !== undefined && isLineExempt(lineNumber, codeRanges);

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

/* ------------------------------------------------------------------------------------ *
 * WP-8 — separating a genuine shear from the documented blind spot
 *
 * `findListOrphans` above is handed only the rendered string, and by then the one fact
 * that would settle the question is gone: whether a short line inside a list item is the
 * *last line of a block* (a paragraph ending, which is not a defect) or a line in the
 * *middle* of one (a shear, which is). `marked-terminal` drops the blank line between two
 * paragraphs of the same loose item, so both shapes render identically.
 *
 * The `marked` token stream knows the difference. Getting that knowledge onto a rendered
 * *line number* is the whole problem, and it is solved here by a probe-and-align pass:
 * mark the source, render it a second time, and locate the marks in the render.
 * ------------------------------------------------------------------------------------ */

/**
 * The probe characters. Built with `String.fromCharCode` rather than written as literal
 * bytes, the same way `render.ts`'s `SENTINEL` is and for the same reason: an embedded
 * control byte in a checked-in source file is the hazard, not the runtime character.
 */
const PROBE_PARAGRAPH = String.fromCharCode(17);
const PROBE_BLOCK = String.fromCharCode(18);

/**
 * Where on a source line a probe may be inserted, scanning right to left. Every clause is
 * something that must stay attached to the end of the line:
 *
 * - trailing whitespace, a `\` or a `<br>` — the three hard-break spellings;
 * - an ATX closing sequence (`## Title ##`);
 * - a run of inline **closing** delimiters. This one is load-bearing and was found the
 *   hard way: `marked` requires a closing `**` to be followed by whitespace, punctuation
 *   or end-of-input, and a control character is none of those, so a probe placed after it
 *   turns `**bold**` into four literal asterisks. `)` is deliberately *not* in the class —
 *   a probe placed *before* a link's closing paren lands inside the href and invalidates
 *   the link instead, which is the same failure from the other side.
 */
const PROBE_TRAILER = /[*_~`]*(?:\s+#+)?(?:\\|<br\s*\/?>)?\s*$/i;

/** Block tokens whose last rendered line is reflowed prose. */
const PROSE_BLOCKS = new Set(["paragraph", "text", "heading"]);

/** A setext heading's last source line is its `===` rule; a probe there would defeat it. */
const SETEXT_RULE = /^[=-]+$/;

const countNewlines = (value: string): number => {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) === 10) count += 1;
  return count;
};

/**
 * Plan a probe per prose block, by **line index**, walking `marked`'s block tokens.
 *
 * Two properties of `marked`'s tokens dictate the shape of this walk, and both were
 * established against the pinned version rather than assumed:
 *
 * 1. **A block token's `raw` inside a list item is not a faithful copy of the source.**
 *    An item's children are lexed with `state.top` false, where the `text` tokenizer
 *    joins continuation lines with a *doubled* newline — a two-line item yields a `raw`
 *    carrying two `\n`. Counting newlines across those raws gives nonsense. So each
 *    container is re-lexed from its own de-indented `text` at top level, where the same
 *    content comes back as `paragraph` tokens whose `raw` *is* faithful. De-indenting
 *    never adds or removes a line, so line offsets survive the round trip.
 * 2. **Sibling raws do not always concatenate back to the container.** `Tokenizer.list`
 *    trims the trailing newlines off both the list and its final item. So each token is
 *    located by searching forward for its own `raw` rather than by summing the ones
 *    before it, which makes the walk self-correcting at every step.
 *
 * Only prose that renders **indented** is marked (inside a list item or a blockquote, at
 * any depth). A top-level paragraph renders at column 0, where `isIndentedLine` means no
 * orphan candidate can land on it, so probing one would be pure perturbation risk.
 */
function planProbes(text: string, lineOffset: number, marks: Map<number, string>, indented: boolean): void {
  const tokens = new Marked().lexer(text) as Token[];
  const meaningful = tokens.filter((token) => token.type !== "space");
  let consumed = 0;
  for (const token of tokens) {
    const raw = token.raw ?? "";
    const at = raw === "" ? consumed : text.indexOf(raw, consumed);
    if (at === -1) return; // lost the thread: mark nothing rather than mark the wrong line
    const startLine = lineOffset + countNewlines(text.slice(0, at));
    consumed = at + raw.length;

    if (indented && PROSE_BLOCKS.has(token.type)) {
      const trimmed = raw.replace(/\s+$/, "");
      const tail = trimmed.split("\n").pop() ?? "";
      if (!SETEXT_RULE.test(tail)) {
        const next = meaningful[meaningful.indexOf(token) + 1];
        marks.set(
          startLine + countNewlines(trimmed),
          next !== undefined && PROSE_BLOCKS.has(next.type) ? PROBE_PARAGRAPH : PROBE_BLOCK,
        );
      }
    } else if (token.type === "list") {
      let itemConsumed = at;
      for (const item of (token as Tokens.List).items) {
        const itemRaw = item.raw ?? "";
        const itemAt = text.indexOf(itemRaw, itemConsumed);
        if (itemAt === -1) break;
        itemConsumed = itemAt + itemRaw.length;
        planProbes(item.text ?? "", lineOffset + countNewlines(text.slice(0, itemAt)), marks, true);
      }
    } else if (token.type === "blockquote") {
      planProbes((token as Tokens.Blockquote).text ?? "", startLine, marks, true);
    }
  }
}

/**
 * A copy of `source` with a zero-width probe at the end of every indented prose block.
 *
 * Render this *and* the original at the same width and hand both to `readBlockEnds`.
 * Frontmatter is split off untouched — a probe inside it would reach the YAML parser.
 *
 * **Marking more than the loose multi-paragraph case is deliberate.** A hit on a marked
 * line is never reported as a shear, so over-marking can only move a hit *out* of the
 * `shear` bucket. For a predicate that goes on to select a corpus, that is the direction
 * to err in.
 */
export function probeBlockEnds(source: string): string {
  const { body } = splitFrontmatter(source);
  const prefix = source.slice(0, source.length - body.length);
  const marks = new Map<number, string>();
  planProbes(body, 0, marks, false);
  const lines = body.split("\n");
  for (const [index, probe] of marks) {
    const line = lines[index];
    if (line === undefined) continue;
    const cut = (PROBE_TRAILER.exec(line) as RegExpExecArray).index;
    lines[index] = line.slice(0, cut) + probe + line.slice(cut);
  }
  return prefix + lines.join("\n");
}

/** Which kind of block ends on a rendered line. */
export type BlockEndKind = "paragraph" | "block";

export interface BlockEnds {
  /** 1-based rendered line number -> the kind of block that ends there. */
  ends: Map<number, BlockEndKind>;
  /**
   * Whether the alignment invariant held for this document. When false, every orphan in
   * it is reported `unmapped` — the honest answer — rather than guessed at.
   */
  mapped: boolean;
}

/**
 * Locate each probe's rendered line by **aligning the visible character streams**.
 *
 * A line-for-line comparison of the two renders does not work and cannot be made to:
 * `marked-terminal` reflows paragraphs by `.length`, so the probe — invisible to every
 * display-width ruler in this repo, `NARROW_MEASURE` included — is still one character to
 * the library, and it can push a block's final word onto a line of its own. The probed
 * render is legitimately *not* byte-identical to the plain one.
 *
 * What reflow cannot do is add, drop or reorder a visible character; it only decides where
 * the whitespace goes. So count non-whitespace characters instead of lines: the *n*th
 * visible character is the same character in both renders, and the probe sits immediately
 * after its block's last one. `mapped` reports that invariant, checked per document —
 * measured over the three vendored strata it holds for all but the handful of files where
 * `marked`'s own `raw` values do not reconstruct the source.
 */
export function readBlockEnds(plain: string, probed: string): BlockEnds {
  const ends = new Map<number, BlockEndKind>();
  const hits: Array<{ count: number; kind: BlockEndKind }> = [];
  let probedVisible = "";
  for (const char of stripAnsi(probed)) {
    if (char === PROBE_PARAGRAPH || char === PROBE_BLOCK) {
      hits.push({ count: probedVisible.length, kind: char === PROBE_PARAGRAPH ? "paragraph" : "block" });
      continue;
    }
    if (!/\s/.test(char)) probedVisible += char;
  }

  // For every visible character of the plain render, the line it landed on.
  const lineOf: number[] = [];
  let plainVisible = "";
  let line = 1;
  for (const char of stripAnsi(plain)) {
    if (char === "\n") line += 1;
    else if (!/\s/.test(char)) {
      plainVisible += char;
      lineOf.push(line);
    }
  }

  // The characters themselves, not merely how many: a probe that defeated an inline rule
  // — a closing `**` no longer recognized, a link href invalidated — changes *which*
  // characters render, and comparing counts alone could let that through on a document
  // where two such changes cancelled out.
  if (plainVisible !== probedVisible) return { ends, mapped: false };
  for (const hit of hits) {
    const at = lineOf[hit.count - 1];
    if (at === undefined) continue;
    // A paragraph boundary is the stronger reading of a line: it never loses to `block`.
    if (ends.get(at) !== "paragraph") ends.set(at, hit.kind);
  }
  return { ends, mapped: true };
}

/** What a `findListOrphans` hit turned out to be. */
export type OrphanKind = "shear" | "paragraph-boundary" | "block-boundary" | "unmapped";

export interface ClassifiedOrphan {
  /** 1-based line number in the rendered output. */
  line: number;
  /** Trimmed text of the line — the same string `findListOrphans` reports for this hit. */
  text: string;
  kind: OrphanKind;
  /**
   * Widest whitespace-free run, in display columns, across the hit and its two
   * neighbours. **A shape signal, not a severity score**, and the one WP-9 needs: 1,748
   * of the 2,837 genuine shears (62%) sit beside a token that does not fit the item's
   * budget at all — a bare URL, a reference-style image label — where the break was
   * forced rather than chosen. A corpus selected without splitting on this would take a
   * hundred link-list READMEs and count them as a hundred distinct defects. The
   * remaining 1,089 are ordinary reflow shears, a short word stranded mid-paragraph.
   *
   * **Post-WP-14 (measured at sprint close): 1,373 of 2,417 shears, 56.8%.** The collapse
   * the sprint expected did not happen — parsing an item's inline markup splits
   * `[label](url)` into two runs but does not shorten the URL, and reference links and
   * autolinked emails *add* long tokens that were invisible while the source sat unparsed.
   * The distribution barely moved (mean 74.1 -> 73.1 columns, p90 94 either side). WP-9's
   * own harness derives 1,419 rather than 1,373 for the same threshold; the figure is
   * threshold-invariant across -0..-5 columns so no conclusion turns on it, and the
   * disagreement is recorded rather than resolved.
   */
  longestToken: number;
}

/**
 * Every `findListOrphans` hit, labelled.
 *
 * **The candidate walk below is a deliberate line-numbered clone of the frozen
 * function's**, not a variation on it: `findListOrphans` returns bare strings, and a hit
 * has to be tied to a line number before a token can be matched to it. The invariant that
 * makes the two readings comparable — same candidates, only labelled — is asserted in
 * `tests/detectors.test.ts` rather than left to inspection. If a change here makes the
 * candidate sets diverge, that test fails; the frozen counts do not move either way.
 */
export function classifyListOrphans(
  rendered: string,
  width: number,
  blockEnds: BlockEnds,
  options: DetectorOptions = {},
): ClassifiedOrphan[] {
  const measure = options.measure ?? NARROW_MEASURE;
  const lines = rendered.split("\n").map(stripAnsi);
  const found: ClassifiedOrphan[] = [];
  let inList = false;

  const widestRun = (index: number): number => {
    let widest = 0;
    for (let i = Math.max(0, index - 1); i <= Math.min(lines.length - 1, index + 1); i += 1) {
      for (const run of (lines[i] as string).trim().split(/\s+/)) {
        const runWidth = measure(run);
        if (runWidth > widest) widest = runWidth;
      }
    }
    return widest;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    if (LIST_BULLET.test(line)) inList = true;
    else if (line.trim() !== "" && !isIndentedLine(line)) inList = false;

    if (i === 0) continue;
    if (!inList || line.trim() === "" || !isIndentedLine(line) || LIST_BULLET.test(line)) continue;
    if (isExempt(i + 1, options.codeRanges)) continue;

    const previous = lines[i - 1] as string;
    if (previous.trim() === "") continue;
    if (line.trim().split(/\s+/).filter(Boolean).length > 2) continue;
    if (measure(previous) < width - 10) continue;

    const next = lines[i + 1];
    if (next === undefined || next.trim() === "" || !isIndentedLine(next) || LIST_BULLET.test(next)) continue;

    const at = blockEnds.ends.get(i + 1);
    const kind: OrphanKind = !blockEnds.mapped
      ? "unmapped"
      : at === "paragraph"
        ? "paragraph-boundary"
        : at === "block"
          ? "block-boundary"
          : "shear";
    found.push({ line: i + 1, text: line.trim(), kind, longestToken: widestRun(i) });
  }
  return found;
}

/**
 * The orphans that are **layout faults**: a short line in the middle of a block, not the
 * last line of one.
 *
 * What it deliberately does not flag: the last line of a loose item's first paragraph
 * (`paragraph-boundary` — the documented blind spot, and the thing this WP was built to
 * subtract), the last line of any other block inside an item (`block-boundary` — a
 * paragraph before a fence, a nested list, a table), and anything in a document whose
 * probe did not align (`unmapped`, reported rather than assumed either way).
 *
 * **Measured, and it is not what the sprint expected.** Over the three vendored strata at
 * the five swept widths — 479 files, 2,395 file-widths, 3,223 hits — the split is 2,837
 * `shear`, 144 `paragraph-boundary`, 242 `block-boundary`, **0 `unmapped`**. The blind spot
 * is 4.5% of the metric, not the bulk of it, and the reason is simply that the material does
 * not contain the construct: 533 loose multi-paragraph item boundaries against 32,614
 * indented prose-block ends. Subtracting it moves the per-stratum firing rate from
 * 37%/49%/56% of files to 36%/44%/55%. That rate is a fact about link-dense list items —
 * see `ClassifiedOrphan.longestToken` — not about loose items.
 *
 * **The `0 unmapped` above is a pre-WP-14 reading and no longer holds.** Once list items
 * began parsing their inline tokens, `readBlockEnds`' probe became defeatable *inside* an
 * item, so the same pool now yields 49 `unmapped` hits over 7 file-width combos in 2 files.
 * Re-measured at sprint close: **2,817 hits — 2,417 `shear`, 128 `paragraph-boundary`,
 * 223 `block-boundary`, 49 `unmapped`**, with 175 files firing at least one shear (was
 * 215). Every conclusion above survives the re-measurement; only the absolute counts moved.
 * The `unmapped` bucket is doing its job — reporting non-alignment instead of guessing a
 * label — and closing it is this detector's own follow-up, not a caller's problem.
 */
export function findShearOrphans(
  rendered: string,
  width: number,
  blockEnds: BlockEnds,
  options: DetectorOptions = {},
): ClassifiedOrphan[] {
  return classifyListOrphans(rendered, width, blockEnds, options).filter((hit) => hit.kind === "shear");
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
