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
import { isIndentedLine, stripAnsi } from "../src/list-lines";
import { renderDocument, renderDocumentDetailed } from "../src/render";

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
