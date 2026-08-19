import { describe, expect, test } from "bun:test";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import type { SgrMode } from "../src/colour";
import { createLayoutContext, createPrefixColumns } from "../src/layout-context";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";

const base = {
  width: 100,
  glyphs: UNICODE_GLYPHS,
  measure: NARROW_MEASURE,
  resolveFenceLanguage: (raw: string | undefined): string | undefined => raw,
  emoji: true,
  sgr: "none" as const,
};

describe("LayoutContext", () => {
  test("carries the values the review specified, unaltered", () => {
    const ctx = createLayoutContext({ ...base, glyphs: ASCII_GLYPHS, measure: WIDE_MEASURE });
    expect(ctx.width).toBe(100);
    expect(ctx.glyphs).toBe(ASCII_GLYPHS);
    expect(ctx.measure).toBe(WIDE_MEASURE);
    expect(ctx.measure.ambiguous).toBe("wide");
    expect(ctx.emoji).toBe(true);
    expect(ctx.sgr).toBe("none");
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

/**
 * **The derived-field invariant** — WP-2 of `plans/colour-modes.md` (cycle-1 f7).
 *
 * `LayoutContext` carries the canonical `sgr` and keeps `color` as a *derived* boolean:
 * `color === (sgr !== "none")`, computed in `createLayoutContext` and accepted from nobody.
 * The failure this forecloses is `color: false, sgr: "full"` — two independent inputs that
 * can disagree about the same decision, inside the one value every visitor in the renderer
 * trusts without re-checking. `LayoutContextInit` has no `color` field at all, so the
 * disagreement is not merely untested but unconstructible; this is the runtime half of that
 * claim, asserted for **all three** modes rather than for the two a boolean has.
 */
describe("LayoutContext.color is derived from sgr, never accepted", () => {
  const modes: Array<[SgrMode, boolean]> = [
    ["full", true],
    ["formats", true],
    ["none", false],
  ];

  for (const [sgr, expected] of modes) {
    test(`sgr "${sgr}" derives color ${String(expected)}`, () => {
      const ctx = createLayoutContext({ ...base, sgr });
      expect(ctx.sgr).toBe(sgr);
      expect(ctx.color).toBe(expected);
      expect(ctx.color).toBe(ctx.sgr !== "none");
    });
  }

  test("`formats` is on the colour side of the boolean, which is the whole point of it", () => {
    // The mode exists to keep emitting — formats and control — so a reader still using the
    // `sgr !== "none"` threshold must see `true` here. A derivation that folded `formats`
    // in with `none` would silently turn every such reader off.
    expect(createLayoutContext({ ...base, sgr: "formats" }).color).toBe(true);
  });

  test("the derived field cannot be overwritten after construction", () => {
    const ctx = createLayoutContext({ ...base, sgr: "full" });
    expect(() => {
      (ctx as unknown as { color: boolean }).color = false;
    }).toThrow();
    expect(ctx.color).toBe(true);
  });

  test("an init object carrying a stray `color` cannot reach the context", () => {
    // Belt and braces on the type: a caller that casts past `LayoutContextInit` still gets
    // the derived answer, because `createLayoutContext` never reads that key.
    const ctx = createLayoutContext({ ...base, sgr: "full", color: false } as unknown as Parameters<
      typeof createLayoutContext
    >[0]);
    expect(ctx.color).toBe(true);
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

  test("pops back to exactly where it was, which is what the finally blocks rely on", () => {
    const stack = createPrefixColumns();
    stack.push({ columns: 6, list: true });
    const before = { width: stack.width(), depth: stack.listDepth() };
    stack.push({ columns: 4, list: false });
    stack.pop();
    expect(stack.width()).toBe(before.width);
    expect(stack.listDepth()).toBe(before.depth);
  });

  test("popping an empty stack is harmless", () => {
    const stack = createPrefixColumns();
    stack.pop();
    expect(stack.width()).toBe(0);
  });
});
