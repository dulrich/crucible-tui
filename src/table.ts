import Table from "cli-table3";
import type { Token, Tokens } from "marked";
import stringWidth from "string-width";
import type { GlyphSet } from "./glyphs";

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
 * cli-table3 geometry, stated once so the chrome budget is derived rather than
 * guessed. These values MUST match the `style` object passed in `renderTable`.
 *
 * A rendered table line looks like:
 *
 *     │ cell │ cell │ cell │
 *     ^ ^  ^ ^                 border, pad-left, content, pad-right, border...
 *
 * so for an N-column table there are N+1 vertical rules and N pairs of padding.
 * Critically, cli-table3's `colWidths` are *cell* widths that INCLUDE padding —
 * treating them as content widths is the +2-per-column overshoot that the
 * prototype of this allocator shipped. `cellWidth()` is the only place that
 * conversion happens.
 */
const PADDING_LEFT = 1;
const PADDING_RIGHT = 1;
const BORDER_COLUMNS = 1;

/** Per-column content floor. No column may be narrower than this while shrinking. */
export const MIN_COLUMN_WIDTH = 6;

/**
 * Hard lower bound on a cell width. cli-table3's border and content rows only stay
 * the same width once the cell width exceeds the padding, so content width 0 is not
 * merely ugly — it misaligns the whole table.
 */
const ABSOLUTE_MIN_COLUMN_WIDTH = 1;

/** Display columns consumed by borders and padding for an N-column table. */
export function chromeWidth(columnCount: number): number {
  if (columnCount <= 0) return 0;
  const verticalRules = columnCount + 1;
  return verticalRules * BORDER_COLUMNS + columnCount * (PADDING_LEFT + PADDING_RIGHT);
}

/** Convert a content width to the cell width cli-table3's `colWidths` expects. */
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
 * Flatten a cell's inline token stream to plain text.
 *
 * Deliberately *no ANSI inside cells*: every width measurement and every hard split
 * in this module operates on the string directly, and splitting a string that carries
 * escape sequences risks cutting inside a sequence or dropping a reset — which would
 * corrupt both the colours and the alignment. Emphasis markers are unwrapped, code
 * spans lose their backticks, and a link keeps both its label and its href so no
 * content is discarded.
 */
export function flattenInline(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) return decodeEntities(fallback);

  const parts = tokens.map((token): string => {
    switch (token.type) {
      case "text":
      case "escape":
      case "codespan":
      case "html":
        return decodeEntities(token.text ?? "");
      case "strong":
      case "em":
      case "del":
        return flattenInline(token.tokens, token.text ?? "");
      case "link": {
        const label = flattenInline(token.tokens, token.text ?? "");
        const href = token.href ?? "";
        return href === "" || href === label ? label : `${label} (${href})`;
      }
      case "image":
        return decodeEntities(token.text ?? "");
      case "br":
        return " ";
      default: {
        const nested = "tokens" in token ? (token.tokens as Token[] | undefined) : undefined;
        if (nested && nested.length > 0) return flattenInline(nested, token.raw ?? "");
        return decodeEntities("text" in token ? (token.text ?? "") : (token.raw ?? ""));
      }
    }
  });

  return parts.join("");
}

/** Plain text for one table cell. */
export function cellText(cell: Tokens.TableCell): string {
  return flattenInline(cell.tokens, cell.text ?? "").replace(/\s+/g, " ").trim();
}

export interface TableGrid {
  header: string[];
  rows: string[][];
  aligns: ("left" | "center" | "right")[];
  columnCount: number;
}

/** Extract a rectangular grid of plain-text cells plus per-column alignment. */
export function tableGrid(token: Tokens.Table): TableGrid {
  const header = token.header.map(cellText);
  const rawRows = token.rows.map((row) => row.map(cellText));
  const columnCount = Math.max(header.length, ...rawRows.map((row) => row.length), 0);

  const pad = (row: string[]): string[] =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? "");

  const aligns = Array.from({ length: columnCount }, (_, index) => token.align[index] ?? "left");

  return { header: pad(header), rows: rawRows.map(pad), aligns, columnCount };
}

// ---------------------------------------------------------------------------
// Step 1 — natural widths
// ---------------------------------------------------------------------------

/**
 * Widest cell per column, measured with `string-width` so CJK (2 columns per
 * character) and emoji are counted in display columns rather than code units.
 */
export function naturalWidths(header: string[], rows: string[][]): number[] {
  return header.map((cell, index) => {
    let widest = stringWidth(cell);
    for (const row of rows) {
      const width = stringWidth(row[index] ?? "");
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
export function splitToken(token: string, width: number): string[] {
  const limit = Math.max(1, width);
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const grapheme of graphemes(token)) {
    const graphemeWidth = stringWidth(grapheme);
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

/**
 * Wrap cell text to `width` display columns: greedy fill on word boundaries, with
 * any word too wide for the column hard-split first. Never ellipsizes.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const pieces = stringWidth(word) > limit ? splitToken(word, limit) : [word];
    for (const piece of pieces) {
      if (current === "") {
        current = piece;
        continue;
      }
      if (stringWidth(current) + 1 + stringWidth(piece) <= limit) {
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

// ---------------------------------------------------------------------------
// Step 5 — render
// ---------------------------------------------------------------------------

/**
 * Render a markdown table to ANSI, guaranteed to fit within `targetWidth`.
 *
 * The single sanctioned exception is a table too wide to fit even at the per-column
 * floor (>= 9 columns at an 80-column target): it is emitted at its minimum feasible
 * width instead of being truncated or thrown away. `allocateWidths(...).fits` reports
 * that case for callers that need to know.
 */
/** Widest rendered line, measured with *our* `string-width` — the one `--check` uses. */
function maxRenderedWidth(text: string): number {
  let max = 0;
  for (const line of text.split("\n")) {
    const width = stringWidth(line);
    if (width > max) max = width;
  }
  return max;
}

function buildTable(
  grid: TableGrid,
  natural: number[],
  budget: number,
  glyphs: GlyphSet,
): { text: string; fits: boolean } {
  const { widths, fits } = allocateWidths(natural, budget);
  const layout = (row: string[]): string[] =>
    row.map((cell, index) => wrapText(cell, widths[index] ?? ABSOLUTE_MIN_COLUMN_WIDTH).join("\n"));

  const table = new Table({
    head: layout(grid.header),
    colWidths: widths.map(cellWidth),
    colAligns: grid.aligns,
    // Padding is declared here and consumed by chromeWidth()/cellWidth(); the two
    // must agree or the table overshoots the target by 2 columns per column.
    style: {
      head: ["bold"],
      border: ["grey"],
      "padding-left": PADDING_LEFT,
      "padding-right": PADDING_RIGHT,
    },
    // Cells are pre-wrapped above; cli-table3's own wrapping truncates with "…".
    wordWrap: false,
    // `undefined` (the Unicode tier) keeps cli-table3's own default box-drawing
    // charset — today's behaviour, byte-identical. The ASCII tier supplies a `+-|`
    // override; every substitute is 1 display column, identical to the Unicode
    // character it replaces, so `chromeWidth()`/`allocateWidths()` need no changes.
    ...(glyphs.tableChars !== undefined ? { chars: glyphs.tableChars } : {}),
  });

  for (const row of grid.rows) table.push(layout(row));

  return { text: `${table.toString()}\n`, fits };
}

/**
 * How many re-allocation passes to spend reconciling our width measurement with
 * cli-table3's. One pass fixes every case observed in the corpora; the cap only
 * exists so a pathological input cannot loop.
 */
const MAX_FIT_PASSES = 3;

/**
 * Render a markdown table to ANSI, guaranteed to fit within `targetWidth`.
 *
 * The single sanctioned exception is a table too wide to fit even at the per-column
 * floor (>= 9 columns at an 80-column target): it is emitted at its minimum feasible
 * width instead of being truncated or thrown away. `allocateWidths(...).fits` reports
 * that case for callers that need to know.
 *
 * **Why this re-renders.** `cli-table3` pads each cell to its `colWidths` entry using
 * *its own bundled* `string-width@4`, while this module allocates — and `--check`
 * verifies — with `string-width@7`. The two disagree on characters whose width data
 * changed between those majors: U+26A0 (warning sign) measures 1 column under v4 and 2
 * under v7. cli-table3 therefore pads such a cell one column too wide, and the finished
 * line overruns the target by one per affected cell, even though the allocation was
 * correct. Rather than duplicate cli-table3's measurement (a private, versioned detail),
 * we measure the *finished* table the same way `--check` will and re-allocate against a
 * budget reduced by the observed overage. Found by the vault corpus sweep, 2026-07-27.
 */
export function renderTable(token: Tokens.Table, targetWidth: number, glyphs: GlyphSet): string {
  const grid = tableGrid(token);
  if (grid.columnCount === 0) return "";

  const natural = naturalWidths(grid.header, grid.rows);

  let budget = targetWidth;
  let result = buildTable(grid, natural, budget, glyphs);

  // Only reconcile when the table is supposed to fit; the >= 9-column case overflows
  // by design and shrinking it further would just churn.
  for (let pass = 0; pass < MAX_FIT_PASSES && result.fits; pass += 1) {
    const overage = maxRenderedWidth(result.text) - targetWidth;
    if (overage <= 0) break;

    const retry = buildTable(grid, natural, budget - overage, glyphs);
    // If shrinking pushes the table below its own floor, keep the wider-but-structured
    // rendering rather than emitting a collapsed one.
    if (!retry.fits) break;
    budget -= overage;
    result = retry;
  }

  return result.text;
}
