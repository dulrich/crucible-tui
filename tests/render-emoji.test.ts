import { describe, expect, test } from "bun:test";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocument } from "../src/render";


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
