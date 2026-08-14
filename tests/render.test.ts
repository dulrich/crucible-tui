import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { highlight as cliHighlight } from "cli-highlight";
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

// WP-11 (representative-corpus, formerly WP-7): shortcode substitution follows the
// glyph tier — Unicode renders the glyph (the default, matching `marked-terminal`'s own
// default), ASCII cannot draw it and keeps the literal shortcode, and
// `MdviewConfig.emoji` (`src/config.ts`) overrides either direction via the
// `emojiOverride` argument `renderDocumentDetailed`/`renderDocument` now accept. See
// `src/render.ts`'s `emoji` computation at the top of `renderDocumentDetailed` and
// `src/AGENTS.md`'s emoji section for why this is no longer a hardcoded constant.
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
