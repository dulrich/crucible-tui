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
import { findListOrphans } from "../src/detectors";
import { LIST_BULLET, isIndentedLine, stripAnsi } from "../src/list-lines";
import { renderDocument } from "../src/render";

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
