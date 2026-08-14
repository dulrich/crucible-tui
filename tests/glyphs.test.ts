import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { ASCII_GLYPHS, UNICODE_GLYPHS, resolveGlyphs } from "../src/glyphs";
import { renderDocument, renderDocumentDetailed } from "../src/render";

// Deliberately matching the ESC control character to strip ANSI SGR codes so
// assertions can check plain rendered text.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

// --- resolveGlyphs precedence ------------------------------------------------

describe("resolveGlyphs — precedence", () => {
  test("explicit override beats MDVIEW_GLYPHS", () => {
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "unicode" }, "ascii")).toBe(ASCII_GLYPHS);
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "ascii" }, "unicode")).toBe(UNICODE_GLYPHS);
  });

  test("MDVIEW_GLYPHS beats detection", () => {
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "ascii", LANG: "en_US.UTF-8", TERM: "xterm-256color" })).toBe(
      ASCII_GLYPHS,
    );
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "unicode", LANG: "C", TERM: "linux" })).toBe(UNICODE_GLYPHS);
  });

  test("a garbage MDVIEW_GLYPHS value falls through to detection instead of throwing", () => {
    expect(() =>
      resolveGlyphs({ MDVIEW_GLYPHS: "bogus", LANG: "en_US.UTF-8", TERM: "xterm-256color" }),
    ).not.toThrow();
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "bogus", LANG: "en_US.UTF-8", TERM: "xterm-256color" })).toBe(
      UNICODE_GLYPHS,
    );
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "AUTO", LANG: "C", TERM: "linux" })).toBe(ASCII_GLYPHS);
  });
});

// --- detection truth table --------------------------------------------------

describe("resolveGlyphs — auto-detection truth table", () => {
  test("UTF-8 locale + a capable TERM -> unicode", () => {
    expect(resolveGlyphs({ LANG: "en_US.UTF-8", TERM: "xterm-256color" })).toBe(UNICODE_GLYPHS);
  });

  test("TERM=linux with a UTF-8 locale -> ascii", () => {
    expect(resolveGlyphs({ LANG: "en_US.UTF-8", TERM: "linux" })).toBe(ASCII_GLYPHS);
  });

  test("LC_ALL=C -> ascii", () => {
    expect(resolveGlyphs({ LC_ALL: "C", TERM: "xterm-256color" })).toBe(ASCII_GLYPHS);
  });

  test("empty env -> ascii", () => {
    expect(resolveGlyphs({})).toBe(ASCII_GLYPHS);
  });

  test("LC_ALL beats LANG", () => {
    expect(resolveGlyphs({ LC_ALL: "C", LANG: "en_US.UTF-8", TERM: "xterm-256color" })).toBe(
      ASCII_GLYPHS,
    );
    expect(resolveGlyphs({ LC_ALL: "en_US.UTF-8", LANG: "C", TERM: "xterm-256color" })).toBe(
      UNICODE_GLYPHS,
    );
  });

  test("a missing/empty TERM is treated as not-in-the-dumb-list, so locale alone decides", () => {
    expect(resolveGlyphs({ LANG: "en_US.UTF-8" })).toBe(UNICODE_GLYPHS);
    expect(resolveGlyphs({ LANG: "en_US.UTF-8", TERM: "" })).toBe(UNICODE_GLYPHS);
  });

  test("every known-dumb TERM forces ascii even under a UTF-8 locale", () => {
    for (const term of ["linux", "dumb", "vt100", "vt220", "ansi"]) {
      expect(resolveGlyphs({ LANG: "en_US.UTF-8", TERM: term })).toBe(ASCII_GLYPHS);
    }
  });
});

// --- bullet cycling ----------------------------------------------------------

describe("bullet cycling by nesting depth", () => {
  function bulletAtDepth(depth: number): string {
    const nested = Array.from({ length: depth }, (_, index) => `${"  ".repeat(index)}- level ${index}`);
    const output = stripAnsi(renderDocument(nested.join("\n"), 80));
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    const target = lines[depth - 1] ?? "";
    const match = /\S/.exec(target.trimStart());
    return match ? match[0] : "";
  }

  test("depth 1, 2, 3 cycle through the three configured bullets", () => {
    expect(bulletAtDepth(1)).toBe("•");
    expect(bulletAtDepth(2)).toBe("◦");
    expect(bulletAtDepth(3)).toBe("‣");
  });

  test("depth 4 wraps back to the first bullet", () => {
    expect(bulletAtDepth(4)).toBe("•");
  });

  test("under the ASCII tier every depth uses '-'", () => {
    const nested = ["- one", "  - two", "    - three", "      - four"].join("\n");
    const output = stripAnsi(renderDocument(nested, 80, ASCII_GLYPHS));
    for (const line of output.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("-")) expect(trimmed[0]).toBe("-");
    }
    expect(output).not.toContain("•");
    expect(output).not.toContain("◦");
    expect(output).not.toContain("‣");
  });
});

// --- regression: fenced/indented code nested inside a list item must never be
// touched (caught in review) --------------------------------------------------

// `src/AGENTS.md`'s rendering policy is unqualified: fenced code is never
// rewritten — a wrapped or altered command is a wrong command. `substituteBullets`
// initially rewrote `* `/bare-`*` content inside a fence nested in a list item,
// because it walked the fully-resolved list body with no awareness that part of that
// body is code the `code` override already bracketed in `SENTINEL` pairs. No existing
// gate caught it: `--check` and both sweeps exempt code ranges from width checking, so
// corrupting a line *inside* one is invisible to a width-only gate.
describe("bullet substitution never touches fenced/indented code nested in a list item", () => {
  const FENCED_IN_LIST = [
    "- item one",
    "",
    "    ```bash",
    "    * not a bullet",
    "    ls *.md",
    "    ```",
    "",
    "- item two",
    "",
  ].join("\n");

  test("a fenced code block's '* not a bullet' and 'ls *.md' survive literally under the Unicode tier", () => {
    const { text, codeRanges } = renderDocumentDetailed(FENCED_IN_LIST, 80, UNICODE_GLYPHS);
    expect(codeRanges.length).toBeGreaterThan(0);
    expect(text).toContain("* not a bullet");
    expect(text).toContain("ls *.md");
    // The real markers (the two actual list items) still get substituted — this is
    // not "substitution stopped working everywhere", only inside the fence.
    expect(text).toContain("• item one");
    expect(text).toContain("• item two");
  });

  test("the same fence survives literally under the ASCII tier", () => {
    const { text } = renderDocumentDetailed(FENCED_IN_LIST, 80, ASCII_GLYPHS);
    expect(text).toContain("* not a bullet");
    expect(text).toContain("ls *.md");
    expect(text).toContain("- item one");
    expect(text).toContain("- item two");
  });

  const INDENTED_IN_LIST = [
    "- item one",
    "",
    "        * not a bullet",
    "        ls *.md",
    "",
    "- item two",
    "",
  ].join("\n");

  test("an indented (4-space) code block nested in a list item also survives literally, if it reaches substituteBullets", () => {
    const { text, codeRanges } = renderDocumentDetailed(INDENTED_IN_LIST, 80, UNICODE_GLYPHS);
    // Confirms this path does reach the same `code`-override/SENTINEL machinery as a
    // fenced block, rather than asserting on an untested assumption.
    expect(codeRanges.length).toBeGreaterThan(0);
    expect(text).toContain("* not a bullet");
    expect(text).toContain("ls *.md");
    expect(text).toContain("• item one");
    expect(text).toContain("• item two");
  });

  test("a list item whose prose legitimately begins with an escaped asterisk still gets its own marker substituted (no over-correction)", () => {
    const source = "- \\*not emphasis\\* rest\n";
    const output = stripAnsi(renderDocument(source, 80));
    // The real marker (the list item's own leading `* `) is substituted to the
    // glyph...
    expect(output).toContain("• ");
    expect(output).not.toMatch(/^\s*\*/m);
    // ...while the escaped asterisks in the item's own prose are left completely alone:
    // not mistaken for another marker, and not skipped by the fence-detection logic added
    // above, since there is no `SENTINEL` anywhere in this document to trigger it.
    //
    // The *spelling* of that prose changed in WP-14 and the point of the test did not.
    // Until then `marked-terminal`'s `text` renderer handed a list item its markdown
    // source verbatim, so the backslashes survived into the output and this asserted
    // `\*not emphasis\*`. Inline tokens are dispatched now, so an escape resolves exactly
    // as it always has in a paragraph — pinned side by side below, because "the item
    // agrees with the paragraph" is the durable claim and the literal bytes are not.
    expect(output).toContain("*not emphasis* rest");
    expect(output).not.toContain("\\*");
    expect(stripAnsi(renderDocument("\\*not emphasis\\* rest\n", 80))).toContain("*not emphasis* rest");
  });
});

// --- width invariance (load-bearing) -----------------------------------------

const MIXED_DOCUMENT = [
  "# A document with everything",
  "",
  "- top item with enough words in it to force a wrap at eighty columns exactly",
  "  - nested item also with enough words in it to force a wrap at eighty columns",
  "    - doubly nested item with enough words in it to force a wrap at eighty columns too",
  "      - four levels deep, cycling back to the first bullet glyph in the unicode tier",
  "- second top-level item",
  "",
  "- [x] done thing",
  "- [ ] todo thing",
  "",
  "---",
  "",
  "| Column A | Column B | Column C |",
  "| --- | --- | --- |",
  "| some prose that is reasonably long for a table cell | short | another reasonably long cell |",
  "| a | b | c |",
  "",
].join("\n");

describe("width invariance across glyph tiers", () => {
  test("no line exceeds the target width under either tier at width 80", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      const output = renderDocument(MIXED_DOCUMENT, 80, glyphs);
      for (const line of output.split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(80);
      }
    }
  });

  test("both tiers produce the same number of lines — the tier swap moves no content across a wrap boundary", () => {
    const unicodeOutput = renderDocument(MIXED_DOCUMENT, 80, UNICODE_GLYPHS);
    const asciiOutput = renderDocument(MIXED_DOCUMENT, 80, ASCII_GLYPHS);
    expect(asciiOutput.split("\n").length).toBe(unicodeOutput.split("\n").length);
  });
});

// --- ASCII tier is a provable no-op where it should be -----------------------

describe("ASCII tier — provable no-op", () => {
  test("the rule is byte-identical to today's output: '-'.repeat(79) at width 80", () => {
    const output = stripAnsi(renderDocument("above\n\n---\n\nbelow\n", 80, ASCII_GLYPHS));
    expect(output).toContain("-".repeat(79));
  });

  test("'- [x] done' survives byte-identical (not merely display-identical) under the ASCII tier", () => {
    const output = stripAnsi(renderDocument("- [x] done\n", 80, ASCII_GLYPHS));
    // No invisible passenger of any kind: the defeated-recognition sentinel
    // (`render.ts`'s `TASK_STATE_SENTINEL`) is stripped out of the fully-rendered
    // document before `renderDocument` ever returns, so this is a plain, literal
    // substring check — not "strip something first, then compare".
    expect(output).toContain("[x] done");
    expect(output).not.toContain("✓");
  });

  test("every GFM-recognized state (' ', 'x', 'X') survives byte-identical, single-spaced, original case", () => {
    for (const char of [" ", "x", "X"]) {
      const output = stripAnsi(renderDocument(`- [${char}] thing\n`, 80, ASCII_GLYPHS));
      expect(output).toContain(`[${char}] thing`);
    }
  });

  test("Obsidian custom task states (not recognized by GFM) survive completely untouched", () => {
    const output = stripAnsi(renderDocument("- [/] in progress\n", 80, ASCII_GLYPHS));
    expect(output).toContain("[/] in progress");
    expect(output).not.toContain("◐");
  });

  test("the unicode tier still rewrites the same task line to a glyph", () => {
    const output = stripAnsi(renderDocument("- [x] done\n", 80, UNICODE_GLYPHS));
    expect(output).not.toContain("[x]");
    expect(output).toContain("✓");
  });
});

// --- the property the ASCII tier actually promises ---------------------------

// This is the gate that would have caught the U+200B regression (a zero-width space
// was used in an earlier version of this fix): `string-width` measuring something as 0
// columns is a statement about this tool's own width *accounting*, not about what an
// ASCII-only terminal does with an unrecognized multi-byte UTF-8 sequence. The ASCII
// tier's actual contract is "no Unicode in the output" — asserted here directly on
// code points, never inferred from a width measurement.
const ASCII_EXERCISE_DOCUMENT = [
  "# Heading",
  "",
  "- top item",
  "  - nested item",
  "    - doubly nested item",
  "      - four levels deep, cycling back to the first ASCII bullet",
  "",
  "- [ ] todo state",
  "- [x] done state (lowercase)",
  "- [X] done state (uppercase)",
  "- [/] in-progress (Obsidian custom state)",
  "- [>] forwarded (Obsidian custom state)",
  "",
  "---",
  "",
  "| Column A | Column B |",
  "| --- | --- |",
  "| one | two |",
  "",
].join("\n");

describe("ASCII tier — the actual promised property (no code point above U+007E)", () => {
  test("bullets, nested lists, a table, an hr, and every task state stay pure ASCII", () => {
    const output = renderDocument(ASCII_EXERCISE_DOCUMENT, 80, ASCII_GLYPHS);
    const offenders = new Set<string>();
    for (const ch of output) {
      const code = ch.codePointAt(0) ?? 0;
      // ANSI SGR escapes use ESC (0x1B) plus printable ASCII, both <= 0x7E; not
      // stripped here on purpose, since the point of this assertion is that literally
      // nothing above ASCII ever reaches the output, styling included.
      if (code > 0x7e) offenders.add(`U+${code.toString(16)}`);
    }
    expect([...offenders]).toEqual([]);
  });
});

// --- table borders by tier ----------------------------------------------------

describe("table borders by glyph tier", () => {
  const TABLE_DOC = ["| A | B |", "| --- | --- |", "| one | two |", ""].join("\n");

  test("unicode tier tables still contain box-drawing characters (today's behavior, unchanged)", () => {
    const output = renderDocument(TABLE_DOC, 80, UNICODE_GLYPHS);
    expect(output).toContain("┌");
    expect(output).toContain("│");
  });

  test("ascii tier tables use +/- and | and no box-drawing character", () => {
    const output = renderDocument(TABLE_DOC, 80, ASCII_GLYPHS);
    expect(output).toContain("+");
    expect(output).toContain("|");
    for (const boxChar of ["┌", "┬", "┐", "│", "├", "┼", "┤", "└", "┴", "┘"]) {
      expect(output).not.toContain(boxChar);
    }
  });
});
