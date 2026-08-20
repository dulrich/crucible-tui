import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { preprocessBody, renderDocument } from "../src/render";
import {
  WIKI_LINK,
  WIKI_LINK_STYLES,
  WIKI_LINK_TOKENIZER,
  type WikiLinkToken,
  wikiLinkExtension,
} from "../src/wikilink";

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
 *    WP-1's today-pins. The four verbatim-context witnesses live in `tests/render.test.ts`;
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

type Policy =
  | typeof PLAIN
  | typeof COLOUR
  | typeof FORMATS_POLICY
  | typeof LINKS
  | typeof LINKS_TMUX
  | typeof LINKS_PLAIN;

/** Render under an explicit policy — the shape every pin below is measured with. */
const at = (source: string, policy: Policy, width = 80, glyphs = UNICODE_GLYPHS): string =>
  renderDocument(source, width, glyphs, undefined, undefined, undefined, policy);

const render = (source: string, width = 80, colour = false, glyphs = UNICODE_GLYPHS): string =>
  renderDocument(source, width, glyphs, undefined, undefined, undefined, colour ? COLOUR : PLAIN);

/** Every ESC offset in a string, so a witness can compare positions and not just counts. */
const escPositions = (text: string): number[] => {
  const found: number[] = [];
  for (let index = text.indexOf(ESC); index !== -1; index = text.indexOf(ESC, index + 1)) found.push(index);
  return found;
};

/** Lex with the extension registered, exactly as `renderDocumentDetailed` does. */
const lex = (source: string): Token[] => {
  const instance = new Marked();
  instance.use({ extensions: [wikiLinkExtension] });
  return instance.lexer(source);
};

/** The inline tokens of a source's first paragraph. */
const inlineTokens = (source: string): Token[] => (lex(source)[0] as Tokens.Paragraph).tokens;

/** The one wikilink token in a source's first paragraph. */
const wikiToken = (source: string): WikiLinkToken =>
  inlineTokens(source).find((token) => token.type === "wikilink") as unknown as WikiLinkToken;

describe("the tokenizer extension — shape, registration, and the token it produces", () => {
  test("it is an inline tokenizer with no renderer field — the walk is this repo's", () => {
    expect(wikiLinkExtension.name).toBe("wikilink");
    expect(wikiLinkExtension.level).toBe("inline");
    expect(typeof wikiLinkExtension.tokenizer).toBe("function");
    // A `renderer` here would be dead code: `marked`'s `Parser` never sees this token,
    // because `src/render.ts` walks with `TokenWalker`. It is also what keeps
    // `opts.extensions.renderers` empty.
    expect("renderer" in wikiLinkExtension).toBe(false);
  });

  test("`start` is the naive index of `[[`, and -1 when there is none", () => {
    // Its only job is to stop `inlineText` swallowing a position this tokenizer would have
    // claimed (`marked.cjs:1639-1652`), and marked ignores a negative answer. A bang-aware
    // backtrack is unnecessary — `inlineText`'s own stop-set already includes `!`.
    const start = wikiLinkExtension.start?.bind({ lexer: null } as never);
    expect(start?.("no links here")).toBe(-1);
    expect(start?.("see [[slug]] now")).toBe(4);
    expect(start?.("see ![[slug]] now")).toBe(5);
  });

  test("the token carries slug, alias, embed, raw and the label's own child tokens", () => {
    const plain = wikiToken("see [[slug]] now\n");
    expect(plain.type).toBe("wikilink");
    expect(plain.raw).toBe("[[slug]]");
    expect(plain.slug).toBe("slug");
    expect(plain.alias).toBeUndefined();
    expect(plain.embed).toBe(false);
    expect(plain.tokens.map((token) => token.type)).toEqual(["text"]);

    const aliased = wikiToken("see [[slug#head|the **viewer**]] now\n");
    expect(aliased.raw).toBe("[[slug#head|the **viewer**]]");
    expect(aliased.slug).toBe("slug");
    expect(aliased.alias).toBe("the **viewer**");
    expect(aliased.embed).toBe(false);
    // **D5**: the label is `alias ?? slug`, lexed into children, so its markup is real.
    expect(aliased.tokens.map((token) => token.type)).toEqual(["text", "strong"]);

    const embed = wikiToken("![[a note]]\n");
    expect(embed.embed).toBe(true);
    expect(embed.raw).toBe("![[a note]]");
    expect(embed.slug).toBe("a note");
  });

  test("a bare slug's own markup is lexed too — D5's parity claim, at the token", () => {
    // The pre-pass wrote the label back into the *source*, so `[[**bold**]]` has always
    // rendered bold. Lexing `alias ?? slug` rather than only an alias is what preserves that.
    expect(wikiToken("see [[**bold**]] now\n").tokens.map((token) => token.type)).toEqual(["strong"]);
  });

  test("the extension wins the position, and the surrounding text stays text", () => {
    expect(inlineTokens("a [[slug]] b\n").map((token) => token.type)).toEqual(["text", "wikilink", "text"]);
    expect(inlineTokens("[[a]] [[b]]\n").map((token) => token.type)).toEqual([
      "wikilink",
      "text",
      "wikilink",
    ]);
  });
});

describe("the two regexes — the provenance record and the lexer form", () => {
  test("WIKI_LINK is still the pattern src/render.ts carried, byte for byte", () => {
    // Kept exported as the provenance record: the same pattern an in-house web renderer
    // applies to the same corpus, so two tools rendering one note agree what a wiki-link is.
    expect(WIKI_LINK.source).toBe("(!)?\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]");
    expect(WIKI_LINK.flags).toBe("g");
  });

  test("WIKI_LINK_TOKENIZER is that pattern anchored, non-global, with `\\n` excluded (D2)", () => {
    expect(WIKI_LINK_TOKENIZER.source).toBe(
      "^(!)?\\[\\[([^\\]|#\\n]+)(?:#[^\\]|\\n]*)?(?:\\|([^\\]\\n]+))?\\]\\]",
    );
    expect(WIKI_LINK_TOKENIZER.flags).toBe("");
    // The three differences, each asserted rather than described: anchored (so the lexer's
    // "does a token start here" question is the one being answered), non-global (so no
    // `lastIndex` carries between calls), and newline-free in all three classes.
    expect(WIKI_LINK_TOKENIZER.test("x [[slug]]")).toBe(false);
    expect(WIKI_LINK_TOKENIZER.test("[[slug]]")).toBe(true);
    expect(WIKI_LINK_TOKENIZER.test("[[a\nb]]")).toBe(false);
    expect(WIKI_LINK_TOKENIZER.test("[[a|b\nc]]")).toBe(false);
    expect(WIKI_LINK_TOKENIZER.test("[[a#b\nc]]")).toBe(false);
  });

  test("the style chain is the two names, outermost first — one chain, two consumers", () => {
    // `styleWikiLabel` (prose) and `src/table.ts`'s fragment emitter both hand exactly this
    // to `applyStyleChain`, which is the plan's "one shared applicator".
    expect(WIKI_LINK_STYLES).toEqual(["cyan", "underline"]);
  });
});

describe("recognition is frozen — the pinned cases, now decided by the lexer", () => {
  const label = (source: string): string => stripAnsi(render(source)).trim();

  test("[[slug]] renders the slug", () => {
    expect(label("See [[mdview]] now.\n")).toBe("See mdview now.");
  });

  test("[[target|alias]] renders the alias, not the target", () => {
    expect(label("See [[mdview|the viewer]].\n")).toBe("See the viewer.");
    expect(wikiToken("See [[mdview|the viewer]].\n").alias).toBe("the viewer");
  });

  test("[[slug#heading]] renders the slug and drops the heading", () => {
    expect(label("See [[mdview#Run]].\n")).toBe("See mdview.");
  });

  test("![[embed]] keeps its `embed: ` prefix, outside the styled span", () => {
    expect(label("![[a note]]\n")).toBe("embed: a note");
    expect(label("![[note|shown]]\n")).toBe("embed: shown");
    // The prefix is the *visitor's*, emitted outside the chain — so it is never lexed as
    // markdown and never carries the style.
    expect(at("![[a note]]\n", COLOUR)).toContain(`embed: ${CYAN_UNDERLINE_OPEN}a note${CYAN_UNDERLINE_CLOSE}`);
  });

  test("adjacent links are two independent tokens", () => {
    const coloured = at("[[a]] [[b]]\n", COLOUR);
    expect(coloured.split(CYAN_UNDERLINE_OPEN).length - 1).toBe(2);
    expect(coloured.split(CYAN_UNDERLINE_CLOSE).length - 1).toBe(2);
  });

  test("a multiline alias does not match today and continues not to — locked D2", () => {
    // The pre-pass ran line by line, so its brackets could never be in one string. The lexer
    // offers whole inline runs, newlines included, so the regex has to say so itself.
    expect(inlineTokens("[[target|first\nsecond]]\n").some((token) => token.type === "wikilink")).toBe(false);
    expect(at("[[a\nb]]\n", PLAIN)).toBe("[[a b]]\n\n");
  });

  test("an alias containing a Markdown link does not match, and continues not to", () => {
    // The alias group is `[^\]\n]+`; a nested `[label](url)` contains `]`, so the whole
    // construct fails to match and the text is lexed as ordinary markdown instead.
    const source = "[[target|[label](https://example.com)]]\n";
    expect(inlineTokens(source).some((token) => token.type === "wikilink")).toBe(false);
    expect(stripAnsi(render(source))).toContain("label");
  });

  test("malformed input passes through unchanged", () => {
    for (const source of ["[[unclosed", "not a link]]", "[[]]", "[ [spaced] ]", "[[a|]]", "[[|b]]"]) {
      expect(inlineTokens(`${source}\n`).some((token) => token.type === "wikilink")).toBe(false);
    }
  });

  test("a fenced [[slug]] example is verbatim in both modes — now by construction", () => {
    // The fence toggle in `preprocessBody` used to guard this. There is nothing left to
    // guard: a `code` token has no `tokens` array, so the inline tokenizer is unreachable.
    const source = "```\nSee [[mdview]] for details.\n```\n";
    expect(render(source)).toContain("[[mdview]]");
    expect(stripAnsi(render(source, 80, true))).toContain("[[mdview]]");
  });
});

/**
 * **C4 — code points 2 and 3 are content now.**
 *
 * They were the carrier pair, and `preprocessBody` sanitized them out of incoming source so
 * a hostile document could not forge a styled span. With the carriers retired the bytes mean
 * nothing to this renderer, and Decision 1 of `plans/colour-policy.md` says a byte this tool
 * assigns no meaning passes through as content. Code points **0 and 1** keep their strips,
 * because they still have internal meaning — asserted here so the distinction is a pin and
 * not a comment.
 */
describe("C4 — authored code points 2 and 3 pass through, and 0/1 still do not", () => {
  test("an authored STX/ETX pair survives preprocessing and reaches the output", () => {
    const source = `A paragraph with ${STX}forged${ETX} carriers in it.\n`;
    expect(preprocessBody(source, UNICODE_GLYPHS)).toBe(source);
    for (const policy of [PLAIN, COLOUR] as const) {
      const output = at(source, policy);
      expect(output).toContain(`${STX}forged${ETX}`);
    }
  });

  test("and they forge nothing — there is no pass left for them to drive", () => {
    const source = `A paragraph with ${STX}forged${ETX} carriers in it.\n`;
    // The failure this rules out is a residual styling pass: the bytes are inert content,
    // so the coloured render carries the paragraph's own framing and nothing else.
    expect(at(source, COLOUR)).toBe(`${ESC}[0mA paragraph with ${STX}forged${ETX} carriers in it.${ESC}[0m\n\n`);
    expect(at(source, COLOUR)).not.toContain(CYAN_UNDERLINE_OPEN);
  });

  test("inside a fence they pass through too — the strip chain no longer reaches them", () => {
    const source = "```\n" + `code ${STX}x${ETX}\n` + "```\n";
    expect(preprocessBody(source, UNICODE_GLYPHS)).toBe(source);
  });

  test("code points 0 and 1 are still stripped — the hostile-forge witnesses, untouched", () => {
    // `SENTINEL` (0) would forge a code range and `TASK_STATE_SENTINEL` (1) a defeated-regex
    // marker; both still have internal meaning, so both are still sanitized unconditionally,
    // fences included.
    const zero = String.fromCharCode(0);
    const one = String.fromCharCode(1);
    expect(preprocessBody(`a ${zero}b${zero} c\n`, UNICODE_GLYPHS)).toBe("a b c\n");
    expect(preprocessBody(`a ${one}b${one} c\n`, UNICODE_GLYPHS)).toBe("a b c\n");
    expect(preprocessBody("```\n" + `x${zero}${one}y\n` + "```\n", UNICODE_GLYPHS)).toBe("```\nxy\n```\n");
  });
});

describe("the lexer-input witness: preprocessing introduces no NEW ESC byte and no carrier", () => {
  // **Not an absence assertion, deliberately.** Decision 1 scopes "zero escape bytes" to
  // *tool-generated* escapes; ESC the author wrote passes through the verbatim paths by
  // design, so a test demanding no ESC at all in the lexer's input would contradict the spec
  // it exists to enforce. Rephrased at WP-2 to cover the carriers on the same terms: the
  // claim is that **the tool generates none**, not that none can be present.
  const sources: Array<[string, string]> = [
    ["a plain wiki-link", "See [[mdview]] for details.\n"],
    ["an aliased wiki-link", "See [[mdview|the viewer]].\n"],
    ["an embed", "![[a note]]\n"],
    ["adjacent links", "[[a]] [[b]] [[c]]\n"],
    ["a link in a heading", "# See [[mdview]]\n"],
    ["a link in a list item", "- see [[mdview]]\n"],
    ["a link in a blockquote", "> see [[mdview]]\n"],
    ["a link in a table cell", "| a |\n|---|\n| [[mdview]] |\n"],
    ["a fenced example", "```\nSee [[mdview]].\n```\n"],
    ["task states beside a link", "- [/] see [[mdview]]\n"],
    ["malformed brackets", "[[unclosed and not a link]]]\n"],
  ];

  for (const [name, source] of sources) {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      test(`${name} (${glyphs.tier}): ESC-free and carrier-free source stays so`, () => {
        expect(source).not.toContain(ESC);
        expect(source).not.toContain(STX);
        expect(source).not.toContain(ETX);
        const processed = preprocessBody(source, glyphs);
        expect(processed).not.toContain(ESC);
        expect(processed).not.toContain(STX);
        expect(processed).not.toContain(ETX);
      });
    }
  }

  test("preprocessing now touches only task states — every wiki-link line is identity", () => {
    // The whole of the cutover, stated at this seam: `markWikiLinks` is gone, so a document
    // with no task-shaped line passes through `preprocessBody` unchanged.
    for (const [, source] of sources) {
      if (source.includes("[/]")) continue;
      expect(preprocessBody(source, UNICODE_GLYPHS)).toBe(source);
    }
  });

  test("authored ESC survives with its count and relative positions intact", () => {
    // Positions, not just counts: a pass that deleted one authored escape and added one of
    // its own would keep the count and still be the defect this witness is for.
    const source = `Text ${ESC}[31mred${ESC}[39m and [[mdview]] and ${ESC}[1mbold${ESC}[22m.\n`;
    const processed = preprocessBody(source, UNICODE_GLYPHS);

    expect(escPositions(source).length).toBe(4);
    expect(escPositions(processed).length).toBe(4);
    // Since the wiki-link half of the pass is gone, the positions are not merely relative
    // now — they are absolutely identical, which is the stronger statement.
    expect(escPositions(processed)).toEqual(escPositions(source));
    const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const sequences = (text: string): string[] => text.match(SGR) ?? [];
    expect(sequences(processed)).toEqual(sequences(source));
    for (const pair of [`${ESC}[31mred`, `red${ESC}[39m`, `${ESC}[1mbold`, `bold${ESC}[22m`]) {
      expect(processed).toContain(pair);
    }
  });

  test("the whole gate corpus's own sources are ESC-free, and stay so", async () => {
    const manifest = (await Bun.file(`${import.meta.dir}/../corpus/default-manifest.json`).json()) as {
      corpora: Array<{ globs: string[] }>;
    };
    const files = manifest.corpora.flatMap((corpus) => corpus.globs);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
      expect(source).not.toContain(ESC);
      for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
        expect(preprocessBody(source, glyphs)).not.toContain(ESC);
      }
    }
  });
});

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
 * **C6 — the two table-cell defects, repaired by the span-cell contract.**
 *
 * `src/table.ts` builds measured plain text and never dispatches a cell token, so a label in
 * a cell used to be styled by the pass that ran over the **whole finished document** —
 * chrome and all. It carries `{text, spans}` now: the flatten walk records the label's outer
 * chain as a `CellSpan` over the *normalized* text, and the emitter styles each wrapped
 * fragment independently.
 *
 * - **C6a, the bleed.** A wrapped label's style used to open on one row and close on
 *   another, so the cell's padding, the border glyph and the *neighbouring cell's text* all
 *   rendered inside it. A fragment is exactly the text between two pieces of chrome, so a
 *   fragment-scoped emission cannot produce it.
 * - **C6b, the boundary spaces.** The carriers were non-whitespace and stood between a
 *   label's own leading/trailing spaces and `cellText`'s `\s+` collapse. Nothing in the
 *   flatten walk knows about carriers, so a wiki label normalizes like every other cell text.
 */
describe("C6 — table cells: fragment-scoped styling and ordinary normalization (WP-2, repaired)", () => {
  test("C6b: a label's boundary whitespace normalizes like every other cell text", () => {
    const source = "| col |\n|---|\n| [[ b ]] |\n";
    // One visible column, not three: WP-1 pinned `│  b  │` — the carrier-fenced spaces.
    expect(at(source, PLAIN)).toBe("┌─────┐\n│ col │\n├─────┤\n│ b   │\n└─────┘\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[90m┌─────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m col ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├─────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE}   ${ESC}[90m│${ESC}[39m\n${ESC}[90m└─────┘${ESC}[39m\n`,
    );
  });

  test("C6a: a wrapped label is styled per fragment — nothing crosses padding or a border", () => {
    const source = "| a | y |\n|---|---|\n| [[abcdefghijklmnopqrstuvwxyz]] | y |\n";
    // The colourless geometry is unmoved — styling never moves a column here.
    expect(at(source, PLAIN, 16)).toBe(
      "┌──────────┬───┐\n│ a        │ y │\n├──────────┼───┤\n│ abcdefgh │ y │\n│ ijklmnop │   │\n│ qrstuvwx │   │\n│ yz       │   │\n└──────────┴───┘\n",
    );
    const coloured = at(source, COLOUR, 16);
    expect(coloured).toBe(
      `${ESC}[90m┌──────────${ESC}[39m${ESC}[90m┬───┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m a        ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m y ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├──────────${ESC}[39m${ESC}[90m┼───┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}abcdefgh${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m y ${ESC}[90m│${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}ijklmnop${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m   ${ESC}[90m│${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}qrstuvwx${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m   ${ESC}[90m│${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}yz${CYAN_UNDERLINE_CLOSE}       ${ESC}[90m│${ESC}[39m   ${ESC}[90m│${ESC}[39m\n${ESC}[90m└──────────${ESC}[39m${ESC}[90m┴───┘${ESC}[39m\n`,
    );
    // **The defect named directly, inverted.** WP-1 asserted `ESC[36m y ESC[90m│` — the
    // neighbour cell inside the cyan — and `ESC[4mabcdefgh ESC[90m│` — the style crossing a
    // border. Neither shape may exist now.
    expect(coloured).not.toContain(`${ESC}[36m y ${ESC}[90m│`);
    expect(coloured).not.toContain(`${ESC}[4mabcdefgh ${ESC}[90m│`);
    // Every row's cyan pairs balance within the row, which is the invariant fragment scoping
    // buys and the one the document pass violated.
    for (const line of coloured.split("\n")) {
      expect(line.split(CYAN_UNDERLINE_OPEN).length).toBe(line.split(CYAN_UNDERLINE_CLOSE).length);
    }
  });

  test("C6a: a body cell and a header cell, unwrapped, in `full` and `formats`", () => {
    const body = "| col |\n|---|\n| [[wiki-slug]] |\n";
    expect(at(body, PLAIN)).toBe("┌───────────┐\n│ col       │\n├───────────┤\n│ wiki-slug │\n└───────────┘\n");
    expect(at(body, COLOUR)).toBe(
      `${ESC}[90m┌───────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m col       ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}wiki-slug${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────┘${ESC}[39m\n`,
    );
    expect(at(body, FORMATS_POLICY)).toBe(
      `┌───────────┐\n│${ESC}[1m col       ${ESC}[22m│\n├───────────┤\n│ ${UNDERLINE_OPEN}wiki-slug${UNDERLINE_CLOSE} │\n└───────────┘\n`,
    );

    const header = "| [[head-slug]] |\n|---|\n| body |\n";
    expect(at(header, PLAIN)).toBe("┌───────────┐\n│ head-slug │\n├───────────┤\n│ body      │\n└───────────┘\n");
    // The head-bold chain nests around the wiki chain through `applyStyle`'s existing
    // surgery — no new nesting mechanism, exactly as the contract says.
    expect(at(header, COLOUR)).toBe(
      `${ESC}[90m┌───────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m ${CYAN_UNDERLINE_OPEN}head-slug${CYAN_UNDERLINE_CLOSE} ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m body      ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────┘${ESC}[39m\n`,
    );
    expect(at(header, FORMATS_POLICY)).toBe(
      `┌───────────┐\n│${ESC}[1m ${UNDERLINE_OPEN}head-slug${UNDERLINE_CLOSE} ${ESC}[22m│\n├───────────┤\n│ body      │\n└───────────┘\n`,
    );
  });

  test("C6a: every alignment, one wiki-link per column", () => {
    const source = "| L | C | R |\n|:---|:---:|---:|\n| [[a]] | [[b]] | [[c]] |\n";
    expect(at(source, PLAIN)).toBe("┌───┬───┬───┐\n│ L │ C │ R │\n├───┼───┼───┤\n│ a │ b │ c │\n└───┴───┴───┘\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[90m┌───${ESC}[39m${ESC}[90m┬───${ESC}[39m${ESC}[90m┬───┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m L ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m C ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m R ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───${ESC}[39m${ESC}[90m┼───${ESC}[39m${ESC}[90m┼───┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}a${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}c${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───${ESC}[39m${ESC}[90m┴───${ESC}[39m${ESC}[90m┴───┘${ESC}[39m\n`,
    );
  });

  test("C6a: a wrapped label beside prose in the same cell — only the label's fragments style", () => {
    const source = "| a | y |\n|---|---|\n| pre [[abcdefghijklmnop]] post | y |\n";
    expect(at(source, PLAIN, 20)).toBe(
      "┌──────────────┬───┐\n│ a            │ y │\n├──────────────┼───┤\n│ pre          │ y │\n│ abcdefghijkl │   │\n│ mnop post    │   │\n└──────────────┴───┘\n",
    );
    const coloured = at(source, COLOUR, 20);
    // The span is clipped to the label: `pre` and `post` are outside it on their own rows.
    expect(coloured).toContain(`${ESC}[90m│${ESC}[39m pre          ${ESC}[90m│${ESC}[39m`);
    expect(coloured).toContain(`${CYAN_UNDERLINE_OPEN}mnop${CYAN_UNDERLINE_CLOSE} post`);
    for (const line of coloured.split("\n")) {
      expect(line.split(CYAN_UNDERLINE_OPEN).length).toBe(line.split(CYAN_UNDERLINE_CLOSE).length);
    }
  });

  test("C6b: the normalization edge grid — edges, adjacency, internal runs, entities, embeds", () => {
    // Every one of these is a cell whose label abuts something the carriers used to fence.
    const cases: Array<[string, string]> = [
      ["a label at the cell's own edge", "| col |\n|---|\n| [[a]] x |\n"],
      ["two adjacent labels", "| col |\n|---|\n| [[a]][[b]] |\n"],
      ["an internal whitespace run inside a label", "| col |\n|---|\n| [[a   b]] |\n"],
      ["decoded entities around a label", "| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n"],
      ["an embed in a cell", "| col |\n|---|\n| ![[note]] |\n"],
    ];
    const expected = [
      "┌─────┐\n│ col │\n├─────┤\n│ a x │\n└─────┘\n",
      "┌─────┐\n│ col │\n├─────┤\n│ ab  │\n└─────┘\n",
      "┌─────┐\n│ col │\n├─────┤\n│ a b │\n└─────┘\n",
      "┌───────────┐\n│ col       │\n├───────────┤\n│ a & b <c> │\n└───────────┘\n",
      "┌─────────────┐\n│ col         │\n├─────────────┤\n│ embed: note │\n└─────────────┘\n",
    ];
    cases.forEach(([, source], index) => {
      expect(at(source, PLAIN)).toBe(expected[index] as string);
      // Whatever the shape, the coloured render carries the same visible text.
      expect(stripAnsi(at(source, COLOUR))).toBe(expected[index] as string);
    });

    // Two of them named individually, because they are the ones the contract's edge grid
    // exists for: adjacent labels get two independent spans, and the `embed: ` prefix sits
    // outside the span in a cell exactly as it does in prose.
    expect(at("| col |\n|---|\n| [[a]][[b]] |\n", COLOUR)).toContain(
      `${CYAN_UNDERLINE_OPEN}a${CYAN_UNDERLINE_CLOSE}${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE}`,
    );
    expect(at("| col |\n|---|\n| ![[note]] |\n", COLOUR)).toContain(
      `embed: ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}`,
    );
  });

  test("D4: an escaped pipe keeps the alias in one cell; an unescaped one splits it, per GFM", () => {
    // The authored-correct spelling. `marked` unescapes `\|` when it splits the row, so the
    // cell's inline source carries a real `|` and the tokenizer reads it as the separator.
    const escaped = "| col |\n|---|\n| [[s\\|Alias]] |\n";
    expect(at(escaped, PLAIN)).toBe("┌───────┐\n│ col   │\n├───────┤\n│ Alias │\n└───────┘\n");
    expect(at(escaped, COLOUR)).toContain(`${CYAN_UNDERLINE_OPEN}Alias${CYAN_UNDERLINE_CLOSE}`);
    // **Today's accidental tolerance is not reproduced** (locked D4). The pre-pass ate the
    // pipe before the lexer split the row, so the cell survived whole; the lexer splits
    // first now, and the two halves are literal text in two cells. WP-1 pinned
    // `│ Alias │ y │`; this is the byte change D4 authorizes.
    const unescaped = "| a | b |\n|---|---|\n| [[s|Alias]] | y |\n";
    expect(at(unescaped, PLAIN)).toBe(
      "┌─────┬─────────┐\n│ a   │ b       │\n├─────┼─────────┤\n│ [[s │ Alias]] │\n└─────┴─────────┘\n",
    );
    expect(at(unescaped, COLOUR)).not.toContain(CYAN_UNDERLINE_OPEN);
  });

  test("cells carry no OSC-8 and no nested SGR — locked D3, kept by flattening the children", () => {
    // `renderTable` never dispatches a cell token, and the flatten walk renders a label's
    // children as plain text, so `renderLink` is unreachable from a cell by construction.
    const url = at("| col |\n|---|\n| [[https://example.test/path]] |\n", LINKS);
    expect(url).not.toContain(`${ESC}]8;;`);
    expect(url).toContain(`${CYAN_UNDERLINE_OPEN}https://example.test/path${CYAN_UNDERLINE_CLOSE}`);

    const bold = at("| col |\n|---|\n| [[**bold**]] |\n", COLOUR);
    expect(at("| col |\n|---|\n| [[**bold**]] |\n", PLAIN)).toBe(
      "┌──────┐\n│ col  │\n├──────┤\n│ bold │\n└──────┘\n",
    );
    expect(bold).toContain(`${CYAN_UNDERLINE_OPEN}bold${CYAN_UNDERLINE_CLOSE}`);
    expect(bold).not.toContain(`${ESC}[1mbold`);
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
