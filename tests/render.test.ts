import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, mock, test } from "bun:test";
import stringWidth from "string-width";
import type { Tokens } from "marked";
import { highlight as cliHighlight } from "cli-highlight";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { renderWithForcedColor } from "./helpers/color";

const TABLE_MODULE_PATH = `${import.meta.dir}/../src/table.ts`;

if (!existsSync(TABLE_MODULE_PATH)) {
  // WP-3 (`src/table.ts`) has not landed in this worktree yet. Stub it here, in this
  // test file only, per the WP-2 brief: never in `src/`. This stub only needs to let
  // renderDocument's own plumbing (frontmatter, wiki-links, task states, prose) run
  // end to end; the allocator's own correctness is WP-3's test file's job, not this
  // one's.
  mock.module("../src/table", () => ({
    renderTable: (token: Tokens.Table, targetWidth: number, _glyphs?: unknown): string => {
      const cellText = (cell: Tokens.TableCell): string => cell.text;
      const rows = [token.header, ...token.rows];
      const width = Math.max(0, targetWidth);
      return rows.map((row) => row.map(cellText).join(" | ").slice(0, width)).join("\n");
    },
  }));
}

const { renderDocument, renderDocumentDetailed } = await import("../src/render");

// Deliberately matching the ESC control character to strip ANSI SGR codes so
// assertions can check plain rendered text.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

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

  test("![[folder/pic.png|alt]] renders embed: alt", () => {
    const plain = stripAnsi(renderDocument("See ![[folder/pic.png|alt]] for details.\n", 80));
    expect(plain).toContain("embed: alt");
    expect(plain).not.toContain("folder/pic.png");
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
  // "language not found" diagnostic when one is actually emitted. `cli-highlight`'s own
  // `highlight()` (the function `marked-terminal`'s gated wrapper calls through to) logs
  // via `console.error` unconditionally on a language `supportsLanguage()` rejects —
  // it is not reachable from `renderDocumentDetailed` any more after this WP's fix
  // (every fence language is normalized to something supported before it gets there),
  // so this exercises the same underlying library entry point directly instead.
  test("positive control: cli-highlight itself still emits a real console.error for a genuinely unsupported language", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      try {
        cliHighlight("const x = 1;", { language: "not-a-real-language-xyz" });
      } catch {
        // cli-highlight throws in addition to logging for a genuinely unknown
        // language; the console.error call happens before the throw, which is all
        // this control needs to prove the capture mechanism works.
      }
    } finally {
      console.error = original;
    }
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((message) => message.includes("not-a-real-language-xyz"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WP-2 / WP-2b — the loose-list double-wrap defect (characterized in WP-2, closed
// in WP-2b).
//
// Read this before changing anything below. **No width assertion can see this
// defect**: an orphaned line is *under* the target width, so `--check` and both
// corpus sweeps are blind to it by construction. That is exactly why it survived
// every gate. The metric below is therefore the only thing that tests it.
//
// An orphan is: a line inside a rendered list item that carries <= 2 words, whose
// preceding line is nearly full (>= width - 10), and which is *followed by more
// prose in the same item*. That last clause matters — without it the metric also
// flags the natural short final line of any wrapped item (a tight item ending
// "...being fixed."), which is not a defect and is present either way.
//
// **Known blind spot, do not "fix" it by loosening the metric.** `marked-terminal`
// drops the blank line between two paragraphs of the same loose item
// (`bulletPointLines`' `.filter(identity)`), so in rendered text a paragraph
// boundary and a shear are the same shape and the first paragraph's short last line
// reads as an orphan. No line-based metric can separate them; the multi-paragraph
// case is therefore asserted structurally, on its own inline source, rather than
// being added to `loose-list.md`.
// ---------------------------------------------------------------------------

const LIST_BULLET = /^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/;
const isIndentedLine = (line: string): boolean => /^\s{2,}\S/.test(line);

function findListOrphans(rendered: string, width: number): string[] {
  const lines = rendered.split("\n").map(stripAnsi);
  const orphans: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    // the bullet line itself has to be seen to open the list, so this runs from i = 0
    if (LIST_BULLET.test(line)) inList = true;
    else if (line.trim() !== "" && !isIndentedLine(line)) inList = false;

    if (i === 0) continue;
    if (!inList || line.trim() === "" || !isIndentedLine(line) || LIST_BULLET.test(line)) continue;

    const previous = lines[i - 1] as string;
    if (previous.trim() === "") continue;
    if (line.trim().split(/\s+/).filter(Boolean).length > 2) continue;
    if (stringWidth(previous) < width - 10) continue;

    // must continue into more prose in the same item, not simply end it
    const next = lines[i + 1];
    if (next === undefined || next.trim() === "" || !isIndentedLine(next) || LIST_BULLET.test(next)) continue;

    orphans.push(line.trim());
  }
  return orphans;
}

const WP2_WIDTHS = [80, 100, 120, 172];
const WP2_TIERS = [
  ["unicode", UNICODE_GLYPHS],
  ["ascii", ASCII_GLYPHS],
] as const;

describe("renderDocument — loose-list double-wrap (WP-2)", () => {
  test("the orphan metric detects a known-bad rendering and clears a known-good one", () => {
    const bad = ["    • alpha beta gamma delta epsilon zeta eta theta iota kappa", "      lambda", "      mu nu xi"].join(
      "\n",
    );
    expect(findListOrphans(bad, 64)).toEqual(["lambda"]);

    // same text, wrapped in one pass — no orphan
    const good = ["    • alpha beta gamma delta epsilon zeta eta theta iota kappa", "      lambda mu nu xi"].join("\n");
    expect(findListOrphans(good, 64)).toEqual([]);
  });

  test("tight lists, ordered lists, and plain prose emit no orphaned lines", () => {
    const source = [
      "- A tight list item written long enough that it wraps at every width under test, which is the point: tight items never reach the paragraph override at all.",
      "- A second tight item, also long enough to wrap across multiple lines, with no blank line separating it from its neighbour so the lexer leaves the list tight.",
      "",
      "1. An ordered tight item long enough to wrap, verifying the ordered marker path behaves the same way the unordered one does at every width under test.",
      "2. A second ordered item, also long enough to wrap over several lines at the widths under test, closing the ordered control list.",
      "",
      "This paragraph is not part of any list and is deliberately long enough to be reflowed by the paragraph renderer at every width under test, so a regression shows up here.",
    ].join("\n");

    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        expect(findListOrphans(renderDocument(source, width, glyphs), width)).toEqual([]);
      }
    }
  });

  test("no line of the loose-list fixture exceeds the target width — the defect is invisible to width gates", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        for (const line of renderDocument(source, width, glyphs).split("\n")) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  // Closed by WP-2b. Until then this fixture rendered 12/9/6/7 orphans at these four
  // widths; the paragraph override now renders a loose item at the width the item will
  // actually occupy, so `rewrapListBody` has nothing left to shear. The counts are the
  // only evidence that holds — every width gate stays green either way.
  test("loose list items emit no orphaned lines, at every width and both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        expect(findListOrphans(renderDocument(source, width, glyphs), width)).toEqual([]);
      }
    }
  });

  // The three lines this used to shear off, named individually: a count going to zero
  // proves nothing if the fixture stopped containing the case.
  test("the lines the defect used to shear are back on the line they belong to", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    const lines = renderDocument(source, 80, UNICODE_GLYPHS).split("\n").map(stripAnsi);

    for (const [orphan, follows] of [
      ["several", "rendered lines at any reasonable"],
      ["between", "items, which is what makes marked"],
      ["which the", "orphaned trailing word appears"],
    ] as const) {
      expect(lines.some((line) => line.trim() === orphan)).toBe(false);
      expect(lines.some((line) => line.includes(`${orphan} ${follows}`))).toBe(true);
    }
  });

  // Unsettled point 1 of the WP-2b brief. `"10. "` is four columns, not two: a budget
  // built on a hardcoded 2 leaves every line of a ten-item ordered loose list two
  // columns over, and `rewrapListBody` shears the tail off again. Counterfactual run
  // while writing this: forcing `listMarkerWidth` to return 2 puts 2 orphans back at
  // width 100 and 1 at width 172 in this fixture's ordered section.
  test("a loose ordered list wide enough to reach a two-digit marker wraps to the marker's real width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const tenth = lines.findIndex((line) => line.trimStart().startsWith("10. "));
      expect(tenth).toBeGreaterThan(-1);

      // the marker line and its continuations, up to the end of that item
      const item = [lines[tenth] as string];
      for (let i = tenth + 1; i < lines.length && isIndentedLine(lines[i] as string); i += 1) {
        if (LIST_BULLET.test(lines[i] as string)) break;
        item.push(lines[i] as string);
      }
      expect(item.length).toBeGreaterThan(1);
      for (const line of item) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      // continuations are indented under the four-column marker, not a two-column one
      expect((item[1] as string).length - (item[1] as string).trimStart().length).toBe(8);
      expect(findListOrphans(item.join("\n"), width)).toEqual([]);
    }
  });

  // Unsettled point 2. An authored break is real content: it must survive whatever the
  // list path does to wrapping. It is also the reason this WP re-renders the paragraph
  // at the right width instead of coalescing the wrapped result — by the time a result
  // reaches the override, `reflowText` has already turned its own wraps *and* the
  // author's break into the same bare `\n`.
  test("an authored <br /> break inside a loose list item survives", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const broken = lines.findIndex((line) => line.trimEnd().endsWith("A hard break follows this sentence."));
      expect(broken).toBeGreaterThan(-1);
      // the break held: the next line starts the following sentence, and it would
      // comfortably have fitted on the line above, so nothing but the break put it there
      expect((lines[broken + 1] as string).trim()).toStartWith("And this sentence must begin");
      expect(stringWidth(lines[broken] as string) + 1 + "And".length).toBeLessThan(width);
    }
  });

  // Unsettled point 4. Two paragraphs in one loose item fire the override twice; they
  // must not run into each other. Kept out of `loose-list.md` on purpose: the library
  // drops the blank line between an item's paragraphs (`bulletPointLines`' own
  // `.filter(identity)`), so a paragraph boundary is *indistinguishable* from a shear in
  // the rendered text, and `findListOrphans` flags the first paragraph's short last line
  // as an orphan. That is a blind spot of the metric, not a defect in the rendering —
  // see the WP-2b report. Asserted structurally here instead of by count.
  test("two paragraphs in one loose item stay two paragraphs", () => {
    const source = [
      "- The first paragraph of an item that carries two of them, written long enough that it wraps across more than one rendered line at every width under test.",
      "",
      "  The second paragraph of that very same item, also long enough to wrap, which must stay a separate block rather than being folded onto the end of the first one.",
      "",
      "- A closing item, long enough to wrap, so the two-paragraph item is not the last thing in the list and the list is unambiguously loose.",
    ].join("\n");

    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs);
        const lines = rendered.split("\n").map(stripAnsi);
        // the second paragraph starts its own line — never appended to the first's tail
        const second = lines.findIndex((line) => line.trim().startsWith("The second paragraph"));
        expect(second).toBeGreaterThan(-1);
        expect(lines.filter((line) => line.includes("under test. The second paragraph"))).toEqual([]);
        for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // Not one of the four unsettled points — found by the corpus byte-differential, and
  // a regression this WP would otherwise have shipped. `marked-terminal`'s
  // `isPointedLine` treats *any* line starting with `*` or `N.` as a marker line, and
  // an item's continuation lines sit at column 0 when it runs. Moving a wrap point can
  // therefore hand it a line it mistakes for a marker: in an ordered list that line
  // consumes an item number and every later item is renumbered. Counterfactual, with
  // the guard in `render.ts` disabled: this renders as 1, 2001, 3, 4.
  test("a continuation line that starts like a list marker does not steal an item number", () => {
    const build = (fillers: number): string =>
      [
        `1. ${Array.from({ length: fillers }, (_, i) => `word${i}`).join(" ")} 2001. Marks the start of a sentence, and the item then continues for a good while afterwards so that it wraps more than once in total.`,
        "",
        "2. A second ordered item, long enough to wrap at the widths under test, closing the list.",
        "",
        "3. A third ordered item, also long enough to wrap at the widths under test.",
      ].join("\n");

    // filler counts chosen so the `2001.` token lands at the start of a wrapped line
    for (const [fillers, width] of [
      [17, 120],
      [27, 100],
      [25, 172],
    ] as const) {
      const lines = renderDocument(build(fillers), width)
        .split("\n")
        .map(stripAnsi)
        .filter((line) => line.trim() !== "");

      // the token is where we think it is — otherwise this test proves nothing
      expect(lines.some((line, index) => index > 0 && line.trim().startsWith("2001."))).toBe(true);
      // item markers are still 1, 2, 3 at the depth-1 indent
      expect(lines.map((line) => /^ {4}(\d+)\.\s/.exec(line)?.[1]).filter(Boolean)).toEqual(["1", "2", "3"]);
      // and no `"* "` inside the text was rewritten into a number
      expect(lines.filter((line) => /\*\d+\.\s/.test(line))).toEqual([]);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // Unsettled point 3. The budget subtracts one marker + one indent *per enclosing
  // level*, so an off-by-a-level shows up as either overflow (too shallow — caught by
  // the width test above) or a visibly short right edge (too deep). Depth 2 at width 80
  // fills to 79 of 80; a depth-3 budget would cap it around 73.
  test("a nested loose list is wrapped at its own depth's budget, not its parent's", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const nested = lines.filter((line) => /^\s{8}/.test(line) && line.trim() !== "");
      expect(nested.length).toBeGreaterThan(3);
      const widest = Math.max(...nested.map((line) => stringWidth(line)));
      expect(widest).toBeLessThanOrEqual(width);
      expect(widest).toBeGreaterThanOrEqual(width - 4);
    }
  });
});
