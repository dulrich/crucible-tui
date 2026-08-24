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

/** Padded cell segments (content plus its left/right padding) for one body line. */
function segments(line: string): string[] {
  if (!line.startsWith("│")) return [];
  return line.split("│").slice(1, -1);
}

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
