import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Lexer, type Tokens } from "marked";
import stringWidth from "string-width";
import {
  type CellContent,
  type CellSpan,
  MIN_COLUMN_WIDTH,
  type TableGrid,
  allocateWidths,
  cellText,
  chromeWidth,
  flattenInline,
  naturalWidths,
  renderGrid,
  renderTable,
  tableGrid,
  wrapText,
} from "../src/table";
// The production strip, imported rather than re-spelled — see `tests/glyphs.test.ts`.
import { stripAnsi } from "../src/list-lines";
import { type Align, splitToken } from "../src/text";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { NARROW_MEASURE, WIDE_MEASURE, type Measure } from "../src/width";

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

/** Display-column offsets of every box-drawing rule on a line. */
const RULES = new Set(["│", "┌", "┬", "┐", "├", "┼", "┤", "└", "┴", "┘"]);
function ruleColumns(line: string): number[] {
  const columns: number[] = [];
  let offset = 0;
  for (const character of line) {
    if (RULES.has(character)) columns.push(offset);
    offset += stringWidth(character);
  }
  return columns;
}

/** Padded cell segments (content plus its left/right padding) for one body line. */
function segments(line: string): string[] {
  if (!line.startsWith("│")) return [];
  return line.split("│").slice(1, -1);
}

/** Concatenate every fragment a column contributes, in order. */
function columnText(output: string, columnIndex: number): string {
  let text = "";
  for (const line of lines(output)) {
    const cells = segments(line);
    const cell = cells[columnIndex];
    if (cell !== undefined) text += cell.trim();
  }
  return text;
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
const LONG_DIR = "example/config-presets/templates/gitignore/";
const GATE_COMMAND = "bun run design:verify";

// --- geometry --------------------------------------------------------------

/** Every non-empty rendered line's display width, on the ruler the render used. */
function lineWidths(output: string, measure: Measure): number[] {
  return lines(output)
    .filter((line) => line !== "")
    .map((line) => measure(line));
}

/** Widest minus narrowest rendered line: 0 iff the table's right edge is straight. */
function edgeSpread(output: string, measure: Measure): number {
  const widths = lineWidths(output, measure);
  return Math.max(...widths) - Math.min(...widths);
}

describe("per-cell padding measures with this repo's own ruler (WP-3)", () => {
  /**
   * Until WP-3 the finished string was assembled by `cli-table3`, which pads every cell
   * with **its own bundled `string-width@4.2.3`** — a version that has no
   * `ambiguousIsNarrow` option at all. A cell holding *k* characters the two versions
   * disagree about was padded *k* columns too wide; *k* varies cell by cell, so the
   * table's **right edge went ragged**. `src/AGENTS.md` recorded that as not fixable from
   * outside the library, and it was right: the capped render/measure/reallocate loop
   * that used to sit in `renderTable` could only ever chase the *aggregate* overage,
   * which is why it kept the table inside the target while leaving the edge crooked.
   *
   * Both edge tests below **fail on the parent commit** — measured there: spread 3 for
   * the narrow U+26A0 case, spread 4 for the wide/ASCII case — and are 0 here, because
   * the emitter pads with the same `Measure` the allocation used.
   */
  const WARNING_SIGN = "⚠";

  // Two characters the bundled v4 and this repo's v7 disagree about, for opposite
  // reasons: U+26A0 changed width data between the majors, while `—`/`→`/`≥`/`×` are
  // East Asian *Ambiguous* and v4 has no option to be told which way to count them.
  const AMBIGUOUS_TABLE =
    "| Risk | Note |\n| --- | --- |\n| — — — | plain |\n| — | → ≥ × |\n";

  test("narrow mode: a table whose cells hold U+26A0 keeps a straight right edge", () => {
    const token = lexTable(
      `| Risk | Note |\n| --- | --- |\n| ${WARNING_SIGN} ${WARNING_SIGN} ${WARNING_SIGN} | plain |\n| a | escalate now |\n`,
    );
    const output = renderTable(token, 40, UNICODE_GLYPHS, NARROW_MEASURE);
    expect(edgeSpread(output, NARROW_MEASURE)).toBe(0);
    expect(maxWidth(output)).toBeLessThanOrEqual(40);
  });

  /**
   * **The combination the CLI actually produces in wide mode**: `resolveGlyphs` returns
   * the ASCII tier ahead of `--unicode` whenever the ambiguous setting is `wide`, so
   * this — not wide + Unicode — is the pairing a real user in a wide terminal renders
   * with. Wide + Unicode is still exactly 2x the target and this WP did not change
   * that; `tests/width.test.ts` pins it at 160 columns for target 80 and 200 for 100.
   */
  test("wide mode + the ASCII tier: the edge is straight and inside the target", () => {
    const token = lexTable(AMBIGUOUS_TABLE);
    for (const target of [40, 60, 80]) {
      const output = renderTable(token, target, ASCII_GLYPHS, WIDE_MEASURE);
      expect(edgeSpread(output, WIDE_MEASURE)).toBe(0);
      for (const width of lineWidths(output, WIDE_MEASURE)) {
        expect(width).toBeLessThanOrEqual(target);
      }
    }
  });

  test("the rendered geometry is the allocated geometry — there is no repair pass", () => {
    const token = lexTable(AMBIGUOUS_TABLE);
    const grid = tableGrid(token);
    for (const target of [40, 60, 80]) {
      const allocation = allocateWidths(naturalWidths(grid.header, grid.rows, WIDE_MEASURE), target);
      const output = renderTable(token, target, ASCII_GLYPHS, WIDE_MEASURE);
      expect(Math.max(...lineWidths(output, WIDE_MEASURE))).toBe(allocation.totalWidth);
    }
  });

  test("a table whose cell holds U+26A0 still fits the target", () => {
    const token = lexTable(
      `| Risk | Note | Owner |\n| --- | --- | --- |\n| ${WARNING_SIGN} | escalate before Friday | alex |\n`,
    );
    for (const target of [40, 60, 80, 100]) {
      expect(maxWidth(renderTable(token, target, UNICODE_GLYPHS))).toBeLessThanOrEqual(target);
    }
  });

  test("the glyph itself survives — padding is corrected, content is never dropped", () => {
    const token = lexTable(
      `| Risk | Note |\n| --- | --- |\n| ${WARNING_SIGN} | escalate |\n`,
    );
    const output = renderTable(token, 60, UNICODE_GLYPHS);
    expect(stripAnsi(output)).toContain(WARNING_SIGN);
    expect(output).not.toContain("…");
  });

  test("rendering is deterministic — the same input renders byte-identically", () => {
    const token = lexTable("| A | B |\n| --- | --- |\n| one | two |\n");
    const before = renderTable(token, 80, UNICODE_GLYPHS);
    expect(maxWidth(before)).toBeLessThanOrEqual(80);
    expect(renderTable(token, 80, UNICODE_GLYPHS)).toBe(before);
  });
});

// --- the border set --------------------------------------------------------

describe("the emitted border set", () => {
  const table = buildTable(["A", "B"], [["one", "two"], ["three", "four"]]);

  /**
   * Twelve junction slots draw the three horizontal rules and three draw the vertical
   * rules, and the emitter owns all fifteen now. The Unicode tier's set has to
   * reproduce `cli-table3`'s own defaults exactly — `GlyphSet.tableChars` is
   * `undefined` there, which used to mean "keep the library's charset" and now means
   * "use `UNICODE_BORDER`" — so this is the standing check that it still does.
   */
  test("the Unicode tier draws the box-drawing rules, corners and junctions", () => {
    const rendered = lines(renderTable(table, 40, UNICODE_GLYPHS)).filter((l) => l !== "");
    expect(rendered[0]).toMatch(/^┌─+┬─+┐$/);
    expect(rendered[2]).toMatch(/^├─+┼─+┤$/);
    expect(rendered.at(-1)).toMatch(/^└─+┴─+┘$/);
    expect(rendered[1]).toMatch(/^│[^│]+│[^│]+│$/);
  });

  test("the ASCII tier draws the same twelve slots as + and -", () => {
    const rendered = lines(renderTable(table, 40, ASCII_GLYPHS)).filter((l) => l !== "");
    expect(rendered[0]).toMatch(/^\+-+\+-+\+$/);
    expect(rendered[2]).toMatch(/^\+-+\+-+\+$/);
    expect(rendered.at(-1)).toMatch(/^\+-+\+-+\+$/);
    expect(rendered[1]).toMatch(/^\|[^|]+\|[^|]+\|$/);
    expect(rendered.join("")).not.toContain("┌");
  });

  test("a rule sits above the header, between every pair of rows, and below the last", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      const rendered = lines(renderTable(table, 40, glyphs)).filter((l) => l !== "");
      // top rule, header, mid rule, row, mid rule, row, bottom rule
      expect(rendered.length).toBe(7);
    }
  });

  test("a header-only table still gets both outer rules", () => {
    const headerOnly = lexTable("| A | B |\n| --- | --- |\n");
    const rendered = lines(renderTable(headerOnly, 40, UNICODE_GLYPHS)).filter((l) => l !== "");
    expect(rendered.length).toBe(3);
    expect(rendered[0]).toMatch(/^┌/);
    expect(rendered.at(-1)).toMatch(/^└/);
  });
});

// --- multi-line cells ------------------------------------------------------

describe("multi-line cells compose vertically", () => {
  /**
   * Cells arrive pre-wrapped, so a row is as tall as its tallest cell and every shorter
   * cell owes blank, cell-wide lines *below* its content — `cli-table3`'s default
   * vertical alignment was top and this module never set `rowAligns`, so that is the
   * behaviour being reproduced rather than chosen.
   */
  test("a short cell is blank-padded to the row's height, and the row stays rectangular", () => {
    const table = buildTable(["A", "B"], [["x", "one two three four five six seven eight"]]);
    const output = renderTable(table, 40, UNICODE_GLYPHS);
    const body = lines(output).filter((line) => line.startsWith("│")).slice(1);
    expect(body.length).toBeGreaterThan(1);
    expect(segments(body[1] ?? "")[0]?.trim()).toBe("");
    expect(new Set(body.map((line) => stringWidth(line))).size).toBe(1);
  });
});

describe("chromeWidth", () => {
  test("counts N+1 vertical rules and 2 padding columns per column", () => {
    expect(chromeWidth(1)).toBe(4);
    expect(chromeWidth(2)).toBe(7);
    expect(chromeWidth(3)).toBe(10);
    expect(chromeWidth(6)).toBe(19);
    expect(chromeWidth(9)).toBe(28);
  });

  test("is zero for an empty table", () => {
    expect(chromeWidth(0)).toBe(0);
  });
});

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

// --- allocation ------------------------------------------------------------

describe("allocateWidths", () => {
  test("leaves a table that already fits at its natural widths", () => {
    const allocation = allocateWidths([4, 6, 5], 80);
    expect(allocation.widths).toEqual([4, 6, 5]);
    expect(allocation.fits).toBe(true);
    expect(allocation.totalWidth).toBe(4 + 6 + 5 + chromeWidth(3));
  });

  test("shrinks only the over-budget columns and fills the target exactly", () => {
    const allocation = allocateWidths([3, 200], 80);
    expect(allocation.widths[0]).toBe(3);
    expect(allocation.widths[1]).toBe(80 - chromeWidth(2) - 3);
    expect(allocation.totalWidth).toBe(80);
    expect(allocation.fits).toBe(true);
  });

  test("never lets a column fall below the floor", () => {
    const allocation = allocateWidths([120, 120, 120, 8], 60);
    for (const width of allocation.widths) {
      expect(width).toBeGreaterThanOrEqual(Math.min(8, MIN_COLUMN_WIDTH));
    }
    expect(allocation.widths.every((width) => width > 0)).toBe(true);
  });

  test("reports the sanctioned overflow for a table that cannot fit at the floor", () => {
    const natural = Array.from({ length: 9 }, () => 40);
    const allocation = allocateWidths(natural, 80);
    expect(allocation.fits).toBe(false);
    expect(allocation.widths).toEqual(Array.from({ length: 9 }, () => MIN_COLUMN_WIDTH));
    expect(allocation.totalWidth).toBe(9 * MIN_COLUMN_WIDTH + chromeWidth(9));
    expect(allocation.totalWidth).toBe(82);
  });

  test("handles an empty column set", () => {
    expect(allocateWidths([], 80)).toEqual({ widths: [], totalWidth: 0, fits: true });
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

// --- the width invariant ---------------------------------------------------

describe("renderTable width invariant", () => {
  test("the fixture really does carry a 367+ column source row", () => {
    const widest = WIDE_FIXTURE.split("\n")
      .filter((line) => line.startsWith("|"))
      .reduce((longest, line) => Math.max(longest, stringWidth(line)), 0);
    expect(widest).toBeGreaterThanOrEqual(367);
  });

  test.each([80, 100, 160])("no line exceeds a %i-column target", (target) => {
    const output = renderTable(WIDE_TABLE, target, UNICODE_GLYPHS);
    for (const line of lines(output)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(target);
    }
    expect(maxWidth(output)).toBe(target);
  });
});

describe("renderTable losslessness", () => {
  test.each([80, 100, 160])("emits no ellipsis at width %i", (target) => {
    expect(renderTable(WIDE_TABLE, target, UNICODE_GLYPHS)).not.toContain("…");
  });

  test.each([80, 100, 160])("keeps every long token in full at width %i", (target) => {
    const output = renderTable(WIDE_TABLE, target, UNICODE_GLYPHS);
    expect(squeeze(columnText(output, 0))).toContain(squeeze(GATE_COMMAND));
    expect(squeeze(columnText(output, 1))).toContain(squeeze(LONG_DIR));
    expect(squeeze(columnText(output, 2))).toContain(squeeze(LONG_PATH));
  });
});

// --- no column collapse ----------------------------------------------------

describe("renderTable column collapse", () => {
  const narrow = "WP3";
  const wide = Array.from({ length: 30 }, (_, index) => `token${index}`).join(" ");

  test("a 3-char column beside a 200-char column keeps both, header intact", () => {
    expect(stringWidth(wide)).toBeGreaterThan(200);
    const table = buildTable(["WP", "Detail"], [[narrow, wide]]);
    const grid = tableGrid(table);
    const allocation = allocateWidths(naturalWidths(grid.header, grid.rows), 80);

    expect(allocation.widths[0]).toBe(3);
    expect(allocation.widths[1]).toBeGreaterThanOrEqual(MIN_COLUMN_WIDTH);
    expect(allocation.fits).toBe(true);

    const output = renderTable(table, 80, UNICODE_GLYPHS);
    expect(output).toContain("WP");
    expect(output).toContain("Detail");
    expect(columnText(output, 0)).toContain(narrow);
    expect(maxWidth(output)).toBe(80);
  });

  test("a long unbreakable token beside a narrow column does not starve it", () => {
    const table = buildTable(["WP", "Path"], [[narrow, `${LONG_PATH}${LONG_PATH}${LONG_PATH}`]]);
    const output = renderTable(table, 40, UNICODE_GLYPHS);
    expect(columnText(output, 0)).toContain(narrow);
    expect(output).not.toContain("…");
    expect(maxWidth(output)).toBe(40);
  });
});

// --- alignment -------------------------------------------------------------

describe("renderTable alignment", () => {
  const table = buildTable(["Left", "Center", "Right"], [["a", "b", "c"]], [":---", ":---:", "---:"]);

  function pads(line: string, columnIndex: number): { left: number; right: number } {
    const cell = segments(line)[columnIndex] ?? "";
    return {
      left: cell.length - cell.trimStart().length,
      right: cell.length - cell.trimEnd().length,
    };
  }

  test("maps :--- / :---: / ---: to left, center and right", () => {
    expect(tableGrid(table).aligns).toEqual(["left", "center", "right"]);
  });

  test("renders the body row left, centered and right", () => {
    const output = renderTable(table, 80, UNICODE_GLYPHS);
    const bodyLine = lines(output).filter((line) => line.startsWith("│")).at(-1) ?? "";

    const left = pads(bodyLine, 0);
    const center = pads(bodyLine, 1);
    const right = pads(bodyLine, 2);

    expect(left.left).toBeLessThan(left.right);
    expect(Math.abs(center.left - center.right)).toBeLessThanOrEqual(1);
    expect(right.left).toBeGreaterThan(right.right);
  });

  /**
   * Alignment is **applied** here, not merely computed. Until WP-3 `grid.aligns` was
   * handed to `cli-table3` as `colAligns` and the library chose the padding side, so
   * the decision had no implementation on this side of the seam at all.
   *
   * The exact counts are pinned rather than the ordering, because one of them is a
   * choice that could silently flip: an odd slack in a **centred** cell goes to the
   * **right**, matching `cli-table3`'s `pad()` (`right = ceil(padlen / 2)`), so
   * centred cells keep the bytes they had.
   */
  test("the padding side and count are exact, and centre biases the odd column right", () => {
    const output = renderTable(table, 80, UNICODE_GLYPHS);
    const bodyLine = lines(output).filter((line) => line.startsWith("│")).at(-1) ?? "";

    // Header widths 4/6/5 are the natural widths; a one-column cell leaves 3/5/4 slack.
    expect(pads(bodyLine, 0)).toEqual({ left: 1, right: 4 });
    expect(pads(bodyLine, 1)).toEqual({ left: 3, right: 4 });
    expect(pads(bodyLine, 2)).toEqual({ left: 5, right: 1 });
  });
});

// --- CJK + emoji -----------------------------------------------------------

describe("renderTable CJK and emoji", () => {
  test.each([80, 100, 160])(
    "column rules land on identical display columns at width %i",
    (target) => {
      const output = renderTable(WIDE_TABLE, target, UNICODE_GLYPHS);
      const rendered = lines(output).filter((line) => line.trim() !== "");
      const expected = ruleColumns(rendered[0] ?? "");
      expect(expected.length).toBe(7);
      for (const line of rendered) {
        expect(ruleColumns(line)).toEqual(expected);
      }
    },
  );

  test("a CJK + emoji only table stays rectangular", () => {
    const table = buildTable(
      ["名前", "説明"],
      [
        ["你好世界 🎉", "中文和表情符号混排的行,用于验证宽度对齐 🚀"],
        ["ascii", "plain"],
      ],
    );
    const output = renderTable(table, 40, UNICODE_GLYPHS);
    const widths = new Set(lines(output).filter((l) => l !== "").map((l) => stringWidth(l)));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeLessThanOrEqual(40);
  });
});

// --- chrome invariant ------------------------------------------------------

describe("chrome invariant", () => {
  const columnCounts = [2, 3, 6];
  const targets = [40, 80, 160];

  test.each(columnCounts.flatMap((n) => targets.map((w) => [n, w] as const)))(
    "%i columns at width %i render at exactly the predicted width",
    (columnCount, target) => {
      const headers = Array.from({ length: columnCount }, (_, i) => `Column ${i}`);
      const rows = [
        Array.from({ length: columnCount }, (_, i) => `${LONG_PATH}#${i} and some prose after it`),
      ];
      const table = buildTable(headers, rows);
      const grid = tableGrid(table);
      const natural = naturalWidths(grid.header, grid.rows);
      const naturalTotal = natural.reduce((a, b) => a + b, 0) + chromeWidth(columnCount);
      const allocation = allocateWidths(natural, target);
      const output = renderTable(table, target, UNICODE_GLYPHS);

      // The rendered geometry is exactly what the allocator predicted: this is the
      // assertion that keeps the prototype's +2-per-table overshoot from returning.
      expect(maxWidth(output)).toBe(allocation.totalWidth);
      expect(maxWidth(output)).not.toBe(target + 2);

      if (allocation.fits) {
        expect(maxWidth(output)).toBeLessThanOrEqual(target);
        // A shrunk table fills the target exactly; an untouched one keeps its
        // natural geometry rather than being padded out to the target.
        expect(maxWidth(output)).toBe(naturalTotal > target ? target : naturalTotal);
      } else {
        // Sanctioned overflow only: every column is pinned at the floor.
        expect(allocation.widths).toEqual(
          Array.from({ length: columnCount }, () => MIN_COLUMN_WIDTH),
        );
        expect(maxWidth(output)).toBe(columnCount * MIN_COLUMN_WIDTH + chromeWidth(columnCount));
      }
    },
  );

  test.each(columnCounts.flatMap((n) => targets.map((w) => [n, w] as const)))(
    "%i short columns at width %i never exceed the target",
    (columnCount, target) => {
      const headers = Array.from({ length: columnCount }, (_, i) => `H${i}`);
      const rows = [Array.from({ length: columnCount }, (_, i) => `v${i}`)];
      const output = renderTable(buildTable(headers, rows), target, UNICODE_GLYPHS);
      expect(maxWidth(output)).toBeLessThanOrEqual(target);
      expect(maxWidth(output)).not.toBe(target + 2);
    },
  );
});

// --- already fits ----------------------------------------------------------

describe("renderTable already-fits case", () => {
  test("a narrow table is neither shrunk nor reflowed", () => {
    const table = buildTable(["WP", "Owner"], [["WP-3", "analyst"]]);
    const output = renderTable(table, 120, UNICODE_GLYPHS);

    expect(columnText(output, 0)).toBe("WPWP-3");
    expect(columnText(output, 1)).toBe("Owneranalyst");
    // 4 + 7 content columns + chrome(2); nothing is padded out to the target.
    expect(maxWidth(output)).toBe(4 + 7 + chromeWidth(2));
    expect(lines(output).filter((line) => line.startsWith("│")).length).toBe(2);
  });
});

// --- >= 9 columns ----------------------------------------------------------

describe("renderTable with nine or more columns", () => {
  const headers = Array.from({ length: 9 }, (_, i) => `Head${i}`);
  const rows = [Array.from({ length: 9 }, (_, i) => `value-${i}-longish`)];
  const table = buildTable(headers, rows);

  test("renders at the minimum feasible width instead of throwing at width 80", () => {
    const output = renderTable(table, 80, UNICODE_GLYPHS);
    // 9 columns cannot fit 80: 9*6 + 28 = 82. Documented, sanctioned overflow.
    expect(maxWidth(output)).toBe(82);
    expect(output).not.toContain("…");
    const grid = tableGrid(table);
    expect(allocateWidths(naturalWidths(grid.header, grid.rows), 80).fits).toBe(false);
  });

  test("fits normally once the target is wide enough", () => {
    for (const target of [100, 160]) {
      const output = renderTable(table, target, UNICODE_GLYPHS);
      expect(maxWidth(output)).toBe(target);
      expect(output).not.toContain("…");
    }
  });

  test("still keeps every column and loses nothing at width 80", () => {
    const output = renderTable(table, 80, UNICODE_GLYPHS);
    for (let index = 0; index < 9; index += 1) {
      expect(squeeze(columnText(output, index))).toContain(squeeze(`value-${index}-longish`));
      expect(squeeze(columnText(output, index))).toContain(`Head${index}`);
    }
  });
});

/**
 * The head/border styling, after it stopped being `@colors/colors`' decision — WP-2 of
 * `plans/colour-policy.md`.
 *
 * Three things are separable and each is asserted on its own: the bytes (unchanged —
 * `grey` is `90m`/`39m` and `bold` is `1m`/`22m`, exactly what the retired package's
 * `styles` record supplied), the *gate* (the resolved policy, threaded in as an argument,
 * where it used to be that package's own environment-only `enabled`), and the geometry
 * (styling wraps already-measured strings, so it must not move a column at either
 * setting).
 *
 * The gate is the change with a user-visible consequence, and it is the one Decision 1 of
 * the plan requires: at this WP's base, `mdview wide-table.md | cat` — no TTY, nothing
 * forced — emitted 205 grey pairs and 12 bold pairs into the pipe, because `cli-table3`
 * had called `colors.supportsColor()` with no stream argument and `src/table.ts` kept that
 * rule when it took the emitter over.
 */
describe("border and head styling obey the policy that is handed in", () => {
  const table = lexTable(["| Head | Other |", "|---|---|", "| a | b |", ""].join("\n"));

  test("colour off emits no escape at all", () => {
    const output = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "none");
    expect(output).not.toContain(ESC);
  });

  test("the default is colour off — a forgotten argument cannot leak styling", () => {
    expect(renderTable(table, 40, UNICODE_GLYPHS)).not.toContain(ESC);
    expect(renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE)).not.toContain(ESC);
  });

  test("colour on wraps every border piece in grey and every head cell in bold", () => {
    const output = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    expect(output).toContain(`${ESC}[90m`);
    expect(output).toContain(`${ESC}[1m`);
    // One wrap per *cell*, not one per line — the escape-sequence layout `cli-table3`
    // produced and this emitter reproduces. A three-rule, two-row 2-column table has
    // 2 pieces per rule row and 3 per content row.
    const greyOpens = output.split(`${ESC}[90m`).length - 1;
    expect(greyOpens).toBe(3 * 2 + 2 * 3);
    // Two head cells, so two bold pairs.
    expect(output.split(`${ESC}[1m`).length - 1).toBe(2);
  });

  test("styling changes no column: the two renders strip to the same text", () => {
    const plain = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "none");
    const styled = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    expect(stripAnsi(styled)).toBe(plain);
    expect(maxWidth(styled)).toBe(maxWidth(plain));
  });

  /**
   * **The table is the producer where the mode split is most visible** — WP-2 of
   * `plans/colour-modes.md`. `bold` is format-class and `gray` is hue-class, so a
   * `formats` render keeps every head cell bold and loses every grey border piece, with
   * the glyphs themselves unchanged and unmoved.
   *
   * Asserted as **exact pairs with counts**, not as "some SGR is present": the counts are
   * what fail if the filter drops the wrong class, and the `39m`/`90m` absences are what
   * fail if it drops nothing at all. This is also WP-4's axis seed in miniature — a table
   * has no paragraph `reset` framing to mask a dead filter, which is why cycle-3 f6 chose
   * it over a document-level probe.
   */
  test("`formats` keeps every bold head and drops every grey border piece", () => {
    const output = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "formats");
    // The positive arm: the same two bold pairs `full` emits, byte for byte.
    expect(output).toContain(`${ESC}[1m`);
    expect(output.split(`${ESC}[1m`).length - 1).toBe(2);
    expect(output.split(`${ESC}[22m`).length - 1).toBe(2);
    // The negative arm: grey's open and its close, named separately.
    expect(output).not.toContain(`${ESC}[90m`);
    expect(output).not.toContain(`${ESC}[39m`);
  });

  test("`formats` is neither of the other two modes — the seed is not vacuous either way", () => {
    const none = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "none");
    const formats = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "formats");
    const full = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    expect(formats).not.toBe(none);
    expect(formats).not.toBe(full);
    // And it is exactly `full` minus the grey pairs, which is the claim in byte form.
    expect(formats).toBe(full.split(`${ESC}[90m`).join("").split(`${ESC}[39m`).join(""));
  });

  test("the filter moves no column: all three modes strip to the same text and width", () => {
    const none = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, "none");
    for (const sgr of ["none", "formats", "full"] as const) {
      const output = renderTable(table, 40, UNICODE_GLYPHS, NARROW_MEASURE, sgr);
      expect(stripAnsi(output)).toBe(none);
      expect(maxWidth(output)).toBe(maxWidth(none));
    }
  });

  test("and the allocated geometry still equals the rendered geometry under colour", () => {
    const styled = renderTable(WIDE_TABLE, 100, UNICODE_GLYPHS, NARROW_MEASURE, "full");
    const grid = tableGrid(WIDE_TABLE);
    const allocation = allocateWidths(naturalWidths(grid.header, grid.rows), 100);
    expect(maxWidth(styled)).toBe(allocation.totalWidth);
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
 * `tests/wikilink.test.ts`). `src/table.ts` could not do better, because `flattenInline`
 * stringified a cell irreversibly and nothing downstream knew which characters had been a
 * label.
 *
 * The contract is `{ text, spans }`: **plain for measurement and splitting, styled at
 * emission**. `naturalWidths`, `wrapText` and `splitToken` still see nothing but `text`, so
 * no pass ever measures or cuts an escape byte; `renderGrid` applies each span **per
 * fragment**, clipped to the wrapped line, so a sequence physically cannot cross padding or
 * a border.
 *
 * **Nothing in `src/` produces a span yet** — that is WP-2's — which is exactly why this
 * battery exists. A contract whose only exercise is its own unwritten producer is a
 * contract nobody has run, so every clipping, wrapping, padding, measurement and nesting
 * path is driven here from hand-built spans, at WP-1, with exact bytes. The
 * production-empty case is proved by the rest of this file and by the env-pinned
 * render-diff: with `spans` empty the emitter's output is byte-identical.
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

  test("inline markup flattens with the link's href kept, and no cell carries a span today", () => {
    const cell = lexBodyCell(
      "| col |\n|---|\n| **bold** and `code` and [l](https://example.test/x) |\n",
    );
    const flat = flattenInline(cell.tokens, cell.text ?? "");
    expect(flat.text).toBe("bold and code and l (https://example.test/x)");
    // The production-empty half of the contract, asserted rather than assumed.
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
    // could render inside the label's cyan — see `tests/wikilink.test.ts`, C6a.
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
