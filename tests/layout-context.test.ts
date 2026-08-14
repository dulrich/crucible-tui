import { describe, expect, test } from "bun:test";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { createLayoutContext, createPrefixColumns } from "../src/layout-context";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";

const base = {
  width: 100,
  glyphs: UNICODE_GLYPHS,
  measure: NARROW_MEASURE,
  resolveFenceLanguage: (raw: string | undefined): string | undefined => raw,
  emoji: true,
  color: false,
};

describe("LayoutContext", () => {
  test("carries the values the review specified, unaltered", () => {
    const ctx = createLayoutContext({ ...base, glyphs: ASCII_GLYPHS, measure: WIDE_MEASURE });
    expect(ctx.width).toBe(100);
    expect(ctx.glyphs).toBe(ASCII_GLYPHS);
    expect(ctx.measure).toBe(WIDE_MEASURE);
    expect(ctx.measure.ambiguous).toBe("wide");
    expect(ctx.emoji).toBe(true);
    expect(ctx.color).toBe(false);
  });

  test("is frozen, so no visitor can re-point the width or the ruler mid-document", () => {
    const ctx = createLayoutContext(base);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as unknown as { width: number }).width = 40;
    }).toThrow();
    expect(ctx.width).toBe(100);
  });

  test("hands out a fresh prefix stack per context, never a shared one", () => {
    const first = createLayoutContext(base);
    const second = createLayoutContext(base);
    first.prefix.push({ columns: 6, list: true });
    expect(first.prefix.width()).toBe(6);
    expect(second.prefix.width()).toBe(0);
  });

  test("exposes the fence-language resolver as a field rather than an import", () => {
    const ctx = createLayoutContext({ ...base, resolveFenceLanguage: () => "plaintext" });
    expect(ctx.resolveFenceLanguage("dataviewjs")).toBe("plaintext");
  });
});

describe("PrefixColumns", () => {
  test("sums every level's owed columns", () => {
    const stack = createPrefixColumns();
    expect(stack.width()).toBe(0);
    stack.push({ columns: 6, list: true });
    stack.push({ columns: 4, list: false });
    stack.push({ columns: 7, list: true });
    expect(stack.width()).toBe(17);
  });

  test("counts list levels separately from the columns they contribute", () => {
    const stack = createPrefixColumns();
    stack.push({ columns: 6, list: true });
    stack.push({ columns: 4, list: false });
    stack.push({ columns: 7, list: true });
    expect(stack.listDepth()).toBe(2);
  });

  test("outerColumns excludes list levels, which the list budget counts itself", () => {
    const stack = createPrefixColumns();
    stack.push({ columns: 6, list: true });
    stack.push({ columns: 4, list: false });
    stack.push({ columns: 7, list: true });
    // Only the blockquote's four columns; double-counting the list levels here would
    // narrow every nested list twice.
    expect(stack.outerColumns()).toBe(4);
  });

  test("pops back to exactly where it was, which is what the finally blocks rely on", () => {
    const stack = createPrefixColumns();
    stack.push({ columns: 6, list: true });
    const before = { width: stack.width(), depth: stack.listDepth(), outer: stack.outerColumns() };
    stack.push({ columns: 4, list: false });
    stack.pop();
    expect(stack.width()).toBe(before.width);
    expect(stack.listDepth()).toBe(before.depth);
    expect(stack.outerColumns()).toBe(before.outer);
  });

  test("popping an empty stack is harmless", () => {
    const stack = createPrefixColumns();
    stack.pop();
    expect(stack.width()).toBe(0);
  });
});
