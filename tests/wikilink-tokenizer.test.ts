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

const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;
const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;

type Policy = typeof PLAIN | typeof COLOUR;

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

  test("the token carries the `#fragment`, `#` excluded, only when one is authored", () => {
    // WP-2 of `plans/follow-wiki-links.md`: the fragment was matched and discarded before,
    // so a `[[note#Heading]]` could not point a reader at the heading it names. It is a
    // capture now, handed to `ctx.resolveWikiLink` at emission and never shown in the label.
    expect(wikiToken("see [[a#b]] now\n").fragment).toBe("b");
    expect(wikiToken("see [[a#b|c]] now\n").fragment).toBe("b");
    expect(wikiToken("see [[a#b|c]] now\n").alias).toBe("c");
    // Absent, not empty, when no `#` is authored — the same present-only-when-authored rule
    // `alias` follows, so the two are distinguishable by the resolver.
    expect(wikiToken("see [[a]] now\n").fragment).toBeUndefined();
    expect(wikiToken("see [[a|c]] now\n").fragment).toBeUndefined();
    // An authored-but-empty fragment is `""`: the `#` was written, so the group participated.
    expect(wikiToken("see [[a#]] now\n").fragment).toBe("");
    // A multi-word fragment survives whole; the slug never carries any of it.
    const heading = wikiToken("see [[note#Heading two]] now\n");
    expect(heading.slug).toBe("note");
    expect(heading.fragment).toBe("Heading two");
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
    // The fragment group is *capturing* here and non-capturing in `WIKI_LINK` — the one
    // difference WP-2 of `plans/follow-wiki-links.md` added, and the reason this string is
    // not `WIKI_LINK`'s with a `^`. It changes what the match exposes, never what it matches;
    // the recognition witnesses below are what pin the second half of that claim.
    expect(WIKI_LINK_TOKENIZER.source).toBe(
      "^(!)?\\[\\[([^\\]|#\\n]+)(?:#([^\\]|\\n]*))?(?:\\|([^\\]\\n]+))?\\]\\]",
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
