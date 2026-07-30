import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, mock, test } from "bun:test";
import stringWidth from "string-width";
import type { Tokens } from "marked";
import { highlight as cliHighlight } from "cli-highlight";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
// WP-2d moved these out of this file and into `src/detectors.ts` so the corpus sweep
// measures with the same implementation the test suite does. The move was verified to
// change no count: 58 aggregate metrics (4 fixtures x 6 widths x 2 tiers, plus a
// 1,000-file corpus sample at 5 widths) and all 17 per-file corpus entries were
// byte-identical before and after. **Do not reimplement any of them here.**
import {
  LIST_BULLET,
  findColumnZeroMarkers,
  findContinuationOverIndent,
  findListOrphans,
  isIndentedLine,
  stripAnsi,
} from "../src/detectors";
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
// every gate. `findListOrphans` is therefore the only thing that tests it.
//
// The metric itself — definition, its one known blind spot, and why neither may be
// loosened — now lives in `src/detectors.ts`, imported above. It moved there in
// WP-2d so `scripts/sweep.ts` measures with this exact implementation rather than a
// second copy that drifts from it. Read that module's doc comment before touching
// any orphan assertion here.
// ---------------------------------------------------------------------------

// **116, 172 and 346 are the user's three real terminal widths** (the three tiled
// layouts); 116 and 346 were added in WP-2c, which found the orphan defect had until
// then been measured only at 80/100/120/172 — one real width out of four. 80/100/120
// stay: they are the WP-2b baseline and 80 is the narrowest case the wrap has to
// survive.
const WP2_WIDTHS = [80, 100, 116, 120, 172, 346];

// The subset at which these fixtures actually wrap. A handful of assertions below are
// *structural* — "this item spans more than one line", "the nested block fills its
// budget to within 4 columns" — and at 346 columns the fixture text simply fits on one
// line, which would make them assert nothing (or fail) for a reason that has nothing to
// do with the behaviour under test. Orphan counts and width bounds are checked at every
// width in `WP2_WIDTHS`, including 346; only shape assertions use this narrower set.
const WP2_WRAPPING_WIDTHS = WP2_WIDTHS.filter((width) => width <= 172);

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
    for (const width of WP2_WRAPPING_WIDTHS) {
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
    for (const width of WP2_WRAPPING_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const nested = lines.filter((line) => /^\s{8}/.test(line) && line.trim() !== "");
      expect(nested.length).toBeGreaterThan(3);
      const widest = Math.max(...nested.map((line) => stringWidth(line)));
      expect(widest).toBeLessThanOrEqual(width);
      expect(widest).toBeGreaterThanOrEqual(width - 4);
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2c — the same visual defect, in *tight* lists, by a different mechanism.
//
// A tight item is not a paragraph token, so `marked-terminal` never reflows it and the
// author's own line breaks reach `rewrapListBody` verbatim. Adding the six columns of
// marker and indent pushes each authored line over the target and `rewrapListBody`
// splits it *per line*, shearing the tail word onto a line of its own.
//
// **The load-bearing premise is that a hard break is still distinguishable here.** It is
// — but not as `marked-terminal`'s `HARD_RETURN`. Its `br` renderer never fires for a
// tight item (`Renderer.prototype.text`, `index.js:84-89`, renders a block text token
// from raw `token.text` and never dispatches `token.tokens`), so the *markdown source
// spelling* of the break arrives instead. The first test below is that premise, asserted
// directly rather than assumed; if it ever stops holding, safe coalescing is impossible
// and the rest of this block is unsound.
//
// The metric is `findListOrphans`, unchanged and shared with WP-2b above.
// ---------------------------------------------------------------------------

describe("renderDocument — tight-list authored soft breaks (WP-2c)", () => {
  const at = (source: string, width: number, glyphs = UNICODE_GLYPHS): string[] =>
    renderDocument(source, width, glyphs).split("\n").map(stripAnsi);

  // The premise. A soft break is a space; a hard break is a line. Both are authored, and
  // only the source spelling tells them apart at this seam.
  test("a soft break in a tight item is joined and each authored hard break is kept", () => {
    const tail = "and this trailing text is here purely so that the item is long enough to be interesting.";
    const cases = [
      ["soft", `- A first line with no break marker at its end\n  ${tail}\n`, true],
      ["two trailing spaces", `- A first line ending in two spaces  \n  ${tail}\n`, false],
      ["trailing backslash", `- A first line ending in a backslash\\\n  ${tail}\n`, false],
      ["<br />", `- A first line ending in a break tag.<br />\n  ${tail}\n`, false],
      ["<br>", `- A first line ending in a bare break tag.<br>\n  ${tail}\n`, false],
    ] as const;

    for (const [name, source, shouldJoin] of cases) {
      // 200 columns: the whole item fits on one rendered line, so the *only* thing that
      // can put the tail on a line of its own is the break itself, never the wrap.
      const lines = at(source, 200).filter((line) => line.trim() !== "");
      expect(`${name} -> ${lines.length} line(s)`).toBe(`${name} -> ${shouldJoin ? 1 : 2} line(s)`);
      // whichever way it went, the text itself is intact and in order
      expect(lines.join(" ").replace(/\s+/g, " ")).toContain(tail);
    }
  });

  test("tight list items emit no orphaned lines, at every width and both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        expect(findListOrphans(renderDocument(source, width, glyphs), width)).toEqual([]);
      }
    }
  });

  test("no line of the tight-list fixture exceeds the target width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        for (const line of renderDocument(source, width, glyphs).split("\n")) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  // A count going to zero proves nothing if the fixture stopped containing the case, so
  // the words this defect used to shear off are named individually. Counterfactual,
  // measured on the parent commit with this fixture: 2/12/3/3/1/0 orphans at
  // 80/100/116/120/172/346.
  test("the words the defect used to shear are back on the line they belong to", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [width, orphan, follows] of [
      [100, "previous pass", "has already written out"],
      [116, "middling", "terminal looks like"],
      [172, "and which", "therefore only shears"],
    ] as const) {
      const lines = at(source, width);
      expect(lines.some((line) => line.trim() === orphan)).toBe(false);
      expect(lines.some((line) => line.includes(`${orphan} ${follows}`))).toBe(true);
    }
  });

  // The two ways this change can silently destroy content, neither of which any width
  // gate can see. A long token is never joined *into* — it was never split, because
  // nothing reflowed the item — and a fence is never reached at all, because it is a
  // `code` token and this pass only ever sees `text` tokens.
  test("a long URL and a long path survive a coalescing pass intact", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    const url = "https://example.invalid/a/deliberately/long/url/that/must/never/be/split/or/joined/mid-token/ok";
    const path = "/home/example/some/deliberately/long/filesystem/path/that/must/also/survive/a/join/verbatim.md";
    for (const width of WP2_WIDTHS) {
      const rendered = at(source, width).join("\n");
      for (const token of [url, path]) {
        if (width - 6 >= token.length) {
          // fits: it must appear whole, on one line, with nothing inserted into it
          expect(rendered).toContain(token);
        } else {
          // does not fit: `wrapAnsi` hard-splits it (never ellipsizes), and the pieces
          // must still rejoin to the original token, in order, losslessly
          expect(rendered.replace(/\n\s*/g, "")).toContain(token);
        }
      }
    }
  });

  test("fenced content inside a tight list item is byte-identical to its source", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).map((line) => line.trim());
        // the three fence lines, including the `*`/`N.` decoys and the double space
        expect(rendered).toContain("# * not a bullet, and 1. not a marker");
        expect(rendered).toContain("bun run --cwd mdview sweep");
        expect(rendered).toContain('echo "two  spaces above are not a break"');
      }
    }
  });

  test("coalescing never crosses an item or a nested-list boundary", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const rendered = at(source, width).join("\n");
      // one item's tail never lands on the same line as the next item's head
      expect(rendered).not.toContain("at any width at all. A third item");
      expect(rendered).not.toContain("would then skip. An item authored");
      // the outer item's tail never lands on the nested item's head, or vice versa
      expect(rendered).not.toContain("reached at all. A nested item");
      expect(rendered).not.toContain("of its own too. A closing outer item");
    }
  });

  // The guard against joining across a *blank* line is what keeps this out of the loose
  // path entirely, but the loose fixture is the direct control: WP-2b closed it and this
  // WP must not move it. Its tight sections are each authored on a single source line, so
  // they carry no soft break for this pass to act on either.
  test("the loose-list fixture is untouched — no orphans, no overflow, at every width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs);
        expect(findListOrphans(rendered, width)).toEqual([]);
        for (const line of rendered.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // The pass is gated on being inside a list, in a block position, on a token that
  // carries inline `tokens`. Prose authored wrapped exactly like the items is the control
  // for the first condition: it is reflowed by the paragraph renderer, never by this.
  test("authored line breaks in non-list prose are not this pass's business", () => {
    const source =
      "A paragraph authored wrapped at a narrow column,\nwith a second source line,\nand a third one after that.\n";
    const whole = "A paragraph authored wrapped at a narrow column, with a second source line, and a third one after that.";
    for (const width of WP2_WIDTHS) {
      const lines = at(source, width).filter((line) => line.trim() !== "");
      // The paragraph renderer reflows it: the authored breaks are gone and the text is
      // laid out to the *full* target width, not to any list budget. It is one line at
      // every width here except 80, where the library's own wrap splits it.
      expect(lines.join(" ")).toBe(whole);
      // and it was laid out to the *full* target width, not to any list budget: the
      // authored breaks are gone, so no rendered line ends where a source line did
      expect(lines.some((line) => line.endsWith("narrow column,") || line.endsWith("source line,"))).toBe(false);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // `- [x] ` items carry `TASK_STATE_SENTINEL` between the bracket and the state char,
  // and coalescing runs over the text that holds it. It must arrive at the strip pass
  // intact — a lost sentinel means `[X]  done` (rebuilt by the dead `checkbox` seam)
  // instead of the literal source text.
  test("task states survive coalescing in both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      expect(at(source, width, UNICODE_GLYPHS).join("\n")).toContain("✓ A completed task");
      expect(at(source, width, UNICODE_GLYPHS).join("\n")).toContain("◐ An in-progress task");
      const ascii = at(source, width, ASCII_GLYPHS).join("\n");
      expect(ascii).toContain("[x] A completed task");
      expect(ascii).toContain("[/] An in-progress task");
      // and neither sentinel ever reaches the output
      expect(ascii).not.toContain(String.fromCharCode(1));
      expect(ascii).not.toContain(String.fromCharCode(0));
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2e — the nested-list continuation over-indent.
//
// A continuation line inside a *nested* item was indented past its own item's first
// line, one marker width per ancestor level, because `marked-terminal`'s
// `bulletPointLines` / `numberedLines` pad every line their `isPointedLine` does not
// recognize — which is every continuation of an inner list that already rendered, but
// none of that inner list's marker lines. See `realignNestedContinuations` in
// `src/render.ts` for the mechanism, and for why the fix subtracts the drift instead of
// snapping lines to a column.
//
// **It is not a cosmetic defect and it is not a second metric.** A continuation shifted
// right is a continuation over budget, so the shallower `rewrapListBody` sheared its
// tail word onto a line of its own — the same orphan WP-2/2b/2c chased, from a source
// none of them had isolated. Measured on this fixture at 80/100/116/120/172/346, both
// glyph tiers, on the parent commit: **36/25/21/19/10/3 over-indents and 8/6/4/3/1/0
// orphans**, against 0 and 0 after. The orphans go away *with* the indent, and nothing
// in the orphan path was touched to make that happen — which is the whole claim.
//
// Both detectors are `src/detectors.ts`'s, unchanged; this block passes `codeRanges`
// because fenced code is never rewritten and its shape is not ours to guarantee.
// ---------------------------------------------------------------------------

describe("renderDocument — nested-list continuation over-indent (WP-2e)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/nested-list.md`, "utf8");
  const at = (source: string, width: number, glyphs = UNICODE_GLYPHS): string[] =>
    renderDocument(source, width, glyphs).split("\n").map(stripAnsi);

  test("no continuation of the nested-list fixture is indented past its own item, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        expect(findContinuationOverIndent(text, { codeRanges })).toEqual([]);
      }
    }
  });

  // The causal claim, on the same fixture and in the same shape as WP-2b's and WP-2c's
  // assertions: fixing the indent is what removes these, not a separate wrap change.
  test("the nested-list fixture emits no orphaned lines, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        expect(findListOrphans(text, width, { codeRanges })).toEqual([]);
      }
    }
  });

  // **Code ranges are exempt here, and were not before WP-2f — this assertion used to
  // pass for the wrong reason.** The tool's guarantee is "no *non-code* line exceeds the
  // width" (`AGENTS.md`, rendering policy; `--check` and both sweeps skip code ranges).
  // Until WP-2f this fixture's fenced content happened to fit anyway, because
  // `rewrapListBody` was splitting it — the very invariant violation WP-2f closed. With
  // the fence left alone, its longest content line is 81 columns at width 80, exempt.
  test("no line of the nested-list fixture exceeds the target width, outside its fences", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of text.split("\n").entries()) {
          if (codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  // A count going to zero proves nothing if the fixture stopped containing the case, so
  // the words this defect used to shear are named individually, as WP-2c does. **Not**
  // "reunited with the word that followed them", which is WP-2c's form and is wrong here:
  // this fix moves the whole item two to four columns left, so the item reflows and the
  // neighbour a word lands beside legitimately changes. What must hold is that none of
  // them is stranded on a line of its own any more, and that none of them went missing.
  // Every entry below was alone on a line on the parent commit, at that width.
  test("the words the defect used to shear are no longer alone on a line", async () => {
    const source = await fixture();
    for (const [width, sheared] of [
      [80, ["once", "drifted", "more", "pass", "lines", "multiple", "bullet"]],
      [100, ["to.", "that", "full", "them", "against"]],
      [116, ["as", "one", "bullet"]],
      [120, ["from", "columns"]],
      [172, ["and"]],
    ] as const) {
      const lines = at(source, width);
      for (const word of sheared) {
        expect(`w${width} "${word}" alone: ${lines.some((line) => line.trim() === word)}`).toBe(
          `w${width} "${word}" alone: false`,
        );
        expect(`w${width} "${word}" present: ${lines.some((line) => line.includes(word))}`).toBe(
          `w${width} "${word}" present: true`,
        );
      }
    }
  });

  // The columns themselves, at the widths these fixtures wrap at, read straight off the
  // output rather than through a detector — the pass and `findContinuationOverIndent`
  // now share a stack model, so one flat reading of the rendered text is the independent
  // check on both.
  test("each nested item's continuations sit at exactly its own marker's text column", async () => {
    const source = await fixture();
    for (const width of WP2_WRAPPING_WIDTHS) {
      const { text, codeRanges } = renderDocumentDetailed(source, width);
      const lines = text.split("\n").map(stripAnsi);
      const inFence = (index: number): boolean =>
        codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
      let expected: number | null = null;
      let sawNested = false;
      for (const [index, line] of lines.entries()) {
        if (line.trim() === "") continue;
        // fenced content keeps whatever indent the library gave it — never rewritten
        if (inFence(index)) continue;
        const marker = /^(\s{2,}(?:[•◦‣]|\d+\.)\s+)/.exec(line);
        if (marker) {
          const prefix = marker[1] as string;
          expected = prefix.length;
          if (prefix.length - prefix.trimStart().length > 4) sawNested = true;
          continue;
        }
        if (!isIndentedLine(line) || expected === null) {
          expected = null;
          continue;
        }
        expect(`${line.trim().slice(0, 24)} @ ${line.length - line.trimStart().length}`).toBe(
          `${line.trim().slice(0, 24)} @ ${expected}`,
        );
      }
      expect(sawNested).toBe(true);
    }
  });

  // The landmine this pass walks past on every line it looks at: `substituteBullets`
  // honours `SENTINEL`, `rewrapListBody` does not (WP-2f), and adding a second offender
  // would have been invisible to all seven gates, since code ranges are exempt from
  // width checking. The decoys are the two marker shapes on the fence's first line.
  test("a fence nested inside a nested list item keeps its own content", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).map((line) => line.trim());
        expect(rendered).toContain("# * not a bullet, and 1. not a marker");
        expect(rendered).toContain("bun run --cwd mdview sweep");
        // WP-2f: `rewrapListBody` split this line in two on the parent commit at width
        // 80 — the same fixture, the same fence, a different pass. It is 81 columns and
        // now overflows instead, which is what fenced code does everywhere else.
        expect(rendered).toContain('echo "these four leading spaces are content, not indentation"');
      }
    }
  });

  // **The reason the pass subtracts a drift instead of snapping to a column.** A
  // blockquote inside a list item is indented past its item's text column by its own
  // renderer, legitimately, and `findContinuationOverIndent` reports it all the same.
  // Snapping every reported line to `item.textColumn` would flatten the quote into the
  // prose around it; subtracting only what the list level added preserves the offset —
  // at every depth, which is what the second assertion is for.
  test("a blockquote inside a list item keeps its own indent relative to that item", () => {
    const source = [
      "- An outer item long enough to wrap at every width under test, so that its own continuation lines exist and can be told apart from the quoted block that follows them.",
      "",
      "  > A quoted block inside that item, also long enough to wrap, whose lines belong four columns to the right of the item's own text and must stay there.",
      "",
      "  - A nested item long enough to wrap at every width under test, carrying a quote of its own so the same offset is checked one level down as well.",
      "",
      "    > A quoted block inside the nested item, long enough to wrap, four columns right of that item's text column and not of its parent's.",
      "",
    ].join("\n");

    for (const width of WP2_WRAPPING_WIDTHS) {
      const lines = at(source, width);
      const columnOf = (needle: string): number => {
        const line = lines.find((candidate) => candidate.includes(needle));
        expect(line === undefined ? `${needle}: missing` : `${needle}: present`).toBe(`${needle}: present`);
        return (line as string).length - (line as string).trimStart().length;
      };
      // outer item's text column is 6 (4 of indent + 2 of bullet); its quote sits at 10
      expect(columnOf("A quoted block inside that item")).toBe(10);
      // nested item's text column is 10; its quote sits at 14, not at the outer quote's 10
      expect(columnOf("A quoted block inside the nested item")).toBe(14);
    }
  });

  // Nothing is ever ellipsized, and a token too long for its own budget is hard-split and
  // rejoins losslessly — including inside a nested item, where this pass changes the
  // column the split happens at and therefore where in the token it happens.
  test("a long token inside a nested item is hard-split losslessly, never ellipsized", async () => {
    const source = await fixture();
    const token =
      "https://example.invalid/a/second/deliberately/long/url/inside/a/nested/list/item/which/must/also/survive/verbatim/ok";
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).join("\n");
        expect(rendered).not.toContain("…");
        expect(rendered.replace(/\n\s*/g, "")).toContain(token);
      }
    }
  });

  // WP-2b's and WP-2c's fixtures are the direct control for this change: it is the first
  // one to rewrite an already-composed list body rather than to decide where text wraps,
  // so it is the first that could move them without touching either wrapping override.
  test("the loose-list and tight-list fixtures are untouched — no orphans, no over-indents, no overflow", async () => {
    for (const name of ["loose-list", "tight-list"]) {
      const source = await readFile(`${import.meta.dir}/fixtures/${name}.md`, "utf8");
      for (const [, glyphs] of WP2_TIERS) {
        for (const width of WP2_WIDTHS) {
          const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
          expect(`${name}: ${findListOrphans(text, width).join(",")}`).toBe(`${name}: `);
          expect(findContinuationOverIndent(text, { codeRanges })).toEqual([]);
          for (const line of text.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2f — fenced code inside a list item, and the marker-shaped continuation.
//
// **Both invariants here are invisible to all seven gates, for the same structural
// reason.** `--check` and both sweeps exempt recorded `codeRanges` from width checking,
// so a pass that *corrupts* a line inside one cannot make a width gate fail — and a
// continuation line that starts `*` is under the width by definition. `rewrapListBody`
// shipped from WP-2 with neither the `SENTINEL` walk `substituteBullets` and
// `realignNestedContinuations` both have, nor the `MARKER_SHAPED_LINE` guard both
// wrapping overrides have.
//
// Measured on the parent commit over a 1,000-file corpus sample of fence-carrying files
// at 80 and 116: **154 of 37,246 fenced source lines did not survive verbatim; 0 after**
// (the 19 that remain either side are the same lines, and are the metric's own fence
// parity disagreeing with marked's lexer on nested fences — not a rendering change).
// This fixture is the public-safe frozen version of that case.
//
// The one assertion deliberately **not** made here is the orphan count: the fixture puts
// short prose lines immediately in front of fences on purpose, and a text token's natural
// short last line before a fence is a block boundary, not a shear — one of the two
// documented blind spots in `findListOrphans`. `loose-list`, `tight-list` and
// `nested-list` remain the orphan gates; this fixture is the fence-integrity gate.
// ---------------------------------------------------------------------------

describe("renderDocument — fenced code inside list items (WP-2f)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/fenced-list.md`, "utf8");

  // 54/55 and 101 are the other widths at which the marker guard fires on this fixture;
  // 100 is already in `WP2_WIDTHS`. Named rather than swept so a change that moves the
  // break points shows up as a failure here instead of silently rendering the case inert.
  const WP2F_WIDTHS = [...WP2_WIDTHS, 54, 55, 101];

  /** Every non-blank content line of every fenced block in the fixture's source. */
  const fencedSourceLines = (source: string): string[] => {
    const out: string[] = [];
    let open = false;
    for (const line of source.split("\n")) {
      if (/^\s*```/.test(line)) {
        open = !open;
        continue;
      }
      if (open && line.trim() !== "") out.push(line.trim());
    }
    return out;
  };

  test("the fixture actually contains the case — fences in loose, tight and nested items", async () => {
    const lines = fencedSourceLines(await fixture());
    expect(lines.length).toBe(5);
    // the one-line block: its opening and closing markers land on the same physical
    // rendered line, so it never *starts* inside a fence — the case that decides how
    // strict the sentinel walk has to be.
    expect(lines.some((line) => line.startsWith("printf"))).toBe(true);
    // the decoys: fence content that both marker-shaped passes would otherwise claim
    expect(lines.some((line) => line.startsWith("* not a bullet, and 1. not a marker"))).toBe(true);
  });

  test("every fenced source line survives verbatim, on one rendered line, at every width and both tiers", async () => {
    const source = await fixture();
    const fenced = fencedSourceLines(source);
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line).trim());
        for (const line of fenced) {
          expect(`${tier} w${width}: ${rendered.includes(line)}`).toBe(`${tier} w${width}: true`);
        }
      }
    }
  });

  // The decision this WP had to make and record: an over-budget fence line inside a list
  // item **overflows**, exactly as fenced code does everywhere else. That is only
  // self-consistent if the resulting long lines are actually exempt — so this asserts the
  // exemption rather than assuming it. A failure here means the tool is now emitting
  // overflow that `--check` and the sweep would have to be widened to tolerate, which is
  // the one outcome this WP is not allowed to produce.
  test("every over-width line lands inside a recorded code range, and nothing else exceeds the width", async () => {
    const source = await fixture();
    let sawOverflow = false;
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        const inFence = (index: number): boolean =>
          codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
        for (const [index, line] of text.split("\n").entries()) {
          if (stringWidth(stripAnsi(line)) <= width) continue;
          sawOverflow = true;
          expect(`${tier} w${width} line ${index + 1} exempt: ${inFence(index)}`).toBe(
            `${tier} w${width} line ${index + 1} exempt: true`,
          );
        }
      }
    }
    // the fixture is only evidence if some line really does overflow
    expect(sawOverflow).toBe(true);
  });

  // The marker-shaped-continuation case, demonstrated rather than asserted in the
  // abstract. This pass breaks the last item's line so that a continuation begins with
  // the author's bare `*`, and `substituteBullets` — which runs after it, over the same
  // body — used to match a leading `*` at *any* indent and rewrote it into the depth's
  // bullet glyph. Measured over every width in 40-360, both tiers: **the parent commit
  // corrupts it at 54, 55, 100 and 101; this one at none of them.**
  //
  // In an ordered list `numberedLine` is the second consumer of the same shape, so the
  // numbers are checked too. Widths 54/55/101 are named in `WP2F_WIDTHS` for exactly
  // this reason — the case is inert at most widths and 100 is the only one of the four
  // that the standard set covers.
  test("a continuation line never starts with the author's own `*`, and no list is renumbered", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const lines = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line));
        const rendered = lines.join("\n");
        // the author's glob survives as a glob — measured across the soft wrap, since at
        // some widths the break falls between the `*` and the word after it
        const flowed = rendered.replace(/\s+/g, " ");
        expect(`${tier} w${width}: ${flowed.includes("* zero or more")}`).toBe(`${tier} w${width}: true`);
        for (const bullet of [...UNICODE_GLYPHS.bullets, ...ASCII_GLYPHS.bullets]) {
          expect(`${tier} w${width}: ${rendered.includes(`${bullet} zero or more`)}`).toBe(`${tier} w${width}: false`);
        }
        // and no line *inside a list body* is claimable by `isPointedLine`: a non-zero
        // exact multiple of four spaces, then a literal marker. Fence lines keep whatever
        // the library gave them and are not this pass's to shape; a column-zero paragraph
        // is not in a list body at all, and the library never scans it.
        const { codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of lines.entries()) {
          if (codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
          if (!/^(?: {4})+\*/.test(line)) continue;
          expect(`${tier} w${width} line ${index + 1}: ${line.trim().slice(0, 32)}`).toBe(
            `${tier} w${width} line ${index + 1}: <no marker-shaped continuation>`,
          );
        }
        // both ordered lists keep their own numbering: two items, then three. A
        // renumbering would show up as an extra number in this sequence, which is what
        // happens when `numberedLine` claims a line that only *looks* like a marker.
        const numbers = lines
          .filter((line, index) => !codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end))
          .map((line) => /^ {4,}(\d+)\.\s/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]));
        expect(`${tier} w${width}: ${numbers.join(",")}`).toBe(`${tier} w${width}: 1,2,1,2,3`);
      }
    }
  });

  // Nothing is ever ellipsized, and the fence's content is not merely present but
  // uncut: the longest command in the fixture is 106 columns and must appear whole even
  // at width 40, where every other line has been wrapped four times over.
  test("the longest fenced command is never split or ellipsized, at any width in 40-360", async () => {
    const source = await fixture();
    const command =
      'echo "a deliberately very long command line that must never be rewrapped or reindented at all, at any width"';
    for (let width = 40; width <= 360; width += 20) {
      const rendered = renderDocument(source, width);
      expect(`w${width}: ${rendered.includes("…")}`).toBe(`w${width}: false`);
      expect(`w${width}: ${rendered.split("\n").some((line) => stripAnsi(line).trim() === command)}`).toBe(
        `w${width}: true`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2g — lists inside blockquotes, and the indent-destroying re-wrap.
//
// **The gate is a new invariant, because neither existing detector can see this class.**
// `findListOrphans` and `findContinuationOverIndent` both require `isIndentedLine`, so a
// line that collapsed to column 0 is skipped by each of them — no number either of them
// produces is evidence here, in either direction. `findColumnZeroMarkers` is WP-2g's own
// instrument and goes to zero on this fixture.
//
// Two independent mechanisms, and the severe one was ours: `wrapOverBudgetLines` re-wrapped
// any over-budget line with `wrapAnsi(line, targetWidth)`, which starts each emitted line
// at a *word* and so discards the line's leading indent even when the line does not have
// to be split at all — and the `blockquote` caller is the one whose lines are all
// indented. The milder one is the library's: `indentify(this.tab, quote.trim())`
// (`index.js:106`) costs the body's first line its own indent, leaving a quoted list's
// first marker four columns left of its siblings at any width where nothing wraps.
//
// Measured over the 95 corpus files that put a list inside a blockquote, at widths
// 40/80/116/346: **column-0 markers 471 -> 4** (the residual 4 are one authored numbered
// paragraph in one file, present identically on the parent), and on the tier-pure
// sub-count of substituted bullet glyphs, **406 -> 0**.
// ---------------------------------------------------------------------------

describe("renderDocument — lists inside blockquotes (WP-2g)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/blockquote-list.md`, "utf8");

  // 40 is the narrowest realistic tiled pane and the width at which this fixture's quoted
  // items wrap hardest; 55 is where the WP-2f marker guard fires on its sibling fixture.
  const WP2G_WIDTHS = [40, 55, ...WP2_WIDTHS];

  test("the fixture actually contains every direction of the case", async () => {
    const source = await fixture();
    // a list inside a blockquote, unordered and ordered, plus a nested level
    expect(/^> - /m.test(source)).toBe(true);
    expect(/^> 1\. /m.test(source)).toBe(true);
    expect(/^>\s+- /m.test(source)).toBe(true);
    // a blockquote inside a blockquote, and a blockquote inside a *list item*
    expect(/^> > - /m.test(source)).toBe(true);
    expect(/^ {2}> /m.test(source)).toBe(true);
    // fenced code inside a blockquote, including the one-line shape
    expect(/^> ```/m.test(source)).toBe(true);
  });

  test("no rendered list marker sits at column 0, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (let width = 40; width <= 360; width += 1) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        const found = findColumnZeroMarkers(text, { codeRanges });
        expect(`${tier} w${width}: ${found.map((hit) => `${hit.line}:${hit.text.slice(0, 24)}`).join(" | ")}`).toBe(
          `${tier} w${width}: `,
        );
      }
    }
  });

  // The stronger form of the same invariant, and the one that cannot be argued with: a
  // bullet *glyph* is written only by `substituteBullets`, which matches its marker on the
  // four-column grid, so one at column 0 can only have got there by a later pass moving
  // the line left. No adjacency heuristic, no authored-prose ambiguity.
  test("no substituted bullet glyph ever appears at column 0", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (let width = 40; width <= 360; width += 1) {
        const offenders = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line))
          .filter((line) => [...UNICODE_GLYPHS.bullets, ...ASCII_GLYPHS.bullets].some((b) => line.startsWith(`${b} `)));
        expect(`${tier} w${width}: ${offenders.join(" | ")}`).toBe(`${tier} w${width}: `);
      }
    }
  });

  // The library's `quote.trim()`, and the *only* symptom it has on its own: at a width
  // where nothing wraps, a quoted list's first item is four columns left of its siblings.
  // Asserted as "every marker of one list is at one column" rather than as a literal
  // column, so it stays true if the blockquote's own indent ever changes.
  test("a quoted list's items are siblings at one column, at a width where nothing wraps", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      const lines = renderDocument(source, 400, glyphs)
        .split("\n")
        .map((line) => stripAnsi(line));
      const start = lines.findIndex((line) => line.includes("A list item inside a blockquote"));
      const second = lines.findIndex((line) => line.includes("A second item, also long enough"));
      expect(`${tier}: ${start >= 0 && second >= 0}`).toBe(`${tier}: true`);
      const columnOf = (line: string): number => line.length - line.trimStart().length;
      expect(`${tier}: ${columnOf(lines[start] as string)}`).toBe(`${tier}: ${columnOf(lines[second] as string)}`);
      // and it is the blockquote's indent on top of the list's, not either one alone
      expect(`${tier}: ${columnOf(lines[start] as string)}`).toBe(`${tier}: 8`);
    }
  });

  // A blockquote *inside* a list item is legitimately indented past its item's text
  // column by its own renderer — WP-2e's non-negotiable, restated here because this WP
  // touches the other side of the same relationship. The quote must be deeper than the
  // item's text column, and the item's own trailing prose must come back to it.
  test("a blockquote inside a list item stays legitimately deeper, and its item's prose returns", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const lines = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line));
        const columnOf = (needle: string): number => {
          const line = lines.find((candidate) => candidate.includes(needle));
          return line === undefined ? -1 : line.length - line.trimStart().length;
        };
        const item = columnOf("A list item that");
        const quoted = columnOf("Quoted prose inside");
        const trailing = columnOf("Trailing prose belonging");
        // the marker line's *text* column is the marker column plus the marker's width
        expect(`${tier} w${width}: ${quoted > item && trailing > item && quoted > trailing}`).toBe(
          `${tier} w${width}: true`,
        );
      }
    }
  });

  // `wrapOverBudgetLines` had no `SENTINEL` walk either, and a fence inside a blockquote
  // reaches it already bracketed. Both fence shapes are in the fixture, including the
  // one-line block whose whole content sits on a line that both opens and closes the
  // pair — the shape that forces the stricter of the two walks in this file.
  test("every fenced source line inside a blockquote survives verbatim on one line", async () => {
    const source = await fixture();
    const fenced: string[] = [];
    let open = false;
    for (const raw of source.split("\n")) {
      const line = raw.replace(/^(\s*>)+\s?/, "");
      if (/^\s*```/.test(line)) {
        open = !open;
        continue;
      }
      if (open && line.trim() !== "") fenced.push(line.trim());
    }
    expect(fenced.length).toBe(3);
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line).trim());
        for (const line of fenced) {
          expect(`${tier} w${width}: ${rendered.includes(line)}`).toBe(`${tier} w${width}: true`);
        }
      }
    }
  });

  // Same decision as WP-2f, one seam over: an over-budget fence line inside a blockquote
  // overflows rather than wrapping, and that is only self-consistent because it stays
  // inside a recorded range. Asserted, not assumed.
  test("every over-width line lands inside a recorded code range", async () => {
    const source = await fixture();
    let sawOverflow = false;
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of text.split("\n").entries()) {
          if (stringWidth(stripAnsi(line)) <= width) continue;
          sawOverflow = true;
          const exempt = codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
          expect(`${tier} w${width} line ${index + 1} exempt: ${exempt}`).toBe(
            `${tier} w${width} line ${index + 1} exempt: true`,
          );
        }
      }
    }
    expect(sawOverflow).toBe(true);
  });

  // Quoted content is wrapped at the quote's own budget, not at the full width — the
  // `paragraph` override's gate had to move from "are we in a list" to "does anything
  // still owe columns" once the safety net stopped hiding the overflow by deleting the
  // indent. Without that, every wrapped line of quoted prose is 4 columns over and the
  // net shears a word off each of them.
  test("no continuation inside a blockquote is indented past its own item, and none is orphaned", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const lines = renderDocument(source, width, glyphs).split("\n");
        // Scoped to the fixture's *quoted-list* half, which ends at "The other
        // direction": everything after it is the legitimately-deeper cases (a quote
        // inside a list item) and the fences, and `findContinuationOverIndent` reports
        // the legitimate class identically to the defect — it is not a to-do list.
        // That half carries no fence, so no code ranges are in play.
        const cut = lines.findIndex((line) => stripAnsi(line).includes("The other direction"));
        expect(`${tier} w${width}: ${cut > 0}`).toBe(`${tier} w${width}: true`);
        const over = findContinuationOverIndent(lines.slice(0, cut).join("\n"));
        expect(`${tier} w${width}: ${over.map((hit) => hit.text.slice(0, 30)).join(" | ")}`).toBe(`${tier} w${width}: `);
      }
    }
  });
});

// WP-11 (representative-corpus, formerly WP-7): shortcode substitution follows the
// glyph tier — Unicode renders the glyph (the default, matching `marked-terminal`'s own
// default), ASCII cannot draw it and keeps the literal shortcode, and
// `MdviewConfig.emoji` (`src/config.ts`) overrides either direction via the
// `emojiOverride` argument `renderDocumentDetailed`/`renderDocument` now accept. See
// `src/render.ts`'s `emoji` computation at the top of `renderDocumentDetailed` and
// `AGENTS.md`'s emoji section for why this is no longer a hardcoded constant.
//
// These tests fail if any of the three `markedTerminal()` construction sites — the
// main one, or either per-budget cache (`paragraphRendererAt`, `headingRendererAt`) —
// stop honoring the same `emoji` value, or if the config override stops reaching
// `renderDocumentDetailed`.
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

  test("unicode tier: a shortcode inside a loose list item's own budgeted paragraph renderer is substituted too", () => {
    // Exercises `paragraphRendererAt` — the per-budget cache with its own
    // `markedTerminal()` construction, which must carry the same `emoji` value.
    // Substitution must not depend on whether a paragraph sits inside a list.
    const source = "- one\n\n  still one, with a shortcode :bulb: in its second paragraph\n\n- two\n";
    const output = renderDocument(source, 80, UNICODE_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain("💡");
    expect(plain).not.toContain(":bulb:");
  });

  test("ascii tier: the same budgeted-paragraph seam keeps the literal, not a unicode-cached glyph", () => {
    // The likeliest bug this WP guards against: `paragraphRendererAt`'s cache is keyed
    // only by budget, so if it were built without `emoji` it would silently default to
    // the library's own `true` regardless of tier. Proven by reverting the `emoji`
    // argument at this call site alone (leaving the main construction correct) and
    // confirming this exact source then renders 💡 at the ASCII tier — see the WP-11
    // report for the reproduction. With `emoji` threaded through, it must not.
    const source = "- one\n\n  still one, with a shortcode :bulb: in its second paragraph\n\n- two\n";
    const output = renderDocument(source, 80, ASCII_GLYPHS);
    const plain = stripAnsi(output);
    expect(plain).toContain(":bulb:");
    expect(plain).not.toContain("💡");
  });

  test("ascii tier: a heading inside a blockquote — the budgeted-heading cache seam — also keeps the literal", () => {
    // Same proof as above for `headingRendererAt`: a blockquote's non-zero
    // `pendingPrefixWidth()` forces `budget !== targetWidth`, which is exactly what
    // routes a nested heading through the per-budget cache instead of `originalHeading`.
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
