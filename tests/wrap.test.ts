import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { link as osc8Link, scan } from "../src/ansi";
// The production strip, imported rather than re-spelled — see `tests/glyphs.test.ts`.
import { stripAnsi } from "../src/list-lines";
import { graphemes, wrapAnsi } from "../src/wrap";

// Built via `String.fromCharCode`, not a literal control byte or a `\x1b` source
// escape, matching the convention already used in `tests/table-normalization.test.ts`
// and `tests/table-emission.test.ts` (since split).
const ESC = String.fromCharCode(27);

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
      // terminating "m"), and no line may carry a sequence the scanner cannot parse.
      expect(line).not.toMatch(/\[[0-9;]*$/);
      expect(scan(line).malformed).toBe(false);
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

// WP-3 of `plans/colour-policy.md`. `wrapAnsi` used to carry its own SGR-only tokenizer,
// so a labelled hyperlink crossing the budget was chunked *mid-sequence* — a 26-character
// label at width 10 came apart as `ESC ]8;;https:` / `//x BEL abcdefg`, and the two halves
// shipped to the terminal as text. Both split paths consume `src/ansi.ts`'s spans now, so
// every sequence kind is atomic on both of them. The pins below are one per kind × both
// paths (a token that fits, and one that must be hard-split), plus width 1, which is where
// the hard split is exercised on every single grapheme.
describe("wrapAnsi — every sequence kind is atomic, on both split paths", () => {
  const kinds: Array<[string, (label: string) => string]> = [
    ["SGR", styled],
    ["OSC-8, BEL-terminated", (label) => osc8Link(label, "https://example.invalid/a")],
    [
      "OSC-8, ST-terminated",
      (label) => `${ESC}]8;;https://example.invalid/a${ESC}\\${label}${ESC}]8;;${ESC}\\`,
    ],
    ["tmux DCS", (label) => osc8Link(label, "https://example.invalid/a", true)],
  ];

  for (const [name, wrap] of kinds) {
    test(`${name}: a labelled run crossing the budget is never cut mid-sequence`, () => {
      const text = `intro ${wrap("abcdefghijklmnopqrstuvwxyz")} outro`;
      for (const width of [1, 4, 10, 26, 40]) {
        for (const line of wrapAnsi(text, width)) {
          expect(scan(line).malformed).toBe(false);
        }
        expect(stripAnsi(wrapAnsi(text, width).join("")).replace(/\s+/g, "")).toBe(
          "introabcdefghijklmnopqrstuvwxyzoutro",
        );
      }
    });

    test(`${name}: a label that fits is placed whole, sequences included`, () => {
      const [line] = wrapAnsi(`x ${wrap("ab")} y`, 40);
      expect(line).toBe(`x ${wrap("ab")} y`);
      expect(scan(line as string).malformed).toBe(false);
    });

    test(`${name}: the visible budget is honoured, not the byte count`, () => {
      // The failure this pins: measuring the raw bytes of a wrapped sequence puts a line
      // that is six columns wide over a budget of ten, and the wrap splits text that
      // never needed splitting.
      for (const line of wrapAnsi(`${wrap("abcdef")} ${wrap("ghijkl")}`, 13)) {
        expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(13);
      }
    });
  }

  test("an escape-only run does not become a zero-width word — the repair, at the seam", () => {
    // Repair 3: a run of sequences with no visible text between two spaces used to be
    // placed like a word — consuming the pending space, contributing no columns, and
    // leaving a trailing space the colourless render never had.
    const lines = wrapAnsi(`recorded at ${ESC}[34m${ESC}[4m ${"u".repeat(40)}`, 20);
    for (const line of lines) expect(line).toBe(line.replace(/ $/, ""));
    expect(stripAnsi(lines.join("\n"))).toContain("recorded at");
    // Nothing is dropped: the carried bytes are emitted with the next visible piece.
    expect(lines.join("")).toContain(`${ESC}[34m${ESC}[4m`);
  });

  test("a line that is nothing but sequences survives as itself", () => {
    expect(wrapAnsi(`${ESC}[0m`, 20)).toEqual([`${ESC}[0m`]);
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
