import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
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
import { stripAnsi } from "../src/list-lines";
import { renderDocument, renderDocumentDetailed } from "../src/render";
import { NARROW_MEASURE } from "../src/width";

// **116, 172 and 346 are the user's three real terminal widths** (the three tiled
// layouts); 116 and 346 were added in WP-2c, which found the orphan defect had until
// then been measured only at 80/100/120/172 — one real width out of four. 80/100/120
// stay: they are the WP-2b baseline and 80 is the narrowest case the wrap has to
// survive.
const WP2_WIDTHS = [80, 100, 116, 120, 172, 346];

const WP2_TIERS = [
  ["unicode", UNICODE_GLYPHS],
  ["ascii", ASCII_GLYPHS],
] as const;

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
