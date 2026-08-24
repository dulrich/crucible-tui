import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Lexer, type Tokens } from "marked";
import stringWidth from "string-width";
import {
  MIN_COLUMN_WIDTH,
  allocateWidths,
  chromeWidth,
  naturalWidths,
  renderTable,
  tableGrid,
} from "../src/table";
// The production strip, imported rather than re-spelled — see `tests/glyphs.test.ts`.
import { stripAnsi } from "../src/list-lines";
import { UNICODE_GLYPHS } from "../src/glyphs";

// --- helpers ---------------------------------------------------------------

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
