import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderDocument } from "../src/render";
import { wikiLinkExtension } from "../src/wikilink";

/**
 * Wiki-link recognition — WP-2 of `plans/wiki-link-tokenizer.md`, the atomic cutover.
 *
 * Recognition used to be a **pre-lexer regex substitution** over source lines, with a
 * carrier pair (code points 2/3) marking the label through the lexer and a post-walk pass
 * styling each balanced pair. It is an **inline tokenizer extension** now: `marked`'s lexer
 * offers it a position, it returns a `wikilink` token whose children are the label's own
 * inline tokens, and `src/walk.ts` dispatches it to a visitor that styles at emission.
 *
 * Four claims live here and they fail for different reasons, so they are kept apart:
 *
 * 1. **Recognition is frozen** in the sense that matters — the same pattern, with `\n`
 *    excluded (locked D2) and applied by the lexer rather than to raw lines. Every case
 *    below is pinned as an expected output rather than discovered.
 * 2. **The verbatim contexts and the precedence surface are repaired**, row by row, against
 *    WP-1's today-pins. The four verbatim-context witnesses live in `tests/render-wikilinks.test.ts`;
 *    the non-verbatim precedence matrix and the ownership-class sweep are here.
 * 3. **The three measured defects are fixed**: the malformed OSC-8 a URL-shaped label
 *    produced (C5), the wrapped-label encasing (C2), and the two table-cell defects — the
 *    cross-chrome bleed and the boundary-space artifact (C6a/C6b).
 * 4. **No ESC and no carrier this tool generates enters the lexer.** The witness compares
 *    authored ESC positions and counts across `preprocessBody` — *not* an absence assertion,
 *    which would contradict Decision 1's rule that authored escapes pass through verbatim —
 *    and code points 2/3 now pass through as ordinary content (grant C4).
 */

const ESC = String.fromCharCode(27);
const STX = String.fromCharCode(2);
const ETX = String.fromCharCode(3);
const CYAN_UNDERLINE_OPEN = `${ESC}[36m${ESC}[4m`;
const CYAN_UNDERLINE_CLOSE = `${ESC}[24m${ESC}[39m`;
const UNDERLINE_OPEN = `${ESC}[4m`;
const UNDERLINE_CLOSE = `${ESC}[24m`;

const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;
const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;

// The three axes beyond those two: the hyperlink axis (which is what makes the OSC-8 rows
// visible at all), the tmux envelope, and the `formats` mode.
const BEL = String.fromCharCode(7);
const FORMATS_POLICY = { sgr: "formats", hyperlinks: false, tmux: false } as const;
const LINKS = { sgr: "full", hyperlinks: true, tmux: false } as const;
const LINKS_TMUX = { sgr: "full", hyperlinks: true, tmux: true } as const;
const LINKS_PLAIN = { sgr: "none", hyperlinks: true, tmux: false } as const;
// `FORMATS_POLICY` with the hyperlink axis on — the fourth corner of the (sgr × hyperlinks)
// square, needed only by the "following a wiki-link" witnesses at the end of this file.
const FORMATS_LINKS = { sgr: "formats", hyperlinks: true, tmux: false } as const;

type Policy =
  | typeof PLAIN
  | typeof COLOUR
  | typeof FORMATS_POLICY
  | typeof FORMATS_LINKS
  | typeof LINKS
  | typeof LINKS_TMUX
  | typeof LINKS_PLAIN;

/** Render under an explicit policy — the shape every pin below is measured with. */
const at = (source: string, policy: Policy, width = 80, glyphs = UNICODE_GLYPHS): string =>
  renderDocument(source, width, glyphs, undefined, undefined, undefined, policy);

const render = (source: string, width = 80, colour = false, glyphs = UNICODE_GLYPHS): string =>
  renderDocument(source, width, glyphs, undefined, undefined, undefined, colour ? COLOUR : PLAIN);

/** Lex with the extension registered, exactly as `renderDocumentDetailed` does. */
const lex = (source: string): Token[] => {
  const instance = new Marked();
  instance.use({ extensions: [wikiLinkExtension] });
  return instance.lexer(source);
};

/** The inline tokens of a source's first paragraph. */
const inlineTokens = (source: string): Token[] => (lex(source)[0] as Tokens.Paragraph).tokens;

describe("end to end: what a wiki-link renders to, in both colour modes", () => {
  const visible = (source: string, width = 80, glyphs = UNICODE_GLYPHS): string =>
    stripAnsi(render(source, width, false, glyphs));

  test("colour off: the label, no escapes, no carriers", () => {
    const output = render("See [[mdview|the viewer]] now.\n");
    expect(output).toContain("the viewer");
    expect(output).not.toContain(ESC);
    expect(output).not.toContain(STX);
    expect(output).not.toContain(ETX);
  });

  test("colour on: the same characters, wrapped in cyan+underline", () => {
    const output = render("See [[mdview|the viewer]] now.\n", 80, true);
    expect(output).toContain(`${CYAN_UNDERLINE_OPEN}the viewer${CYAN_UNDERLINE_CLOSE}`);
    expect(stripAnsi(output)).toBe(stripAnsi(render("See [[mdview|the viewer]] now.\n")));
  });

  test("inline markup inside a label is still parsed, and still nested inside the style", () => {
    // The children come from `this.lexer.inlineTokens(label)` now rather than from the label
    // being written back into the source, and the nesting is the same: the bold pair sits
    // inside the cyan/underline pair.
    const output = render("See [[t|**bold** and `code`]].\n", 80, true);
    expect(stripAnsi(output)).toContain("bold and code");
    expect(output).toContain(`${CYAN_UNDERLINE_OPEN}${ESC}[1mbold${ESC}[22m`);
    expect(visible("See [[t|**bold** and `code`]].\n")).toContain("bold and code");
  });

  test("a link inside a heading, a list item and a blockquote", () => {
    for (const source of ["# See [[mdview]]\n", "- see [[mdview]]\n", "> see [[mdview]]\n"]) {
      expect(visible(source)).toContain("mdview");
      expect(render(source)).not.toContain(ESC);
      expect(render(source, 80, true)).toContain(CYAN_UNDERLINE_OPEN);
    }
  });

  test("an embed renders `embed: label`, in both tiers and both modes", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      expect(visible("![[a note]]\n", 80, glyphs)).toContain("embed: a note");
      const coloured = render("![[a note]]\n", 80, true, glyphs);
      expect(coloured).toContain(`embed: ${CYAN_UNDERLINE_OPEN}a note${CYAN_UNDERLINE_CLOSE}`);
    }
  });

  test("a codespan's interior is literal now — locked D1", () => {
    // Decision 7 of `plans/colour-modes.md` kept the pre-pass firing here; D1 of the
    // tokenizer plan retires that. A codespan that syntactically forms owns its interior,
    // and the tokenizer is never offered a position inside one.
    const source = "see `[[note]]` here\n";
    expect(render(source)).toBe("see [[note]] here\n\n");
    expect(render(source, 80, true)).toBe(`${ESC}[0msee ${ESC}[33m[[note]]${ESC}[39m here${ESC}[0m\n\n`);
  });

  test("an inline-HTML interior is still recognized — unchanged, and asserted as unchanged", () => {
    // The one "kept-recognizing" row that survives the cutover: marked lexes
    // `<span>[[note]]</span>` as `html + wikilink + html`, so the wiki-link rides the inline
    // run *between* the two tag tokens rather than inside either of them. **These bytes did
    // not move**; the expectation is WP-1's, unedited.
    const source = "<span>[[note]]</span>\n";
    expect(inlineTokens(source).map((token) => token.type)).toEqual(["html", "wikilink", "html"]);
    expect(render(source)).toBe("<span>note</span>\n\n");
    expect(render(source, 80, true)).toBe(
      `${ESC}[0m${ESC}[90m<span>${ESC}[39m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[90m</span>${ESC}[39m${ESC}[0m\n\n`,
    );
  });

  test("task-ordered-text.md renders byte-identically in both tiers with colour off", async () => {
    const source = await Bun.file(`${import.meta.dir}/fixtures/task-ordered-text.md`).text();
    for (const width of [60, 80, 116]) {
      for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
        const output = render(source, width, false, glyphs);
        expect(output).not.toContain(ESC);
        expect(output).not.toContain(STX);
        expect(output).not.toContain(ETX);
      }
    }
  });
});

/**
 * **The precedence matrix — the candidate's bytes, row by row** (grant C3).
 *
 * WP-1 pinned today's bytes for every changing row; these are the same rows measured under
 * the tokenizer. The mechanism behind every repair is one sentence: **a pre-lexer regex
 * substitution cannot know what a construct the lexer has not yet built will turn out to
 * own**, and an inline tokenizer is only ever offered positions no other tokenizer has
 * already claimed.
 *
 * Three rows are **losses**, granted at approval rather than repaired: a wiki-link inside an
 * inline, full-reference or collapsed-reference link label, or inside image alt text, breaks
 * the outer construct, because marked's own label pattern admits no nested `[[`. They are
 * pinned here so the trade is a measurement rather than a description.
 */
describe("the precedence matrix — the candidate's bytes for every changing row (WP-2, C3)", () => {
  test("C3 fix: a backslash escape is honored — the wiki-link does not form", () => {
    const source = "a \\[[note]] b\n";
    expect(at(source, PLAIN)).toBe("a [[note]] b\n\n");
    expect(at(source, COLOUR)).toBe(`${ESC}[0ma [[note]] b${ESC}[0m\n\n`);
  });

  test("C3 fix: an escaped bang is literal, and the wiki-link beside it still forms", () => {
    // `\!` is consumed by marked's `escape` tokenizer, so the `!` is a literal character and
    // the following `[[note]]` is an ordinary (non-embed) wiki-link.
    const source = "a \\![[note]] b\n";
    expect(at(source, PLAIN)).toBe("a !note b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma !${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an inline link's destination is intact, and carries no SGR", () => {
    const source = "a [x](https://e/[[note]]) b\n";
    expect(at(source, PLAIN)).toBe("a x (https://e/[[note]]) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34mx (${ESC}[34m${ESC}[4mhttps://e/[[note]]${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    );
    // The row that mattered: the OSC-8 destination is the authored href and nothing else.
    const links = at(source, LINKS);
    expect(links.slice(links.indexOf(`${ESC}]8;;`) + 5, links.indexOf(BEL))).toBe("https://e/[[note]]");
  });

  test("C3 fix: an inline link's title is intact (invisible here — this renderer drops link titles)", () => {
    const source = 'a [x](https://e/u "[[t]]") b\n';
    expect(at(source, PLAIN)).toBe("a x (https://e/u) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34mx (${ESC}[34m${ESC}[4mhttps://e/u${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an image's destination and its title are both intact", () => {
    expect(at("a ![alt](/[[note]]) b\n", PLAIN)).toBe("a ![alt](/[[note]]) b\n\n");
    expect(at("a ![alt](/[[note]]) b\n", COLOUR)).toBe(
      `${ESC}[0ma ![alt](/[[note]])${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    );
    // A title *is* visible on this renderer's image path — it prints `alt – title`.
    expect(at('a ![alt](/u "[[t]]") b\n', PLAIN)).toBe("a ![alt – [[t]]](/u) b\n\n");
    expect(at('a ![alt](/u "[[t]]") b\n', COLOUR)).toBe(
      `${ESC}[0ma ![alt – [[t]]](/u)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an HTML attribute value is intact, and no SGR lands inside the tag", () => {
    const source = 'a <span title="[[note]]">x</span> b\n';
    expect(at(source, PLAIN)).toBe('a <span title="[[note]]">x</span> b\n\n');
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[90m<span title="[[note]]">${ESC}[39mx${ESC}[90m</span>${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an inline HTML comment's interior is intact", () => {
    const source = "a <!-- [[note]] --> b\n";
    expect(at(source, PLAIN)).toBe("a <!-- [[note]] --> b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[90m<!-- [[note]] -->${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an autolink is no longer broken — the authored `>` closes it", () => {
    const source = "a <https://e/[[note]]> b\n";
    expect(at(source, PLAIN)).toBe("a https://e/[[note]] b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/[[note]]${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: a bare URL is one intact token, with a clean OSC-8 destination", () => {
    const source = "a https://e/[[note]] b\n";
    expect(at(source, PLAIN)).toBe("a https://e/[[note]] b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/[[note]]${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    );
    const links = at(source, LINKS);
    expect(links.slice(links.indexOf(`${ESC}]8;;`) + 5, links.indexOf(BEL))).toBe("https://e/[[note]]");
    expect(links).not.toContain(CYAN_UNDERLINE_OPEN);
  });

  test("C3 fix: a reference definition's destination and title are intact", () => {
    const dest = "[x]: /[[note]]\n\nsee [x] here\n";
    expect(at(dest, PLAIN)).toBe("see x (/[[note]]) here\n\n");
    const links = at(dest, LINKS);
    expect(links.slice(links.indexOf(`${ESC}]8;;`) + 5, links.indexOf(BEL))).toBe("/[[note]]");
    const title = '[x]: /u "[[t]]"\n\nsee [x] here\n';
    expect(at(title, PLAIN)).toBe("see x (/u) here\n\n");
    expect(at(title, COLOUR)).toBe(
      `${ESC}[0msee ${ESC}[34mx (${ESC}[34m${ESC}[4m/u${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m here${ESC}[0m\n\n`,
    );
  });

  test("C3 LOSS: an inline link whose label holds a wiki-link no longer forms", () => {
    // marked's own link-label pattern admits a nested bracket group only in the form
    // `\[(?:\\.|[^\[\]\\])*\]`, which cannot contain `[[` — so the label never matches and
    // the construct falls apart into `text + wikilink + text`. Today's pre-pass hid that by
    // deleting the brackets before the lexer ever saw them. Granted, not repaired.
    const source = "a [label [[note]]](https://e/u) b\n";
    expect(inlineTokens(source).map((token) => token.type)).toEqual([
      "text",
      "wikilink",
      "text",
      "link",
      "text",
    ]);
    expect(at(source, PLAIN)).toBe("a [label note](https://e/u) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/u${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m) b${ESC}[0m\n\n`,
    );
  });

  test("C3 LOSS: full- and collapsed-reference link labels no longer form either", () => {
    // The trailing `[ref]`/`[]` renders per marked's reflink rules on the *remainder*, which
    // is why `ref` comes back as a shortcut link to the same definition.
    const full = "[ref]: https://e/r\n\na [label [[note]]][ref] b\n";
    expect(at(full, PLAIN)).toBe("a [label note]ref (https://e/r) b\n\n");
    expect(at(full, COLOUR)).toBe(
      `${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]${ESC}[34mref (${ESC}[34m${ESC}[4mhttps://e/r${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    );
    const collapsed = "[label [[note]]]: https://e/c\n\na [label [[note]]][] b\n";
    expect(at(collapsed, PLAIN)).toBe("[label note]: https://e/c\n\na [label note][] b\n\n");
  });

  test("C3 LOSS: an image whose alt text holds a wiki-link no longer forms one image token", () => {
    const inline = "a ![alt [[note]]](img.png) b\n";
    expect(at(inline, PLAIN)).toBe("a ![alt note](img.png) b\n\n");
    expect(at(inline, COLOUR)).toBe(
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](img.png) b${ESC}[0m\n\n`,
    );
    // The rendered bytes for the *inline* form are near-identical to today's — this renderer
    // prints an image literally either way — but the token shape and the reference form's
    // bytes both change, which is what the plan's row says.
    const reference = "[img]: /i\n\na ![alt [[note]]][img] b\n";
    expect(at(reference, PLAIN)).toBe("a ![alt note]img (/i) b\n\n");
  });

  test("D1 scope note: a match opening before a backtick still wins positionally", () => {
    // **The decision is preserved and the bytes are not, which is a finding rather than a
    // surprise.** The wikilink still wins the position — that is the row's claim, and it
    // holds. What moved is a consequence of locked D5: the label is lexed in its **own**
    // scope now, so its unmatched backtick can no longer pair with the one *outside* the
    // match. Today's pre-pass rewrote the label back into the source, where the two backticks
    // did pair and a codespan formed across the boundary. Measured, both modes.
    const source = "a [[x `code [[y]] z` end]] b\n";
    expect(at(source, PLAIN)).toBe("a x `code [[y z` end]] b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${CYAN_UNDERLINE_OPEN}x \`code [[y${CYAN_UNDERLINE_CLOSE} z\` end]] b${ESC}[0m\n\n`,
    );
  });

  test("D2: a multiline `[[a\\nb]]` does not match, and the brackets survive verbatim", () => {
    // Unchanged from WP-1's pin, and asserted as unchanged.
    const source = "[[a\nb]]\n";
    expect(at(source, PLAIN)).toBe("[[a b]]\n\n");
    expect(at(source, COLOUR)).toBe(`${ESC}[0m[[a${ESC}[0m ${ESC}[0mb]]${ESC}[0m\n\n`);
  });

  test("D5: a bare slug's own markup is parsed, exactly as an alias's is", () => {
    expect(at("See [[**bold**]] now.\n", PLAIN)).toBe("See bold now.\n\n");
    expect(at("See [[**bold**]] now.\n", COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[1mbold${ESC}[22m${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("D5: a fragment with an alias renders the alias, and an embed's markup is parsed too", () => {
    // **These four are visible-text parity with WP-1's pins**, asserted as unmoved: the
    // label's own markup rendered before the cutover and renders now, and the bytes agree.
    expect(at("See [[a#h|X]] now.\n", PLAIN)).toBe("See X now.\n\n");
    expect(at("See [[a#h|X]] now.\n", COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}X${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
    expect(at("![[a **b**]]\n", PLAIN)).toBe("embed: a b\n\n");
    expect(at("![[a **b**]]\n", COLOUR)).toBe(
      `${ESC}[0membed: ${CYAN_UNDERLINE_OPEN}a ${ESC}[1mb${ESC}[22m${CYAN_UNDERLINE_CLOSE}${ESC}[0m\n\n`,
    );
  });
});

/**
 * **C5 — the OSC-8 repair.**
 *
 * `[[https://example.test/path]]` has no alias, so the label *is* the URL. It is lexed on
 * its own now, comes out a clean `url` token, and `renderLink` emits OSC-8 for it — with the
 * styling applied *around* the finished sequence rather than written into it. Today the
 * carrier pass ran over the **finished document**, long after that emission, so the wiki
 * chain's close codes landed **inside the destination, before the BEL** (addendum P9): a
 * sequence no terminal resolves.
 *
 * Pinned in all the combinations WP-1 recorded the malformation in, so the repair is graded
 * against a measurement rather than a description.
 */
describe("C5 — a URL-shaped label emits a well-formed OSC-8 (WP-2, repaired)", () => {
  const source = "See [[https://example.test/path]] now.\n";
  const URL = "https://example.test/path";

  /** The bytes between the OSC-8 introducer and its terminating BEL. */
  const destination = (output: string): string =>
    output.slice(output.indexOf(`${ESC}]8;;`) + 5, output.indexOf(BEL));

  test("hyperlinks off: no OSC-8 at all, and the visible text is the URL", () => {
    expect(at(source, PLAIN)).toBe(`See ${URL} now.\n\n`);
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[4m${ESC}[39m${ESC}[36m${ESC}[34m${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m now.${ESC}[0m\n\n`,
    );
  });

  test("hyperlinks on, colour on: the destination is clean — the malformation is gone", () => {
    const output = at(source, LINKS);
    expect(output).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}]8;;${URL}${BEL}${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[4m${ESC}[39m${ESC}[36m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m now.${ESC}[0m\n\n`,
    );
    // The repair named, not just spelled: **no ESC between the introducer and the BEL**.
    // WP-1's pin for this line read `${URL}` + the wiki close pair.
    expect(destination(output)).toBe(URL);
    expect(destination(output)).not.toContain(ESC);
  });

  test("hyperlinks on, colour off: the control — same clean destination, no styling at all", () => {
    expect(at(source, LINKS_PLAIN)).toBe(
      `See ${ESC}]8;;${URL}${BEL}${URL}${ESC}]8;;${BEL} now.\n\n`,
    );
  });

  test("hyperlinks on under tmux: the DCS envelope wraps a clean destination", () => {
    const output = at(source, LINKS_TMUX);
    expect(output).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}Ptmux;${ESC}${ESC}]8;;${URL}${BEL}${ESC}\\${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[4m${ESC}[39m${ESC}[36m${ESC}[34m${ESC}Ptmux;${ESC}${ESC}]8;;${BEL}${ESC}\\${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m now.${ESC}[0m\n\n`,
    );
    // Inside the envelope the payload is still exactly the authored URL.
    expect(output.slice(output.indexOf(`${ESC}]8;;`) + 5, output.indexOf(BEL))).toBe(URL);
  });

  test("a URL-shaped *alias* takes the same repaired path", () => {
    const aliased = "See [[note|https://example.test/path]] now.\n";
    const output = at(aliased, LINKS);
    expect(destination(output)).toBe(URL);
    expect(destination(output)).not.toContain(ESC);
  });

  test("the destination is sanitized at emission — an authored control byte cannot escape it", () => {
    // `src/ansi.ts`'s `link` is the only place a document's own href is interpolated into a
    // control sequence, and it sanitizes there. A label carrying a raw ESC would otherwise
    // put one inside the OSC-8 payload.
    const hostile = `See [[https://e/${ESC}x]] now.\n`;
    const output = at(hostile, LINKS_PLAIN);
    expect(output.slice(output.indexOf(`${ESC}]8;;`) + 5, output.indexOf(BEL))).not.toContain(ESC);
  });
});

/**
 * **C2 — a wrapped prose label carries one pair, like every other styled span.**
 *
 * Wiki-links were the only styled producer whose styling was applied *after* wrapping: the
 * post-document pass saw a label already split across lines and `applyStyle`'s line-break
 * encasing closed and reopened the chain around every generated break. Styling happens
 * before the wrap now, and `src/wrap.ts` synthesizes no close/open pair at a break (addendum
 * P1) — so a label crossing six lines carries **one** open and one close, which is what every
 * `strong`, `link` and `del` in this renderer already does.
 *
 * WP-1 counted six opens at width 8. These count one, in all three modes.
 */
describe("C2 — a wrapped prose label carries one pair, not one per line (WP-2, repaired)", () => {
  const source = "See [[a-very-long-wiki-label-that-must-wrap-here]] now.\n";

  test("width 24 (word wrap into a hard split): the visible text is unmoved, the pairs are one", () => {
    // The colourless render is the frozen baseline and did **not** move — asserted first,
    // because C2 authorizes escape bytes to change and nothing else.
    expect(at(source, PLAIN, 24)).toBe("See\na-very-long-wiki-label-t\nhat-must-wrap-here now.\n\n");
    expect(at(source, COLOUR, 24)).toBe(
      `${ESC}[0mSee\n${CYAN_UNDERLINE_OPEN}a-very-long-wiki-label-t\nhat-must-wrap-here${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
    expect(at(source, FORMATS_POLICY, 24)).toBe(
      `${ESC}[0mSee\n${UNDERLINE_OPEN}a-very-long-wiki-label-t\nhat-must-wrap-here${UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("width 8 (six hard-split fragments): one pair, counted as well as spelled", () => {
    expect(at(source, PLAIN, 8)).toBe("See\na-very-l\nong-wiki\n-label-t\nhat-must\n-wrap-he\nre now.\n\n");
    const coloured = at(source, COLOUR, 8);
    expect(coloured).toBe(
      `${ESC}[0mSee\n${CYAN_UNDERLINE_OPEN}a-very-l\nong-wiki\n-label-t\nhat-must\n-wrap-he\nre${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
    // WP-1 counted six. One is what C2 grants, and it is what every other styled span emits.
    expect(coloured.split(CYAN_UNDERLINE_OPEN).length - 1).toBe(1);
    expect(coloured.split(CYAN_UNDERLINE_CLOSE).length - 1).toBe(1);
    expect(at(source, FORMATS_POLICY, 8)).toBe(
      `${ESC}[0mSee\n${UNDERLINE_OPEN}a-very-l\nong-wiki\n-label-t\nhat-must\n-wrap-he\nre${UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("the visible text is identical across all three modes at both widths", () => {
    for (const width of [8, 24]) {
      const base = at(source, PLAIN, width);
      expect(stripAnsi(at(source, COLOUR, width))).toBe(base);
      expect(stripAnsi(at(source, FORMATS_POLICY, width))).toBe(base);
    }
  });
});

/**
 * **The ownership-class probe sweep — the matrix's closing rule, flipped.**
 *
 * Eighteen shapes covering every built-in inline ownership class in marked's tokenizer order
 * (`marked.esm.js:1549-1635`), each containing `[[note]]`, with the candidate's rendered
 * bytes pinned exactly in both colour modes. Its job is unchanged: a shape whose class the
 * matrix did not predict shows up here as a diff nobody authorized.
 */
describe("the ownership-class probe sweep — every built-in inline shape, the candidate's bytes", () => {
  const cases: Array<[string, string, string, string]> = [
    ["escape", "a \\[[note]] b\n", "a [[note]] b\n\n", `${ESC}[0ma [[note]] b${ESC}[0m\n\n`],
    [
      "tag",
      'a <span title="[[note]]">x</span> b\n',
      'a <span title="[[note]]">x</span> b\n\n',
      `${ESC}[0ma ${ESC}[90m<span title="[[note]]">${ESC}[39mx${ESC}[90m</span>${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "comment",
      "a <!-- [[note]] --> b\n",
      "a <!-- [[note]] --> b\n\n",
      `${ESC}[0ma ${ESC}[90m<!-- [[note]] -->${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (inline)",
      "a [label [[note]]](https://e/u) b\n",
      "a [label note](https://e/u) b\n\n",
      `${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/u${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m) b${ESC}[0m\n\n`,
    ],
    [
      "link (full reference)",
      "[r]: https://e/r\n\na [label [[note]]][r] b\n",
      "a [label note]r (https://e/r) b\n\n",
      `${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]${ESC}[34mr (${ESC}[34m${ESC}[4mhttps://e/r${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (collapsed reference)",
      "[label [[note]]]: https://e/c\n\na [label [[note]]][] b\n",
      "[label note]: https://e/c\n\na [label note][] b\n\n",
      `${ESC}[0m[label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]: ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/c${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m${ESC}[0m\n\n${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}][] b${ESC}[0m\n\n`,
    ],
    [
      "link (shortcut reference)",
      "[label [[note]]]: https://e/s\n\na [label [[note]]] b\n",
      "[label note]: https://e/s\n\na [label note] b\n\n",
      `${ESC}[0m[label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]: ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/s${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m${ESC}[0m\n\n${ESC}[0ma [label ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}] b${ESC}[0m\n\n`,
    ],
    [
      "image (inline)",
      "a ![alt [[note]]](img.png) b\n",
      "a ![alt note](img.png) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](img.png) b${ESC}[0m\n\n`,
    ],
    [
      "image (full reference)",
      "[i]: /i\n\na ![alt [[note]]][i] b\n",
      "a ![alt note]i (/i) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]${ESC}[34mi (${ESC}[34m${ESC}[4m/i${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "image (collapsed reference)",
      "[alt [[note]]]: /ic\n\na ![alt [[note]]][] b\n",
      "[alt note]: /ic\n\na ![alt note][] b\n\n",
      `${ESC}[0m[alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]: /ic${ESC}[0m\n\n${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}][] b${ESC}[0m\n\n`,
    ],
    [
      "image (shortcut reference)",
      "[alt [[note]]]: /is\n\na ![alt [[note]]] b\n",
      "[alt note]: /is\n\na ![alt note] b\n\n",
      `${ESC}[0m[alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}]: /is${ESC}[0m\n\n${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}] b${ESC}[0m\n\n`,
    ],
    [
      "autolink",
      "a <https://e/[[note]]> b\n",
      "a https://e/[[note]] b\n\n",
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/[[note]]${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "url",
      "a https://e/[[note]] b\n",
      "a https://e/[[note]] b\n\n",
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/[[note]]${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "codespan",
      "a `[[note]]` b\n",
      "a [[note]] b\n\n",
      `${ESC}[0ma ${ESC}[33m[[note]]${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "emStrong",
      "a **[[note]]** and *[[note]]* b\n",
      "a note and note b\n\n",
      `${ESC}[0ma ${ESC}[1m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[22m and ${ESC}[3m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[23m b${ESC}[0m\n\n`,
    ],
    [
      "del",
      "a ~~[[note]]~~ b\n",
      "a note b\n\n",
      `${ESC}[0ma ${ESC}[2m${ESC}[90m${ESC}[9m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[90m${ESC}[29m${ESC}[39m${ESC}[22m b${ESC}[0m\n\n`,
    ],
    [
      "br",
      "a [[note]]  \nb [[note]]\n",
      "a note\nb note\n\n",
      `${ESC}[0ma ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}\nb ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[0m\n\n`,
    ],
    [
      "inlineText",
      "a [[note]] b\n",
      "a note b\n\n",
      `${ESC}[0ma ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} b${ESC}[0m\n\n`,
    ],
  ];

  test("the sweep is total over the shapes the matrix enumerates", () => {
    expect(cases.length).toBe(18);
  });

  for (const [name, source, plain, coloured] of cases) {
    test(`${name}: the candidate's bytes, colour off and colour on`, () => {
      expect(at(source, PLAIN)).toBe(plain);
      expect(at(source, COLOUR)).toBe(coloured);
    });
  }

  test("no wiki-link SGR reaches a destination, an attribute or a comment in any shape", () => {
    // The class-level statement the eighteen rows above make one at a time, asserted once:
    // wherever the tokenizer did not fire, there is no cyan at all.
    for (const source of [
      "a [x](https://e/[[note]]) b\n",
      'a <span title="[[note]]">x</span> b\n',
      "a <!-- [[note]] --> b\n",
      "a <https://e/[[note]]> b\n",
      "a https://e/[[note]] b\n",
      "[x]: /[[note]]\n\nsee [x] here\n",
      "a `[[note]]` b\n",
    ]) {
      expect(at(source, COLOUR)).not.toContain(CYAN_UNDERLINE_OPEN);
      expect(at(source, LINKS)).not.toContain(CYAN_UNDERLINE_OPEN);
    }
  });
});

/**
 * **Assumption 3 — the emoji and entity transforms over a styled label.**
 *
 * `transform` (`src/blocks.ts`) runs `emojify` and the entity decode over *composed block
 * text*, after inline rendering — so it now sees a label already wrapped in SGR, where
 * before it saw one wrapped in carriers. The plan lists this as an assumption to pin rather
 * than assume: the styling must not fence the shortcode or the entity, and must not be
 * consumed by either.
 */
describe("Assumption 3 — the emoji and entity transforms still reach a styled label", () => {
  test("a shortcode inside a label is substituted, inside the style", () => {
    expect(at("See [[:rocket: launch]] now.\n", PLAIN)).toBe("See 🚀 launch now.\n\n");
    expect(at("See [[:rocket: launch]] now.\n", COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}🚀 launch${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("an entity inside a label is decoded, inside the style", () => {
    // The lexer escapes `&` to `&amp;` in the label's own text token, and `transform` decodes
    // it after composition — the same round trip as any other prose.
    expect(at("See [[a & b]] now.\n", PLAIN)).toBe("See a & b now.\n\n");
    expect(at("See [[a & b]] now.\n", COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}a & b${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("a codespan inside a label keeps its colons literal — COLON_REPLACER round-trips", () => {
    // The other half of the ordering hazard: `codespan` emits the sentinel and the block
    // renderers undo it, and a styled label must not break that round trip.
    expect(at("See [[t|`:rocket:`]] now.\n", PLAIN)).toBe("See :rocket: now.\n\n");
    expect(at("See [[t|`:rocket:`]] now.\n", COLOUR)).toContain(":rocket:");
  });

  test("the shortcode's stray trailing space is stripped exactly once, as everywhere else", () => {
    // `insertEmojis` appends a space that was never in the source; `stripEmojiTrailingSpace`
    // removes it at end of line. A label at end of line is the case that could double-strip.
    expect(at("See [[:rocket:]]\n", PLAIN)).toBe("See 🚀\n\n");
  });
});

/**
 * **Following a wiki-link — WP-2 of `plans/follow-wiki-links.md`.**
 *
 * The label was a styled span the terminal could not follow until this plan; it is an OSC-8
 * hyperlink to the file the slug names now, wrapped around **exactly** the bytes the styled
 * label already was. The claims are kept apart because they fail for different reasons:
 *
 * 1. **The wrap is `renderLink`'s shape** — style inside the sequence, `embed: ` outside it —
 *    in all four block contexts a wiki-link reaches (paragraph, list item, heading,
 *    blockquote), pinned as whole byte strings.
 * 2. **Three separate ways to render byte-identically to before the plan**: no resolver, a
 *    resolver that resolves nothing (D3), and `hyperlinks: false` with a resolver (D5). Each
 *    is asserted against the *same render with the feature absent*, not against a transcribed
 *    string, so it cannot drift.
 * 3. **The fragment reaches the resolver** as `(slug, fragment)` with the `#` stripped, and
 *    whatever the resolver returns is the destination — this file asserts the *contract*, not
 *    the URI, which is `tests/wikiresolve.test.ts`'s.
 * 4. **D7 — a child link owns the destination.** `src/ansi.ts`'s `link` has no nesting
 *    contract, so a label that already emitted an OSC-8 open is left alone entirely.
 * 5. **The policy axes**, parameterized: `formats`, `none` and tmux each frame the same
 *    sequence differently and none of them changes whether it is emitted (audit E2).
 */
describe("following a wiki-link: the OSC-8 wrap, and the three ways it stays absent", () => {
  const RESOLVED = "file:///v/note.md";
  const OPEN = `${ESC}]8;;${RESOLVED}${BEL}`;
  const CLOSE = `${ESC}]8;;${BEL}`;

  /** Resolves exactly one slug, so every witness has an unresolved control beside it. */
  const resolveNote = (slug: string): string | undefined => (slug === "note" ? RESOLVED : undefined);

  /** `at`, plus the resolver — the trailing parameter `renderDocument` gained at WP-2. */
  const following = (
    source: string,
    policy: Policy,
    resolve: (slug: string, fragment?: string) => string | undefined = resolveNote,
    width = 80,
  ): string => renderDocument(source, width, UNICODE_GLYPHS, undefined, undefined, undefined, policy, resolve);

  test("a paragraph label: OSC-8 open, today's styled label, OSC-8 close", () => {
    expect(following("See [[note]] now.\n", LINKS)).toBe(
      `${ESC}[0mSee ${OPEN}${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("a list item's label — the item's own chrome stays outside the sequence", () => {
    expect(following("- See [[note]] now.\n", LINKS)).toBe(
      `    • ${ESC}[0mSee ${OPEN}${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("a heading's label — the heading chain re-opens after the label, still inside the link", () => {
    // `applyStyle`'s encasing re-opens the heading's own green *between* the label's close and
    // the OSC-8 close. That is the existing chain behaviour, not this plan's: pinned so a
    // future change to either has to say which one moved.
    expect(following("## See [[note]] now\n", LINKS)).toBe(
      `${ESC}[32m${ESC}[1m## See ${OPEN}${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[32m${CLOSE} now${ESC}[22m${ESC}[39m\n\n`,
    );
  });

  test("a blockquote's label — the quote indent and its chain stay outside", () => {
    expect(following("> See [[note]] now.\n", LINKS)).toBe(
      `${ESC}[90m${ESC}[3m    ${ESC}[0mSee ${OPEN}${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[90m${CLOSE} now.${ESC}[0m${ESC}[23m${ESC}[39m\n\n`,
    );
  });

  test("an embed's `embed: ` prefix is outside the sequence, as it is outside the style", () => {
    expect(following("![[note]]\n", LINKS)).toBe(
      `${ESC}[0membed: ${OPEN}${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${CLOSE}${ESC}[0m\n\n`,
    );
  });

  test("an unresolved slug is byte-identical to the render with no resolver at all (D3)", () => {
    const source = "See [[missing]] now.\n";
    expect(following(source, LINKS)).toBe(at(source, LINKS));
    expect(following(source, LINKS)).not.toContain(`${ESC}]8;;`);
    // And the two live side by side in one document: one link, one plain label.
    const mixed = following("See [[note]] and [[missing]].\n", LINKS);
    expect(mixed.split(`${ESC}]8;;`).length - 1).toBe(2); // one open, one close
    expect(mixed).toContain(`${OPEN}${CYAN_UNDERLINE_OPEN}note`);
    expect(mixed).toContain(`${CYAN_UNDERLINE_OPEN}missing${CYAN_UNDERLINE_CLOSE}.`);
  });

  test("hyperlinks off with a resolver present is byte-identical to today (D5)", () => {
    for (const [policy, plain] of [
      [COLOUR, COLOUR],
      [PLAIN, PLAIN],
      [FORMATS_POLICY, FORMATS_POLICY],
    ] as const) {
      const source = "See [[note]] now.\n";
      expect(following(source, policy)).toBe(at(source, plain));
      expect(following(source, policy)).not.toContain(`${ESC}]8;;`);
    }
  });

  test("the resolver is handed (slug, fragment) with the `#` stripped, and owns the destination", () => {
    const seen: Array<[string, string | undefined]> = [];
    const record = (slug: string, fragment?: string): string => {
      seen.push([slug, fragment]);
      return `file:///v/note.md#${fragment ?? ""}`;
    };
    const output = following("See [[note#Heading two]] now.\n", LINKS, record);
    expect(seen).toEqual([["note", "Heading two"]]);
    // Whatever it returns is the destination, verbatim — this file does not own URI shape.
    expect(output).toContain(`${ESC}]8;;file:///v/note.md#Heading two${BEL}`);
    // A link with no fragment hands `undefined`, not `""`.
    seen.length = 0;
    following("See [[note]] now.\n", LINKS, record);
    expect(seen).toEqual([["note", undefined]]);
  });

  test("D7 — a URL-shaped alias keeps its own link, and the wiki wrap is suppressed", () => {
    // The child reached `renderLink` and emitted an OSC-8 open; `src/ansi.ts`'s `link` has no
    // nesting contract, so wrapping would leave the rest of the line pointing at nothing.
    const source = "See [[note|https://example.test/path]] now.\n";
    // `note` resolves, so the resolver *would* have produced a destination — and is not asked.
    expect(resolveNote("note")).toBe(RESOLVED);
    expect(following(source, LINKS)).toBe(at(source, LINKS));
    expect(following(source, LINKS)).not.toContain(RESOLVED);
    // Exactly one pair: the child's open and its close, and nothing else.
    expect(following(source, LINKS).split(`${ESC}]8;;`).length - 1).toBe(2);
    // The same holds under tmux, where the envelope only doubles ESC around that substring.
    expect(following(source, LINKS_TMUX)).toBe(at(source, LINKS_TMUX));
  });

  test.each([
    [
      "formats — the label is underline-only, the sequence is unchanged",
      FORMATS_LINKS,
      `${ESC}[0mSee ${OPEN}${UNDERLINE_OPEN}note${UNDERLINE_CLOSE}${CLOSE} now.${ESC}[0m\n\n`,
    ],
    ["none — the sequence wraps a bare label", LINKS_PLAIN, `See ${OPEN}note${CLOSE} now.\n\n`],
    [
      "tmux — the DCS envelope frames both the open and the close",
      LINKS_TMUX,
      `${ESC}[0mSee ${ESC}Ptmux;${ESC}${OPEN}${ESC}\\${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}Ptmux;${ESC}${CLOSE}${ESC}\\ now.${ESC}[0m\n\n`,
    ],
  ])("the axes do not decide whether the link is emitted, only how it is framed: %s", (_name, policy, expected) => {
    expect(following("See [[note]] now.\n", policy)).toBe(expected);
  });
});
