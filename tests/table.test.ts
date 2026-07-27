import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Lexer, type Tokens } from "marked";
import stringWidth from "string-width";
import {
  MIN_COLUMN_WIDTH,
  allocateWidths,
  cellText,
  chromeWidth,
  naturalWidths,
  renderTable,
  splitToken,
  tableGrid,
  wrapText,
} from "../src/table";

// --- helpers ---------------------------------------------------------------

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

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

const LONG_PATH = "example_billing/apps/api/src/importer.test.ts";
const GATE_COMMAND = "bun run design:verify";

// --- geometry --------------------------------------------------------------

describe("width reconciliation with cli-table3's own measurement", () => {
  // cli-table3 pads cells using its bundled string-width@4, which measures U+26A0 as 1
  // column; this module and `--check` use string-width@7, which says 2. Before the
  // reconciliation pass, a table containing it rendered exactly 1 column over target.
  // Found in the wild by the vault sweep: "2026-07-15 1v1 Prep.md" line 139 at width 80.
  const WARNING_SIGN = "⚠";

  test("a table whose cell holds U+26A0 still fits the target", () => {
    const token = lexTable(
      `| Risk | Note | Owner |\n| --- | --- | --- |\n| ${WARNING_SIGN} | escalate before Friday | alex |\n`,
    );
    for (const target of [40, 60, 80, 100]) {
      expect(maxWidth(renderTable(token, target))).toBeLessThanOrEqual(target);
    }
  });

  test("the glyph itself survives — reconciliation shrinks, it never drops content", () => {
    const token = lexTable(
      `| Risk | Note |\n| --- | --- |\n| ${WARNING_SIGN} | escalate |\n`,
    );
    const output = renderTable(token, 60);
    expect(stripAnsi(output)).toContain(WARNING_SIGN);
    expect(output).not.toContain("…");
  });

  test("a table with no such glyph is not shrunk by the reconciliation pass", () => {
    const token = lexTable("| A | B |\n| --- | --- |\n| one | two |\n");
    const before = renderTable(token, 80);
    expect(maxWidth(before)).toBeLessThanOrEqual(80);
    // Plain ASCII content: cli-table3 and string-width@7 agree, so the first build is
    // already correct and the output must be byte-identical across repeated renders.
    expect(renderTable(token, 80)).toBe(before);
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
    expect(grid.rows.map((row) => row[0])).toEqual([
      "bun run design:verify",
      "bold and em",
      "a < b & c",
      "[[wiki-slug]]",
    ]);
    for (const row of grid.rows) expect(row[0]).not.toContain(ESC);
  });

  test("keeps both a link's label and its href", () => {
    const table = buildTable(["A"], [["[label](https://example.test/x)"]]);
    const cell = table.rows[0]?.[0];
    expect(cell).toBeDefined();
    expect(cellText(cell as Tokens.TableCell)).toBe("label (https://example.test/x)");
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
    const output = renderTable(WIDE_TABLE, target);
    for (const line of lines(output)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(target);
    }
    expect(maxWidth(output)).toBe(target);
  });
});

describe("renderTable losslessness", () => {
  test.each([80, 100, 160])("emits no ellipsis at width %i", (target) => {
    expect(renderTable(WIDE_TABLE, target)).not.toContain("…");
  });

  test.each([80, 100, 160])("keeps every long token in full at width %i", (target) => {
    const output = renderTable(WIDE_TABLE, target);
    expect(squeeze(columnText(output, 0))).toContain(squeeze(GATE_COMMAND));
    expect(squeeze(columnText(output, 1))).toContain(
      squeeze("skills/project-setup/references/gitignore/"),
    );
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

    const output = renderTable(table, 80);
    expect(output).toContain("WP");
    expect(output).toContain("Detail");
    expect(columnText(output, 0)).toContain(narrow);
    expect(maxWidth(output)).toBe(80);
  });

  test("a long unbreakable token beside a narrow column does not starve it", () => {
    const table = buildTable(["WP", "Path"], [[narrow, `${LONG_PATH}${LONG_PATH}${LONG_PATH}`]]);
    const output = renderTable(table, 40);
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
    const output = renderTable(table, 80);
    const bodyLine = lines(output).filter((line) => line.startsWith("│")).at(-1) ?? "";

    const left = pads(bodyLine, 0);
    const center = pads(bodyLine, 1);
    const right = pads(bodyLine, 2);

    expect(left.left).toBeLessThan(left.right);
    expect(Math.abs(center.left - center.right)).toBeLessThanOrEqual(1);
    expect(right.left).toBeGreaterThan(right.right);
  });
});

// --- CJK + emoji -----------------------------------------------------------

describe("renderTable CJK and emoji", () => {
  test.each([80, 100, 160])(
    "column rules land on identical display columns at width %i",
    (target) => {
      const output = renderTable(WIDE_TABLE, target);
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
    const output = renderTable(table, 40);
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
      const output = renderTable(table, target);

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
      const output = renderTable(buildTable(headers, rows), target);
      expect(maxWidth(output)).toBeLessThanOrEqual(target);
      expect(maxWidth(output)).not.toBe(target + 2);
    },
  );
});

// --- already fits ----------------------------------------------------------

describe("renderTable already-fits case", () => {
  test("a narrow table is neither shrunk nor reflowed", () => {
    const table = buildTable(["WP", "Owner"], [["WP-3", "analyst"]]);
    const output = renderTable(table, 120);

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
    const output = renderTable(table, 80);
    // 9 columns cannot fit 80: 9*6 + 28 = 82. Documented, sanctioned overflow.
    expect(maxWidth(output)).toBe(82);
    expect(output).not.toContain("…");
    const grid = tableGrid(table);
    expect(allocateWidths(naturalWidths(grid.header, grid.rows), 80).fits).toBe(false);
  });

  test("fits normally once the target is wide enough", () => {
    for (const target of [100, 160]) {
      const output = renderTable(table, target);
      expect(maxWidth(output)).toBe(target);
      expect(output).not.toContain("…");
    }
  });

  test("still keeps every column and loses nothing at width 80", () => {
    const output = renderTable(table, 80);
    for (let index = 0; index < 9; index += 1) {
      expect(squeeze(columnText(output, index))).toContain(squeeze(`value-${index}-longish`));
      expect(squeeze(columnText(output, index))).toContain(`Head${index}`);
    }
  });
});
