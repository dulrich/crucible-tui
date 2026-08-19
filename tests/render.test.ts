import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { highlightToAnsi } from "../src/highlight";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocument, renderDocumentDetailed } from "../src/render";

describe("renderDocument — wiki-links", () => {
  test("[[slug]] renders the slug, styled", () => {
    const output = renderDocument("See [[mdview]] for details.\n", 80);
    expect(stripAnsi(output)).toContain("mdview");
    expect(output).not.toContain("[[mdview]]");
  });

  test("[[slug|alias]] renders the alias, not the slug", () => {
    const output = renderDocument("See [[mdview|the viewer]] for details.\n", 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("the viewer");
    expect(plain).not.toContain("mdview");
  });

  test("[[slug#heading]] renders the slug (no alias given)", () => {
    const output = renderDocument("See [[mdview#Run]] for details.\n", 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("mdview");
    expect(plain).not.toContain("#Run");
  });

  test("a wiki-link inside a fenced code block is left alone", () => {
    const source = "```\nSee [[mdview]] for details.\n```\n";
    const output = renderDocument(source, 80);
    expect(output).toContain("[[mdview]]");
  });

  // **"Styled" stopped meaning "styled unconditionally" at WP-4 of
  // `plans/colour-policy.md`.** The three tests above pass either way — they strip escapes
  // before asserting — and that is exactly why they could not see the defect: `styleWikiLink`
  // put a cyan/underline SGR pair into the markdown *source*, before the lexer, at every
  // colour level, so the default `renderDocument` call they make carried colour into a pipe
  // with none requested. The mechanism and the gate are both pinned here; the carrier
  // machinery itself is `tests/wikilink.test.ts`'s.
  test("with no policy, a wiki-link emits no escape and no carrier", () => {
    const output = renderDocument("See [[mdview]] for details.\n", 80);
    expect(output).toContain("mdview");
    expect(output).not.toContain(String.fromCharCode(27));
    expect(output).not.toContain(String.fromCharCode(2));
    expect(output).not.toContain(String.fromCharCode(3));
  });

  test("with colour on, the label is cyan+underline and the characters are unchanged", () => {
    const source = "See [[mdview|the viewer]] for details.\n";
    const coloured = renderDocument(source, 80, undefined, undefined, undefined, undefined, {
      sgr: "full",
      hyperlinks: false,
      tmux: false,
    });
    const ESC = String.fromCharCode(27);
    expect(coloured).toContain(`${ESC}[36m${ESC}[4mthe viewer${ESC}[24m${ESC}[39m`);
    expect(stripAnsi(coloured)).toBe(stripAnsi(renderDocument(source, 80)));
  });
});

/**
 * **The `formats` mode at the document level** — WP-2 of `plans/colour-modes.md`.
 *
 * Two obligations that only a whole-document render can witness, plus the framing Decision 8
 * governs. Everything else about the mode is pinned at its own producer with exact-pair
 * assertions (`tests/inline.test.ts`, `tests/table.test.ts`, `tests/frontmatter.test.ts`,
 * `tests/wikilink.test.ts`, `tests/blocks.test.ts`), deliberately: cycle-3 f6 established
 * that a document-level probe is masked by the paragraph `reset` and cannot fail when the
 * hue filter is dead.
 *
 * 1. **Authored escapes are content and survive byte-for-byte** (cycle-2 f3). This is what
 *    killed rev 2's "formats ≡ full minus hue codes" identity gate: an authored `31m` is not
 *    the tool's to remove at *any* mode, so a filter that operated on the finished byte
 *    stream rather than on the tool's own style chains would have been unsound. The filter
 *    is over named chains at the emitter, so an authored sequence is never even a candidate.
 * 2. **The reset framing is present under `formats`** (Decision 8) — paragraphs and list
 *    items alike, which is the second `reset` chain (`src/lists.ts`) the decision names.
 */
describe("renderDocument under `formats` — authored escapes, and the reset framing", () => {
  const ESC = String.fromCharCode(27);
  const NONE = { sgr: "none", hyperlinks: false, tmux: false } as const;
  const FORMATS = { sgr: "formats", hyperlinks: false, tmux: false } as const;
  const FULL = { sgr: "full", hyperlinks: false, tmux: false } as const;
  const render = (source: string, policy: typeof NONE | typeof FORMATS | typeof FULL): string =>
    renderDocument(source, 60, UNICODE_GLYPHS, undefined, undefined, undefined, policy);

  const AUTHORED = `A paragraph with authored ${ESC}[31mred${ESC}[39m in it.\n`;

  test("an authored hue sequence survives `formats` byte-for-byte, in place and in order", () => {
    const out = render(AUTHORED, FORMATS);
    expect(out).toContain(`${ESC}[31mred${ESC}[39m`);
    expect(out.split(`${ESC}[31m`).length - 1).toBe(1);
    expect(out.split(`${ESC}[39m`).length - 1).toBe(1);
    // And the tool's own framing sits outside it rather than through it.
    expect(out).toBe(`${ESC}[0mA paragraph with authored ${ESC}[31mred${ESC}[39m in it.${ESC}[0m\n\n`);
  });

  test("the same authored sequence survives `none` and `full` too — fidelity is not modal", () => {
    for (const policy of [NONE, FORMATS, FULL]) {
      expect(render(AUTHORED, policy)).toContain(`${ESC}[31mred${ESC}[39m`);
    }
    expect(render(AUTHORED, NONE)).toBe(`A paragraph with authored ${ESC}[31mred${ESC}[39m in it.\n\n`);
  });

  test("a paragraph and a list item both keep their reset framing under `formats`", () => {
    // `src/blocks.ts`'s `RESET` and `src/lists.ts`'s `LIST_ITEM` — the two chains Decision 8
    // is about. `0m` opens and closes, so this is pinned as the whole byte string.
    expect(render("plain prose\n", FORMATS)).toBe(`${ESC}[0mplain prose${ESC}[0m\n\n`);
    expect(render("- a list item\n", FORMATS)).toBe(`    • ${ESC}[0ma list item${ESC}[0m\n\n`);
    // ... and are absent under `none`, so the assertions above are not vacuous.
    expect(render("plain prose\n", NONE)).toBe("plain prose\n\n");
    expect(render("- a list item\n", NONE)).toBe("    • a list item\n\n");
  });

  test("`formats` is exactly `full` minus the tool's own hue pairs on a mixed document", () => {
    // Stated as a *measured* relationship on one document rather than as an identity gate:
    // rev 2's identity was unsound in general (an authored hue must not be removed), so this
    // case deliberately carries no authored escape and is a per-document witness, not a rule.
    const source = "`code` and **bold**\n";
    expect(render(source, FULL)).toBe(`${ESC}[0m${ESC}[33mcode${ESC}[39m and ${ESC}[1mbold${ESC}[22m${ESC}[0m\n\n`);
    expect(render(source, FORMATS)).toBe(`${ESC}[0mcode and ${ESC}[1mbold${ESC}[22m${ESC}[0m\n\n`);
    expect(render(source, NONE)).toBe("code and bold\n\n");
  });

  test("the three modes differ only in escapes — every visible character is identical", () => {
    const source = `# Heading\n\n${AUTHORED}\n- item with \`code\` and **bold**\n\n| a | b |\n|---|---|\n| c | d |\n`;
    const base = stripAnsi(render(source, NONE));
    expect(stripAnsi(render(source, FORMATS))).toBe(base);
    expect(stripAnsi(render(source, FULL))).toBe(base);
  });
});

// The defect record — `src/AGENTS.md`, "The wiki-link carrier defect", and WP-1 of
// `plans/colour-modes.md`. `markWikiLinks` (`src/wikilink.ts:116-121`, called from
// `preprocessBody`, `src/render.ts:251-274`) is guarded only by `FENCE_LINE`
// (` ``` `/`~~~`), so it fires on lines that later tokenize as indented code, block
// HTML, or code nested under a blockquote or a list, exactly as it fires on ordinary
// prose. **These tests assert the renderer's CURRENT output, byte-for-byte, in both
// colour modes — recorded, not fixed.** If a future change moves any of these bytes,
// one of these tests is the tripwire that is supposed to fail; the fix belongs to the
// successor plan `src/AGENTS.md` names, not to this WP.
describe("renderDocument — the wiki-link defect in verbatim contexts (plans/colour-modes.md WP-1, recorded not fixed)", () => {
  const ESC = String.fromCharCode(27);
  const CYAN_UNDERLINE_OPEN = `${ESC}[36m${ESC}[4m`;
  const CYAN_UNDERLINE_CLOSE = `${ESC}[24m${ESC}[39m`;
  // Migrated at WP-2 of `plans/colour-modes.md` (`color: true` -> `sgr: "full"`,
  // `color: false` -> `sgr: "none"`). **Not one expected byte in this describe block
  // moved with them**: these witnesses record the defect's current output and exist to
  // trip when a future fix changes it, so a migration that also "tidied" an expectation
  // would have destroyed the instrument.
  const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;
  const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;

  test("defect record: indented code loses authored brackets — plain, alias, fragment, embed (pinned until the successor fix plan)", () => {
    const source =
      "Intro paragraph.\n\n" +
      "    See [[slug]] here\n" +
      "    See [[slug|Alias]] here\n" +
      "    See [[slug#head|Alias]] here\n" +
      "    See ![[embed]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe(
      "Intro paragraph.\n\n" +
        "    See slug here\n" +
        "    See Alias here\n" +
        "    See Alias here\n" +
        "    See embed: embed here\n\n",
    );
    expect(plain.codeRanges).toEqual([[3, 6]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `${ESC}[0mIntro paragraph.${ESC}[0m\n\n` +
        `    See ${CYAN_UNDERLINE_OPEN}slug${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m\n` +
        `    See ${CYAN_UNDERLINE_OPEN}Alias${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m\n` +
        `    See ${CYAN_UNDERLINE_OPEN}Alias${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m\n` +
        `    See embed: ${CYAN_UNDERLINE_OPEN}embed${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m\n\n`,
    );
    // The blue on "here" is the syntax highlighter's own `highlightAuto` guess over the
    // code range's content — never asserted away, per the brief: coloured code is
    // intentionally passed through the highlighter, so "no SGR but the wiki-link's" would
    // be the wrong claim to pin.
    expect(coloured.codeRanges).toEqual([[3, 6]]);
  });

  test("defect record: block HTML loses authored brackets and carries no codeRange exemption", () => {
    const source = "<div>\nSee [[slug]] here\n</div>\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("<div>\nSee slug here\n</div>\n");
    // Unlike indented/blockquote/list-nested code, block HTML never passes through
    // `wrapCode`, so `extractCodeRanges` records nothing here — this corruption carries
    // no class-C protection and no `--check`/sweep exemption at all.
    expect(plain.codeRanges).toEqual([]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `${ESC}[90m<div>${ESC}[39m\n` +
        `${ESC}[90mSee ${CYAN_UNDERLINE_OPEN}slug${CYAN_UNDERLINE_CLOSE} here${ESC}[39m\n` +
        `${ESC}[90m</div>${ESC}[39m\n` +
        `${ESC}[90m${ESC}[39m`,
    );
    expect(coloured.codeRanges).toEqual([]);
  });

  test("defect record: indented code nested inside a blockquote loses authored brackets", () => {
    const source = "> Intro\n\n>     See [[slug]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("    Intro\n\n        See slug here\n\n");
    expect(plain.codeRanges).toEqual([[3, 3]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `${ESC}[90m${ESC}[3m    ${ESC}[0mIntro${ESC}[0m${ESC}[23m${ESC}[39m\n\n` +
        `${ESC}[90m${ESC}[3m        See ${CYAN_UNDERLINE_OPEN}slug${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m${ESC}[90m${ESC}[23m${ESC}[39m\n\n`,
    );
    expect(coloured.codeRanges).toEqual([[3, 3]]);
  });

  test("defect record: indented code nested inside a list item loses authored brackets", () => {
    const source = "- Intro\n\n      See [[slug]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("    • Intro\n          See slug here\n\n");
    expect(plain.codeRanges).toEqual([[2, 2]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `    • ${ESC}[0m${ESC}[0m${ESC}[0mIntro${ESC}[0m${ESC}[0m${ESC}[0m\n` +
        `      ${ESC}[0m    See ${CYAN_UNDERLINE_OPEN}slug${CYAN_UNDERLINE_CLOSE} ${ESC}[34mhere${ESC}[39m${ESC}[0m\n\n`,
    );
    expect(coloured.codeRanges).toEqual([[2, 2]]);
  });
});

describe("renderDocument — Obsidian task states", () => {
  test("task states render as glyphs, not literal bracket markers", () => {
    const source = "- [x] done thing\n- [ ] todo thing\n- [/] in progress thing\n";
    const output = renderDocument(source, 80);
    const plain = stripAnsi(output);
    expect(plain).not.toContain("[x]");
    expect(plain).not.toContain("[ ]");
    expect(plain).not.toContain("[/]");
    expect(plain).toContain("✓");
    expect(plain).toContain("○");
    expect(plain).toContain("◐");
  });

  test("a task-state-looking line inside a fence is untouched", () => {
    const source = "```\n- [x] literal, not a real task\n```\n";
    const output = renderDocument(source, 80);
    expect(output).toContain("[x]");
  });
});

describe("renderDocument — width and prose coverage", () => {
  test("no line exceeds the target width for tests/fixtures/simple.md", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/simple.md`, "utf8");
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("headings, bold/italic, lists, blockquotes, and a fenced code block all render non-empty", () => {
    const source = [
      "# Heading one",
      "",
      "Some **bold** and some *italic* text.",
      "",
      "- item one",
      "- item two",
      "",
      "> a quoted blockquote",
      "",
      "```bash",
      "echo hello",
      "```",
      "",
    ].join("\n");

    const output = renderDocument(source, 80);
    expect(output.length).toBeGreaterThan(0);

    const plain = stripAnsi(output);
    expect(plain).toContain("Heading one");
    expect(plain).toContain("bold");
    expect(plain).toContain("italic");
    expect(plain).toContain("item one");
    expect(plain).toContain("item two");
    expect(plain).toContain("quoted blockquote");
    expect(plain).toContain("echo hello");
  });
});

describe("renderDocument — list reflow (WP-4a)", () => {
  test("a 300-character bullet emits no line over the target width", () => {
    const bullet = `- ${"word ".repeat(60)}`.trim();
    const output = renderDocument(bullet, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("a nested list (depth 2) emits no line over the target width", () => {
    const source = [
      `- top item with ${"word ".repeat(30)}`.trim(),
      `  - nested item with ${"word ".repeat(30)}`.trim(),
      `    - doubly nested item with ${"word ".repeat(30)}`.trim(),
      "- second top item",
    ].join("\n");
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("an ordered list (wider markers than '* ') wraps correctly", () => {
    const items = Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. item ${i} with ${"word ".repeat(20)}`.trim(),
    );
    const output = renderDocument(items.join("\n"), 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
    const plain = stripAnsi(output);
    expect(plain).toContain("item 0");
    expect(plain).toContain("item 11");
  });

  test("a bullet with a long inline code span has no overflow and intact escapes", () => {
    const longPath = "mdview/tests/fixtures/a/very/long/path/that/needs/to/be/split/somewhere";
    const source = `- see \`${longPath}\` for the fixture`;
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/\[[0-9;]*$/);
    }
    const plain = stripAnsi(output);
    expect(plain.replace(/\s+/g, "")).toContain(longPath.replace(/\s+/g, ""));
  });
});

describe("renderDocument — fenced code exemption and sentinels (WP-4a)", () => {
  test("a 200-char command line in a fence is emitted verbatim, unbroken", () => {
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["```bash", longCommand, "```", ""].join("\n");
    const output = renderDocument(source, 80);
    expect(output).toContain(longCommand);
  });

  test("renderDocumentDetailed reports a codeRanges entry covering the fence, sentinel-free", () => {
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["intro paragraph", "", "```bash", longCommand, "```", "", "outro paragraph"].join("\n");
    const { text, codeRanges } = renderDocumentDetailed(source, 80);

    expect(codeRanges.length).toBeGreaterThan(0);
    expect(text).not.toContain(String.fromCharCode(0));

    const lines = text.split("\n");
    const [start, end] = codeRanges[0] ?? [0, 0];
    const rangeText = lines.slice(start - 1, end).join("\n");
    expect(rangeText).toContain(longCommand);
  });

  test("--check-shape scenario: the fence line itself still exceeds 80 in the raw text", () => {
    // Confirms the exemption is doing real work — without it this fixture would
    // fail a naive per-line width check.
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["```bash", longCommand, "```", ""].join("\n");
    const { text } = renderDocumentDetailed(source, 80);
    const overLong = text.split("\n").some((line) => stringWidth(line) > 80);
    expect(overLong).toBe(true);
  });
});

describe("renderDocument — frontmatter integration", () => {
  test("renders the metadata block ahead of the body when frontmatter is present", () => {
    const source = "---\ntitle: Example\npending-plans: []\n---\n\n# Body\n";
    const output = renderDocument(source, 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("title");
    expect(plain).toContain("Example");
    expect(plain).toContain("—");
    expect(plain.indexOf("Example")).toBeLessThan(plain.indexOf("Body"));
  });

  test("a document with no frontmatter renders only the body", () => {
    const output = renderDocument("# Just a body\n", 80);
    expect(stripAnsi(output)).toContain("Just a body");
  });
});

describe("renderDocument — frontmatter divider (WP-3)", () => {
  const withFrontmatter = "---\ntitle: Example\n---\n\nBody text here.\n";

  test("present exactly once after the metadata block when frontmatter exists", () => {
    const plain = stripAnsi(renderDocument(withFrontmatter, 40));
    const rule = UNICODE_GLYPHS.rule.repeat(39);
    expect(plain.split(rule).length - 1).toBe(1);
  });

  test("absent when frontmatter is absent", () => {
    const plain = stripAnsi(renderDocument("Body text here.\n", 40));
    expect(plain).not.toContain(UNICODE_GLYPHS.rule.repeat(39));
  });

  test("its length is targetWidth - 1 at widths 40, 80, and 160", () => {
    for (const width of [40, 80, 160]) {
      const lines = stripAnsi(renderDocument(withFrontmatter, width)).split("\n");
      expect(lines).toContain(UNICODE_GLYPHS.rule.repeat(width - 1));
    }
  });

  test("is byte-identical to the rule the same document's --- produces at the same width and tier", () => {
    const width = 64;
    const dividerOutput = renderDocument(withFrontmatter, width);
    const hrOutput = renderDocument("Body text here.\n\n---\n\nMore text here.\n", width);

    const rule = UNICODE_GLYPHS.rule.repeat(width - 1);
    const dividerLine = dividerOutput.split("\n").find((line) => line === rule);
    const hrLine = hrOutput.split("\n").find((line) => line === rule);

    expect(dividerLine).toBeDefined();
    expect(hrLine).toBeDefined();
    // Byte-identical (not just equal after stripping ANSI) to the library's own rule.
    expect(dividerLine).toBe(hrLine);
  });

  test("uses the tier's own rule glyph: unicode -> ─, ascii -> -", () => {
    const unicodeLines = stripAnsi(renderDocument(withFrontmatter, 40, UNICODE_GLYPHS)).split("\n");
    const asciiLines = stripAnsi(renderDocument(withFrontmatter, 40, ASCII_GLYPHS)).split("\n");
    expect(unicodeLines).toContain("─".repeat(39));
    expect(asciiLines).toContain("-".repeat(39));
    expect(unicodeLines).not.toContain("-".repeat(39));
  });
});

describe("renderDocument — codeRanges regression: frontmatter + fenced code (WP-3)", () => {
  test("a code range still lands exactly on the fence's rendered lines when frontmatter is also present", () => {
    const marker = "echo hello-from-fence-regression";
    const withMeta = [
      "---",
      "title: Example",
      "---",
      "",
      "intro paragraph",
      "",
      "```bash",
      marker,
      "```",
      "",
      "outro paragraph",
      "",
    ].join("\n");
    const withoutMeta = ["intro paragraph", "", "```bash", marker, "```", "", "outro paragraph", ""].join(
      "\n",
    );

    const withMetaResult = renderDocumentDetailed(withMeta, 80);
    const withoutMetaResult = renderDocumentDetailed(withoutMeta, 80);

    expect(withMetaResult.codeRanges.length).toBeGreaterThan(0);
    expect(withoutMetaResult.codeRanges.length).toBeGreaterThan(0);

    // Assert against the *real* line numbers reported for the frontmatter render,
    // reading the actual text back out at those line numbers — not an offset computed
    // by hand from the divider's known length.
    const lines = withMetaResult.text.split("\n");
    const [start, end] = withMetaResult.codeRanges[0] ?? [0, 0];
    const rangeText = lines.slice(start - 1, end).join("\n");
    expect(rangeText).toContain(marker);
    expect(withMetaResult.text).not.toContain(String.fromCharCode(0));

    // The divider adds exactly one line ahead of the body relative to a frontmatter-less
    // render of the identical body — proving the divider is folded into `metaBlock`
    // (and therefore into `metaLineOffset`) rather than spliced in afterward, which is
    // exactly the bug this regression exists to catch.
    const [withoutMetaStart, withoutMetaEnd] = withoutMetaResult.codeRanges[0] ?? [0, 0];
    const metaLinesAhead = start - withoutMetaStart;
    expect(metaLinesAhead).toBeGreaterThan(0);
    // The shift is uniform across the whole range (start and end move by the same
    // amount), confirming a constant line offset rather than a range that grew or
    // shrank — i.e. the fence's own content is untouched, only its position moved.
    expect(end - start).toBe(withoutMetaEnd - withoutMetaStart);
  });
});

describe("renderDocument — embeds (WP-3)", () => {
  test("![[my-note]] renders a labelled embed with the stray ! gone", () => {
    const plain = stripAnsi(renderDocument("See ![[my-note]] for details.\n", 80));
    expect(plain).toContain("embed: my-note");
    expect(plain).not.toContain("!");
  });

  test("![[example/pic.png|alt]] renders embed: alt", () => {
    const plain = stripAnsi(renderDocument("See ![[example/pic.png|alt]] for details.\n", 80));
    expect(plain).toContain("embed: alt");
    expect(plain).not.toContain("example/pic.png");
    expect(plain).not.toContain("!");
  });

  test("[[plain]] is unchanged: no embed: prefix, no stray !", () => {
    const plain = stripAnsi(renderDocument("See [[plain]] for details.\n", 80));
    expect(plain).toContain("plain");
    expect(plain).not.toContain("embed:");
  });

  test("![[x]] inside a fenced code block stays completely literal", () => {
    const output = renderDocument("```\nSee ![[x]] for details.\n```\n", 80);
    expect(output).toContain("![[x]]");
  });
});

describe("renderDocument — fence language normalization silences highlight.js diagnostics (WP-3)", () => {
  test("a dataviewjs fence renders through the forced-color harness with zero captured messages", async () => {
    const source = ["```dataviewjs", "dv.pages().sort(p => p.file.name)", "```", ""].join("\n");
    const { text, messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
    expect(text.length).toBeGreaterThan(0);
  });

  test("a dataview fence also renders through the forced-color harness with zero captured messages", async () => {
    const source = ["```dataview", "TABLE file.name FROM \"notes\"", "```", ""].join("\n");
    const { messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
  });

  test("an ad-note admonition fence (Obsidian, unsupported) also emits nothing", async () => {
    const source = ["```ad-note", "a note admonition", "```", ""].join("\n");
    const { messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
  });

  // Positive control, so the three tests above cannot pass vacuously: prove the
  // console.error capture mechanism itself still detects a real highlight.js
  // "language not found" diagnostic when one is actually emitted. The owned colorizer
  // (`src/highlight.ts`, which replaced the retired package in WP-2 of
  // `plans/colour-policy.md`) calls `hljs.highlight` on any truthy language, and
  // highlight.js logs via `console.error` *and then* throws on one it does not know.
  // It is not reachable from `renderDocumentDetailed` after WP-3's fix — every fence
  // language is normalized to something supported before it gets there — so this
  // exercises the same entry point directly instead.
  test("positive control: the owned colorizer still emits a real console.error for a genuinely unsupported language", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      try {
        highlightToAnsi({ sgr: "full" }, "const x = 1;", "not-a-real-language-xyz");
      } catch {
        // highlight.js throws in addition to logging for a genuinely unknown language;
        // the console.error call happens before the throw, which is all this control
        // needs to prove the capture mechanism works. `src/blocks.ts` catches the same
        // throw and falls back to flat yellow.
      }
    } finally {
      console.error = original;
    }
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((message) => message.includes("not-a-real-language-xyz"))).toBe(true);
  });
});

// WP-11 (representative-corpus, formerly WP-7): shortcode substitution follows the
// glyph tier — Unicode renders the glyph (the default, matching `marked-terminal`'s own
// default), ASCII cannot draw it and keeps the literal shortcode, and
// `MdviewConfig.emoji` (`src/config.ts`) overrides either direction via the
// `emojiOverride` argument `renderDocumentDetailed`/`renderDocument` now accept. See
// `src/render.ts`'s `emoji` computation at the top of `renderDocumentDetailed` and
// `src/AGENTS.md`'s emoji section for why this is no longer a hardcoded constant.
//
// These tests fail if the `markedTerminal()` construction and the `LayoutContext` stop
// honouring the same `emoji` value, or if the config override stops reaching
// `renderDocumentDetailed`.
//
// **They were written against three construction sites and now cover two seams** (WP-3 of
// `plans/marked-terminal-replacement.md`). The two per-budget `markedTerminal()` caches —
// built only because the library takes its width at construction — are gone; the owned
// block renderers take the budget as a parameter and read `emoji` off the context. The
// nested cases below are kept exactly as they were, because what they actually assert is
// that substitution does not depend on whether a paragraph or heading sits inside a list
// or a blockquote, and that property outlives the mechanism that used to threaten it.
describe("renderDocument — emoji shortcode substitution follows the glyph tier (WP-11)", () => {
  test("unicode tier: a prose shortcode in a paragraph is substituted with its glyph", () => {
    const output = renderDocument("Ship it :rocket: today.\n", 80, UNICODE_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain("🚀");
    expect(plain).not.toContain(":rocket:");
  });

  test("unicode tier: a prose shortcode in a heading is substituted with its glyph", () => {
    const output = renderDocument("# Status :white_check_mark:\n", 80, UNICODE_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain("✅");
    expect(plain).not.toContain(":white_check_mark:");
  });

  test("ascii tier: a shortcode in a paragraph keeps its literal text, no glyph", () => {
    // The terminal-capability question this WP exists to answer: an ASCII terminal
    // cannot draw 🚀, so the literal shortcode is the only thing it can render.
    const output = renderDocument("Ship it :rocket: today.\n", 80, ASCII_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain(":rocket:");
    expect(plain).not.toContain("🚀");
  });

  test("ascii tier: a shortcode in a heading keeps its literal text, no glyph", () => {
    const output = renderDocument("# Status :white_check_mark:\n", 80, ASCII_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain(":white_check_mark:");
    expect(plain).not.toContain("✅");
  });

  test("unicode tier: a shortcode inside a loose list item's own budgeted paragraph is substituted too", () => {
    // A loose item's paragraph renders at the item's own budget rather than the full
    // width. That used to mean a second `markedTerminal()` instance with its own `emoji`
    // option; it now means one argument to `renderParagraph`, reading `ctx.emoji`.
    // Substitution must not depend on whether a paragraph sits inside a list either way.
    const source = "- one\n\n  still one, with a shortcode :bulb: in its second paragraph\n\n- two\n";
    const output = renderDocument(source, 80, UNICODE_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain("💡");
    expect(plain).not.toContain(":bulb:");
  });

  test("ascii tier: the same budgeted-paragraph seam keeps the literal, not a unicode glyph", () => {
    // The bug WP-11 guarded against here was a per-budget cache built without `emoji`,
    // silently defaulting to the library's own `true` regardless of tier — reproduced at
    // the time by reverting the `emoji` argument at that one call site and watching this
    // exact source render 💡 at the ASCII tier. WP-3 removed the cache, so the shape of
    // the bug changed; the property under test did not.
    const source = "- one\n\n  still one, with a shortcode :bulb: in its second paragraph\n\n- two\n";
    const output = renderDocument(source, 80, ASCII_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain(":bulb:");
    expect(plain).not.toContain("💡");
  });

  test("ascii tier: a heading inside a blockquote — the budgeted-heading seam — also keeps the literal", () => {
    // Same property one renderer over: a blockquote's non-zero `pendingPrefixWidth()`
    // makes the heading's budget differ from the target width, which is what used to route
    // it through the per-budget cache and now simply changes an argument.
    const output = renderDocument("> ## Heads :bulb:\n", 40, ASCII_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain(":bulb:");
    expect(plain).not.toContain("💡");
  });

  test("config override forces substitution on at the ascii tier", () => {
    const output = renderDocument("Ship it :rocket: today.\n", 80, ASCII_GLYPHS, undefined, true);
    const plain = stripAnsi(output);
    expect(plain).toContain("🚀");
    expect(plain).not.toContain(":rocket:");
  });

  test("config override forces substitution off at the unicode tier", () => {
    const output = renderDocument("Ship it :rocket: today.\n", 80, UNICODE_GLYPHS, undefined, false);
    const plain = stripAnsi(output);
    expect(plain).toContain(":rocket:");
    expect(plain).not.toContain("🚀");
  });

  test("a shortcode inside a fence stays literal, whatever the tier or override says", () => {
    // `marked-terminal`'s `code` renderer never runs `insertEmojis`, so fence content
    // is inert by construction — true regardless of `emoji`, and this existing path
    // needs no special case for the glyph-tier work. Proven at both tiers and with the
    // override explicitly forcing substitution on, so nothing here is an accident of
    // the ASCII tier just happening not to substitute.
    for (const [glyphs, override] of [
      [UNICODE_GLYPHS, undefined],
      [ASCII_GLYPHS, undefined],
      [UNICODE_GLYPHS, true],
    ] as const) {
      const output = renderDocument("```\n:star:\n```\n", 80, glyphs, undefined, override);
      const plain = stripAnsi(output);
      expect(plain).toContain(":star:");
    }
  });

  test("a shortcode inside a code span stays literal — the colon round-trip's whole job", () => {
    // WP-6 expected to delete `COLON_REPLACER` with `marked-terminal` and measurement said
    // no. The substitution pass is this repo's own now and still runs over composed block
    // text, *after* inline rendering, so a code span's colons are exposed to it unless the
    // sentinel hides them. Substituting both halves of the round-trip with identity turns
    // every one of these into a glyph — inside verbatim content, which is the one thing a
    // code span exists to prevent. All three positions are covered because all three run
    // the composition that undoes the sentinel: a paragraph, a list item and a blockquote.
    for (const source of ["Run `:rocket:` now.\n", "- item with `:smile:` inside\n", "> quoted `:tada:` here\n"]) {
      const plain = stripAnsi(renderDocument(source, 80, UNICODE_GLYPHS, undefined, true));
      expect(plain).toContain(source.includes("rocket") ? ":rocket:" : source.includes("smile") ? ":smile:" : ":tada:");
      expect(plain).not.toContain("🚀");
      expect(plain).not.toContain("😄");
      expect(plain).not.toContain("🎉");
    }
    // And the sentinel itself never reaches the terminal, at either tier.
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      expect(renderDocument("Run `a:b` now.\n", 80, glyphs)).not.toContain("#COLON");
    }
  });

  test("no trailing space the source did not have, anywhere: mid-line, paragraph end, heading end", () => {
    // `insertEmojis` returns `emojiSign + ' '` — the glyph plus a space that was never
    // in the source. Mid-line, reflow rejoins it against the following word so the
    // extra byte is invisible; at the true end of a rendered line nothing follows to
    // reflow against, and pre-WP-11 that survived as trailing whitespace. WP-11's
    // contract: strip it uniformly, so end-of-paragraph and end-of-heading now match
    // mid-line — no trailing space anywhere, not "sometimes, depending on position".
    expect(stripAnsi(renderDocument("Ship it :rocket: today.\n", 80))).toContain("Ship it 🚀 today.");
    expect(stripAnsi(renderDocument("All done :rocket:\n", 80))).toContain("🚀\n");
    expect(stripAnsi(renderDocument("All done :rocket:\n", 80))).not.toContain("🚀 \n");
    expect(stripAnsi(renderDocument("# Status :white_check_mark:\n", 80))).toContain("✅\n");
    expect(stripAnsi(renderDocument("# Status :white_check_mark:\n", 80))).not.toContain("✅ \n");
  });

  test("no trailing space in a list item, including one that is not the list's last line", () => {
    // Pre-WP-11 this only looked uniformly "trimmed" because `marked-terminal`'s own
    // `list()` does `body.trim()` on the whole concatenated body — which happens to
    // eat the very last item's trailing space as a side effect of trimming the whole
    // string, not because any per-item logic drops it. A **non-last** item proves the
    // rule is now real: before this WP, `item :bulb: \n    * item2 ...` kept the space
    // on the first item's own line.
    const twoItems = stripAnsi(renderDocument("- item :bulb:\n- item2 :bulb:\n", 80));
    expect(twoItems).toContain("💡\n");
    expect(twoItems).not.toContain("💡 \n");
    const singleItem = stripAnsi(renderDocument("- item :bulb:\n", 80));
    expect(singleItem).toContain("💡\n");
    expect(singleItem).not.toContain("💡 \n");
  });

  test("no trailing space survives under real ANSI styling, not just the colorless test default", async () => {
    // Under `bun test` chalk is level 0 (no TTY) and every SGR-code assumption above is
    // vacuous. `renderWithForcedColor` renders in a fresh subprocess with FORCE_COLOR=3
    // set before that process's module graph loads, so `chalk.reset`/`chalk.green.bold`
    // actually wrap the rendered segment — proving `stripEmojiTrailingSpace`'s regex
    // correctly looks *past* the closing SGR codes for the artifact space, rather than
    // only working by accident when there are none to look past.
    const paragraph = await renderWithForcedColor("All done :rocket:\n", 80);
    const paragraphPlain = stripAnsi(paragraph.text);
    expect(paragraphPlain).toContain("🚀\n");
    expect(paragraphPlain).not.toContain("🚀 \n");
    // Built the same indirect way `src/render.ts`'s own `EMOJI_TRAILING_SPACE` is: a
    // separately-declared source string interpolated into `new RegExp`, not a regex
    // literal — eslint's `no-control-regex` flags a literal ESC escape it can see
    // directly, not one behind this level of indirection.
    const ansiSgrSource = "(?:\\x1b\\[[0-9;]*m)*";
    expect(paragraph.text).not.toMatch(new RegExp(`🚀 ${ansiSgrSource}\\n`));

    const heading = await renderWithForcedColor("# Status :white_check_mark:\n", 80);
    const headingPlain = stripAnsi(heading.text);
    expect(headingPlain).toContain("✅\n");
    expect(headingPlain).not.toContain("✅ \n");
  });

  test("a fenced code block's own literal emoji-then-space content is never touched by the trailing-space strip", () => {
    // `stripEmojiTrailingSpace` must skip fenced ranges (`codeRanges`), or a document
    // that happens to contain a real emoji character followed by a real trailing space
    // as literal fence content would be silently mangled — exactly the fence-verbatim
    // contract this tool already guarantees for width, extended here to this new pass.
    const source = "```\n🎉 \n```\n";
    const output = renderDocument(source, 80);
    // The fence's own trailing space must survive; only bytes outside `codeRanges`
    // are ever candidates for this strip.
    expect(output).toContain("🎉 \n");
  });
});

// ---------------------------------------------------------------------------
// WP-14 witness — inline markup is parsed inside a list item.
//
// Follows the witness pattern WP-10 established: the fixture and its record in
// `tests/fixtures/witnesses/witness-index.json` (id `wp14-list-item-inline-markup`)
// carry the evidence, and this describe block is the test half. It lives here rather
// than in `tests/witnesses.test.ts` because the plan assigns WP-14
// `tests/render.test.ts`, and the index's `test_file` field points at this file
// accordingly.
//
// What it witnesses: before the fix, `marked-terminal`'s `Renderer.prototype.text`
// (`index.js:84-89`) returned a list item's raw markdown source, so `**bold**`,
// `[label](url)`, `` `code` `` and `~~struck~~` reached the terminal as literal syntax
// in tight, loose, nested, ordered and task items — and only there. The `revert_method`
// recorded in the index turns every "parsed" assertion below red.
// ---------------------------------------------------------------------------

describe("witness: WP-14 -- inline markup inside a list item (tests/fixtures/witnesses/defect-wp14-list-item-inline-markup.md)", () => {
  const WITNESS_PATH = `${import.meta.dir}/fixtures/witnesses/defect-wp14-list-item-inline-markup.md`;
  const witnessSource = (): Promise<string> => readFile(WITNESS_PATH, "utf8");

  /** The item lines of the rendered fixture, minus the fence's own verbatim content. */
  function itemLines(rendered: string): string[] {
    return stripAnsi(rendered)
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.includes("echo "));
  }

  test("every list-item kind renders its inline markup parsed, exactly as the paragraph control does", async () => {
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    // The control: a paragraph has always parsed these. Each item kind must now agree
    // with it, which is the whole claim — not "some markup disappeared".
    expect(rendered).toContain("A paragraph is the control: bold, em, code, label (https://example.com/p) and struck");
    for (const marker of [
      "• tight: bold, em, code, label (https://example.com/p) and struck",
      "• loose: bold, em, code, label (https://example.com/p) and struck",
      "1. ordered: bold, em, code, label (https://example.com/p) and struck",
      "◦ nested: bold, em, code, label (https://example.com/p) and struck",
    ]) {
      expect(rendered).toContain(marker);
    }
    // ...and no item still carries the source spelling.
    for (const line of itemLines(rendered)) {
      expect(line).not.toContain("**");
      expect(line).not.toContain("~~");
      expect(line).not.toContain("](");
      expect(line).not.toContain("`");
    }
  });

  test("a task item's checkbox is rendered once, not doubled or lost, now that the item's tokens are what render", async () => {
    // `marked-terminal`'s `listitem` (`index.js:155-184`) prepends the checkbox two
    // different ways: a *tight* task item gets it concatenated onto the composed string,
    // a *loose* one gets a `text` token unshifted onto `item.tokens`. Only the second
    // touches anything the `text` override sees, and that unshifted token carries no
    // `tokens` of its own, so it takes the untouched library path.
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    const open = rendered.split("\n").filter((line) => line.includes("task open"));
    const done = rendered.split("\n").filter((line) => line.includes("task done"));
    expect(open).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(open[0]).toContain("○ task open: bold and label (https://example.com/p)");
    expect(done[0]).toContain("✓ task done: bold and label (https://example.com/p)");
    // One state glyph, not two — the doubling failure mode this asserts against.
    expect((open[0]?.match(/○/g) ?? []).length).toBe(1);
    expect((done[0]?.match(/✓/g) ?? []).length).toBe(1);
  });

  test("an authored hard break still ends its line, and no bare carriage return survives", async () => {
    // Dispatching inline tokens makes `br` fire, and with `reflowText` on it emits
    // `HARD_RETURN` (`\r`) rather than a newline — a marker only the three reflowing
    // block renderers know how to consume. A list item is not one of them, so the `text`
    // override converts it itself. A `\r` reaching a terminal walks the cursor back to
    // column 0 and overwrites the line, which is why its absence is asserted directly.
    for (const width of [80, 100, 160]) {
      const rendered = stripAnsi(renderDocument(await witnessSource(), width));
      expect(rendered).toContain("this line ends in two spaces\n");
      expect(rendered).toMatch(/this line ends in two spaces\n\s+so this one must stay on a line of its own/);
      expect(rendered).not.toContain("\r");
    }
  });

  test("an authored soft break is still coalesced and re-wrapped at the item's budget (WP-2c is intact)", async () => {
    // The other half of the same seam: a soft break must be joined, a hard one must not.
    // At 160 the whole item fits on one line, which only happens if the join happened.
    const wide = stripAnsi(renderDocument(await witnessSource(), 160));
    expect(wide).toContain(
      "tight, authored soft break: this line was wrapped by its author and continues here, so the two must coalesce into one logical line",
    );
  });

  test("a fence nested in a list item is still verbatim -- the sentinel guard is not weakened", async () => {
    // `**not bold**` inside the fence proves the exemption is doing real work: it is the
    // exact markup the rest of this fixture asserts *is* parsed everywhere else.
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    expect(rendered).toContain('echo "**not bold**" > /home/example/out.md');
  });

  test("no rendered line exceeds the target width at any swept width", async () => {
    // Parsing changes rendered content, so the width gates are the real test of it: a
    // regression here would mean ANSI or resolved markup being measured wrongly.
    const source = await witnessSource();
    for (const width of [80, 100, 116, 160, 346]) {
      for (const line of stripAnsi(renderDocument(source, width)).split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("under real ANSI the item is styled like the paragraph, and the styling is not counted as width", async () => {
    // Under `bun test` chalk is level 0, so every assertion above is about resolved
    // *text*. This one renders in a subprocess with FORCE_COLOR=3 so `chalk.bold` and
    // `chalk.blue.underline` actually emit SGR codes, and checks the two things that
    // could only break with colour on: the item gets the same styling the paragraph
    // gets, and `measure` still reads the line's visible width.
    const source = [
      "Control **bold** and [label](https://example.com/p).",
      "",
      "- item **bold** and [label](https://example.com/p).",
      "",
    ].join("\n");
    const { text } = await renderWithForcedColor(source, 80);
    const lines = text.split("\n");
    const control = lines.find((line) => line.includes("Control")) ?? "";
    const item = lines.find((line) => line.includes("item")) ?? "";
    expect(stripAnsi(control)).toContain("Control bold and label (https://example.com/p).");
    expect(stripAnsi(item)).toContain("item bold and label (https://example.com/p).");
    // Bold open/close, present in the paragraph before this WP and in the item only after.
    for (const styled of [control, item]) {
      expect(styled).not.toBe(stripAnsi(styled));
      expect(styled).toContain("\u001b[1mbold\u001b[22m");
    }
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(80);
  });
});
