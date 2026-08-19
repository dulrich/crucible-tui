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

const on = { color: true };
const off = { color: false };

const COLOUR = { color: true, hyperlinks: false, tmux: false } as const;
const PLAIN = { color: false, hyperlinks: false, tmux: false } as const;

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
