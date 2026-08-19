import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
// WP-2d moved these out of this file and into `src/detectors.ts` so the corpus sweep
// measures with the same implementation the test suite does. The move was verified to
// change no count: 58 aggregate metrics (4 fixtures x 6 widths x 2 tiers, plus a
// 1,000-file corpus sample at 5 widths) and all 17 per-file corpus entries were
// byte-identical before and after. **Do not reimplement any of them here.**
// WP-5 of `plans/tn-review-remediation.md` then moved the line primitives one module
// further, to `src/list-lines.ts`, so `src/render.ts` reaches them without importing the
// detectors at all — same rule, one level down: relocated, never copied.
import {
  findColumnZeroMarkers,
  findContinuationOverIndent,
  findListOrphans,
} from "../src/detectors";
import type { ColourPolicy } from "../src/colour";
import type { GlyphSet } from "../src/glyphs";
import { resolveFenceLanguage } from "../src/lang";
import { LIST_BULLET, isIndentedLine, stripAnsi } from "../src/list-lines";
import { renderDocument, renderDocumentDetailed } from "../src/render";
import { NARROW_MEASURE } from "../src/width";

// ---------------------------------------------------------------------------
// WP-2 / WP-2b — the loose-list double-wrap defect (characterized in WP-2, closed
// in WP-2b).
//
// Read this before changing anything below. **No width assertion can see this
// defect**: an orphaned line is *under* the target width, so `--check` and both
// corpus sweeps are blind to it by construction. That is exactly why it survived
// every gate. `findListOrphans` is therefore the only thing that tests it.
//
// The metric itself — definition, its one known blind spot, and why neither may be
// loosened — now lives in `src/detectors.ts`, imported above. It moved there in
// WP-2d so `scripts/sweep.ts` measures with this exact implementation rather than a
// second copy that drifts from it. Read that module's doc comment before touching
// any orphan assertion here.
// ---------------------------------------------------------------------------

// **116, 172 and 346 are the user's three real terminal widths** (the three tiled
// layouts); 116 and 346 were added in WP-2c, which found the orphan defect had until
// then been measured only at 80/100/120/172 — one real width out of four. 80/100/120
// stay: they are the WP-2b baseline and 80 is the narrowest case the wrap has to
// survive.
const WP2_WIDTHS = [80, 100, 116, 120, 172, 346];

// The subset at which these fixtures actually wrap. A handful of assertions below are
// *structural* — "this item spans more than one line", "the nested block fills its
// budget to within 4 columns" — and at 346 columns the fixture text simply fits on one
// line, which would make them assert nothing (or fail) for a reason that has nothing to
// do with the behaviour under test. Orphan counts and width bounds are checked at every
// width in `WP2_WIDTHS`, including 346; only shape assertions use this narrower set.
const WP2_WRAPPING_WIDTHS = WP2_WIDTHS.filter((width) => width <= 172);

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

  // Closed by WP-2b. Until then this fixture rendered 12/9/6/7 orphans at these four
  // widths; the paragraph override now renders a loose item at the width the item will
  // actually occupy, so `rewrapListBody` has nothing left to shear. The counts are the
  // only evidence that holds — every width gate stays green either way.
  test("loose list items emit no orphaned lines, at every width and both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        expect(findListOrphans(renderDocument(source, width, glyphs), width)).toEqual([]);
      }
    }
  });

  // The three lines this used to shear off, named individually: a count going to zero
  // proves nothing if the fixture stopped containing the case.
  test("the lines the defect used to shear are back on the line they belong to", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    const lines = renderDocument(source, 80, UNICODE_GLYPHS).split("\n").map(stripAnsi);

    for (const [orphan, follows] of [
      ["several", "rendered lines at any reasonable"],
      ["between", "items, which is what makes marked"],
      ["which the", "orphaned trailing word appears"],
    ] as const) {
      expect(lines.some((line) => line.trim() === orphan)).toBe(false);
      expect(lines.some((line) => line.includes(`${orphan} ${follows}`))).toBe(true);
    }
  });

  // Unsettled point 1 of the WP-2b brief. `"10. "` is four columns, not two: a budget
  // built on a hardcoded 2 leaves every line of a ten-item ordered loose list two
  // columns over, and `rewrapListBody` shears the tail off again. Counterfactual run
  // while writing this: forcing `listMarkerWidth` to return 2 puts 2 orphans back at
  // width 100 and 1 at width 172 in this fixture's ordered section.
  test("a loose ordered list wide enough to reach a two-digit marker wraps to the marker's real width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WRAPPING_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const tenth = lines.findIndex((line) => line.trimStart().startsWith("10. "));
      expect(tenth).toBeGreaterThan(-1);

      // the marker line and its continuations, up to the end of that item
      const item = [lines[tenth] as string];
      for (let i = tenth + 1; i < lines.length && isIndentedLine(lines[i] as string); i += 1) {
        if (LIST_BULLET.test(lines[i] as string)) break;
        item.push(lines[i] as string);
      }
      expect(item.length).toBeGreaterThan(1);
      for (const line of item) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      // continuations are indented under the four-column marker, not a two-column one
      expect((item[1] as string).length - (item[1] as string).trimStart().length).toBe(8);
      expect(findListOrphans(item.join("\n"), width)).toEqual([]);
    }
  });

  // Unsettled point 2. An authored break is real content: it must survive whatever the
  // list path does to wrapping. It is also the reason this WP re-renders the paragraph
  // at the right width instead of coalescing the wrapped result — by the time a result
  // reaches the override, `reflowText` has already turned its own wraps *and* the
  // author's break into the same bare `\n`.
  test("an authored <br /> break inside a loose list item survives", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const broken = lines.findIndex((line) => line.trimEnd().endsWith("A hard break follows this sentence."));
      expect(broken).toBeGreaterThan(-1);
      // the break held: the next line starts the following sentence, and it would
      // comfortably have fitted on the line above, so nothing but the break put it there
      expect((lines[broken + 1] as string).trim()).toStartWith("And this sentence must begin");
      expect(stringWidth(lines[broken] as string) + 1 + "And".length).toBeLessThan(width);
    }
  });

  // Unsettled point 4. Two paragraphs in one loose item fire the override twice; they
  // must not run into each other. Kept out of `loose-list.md` on purpose: the library
  // drops the blank line between an item's paragraphs (`bulletPointLines`' own
  // `.filter(identity)`), so a paragraph boundary is *indistinguishable* from a shear in
  // the rendered text, and `findListOrphans` flags the first paragraph's short last line
  // as an orphan. That is a blind spot of the metric, not a defect in the rendering —
  // see the WP-2b report. Asserted structurally here instead of by count.
  test("two paragraphs in one loose item stay two paragraphs", () => {
    const source = [
      "- The first paragraph of an item that carries two of them, written long enough that it wraps across more than one rendered line at every width under test.",
      "",
      "  The second paragraph of that very same item, also long enough to wrap, which must stay a separate block rather than being folded onto the end of the first one.",
      "",
      "- A closing item, long enough to wrap, so the two-paragraph item is not the last thing in the list and the list is unambiguously loose.",
    ].join("\n");

    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs);
        const lines = rendered.split("\n").map(stripAnsi);
        // the second paragraph starts its own line — never appended to the first's tail
        const second = lines.findIndex((line) => line.trim().startsWith("The second paragraph"));
        expect(second).toBeGreaterThan(-1);
        expect(lines.filter((line) => line.includes("under test. The second paragraph"))).toEqual([]);
        for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // Not one of the four unsettled points — found by the corpus byte-differential, and
  // a regression this WP would otherwise have shipped. `marked-terminal`'s
  // `isPointedLine` treats *any* line starting with `*` or `N.` as a marker line, and
  // an item's continuation lines sit at column 0 when it runs. Moving a wrap point can
  // therefore hand it a line it mistakes for a marker: in an ordered list that line
  // consumes an item number and every later item is renumbered. Counterfactual, with
  // the guard in `render.ts` disabled: this renders as 1, 2001, 3, 4.
  test("a continuation line that starts like a list marker does not steal an item number", () => {
    const build = (fillers: number): string =>
      [
        `1. ${Array.from({ length: fillers }, (_, i) => `word${i}`).join(" ")} 2001. Marks the start of a sentence, and the item then continues for a good while afterwards so that it wraps more than once in total.`,
        "",
        "2. A second ordered item, long enough to wrap at the widths under test, closing the list.",
        "",
        "3. A third ordered item, also long enough to wrap at the widths under test.",
      ].join("\n");

    // filler counts chosen so the `2001.` token lands at the start of a wrapped line
    for (const [fillers, width] of [
      [17, 120],
      [27, 100],
      [25, 172],
    ] as const) {
      const lines = renderDocument(build(fillers), width)
        .split("\n")
        .map(stripAnsi)
        .filter((line) => line.trim() !== "");

      // the token is where we think it is — otherwise this test proves nothing
      expect(lines.some((line, index) => index > 0 && line.trim().startsWith("2001."))).toBe(true);
      // item markers are still 1, 2, 3 at the depth-1 indent
      expect(lines.map((line) => /^ {4}(\d+)\.\s/.exec(line)?.[1]).filter(Boolean)).toEqual(["1", "2", "3"]);
      // and no `"* "` inside the text was rewritten into a number
      expect(lines.filter((line) => /\*\d+\.\s/.test(line))).toEqual([]);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // Unsettled point 3. The budget subtracts one marker + one indent *per enclosing
  // level*, so an off-by-a-level shows up as either overflow (too shallow — caught by
  // the width test above) or a visibly short right edge (too deep). Depth 2 at width 80
  // fills to 79 of 80; a depth-3 budget would cap it around 73.
  test("a nested loose list is wrapped at its own depth's budget, not its parent's", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const width of WP2_WRAPPING_WIDTHS) {
      const lines = renderDocument(source, width, UNICODE_GLYPHS).split("\n").map(stripAnsi);
      const nested = lines.filter((line) => /^\s{8}/.test(line) && line.trim() !== "");
      expect(nested.length).toBeGreaterThan(3);
      const widest = Math.max(...nested.map((line) => stringWidth(line)));
      expect(widest).toBeLessThanOrEqual(width);
      expect(widest).toBeGreaterThanOrEqual(width - 4);
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2c — the same visual defect, in *tight* lists, by a different mechanism.
//
// A tight item is not a paragraph token, so `marked-terminal` never reflows it and the
// author's own line breaks reach `rewrapListBody` verbatim. Adding the six columns of
// marker and indent pushes each authored line over the target and `rewrapListBody`
// splits it *per line*, shearing the tail word onto a line of its own.
//
// **The load-bearing premise is that a hard break is still distinguishable here.** It is
// — but not as `marked-terminal`'s `HARD_RETURN`. Its `br` renderer never fires for a
// tight item (`Renderer.prototype.text`, `index.js:84-89`, renders a block text token
// from raw `token.text` and never dispatches `token.tokens`), so the *markdown source
// spelling* of the break arrives instead. The first test below is that premise, asserted
// directly rather than assumed; if it ever stops holding, safe coalescing is impossible
// and the rest of this block is unsound.
//
// The metric is `findListOrphans`, unchanged and shared with WP-2b above.
// ---------------------------------------------------------------------------

describe("renderDocument — tight-list authored soft breaks (WP-2c)", () => {
  const at = (source: string, width: number, glyphs = UNICODE_GLYPHS): string[] =>
    renderDocument(source, width, glyphs).split("\n").map(stripAnsi);

  // The premise. A soft break is a space; a hard break is a line. Both are authored, and
  // only the source spelling tells them apart at this seam.
  test("a soft break in a tight item is joined and each authored hard break is kept", () => {
    const tail = "and this trailing text is here purely so that the item is long enough to be interesting.";
    const cases = [
      ["soft", `- A first line with no break marker at its end\n  ${tail}\n`, true],
      ["two trailing spaces", `- A first line ending in two spaces  \n  ${tail}\n`, false],
      ["trailing backslash", `- A first line ending in a backslash\\\n  ${tail}\n`, false],
      ["<br />", `- A first line ending in a break tag.<br />\n  ${tail}\n`, false],
      ["<br>", `- A first line ending in a bare break tag.<br>\n  ${tail}\n`, false],
    ] as const;

    for (const [name, source, shouldJoin] of cases) {
      // 200 columns: the whole item fits on one rendered line, so the *only* thing that
      // can put the tail on a line of its own is the break itself, never the wrap.
      const lines = at(source, 200).filter((line) => line.trim() !== "");
      expect(`${name} -> ${lines.length} line(s)`).toBe(`${name} -> ${shouldJoin ? 1 : 2} line(s)`);
      // whichever way it went, the text itself is intact and in order
      expect(lines.join(" ").replace(/\s+/g, " ")).toContain(tail);
    }
  });

  test("tight list items emit no orphaned lines, at every width and both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        expect(findListOrphans(renderDocument(source, width, glyphs), width)).toEqual([]);
      }
    }
  });

  test("no line of the tight-list fixture exceeds the target width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        for (const line of renderDocument(source, width, glyphs).split("\n")) {
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  // A count going to zero proves nothing if the fixture stopped containing the case, so
  // the words this defect used to shear off are named individually. Counterfactual,
  // measured on the parent commit with this fixture: 2/12/3/3/1/0 orphans at
  // 80/100/116/120/172/346.
  test("the words the defect used to shear are back on the line they belong to", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [width, orphan, follows] of [
      [100, "previous pass", "has already written out"],
      [116, "middling", "terminal looks like"],
      [172, "and which", "therefore only shears"],
    ] as const) {
      const lines = at(source, width);
      expect(lines.some((line) => line.trim() === orphan)).toBe(false);
      expect(lines.some((line) => line.includes(`${orphan} ${follows}`))).toBe(true);
    }
  });

  // The two ways this change can silently destroy content, neither of which any width
  // gate can see. A long token is never joined *into* — it was never split, because
  // nothing reflowed the item — and a fence is never reached at all, because it is a
  // `code` token and this pass only ever sees `text` tokens.
  test("a long URL and a long path survive a coalescing pass intact", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    const url = "https://example.invalid/a/deliberately/long/url/that/must/never/be/split/or/joined/mid-token/ok";
    const path = "/home/example/some/deliberately/long/filesystem/path/that/must/also/survive/a/join/verbatim.md";
    for (const width of WP2_WIDTHS) {
      const rendered = at(source, width).join("\n");
      for (const token of [url, path]) {
        if (width - 6 >= token.length) {
          // fits: it must appear whole, on one line, with nothing inserted into it
          expect(rendered).toContain(token);
        } else {
          // does not fit: `wrapAnsi` hard-splits it (never ellipsizes), and the pieces
          // must still rejoin to the original token, in order, losslessly
          expect(rendered.replace(/\n\s*/g, "")).toContain(token);
        }
      }
    }
  });

  test("fenced content inside a tight list item is byte-identical to its source", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).map((line) => line.trim());
        // the three fence lines, including the `*`/`N.` decoys and the double space
        expect(rendered).toContain("# * not a bullet, and 1. not a marker");
        expect(rendered).toContain("bun run --cwd mdview sweep");
        expect(rendered).toContain('echo "two  spaces above are not a break"');
      }
    }
  });

  test("coalescing never crosses an item or a nested-list boundary", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      const rendered = at(source, width).join("\n");
      // one item's tail never lands on the same line as the next item's head
      expect(rendered).not.toContain("at any width at all. A third item");
      expect(rendered).not.toContain("would then skip. An item authored");
      // the outer item's tail never lands on the nested item's head, or vice versa
      expect(rendered).not.toContain("reached at all. A nested item");
      expect(rendered).not.toContain("of its own too. A closing outer item");
    }
  });

  // The guard against joining across a *blank* line is what keeps this out of the loose
  // path entirely, but the loose fixture is the direct control: WP-2b closed it and this
  // WP must not move it. Its tight sections are each authored on a single source line, so
  // they carry no soft break for this pass to act on either.
  test("the loose-list fixture is untouched — no orphans, no overflow, at every width", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/loose-list.md`, "utf8");
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs);
        expect(findListOrphans(rendered, width)).toEqual([]);
        for (const line of rendered.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  // The pass is gated on being inside a list, in a block position, on a token that
  // carries inline `tokens`. Prose authored wrapped exactly like the items is the control
  // for the first condition: it is reflowed by the paragraph renderer, never by this.
  test("authored line breaks in non-list prose are not this pass's business", () => {
    const source =
      "A paragraph authored wrapped at a narrow column,\nwith a second source line,\nand a third one after that.\n";
    const whole = "A paragraph authored wrapped at a narrow column, with a second source line, and a third one after that.";
    for (const width of WP2_WIDTHS) {
      const lines = at(source, width).filter((line) => line.trim() !== "");
      // The paragraph renderer reflows it: the authored breaks are gone and the text is
      // laid out to the *full* target width, not to any list budget. It is one line at
      // every width here except 80, where the library's own wrap splits it.
      expect(lines.join(" ")).toBe(whole);
      // and it was laid out to the *full* target width, not to any list budget: the
      // authored breaks are gone, so no rendered line ends where a source line did
      expect(lines.some((line) => line.endsWith("narrow column,") || line.endsWith("source line,"))).toBe(false);
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // `- [x] ` items carry `TASK_STATE_SENTINEL` between the bracket and the state char,
  // and coalescing runs over the text that holds it. It must arrive at the strip pass
  // intact — a lost sentinel means `[X]  done` (rebuilt by the dead `checkbox` seam)
  // instead of the literal source text.
  test("task states survive coalescing in both glyph tiers", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");
    for (const width of WP2_WIDTHS) {
      expect(at(source, width, UNICODE_GLYPHS).join("\n")).toContain("✓ A completed task");
      expect(at(source, width, UNICODE_GLYPHS).join("\n")).toContain("◐ An in-progress task");
      const ascii = at(source, width, ASCII_GLYPHS).join("\n");
      expect(ascii).toContain("[x] A completed task");
      expect(ascii).toContain("[/] An in-progress task");
      // and neither sentinel ever reaches the output.
      //
      // **Colourless only** — this run has no `FORCE_COLOR`. The *character* is gone under
      // colour too, but the SGR pair a syntax highlighter wrapped around it before the strip
      // is not: measured at WP-4 of `plans/renderer-deferred-work.md` as an orphaned empty
      // colour pair inside a recorded `codeRange`. See `src/AGENTS.md`, "Colourless gates
      // cannot see colour-only defects" — the round-trip claim is true here and not in
      // general.
      expect(ascii).not.toContain(String.fromCharCode(1));
      expect(ascii).not.toContain(String.fromCharCode(0));
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2e — the nested-list continuation over-indent.
//
// A continuation line inside a *nested* item was indented past its own item's first
// line, one marker width per ancestor level, because `marked-terminal`'s
// `bulletPointLines` / `numberedLines` pad every line their `isPointedLine` does not
// recognize — which is every continuation of an inner list that already rendered, but
// none of that inner list's marker lines. See `realignEmbeddedContinuations` in
// `src/lists.ts` (the pass WP-5 moved into composition, structural on stripped bytes;
// it was `realignNestedContinuations` in `src/render.ts` until then) for the
// mechanism, and for why the fix subtracts the drift instead of snapping lines to a
// column.
//
// **It is not a cosmetic defect and it is not a second metric.** A continuation shifted
// right is a continuation over budget, so the shallower `rewrapListBody` sheared its
// tail word onto a line of its own — the same orphan WP-2/2b/2c chased, from a source
// none of them had isolated. Measured on this fixture at 80/100/116/120/172/346, both
// glyph tiers, on the parent commit: **36/25/21/19/10/3 over-indents and 8/6/4/3/1/0
// orphans**, against 0 and 0 after. The orphans go away *with* the indent, and nothing
// in the orphan path was touched to make that happen — which is the whole claim.
//
// Both detectors are `src/detectors.ts`'s, unchanged; this block passes `codeRanges`
// because fenced code is never rewritten and its shape is not ours to guarantee.
// ---------------------------------------------------------------------------

describe("renderDocument — nested-list continuation over-indent (WP-2e)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/nested-list.md`, "utf8");
  const at = (source: string, width: number, glyphs = UNICODE_GLYPHS): string[] =>
    renderDocument(source, width, glyphs).split("\n").map(stripAnsi);

  test("no continuation of the nested-list fixture is indented past its own item, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        expect(findContinuationOverIndent(text, { codeRanges })).toEqual([]);
      }
    }
  });

  // The causal claim, on the same fixture and in the same shape as WP-2b's and WP-2c's
  // assertions: fixing the indent is what removes these, not a separate wrap change.
  test("the nested-list fixture emits no orphaned lines, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        expect(findListOrphans(text, width, { codeRanges })).toEqual([]);
      }
    }
  });

  // **Code ranges are exempt here, and were not before WP-2f — this assertion used to
  // pass for the wrong reason.** The tool's guarantee is "no *non-code* line exceeds the
  // width" (`src/AGENTS.md`, rendering policy; `--check` and both sweeps skip code ranges).
  // Until WP-2f this fixture's fenced content happened to fit anyway, because
  // `rewrapListBody` was splitting it — the very invariant violation WP-2f closed. With
  // the fence left alone, its longest content line is 81 columns at width 80, exempt.
  test("no line of the nested-list fixture exceeds the target width, outside its fences", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of text.split("\n").entries()) {
          if (codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
          expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  // A count going to zero proves nothing if the fixture stopped containing the case, so
  // the words this defect used to shear are named individually, as WP-2c does. **Not**
  // "reunited with the word that followed them", which is WP-2c's form and is wrong here:
  // this fix moves the whole item two to four columns left, so the item reflows and the
  // neighbour a word lands beside legitimately changes. What must hold is that none of
  // them is stranded on a line of its own any more, and that none of them went missing.
  // Every entry below was alone on a line on the parent commit, at that width.
  test("the words the defect used to shear are no longer alone on a line", async () => {
    const source = await fixture();
    for (const [width, sheared] of [
      [80, ["once", "drifted", "more", "pass", "lines", "multiple", "bullet"]],
      [100, ["to.", "that", "full", "them", "against"]],
      [116, ["as", "one", "bullet"]],
      [120, ["from", "columns"]],
      [172, ["and"]],
    ] as const) {
      const lines = at(source, width);
      for (const word of sheared) {
        expect(`w${width} "${word}" alone: ${lines.some((line) => line.trim() === word)}`).toBe(
          `w${width} "${word}" alone: false`,
        );
        expect(`w${width} "${word}" present: ${lines.some((line) => line.includes(word))}`).toBe(
          `w${width} "${word}" present: true`,
        );
      }
    }
  });

  // The columns themselves, at the widths these fixtures wrap at, read straight off the
  // output rather than through a detector — the pass and `findContinuationOverIndent`
  // now share a stack model, so one flat reading of the rendered text is the independent
  // check on both.
  test("each nested item's continuations sit at exactly its own marker's text column", async () => {
    const source = await fixture();
    for (const width of WP2_WRAPPING_WIDTHS) {
      const { text, codeRanges } = renderDocumentDetailed(source, width);
      const lines = text.split("\n").map(stripAnsi);
      const inFence = (index: number): boolean =>
        codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
      let expected: number | null = null;
      let sawNested = false;
      for (const [index, line] of lines.entries()) {
        if (line.trim() === "") continue;
        // fenced content keeps whatever indent the library gave it — never rewritten
        if (inFence(index)) continue;
        const marker = /^(\s{2,}(?:[•◦‣]|\d+\.)\s+)/.exec(line);
        if (marker) {
          const prefix = marker[1] as string;
          expected = prefix.length;
          if (prefix.length - prefix.trimStart().length > 4) sawNested = true;
          continue;
        }
        if (!isIndentedLine(line) || expected === null) {
          expected = null;
          continue;
        }
        expect(`${line.trim().slice(0, 24)} @ ${line.length - line.trimStart().length}`).toBe(
          `${line.trim().slice(0, 24)} @ ${expected}`,
        );
      }
      expect(sawNested).toBe(true);
    }
  });

  // The landmine this pass walks past on every line it looks at: `substituteBullets`
  // honours `SENTINEL`, `rewrapListBody` does not (WP-2f), and adding a second offender
  // would have been invisible to every gate `bun run verify` runs, since code ranges are
  // exempt from width checking. The decoys are the two marker shapes on the fence's
  // first line.
  test("a fence nested inside a nested list item keeps its own content", async () => {
    const source = await fixture();
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).map((line) => line.trim());
        expect(rendered).toContain("# * not a bullet, and 1. not a marker");
        expect(rendered).toContain("bun run --cwd mdview sweep");
        // WP-2f: `rewrapListBody` split this line in two on the parent commit at width
        // 80 — the same fixture, the same fence, a different pass. It is 81 columns and
        // now overflows instead, which is what fenced code does everywhere else.
        expect(rendered).toContain('echo "these four leading spaces are content, not indentation"');
      }
    }
  });

  // **The reason the pass subtracts a drift instead of snapping to a column.** A
  // blockquote inside a list item is indented past its item's text column by its own
  // renderer, legitimately, and `findContinuationOverIndent` reports it all the same.
  // Snapping every reported line to `item.textColumn` would flatten the quote into the
  // prose around it; subtracting only what the list level added preserves the offset —
  // at every depth, which is what the second assertion is for.
  test("a blockquote inside a list item keeps its own indent relative to that item", () => {
    const source = [
      "- An outer item long enough to wrap at every width under test, so that its own continuation lines exist and can be told apart from the quoted block that follows them.",
      "",
      "  > A quoted block inside that item, also long enough to wrap, whose lines belong four columns to the right of the item's own text and must stay there.",
      "",
      "  - A nested item long enough to wrap at every width under test, carrying a quote of its own so the same offset is checked one level down as well.",
      "",
      "    > A quoted block inside the nested item, long enough to wrap, four columns right of that item's text column and not of its parent's.",
      "",
    ].join("\n");

    for (const width of WP2_WRAPPING_WIDTHS) {
      const lines = at(source, width);
      const columnOf = (needle: string): number => {
        const line = lines.find((candidate) => candidate.includes(needle));
        expect(line === undefined ? `${needle}: missing` : `${needle}: present`).toBe(`${needle}: present`);
        return (line as string).length - (line as string).trimStart().length;
      };
      // outer item's text column is 6 (4 of indent + 2 of bullet); its quote sits at 10
      expect(columnOf("A quoted block inside that item")).toBe(10);
      // nested item's text column is 10; its quote sits at 14, not at the outer quote's 10
      expect(columnOf("A quoted block inside the nested item")).toBe(14);
    }
  });

  // Nothing is ever ellipsized, and a token too long for its own budget is hard-split and
  // rejoins losslessly — including inside a nested item, where this pass changes the
  // column the split happens at and therefore where in the token it happens.
  test("a long token inside a nested item is hard-split losslessly, never ellipsized", async () => {
    const source = await fixture();
    const token =
      "https://example.invalid/a/second/deliberately/long/url/inside/a/nested/list/item/which/must/also/survive/verbatim/ok";
    for (const [, glyphs] of WP2_TIERS) {
      for (const width of WP2_WIDTHS) {
        const rendered = at(source, width, glyphs).join("\n");
        expect(rendered).not.toContain("…");
        expect(rendered.replace(/\n\s*/g, "")).toContain(token);
      }
    }
  });

  // WP-2b's and WP-2c's fixtures are the direct control for this change: it is the first
  // one to rewrite an already-composed list body rather than to decide where text wraps,
  // so it is the first that could move them without touching either wrapping override.
  test("the loose-list and tight-list fixtures are untouched — no orphans, no over-indents, no overflow", async () => {
    for (const name of ["loose-list", "tight-list"]) {
      const source = await readFile(`${import.meta.dir}/fixtures/${name}.md`, "utf8");
      for (const [, glyphs] of WP2_TIERS) {
        for (const width of WP2_WIDTHS) {
          const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
          expect(`${name}: ${findListOrphans(text, width).join(",")}`).toBe(`${name}: `);
          expect(findContinuationOverIndent(text, { codeRanges })).toEqual([]);
          for (const line of text.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2f — fenced code inside a list item, and the marker-shaped continuation.
//
// **Both invariants here are invisible to every gate `bun run verify` runs, for the same
// structural reason.** `--check` and both sweeps exempt recorded `codeRanges` from width
// checking, so a pass that *corrupts* a line inside one cannot make a width gate fail — and a
// continuation line that starts `*` is under the width by definition. `rewrapListBody`
// shipped from WP-2 with neither the `SENTINEL` walk `substituteBullets` and
// the de-drift pass (now `realignEmbeddedContinuations`, `src/lists.ts`) both have,
// nor the `MARKER_SHAPED_LINE` guard both wrapping overrides have.
//
// Measured on the parent commit over a 1,000-file corpus sample of fence-carrying files
// at 80 and 116: **154 of 37,246 fenced source lines did not survive verbatim; 0 after**
// (the 19 that remain either side are the same lines, and are the metric's own fence
// parity disagreeing with marked's lexer on nested fences — not a rendering change).
// This fixture is the public-safe frozen version of that case.
//
// The one assertion deliberately **not** made here is the orphan count: the fixture puts
// short prose lines immediately in front of fences on purpose, and a text token's natural
// short last line before a fence is a block boundary, not a shear — one of the two
// documented blind spots in `findListOrphans`. `loose-list`, `tight-list` and
// `nested-list` remain the orphan gates; this fixture is the fence-integrity gate.
// ---------------------------------------------------------------------------

describe("renderDocument — fenced code inside list items (WP-2f)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/fenced-list.md`, "utf8");

  // 54/55 and 101 are the other widths at which the marker guard fires on this fixture;
  // 100 is already in `WP2_WIDTHS`. Named rather than swept so a change that moves the
  // break points shows up as a failure here instead of silently rendering the case inert.
  const WP2F_WIDTHS = [...WP2_WIDTHS, 54, 55, 101];

  /** Every non-blank content line of every fenced block in the fixture's source. */
  const fencedSourceLines = (source: string): string[] => {
    const out: string[] = [];
    let open = false;
    for (const line of source.split("\n")) {
      if (/^\s*```/.test(line)) {
        open = !open;
        continue;
      }
      if (open && line.trim() !== "") out.push(line.trim());
    }
    return out;
  };

  test("the fixture actually contains the case — fences in loose, tight and nested items", async () => {
    const lines = fencedSourceLines(await fixture());
    expect(lines.length).toBe(5);
    // the one-line block: its opening and closing markers land on the same physical
    // rendered line, so it never *starts* inside a fence — the case that decides how
    // strict the sentinel walk has to be.
    expect(lines.some((line) => line.startsWith("printf"))).toBe(true);
    // the decoys: fence content that both marker-shaped passes would otherwise claim
    expect(lines.some((line) => line.startsWith("* not a bullet, and 1. not a marker"))).toBe(true);
  });

  test("every fenced source line survives verbatim, on one rendered line, at every width and both tiers", async () => {
    const source = await fixture();
    const fenced = fencedSourceLines(source);
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line).trim());
        for (const line of fenced) {
          expect(`${tier} w${width}: ${rendered.includes(line)}`).toBe(`${tier} w${width}: true`);
        }
      }
    }
  });

  // The decision this WP had to make and record: an over-budget fence line inside a list
  // item **overflows**, exactly as fenced code does everywhere else. That is only
  // self-consistent if the resulting long lines are actually exempt — so this asserts the
  // exemption rather than assuming it. A failure here means the tool is now emitting
  // overflow that `--check` and the sweep would have to be widened to tolerate, which is
  // the one outcome this WP is not allowed to produce.
  test("every over-width line lands inside a recorded code range, and nothing else exceeds the width", async () => {
    const source = await fixture();
    let sawOverflow = false;
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        const inFence = (index: number): boolean =>
          codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
        for (const [index, line] of text.split("\n").entries()) {
          if (stringWidth(stripAnsi(line)) <= width) continue;
          sawOverflow = true;
          expect(`${tier} w${width} line ${index + 1} exempt: ${inFence(index)}`).toBe(
            `${tier} w${width} line ${index + 1} exempt: true`,
          );
        }
      }
    }
    // the fixture is only evidence if some line really does overflow
    expect(sawOverflow).toBe(true);
  });

  // The marker-shaped-continuation case, demonstrated rather than asserted in the
  // abstract. This pass breaks the last item's line so that a continuation begins with
  // the author's bare `*`, and `substituteBullets` — which runs after it, over the same
  // body — used to match a leading `*` at *any* indent and rewrote it into the depth's
  // bullet glyph. Measured over every width in 40-360, both tiers: **the parent commit
  // corrupts it at 54, 55, 100 and 101; this one at none of them.**
  //
  // In an ordered list `numberedLine` is the second consumer of the same shape, so the
  // numbers are checked too. Widths 54/55/101 are named in `WP2F_WIDTHS` for exactly
  // this reason — the case is inert at most widths and 100 is the only one of the four
  // that the standard set covers.
  test("a continuation line never starts with the author's own `*`, and no list is renumbered", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2F_WIDTHS) {
        const lines = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line));
        const rendered = lines.join("\n");
        // the author's glob survives as a glob — measured across the soft wrap, since at
        // some widths the break falls between the `*` and the word after it
        const flowed = rendered.replace(/\s+/g, " ");
        expect(`${tier} w${width}: ${flowed.includes("* zero or more")}`).toBe(`${tier} w${width}: true`);
        for (const bullet of [...UNICODE_GLYPHS.bullets, ...ASCII_GLYPHS.bullets]) {
          expect(`${tier} w${width}: ${rendered.includes(`${bullet} zero or more`)}`).toBe(`${tier} w${width}: false`);
        }
        // and no line *inside a list body* is claimable by `isPointedLine`: a non-zero
        // exact multiple of four spaces, then a literal marker. Fence lines keep whatever
        // the library gave them and are not this pass's to shape; a column-zero paragraph
        // is not in a list body at all, and the library never scans it.
        const { codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of lines.entries()) {
          if (codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
          if (!/^(?: {4})+\*/.test(line)) continue;
          expect(`${tier} w${width} line ${index + 1}: ${line.trim().slice(0, 32)}`).toBe(
            `${tier} w${width} line ${index + 1}: <no marker-shaped continuation>`,
          );
        }
        // both ordered lists keep their own numbering: two items, then three. A
        // renumbering would show up as an extra number in this sequence, which is what
        // happens when `numberedLine` claims a line that only *looks* like a marker.
        const numbers = lines
          .filter((line, index) => !codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end))
          .map((line) => /^ {4,}(\d+)\.\s/.exec(line))
          .filter((match): match is RegExpExecArray => match !== null)
          .map((match) => Number(match[1]));
        expect(`${tier} w${width}: ${numbers.join(",")}`).toBe(`${tier} w${width}: 1,2,1,2,3`);
      }
    }
  });

  // Nothing is ever ellipsized, and the fence's content is not merely present but
  // uncut: the longest command in the fixture is 106 columns and must appear whole even
  // at width 40, where every other line has been wrapped four times over.
  test("the longest fenced command is never split or ellipsized, at any width in 40-360", async () => {
    const source = await fixture();
    const command =
      'echo "a deliberately very long command line that must never be rewrapped or reindented at all, at any width"';
    for (let width = 40; width <= 360; width += 20) {
      const rendered = renderDocument(source, width);
      expect(`w${width}: ${rendered.includes("…")}`).toBe(`w${width}: false`);
      expect(`w${width}: ${rendered.split("\n").some((line) => stripAnsi(line).trim() === command)}`).toBe(
        `w${width}: true`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// WP-2g — lists inside blockquotes, and the indent-destroying re-wrap.
//
// **The gate is a new invariant, because neither existing detector can see this class.**
// `findListOrphans` and `findContinuationOverIndent` both require `isIndentedLine`, so a
// line that collapsed to column 0 is skipped by each of them — no number either of them
// produces is evidence here, in either direction. `findColumnZeroMarkers` is WP-2g's own
// instrument and goes to zero on this fixture.
//
// Two independent mechanisms, and the severe one was ours: `wrapOverBudgetLines` re-wrapped
// any over-budget line with `wrapAnsi(line, targetWidth)`, which starts each emitted line
// at a *word* and so discards the line's leading indent even when the line does not have
// to be split at all — and the `blockquote` caller is the one whose lines are all
// indented. The milder one is the library's: `indentify(this.tab, quote.trim())`
// (`index.js:106`) costs the body's first line its own indent, leaving a quoted list's
// first marker four columns left of its siblings at any width where nothing wraps.
//
// Measured over the 95 corpus files that put a list inside a blockquote, at widths
// 40/80/116/346: **column-0 markers 471 -> 4** (the residual 4 are one authored numbered
// paragraph in one file, present identically on the parent), and on the tier-pure
// sub-count of substituted bullet glyphs, **406 -> 0**.
// ---------------------------------------------------------------------------

describe("renderDocument — lists inside blockquotes (WP-2g)", () => {
  const fixture = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/blockquote-list.md`, "utf8");

  // 40 is the narrowest realistic tiled pane and the width at which this fixture's quoted
  // items wrap hardest; 55 is where the WP-2f marker guard fires on its sibling fixture.
  const WP2G_WIDTHS = [40, 55, ...WP2_WIDTHS];

  test("the fixture actually contains every direction of the case", async () => {
    const source = await fixture();
    // a list inside a blockquote, unordered and ordered, plus a nested level
    expect(/^> - /m.test(source)).toBe(true);
    expect(/^> 1\. /m.test(source)).toBe(true);
    expect(/^>\s+- /m.test(source)).toBe(true);
    // a blockquote inside a blockquote, and a blockquote inside a *list item*
    expect(/^> > - /m.test(source)).toBe(true);
    expect(/^ {2}> /m.test(source)).toBe(true);
    // fenced code inside a blockquote, including the one-line shape
    expect(/^> ```/m.test(source)).toBe(true);
  });

  test("no rendered list marker sits at column 0, at every width and both tiers", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (let width = 40; width <= 360; width += 1) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        const found = findColumnZeroMarkers(text, { codeRanges });
        expect(`${tier} w${width}: ${found.map((hit) => `${hit.line}:${hit.text.slice(0, 24)}`).join(" | ")}`).toBe(
          `${tier} w${width}: `,
        );
      }
    }
  });

  // The stronger form of the same invariant, and the one that cannot be argued with: a
  // bullet *glyph* is written only by `substituteBullets`, which matches its marker on the
  // four-column grid, so one at column 0 can only have got there by a later pass moving
  // the line left. No adjacency heuristic, no authored-prose ambiguity.
  test("no substituted bullet glyph ever appears at column 0", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (let width = 40; width <= 360; width += 1) {
        const offenders = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line))
          .filter((line) => [...UNICODE_GLYPHS.bullets, ...ASCII_GLYPHS.bullets].some((b) => line.startsWith(`${b} `)));
        expect(`${tier} w${width}: ${offenders.join(" | ")}`).toBe(`${tier} w${width}: `);
      }
    }
  });

  // The library's `quote.trim()`, and the *only* symptom it has on its own: at a width
  // where nothing wraps, a quoted list's first item is four columns left of its siblings.
  // Asserted as "every marker of one list is at one column" rather than as a literal
  // column, so it stays true if the blockquote's own indent ever changes.
  test("a quoted list's items are siblings at one column, at a width where nothing wraps", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      const lines = renderDocument(source, 400, glyphs)
        .split("\n")
        .map((line) => stripAnsi(line));
      const start = lines.findIndex((line) => line.includes("A list item inside a blockquote"));
      const second = lines.findIndex((line) => line.includes("A second item, also long enough"));
      expect(`${tier}: ${start >= 0 && second >= 0}`).toBe(`${tier}: true`);
      const columnOf = (line: string): number => line.length - line.trimStart().length;
      expect(`${tier}: ${columnOf(lines[start] as string)}`).toBe(`${tier}: ${columnOf(lines[second] as string)}`);
      // and it is the blockquote's indent on top of the list's, not either one alone
      expect(`${tier}: ${columnOf(lines[start] as string)}`).toBe(`${tier}: 8`);
    }
  });

  // A blockquote *inside* a list item is legitimately indented past its item's text
  // column by its own renderer — WP-2e's non-negotiable, restated here because this WP
  // touches the other side of the same relationship. The quote must be deeper than the
  // item's text column, and the item's own trailing prose must come back to it.
  test("a blockquote inside a list item stays legitimately deeper, and its item's prose returns", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const lines = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line));
        const columnOf = (needle: string): number => {
          const line = lines.find((candidate) => candidate.includes(needle));
          return line === undefined ? -1 : line.length - line.trimStart().length;
        };
        const item = columnOf("A list item that");
        const quoted = columnOf("Quoted prose inside");
        const trailing = columnOf("Trailing prose belonging");
        // the marker line's *text* column is the marker column plus the marker's width
        expect(`${tier} w${width}: ${quoted > item && trailing > item && quoted > trailing}`).toBe(
          `${tier} w${width}: true`,
        );
      }
    }
  });

  // `wrapOverBudgetLines` had no `SENTINEL` walk either, and a fence inside a blockquote
  // reaches it already bracketed. Both fence shapes are in the fixture, including the
  // one-line block whose whole content sits on a line that both opens and closes the
  // pair — the shape that forces the stricter of the two walks in this file.
  test("every fenced source line inside a blockquote survives verbatim on one line", async () => {
    const source = await fixture();
    const fenced: string[] = [];
    let open = false;
    for (const raw of source.split("\n")) {
      const line = raw.replace(/^(\s*>)+\s?/, "");
      if (/^\s*```/.test(line)) {
        open = !open;
        continue;
      }
      if (open && line.trim() !== "") fenced.push(line.trim());
    }
    expect(fenced.length).toBe(3);
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const rendered = renderDocument(source, width, glyphs)
          .split("\n")
          .map((line) => stripAnsi(line).trim());
        for (const line of fenced) {
          expect(`${tier} w${width}: ${rendered.includes(line)}`).toBe(`${tier} w${width}: true`);
        }
      }
    }
  });

  // Same decision as WP-2f, one seam over: an over-budget fence line inside a blockquote
  // overflows rather than wrapping, and that is only self-consistent because it stays
  // inside a recorded range. Asserted, not assumed.
  test("every over-width line lands inside a recorded code range", async () => {
    const source = await fixture();
    let sawOverflow = false;
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of text.split("\n").entries()) {
          if (stringWidth(stripAnsi(line)) <= width) continue;
          sawOverflow = true;
          const exempt = codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end);
          expect(`${tier} w${width} line ${index + 1} exempt: ${exempt}`).toBe(
            `${tier} w${width} line ${index + 1} exempt: true`,
          );
        }
      }
    }
    expect(sawOverflow).toBe(true);
  });

  // Quoted content is wrapped at the quote's own budget, not at the full width — the
  // `paragraph` override's gate had to move from "are we in a list" to "does anything
  // still owe columns" once the safety net stopped hiding the overflow by deleting the
  // indent. Without that, every wrapped line of quoted prose is 4 columns over and the
  // net shears a word off each of them.
  test("no continuation inside a blockquote is indented past its own item, and none is orphaned", async () => {
    const source = await fixture();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of WP2G_WIDTHS) {
        const lines = renderDocument(source, width, glyphs).split("\n");
        // Scoped to the fixture's *quoted-list* half, which ends at "The other
        // direction": everything after it is the legitimately-deeper cases (a quote
        // inside a list item) and the fences, and `findContinuationOverIndent` reports
        // the legitimate class identically to the defect — it is not a to-do list.
        // That half carries no fence, so no code ranges are in play.
        const cut = lines.findIndex((line) => stripAnsi(line).includes("The other direction"));
        expect(`${tier} w${width}: ${cut > 0}`).toBe(`${tier} w${width}: true`);
        const over = findContinuationOverIndent(lines.slice(0, cut).join("\n"));
        expect(`${tier} w${width}: ${over.map((hit) => hit.text.slice(0, 30)).join(" | ")}`).toBe(`${tier} w${width}: `);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WP-1 of `plans/renderer-deferred-work.md` — the coalesced-path guard collision.
//
// Read this before touching the guard in `src/render.ts`'s `text` override. The
// defect it grades was **silent content corruption that no gate in this repo could
// see**: the rendered output contained a nested list item nobody wrote, the line was
// under the target width so `--check` and both sweeps were blind to it, and
// `findContinuationOverIndent`'s drift-1 exemption forgave it because the artifact
// the corruption produced is itself guard-shaped. Only a per-width assertion on a
// committed witness can catch it, which is what this group is.
//
// **The widths are named here on purpose.** `WP2F_WIDTHS` is
// `[80,100,116,120,172,346,54,55,101]` and never executes at 64, 65 or 66, so the
// fixture alone would leave the regression untested. The case is inert at every width
// but two per shape.
// ---------------------------------------------------------------------------

describe("renderDocument — the coalesced-path guard collision (WP-1, renderer-deferred-work)", () => {
  const witness = (): Promise<string> => readFile(`${import.meta.dir}/fixtures/coalesced-guard-collision.md`, "utf8");

  // The two widths the parent commit corrupted, and the clean widths on either side of
  // each. 65: the one-digit ordered item at text column 7, whose single guard space
  // landed it at 8, on the four-column grid. 69: the same item inside a blockquote,
  // four columns further right, at 11 → 12.
  const CORRUPTED_WIDTHS = [65, 69];
  const NEIGHBOUR_WIDTHS = [64, 66, 68, 70];

  test("the author's literal `*` survives at the corrupted widths and their neighbours, both tiers", async () => {
    const source = await witness();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of [...NEIGHBOUR_WIDTHS, ...CORRUPTED_WIDTHS]) {
        // measured across the soft wrap: at some widths the break falls between the
        // `*` and the word after it, so the check has to be on flowed text
        const flowed = stripAnsi(renderDocument(source, width, glyphs)).replace(/\s+/g, " ");
        const survivors = (flowed.match(/\* star token/g) ?? []).length;
        // one per list in the fixture: ordered, quoted ordered, unordered, ten-item
        expect(`${tier} w${width}: ${survivors}`).toBe(`${tier} w${width}: 4`);
      }
    }
  });

  test("the corruption witness is gone: no bullet glyph ever replaces that `*`", async () => {
    const source = await witness();
    for (const [tier, glyphs] of WP2_TIERS) {
      // the whole 40-200 band, not just the named widths — the defect was found by
      // sweeping widths, and a repair that only moves it to width 73 is not a repair
      for (let width = 40; width <= 200; width += 1) {
        const rendered = stripAnsi(renderDocument(source, width, glyphs));
        for (const bullet of [...UNICODE_GLYPHS.bullets, ...ASCII_GLYPHS.bullets]) {
          expect(`${tier} w${width}: ${rendered.includes(`${bullet} star token`)}`).toBe(`${tier} w${width}: false`);
        }
      }
    }
  });

  test("no continuation of this fixture is claimable by `isPointedLine` on the grid", async () => {
    const source = await witness();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of [...NEIGHBOUR_WIDTHS, ...CORRUPTED_WIDTHS, 54, 55, 80, 100, 101]) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        for (const [index, line] of text.split("\n").map((l) => stripAnsi(l)).entries()) {
          if (codeRanges.some(([start, end]) => index + 1 >= start && index + 1 <= end)) continue;
          if (!/^(?: {4})+(?:\*|\d+\.)/.test(line)) continue;
          // a genuine marker line is fine; a *continuation* claimed by the shape is not,
          // and the two are told apart by whether the fixture authored a marker there
          if (/^(?: {4})+(?:\*|\d+\.) (?:one|two|three|four|five|six|seven|eight|nine|short lead)\b/.test(line)) continue;
          expect(`${tier} w${width} line ${index + 1}: ${line.trim().slice(0, 32)}`).toBe(
            `${tier} w${width} line ${index + 1}: <no marker-shaped continuation>`,
          );
        }
      }
    }
  });

  // The three detector counts are class D's ratchet, and the guard is exactly the kind
  // of change that can move them: a wider guard would show up here as over-indent drift
  // the drift-1 exemption does not forgive. Measured over 40-200 at both tiers against
  // the parent commit: identical at every axis.
  test("the three detector counts stay at zero across the whole width band, both tiers", async () => {
    const source = await witness();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (let width = 40; width <= 200; width += 1) {
        const rendered = renderDocument(source, width, glyphs);
        const counts = [
          findListOrphans(rendered, width).length,
          findContinuationOverIndent(rendered).length,
          findColumnZeroMarkers(rendered).length,
        ];
        expect(`${tier} w${width}: ${counts.join(",")}`).toBe(`${tier} w${width}: 0,0,0`);
      }
    }
  });

  // The other half of the rule, pinned so nobody "simplifies" the guard back to a flat
  // one space or widens it to a flat two. `"* "` puts an item's text at column 6 and
  // `"12. "` at column 8; one guard space lands at 7 and 9, both off the grid, and both
  // of those are byte-identical to the parent commit. Only the one-digit ordered marker
  // (`"1. "`, column 7 → 8) needs two.
  test("the single-space guard is unchanged where it already missed the grid", async () => {
    // an unordered tight item whose source spans two authored lines, so it coalesces
    const unordered = "* lead line here\n  and a second authored line * star token and more words to push it over the edge";
    for (let width = 40; width <= 200; width += 1) {
      const lines = stripAnsi(renderDocument(unordered, width)).split("\n");
      for (const line of lines) {
        // the guarded continuation, when it appears, sits at column 7 — never 4 or 8
        if (!line.includes("star token")) continue;
        const indent = line.length - line.trimStart().length;
        expect(`w${width}: ${indent % 4 === 0 && /^\s*\*/.test(line)}`).toBe(`w${width}: false`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// WP-5 of `plans/renderer-deferred-work.md` — the coalesced colon-guard continuation
// drift, pinned as a witness rather than repaired.
//
// A cosmetic defect, recorded (not fixed) by `plans/marked-terminal-replacement.md`'s
// WP-6 deferred-finding note under the name "the punctuation-leading continuation
// wrap": a coalesced tight item's continuation can begin one column right of the
// item's own text column, the first visible character a piece of punctuation that
// cannot start a word. **This group pins the current (defective) output; it does not
// fix it.** No sound repair is specified — see `src/AGENTS.md`, "The two paths guard
// differently" — so the day someone does fix it, this test fails loudly and names the
// fixture that needs re-measuring.
//
// **The verified mechanism differs from the one `plans/marked-terminal-replacement.md`
// recorded, and `src/AGENTS.md` carries the correction.** In short: a colon inside a
// code span becomes the 9-byte `COLON_REPLACER` sentinel before the *coalesced*
// tight-item wrap ever sees it (`undoColon` does not run until `composeItem`, after
// that wrap); the sentinel's literal leading `*` matches `MARKER_SHAPED_LINE`, firing
// the same marker-shaped-continuation guard `src/AGENTS.md`'s "third condition"
// paragraph already documents as deliberate and correct for exactly this shape; and
// the one guard space that adds survives `undoColon`'s later decode of the sentinel
// back to `:`, one column wider than an unguarded continuation of the same item.
describe("renderDocument — the coalesced colon-guard continuation drift (WP-5, renderer-deferred-work)", () => {
  const witness = (): Promise<string> =>
    readFile(`${import.meta.dir}/fixtures/coalesced-colon-guard-continuation.md`, "utf8");

  // Four widths spanning the range this reproduces at, in both tiers — the tier is
  // irrelevant to this mechanism (the guard fires before `substituteBullets` ever
  // reads the tier), and both are asserted so a tier-specific "fix" cannot go unseen.
  test("the escaped-colon continuation sits one column right of its item's other continuations", async () => {
    const source = await witness();
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of [50, 60, 90, 101]) {
        const rendered = renderDocument(source, width, glyphs);
        const drift1 = findContinuationOverIndent(rendered).filter((hit) => hit.drift === 1);
        expect(`${tier} w${width}: ${drift1.map((hit) => hit.text.slice(0, 7)).join(",")}`).toBe(
          `${tier} w${width}: :11-17.`,
        );
      }
    }
  });

  test("width 60 renders the exact pinned shape — a colon-led continuation at column 7, its siblings at 6", async () => {
    const source = await witness();
    const lines = stripAnsi(renderDocument(source, 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual([
      "    • Do not edit findListOrphans' body",
      "      (src/detectors.ts:139) — frozen by",
      "       :11-17. Do not edit classifyListOrphans",
      "      either; it is WP-8's and its counts must stay",
      "      comparable. Use the detectors, don't tune them.",
    ]);
  });
});

// ---------------------------------------------------------------------------
// WP-3 of `plans/colour-policy.md` — layout is escape-blind, and these are the
// artifacts that proved it was not.
//
// **Read the direction of this group before changing an assertion in it.** The
// colour-off render is the frozen baseline (cycle-3 f6); every assertion here says the
// *stripped colour-on* render equals it. None of them may be satisfied by moving the
// colourless side — that is the one thing this package was prohibited from doing.
//
// Three defects, all the same mechanism — a layout decision made on bytes instead of on
// columns — and each with its own witness line at width 80 in `tight-list.md`:
//
// 1. `fixNestedLists`' `\S` matched an SGR reset's `m`, splitting a line at the escape
//    and leaving `"    ESC[0m"` behind (measured on `nested-list.md`: 7 such lines).
// 2. the empty-line filter compared raw bytes, so an encased blank line survived it.
// 3. an escape-only run became a zero-width word in `wrapAnsi`, consuming the pending
//    space and leaving it trailing; and the hard-break seam asked `HARD_BREAK_TAIL` of
//    raw bytes, so a styled `<br />` stopped ending a line.
// ---------------------------------------------------------------------------

describe("colour cannot move a character — the three WP-3 repairs, at width 80", () => {
  const FORCED: ColourPolicy = { sgr: "full", hyperlinks: false, tmux: false };
  const OFF: ColourPolicy = { sgr: "none", hyperlinks: false, tmux: false };

  const render = (source: string, width: number, glyphs: GlyphSet, policy: ColourPolicy): string =>
    renderDocument(source, width, glyphs, NARROW_MEASURE, false, resolveFenceLanguage, policy);

  const tightList = async (): Promise<string> =>
    await readFile(`${import.meta.dir}/fixtures/tight-list.md`, "utf8");

  test("the <br /> merge is gone: the author's break still ends the line", async () => {
    const source = await tightList();
    const lines = stripAnsi(render(source, 80, UNICODE_GLYPHS, FORCED)).split("\n");
    expect(lines).toContain("    • A break tag ends this line.<br />");
    expect(lines).toContain("      And this text follows the tag, again authored wrapped, so the tag is the");
    expect(
      lines.some((line) => line.includes("<br /> And this text follows")),
    ).toBe(false);
  });

  test("the 'recorded at' trailing space is gone — the escape-only word is not a word", async () => {
    const source = await tightList();
    const lines = stripAnsi(render(source, 80, UNICODE_GLYPHS, FORCED)).split("\n");
    expect(lines).toContain("    • The reference for this behaviour is recorded at");
    expect(lines.some((line) => line.endsWith("recorded at "))).toBe(false);
    // Nothing anywhere in the forced render ends in a space that the colourless render
    // does not also end in — the general form of the same defect.
    const off = stripAnsi(render(source, 80, UNICODE_GLYPHS, OFF)).split("\n");
    expect(lines.map((line) => line.replace(/ +$/, ""))).toEqual(lines);
    expect(off.map((line) => line.replace(/ +$/, ""))).toEqual(off);
  });

  test("the escape-only blank lines are gone: no line is whitespace-plus-escapes", async () => {
    for (const fixture of ["tight-list.md", "nested-list.md"]) {
      const source = await readFile(`${import.meta.dir}/fixtures/${fixture}`, "utf8");
      const rendered = render(source, 80, UNICODE_GLYPHS, FORCED);
      for (const line of rendered.split("\n")) {
        // A line that is *only* sequences and whitespace is one the colourless render
        // does not have at all — the shape repairs 1 and 2 jointly produced.
        if (stripAnsi(line).trim() === "") expect(line).toBe(stripAnsi(line));
      }
    }
  });

  test("stripped colour-on equals colour-off, line for line, on both tiers", async () => {
    for (const fixture of ["tight-list.md", "nested-list.md", "fenced-list.md", "loose-list.md"]) {
      const source = await readFile(`${import.meta.dir}/fixtures/${fixture}`, "utf8");
      for (const [tier, glyphs] of WP2_TIERS) {
        for (const width of WP2_WIDTHS) {
          expect(`${fixture} ${tier} w${width}: ${stripAnsi(render(source, width, glyphs, FORCED))}`).toBe(
            `${fixture} ${tier} w${width}: ${render(source, width, glyphs, OFF)}`,
          );
        }
      }
    }
  });

  test("the bullet glyph is substituted under colour too", async () => {
    // `substituteBullets` matched an anchored raw-byte regex, so an encased marker line
    // kept the composer's literal `*` under colour — visible only once repair 1 stopped
    // splitting those lines at the escape.
    const source = await readFile(`${import.meta.dir}/fixtures/nested-list.md`, "utf8");
    const lines = stripAnsi(render(source, 80, UNICODE_GLYPHS, FORCED)).split("\n");
    expect(lines.some((line) => line.trimStart().startsWith("‣ "))).toBe(true);
    expect(lines.some((line) => /^ +\* /.test(line))).toBe(false);
  });
});
