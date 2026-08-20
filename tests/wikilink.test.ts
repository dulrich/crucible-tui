import { describe, expect, test } from "bun:test";
import { scan } from "../src/ansi";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { preprocessBody, renderDocument } from "../src/render";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import {
  WIKI_LINK,
  WIKI_LINK_CLOSE,
  WIKI_LINK_OPEN,
  markWikiLink,
  markWikiLinks,
  stripWikiLinkCarriers,
  styleWikiLinkCarriers,
} from "../src/wikilink";

/**
 * Wiki-link carriers — WP-4 of `plans/colour-policy.md`.
 *
 * Three separate claims live here and they fail for different reasons, so they are kept
 * apart deliberately:
 *
 * 1. **Recognition is frozen.** Every case below asserts what `WIKI_LINK` did at this
 *    package's base, including the cases it does *not* match. They are pinned as expected
 *    outputs rather than discovered, per the plan's cycle-2 f4 disposition: a change to
 *    which text is a wiki-link is a separate, deliberate decision nobody has taken.
 * 2. **The carrier mechanism is total and fails safe.** Balanced pairs style; unbalanced
 *    carriers strip; a document that writes the carriers itself cannot forge a styled span.
 * 3. **No ESC byte this tool generates enters the lexer.** The witness compares authored
 *    ESC positions and counts across `preprocessBody`, and transforms ESC-free sources
 *    directly — *not* an absence assertion, which would contradict Decision 1's rule that
 *    authored escapes pass through verbatim.
 */

const ESC = String.fromCharCode(27);
const OPEN = WIKI_LINK_OPEN;
const CLOSE = WIKI_LINK_CLOSE;
const CYAN_UNDERLINE_OPEN = `${ESC}[36m${ESC}[4m`;
const CYAN_UNDERLINE_CLOSE = `${ESC}[24m${ESC}[39m`;

// Migrated at WP-2 of `plans/colour-modes.md`: `color: true` -> `sgr: "full"`,
// `color: false` -> `sgr: "none"`. **No expected byte in this file moved with them** —
// including WP-1's pinned defect witnesses, which record today's corrupted output and are
// the instrument a future fix has to trip.
const on = { sgr: "full" } as const;
const off = { sgr: "none" } as const;

const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;
const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;

// The three axes the precedence-matrix witnesses below need beyond those two: the
// hyperlink axis (which is what makes the SGR-inside-a-destination rows visible at all),
// the tmux envelope, and the `formats` mode.
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

/** Render under an explicit policy — the shape every today-pin below is measured with. */
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

describe("the carriers are code points 2 and 3, and they are invisible to layout", () => {
  test("they are the control characters the sentinel idiom prescribes, not zero-width Unicode", () => {
    // The ASCII glyph tier exists for terminals that cannot render UTF-8, and every gate
    // here measures display width rather than code points — so a U+200B carrier would be
    // three bytes of exactly what that tier avoids and nothing would catch it. Same
    // reasoning `TASK_STATE_SENTINEL` records at length.
    expect(OPEN.charCodeAt(0)).toBe(2);
    expect(CLOSE.charCodeAt(0)).toBe(3);
    expect(OPEN.length).toBe(1);
    expect(CLOSE.length).toBe(1);
  });

  test("they measure zero columns in both ambiguous modes", () => {
    // The wrap seam's re-measure (`src/render.ts`, the coalesced tight-item `wrapAt`).
    // The escapes they replaced were zero columns because `string-width` strips them; the
    // carriers are zero columns because they are control characters. Either way a wrapped
    // label occupies exactly the columns of its visible text, which is what keeps the
    // colourless render's line breaks where they were.
    for (const measure of [NARROW_MEASURE, WIDE_MEASURE]) {
      expect(measure(OPEN)).toBe(0);
      expect(measure(CLOSE)).toBe(0);
      expect(measure(`${OPEN}label${CLOSE}`)).toBe(measure("label"));
    }
  });

  test("src/ansi.ts's scanner classifies them as ordinary text, width 0", () => {
    // The analogous pin to `tests/ansi.test.ts`'s for code points 0 and 1. A carrier is
    // **not** a terminal sequence: it must not be recognised as one, and it must not be
    // counted as a visible column either.
    const result = scan(`${OPEN}abc${CLOSE}`);
    expect(result.spans.map((span) => span.kind)).toEqual(["text"]);
    expect(result.spans[0]?.width).toBe(3);
    expect(result.malformed).toBe(false);
    expect(result.visible).toBe(`${OPEN}abc${CLOSE}`);
  });

  test("stripAnsi does NOT remove them — which is why the pass strips them itself", () => {
    // `stripAnsi` is a derivation of the scanner (SGR, OSC-8, DCS) and knows nothing about
    // carriers. Recorded rather than repaired: every layout decision made between the walk
    // and the carrier pass therefore sees carrier bytes in "visible" text, and the fix for
    // that is the pass's placement, not a wider strip.
    expect(stripAnsi(`${OPEN}abc${CLOSE}`)).toBe(`${OPEN}abc${CLOSE}`);
    expect(stripWikiLinkCarriers(`${OPEN}abc${CLOSE}`)).toBe("abc");
  });
});

describe("recognition is frozen — the pinned cases", () => {
  test("[[slug]] marks the slug", () => {
    expect(markWikiLinks("See [[mdview]] now.")).toBe(`See ${OPEN}mdview${CLOSE} now.`);
  });

  test("[[target|alias]] marks the alias, not the target", () => {
    expect(markWikiLinks("See [[mdview|the viewer]].")).toBe(`See ${OPEN}the viewer${CLOSE}.`);
  });

  test("[[slug#heading]] marks the slug and drops the heading", () => {
    expect(markWikiLinks("See [[mdview#Run]].")).toBe(`See ${OPEN}mdview${CLOSE}.`);
  });

  test("![[embed]] keeps its `embed: ` prefix, outside the carriers", () => {
    // The prefix sat outside the SGR pair before and sits outside the carriers now, so its
    // bytes do not move and the rendered text is unchanged in both colour modes.
    expect(markWikiLinks("![[a note]]")).toBe(`embed: ${OPEN}a note${CLOSE}`);
    expect(markWikiLinks("![[note|shown]]")).toBe(`embed: ${OPEN}shown${CLOSE}`);
  });

  test("adjacent links are two independent pairs", () => {
    expect(markWikiLinks("[[a]] [[b]]")).toBe(`${OPEN}a${CLOSE} ${OPEN}b${CLOSE}`);
  });

  test("a multiline alias does not match today and continues not to", () => {
    // `[^\]]+` would happily cross a newline, but the pass is applied line by line, so the
    // opening and closing brackets are never in the same string. Unchanged, on purpose.
    const source = "[[target|first\nsecond]]";
    expect(source.split("\n").map(markWikiLinks).join("\n")).toBe(source);
  });

  test("an alias containing a Markdown link does not match, and continues not to", () => {
    // The alias group is `[^\]]+`; a nested `[label](url)` contains `]`, so the whole
    // construct fails to match and passes through as literal text.
    const source = "[[target|[label](https://example.com)]]";
    expect(markWikiLinks(source)).toBe(source);
  });

  test("malformed input passes through unchanged", () => {
    for (const source of ["[[unclosed", "not a link]]", "[[]]", "[ [spaced] ]", "[[a|]]", "[[|b]]"]) {
      expect(markWikiLinks(source)).toBe(source);
    }
  });

  test("the exported regex is the one src/render.ts carried, byte for byte", () => {
    expect(WIKI_LINK.source).toBe("(!)?\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]");
    expect(WIKI_LINK.flags).toBe("g");
  });
});

describe("the balanced-pair pass", () => {
  test("a balanced pair is styled cyan+underline with colour on, through the emitter", () => {
    expect(styleWikiLinkCarriers(`a ${OPEN}label${CLOSE} b`, on)).toBe(
      `a ${CYAN_UNDERLINE_OPEN}label${CYAN_UNDERLINE_CLOSE} b`,
    );
  });

  test("the same input with colour off keeps every character and emits nothing", () => {
    expect(styleWikiLinkCarriers(`a ${OPEN}label${CLOSE} b`, off)).toBe("a label b");
  });

  test("the styled bytes are exactly the pair styleWikiLink used to hardcode", () => {
    // The whole fidelity claim of the package in one line: `chalk.cyan.underline` through
    // `src/style.ts`'s committed table produces the identical four codes the deleted
    // function spelled by hand, in the identical order.
    const styled = styleWikiLinkCarriers(markWikiLink("x"), on);
    expect(styled).toBe(`${CYAN_UNDERLINE_OPEN}x${CYAN_UNDERLINE_CLOSE}`);
  });

  test("two adjacent pairs are styled independently", () => {
    expect(styleWikiLinkCarriers(`${OPEN}a${CLOSE} ${OPEN}b${CLOSE}`, on)).toBe(
      `${CYAN_UNDERLINE_OPEN}a${CYAN_UNDERLINE_CLOSE} ${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE}`,
    );
  });

  test("an empty label emits nothing — applyStyle's own guard", () => {
    expect(styleWikiLinkCarriers(`${OPEN}${CLOSE}`, on)).toBe("");
  });

  test("a pair spanning a newline is encased, per applyStyle", () => {
    // A hard-split of an over-long label can separate a carrier from its text. The pass
    // runs over the whole rendered document rather than per line, so the pair is still
    // balanced; `applyStyle` closes before the break and reopens after, exactly as every
    // other multi-line styled span in this renderer does.
    expect(styleWikiLinkCarriers(`${OPEN}a\nb${CLOSE}`, on)).toBe(
      `${CYAN_UNDERLINE_OPEN}a${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE}`,
    );
  });

  test("a nested style closing with one of this chain's codes is re-opened", () => {
    // `applyStyle`'s nested close/reopen. An inline `link` inside a label closes with
    // `39m`, which is also cyan's close, so the cyan is re-opened after it rather than
    // leaving the rest of the label unstyled — which is what the hardcoded pair did.
    // Only the *matched* link of the chain re-opens (`36m`, not the whole `36m`+`4m`),
    // which is chalk's own behaviour and is pinned as such in `tests/style.test.ts`.
    expect(styleWikiLinkCarriers(`${OPEN}a${ESC}[39mb${CLOSE}`, on)).toBe(
      `${CYAN_UNDERLINE_OPEN}a${ESC}[39m${ESC}[36mb${CYAN_UNDERLINE_CLOSE}`,
    );
  });

  test("text with no carriers at all is returned untouched", () => {
    expect(styleWikiLinkCarriers("nothing here", on)).toBe("nothing here");
  });
});

/**
 * **The wiki-link chain under `formats`** — WP-2 of `plans/colour-modes.md`.
 *
 * `WIKI_LINK_STYLE` is `underline` over `cyan` (`src/wikilink.ts`), so the mode split falls
 * straight through the middle of it: the cyan is hue-class and drops, the underline is
 * format-class and stays. That is the enumeration Decision 5 asks for on this producer —
 * *the cyan drops, the underline does not* — and it is worth its own block because the
 * chain is the only two-link one in the renderer whose links are one of each class.
 *
 * The pass itself is unchanged: it still strips every carrier, balanced or not, at every
 * mode. What the mode decides is only which bytes go in their place.
 */
describe("the balanced-pair pass under `formats` — the cyan drops, the underline stays", () => {
  const formats = { sgr: "formats" } as const;
  const UNDERLINE_OPEN = `${ESC}[4m`;
  const UNDERLINE_CLOSE = `${ESC}[24m`;

  test("a balanced pair keeps the underline and loses the cyan, exactly", () => {
    expect(styleWikiLinkCarriers(`a ${OPEN}label${CLOSE} b`, formats)).toBe(
      `a ${UNDERLINE_OPEN}label${UNDERLINE_CLOSE} b`,
    );
  });

  test("the dropped codes are named individually, so a failure says which one came back", () => {
    const styled = styleWikiLinkCarriers(markWikiLink("x"), formats);
    expect(styled).toContain(`${ESC}[4m`);
    expect(styled).toContain(`${ESC}[24m`);
    expect(styled).not.toContain(`${ESC}[36m`);
    expect(styled).not.toContain(`${ESC}[39m`);
  });

  test("every carrier is still removed, and no visible character moves", () => {
    // The carriers are the pass's own contract and are independent of the mode.
    const styled = styleWikiLinkCarriers(`a ${OPEN}label${CLOSE} b`, formats);
    expect(styled).not.toContain(OPEN);
    expect(styled).not.toContain(CLOSE);
    expect(stripAnsi(styled)).toBe(styleWikiLinkCarriers(`a ${OPEN}label${CLOSE} b`, off));
  });

  test("the newline encasing re-opens the FILTERED chain — no cyan on the second line", () => {
    // The failure this rules out is a filter applied after the encasing rather than before
    // it: `applyStyle` reinserts `openAll` after every break, so an unfiltered chain would
    // leak `36m` onto every line but the first.
    expect(styleWikiLinkCarriers(`${OPEN}a\nb${CLOSE}`, formats)).toBe(
      `${UNDERLINE_OPEN}a${UNDERLINE_CLOSE}\n${UNDERLINE_OPEN}b${UNDERLINE_CLOSE}`,
    );
  });

  test("an empty label still emits nothing — applyStyle's own guard, unchanged by the mode", () => {
    expect(styleWikiLinkCarriers(`${OPEN}${CLOSE}`, formats)).toBe("");
  });

  test("`formats` is neither of the other two modes on this producer", () => {
    const input = `a ${OPEN}label${CLOSE} b`;
    expect(styleWikiLinkCarriers(input, formats)).not.toBe(styleWikiLinkCarriers(input, on));
    expect(styleWikiLinkCarriers(input, formats)).not.toBe(styleWikiLinkCarriers(input, off));
  });
});

describe("unbalanced carriers degrade to stripping, never to leaked bytes", () => {
  const cases: Array<[string, string, string]> = [
    ["an opener with no closer", `a ${OPEN}b c`, "a b c"],
    ["a closer with no opener", `a b${CLOSE} c`, "a b c"],
    ["a closer before an opener", `${CLOSE}a${OPEN}b`, "ab"],
    ["a second opener inside an open span", `${OPEN}a${OPEN}b${CLOSE}`, "ab"],
    ["a trailing opener at end of input", `text${OPEN}`, "text"],
    ["carriers only", `${OPEN}${CLOSE}${CLOSE}${OPEN}`, ""],
  ];

  for (const [name, input, visible] of cases) {
    test(`${name}: colour off strips and keeps the text`, () => {
      expect(styleWikiLinkCarriers(input, off)).toBe(visible);
    });

    test(`${name}: colour on emits no half-open pair`, () => {
      const result = styleWikiLinkCarriers(input, on);
      expect(result).not.toContain(OPEN);
      expect(result).not.toContain(CLOSE);
      // Whatever styling fired, it is balanced: as many opens as closes.
      const opens = result.split(CYAN_UNDERLINE_OPEN).length - 1;
      const closes = result.split(CYAN_UNDERLINE_CLOSE).length - 1;
      expect(opens).toBe(closes);
      expect(stripAnsi(result)).toBe(visible);
    });
  }
});

describe("a hostile document cannot forge a styled span", () => {
  test("authored carriers are stripped before the lexer sees them", () => {
    const source = `A paragraph with ${OPEN}forged${CLOSE} carriers in it.\n`;
    expect(preprocessBody(source, UNICODE_GLYPHS)).toBe("A paragraph with forged carriers in it.\n");
  });

  test("and the rendered document carries neither the carriers nor a style", () => {
    const source = `A paragraph with ${OPEN}forged${CLOSE} carriers in it.\n`;
    for (const colour of [false, true]) {
      const output = render(source, 80, colour);
      expect(output).toContain("forged");
      expect(output).not.toContain(OPEN);
      expect(output).not.toContain(CLOSE);
      expect(output).not.toContain(CYAN_UNDERLINE_OPEN);
    }
  });

  test("authored carriers are stripped inside a fence too, exactly like the other sentinels", () => {
    // The strip chain runs ahead of the fence toggle by construction, for the reason
    // `stripSentinelChar` gives: a control character has no legitimate place in markdown
    // source, so a fence is not a licence to smuggle one through.
    const source = "```\n" + `code ${OPEN}x${CLOSE}\n` + "```\n";
    expect(preprocessBody(source, UNICODE_GLYPHS)).toBe("```\ncode x\n```\n");
  });
});

describe("the lexer-input witness: preprocessing introduces no NEW ESC byte", () => {
  // **Not an absence assertion, deliberately** (the plan's cycle-2 f5 disposition).
  // Decision 1 scopes "zero escape bytes" to *tool-generated* escapes; ESC the author
  // wrote passes through the verbatim paths by design, so a test demanding no ESC at all
  // in the lexer's input would contradict the spec it exists to enforce.
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
      test(`${name} (${glyphs.tier}): ESC-free source stays ESC-free`, () => {
        expect(source).not.toContain(ESC);
        expect(preprocessBody(source, glyphs)).not.toContain(ESC);
      });
    }
  }

  test("authored ESC survives with its count and relative positions intact", () => {
    // Positions, not just counts: a pass that deleted one authored escape and added one of
    // its own would keep the count and still be the defect this witness is for. Compared
    // relative to the surrounding visible text, since the transform legitimately changes
    // absolute offsets by rewriting `[[…]]` into carriers.
    const source = `Text ${ESC}[31mred${ESC}[39m and [[mdview]] and ${ESC}[1mbold${ESC}[22m.\n`;
    const processed = preprocessBody(source, UNICODE_GLYPHS);

    expect(escPositions(source).length).toBe(4);
    expect(escPositions(processed).length).toBe(4);
    // The escape *sequences* themselves are unchanged, in order.
    // The ESC prefix is load-bearing: without it `\[[0-9;]*m` also matches the literal
    // `[[m` of `[[mdview]]`, and the assertion measures the wrong thing.
    const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const sequences = (text: string): string[] => text.match(SGR) ?? [];
    expect(sequences(processed)).toEqual(sequences(source));
    // And each one still sits immediately before the same text it did.
    for (const pair of [`${ESC}[31mred`, `red${ESC}[39m`, `${ESC}[1mbold`, `bold${ESC}[22m`]) {
      expect(processed).toContain(pair);
    }
  });

  test("the whole gate corpus's own sources are ESC-free, and stay so", async () => {
    // Decision 1 asserts the fixed gate corpus contains no authored ESC. Asserted here
    // rather than assumed, because the ratchet's "0 escapes with colour off" reading
    // depends on it.
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
    expect(output).not.toContain(OPEN);
    expect(output).not.toContain(CLOSE);
  });

  test("colour on: the same characters, wrapped in cyan+underline", () => {
    const output = render("See [[mdview|the viewer]] now.\n", 80, true);
    expect(output).toContain(`${CYAN_UNDERLINE_OPEN}the viewer${CYAN_UNDERLINE_CLOSE}`);
    expect(stripAnsi(output)).toBe(stripAnsi(render("See [[mdview|the viewer]] now.\n")));
    expect(output).not.toContain(OPEN);
    expect(output).not.toContain(CLOSE);
  });

  test("inline markup inside a label is still parsed, and still nested inside the style", () => {
    // The label is written into the *source*, so the lexer sees its markup — as it did when
    // the label was wrapped in escapes. Under colour the bold pair therefore sits inside
    // the cyan/underline pair, which is what it did before this package too.
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

  test("a link inside a table cell renders the label — and the cell is NOT styled", () => {
    // Recorded as measured rather than as an aspiration: `src/table.ts` renders cell text
    // through its own path, and this is what actually happens today. The label reaches the
    // cell as carriers, is measured at its visible width (carriers being zero columns), and
    // the post-walk pass styles it in place — so the cell's *allocation* is unaffected and
    // the colourless bytes are the plain label.
    const source = "| col |\n|---|\n| [[wiki-slug]] |\n";
    expect(visible(source)).toContain("wiki-slug");
    expect(render(source)).not.toContain(ESC);
    expect(render(source)).not.toContain(OPEN);
    const coloured = render(source, 80, true);
    expect(coloured).toContain(`${CYAN_UNDERLINE_OPEN}wiki-slug${CYAN_UNDERLINE_CLOSE}`);
  });

  test("adjacent links each get their own pair", () => {
    const coloured = render("See [[a]] and [[b]].\n", 80, true);
    expect(coloured.split(CYAN_UNDERLINE_OPEN).length - 1).toBe(2);
    expect(coloured.split(CYAN_UNDERLINE_CLOSE).length - 1).toBe(2);
  });

  test("a fenced [[slug]] example is verbatim in both modes — the fence toggle", () => {
    const source = "```\nSee [[mdview]] for details.\n```\n";
    expect(render(source)).toContain("[[mdview]]");
    expect(stripAnsi(render(source, 80, true))).toContain("[[mdview]]");
    expect(render(source)).not.toContain(OPEN);
  });

  test("an embed renders `embed: label`, in both tiers and both modes", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      expect(visible("![[a note]]\n", 80, glyphs)).toContain("embed: a note");
      const coloured = render("![[a note]]\n", 80, true, glyphs);
      // The prefix is outside the pair, exactly where it was outside the SGR pair before.
      expect(coloured).toContain(`embed: ${CYAN_UNDERLINE_OPEN}a note${CYAN_UNDERLINE_CLOSE}`);
    }
  });

  // The defect record — `src/AGENTS.md`, "The wiki-link carrier defect", and WP-1 of
  // `plans/colour-modes.md`. Codespans and inline-HTML interiors are the two contexts the
  // context table marks **kept-recognizing** rather than corrupted: the pre-pass has
  // always fired there (this is not new to WP-1), and "recognition semantics stay frozen"
  // (Decision 7) means that stays exactly as it is. Pinned here as decided behaviour, not
  // as something a future package should "fix" by suppressing recognition inside these
  // two contexts.
  test("defect record: a codespan's wiki-link is still recognized and styled — kept by Decision 7", () => {
    const source = "see `[[note]]` here\n";
    expect(render(source)).toBe("see note here\n\n");
    const coloured = render(source, 80, true);
    expect(coloured).toBe(`${ESC}[0msee ${ESC}[33m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[39m here${ESC}[0m\n\n`);
  });

  test("defect record: an inline-HTML interior's wiki-link is still recognized and styled — kept by Decision 7", () => {
    // marked lexes `<span>[[note]]</span>` as `html("<span>")` + `text(carriers…)` +
    // `html("</span>")` — the carriers ride the inline `text` token between the two tag
    // tokens, not the `html` visitor (cycle-1 f6 of the plan-audit reports).
    const source = "<span>[[note]]</span>\n";
    expect(render(source)).toBe("<span>note</span>\n\n");
    const coloured = render(source, 80, true);
    expect(coloured).toBe(
      `${ESC}[0m${ESC}[90m<span>${ESC}[39m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[90m</span>${ESC}[39m${ESC}[0m\n\n`,
    );
  });

  test("task-ordered-text.md renders byte-identically in both tiers with colour off", async () => {
    // The plan names this fixture explicitly: it is the one whose rendering the task-state
    // pre-pass holds together, and it shares `preprocessBody` with the wiki-link pass. Its
    // colourless bytes carry no escape and no carrier at any of the swept widths.
    const source = await Bun.file(`${import.meta.dir}/fixtures/task-ordered-text.md`).text();
    for (const width of [60, 80, 116]) {
      for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
        const output = render(source, width, false, glyphs);
        expect(output).not.toContain(ESC);
        expect(output).not.toContain(OPEN);
        expect(output).not.toContain(CLOSE);
      }
    }
  });
});

/**
 * **The precedence matrix — today's bytes, row by row** (WP-1 of
 * `plans/wiki-link-tokenizer.md`; `src/AGENTS.md`, "The wiki-link carrier defect").
 *
 * `markWikiLinks` is a **pre-lexer regex substitution** over source lines, so it has no
 * idea what a construct the lexer has not yet built will turn out to own. It therefore
 * fires inside backslash escapes, link and image destinations and titles, HTML attribute
 * values and comments, autolinks, bare URLs and reference-definition destinations — every
 * one of which is a context whose bytes the authored `[[…]]` was never meant to leave.
 *
 * **Every expectation here is today's exact output, measured by running this renderer, and
 * every one of them is meant to fail at WP-2.** They are the tripwire net the atomic
 * cutover flips row by row under grant C3; a row whose bytes move for any *other* reason
 * is a defect. Nothing here is aspirational and nothing here should be "fixed" in place —
 * the fix is the tokenizer extension, which changes what these produce all at once.
 *
 * The three rows marked **LOSS** are the ones where today's behaviour is better than the
 * candidate's and the plan accepts the trade knowingly: an outer link or image that
 * currently survives a wiki-link in its label will stop forming.
 */
describe("the precedence matrix — today's bytes for every changing row (WP-1, recorded not fixed)", () => {
  test("C3 fix: a backslash escape does not stop recognition — the `\\` survives, the label is styled", () => {
    const source = "a \\[[note]] b\n";
    expect(at(source, PLAIN)).toBe("a \\note b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma \\${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an escaped bang still renders `embed: ` — the `!` is consumed by the pre-pass", () => {
    const source = "a \\![[note]] b\n";
    expect(at(source, PLAIN)).toBe("a \\embed: note b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma \\embed: ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an inline link's destination is rewritten, and SGR lands inside it", () => {
    // The colour-on row is the one that matters: the cyan/underline pair sits *inside*
    // the href the renderer then prints, and under hyperlinks it sits inside the OSC-8
    // destination before the BEL — a sequence no terminal can resolve.
    const source = "a [x](https://e/[[note]]) b\n";
    expect(at(source, PLAIN)).toBe("a [x](https://e/note) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma [x](${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m) b${ESC}[0m\n\n`,
    );
    expect(at(source, LINKS)).toBe(
      `${ESC}[0ma [x](${ESC}[34m${ESC}]8;;https://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${BEL}${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m) b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an inline link's title is rewritten (invisible here — this renderer drops link titles)", () => {
    const source = 'a [x](https://e/u "[[t]]") b\n';
    expect(at(source, PLAIN)).toBe("a x (https://e/u) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34mx (${ESC}[34m${ESC}[4mhttps://e/u${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an image's destination and its title are both rewritten", () => {
    expect(at("a ![alt](/[[note]]) b\n", PLAIN)).toBe("a ![alt](/note) b\n\n");
    expect(at("a ![alt](/[[note]]) b\n", COLOUR)).toBe(
      `${ESC}[0ma ![alt](/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}) b${ESC}[0m\n\n`,
    );
    // A title *is* visible on this renderer's image path — it prints `alt – title`.
    expect(at('a ![alt](/u "[[t]]") b\n', PLAIN)).toBe("a ![alt – t](/u) b\n\n");
    expect(at('a ![alt](/u "[[t]]") b\n', COLOUR)).toBe(
      `${ESC}[0ma ![alt – ${CYAN_UNDERLINE_OPEN}t${CYAN_UNDERLINE_CLOSE}](/u)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an HTML attribute value is rewritten, and SGR lands inside the tag", () => {
    const source = 'a <span title="[[note]]">x</span> b\n';
    expect(at(source, PLAIN)).toBe('a <span title="note">x</span> b\n\n');
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[90m<span title="${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}">${ESC}[39mx${ESC}[90m</span>${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an inline HTML comment's interior is rewritten and styled", () => {
    const source = "a <!-- [[note]] --> b\n";
    expect(at(source, PLAIN)).toBe("a <!-- note --> b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[90m<!-- ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} -->${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: an autolink is broken — the `>` is swallowed into the URL", () => {
    // The pre-pass eats the brackets, so `<https://e/note>` no longer closes where marked
    // expects: the rendered href carries the authored `>` inside it.
    const source = "a <https://e/[[note]]> b\n";
    expect(at(source, PLAIN)).toBe("a <https://e/note> (https://e/note>) b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma <${ESC}[34mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}> (${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}>${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: a bare URL keeps the label, and under hyperlinks puts SGR in the destination", () => {
    const source = "a https://e/[[note]] b\n";
    expect(at(source, PLAIN)).toBe("a https://e/note b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    );
    expect(at(source, LINKS)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}]8;;https://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${BEL}${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 fix: a reference definition's destination and title are rewritten", () => {
    const dest = "[x]: /[[note]]\n\nsee [x] here\n";
    expect(at(dest, PLAIN)).toBe("see x (/note) here\n\n");
    expect(at(dest, LINKS)).toBe(
      `${ESC}[0msee ${ESC}[34m${ESC}]8;;/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${BEL}${ESC}[34m${ESC}[4mx${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m here${ESC}[0m\n\n`,
    );
    const title = '[x]: /u "[[t]]"\n\nsee [x] here\n';
    expect(at(title, PLAIN)).toBe("see x (/u) here\n\n");
    expect(at(title, COLOUR)).toBe(
      `${ESC}[0msee ${ESC}[34mx (${ESC}[34m${ESC}[4m/u${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m here${ESC}[0m\n\n`,
    );
  });

  test("C3 LOSS: an inline link whose label holds a wiki-link still forms today", () => {
    // The candidate breaks this — `text + wikilink + text` and a literal `](url)`. Pinned
    // so the loss is a *measured* trade at WP-2 rather than a discovery.
    const source = "a [label [[note]]](https://e/u) b\n";
    expect(at(source, PLAIN)).toBe("a label note (https://e/u) b\n\n");
    expect(at(source, LINKS)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}]8;;https://e/u${BEL}${ESC}[34m${ESC}[4mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 LOSS: full- and collapsed-reference links whose labels hold a wiki-link still form today", () => {
    const full = "[ref]: https://e/r\n\na [label [[note]]][ref] b\n";
    expect(at(full, PLAIN)).toBe("a label note (https://e/r) b\n\n");
    expect(at(full, LINKS)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}]8;;https://e/r${BEL}${ESC}[34m${ESC}[4mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m b${ESC}[0m\n\n`,
    );
    const collapsed = "[label [[note]]]: https://e/c\n\na [label [[note]]][] b\n";
    expect(at(collapsed, PLAIN)).toBe("a label note (https://e/c) b\n\n");
    expect(at(collapsed, LINKS)).toBe(
      `${ESC}[0ma ${ESC}[34m${ESC}]8;;https://e/c${BEL}${ESC}[34m${ESC}[4mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m b${ESC}[0m\n\n`,
    );
  });

  test("C3 LOSS: an image whose alt text holds a wiki-link still forms one image token today", () => {
    const inline = "a ![alt [[note]]](img.png) b\n";
    expect(at(inline, PLAIN)).toBe("a ![alt note](img.png) b\n\n");
    expect(at(inline, COLOUR)).toBe(
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](img.png)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    );
    const reference = "[img]: /i\n\na ![alt [[note]]][img] b\n";
    expect(at(reference, PLAIN)).toBe("a ![alt note](/i) b\n\n");
    expect(at(reference, COLOUR)).toBe(
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](/i)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    );
  });

  test("D1 scope note: a match opening before a backtick wins positionally — the codespan never forms", () => {
    // Parity, not a defect: today's line-level regex behaves exactly as the candidate's
    // positional inline loop will. The label swallows the opening backtick, so `code [[y`
    // is *inside* the label and the trailing `]]` is literal. Surfaced at approval.
    const source = "a [[x `code [[y]] z` end]] b\n";
    expect(at(source, PLAIN)).toBe("a x code [[y z end]] b\n\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0ma ${CYAN_UNDERLINE_OPEN}x ${ESC}[33mcode [[y${ESC}[24m${ESC}[39m z${ESC}[39m end]] b${ESC}[0m\n\n`,
    );
  });

  test("D2: a multiline `[[a\\nb]]` does not match, and the brackets survive verbatim", () => {
    const source = "[[a\nb]]\n";
    expect(at(source, PLAIN)).toBe("[[a b]]\n\n");
    expect(at(source, COLOUR)).toBe(`${ESC}[0m[[a${ESC}[0m ${ESC}[0mb]]${ESC}[0m\n\n`);
  });

  test("D5: a bare slug's own markup is parsed today, exactly as an alias's is", () => {
    // The label is written into the *source*, so `**bold**` reaches the lexer whether it
    // came from an alias or from a bare slug. That is why the candidate lexes
    // `alias ?? slug` into child tokens rather than only an alias.
    expect(at("See [[**bold**]] now.\n", PLAIN)).toBe("See bold now.\n\n");
    expect(at("See [[**bold**]] now.\n", COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[1mbold${ESC}[22m${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
  });

  test("D5: a fragment with an alias renders the alias, and an embed's markup is parsed too", () => {
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
 * **C5 — the malformed OSC-8 a URL-shaped slug produces today** (addendum P9).
 *
 * `[[https://example.test/path]]` has no alias, so the label *is* the URL; it re-enters
 * the lexer as text, marked with carriers, and comes out as a `url` token. The carriers
 * are styled by a pass that runs over the **finished document** — which is long after the
 * OSC-8 was emitted — so the wiki chain's close codes land **inside the destination,
 * before the BEL**. There is no terminal in which that resolves.
 *
 * Pinned in all four combinations the candidate has to repair, so WP-2's repair is graded
 * against a measurement rather than against a description.
 */
describe("C5 — a URL-shaped slug emits a malformed OSC-8 today (WP-1, recorded not fixed)", () => {
  const source = "See [[https://example.test/path]] now.\n";
  const URL = "https://example.test/path";

  test("hyperlinks off: no OSC-8 at all, and the visible text is the URL", () => {
    expect(at(source, PLAIN)).toBe(`See ${URL} now.\n\n`);
    expect(at(source, COLOUR)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[39m${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m now.${ESC}[0m\n\n`,
    );
  });

  test("hyperlinks on, colour on: the wiki close pair sits inside the destination before the BEL", () => {
    const output = at(source, LINKS);
    expect(output).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}]8;;${URL}${CYAN_UNDERLINE_CLOSE}${BEL}${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}]8;;${BEL}${ESC}[39m now.${ESC}[0m\n\n`,
    );
    // The malformation named directly, so the failure at WP-2 reads as "the destination is
    // clean now" rather than as an opaque byte diff: SGR between the OSC-8 introducer and
    // its terminating BEL.
    const destination = output.slice(output.indexOf(`${ESC}]8;;`) + 5, output.indexOf(BEL));
    expect(destination).toContain(ESC);
    expect(destination).toBe(`${URL}${CYAN_UNDERLINE_CLOSE}`);
  });

  test("hyperlinks on, colour off: the destination is clean, because nothing styled it", () => {
    // The control that proves the malformation is the *styling* pass's rather than the
    // OSC-8 emitter's: same destination, same link, no escape inside it.
    expect(at(source, LINKS_PLAIN)).toBe(
      `See ${ESC}]8;;${URL}${BEL}${URL}${ESC}]8;;${BEL} now.\n\n`,
    );
  });

  test("hyperlinks on under tmux: the DCS envelope wraps the same malformed destination", () => {
    expect(at(source, LINKS_TMUX)).toBe(
      `${ESC}[0mSee ${CYAN_UNDERLINE_OPEN}${ESC}[34m${ESC}Ptmux;${ESC}${ESC}]8;;${URL}${CYAN_UNDERLINE_CLOSE}${BEL}${ESC}\\${ESC}[34m${ESC}[4m${URL}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}Ptmux;${ESC}${ESC}]8;;${BEL}${ESC}\\${ESC}[39m now.${ESC}[0m\n\n`,
    );
  });
});

/**
 * **C2 — today's post-wrap encasing on a wrapped prose label**.
 *
 * Wiki-links are the only styled producer in this renderer whose styling is applied
 * *after* wrapping: the post-document pass sees a label already split across lines and
 * `applyStyle`'s line-break encasing closes and reopens the chain around every generated
 * break. Every other styled span is styled before the wrap, and `src/wrap.ts` synthesizes
 * no close/open pair at a break (addendum P1) — so those spans carry one open and one
 * close however many lines they cross.
 *
 * WP-2 authorizes wiki-links to join them. These pins are what that grant is measured
 * against: word-wrapped at 24, hard-split at 8, in all three modes.
 */
describe("C2 — a wrapped prose label is encased per line today (WP-1, recorded not fixed)", () => {
  const source = "See [[a-very-long-wiki-label-that-must-wrap-here]] now.\n";

  test("width 24 (word wrap into a hard split): one pair per rendered line", () => {
    expect(at(source, PLAIN, 24)).toBe(
      "See\na-very-long-wiki-label-t\nhat-must-wrap-here now.\n\n",
    );
    expect(at(source, COLOUR, 24)).toBe(
      `${ESC}[0mSee\n${CYAN_UNDERLINE_OPEN}a-very-long-wiki-label-t${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}hat-must-wrap-here${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
    expect(at(source, FORMATS_POLICY, 24)).toBe(
      `${ESC}[0mSee\n${ESC}[4ma-very-long-wiki-label-t${ESC}[24m\n${ESC}[4mhat-must-wrap-here${ESC}[24m now.${ESC}[0m\n\n`,
    );
  });

  test("width 8 (six hard-split fragments): six pairs, one per line", () => {
    expect(at(source, PLAIN, 8)).toBe(
      "See\na-very-l\nong-wiki\n-label-t\nhat-must\n-wrap-he\nre now.\n\n",
    );
    const coloured = at(source, COLOUR, 8);
    expect(coloured).toBe(
      `${ESC}[0mSee\n${CYAN_UNDERLINE_OPEN}a-very-l${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}ong-wiki${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}-label-t${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}hat-must${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}-wrap-he${CYAN_UNDERLINE_CLOSE}\n${CYAN_UNDERLINE_OPEN}re${CYAN_UNDERLINE_CLOSE} now.${ESC}[0m\n\n`,
    );
    // Counted as well as spelled: six opens is the encasing. One open is what every other
    // styled span in this renderer emits across the same six lines, and is what C2 grants.
    expect(coloured.split(CYAN_UNDERLINE_OPEN).length - 1).toBe(6);
    expect(at(source, FORMATS_POLICY, 8)).toBe(
      `${ESC}[0mSee\n${ESC}[4ma-very-l${ESC}[24m\n${ESC}[4mong-wiki${ESC}[24m\n${ESC}[4m-label-t${ESC}[24m\n${ESC}[4mhat-must${ESC}[24m\n${ESC}[4m-wrap-he${ESC}[24m\n${ESC}[4mre${ESC}[24m now.${ESC}[0m\n\n`,
    );
  });
});

/**
 * **C6 — the two table-cell defects, measured** (addendum P13 and P14).
 *
 * Both come from the same place: `src/table.ts` builds plain measured strings and never
 * dispatches a cell token, so a wiki label in a cell is styled by the pass that runs over
 * the **whole finished document** — chrome and all.
 *
 * - **C6a, the bleed.** A wrapped label's style opens on one row and closes on another, so
 *   every byte between them — the cell's padding, the border glyph, the *neighbouring
 *   cell's text* — renders inside the label's cyan. Measured at width 16 below: the `y`
 *   column renders inside `36m`.
 * - **C6b, the boundary spaces.** `cellText` collapses `\s+` and trims, and the carriers
 *   are not whitespace, so they fenced the label's own leading and trailing spaces from
 *   that collapse. `| [[ b ]] |` therefore keeps them, which no other cell text does.
 *
 * Both are recorded as defects and repaired at WP-2 by the span-cell contract, whose
 * fragment scoping makes the first impossible by construction and whose carrier-free
 * normalization makes the second unreachable.
 */
describe("C6 — table-cell wiki-link bytes today: the cross-chrome bleed and the boundary spaces (WP-1, recorded not fixed)", () => {
  test("C6b: a label's boundary whitespace survives the cell's own collapse", () => {
    const source = "| col |\n|---|\n| [[ b ]] |\n";
    // Three visible columns wide, not one: the label is ` b `, spaces included.
    expect(at(source, PLAIN)).toBe("┌─────┐\n│ col │\n├─────┤\n│  b  │\n└─────┘\n");
    expect(at(source, COLOUR)).toBe(
      `${ESC}[90m┌─────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m col ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├─────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN} b ${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m\n${ESC}[90m└─────┘${ESC}[39m\n`,
    );
  });

  test("C6a: a wrapped label bleeds cyan across padding, borders and into the neighbour cell", () => {
    const source = "| a | y |\n|---|---|\n| [[abcdefghijklmnopqrstuvwxyz]] | y |\n";
    expect(at(source, PLAIN, 16)).toBe(
      "┌──────────┬───┐\n│ a        │ y │\n├──────────┼───┤\n│ abcdefgh │ y │\n│ ijklmnop │   │\n│ qrstuvwx │   │\n│ yz       │   │\n└──────────┴───┘\n",
    );
    const coloured = at(source, COLOUR, 16);
    expect(coloured).toBe(
      `${ESC}[90m┌──────────${ESC}[39m${ESC}[90m┬───┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m a        ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m y ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├──────────${ESC}[39m${ESC}[90m┼───┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${ESC}[36m${ESC}[4mabcdefgh ${ESC}[90m│${ESC}[39m${ESC}[36m y ${ESC}[90m│${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m\n${ESC}[36m${ESC}[4m${ESC}[90m│${ESC}[39m${ESC}[36m ijklmnop ${ESC}[90m│${ESC}[39m${ESC}[36m   ${ESC}[90m│${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m\n${ESC}[36m${ESC}[4m${ESC}[90m│${ESC}[39m${ESC}[36m qrstuvwx ${ESC}[90m│${ESC}[39m${ESC}[36m   ${ESC}[90m│${ESC}[39m${ESC}[36m${ESC}[24m${ESC}[39m\n${ESC}[36m${ESC}[4m${ESC}[90m│${ESC}[39m${ESC}[36m yz${ESC}[24m${ESC}[39m       ${ESC}[90m│${ESC}[39m   ${ESC}[90m│${ESC}[39m\n${ESC}[90m└──────────${ESC}[39m${ESC}[90m┴───┘${ESC}[39m\n`,
    );
    // The defect named rather than only spelled: the second column's `y` renders between a
    // cyan open and its close, on a row whose own cell holds no wiki-link at all.
    const bleeding = coloured.split("\n")[3] ?? "";
    expect(bleeding).toContain(`${ESC}[36m y ${ESC}[90m│`);
    // ... and the style crosses a border glyph, which is exactly what fragment scoping forbids.
    expect(bleeding).toContain(`${ESC}[4mabcdefgh ${ESC}[90m│`);
  });

  test("C6a: a body cell and a header cell, unwrapped, in `full` and `formats`", () => {
    const body = "| col |\n|---|\n| [[wiki-slug]] |\n";
    expect(at(body, PLAIN)).toBe(
      "┌───────────┐\n│ col       │\n├───────────┤\n│ wiki-slug │\n└───────────┘\n",
    );
    expect(at(body, COLOUR)).toBe(
      `${ESC}[90m┌───────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m col       ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}wiki-slug${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────┘${ESC}[39m\n`,
    );
    expect(at(body, FORMATS_POLICY)).toBe(
      `┌───────────┐\n│${ESC}[1m col       ${ESC}[22m│\n├───────────┤\n│ ${ESC}[4mwiki-slug${ESC}[24m │\n└───────────┘\n`,
    );

    const header = "| [[head-slug]] |\n|---|\n| body |\n";
    expect(at(header, PLAIN)).toBe(
      "┌───────────┐\n│ head-slug │\n├───────────┤\n│ body      │\n└───────────┘\n",
    );
    // The head-bold chain nests around the wiki chain through `applyStyle`'s existing
    // surgery — no new nesting mechanism, which is what the span contract inherits.
    expect(at(header, COLOUR)).toBe(
      `${ESC}[90m┌───────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m ${CYAN_UNDERLINE_OPEN}head-slug${CYAN_UNDERLINE_CLOSE} ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m body      ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────┘${ESC}[39m\n`,
    );
    expect(at(header, FORMATS_POLICY)).toBe(
      `┌───────────┐\n│${ESC}[1m ${ESC}[4mhead-slug${ESC}[24m ${ESC}[22m│\n├───────────┤\n│ body      │\n└───────────┘\n`,
    );
  });

  test("C6a: every alignment, one wiki-link per column", () => {
    const source = "| L | C | R |\n|:---|:---:|---:|\n| [[a]] | [[b]] | [[c]] |\n";
    expect(at(source, PLAIN)).toBe(
      "┌───┬───┬───┐\n│ L │ C │ R │\n├───┼───┼───┤\n│ a │ b │ c │\n└───┴───┴───┘\n",
    );
    expect(at(source, COLOUR)).toBe(
      `${ESC}[90m┌───${ESC}[39m${ESC}[90m┬───${ESC}[39m${ESC}[90m┬───┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m L ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m C ${ESC}[22m${ESC}[90m│${ESC}[39m${ESC}[1m R ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───${ESC}[39m${ESC}[90m┼───${ESC}[39m${ESC}[90m┼───┤${ESC}[39m\n${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}a${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m ${CYAN_UNDERLINE_OPEN}c${CYAN_UNDERLINE_CLOSE} ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───${ESC}[39m${ESC}[90m┴───${ESC}[39m${ESC}[90m┴───┘${ESC}[39m\n`,
    );
  });

  test("D4: an escaped pipe keeps the alias in one cell; an unescaped one is eaten, not split", () => {
    // The authored-correct spelling. `marked` unescapes `\|` when it splits the row, so the
    // cell's inline source carries a real `|` and the pre-pass reads it as the alias
    // separator — the behaviour the candidate preserves.
    const escaped = "| col |\n|---|\n| [[s\\|Alias]] |\n";
    expect(at(escaped, PLAIN)).toBe("┌───────┐\n│ col   │\n├───────┤\n│ Alias │\n└───────┘\n");
    // And today's *accidental* tolerance of the unescaped form: the pre-pass runs before
    // the lexer splits the row, so the `|` is gone by the time GFM would have split on it
    // and the cell survives whole. **The candidate does not reproduce this** — D4 says an
    // unescaped pipe splits the cell, per GFM. Recorded as malformed markdown.
    const unescaped = "| a | b |\n|---|---|\n| [[s|Alias]] | y |\n";
    expect(at(unescaped, PLAIN)).toBe(
      "┌───────┬───┐\n│ a     │ b │\n├───────┼───┤\n│ Alias │ y │\n└───────┴───┘\n",
    );
  });

  test("cells carry no OSC-8 today, even for a URL-shaped slug with hyperlinks on", () => {
    // Decision 3's no-OSC-8 rule already holds here, for a reason that survives the
    // cutover: `renderTable` never dispatches a cell token, so `renderLink` is unreachable
    // from a cell. The span producer keeps it true by flattening a label's children.
    const output = at("| col |\n|---|\n| [[https://example.test/path]] |\n", LINKS);
    expect(output).not.toContain(`${ESC}]8;;`);
    expect(output).toContain(`${CYAN_UNDERLINE_OPEN}https://example.test/path${CYAN_UNDERLINE_CLOSE}`);
  });

  test("a label's own markup is flattened in a cell — no nested SGR", () => {
    const source = "| col |\n|---|\n| [[**bold**]] |\n";
    expect(at(source, PLAIN)).toBe("┌──────┐\n│ col  │\n├──────┤\n│ bold │\n└──────┘\n");
    const coloured = at(source, COLOUR);
    expect(coloured).toContain(`${CYAN_UNDERLINE_OPEN}bold${CYAN_UNDERLINE_CLOSE}`);
    expect(coloured).not.toContain(`${ESC}[1mbold`);
  });

  test("entities decode around a label, and the label does not fence the decode", () => {
    const source = "| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n";
    expect(at(source, PLAIN)).toBe(
      "┌───────────┐\n│ col       │\n├───────────┤\n│ a & b <c> │\n└───────────┘\n",
    );
    expect(at(source, COLOUR)).toBe(
      `${ESC}[90m┌───────────┐${ESC}[39m\n${ESC}[90m│${ESC}[39m${ESC}[1m col       ${ESC}[22m${ESC}[90m│${ESC}[39m\n${ESC}[90m├───────────┤${ESC}[39m\n${ESC}[90m│${ESC}[39m a & ${CYAN_UNDERLINE_OPEN}b${CYAN_UNDERLINE_CLOSE} <c> ${ESC}[90m│${ESC}[39m\n${ESC}[90m└───────────┘${ESC}[39m\n`,
    );
  });
});

/**
 * **The ownership-class probe sweep — the matrix's closing rule made executable.**
 *
 * The matrix claims to enumerate *every* built-in inline ownership shape in marked's
 * tokenizer order (`marked.esm.js:1549-1635`): escape, tag, comment, link in its four
 * forms, image in its four forms, autolink, url, codespan, emStrong, br, del, inlineText.
 * A claim of completeness needs a total instrument, so this is one: each shape containing
 * `[[note]]`, with today's rendered bytes pinned exactly, in both colour modes.
 *
 * **Its job is to fail at WP-2 in a countable way.** A shape whose class the matrix did not
 * predict shows up here as a diff nobody authorized — a *tripped hold*, not a silent
 * extension of grant C3.
 */
describe("the ownership-class probe sweep — every built-in inline shape, today's bytes", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "escape",
      "a \\[[note]] b\n",
      "a \\note b\n\n",
      `${ESC}[0ma \\${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} b${ESC}[0m\n\n`,
    ],
    [
      "tag",
      'a <span title="[[note]]">x</span> b\n',
      'a <span title="note">x</span> b\n\n',
      `${ESC}[0ma ${ESC}[90m<span title="${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}">${ESC}[39mx${ESC}[90m</span>${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "comment",
      "a <!-- [[note]] --> b\n",
      "a <!-- note --> b\n\n",
      `${ESC}[0ma ${ESC}[90m<!-- ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} -->${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (inline)",
      "a [label [[note]]](https://e/u) b\n",
      "a label note (https://e/u) b\n\n",
      `${ESC}[0ma ${ESC}[34mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} (${ESC}[34m${ESC}[4mhttps://e/u${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (full reference)",
      "[r]: https://e/r\n\na [label [[note]]][r] b\n",
      "a label note (https://e/r) b\n\n",
      `${ESC}[0ma ${ESC}[34mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} (${ESC}[34m${ESC}[4mhttps://e/r${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (collapsed reference)",
      "[label [[note]]]: https://e/c\n\na [label [[note]]][] b\n",
      "a label note (https://e/c) b\n\n",
      `${ESC}[0ma ${ESC}[34mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} (${ESC}[34m${ESC}[4mhttps://e/c${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "link (shortcut reference)",
      "[label [[note]]]: https://e/s\n\na [label [[note]]] b\n",
      "a label note (https://e/s) b\n\n",
      `${ESC}[0ma ${ESC}[34mlabel ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE} (${ESC}[34m${ESC}[4mhttps://e/s${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "image (inline)",
      "a ![alt [[note]]](img.png) b\n",
      "a ![alt note](img.png) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](img.png)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    ],
    [
      "image (full reference)",
      "[i]: /i\n\na ![alt [[note]]][i] b\n",
      "a ![alt note](/i) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](/i)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    ],
    [
      "image (collapsed reference)",
      "[alt [[note]]]: /ic\n\na ![alt [[note]]][] b\n",
      "a ![alt note](/ic) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](/ic)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    ],
    [
      "image (shortcut reference)",
      "[alt [[note]]]: /is\n\na ![alt [[note]]] b\n",
      "a ![alt note](/is) b\n\n",
      `${ESC}[0ma ![alt ${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}](/is)${ESC}[0m ${ESC}[0mb${ESC}[0m\n\n`,
    ],
    [
      "autolink",
      "a <https://e/[[note]]> b\n",
      "a <https://e/note> (https://e/note>) b\n\n",
      `${ESC}[0ma <${ESC}[34mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}> (${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}>${ESC}[24m${ESC}[39m${ESC}[34m)${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "url",
      "a https://e/[[note]] b\n",
      "a https://e/note b\n\n",
      `${ESC}[0ma ${ESC}[34m${ESC}[34m${ESC}[4mhttps://e/${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[24m${ESC}[39m${ESC}[34m${ESC}[39m b${ESC}[0m\n\n`,
    ],
    [
      "codespan",
      "a `[[note]]` b\n",
      "a note b\n\n",
      `${ESC}[0ma ${ESC}[33m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[39m b${ESC}[0m\n\n`,
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
      `${ESC}[0ma ${ESC}[2m${ESC}[90m${ESC}[9m${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}${ESC}[29m${ESC}[39m${ESC}[22m b${ESC}[0m\n\n`,
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
    // If a shape joins the matrix without a row here, this count is the tripwire.
    expect(cases.length).toBe(18);
  });

  for (const [name, source, plain, coloured] of cases) {
    test(`${name}: today's bytes, colour off and colour on`, () => {
      expect(at(source, PLAIN)).toBe(plain);
      expect(at(source, COLOUR)).toBe(coloured);
    });
  }
});
