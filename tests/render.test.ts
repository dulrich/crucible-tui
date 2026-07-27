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
// WP-2 — the loose-list double-wrap defect.
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

  // KNOWN OPEN DEFECT — characterization test, deliberately asserting the *broken*
  // counts so the suite stays green while the bug is open and turns red the moment
  // anything changes it. `reflowText: false` was measured NOT to be the fix (it left
  // these counts identical and regressed non-list prose in 60/300 corpus documents);
  // see `wrapOverBudgetLines`'s doc comment in src/render.ts and WP-2b in
  // plans/crucible-tui-launch.md. **When WP-2b lands, these expectations become 0.**
  test("KNOWN DEFECT: loose list items still emit orphaned lines (WP-2b flips these to 0)", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    const expected = new Map<number, number>([
      [80, 12],
      [100, 9],
      [120, 6],
      [172, 7],
    ]);

    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const orphans = findListOrphans(renderDocument(source, width, glyphs), width);
        expect(orphans.length).toBe(expected.get(width) ?? -1);
      }
    }
  });

  test("KNOWN DEFECT: every orphan sits under a nearly-full line, confirming a second reflow caused it", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    const orphans = findListOrphans(renderDocument(source, 80, UNICODE_GLYPHS), 80);
    expect(orphans).toContain("several");
    expect(orphans).toContain("between");
    // the metric must not assume exactly one word — this one is two
    expect(orphans).toContain("which the");
  });
});
