import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Lexer, Marked, type Tokens } from "marked";
import stringWidth from "string-width";
import {
  type CellContent,
  type CellSpan,
  type TableGrid,
  cellText,
  flattenInline,
  naturalWidths,
  renderGrid,
  tableGrid,
  wrapText,
} from "../src/table";
// The production strip, imported rather than re-spelled — see `tests/glyphs.test.ts`.
import { stripAnsi } from "../src/list-lines";
import { type Align, splitToken } from "../src/text";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import { wikiLinkExtension } from "../src/wikilink";

// --- helpers ---------------------------------------------------------------

const ESC = String.fromCharCode(27);

/** Lex a markdown source string down to its first table token. */
function lexTable(source: string): Tokens.Table {
  const token = new Lexer().lex(source).find((candidate) => candidate.type === "table");
  if (!token) throw new Error("fixture contains no table");
  return token as Tokens.Table;
}

function lines(output: string): string[] {
  return stripAnsi(output).split("\n");
}

function maxWidth(output: string): number {
  return lines(output).reduce((widest, line) => Math.max(widest, stringWidth(line)), 0);
}

const squeeze = (text: string): string => text.replace(/\s+/g, "");

function buildTable(headers: string[], rows: string[][], aligns?: string[]): Tokens.Table {
  const divider = aligns ?? headers.map(() => "---");
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return lexTable(`| ${headers.join(" | ")} |\n| ${divider.join(" | ")} |\n${body}\n`);
}

const WIDE_FIXTURE = readFileSync(`${import.meta.dir}/fixtures/wide-table.md`, "utf8");
const WIDE_TABLE = lexTable(WIDE_FIXTURE);

// Long unbreakable tokens of the shape the real corpus is full of. They are written
// under the sanctioned fake root (`example/`) rather than as real paths, and they must
// stay **at least as long** as what they replaced — this one feeds column-width
// assertions and `wide-table.md` is the `--check` gate's fixture, so a shorter token
// silently weakens both. 53 and 43 columns, against 50 and 42 before WP-2h.
const LONG_PATH = "example/backend/services/api/src/csv-importer.test.ts";
const GATE_COMMAND = "bun run design:verify";

// --- splitting -------------------------------------------------------------

describe("splitToken", () => {
  test("is lossless — the chunks rejoin to the original token", () => {
    for (const width of [1, 2, 6, 7, 12, 40]) {
      expect(splitToken(LONG_PATH, width).join("")).toBe(LONG_PATH);
    }
  });

  test("never exceeds the requested display width", () => {
    for (const width of [6, 7, 12]) {
      for (const chunk of splitToken(LONG_PATH, width)) {
        expect(stringWidth(chunk)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("never emits an ellipsis", () => {
    expect(splitToken(LONG_PATH, 6).join("|")).not.toContain("…");
  });

  test("splits CJK by display width, not code units", () => {
    const chunks = splitToken("你好世界你好世界", 6);
    expect(chunks.join("")).toBe("你好世界你好世界");
    for (const chunk of chunks) expect(stringWidth(chunk)).toBeLessThanOrEqual(6);
    expect(chunks[0]).toBe("你好世");
  });

  test("keeps a multi-codepoint emoji sequence intact", () => {
    const family = "👩‍👩‍👧‍👦";
    const chunks = splitToken(`${family}${family}`, 2);
    expect(chunks.join("")).toBe(`${family}${family}`);
    expect(chunks).toEqual([family, family]);
  });
});

describe("wrapText", () => {
  test("wraps on word boundaries and hard-splits over-long words", () => {
    const wrapped = wrapText(`${GATE_COMMAND} ${LONG_PATH}`, 10);
    for (const line of wrapped) expect(stringWidth(line)).toBeLessThanOrEqual(10);
    expect(squeeze(wrapped.join(""))).toContain(squeeze(LONG_PATH));
    expect(wrapped.join("")).not.toContain("…");
  });

  test("leaves text that already fits on a single line", () => {
    expect(wrapText(GATE_COMMAND, 40)).toEqual([GATE_COMMAND]);
  });

  test("returns a single empty line for empty text", () => {
    expect(wrapText("", 10)).toEqual([""]);
  });
});

// --- cell text -------------------------------------------------------------

describe("cellText", () => {
  test("flattens inline markup to plain text without ANSI", () => {
    const table = buildTable(
      ["A"],
      [["`bun run design:verify`"], ["**bold** and *em*"], ["a < b & c"], ["[[wiki-slug]]"]],
    );
    const grid = tableGrid(table);
    expect(grid.rows.map((row) => row[0]?.text)).toEqual([
      "bun run design:verify",
      "bold and em",
      "a < b & c",
      "[[wiki-slug]]",
    ]);
    for (const row of grid.rows) expect(row[0]?.text).not.toContain(ESC);
    // And nothing this repo produces today carries a span — the producer is WP-2's.
    for (const row of grid.rows) expect(row[0]?.spans).toEqual([]);
  });

  test("keeps both a link's label and its href", () => {
    const table = buildTable(["A"], [["[label](https://example.test/x)"]]);
    const cell = table.rows[0]?.[0];
    expect(cell).toBeDefined();
    expect(cellText(cell as Tokens.TableCell).text).toBe("label (https://example.test/x)");
  });
});

// --- the span-cell contract ------------------------------------------------

/**
 * **The span-cell contract, and the synthetic-span battery that proves it before it has a
 * producer** — WP-1(c) of `plans/wiki-link-tokenizer.md`, cycle-2 f3 tightened at cycle-3
 * f2/f3/f4/f6.
 *
 * The problem the contract solves: a wiki-link in a cell is styled today by a pass that
 * runs over the **whole finished document**, so its style crosses cell padding, border
 * glyphs and row boundaries and bleeds into the neighbouring cell (addendum P14, pinned in
 * `tests/wikilink-table.test.ts`). `src/table.ts` could not do better, because `flattenInline`
 * stringified a cell irreversibly and nothing downstream knew which characters had been a
 * label.
 *
 * The contract is `{ text, spans }`: **plain for measurement and splitting, styled at
 * emission**. `naturalWidths`, `wrapText` and `splitToken` still see nothing but `text`, so
 * no pass ever measures or cuts an escape byte; `renderGrid` applies each span **per
 * fragment**, clipped to the wrapped line, so a sequence physically cannot cross padding or
 * a border.
 *
 * **The producer arrived at WP-2** — `walkInline`'s `wikilink` case, exercised in its own
 * describe below. The synthetic battery is kept exactly as it was, because its job was never
 * to stand in for the producer: it drives every clipping, wrapping, padding, measurement and
 * nesting path from hand-built spans, including shapes no wiki-link produces (partial spans,
 * hostile offsets, un-normalized text). Every cell that carries **no** wiki-link still has an
 * empty `spans`, which is what keeps the rest of this file and the env-pinned render-diff
 * meaningful.
 */
describe("the span-cell contract — text and offsets", () => {
  /** Lex one markdown table down to its first body cell's token. */
  function lexBodyCell(source: string): Tokens.TableCell {
    const table = lexTable(source);
    const cell = table.rows[0]?.[0];
    if (!cell) throw new Error("fixture contains no body cell");
    return cell;
  }

  test("whitespace collapses and trims exactly as the two-step form did", () => {
    // `cellText` used to be `flattenInline(...).replace(/\s+/g, " ").trim()`. The collapse
    // now happens *inside* the flatten so offsets mean something, and this is the identity
    // that says the move changed no byte: every run — spaces, tabs, the boundaries — comes
    // out as the same single space it always did.
    const cell = lexBodyCell("| col |\n|---|\n|   a   b \t c   |\n");
    expect(flattenInline(cell.tokens, cell.text ?? "").text).toBe("a b c");
  });

  test("entities decode, and decoding happens before the collapse", () => {
    const cell = lexBodyCell("| col |\n|---|\n| a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; |\n");
    expect(flattenInline(cell.tokens, cell.text ?? "").text).toBe(`a & b <c> "d" 'e'`);
  });

  test("inline markup flattens with the link's href kept, and a wiki-link-free cell carries no span", () => {
    const cell = lexBodyCell(
      "| col |\n|---|\n| **bold** and `code` and [l](https://example.test/x) |\n",
    );
    const flat = flattenInline(cell.tokens, cell.text ?? "");
    expect(flat.text).toBe("bold and code and l (https://example.test/x)");
    // The half of the contract that stays true now that a producer exists: only a wiki-link
    // contributes a span, so every other cell in the repo is byte-identical to before.
    expect(flat.spans).toEqual([]);
  });

  test("the whole wide fixture's grid carries no span, in either direction", () => {
    const grid = tableGrid(WIDE_TABLE);
    for (const cell of [...grid.header, ...grid.rows.flat()]) {
      expect(cell.spans).toEqual([]);
      expect(cell.text).not.toContain(ESC);
    }
  });

  test("measurement reads `text` and nothing else", () => {
    // Two grids identical but for spans measure identically — the property that lets
    // styling be applied last without ever moving a column.
    const bare: CellContent[] = [{ text: "alpha beta", spans: [] }];
    const spanned: CellContent[] = [{ text: "alpha beta", spans: [{ start: 0, end: 5, styles: ["cyan", "underline"] }] }];
    expect(naturalWidths(spanned, [spanned])).toEqual(naturalWidths(bare, [bare]));
  });
});

/**
 * **The production span producer** — WP-2 of `plans/wiki-link-tokenizer.md`.
 *
 * `walkInline`'s `wikilink` case is the only thing in `src/` that emits a `CellSpan`. Locked
 * decision D3 keeps a cell's wiki-link styled (it is a navigation target); cycle-3 f3 fixed
 * *how*: the label's children are flattened by this walk, exactly as `strong`/`em`/`del`/link
 * children already are, and the **outer chain is the only span the label contributes**. That
 * is what keeps a cell free of nested SGR and of OSC-8 — `renderLink` is unreachable from a
 * cell by construction.
 *
 * Offsets are recorded in *raw* walk coordinates and carried through `normalizeCell`, so a
 * label normalizes like every other cell text (grant C6b). Rendered bytes for all of this are
 * in `tests/wikilink-table.test.ts`; what is asserted here is the `{text, spans}` value itself,
 * because an offset that is right by accident in one table is a defect waiting for another.
 */
describe("the span-cell contract — the wiki-link producer (WP-2)", () => {
  /** Lex a table with the extension registered, exactly as `renderDocumentDetailed` does. */
  function lexTableWithWikiLinks(source: string): Tokens.Table {
    const instance = new Marked();
    instance.use({ extensions: [wikiLinkExtension] });
    const token = instance.lexer(source).find((candidate) => candidate.type === "table");
    if (!token) throw new Error("fixture contains no table");
    return token as Tokens.Table;
  }

  const bodyCell = (source: string): CellContent => {
    const cell = lexTableWithWikiLinks(source).rows[0]?.[0];
    if (!cell) throw new Error("fixture contains no body cell");
    return flattenInline(cell.tokens, cell.text ?? "");
  };

  const WIKI: CellSpan["styles"] = ["cyan", "underline"];

  test("a bare label contributes one span over exactly its own text", () => {
    expect(bodyCell("| col |\n|---|\n| [[wiki-slug]] |\n")).toEqual({
      text: "wiki-slug",
      spans: [{ start: 0, end: 9, styles: WIKI }],
    });
  });

  test("the span is clipped to the label when prose surrounds it", () => {
    expect(bodyCell("| col |\n|---|\n| pre [[mid]] post |\n")).toEqual({
      text: "pre mid post",
      spans: [{ start: 4, end: 7, styles: WIKI }],
    });
  });

  test("adjacent labels are two spans, non-overlapping and ascending", () => {
    const { text, spans } = bodyCell("| col |\n|---|\n| [[a]][[bb]] |\n");
    expect(text).toBe("abb");
    expect(spans).toEqual([
      { start: 0, end: 1, styles: WIKI },
      { start: 1, end: 3, styles: WIKI },
    ]);
  });

  test("the children flatten — no nested span, no href, no OSC-8 material", () => {
    // `strong` inside a label contributes nothing of its own, and a `url` child flattens to
    // its own text rather than to a link. One span, the outer chain, always.
    expect(bodyCell("| col |\n|---|\n| [[**bold** and `code`]] |\n")).toEqual({
      text: "bold and code",
      spans: [{ start: 0, end: 13, styles: WIKI }],
    });
    expect(bodyCell("| col |\n|---|\n| [[https://example.test/p]] |\n")).toEqual({
      text: "https://example.test/p",
      spans: [{ start: 0, end: 22, styles: WIKI }],
    });
  });

  test("`embed: ` is outside the span, and the span still lands on the label", () => {
    expect(bodyCell("| col |\n|---|\n| ![[note]] |\n")).toEqual({
      text: "embed: note",
      spans: [{ start: 7, end: 11, styles: WIKI }],
    });
  });

  test("C6b: offsets survive normalization — boundary trim and internal collapse", () => {
    // The carriers were non-whitespace and fenced `cellText`'s `\s+` collapse, which is why
    // `| [[ b ]] |` used to keep its boundary spaces. Nothing here knows about carriers, so
    // the label normalizes like any other cell text and the span follows the collapse.
    expect(bodyCell("| col |\n|---|\n| [[ b ]] |\n")).toEqual({
      text: "b",
      spans: [{ start: 0, end: 1, styles: WIKI }],
    });
    expect(bodyCell("| col |\n|---|\n| [[a   b]] |\n")).toEqual({
      text: "a b",
      spans: [{ start: 0, end: 3, styles: WIKI }],
    });
    expect(bodyCell("| col |\n|---|\n|   x   [[ a   b ]]   y   |\n")).toEqual({
      text: "x a b y",
      spans: [{ start: 2, end: 5, styles: WIKI }],
    });
  });

  test("entities decode around and inside a label, and the offsets are post-decode", () => {
    // `&amp;` is five characters raw and one decoded; an offset recorded against the raw
    // string would land three characters off.
    expect(bodyCell("| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n")).toEqual({
      text: "a & b <c>",
      spans: [{ start: 4, end: 5, styles: WIKI }],
    });
  });

  test("an empty label contributes no span at all", () => {
    // `applyStyle`'s own guard returns an empty input untouched, and a zero-width span would
    // be a degenerate entry in a list the emitter walks. `[[|x]]` does not match at all, so
    // this is the whitespace-only label that normalizes to nothing.
    expect(bodyCell("| col |\n|---|\n| [[   ]] |\n")).toEqual({ text: "", spans: [] });
  });

  test("the spans a whole grid carries are exactly the labelled cells'", () => {
    const grid = tableGrid(
      lexTableWithWikiLinks("| [[h]] | plain |\n|---|---|\n| [[a]] | b |\n| c | [[d]] |\n"),
    );
    const spanCounts = [grid.header, ...grid.rows].map((row) => row.map((cell) => cell.spans.length));
    expect(spanCounts).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("the span-cell contract — the synthetic-span battery (WP-1 proof, before any producer)", () => {
  /** The chain a wiki-link label will contribute: the same two names `WIKI_LINK_STYLE` composes. */
  const WIKI: readonly CellSpan["styles"][number][] = ["cyan", "underline"];

  const cell = (text: string, ...ranges: Array<[number, number]>): CellContent => ({
    text,
    spans: ranges.map(([start, end]) => ({ start, end, styles: WIKI })),
  });

  const gridOf = (header: CellContent[], rows: CellContent[][], aligns: Align[]): TableGrid => ({
    header,
    rows,
    aligns,
    columnCount: header.length,
  });

  const LEFT: Align[] = ["left"];

  test("an unwrapped span opens and closes inside its own fragment, in all three modes", () => {
    const grid = gridOf([cell("head")], [[cell("alpha beta", [0, 5])]], LEFT);
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m head       ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4malpha${ESC}[24m${ESC}[39m beta ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────────────┘${ESC}[39m\n`,
    );
    // `formats` drops the hue and keeps the underline — the same split every other
    // producer takes, because the chain goes through the one emitter.
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "formats")).toBe(
      `┌────────────┐\n│${ESC}[1m head       ${ESC}[22m│\n├────────────┤\n│ ${ESC}[4malpha${ESC}[24m beta │\n└────────────┘\n`,
    );
    // And `none` emits nothing at all — a span is not a licence to style.
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "none")).toBe(
      "┌────────────┐\n│ head       │\n├────────────┤\n│ alpha beta │\n└────────────┘\n",
    );
  });

  test("adjacent spans are two independent pairs, with nothing between them", () => {
    const grid = gridOf([cell("head")], [[cell("abcdef", [0, 3], [3, 6])]], LEFT);
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m head   ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mabc${ESC}[24m${ESC}[39m${ESC}[36m${ESC}[4mdef${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────────┘${ESC}[39m\n`,
    );
  });

  test("a partial span leaves the text either side of it unstyled", () => {
    const grid = gridOf([cell("h")], [[cell("one two three", [4, 7])]], LEFT);
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌───────────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h             ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m one ${ESC}[36m${ESC}[4mtwo${ESC}[24m${ESC}[39m three ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────────┘${ESC}[39m\n`,
    );
  });

  test("a word-wrapped span is clipped per fragment — no sequence crosses a border", () => {
    // The repair for the measured bleed, in its positive form: two fragments, two pairs,
    // and every border glyph between them outside both.
    const grid = gridOf([cell("h")], [[cell("alpha beta gamma", [0, 16])]], LEFT);
    const output = renderGrid(grid, 14, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    expect(output).toBe(
      `${ESC}[90m┌────────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h          ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4malpha beta${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mgamma${ESC}[24m${ESC}[39m      ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────────────┘${ESC}[39m\n`,
    );
    // Stated as the invariant as well as the bytes, which is what generalizes past this
    // one fixture: **every rendered line closes every pair it opens**. That is precisely
    // what today's document-pass styling does not do, and it is why the neighbouring cell
    // could render inside the label's cyan — see `tests/wikilink-table.test.ts`, C6a.
    // Counted on the wiki chain's own pair rather than on `39m`, which grey also closes
    // with — the point is that *this* chain is balanced per line, not that no `39m` exists.
    for (const line of output.split("\n").filter((candidate) => candidate !== "")) {
      expect(line.split(`${ESC}[36m${ESC}[4m`).length - 1).toBe(
        line.split(`${ESC}[24m${ESC}[39m`).length - 1,
      );
    }
  });

  test("a hard-split span is clipped per fragment too — the word is cut, the style is not", () => {
    const grid = gridOf([cell("h")], [[cell("abcdefghijkl", [0, 12])]], LEFT);
    expect(renderGrid(grid, 10, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h      ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mabcdef${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mghijkl${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────────┘${ESC}[39m\n`,
    );
  });

  test("alignment padding stays outside the span, right and centre alike", () => {
    // Padding measures the *styled* string, which is exact because `Measure` ignores SGR —
    // so the slack is what the cell shows, and the escapes sit inside the padded region
    // rather than being counted as part of it.
    expect(renderGrid(gridOf([cell("h")], [[cell("ab", [0, 2])]], ["right"]), 12, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m  h ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mab${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────┘${ESC}[39m\n`,
    );
    expect(renderGrid(gridOf([cell("h")], [[cell("ab", [0, 2])]], ["center"]), 12, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h  ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mab${ESC}[24m${ESC}[39m ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────┘${ESC}[39m\n`,
    );
  });

  test("a span over a head cell nests inside the head bold, through applyStyle's own surgery", () => {
    const grid = gridOf([cell("alpha beta", [0, 5])], [[cell("body")]], LEFT);
    expect(renderGrid(grid, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌────────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m ${ESC}[36m${ESC}[4malpha${ESC}[24m${ESC}[39m beta ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├────────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m body       ${ESC}[90m│${ESC}[39m\n${ESC}[90m└────────────┘${ESC}[39m\n`,
    );
  });

  test("a span ending mid-CJK keeps whole graphemes, and both measurement modes agree on them", () => {
    const grid = gridOf([cell("h")], [[cell("你好世界", [0, 2])]], LEFT);
    const expected = `${ESC}[90m┌──────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h        ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├──────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4m你好${ESC}[24m${ESC}[39m世界 ${ESC}[90m│${ESC}[39m\n${ESC}[90m└──────────┘${ESC}[39m\n`;
    // CJK Wide is 2 columns under either mode, so the geometry is the same and the span
    // lands on the same two characters — the control for the ambiguous case below.
    expect(renderGrid(grid, 12, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(expected);
    expect(renderGrid(grid, 12, UNICODE_GLYPHS, WIDE_MEASURE, "full")).toBe(expected);
  });

  test("East Asian Ambiguous content: the two measurement modes size differently, the span does not move", () => {
    // This is the case the CJK one cannot make: `—→≥×` is 4 columns narrow and 8 wide, so
    // the allocation genuinely differs — and the span still covers exactly those four
    // characters in both, because offsets are code units and measurement is columns.
    const grid = gridOf([cell("h")], [[cell("—→≥×ab", [0, 4])]], LEFT);
    expect(renderGrid(grid, 14, ASCII_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m+--------+${ESC}[39m\n${ESC}[90m|${ESC}[39m${ESC}[1m h      ${ESC}[22m${ESC}[90m|${ESC}[39m\n${ESC}[90m+--------+${ESC}[39m\n${ESC}[90m|${ESC}[39m ${ESC}[36m${ESC}[4m—→≥×${ESC}[24m${ESC}[39mab ${ESC}[90m|${ESC}[39m\n${ESC}[90m+--------+${ESC}[39m\n`,
    );
    expect(renderGrid(grid, 14, ASCII_GLYPHS, WIDE_MEASURE, "full")).toBe(
      `${ESC}[90m+------------+${ESC}[39m\n${ESC}[90m|${ESC}[39m${ESC}[1m h          ${ESC}[22m${ESC}[90m|${ESC}[39m\n${ESC}[90m+------------+${ESC}[39m\n${ESC}[90m|${ESC}[39m ${ESC}[36m${ESC}[4m—→≥×${ESC}[24m${ESC}[39mab ${ESC}[90m|${ESC}[39m\n${ESC}[90m+------------+${ESC}[39m\n`,
    );
  });

  test("a multi-codepoint emoji sequence is never cut by a span boundary", () => {
    // The family is 11 code units and one grapheme; a span covering all of it must not
    // leave a ZWJ outside the pair.
    const family = "👩‍👩‍👧‍👦";
    expect(family.length).toBe(11);
    const grid = gridOf([cell("h")], [[cell(`${family}x`, [0, 11])]], LEFT);
    expect(renderGrid(grid, 12, UNICODE_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m┌─────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m h   ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├─────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4m${family}${ESC}[24m${ESC}[39mx ${ESC}[90m│${ESC}[39m\n${ESC}[90m└─────┘${ESC}[39m\n`,
    );
  });

  test("the ASCII tier styles spans identically — the tier decides glyphs, not styling", () => {
    const grid = gridOf([cell("head")], [[cell("alpha beta", [0, 5])]], LEFT);
    expect(renderGrid(grid, 40, ASCII_GLYPHS, NARROW_MEASURE, "full")).toBe(
      `${ESC}[90m+------------+${ESC}[39m\n${ESC}[90m|${ESC}[39m${ESC}[1m head       ${ESC}[22m${ESC}[90m|${ESC}[39m\n${ESC}[90m+------------+${ESC}[39m\n${ESC}[90m|${ESC}[39m ${ESC}[36m${ESC}[4malpha${ESC}[24m${ESC}[39m beta ${ESC}[90m|${ESC}[39m\n${ESC}[90m+------------+${ESC}[39m\n`,
    );
  });

  test("styling a span moves no column: every mode strips to the same text and width", () => {
    const grid = gridOf(
      [cell("head one"), cell("head two", [0, 4])],
      [[cell("alpha beta gamma delta", [0, 10]), cell("plain")]],
      ["left", "right"],
    );
    const none = renderGrid(grid, 30, UNICODE_GLYPHS, NARROW_MEASURE, "none");
    for (const sgr of ["none", "formats", "full"] as const) {
      const output = renderGrid(grid, 30, UNICODE_GLYPHS, NARROW_MEASURE, sgr);
      expect(stripAnsi(output)).toBe(none);
      expect(maxWidth(output)).toBe(maxWidth(none));
    }
  });

  test("and it moves no column against the *unspanned* grid either — the geometry is the text's", () => {
    // The strongest form of the "plain for measurement" half: drop the spans and the
    // colourless render is byte-identical, so a span can never change an allocation.
    const spanned = gridOf(
      [cell("head one"), cell("head two", [0, 4])],
      [[cell("alpha beta gamma delta", [0, 10]), cell("plain")]],
      ["left", "right"],
    );
    const bare = gridOf(
      [cell("head one"), cell("head two")],
      [[cell("alpha beta gamma delta"), cell("plain")]],
      ["left", "right"],
    );
    for (const measure of [NARROW_MEASURE, WIDE_MEASURE]) {
      for (const width of [20, 30, 60]) {
        expect(renderGrid(spanned, width, UNICODE_GLYPHS, measure, "none")).toBe(
          renderGrid(bare, width, UNICODE_GLYPHS, measure, "none"),
        );
        expect(stripAnsi(renderGrid(spanned, width, UNICODE_GLYPHS, measure, "full"))).toBe(
          renderGrid(bare, width, UNICODE_GLYPHS, measure, "none"),
        );
      }
    }
  });

  test("un-normalized text degrades to unstyled fragments rather than mis-placed styling", () => {
    // The offset recovery in `wrapFragments` is sound *because* cell text is normalized:
    // every whitespace run is one space, so each wrapped line is a contiguous slice. Hand a
    // grid text that violates that — a double space — and the line cannot be located, which
    // is the one case the recovery bails on. It must bail toward **unstyled**, never toward
    // styling the wrong characters, and the visible text must survive either way.
    const grid = gridOf([cell("h")], [[cell("a  b", [0, 1])]], LEFT);
    const output = renderGrid(grid, 20, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    expect(stripAnsi(output)).toBe(renderGrid(grid, 20, UNICODE_GLYPHS, NARROW_MEASURE, "none"));
    expect(output).not.toContain(`${ESC}[36m`);
    expect(stripAnsi(output)).toContain("a b");
  });

  test("a span outside the text, or empty, styles nothing rather than throwing", () => {
    // Total over hostile offsets: the failure direction is unstyled text, never a
    // half-open pair or a crash.
    for (const ranges of [
      [[50, 60]] as Array<[number, number]>,
      [[3, 3]] as Array<[number, number]>,
      [[-5, 0]] as Array<[number, number]>,
    ]) {
      const grid = gridOf([cell("h")], [[cell("abc", ...ranges)]], LEFT);
      const output = renderGrid(grid, 20, UNICODE_GLYPHS, NARROW_MEASURE, "full");
      expect(stripAnsi(output)).toBe(renderGrid(grid, 20, UNICODE_GLYPHS, NARROW_MEASURE, "none"));
      expect(output).not.toContain(`${ESC}[36m`);
    }
  });
});
