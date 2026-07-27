import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { graphemes, wrapAnsi } from "../src/wrap";

// Built via `String.fromCharCode`, not a literal control byte or a `\x1b` source
// escape, matching the convention already used in `tests/table.test.ts`.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");

function styled(label: string): string {
  return `${ESC}[36m${ESC}[4m${label}${ESC}[24m${ESC}[39m`;
}

describe("wrapAnsi — plain text", () => {
  test("wraps at the budget; no line exceeds it", () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapAnsi(text, 20);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(20);
    }
  });

  test("lossless: every visible character survives, in order", () => {
    const text = "the quick brown fox jumps over the lazy dog and then some more words";
    const lines = wrapAnsi(text, 15);
    const rejoined = lines.join(" ").replace(/\s+/g, " ").trim();
    const original = text.replace(/\s+/g, " ").trim();
    expect(rejoined).toBe(original);
    expect(lines.join("")).not.toContain("…");
  });
});

describe("wrapAnsi — escape sequences", () => {
  test("a styled long token is never cut mid-escape", () => {
    const longPath = "a".repeat(120);
    const text = `intro text ${styled(longPath)} outro text`;
    const lines = wrapAnsi(text, 40);

    for (const line of lines) {
      // No line may end with a truncated escape-sequence opener (missing its
      // terminating "m"), and no line may contain a bare ESC without one.
      expect(line).not.toMatch(/\[[0-9;]*$/);
      const escOpeners = line.split(ESC).length - 1;
      const completeEscapes = (line.match(ANSI) ?? []).length;
      expect(completeEscapes).toBe(escOpeners);
    }
  });

  test("stripping ANSI yields every visible character of the input, in order", () => {
    // A hard-split token legitimately gets no inter-piece space reinserted (that
    // space never existed in the source token), so compare with *all* whitespace
    // removed on both sides — the contract is "no visible character lost or
    // reordered", not "identical spacing after a forced line break".
    const longPath = "/very/long/path/that/needs/hard/splitting/because/it/has/no/spaces/at/all";
    const text = `see ${styled(longPath)} for details`;
    const lines = wrapAnsi(text, 20);
    const rejoined = stripAnsi(lines.join("")).replace(/\s+/g, "");
    expect(rejoined).toBe(`see ${longPath} for details`.replace(/\s+/g, ""));
    expect(rejoined).not.toContain("…");
  });
});

describe("wrapAnsi — CJK and emoji", () => {
  test("never exceeds the budget and never splits an emoji", () => {
    const text = "你好世界 😀😃😄😁 你好世界 😀😃😄😁 你好世界 😀😃😄😁";
    const lines = wrapAnsi(text, 12);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(12);
    }
    const beforeGraphemes = graphemes(text.replace(/\s+/g, ""));
    const afterGraphemes = graphemes(lines.join("").replace(/\s+/g, ""));
    expect(afterGraphemes).toEqual(beforeGraphemes);
  });
});

describe("wrapAnsi — edge cases", () => {
  test("width 1 does not hang or throw", () => {
    expect(() => wrapAnsi("hello world", 1)).not.toThrow();
    const lines = wrapAnsi("hello world", 1);
    expect(lines.length).toBeGreaterThan(0);
  });

  test("empty string input does not hang or throw", () => {
    expect(() => wrapAnsi("", 40)).not.toThrow();
    expect(wrapAnsi("", 40)).toEqual([""]);
  });
});
