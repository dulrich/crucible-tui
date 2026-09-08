import { describe, expect, test } from "bun:test";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderDocument } from "../src/render";

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
const CYAN_UNDERLINE_OPEN = `${ESC}[36m${ESC}[4m`;
const CYAN_UNDERLINE_CLOSE = `${ESC}[24m${ESC}[39m`;
const UNDERLINE_OPEN = `${ESC}[4m`;
const UNDERLINE_CLOSE = `${ESC}[24m`;

const COLOUR = { sgr: "full", hyperlinks: false, tmux: false } as const;
const PLAIN = { sgr: "none", hyperlinks: false, tmux: false } as const;

// The three axes beyond those two: the hyperlink axis (which is what makes the OSC-8 rows
// visible at all), the tmux envelope, and the `formats` mode.
const FORMATS_POLICY = { sgr: "formats", hyperlinks: false, tmux: false } as const;
const LINKS = { sgr: "full", hyperlinks: true, tmux: false } as const;

type Policy = typeof PLAIN | typeof COLOUR | typeof FORMATS_POLICY | typeof LINKS;

/** Render under an explicit policy — the shape every pin below is measured with. */
const at = (source: string, policy: Policy, width = 80, glyphs = UNICODE_GLYPHS): string =>
  renderDocument(source, width, glyphs, undefined, undefined, undefined, policy);

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

  test("D4 of `plans/follow-wiki-links.md`: a resolver reaches prose, never a cell", () => {
    // The cells deferral, asserted rather than described. `styleWikiLabel` is the only place
    // the resolver is consulted and `renderTable` never dispatches a cell token, so a cell's
    // label is flattened by `src/table.ts` and cannot become a hyperlink however the policy
    // and the resolver are set. The splitter would have to split the sequence to allow it;
    // that is follow-up work, not this plan's.
    const source = "| col |\n|---|\n| [[note]] |\n";
    const resolveNote = (slug: string): string | undefined =>
      slug === "note" ? "file:///v/note.md" : undefined;
    const followed = renderDocument(
      source,
      80,
      UNICODE_GLYPHS,
      undefined,
      undefined,
      undefined,
      LINKS,
      resolveNote,
    );
    expect(followed).not.toContain(`${ESC}]8;;`);
    // And byte-identical to the same render with no resolver at all — the cell path is
    // unmoved by this plan.
    expect(followed).toBe(at(source, LINKS));
    expect(followed).toContain(`${CYAN_UNDERLINE_OPEN}note${CYAN_UNDERLINE_CLOSE}`);

    // The same in a prose paragraph beside it, so the witness shows the seam rather than an
    // absence: identical source text, one rendered inside a cell and one outside it.
    const prose = renderDocument(
      "See [[note]] now.\n",
      80,
      UNICODE_GLYPHS,
      undefined,
      undefined,
      undefined,
      LINKS,
      resolveNote,
    );
    expect(prose).toContain(`${ESC}]8;;file:///v/note.md`);
  });
});
