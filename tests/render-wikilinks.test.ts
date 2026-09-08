import { describe, expect, test } from "bun:test";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
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
  // with none requested. The mechanism and the gate are both pinned here; recognition itself
  // is `tests/wikilink-tokenizer.test.ts`'s.
  //
  // **Rephrased, not retired, at WP-2 of `plans/wiki-link-tokenizer.md`** (grant C4). Code
  // points 2 and 3 were the carrier pair that marked a label through the lexer, and this
  // asserted they never reached a terminal. The tokenizer needs no carriers, so those bytes
  // now mean nothing to this renderer and an *authored* one passes through as content — see
  // `tests/wikilink-tokenizer.test.ts`'s C4 pass-through witness. What survives here is the half that
  // is still an invariant and is the one that mattered: **this tool generates no carrier
  // byte**, so a source containing none produces none.
  test("with no policy, a wiki-link emits no escape — and no tool-generated 2/3 for carrier-free input", () => {
    const source = "See [[mdview]] for details.\n";
    expect(source).not.toContain(String.fromCharCode(2));
    expect(source).not.toContain(String.fromCharCode(3));
    const output = renderDocument(source, 80);
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
 * **The verbatim contexts, repaired** — grant C1 of `plans/wiki-link-tokenizer.md`, WP-2.
 *
 * These four were the defect record: `markWikiLinks` was a pre-lexer regex substitution
 * guarded only by `FENCE_LINE` (` ``` `/`~~~`), so it fired on lines that later tokenized as
 * indented code, block HTML, or code nested under a blockquote or a list exactly as it fired
 * on prose — and the substitution was irreversible, so the authored `[[…]]`, the `|`, the
 * `#fragment`, the `!` and (whenever an alias was given) the slug itself were gone before the
 * lexer ran. Block HTML was the worst of them: it never passes through `wrapCode`, so
 * `extractCodeRanges` recorded nothing and the corruption carried no class-C protection and
 * no `--check`/sweep exemption at all.
 *
 * **Recognition is the lexer's now, so every one of these is protected by construction**: an
 * inline tokenizer is never offered a position inside a `code` token, a block `html` token,
 * or a container-nested code block. The four tests below assert the *repaired* bytes, and
 * they are what grant C1 exists for — this is the one place in the plan authorized to change
 * bytes **inside a recorded `codeRange`**.
 *
 * Two things every expectation here was measured for rather than derived:
 *
 * - **`codeRanges` are asserted per case and did not move.** A repair that also changed what
 *   `--check` exempts would be a second, ungranted change.
 * - **The coloured indented-code bytes were re-measured, never derived from the plain ones.**
 *   The highlighter runs `highlightAuto` over the code range's *content*, and restoring the
 *   brackets changes that content — so its guess moved, from `34m` on `here` to `31m` on the
 *   brackets. That SGR is the highlighter's own and is deliberately not asserted away; what
 *   *is* asserted is that no wiki-link SGR reaches a code range any more.
 */
describe("renderDocument — verbatim contexts keep their authored brackets (wiki-link-tokenizer WP-2, C1)", () => {
  const ESC = String.fromCharCode(27);
  const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;
  const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;

  test("C1: indented code keeps every authored byte — plain, alias, fragment, embed", () => {
    const source =
      "Intro paragraph.\n\n" +
      "    See [[slug]] here\n" +
      "    See [[slug|Alias]] here\n" +
      "    See [[slug#head|Alias]] here\n" +
      "    See ![[embed]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    // Every discarded piece is back: the brackets, the `|`, the `#head` fragment, the slug
    // an alias used to replace, and the `!`.
    expect(plain.text).toBe(
      "Intro paragraph.\n\n" +
        "    See [[slug]] here\n" +
        "    See [[slug|Alias]] here\n" +
        "    See [[slug#head|Alias]] here\n" +
        "    See ![[embed]] here\n\n",
    );
    expect(plain.codeRanges).toEqual([[3, 6]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `${ESC}[0mIntro paragraph.${ESC}[0m\n\n` +
        `    See ${ESC}[31m[[slug]]${ESC}[39m here\n` +
        `    See ${ESC}[31m[[slug|Alias]]${ESC}[39m here\n` +
        `    See ${ESC}[31m[[slug#head|Alias]]${ESC}[39m here\n` +
        `    See !${ESC}[31m[[embed]]${ESC}[39m here\n\n`,
    );
    // **Re-measured, not derived.** The `31m` is `highlightAuto`'s own guess over the range's
    // restored content; it used to colour `here` blue. The substantive claim is the next
    // line: no wiki-link SGR reaches a code range any more.
    expect(coloured.text).not.toContain(`${ESC}[36m`);
    expect(coloured.codeRanges).toEqual([[3, 6]]);
  });

  test("C1: block HTML keeps its authored brackets — the corruption with no codeRange to hide in", () => {
    const source = "<div>\nSee [[slug]] here\n</div>\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("<div>\nSee [[slug]] here\n</div>\n");
    // Still no `codeRange`, for the same structural reason as before — block HTML never
    // passes through `wrapCode`. What changed is that there is nothing left to exempt.
    expect(plain.codeRanges).toEqual([]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    // A block `html` token carries no `tokens` array at all, so the inline tokenizer is
    // structurally unreachable here: the whole block is one grey run, brackets included.
    expect(coloured.text).toBe(
      `${ESC}[90m<div>${ESC}[39m\n` +
        `${ESC}[90mSee [[slug]] here${ESC}[39m\n` +
        `${ESC}[90m</div>${ESC}[39m\n` +
        `${ESC}[90m${ESC}[39m`,
    );
    expect(coloured.codeRanges).toEqual([]);
  });

  test("C1: indented code nested inside a blockquote keeps its authored brackets", () => {
    const source = "> Intro\n\n>     See [[slug]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("    Intro\n\n        See [[slug]] here\n\n");
    expect(plain.codeRanges).toEqual([[3, 3]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `${ESC}[90m${ESC}[3m    ${ESC}[0mIntro${ESC}[0m${ESC}[23m${ESC}[39m\n\n` +
        `${ESC}[90m${ESC}[3m        See ${ESC}[31m[[slug]]${ESC}[39m${ESC}[90m here${ESC}[23m${ESC}[39m\n\n`,
    );
    expect(coloured.codeRanges).toEqual([[3, 3]]);
  });

  test("C1: indented code nested inside a list item keeps its authored brackets", () => {
    const source = "- Intro\n\n      See [[slug]] here\n";

    const plain = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, PLAIN);
    expect(plain.text).toBe("    • Intro\n          See [[slug]] here\n\n");
    expect(plain.codeRanges).toEqual([[2, 2]]);

    const coloured = renderDocumentDetailed(source, 80, UNICODE_GLYPHS, undefined, undefined, undefined, COLOUR);
    expect(coloured.text).toBe(
      `    • ${ESC}[0m${ESC}[0m${ESC}[0mIntro${ESC}[0m${ESC}[0m${ESC}[0m\n` +
        `      ${ESC}[0m    See ${ESC}[31m[[slug]]${ESC}[39m here${ESC}[0m\n\n`,
    );
    expect(coloured.codeRanges).toEqual([[2, 2]]);
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
