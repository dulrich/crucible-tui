import type { Token, Tokens } from "marked";
import type { GlyphSet } from "./glyphs";
import { type SgrMode } from "./colour";
import { type StyleName, applyStyle, applyStyleChain, createStyler } from "./style";
import { type Align, padToWidth, splitToken } from "./text";
import { NARROW_MEASURE, type Measure } from "./width";
import { WIKI_LINK_STYLES, type WikiLinkToken } from "./wikilink";

/**
 * The wide-table allocator — the reason `mdview` exists.
 *
 * 43% of this repo's 4,550 markdown table rows are wider than 120 columns and the
 * widest is 1,646. Every surveyed renderer fails one of three ways: it overflows
 * (`lowdown`, `marked-terminal`), it ellipsizes (`rich-cli`, `cli-table3`'s own
 * truncation), or it starves a column to zero width (`glow` #941). This module makes
 * all three structurally impossible:
 *
 * - overflow  — column widths are allocated against an exactly-derived budget;
 * - loss      — over-long tokens are hard-split by display width, never ellipsized;
 * - collapse  — every column is held at or above a floor, or the table is declared
 *               infeasible and rendered at its minimum feasible width instead.
 *
 * Everything here is pure: no I/O, no globals, no `process.stdout`.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Table geometry, stated once so the chrome budget is derived rather than guessed.
 * These values are consumed by both the allocator and the emitter below, which is
 * what keeps the two from disagreeing.
 *
 * A rendered table line looks like:
 *
 *     │ cell │ cell │ cell │
 *     ^ ^  ^ ^                 border, pad-left, content, pad-right, border...
 *
 * so for an N-column table there are N+1 vertical rules and N pairs of padding —
 * `chromeWidth` is `3N + 1`, and every glyph in either tier is exactly 1 display
 * column under narrow measurement, so the arithmetic holds for both.
 *
 * Critically, a *cell* width INCLUDES its padding while an allocated *content* width
 * does not; treating one as the other is the +2-per-column overshoot that the
 * prototype of this allocator shipped, and `tests/table-emission.test.ts` still asserts
 * `maxWidth(output) !== target + 2` because of it. `cellWidth()` is the only place
 * that conversion happens.
 */
const PADDING_LEFT = 1;
const PADDING_RIGHT = 1;
const BORDER_COLUMNS = 1;

/** Per-column content floor. No column may be narrower than this while shrinking. */
export const MIN_COLUMN_WIDTH = 6;

/**
 * Hard lower bound on a cell width. A content width of 0 is not merely ugly: the
 * emitter's rule rows are drawn from the *cell* width and its content rows from the
 * content width plus padding, and a wrapped line can never be narrower than one
 * grapheme, so a zero-width column would let a single character push its own row
 * wider than the rule above it and misalign the whole table.
 */
const ABSOLUTE_MIN_COLUMN_WIDTH = 1;

/** Display columns consumed by borders and padding for an N-column table. */
export function chromeWidth(columnCount: number): number {
  if (columnCount <= 0) return 0;
  const verticalRules = columnCount + 1;
  return verticalRules * BORDER_COLUMNS + columnCount * (PADDING_LEFT + PADDING_RIGHT);
}

/** Convert an allocated content width to the full cell width, padding included. */
function cellWidth(contentWidth: number): number {
  return contentWidth + PADDING_LEFT + PADDING_RIGHT;
}

// ---------------------------------------------------------------------------
// Cell text: markdown tokens -> plain text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/** Undo the five entities `marked` escapes in inline `text` tokens. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (match) => ENTITIES[match] ?? match);
}

/**
 * One styled run inside a cell's finished text — the span-cell contract's unit.
 *
 * `start`/`end` are **UTF-16 code-unit indices into the final normalized cell text**,
 * half-open, and every span in a `CellContent` is non-overlapping and ascending.
 * `styles` is an ordered chain of names already in the committed style table
 * (`src/style.ts`) — outermost first, exactly the order `createStyler` accumulates — so a
 * wiki-link label's span is `["cyan", "underline"]`, the same chain `WIKI_LINK_STYLE`
 * composes. **No new style vocabulary**: a span can only ask for a style this renderer
 * is already authorized to emit.
 */
export interface CellSpan {
  readonly start: number;
  readonly end: number;
  readonly styles: readonly StyleName[];
}

/**
 * A cell's finished text plus the styling it owes — the value the cell pipeline carries.
 *
 * The contract this replaces said "no ANSI inside cells" flat out. That is still true of
 * **measurement and splitting** and always must be: `naturalWidths`, `wrapText` and
 * `splitToken` all operate on `text` alone, and splitting a string that carries escape
 * sequences risks cutting inside a sequence or dropping a reset, which would corrupt both
 * the colours and the alignment. What changed is *where* styling may happen — at
 * **emission**, per fragment, against offsets recorded here — so a styled cell can exist
 * without any pass ever having to measure or split a byte of SGR.
 *
 * `spans` is empty for every cell this repo produces today; the producer is WP-2's.
 */
export interface CellContent {
  readonly text: string;
  readonly spans: readonly CellSpan[];
}

/** Pre-normalization text and spans, in raw walk coordinates. */
interface RawCell {
  readonly text: string;
  readonly spans: readonly CellSpan[];
}

const plainCell = (text: string): RawCell => ({ text, spans: [] });

/** Concatenate walk results, rebasing each part's spans onto the joined string. */
function concatCells(parts: RawCell[]): RawCell {
  if (parts.length === 1) return parts[0] as RawCell;
  let text = "";
  const spans: CellSpan[] = [];
  for (const part of parts) {
    const base = text.length;
    for (const span of part.spans) {
      spans.push({ start: span.start + base, end: span.end + base, styles: span.styles });
    }
    text += part.text;
  }
  return { text, spans };
}

/**
 * The flatten walk itself: inline tokens down to raw text plus raw-coordinate spans.
 *
 * Emphasis markers are unwrapped, code spans lose their backticks, and a link keeps both
 * its label and its href so no content is discarded — all exactly as before. **Children
 * are flattened rather than dispatched**, which is the rule the wiki-link span producer
 * (WP-2) inherits: a label's children flatten to plain text like `strong`/`em`/`del`/link
 * children already do, and the only span a label contributes is its own outer chain. That
 * is what keeps cells free of nested SGR and of OSC-8.
 *
 * Recursive, and deliberately **not** normalizing: collapsing whitespace per level would
 * trim interior spaces at every nesting boundary. Normalization happens once, at the top,
 * in `flattenInline`.
 */
function walkInline(tokens: Token[] | undefined, fallback: string): RawCell {
  if (!tokens || tokens.length === 0) return plainCell(decodeEntities(fallback));

  return concatCells(
    tokens.map((token): RawCell => {
      switch (token.type) {
        case "text":
        case "escape":
        case "codespan":
        case "html":
          return plainCell(decodeEntities(token.text ?? ""));
        case "strong":
        case "em":
        case "del":
          return walkInline(token.tokens, token.text ?? "");
        case "link": {
          const label = walkInline(token.tokens, token.text ?? "");
          const href = token.href ?? "";
          if (href === "" || href === label.text) return label;
          return concatCells([label, plainCell(` (${href})`)]);
        }
        case "image":
          return plainCell(decodeEntities(token.text ?? ""));
        case "br":
          return plainCell(" ");
        case "wikilink": {
          // **The span producer** (WP-2 of `plans/wiki-link-tokenizer.md`). Locked decision
          // D3 keeps a cell's wiki-link styled — it is a navigation target — and cycle-3 f3
          // fixed *how*: the label's children are flattened here, by this walk, exactly as
          // `strong`/`em`/`del`/link children already are, and the only span the label
          // contributes is its own outer chain. That is what keeps a cell free of nested SGR
          // and of OSC-8: `renderLink` is unreachable from here, so a URL-shaped label
          // flattens to its own text rather than emitting a hyperlink into a cell that
          // `splitToken` would then have to split.
          //
          // The `embed: ` prefix sits **outside** the span, matching the prose visitor, and
          // the span is recorded in *raw* coordinates — `normalizeCell` carries it through
          // the collapse and trim, so a label's boundary whitespace normalizes like every
          // other cell's (grant C6b; the carriers used to fence it, which is an artifact
          // nothing here can reproduce).
          //
          // **The span covers the label's *content*, not its authored padding.** A label's
          // own leading and trailing whitespace is about to be collapsed or trimmed away, and
          // if the span still claimed it, one such space merging with the *neighbouring*
          // text's whitespace would leave the survivor styled — a stray styled space, visible
          // in the bytes and in nothing else. Trimming here is also what makes a
          // whitespace-only label contribute no span at all rather than a degenerate one.
          const wiki = token as unknown as WikiLinkToken;
          const label = walkInline(wiki.tokens, wiki.alias ?? wiki.slug);
          const lead = label.text.length - label.text.trimStart().length;
          const tail = label.text.trimEnd().length;
          const styled: RawCell = {
            text: label.text,
            spans: lead >= tail ? [] : [{ start: lead, end: tail, styles: WIKI_LINK_STYLES }],
          };
          return wiki.embed ? concatCells([plainCell("embed: "), styled]) : styled;
        }
        default: {
          const nested = "tokens" in token ? (token.tokens as Token[] | undefined) : undefined;
          if (nested && nested.length > 0) return walkInline(nested, token.raw ?? "");
          return plainCell(decodeEntities("text" in token ? (token.text ?? "") : (token.raw ?? "")));
        }
      }
    }),
  );
}

/** One `\s` in JS's own vocabulary — the class `/\s+/` collapses on. */
const WHITESPACE = /\s/;

/**
 * `text.replace(/\s+/g, " ").trim()`, carrying the spans through it.
 *
 * This is the normalization `cellText` used to apply *after* flattening, moved into the
 * flatten so `CellContent.text` is already-final and offsets mean something. It is the
 * same collapse and the same trim, reproduced rather than reinterpreted: every whitespace
 * run becomes exactly one ASCII space and the result is trimmed once, so for a cell with
 * no spans the text is byte-identical to what the two-step form produced.
 *
 * **Wiki labels normalize like every other cell text**, which is a behaviour change WP-2
 * lands and this function is written for: the carrier bytes were non-whitespace and
 * therefore acted as barriers to the collapse, so `| [[ b ]] |` kept its boundary spaces.
 * Nothing here knows about carriers, so nothing here can reproduce that artifact.
 */
function normalizeCell(raw: RawCell): CellContent {
  const source = raw.text;
  // `positions[i]` is where raw index `i` lands in the collapsed string. Every index of a
  // whitespace run after its first maps *past* the space the run became, so a span that
  // ends inside a run still contains it.
  const positions = new Array<number>(source.length + 1);
  let collapsed = "";
  let index = 0;
  while (index < source.length) {
    if (WHITESPACE.test(source.charAt(index))) {
      positions[index] = collapsed.length;
      index += 1;
      collapsed += " ";
      while (index < source.length && WHITESPACE.test(source.charAt(index))) {
        positions[index] = collapsed.length;
        index += 1;
      }
      continue;
    }
    positions[index] = collapsed.length;
    collapsed += source.charAt(index);
    index += 1;
  }
  positions[source.length] = collapsed.length;

  const lead = collapsed.length - collapsed.trimStart().length;
  const tail = collapsed.trimEnd().length;
  const text = lead >= tail ? "" : collapsed.slice(lead, tail);

  if (raw.spans.length === 0) return { text, spans: [] };

  const clamp = (at: number): number => Math.min(Math.max((positions[at] ?? 0) - lead, 0), text.length);
  const spans: CellSpan[] = [];
  for (const span of raw.spans) {
    const start = clamp(span.start);
    const end = clamp(span.end);
    if (start < end) spans.push({ start, end, styles: span.styles });
  }
  return { text, spans };
}

/**
 * Flatten a cell's inline token stream to its finished text and the spans over it.
 *
 * Returned `text` is **already normalized** — entity-decoded, whitespace-collapsed and
 * trimmed — which is the whole point: an offset is only meaningful against the string the
 * emitter will actually pad and split.
 */
export function flattenInline(tokens: Token[] | undefined, fallback: string): CellContent {
  return normalizeCell(walkInline(tokens, fallback));
}

/** Finished content for one table cell. */
export function cellText(cell: Tokens.TableCell): CellContent {
  return flattenInline(cell.tokens, cell.text ?? "");
}

export interface TableGrid {
  header: CellContent[];
  rows: CellContent[][];
  aligns: Align[];
  columnCount: number;
}

const EMPTY_CELL: CellContent = { text: "", spans: [] };

/** Extract a rectangular grid of cell content plus per-column alignment. */
export function tableGrid(token: Tokens.Table): TableGrid {
  const header = token.header.map(cellText);
  const rawRows = token.rows.map((row) => row.map(cellText));
  const columnCount = Math.max(header.length, ...rawRows.map((row) => row.length), 0);

  const pad = (row: CellContent[]): CellContent[] =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? EMPTY_CELL);

  const aligns = Array.from({ length: columnCount }, (_, index) => token.align[index] ?? "left");

  return { header: pad(header), rows: rawRows.map(pad), aligns, columnCount };
}

// ---------------------------------------------------------------------------
// Step 1 — natural widths
// ---------------------------------------------------------------------------

/**
 * Widest cell per column, measured with the resolved `Measure` (`src/width.ts`) so CJK
 * (2 columns per character) and emoji are counted in display columns rather than code
 * units, and so East Asian Ambiguous characters are counted the way the terminal this
 * render is destined for actually draws them.
 *
 * **It reads `text` and nothing else.** A cell's spans are styling, styling is emitted
 * last and only ever inserts zero-width escape bytes, so measurement is exactly the
 * question it always was and its answer cannot move when a span appears.
 */
export function naturalWidths(
  header: readonly CellContent[],
  rows: readonly (readonly CellContent[])[],
  measure: Measure = NARROW_MEASURE,
): number[] {
  return header.map((cell, index) => {
    let widest = measure(cell.text);
    for (const row of rows) {
      const width = measure(row[index]?.text ?? "");
      if (width > widest) widest = width;
    }
    return Math.max(ABSOLUTE_MIN_COLUMN_WIDTH, widest);
  });
}

// ---------------------------------------------------------------------------
// Step 2/3 — budget and allocation
// ---------------------------------------------------------------------------

export interface Allocation {
  /** Content width per column, excluding padding and borders. */
  widths: number[];
  /** Total rendered width including all chrome. */
  totalWidth: number;
  /**
   * `false` only in the sanctioned-overflow case: the table cannot fit inside
   * `targetWidth` even with every column at its floor (a 9-column table needs
   * 9*6 + 28 = 82 columns at an 80-column target). The caller still gets the
   * minimum feasible layout — never a throw, never a dropped column.
   */
  fits: boolean;
}

/** Per-column floor: `MIN_COLUMN_WIDTH`, or the natural width if it is already smaller. */
function floorWidths(natural: number[]): number[] {
  return natural.map((width) =>
    Math.max(ABSOLUTE_MIN_COLUMN_WIDTH, Math.min(width, MIN_COLUMN_WIDTH)),
  );
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Distribute `total` integer columns across `weights` in proportion, using the
 * largest-remainder method so the parts sum to exactly `total`.
 */
function proportionalShares(weights: number[], total: number): number[] {
  if (weights.length === 0) return [];
  const weightTotal = sum(weights);
  if (weightTotal <= 0 || total <= 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (weight * total) / weightTotal);
  const shares = exact.map((value) => Math.floor(value));
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  let remainder = total - sum(shares);
  for (const entry of order) {
    if (remainder <= 0) break;
    shares[entry.index] = (shares[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return shares;
}

/**
 * Mark the columns that are *not* over budget. A column is left at its natural
 * width whenever that width is no larger than an equal share of what is still
 * unclaimed. Removing those columns raises the share for everyone else, so the
 * pass repeats to a fixpoint — that is what stops a 3-character `WP` column from
 * being shrunk to make room for a 200-character prose column.
 */
function keepNaturalColumns(natural: number[], budget: number): boolean[] {
  const keep = natural.map(() => false);
  for (;;) {
    const flexible: number[] = [];
    let claimed = 0;
    natural.forEach((width, index) => {
      if (keep[index]) claimed += width;
      else flexible.push(index);
    });
    if (flexible.length === 0) break;

    const fairShare = (budget - claimed) / flexible.length;
    const newlyKept = flexible.filter((index) => (natural[index] ?? 0) <= fairShare);
    if (newlyKept.length === 0) break;
    for (const index of newlyKept) keep[index] = true;
  }
  return keep;
}

/**
 * Allocate content widths.
 *
 * 1. Fits already? Use natural widths verbatim — never reflow a table that fits.
 * 2. Infeasible even at the floor? Return the floors and report `fits: false`.
 * 3. Otherwise hold the under-budget columns at their natural width and share the
 *    remaining budget across the over-budget columns in proportion to their natural
 *    widths (i.e. one uniform shrink ratio), then lift anything below the floor back
 *    up to it and reclaim the difference from the widest columns still above theirs.
 */
export function allocateWidths(natural: number[], targetWidth: number): Allocation {
  const columnCount = natural.length;
  if (columnCount === 0) return { widths: [], totalWidth: 0, fits: true };

  const chrome = chromeWidth(columnCount);
  const budget = targetWidth - chrome;
  const finish = (widths: number[]): Allocation => {
    const totalWidth = sum(widths) + chrome;
    return { widths, totalWidth, fits: totalWidth <= targetWidth };
  };

  if (sum(natural) <= budget) return finish(natural.slice());

  const floors = floorWidths(natural);
  if (sum(floors) > budget) return finish(floors);

  const keep = keepNaturalColumns(natural, budget);
  const flexible = natural.map((_, index) => index).filter((index) => !keep[index]);
  if (flexible.length === 0) return finish(floors);

  const claimed = sum(natural.filter((_, index) => keep[index]));
  const shares = proportionalShares(
    flexible.map((index) => natural[index] ?? 0),
    budget - claimed,
  );

  const widths = natural.slice();
  flexible.forEach((column, position) => {
    widths[column] = Math.max(floors[column] ?? 1, shares[position] ?? 0);
  });

  // Lifting to the floor can overshoot the budget; take it back from the widest
  // columns that still have room above their own floor. Terminates because
  // sum(floors) <= budget (checked above).
  let overshoot = sum(widths) - budget;
  while (overshoot > 0) {
    let victim = -1;
    let widest = -1;
    for (const column of flexible) {
      const width = widths[column] ?? 0;
      if (width > (floors[column] ?? 1) && width > widest) {
        widest = width;
        victim = column;
      }
    }
    if (victim < 0) break;
    widths[victim] = (widths[victim] ?? 0) - 1;
    overshoot -= 1;
  }

  return finish(widths);
}

// ---------------------------------------------------------------------------
// Step 4 — lossless splitting
// ---------------------------------------------------------------------------

/**
 * Wrap cell text to `width` display columns: greedy fill on word boundaries, with
 * any word too wide for the column hard-split first. Never ellipsizes.
 */
export function wrapText(text: string, width: number, measure: Measure = NARROW_MEASURE): string[] {
  const limit = Math.max(1, width);
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const pieces = measure(word) > limit ? splitToken(word, limit, measure) : [word];
    for (const piece of pieces) {
      if (current === "") {
        current = piece;
        continue;
      }
      if (measure(current) + 1 + measure(piece) <= limit) {
        current = `${current} ${piece}`;
      } else {
        lines.push(current);
        current = piece;
      }
    }
  }
  lines.push(current);
  return lines;
}

/** One wrapped line of a cell, with the slice of the cell text it came from. */
interface CellFragment {
  readonly text: string;
  /** Offset of this fragment in the cell's `text`, or `-1` if it could not be located. */
  readonly start: number;
  readonly end: number;
}

/**
 * `wrapText`'s own lines, with each line's `[start, end)` in the cell text recovered.
 *
 * **This is a private wrapper over the existing split, not a second wrap** — deliberately,
 * per the plan's clipping rule (cycle-3 f6): `splitToken` (`src/text.ts:35`) and the public
 * `wrapText` keep their exact signatures and semantics, because `src/wrap.ts` imports the
 * first and this module must not change what a prose wrap does. Nothing in `src/text.ts`
 * is touched.
 *
 * Recovery is sound because the input is **already normalized**: every whitespace run in
 * the cell text is a single space, and `wrapText` either breaks at one of those spaces or
 * hard-splits inside a word — so every emitted line is a *contiguous slice* of the text,
 * and consecutive lines are separated by exactly one space or by nothing at all. Locating
 * each line at the cursor, or one past it, therefore identifies it exactly. The lossless
 * rejoin `splitToken` documents (`src/text.ts:33`) is what guarantees no character is lost
 * between fragments.
 *
 * If a line cannot be located — which no normalized input should produce — the fragment is
 * returned with `start = -1` and carries no styling, so the failure direction is *unstyled
 * text*, never text styled against the wrong offsets.
 */
function wrapFragments(text: string, width: number, measure: Measure): CellFragment[] {
  const lines = wrapText(text, width, measure);
  const fragments: CellFragment[] = [];
  let cursor = 0;
  for (const line of lines) {
    const start = text.startsWith(line, cursor)
      ? cursor
      : text.startsWith(line, cursor + 1)
        ? cursor + 1
        : -1;
    if (start === -1) {
      fragments.push({ text: line, start: -1, end: -1 });
      continue;
    }
    fragments.push({ text: line, start, end: start + line.length });
    cursor = start + line.length;
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Step 5 — the emitter
// ---------------------------------------------------------------------------

/**
 * **Why this module emits its own borders (WP-3 of `plans/tn-review-remediation.md`).**
 *
 * Until this package the finished string was assembled by `cli-table3`, and that was a
 * correctness defect, not merely a dependency. `cli-table3` bundles **its own**
 * `string-width@4.2.3` (nested under its `node_modules`, beside this repo's top-level
 * `7.2.0`) and that version has **no `ambiguousIsNarrow` option at all**, so its
 * per-cell padding could never honour `MDVIEW_AMBIGUOUS=wide`. A cell holding *k* East
 * Asian *Ambiguous* characters was padded *k* columns too wide; *k* varies cell by cell
 * within a column, so a table's right edge could be **ragged by up to *k* columns**.
 * `src/AGENTS.md` recorded that as not fixable from outside the library, and it was right:
 * the library pads to its own `colWidths` in its own units, so no pre-padding,
 * pre-wrapping or budget adjustment on this side could make its count agree with ours.
 *
 * Padding here with the caller's own `Measure` — the same ruler `allocateWidths` used
 * and the same one `--check` will grade the result with — makes that disagreement
 * **impossible by construction** rather than repaired after the fact. The capped
 * render/measure/reallocate loop that used to chase the *aggregate* overage (and could
 * only ever chase the aggregate, never the per-cell raggedness) is gone with it, along
 * with `MAX_FIT_PASSES` and `maxRenderedWidth`.
 *
 * **What this does NOT fix, stated plainly so the win is not heard as a bigger one.**
 * Wide mode plus the Unicode tier still cannot lay out a table, and nothing here
 * changes that. `─ │ ┌ ┬ ┼ …` are themselves Ambiguous and measure 2 columns under
 * `wide`, so a border row is exactly **2x** the content rows — 160 columns at a target
 * of 80, 200 at 100, pinned in `tests/width.test.ts`. That is a glyph-choice problem,
 * it is handled by `wideForcesAscii` in `src/glyphs.ts`, and it survives this work
 * untouched. The combination the CLI actually produces in wide mode is the **ASCII**
 * tier, every glyph of which is unambiguously 1 column, and *that* is the combination
 * whose right edge is now straight.
 *
 * The feature surface reproduced is strictly the subset this repo asked `cli-table3`
 * for — `head`, `colWidths`, `colAligns`, `style.head`/`style.border`, the padding
 * pair, `wordWrap: false` and `chars`. There is no `colSpan`, no `rowSpan`, no row
 * height, no vertical alignment and no truncation, because this module never used any
 * of them. Truncation in particular is not merely unused: this repo's rendering policy
 * is that **nothing is ever ellipsized**, and `cli-table3`'s `pad()` fell through to a
 * `truncate()` that appends `…` whenever its own measurement said a line did not fit.
 */

/**
 * One border glyph per slot, resolved from the tier's `chars` record.
 *
 * The names are `cli-table3`'s (which is where the tier's kebab-cased `chars` keys in
 * `src/glyphs.ts` come from), kept deliberately so the ASCII tier's table stays a
 * drop-in and so anyone diffing this against the old output has the same vocabulary.
 * Twelve of the fifteen slots draw the three horizontal rules; the other three draw
 * the vertical rules on a content line.
 */
interface BorderChars {
  readonly topLeft: string;
  readonly topMid: string;
  readonly top: string;
  readonly topRight: string;
  readonly leftMid: string;
  readonly midMid: string;
  readonly mid: string;
  readonly rightMid: string;
  readonly bottomLeft: string;
  readonly bottomMid: string;
  readonly bottom: string;
  readonly bottomRight: string;
  readonly left: string;
  readonly middle: string;
  readonly right: string;
}

/**
 * The Unicode tier's set, which is exactly `cli-table3`'s own default charset.
 *
 * `GlyphSet.tableChars` is `undefined` for that tier — it used to mean "let the library
 * keep its default" and now means "use this", so the constant has to reproduce the
 * library's defaults byte-for-byte or the Unicode tier's output would change. It does;
 * `tests/table-allocation.test.ts`'s `RULES` set is the standing check that these are the glyphs
 * being emitted.
 */
const UNICODE_BORDER: BorderChars = {
  topLeft: "┌",
  topMid: "┬",
  top: "─",
  topRight: "┐",
  leftMid: "├",
  midMid: "┼",
  mid: "─",
  rightMid: "┤",
  bottomLeft: "└",
  bottomMid: "┴",
  bottom: "─",
  bottomRight: "┘",
  left: "│",
  middle: "│",
  right: "│",
};

/**
 * Map a tier's kebab-cased `chars` record onto the slots above, falling back per slot.
 *
 * Per-slot rather than all-or-nothing because that is what the library did
 * (`Object.assign({}, defaults.chars, options.chars)`), so a partial override stays
 * legal. Both shipped tiers are total: Unicode passes `undefined` and ASCII supplies
 * all fifteen keys.
 */
function resolveBorderChars(chars: Readonly<Record<string, string>> | undefined): BorderChars {
  if (chars === undefined) return UNICODE_BORDER;
  const pick = (key: string, fallback: string): string => chars[key] ?? fallback;
  return {
    topLeft: pick("top-left", UNICODE_BORDER.topLeft),
    topMid: pick("top-mid", UNICODE_BORDER.topMid),
    top: pick("top", UNICODE_BORDER.top),
    topRight: pick("top-right", UNICODE_BORDER.topRight),
    leftMid: pick("left-mid", UNICODE_BORDER.leftMid),
    midMid: pick("mid-mid", UNICODE_BORDER.midMid),
    mid: pick("mid", UNICODE_BORDER.mid),
    rightMid: pick("right-mid", UNICODE_BORDER.rightMid),
    bottomLeft: pick("bottom-left", UNICODE_BORDER.bottomLeft),
    bottomMid: pick("bottom-mid", UNICODE_BORDER.bottomMid),
    bottom: pick("bottom", UNICODE_BORDER.bottom),
    bottomRight: pick("bottom-right", UNICODE_BORDER.bottomRight),
    left: pick("left", UNICODE_BORDER.left),
    middle: pick("middle", UNICODE_BORDER.middle),
    right: pick("right", UNICODE_BORDER.right),
  };
}

/**
 * The two styles the old `style: { head: ["bold"], border: ["grey"] }` produced — now
 * emitted by `src/style.ts` under the resolved colour policy (WP-2 of
 * `plans/colour-policy.md`).
 *
 * **The bytes did not change and the rule did.** `@colors/colors` supplied both pairs
 * until this package (`grey` = `90m`/`39m`, `bold` = `1m`/`22m`, byte-identical to the
 * committed table's `gray` and `bold`), *and it decided for itself whether to emit them*:
 * `cli-table3` called `colors.supportsColor()` with no stream argument, so that package
 * answered from the environment alone and **without consulting `isTTY`**. Measured at this
 * package's base, that meant a plain `mdview wide-table.md | cat` — nothing forced, no
 * terminal — emitted **205 grey pairs and 12 bold pairs** into a pipe, which is exactly
 * what Decision 1 of the plan forbids and what made this module the fourth of five
 * independent colour authorities. It now styles iff the resolved policy says so, like
 * every other producer.
 *
 * The gate arrives as `sgr`, threaded from `renderTable`'s caller (`src/render.ts`, from
 * `LayoutContext.sgr`); this module still reads no environment, and now it reads no
 * library's opinion of one either.
 *
 * **It is the mode, not a boolean, since WP-2 of `plans/colour-modes.md`, and this is the
 * producer where the split is most visible**: `gray` is hue-class and `bold` is
 * format-class, so under `formats` a table keeps its **bold heads** and loses its **grey
 * borders** — the glyphs are unchanged and unstyled, the geometry is untouched (styling
 * never moves a column here), and `tests/table-emission.test.ts` pins the exact pairs in all three
 * modes. This module applies no filter of its own; it hands the mode to `applyStyle`,
 * which owns the classification.
 */
const BORDER = createStyler("gray"); // the old `border: ["grey"]`
const HEAD = createStyler("bold"); // the old `head: ["bold"]`

const styleBorder = (sgr: SgrMode, text: string): string => applyStyle({ sgr }, BORDER, text);
const styleHead = (sgr: SgrMode, text: string): string => applyStyle({ sgr }, HEAD, text);

/**
 * Style one wrapped fragment against the cell's spans — **per fragment, nothing crossing**.
 *
 * Each span is clipped to `[fragment.start, fragment.end)` and opened and closed inside
 * the fragment, so no sequence spans a cell's padding, a border glyph or a line break. The
 * measured defect that rule repairs is the neighbouring cell rendering inside a wrapped
 * label's cyan; a fragment-scoped emission cannot produce it, because a fragment is
 * exactly the text between two pieces of chrome.
 *
 * The chain becomes bytes through `applyStyleChain` (`src/style.ts`) — the one applicator,
 * shared with `styleWikiLabel`'s prose path, so neither hand-spells a pair and the two
 * cannot drift.
 */
function styleFragment(
  fragment: CellFragment,
  spans: readonly CellSpan[],
  sgr: SgrMode,
): string {
  if (spans.length === 0 || fragment.start < 0) return fragment.text;

  let out = "";
  let cursor = fragment.start;
  for (const span of spans) {
    const start = Math.max(span.start, fragment.start);
    const end = Math.min(span.end, fragment.end);
    if (start >= end) continue;
    if (start > cursor) out += fragment.text.slice(cursor - fragment.start, start - fragment.start);
    out += applyStyleChain({ sgr }, span.styles, fragment.text.slice(start - fragment.start, end - fragment.start));
    cursor = end;
  }
  if (cursor === fragment.start) return fragment.text;
  return out + fragment.text.slice(cursor - fragment.start);
}

/** One cell, wrapped into its display lines, with the spans those lines are clipped against. */
interface LaidOutCell {
  readonly fragments: CellFragment[];
  readonly spans: readonly CellSpan[];
}

/** A row's cells, each already wrapped into its own display lines. */
type LaidOutRow = LaidOutCell[];

/**
 * Draw one horizontal rule.
 *
 * `kind` picks the three glyphs that vary: `top` is the rule above the header, `mid`
 * every rule between two rows, `bottom` the one under the last row. Each column
 * contributes its left junction plus `cellWidth` fill glyphs, and the last column also
 * contributes the right junction — and each column's contribution is wrapped in the
 * border style *separately*, which is not decoration but the escape-sequence layout
 * `cli-table3` produced (one wrap per cell, not one per line). Reproducing it is what
 * makes the narrow-mode diff empty rather than merely equivalent.
 */
function drawRule(
  widths: number[],
  chars: BorderChars,
  kind: "top" | "mid" | "bottom",
  sgr: SgrMode,
): string {
  const junctions = {
    top: { first: chars.topLeft, inner: chars.topMid, fill: chars.top, last: chars.topRight },
    mid: { first: chars.leftMid, inner: chars.midMid, fill: chars.mid, last: chars.rightMid },
    bottom: {
      first: chars.bottomLeft,
      inner: chars.bottomMid,
      fill: chars.bottom,
      last: chars.bottomRight,
    },
  }[kind];

  return widths
    .map((width, column) => {
      const left = column === 0 ? junctions.first : junctions.inner;
      const right = column === widths.length - 1 ? junctions.last : "";
      return styleBorder(sgr, left + junctions.fill.repeat(cellWidth(width)) + right);
    })
    .join("");
}

/**
 * Draw line `lineIndex` of one row.
 *
 * This is where **alignment is applied**, not merely computed: `grid.aligns` used to be
 * handed to `cli-table3` as `colAligns` and the library chose the padding side, so that
 * decision had no implementation on this side of the seam at all. It is also where
 * **multi-line cells compose vertically** — cells arrive pre-wrapped and a cell with
 * fewer lines than the row is tall contributes a blank cell-wide run, which is what
 * `cli-table3`'s `drawEmpty` did (its default vertical alignment is top, and this
 * module never set `rowAligns`, so short cells pad below).
 */
function drawLine(
  row: LaidOutRow,
  lineIndex: number,
  widths: number[],
  aligns: Align[],
  chars: BorderChars,
  isHead: boolean,
  measure: Measure,
  sgr: SgrMode,
): string {
  return widths
    .map((width, column) => {
      const left = styleBorder(sgr, column === 0 ? chars.left : chars.middle);
      const right = column === widths.length - 1 ? styleBorder(sgr, chars.right) : "";
      const cell = row[column];
      const fragment = cell?.fragments[lineIndex];
      // Padding measures the styled string rather than a saved plain copy, which is exact
      // rather than convenient: `Measure` is `string-width`, so the SGR a span emits is
      // zero columns to it and a fragment pads to what it *shows* (`src/text.ts`'s
      // second documented property). With no spans the styled string *is* the plain one.
      const content =
        cell === undefined || fragment === undefined
          ? " ".repeat(cellWidth(width))
          : " ".repeat(PADDING_LEFT) +
            padToWidth(
              styleFragment(fragment, cell.spans, sgr),
              width,
              aligns[column] ?? "left",
              measure,
            ) +
            " ".repeat(PADDING_RIGHT);
      return left + (isHead ? styleHead(sgr, content) : content) + right;
    })
    .join("");
}

/** Lines in the tallest cell of a row — the row's rendered height. */
function rowHeight(row: LaidOutRow): number {
  return row.reduce((tallest, cell) => Math.max(tallest, cell.fragments.length), 1);
}

/**
 * Compose the whole table: top rule, header, then a rule before every body row, then
 * the bottom rule. A table with no body rows is header-only and still gets both outer
 * rules, which is what the library did and what `tableGrid` can produce from a
 * header-only markdown table.
 */
function composeTable(
  header: LaidOutRow,
  rows: LaidOutRow[],
  widths: number[],
  aligns: Align[],
  chars: BorderChars,
  measure: Measure,
  sgr: SgrMode,
): string {
  const out: string[] = [drawRule(widths, chars, "top", sgr)];

  const emitRow = (row: LaidOutRow, isHead: boolean): void => {
    const height = rowHeight(row);
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      out.push(drawLine(row, lineIndex, widths, aligns, chars, isHead, measure, sgr));
    }
  };

  emitRow(header, true);
  for (const row of rows) {
    out.push(drawRule(widths, chars, "mid", sgr));
    emitRow(row, false);
  }
  out.push(drawRule(widths, chars, "bottom", sgr));

  return `${out.join("\n")}\n`;
}

/**
 * Render a markdown table to ANSI, guaranteed to fit within `targetWidth`.
 *
 * The single sanctioned exception is a table too wide to fit even at the per-column
 * floor (>= 9 columns at an 80-column target): it is emitted at its minimum feasible
 * width instead of being truncated or thrown away. `allocateWidths(...).fits` reports
 * that case for callers that need to know.
 *
 * **One pass, no repair.** Every cell is wrapped to its allocated content width and
 * padded back out to it with the same `Measure`, so the rendered geometry *is* the
 * allocated geometry — `tests/table-emission.test.ts` asserts `maxWidth(output) ===
 * allocation.totalWidth` directly. That equality is what makes a corrective render
 * pass unnecessary rather than merely absent.
 *
 * `sgr` is the resolved policy's, defaulted to `"none"` for the same reason
 * `LayoutContext.hyperlinks` defaults to `false`: unstyled is the answer every gate, sweep
 * and direct test call wants, and the one a forgotten argument should produce.
 * `src/render.ts` passes `ctx.sgr`. Styling never changes the geometry — head and border
 * styles wrap already measured strings — so the equality above holds at every mode, and
 * `tests/table-emission.test.ts` asserts it at all three.
 */
export function renderTable(
  token: Tokens.Table,
  targetWidth: number,
  glyphs: GlyphSet,
  measure: Measure = NARROW_MEASURE,
  sgr: SgrMode = "none",
): string {
  return renderGrid(tableGrid(token), targetWidth, glyphs, measure, sgr);
}

/**
 * The allocate-wrap-emit half of `renderTable`, over a grid that is already built.
 *
 * Split out so the span pipeline has a seam a caller can hand spans to. Nothing in `src/`
 * produces a non-empty `CellSpan` yet — the producer is WP-2's — and a contract whose only
 * exercise is its own future producer is a contract nobody has run: `tests/table-normalization.test.ts`'s
 * synthetic-span battery drives every clipping, wrapping, padding and nesting path through
 * here with hand-built spans, **before** any production span exists. With `spans` empty
 * this is byte-for-byte the function `renderTable` always was.
 */
export function renderGrid(
  grid: TableGrid,
  targetWidth: number,
  glyphs: GlyphSet,
  measure: Measure = NARROW_MEASURE,
  sgr: SgrMode = "none",
): string {
  if (grid.columnCount === 0) return "";

  const natural = naturalWidths(grid.header, grid.rows, measure);
  const { widths } = allocateWidths(natural, targetWidth);
  const chars = resolveBorderChars(glyphs.tableChars);

  const layout = (row: CellContent[]): LaidOutRow =>
    row.map((cell, index) => ({
      fragments: wrapFragments(cell.text, widths[index] ?? ABSOLUTE_MIN_COLUMN_WIDTH, measure),
      spans: cell.spans,
    }));

  return composeTable(
    layout(grid.header),
    grid.rows.map(layout),
    widths,
    grid.aligns,
    chars,
    measure,
    sgr,
  );
}
