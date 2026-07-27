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

  test("captures a real message for an unsupported fence language under forced color", async () => {
    const { messages } = await renderWithForcedColor(unsupportedLangFence, 80);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).toMatch(/dataviewjs/i);
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
