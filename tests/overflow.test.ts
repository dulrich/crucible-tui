import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findFirstOverflow, isLineExempt } from "../src/overflow";
import { findListOrphans } from "../src/detectors";
import { main } from "../src/cli";
import { sweepCorpus, type CorpusSpec, type SweepOptions } from "../scripts/sweep";
import { renderDocumentDetailed } from "../src/render";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { NARROW_MEASURE } from "../src/width";

// ---------------------------------------------------------------------------
// WP-2 (plans/tn-review-remediation.md): the width gate used to exist three times —
// `checkOverflow` in src/cli.ts, `findOverflow` in scripts/sweep.ts, and a third copy
// of the code-range predicate in src/detectors.ts. This file pins the canonical
// implementation and, more importantly, pins that **both** gate entry points reach it:
// the CLI's copy was previously verified only by proxy through the sweep's, which is
// exactly the situation in which two implementations drift unnoticed.
// ---------------------------------------------------------------------------

const fixture = (name: string): string => `${import.meta.dir}/fixtures/${name}`;

describe("isLineExempt", () => {
  test("a range's start and end lines are both inclusive", () => {
    expect(isLineExempt(3, [[3, 5]])).toBe(true);
    expect(isLineExempt(5, [[3, 5]])).toBe(true);
    expect(isLineExempt(4, [[3, 5]])).toBe(true);
  });

  test("the lines either side of a range are not exempt", () => {
    expect(isLineExempt(2, [[3, 5]])).toBe(false);
    expect(isLineExempt(6, [[3, 5]])).toBe(false);
  });

  test("a single-line range exempts exactly that line", () => {
    expect(isLineExempt(7, [[7, 7]])).toBe(true);
    expect(isLineExempt(8, [[7, 7]])).toBe(false);
  });

  test("an empty range array exempts nothing", () => {
    expect(isLineExempt(1, [])).toBe(false);
    expect(isLineExempt(9999, [])).toBe(false);
  });

  test("several ranges, including overlapping ones, are all honoured", () => {
    const ranges: Array<[number, number]> = [
      [2, 4],
      [3, 9],
      [20, 21],
    ];
    expect(isLineExempt(1, ranges)).toBe(false);
    expect(isLineExempt(2, ranges)).toBe(true);
    expect(isLineExempt(9, ranges)).toBe(true);
    expect(isLineExempt(10, ranges)).toBe(false);
    expect(isLineExempt(20, ranges)).toBe(true);
    expect(isLineExempt(22, ranges)).toBe(false);
  });

  test("the detectors' opt-in `codeRanges` still means 'exempt nothing' when omitted", () => {
    // The one asymmetry WP-2 had to preserve rather than flatten: `isLineExempt` takes a
    // required array, and `src/detectors.ts` decides at its own boundary what "no ranges
    // supplied" means, because `DetectorOptions.codeRanges` is opt-in and turning it on
    // would move `findListOrphans`' frozen historical counts.
    const rendered = ["  • a bullet item whose text runs on and on and on and then", "    wraps", "  • next"].join("\n");
    const withoutRanges = findListOrphans(rendered, 64);
    expect(findListOrphans(rendered, 64, {})).toEqual(withoutRanges);
    expect(findListOrphans(rendered, 64, { codeRanges: [] })).toEqual(withoutRanges);
  });
});

describe("findFirstOverflow", () => {
  const wideLine = "x".repeat(200);

  test("flags an over-width line outside any code range", () => {
    expect(findFirstOverflow(`short\n${wideLine}\nshort`, 80, [])).toEqual({ line: 2, width: 200 });
  });

  test("does not flag that line when it falls inside a codeRanges entry", () => {
    expect(findFirstOverflow(`short\n${wideLine}\nshort`, 80, [[2, 2]])).toBeNull();
  });

  test("returns null when every line fits", () => {
    expect(findFirstOverflow("short\nalso short", 80, [])).toBeNull();
  });

  test("returns the FIRST overflow, not all of them — that is the contract", () => {
    const output = `short\n${wideLine}\n${"y".repeat(300)}`;
    expect(findFirstOverflow(output, 80, [])).toEqual({ line: 2, width: 200 });
  });

  test("skips an exempt first overflow and reports the next non-exempt one", () => {
    const output = `${wideLine}\n${"y".repeat(300)}`;
    expect(findFirstOverflow(output, 80, [[1, 1]])).toEqual({ line: 2, width: 300 });
  });

  test("measures with the `Measure` it is given, not a fresh default", () => {
    // A ruler that counts every character as two columns: the same line that fits under
    // the default must overflow under this one. A check measured with a different ruler
    // than the allocation used is asserting something else entirely.
    const doubleWide = ((text: string) => text.length * 2) as unknown as Parameters<typeof findFirstOverflow>[3];
    const output = "0123456789";
    expect(findFirstOverflow(output, 15, [])).toBeNull();
    expect(findFirstOverflow(output, 15, [], doubleWide)).toEqual({ line: 1, width: 20 });
  });
});

describe("both width-gate entry points run the one implementation", () => {
  // `tests/witnesses.test.ts` used to claim it exercised "the same check `--check`/the
  // sweep actually run" while importing only the sweep's copy. This is what makes that
  // claim true: the CLI's `--check` and `sweepCorpus` are driven over the same document
  // at the same width, and both are compared against `findFirstOverflow` directly.
  const source = readFileSync(fixture("wide-table.md"), "utf8");
  // wide-table.md at 40 columns overflows in both glyph tiers (a 9+-column table at its
  // minimum feasible width — the documented accepted case), so the two entry points have
  // something to agree about rather than agreeing on `null`.
  const width = 40;

  test("the CLI's --check reports exactly what findFirstOverflow returns", async () => {
    const expected = findFirstOverflow(
      renderDocumentDetailed(source, width, UNICODE_GLYPHS, NARROW_MEASURE).text,
      width,
      renderDocumentDetailed(source, width, UNICODE_GLYPHS, NARROW_MEASURE).codeRanges,
      NARROW_MEASURE,
    );
    expect(expected).not.toBeNull();

    const env = process.env;
    const configHome = await mkdtemp(join(tmpdir(), "mdview-overflow-"));
    process.env = { ...env, MDVIEW_GLYPHS: "unicode", MDVIEW_AMBIGUOUS: "narrow", XDG_CONFIG_HOME: configHome };
    try {
      await expect(main(["--check", "--width", String(width), "--no-pager", fixture("wide-table.md")])).rejects.toThrow(
        `line ${expected?.line} exceeds target width ${width} (measured ${expected?.width})`,
      );
    } finally {
      process.env = env;
      await rm(configHome, { recursive: true, force: true });
    }
  });

  test("the sweep reports exactly what findFirstOverflow returns, for the same document", async () => {
    const { text, codeRanges } = renderDocumentDetailed(source, width, UNICODE_GLYPHS, NARROW_MEASURE);
    const expected = findFirstOverflow(text, width, codeRanges, NARROW_MEASURE);

    const root = await mkdtemp(join(tmpdir(), "mdview-overflow-corpus-"));
    try {
      await writeFile(join(root, "wide-table.md"), source, "utf8");
      const spec: CorpusSpec = { name: "one-file", root, walkAll: true };
      const options: SweepOptions = { widths: [width], all: true, glyphs: UNICODE_GLYPHS, detect: false };
      const result = await sweepCorpus(spec, options);
      expect(result.overflow).toHaveLength(1);
      expect(result.overflow[0]?.line).toBe(expected?.line ?? 0);
      expect(result.overflow[0]?.width).toBe(expected?.width ?? 0);
      expect(result.overflow[0]?.targetWidth).toBe(width);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("both entry points agree that the same document is clean at its --check gate width", async () => {
    // The gate the repo actually runs (`--check --width 80 tests/fixtures/wide-table.md`).
    const { text, codeRanges } = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, NARROW_MEASURE);
    expect(findFirstOverflow(text, 80, codeRanges, NARROW_MEASURE)).toBeNull();

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    const env = process.env;
    const configHome = await mkdtemp(join(tmpdir(), "mdview-overflow-"));
    process.env = { ...env, MDVIEW_GLYPHS: "unicode", MDVIEW_AMBIGUOUS: "narrow", XDG_CONFIG_HOME: configHome };
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await main(["--check", "--width", "80", "--no-pager", fixture("wide-table.md")]);
    } finally {
      process.stdout.write = original;
      process.env = env;
      await rm(configHome, { recursive: true, force: true });
    }
    expect(chunks.join("")).toBe(text);
  });
});
