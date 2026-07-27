import { describe, expect, test } from "bun:test";
import { findOverflow, resolveCorpusFiles, strideSample } from "../scripts/sweep";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocumentDetailed } from "../src/render";

describe("strideSample", () => {
  const items = Array.from({ length: 1000 }, (_, index) => `path-${String(index).padStart(4, "0")}.md`);

  test("returns exactly `limit` entries from a 1000-item list", () => {
    expect(strideSample(items, 300)).toHaveLength(300);
  });

  test("is deterministic across repeated calls", () => {
    expect(strideSample(items, 300)).toEqual(strideSample(items, 300));
  });

  test("spans the whole sorted list — first and last are represented", () => {
    const sorted = [...items].sort();
    const sample = strideSample(items, 300);
    expect(sample[0]).toBe(sorted[0]);
    expect(sample[sample.length - 1]).toBe(sorted[sorted.length - 1]);
  });

  test("does not simply take the first N (regression guard against scan-order bias)", () => {
    const sorted = [...items].sort();
    const firstN = sorted.slice(0, 300);
    const sample = strideSample(items, 300);
    expect(sample).not.toEqual(firstN);
  });

  test("returns the full list unchanged when it is already at or below the limit", () => {
    const small = items.slice(0, 50);
    expect(strideSample(small, 300)).toEqual([...small].sort());
  });
});

describe("findOverflow", () => {
  const wideLine = "x".repeat(200);

  test("flags an over-width line outside any code range", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findOverflow(output, 80, []);
    expect(found).toEqual({ line: 2, width: 200 });
  });

  test("does not flag the same over-width line when it falls inside a codeRanges entry", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findOverflow(output, 80, [[2, 2]]);
    expect(found).toBeNull();
  });

  test("returns null when every line fits", () => {
    const output = "short\nalso short";
    expect(findOverflow(output, 80, [])).toBeNull();
  });
});

describe("resolveCorpusFiles", () => {
  test("a missing corpus root resolves to null (skip, not fail)", async () => {
    const files = await resolveCorpusFiles({
      name: "missing",
      root: "/definitely/does/not/exist/on/this/machine",
      walkAll: true,
    });
    expect(files).toBeNull();
  });
});

describe("renderWithForcedColor", () => {
  const unsupportedLangFence = "```dataviewjs\nconsole.log(1)\n```\n";

  // DEVIATION, WP-3: this assertion is flipped from WP-1's original. `dataviewjs` used
  // to leak a highlight.js "language not found" diagnostic even under forced color —
  // that was the very bug this harness was built to make visible (see the module doc
  // comment in `tests/helpers/color.ts`). WP-3 fixes it: every fence language is now
  // normalized to one `cli-highlight` supports before it reaches the gated `highlight()`
  // path (`src/lang.ts`), so no fence language reaches stderr any more, not even this
  // one, not even under forced color. Leaving the old assertion in place would mean
  // this test only passes when the bug it exists to catch is still present — i.e. it
  // would now fail forever by design, not by defect. A positive control proving the
  // console.error capture mechanism itself still works when a message *is* genuinely
  // emitted (calling `cli-highlight` directly, bypassing the now-total normalization)
  // lives in `tests/render.test.ts`, so this flip cannot pass vacuously.
  test("a fence language that used to leak a highlight.js diagnostic under forced color now captures nothing (WP-3)", async () => {
    const { messages } = await renderWithForcedColor(unsupportedLangFence, 80);
    expect(messages).toEqual([]);
  });

  test("the normal (non-forced) render path captures nothing for the same input", () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      renderDocumentDetailed(unsupportedLangFence, 80);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
    expect(captured).toHaveLength(0);
  });
});
