import { describe, expect, test } from "bun:test";
import {
  classifyListOrphans,
  findColumnZeroMarkers,
  findContinuationOverIndent,
  findListOrphans,
  findShearOrphans,
  probeBlockEnds,
  readBlockEnds,
  isTableLine,
  type BlockEnds,
  type ClassifiedOrphan,
} from "../src/detectors";
import { stripAnsi } from "../src/list-lines";
import { renderDocumentDetailed } from "../src/render";
import { parseWidths } from "../scripts/sweep";

// ---------------------------------------------------------------------------
// These detectors exist because **no width assertion can see the defects they
// measure**: an orphaned line and an over-indented continuation are both *under*
// the target width, so `--check` and both corpus sweeps are blind to them by
// construction. That is how a rendering defect survived ~44.5k-file sweeps across
// three work packages.
//
// `findListOrphans` additionally carries history: it is the metric every number
// WP-2, WP-2b and WP-2c recorded was measured with. WP-2d moved it out of
// `tests/render.test.ts` into `src/detectors.ts` unchanged, and verified the move
// changed no count. The cases below are the *unit* half of that guarantee — the
// corpus half is the differential recorded in the WP-2d report.
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  test("removes SGR sequences and leaves the text", () => {
    const esc = String.fromCharCode(27);
    expect(stripAnsi(`${esc}[36m${esc}[4malt${esc}[24m${esc}[39m`)).toBe("alt");
  });

  test("leaves text that merely looks like an escape sequence alone", () => {
    // the ESC byte is the whole point — a bare "[36m" in prose is not an escape
    expect(stripAnsi("see [36m in the spec")).toBe("see [36m in the spec");
  });
});

describe("findListOrphans", () => {
  test("detects a known-bad rendering and clears a known-good one", () => {
    const bad = [
      "    • alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "      lambda",
      "      mu nu xi",
    ].join("\n");
    expect(findListOrphans(bad, 64)).toEqual(["lambda"]);

    const good = [
      "    • alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "      lambda mu nu xi",
    ].join("\n");
    expect(findListOrphans(good, 64)).toEqual([]);
  });

  test("does not flag an item's natural short final line", () => {
    // the "followed by more prose in the same item" clause — without it this fires
    const source = ["    • alpha beta gamma delta epsilon zeta eta theta iota kappa", "      lambda"].join("\n");
    expect(findListOrphans(source, 64)).toEqual([]);
  });

  test("does not flag a short line whose predecessor is nowhere near the budget", () => {
    const source = ["    • short", "      lambda", "      mu nu xi"].join("\n");
    expect(findListOrphans(source, 200)).toEqual([]);
  });

  test("codeRanges exemption is opt-in and suppresses only the exempted lines", () => {
    const bad = [
      "    • alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "      lambda",
      "      mu nu xi",
    ].join("\n");
    // omitted -> historical behaviour, which is what every recorded count was measured with
    expect(findListOrphans(bad, 64)).toEqual(["lambda"]);
    // supplied and covering line 2 -> suppressed
    expect(findListOrphans(bad, 64, { codeRanges: [[2, 2]] })).toEqual([]);
    // supplied but covering an unrelated line -> unchanged
    expect(findListOrphans(bad, 64, { codeRanges: [[9, 9]] })).toEqual(["lambda"]);
  });
});

// ---------------------------------------------------------------------------
// WP-8. The point of these is the *pair*: `findListOrphans` keeps its answer and
// `findShearOrphans` subtracts the block boundaries out of it. Every case below
// therefore asserts both readings, never the new one alone — a test that only
// pinned the new number could pass while the frozen series quietly moved.
// ---------------------------------------------------------------------------

/** The whole round trip: probe the source, render both, align, classify. */
function classifyDocument(
  source: string,
  width: number,
): { orphans: string[]; classified: ClassifiedOrphan[]; mapped: boolean } {
  const plain = renderDocumentDetailed(source, width);
  const probed = renderDocumentDetailed(probeBlockEnds(source), width);
  const blockEnds = readBlockEnds(plain.text, probed.text);
  return {
    orphans: findListOrphans(plain.text, width, { codeRanges: plain.codeRanges }),
    classified: classifyListOrphans(plain.text, width, blockEnds, { codeRanges: plain.codeRanges }),
    mapped: blockEnds.mapped,
  };
}

// A loose item whose *first* paragraph ends on a two-word line after a nearly-full
// one. In the render the blank line between the two paragraphs is gone
// (`bulletPointLines`' `.filter(identity)`), so it is indistinguishable from a shear
// by any line-based reading — which is exactly the blind spot this WP subtracts.
const LOOSE_MULTI_PARAGRAPH_ITEM = `- Sustained throughput on the ingest path is bounded by the slowest of the three
  stages, and in every profile we have taken that stage is the checksum
  verifier.

  Buffering ahead of it helps only until the queue is deep enough to hide a
  single stall, after which the extra memory buys nothing at all.
`;

describe("findShearOrphans — the loose multi-paragraph item the old detector cannot clear", () => {
  test("the old detector flags it and the new one does not", () => {
    const { orphans, classified, mapped } = classifyDocument(LOOSE_MULTI_PARAGRAPH_ITEM, 80);

    // the frozen metric's answer, unchanged and still reported
    expect(orphans).toEqual(["checksum verifier."]);
    expect(mapped).toBe(true);
    // ...and the new reading, which knows it is a paragraph ending
    expect(classified.map((hit) => hit.kind)).toEqual(["paragraph-boundary"]);
    expect(classified[0]?.text).toBe("checksum verifier.");
  });

  test("the same hit is a shear when nothing marks its line as a block end", () => {
    // Same rendered input, empty boundary map: the classification is doing the work,
    // not some other property of the line.
    const plain = renderDocumentDetailed(LOOSE_MULTI_PARAGRAPH_ITEM, 80);
    const none: BlockEnds = { ends: new Map(), mapped: true };
    expect(findShearOrphans(plain.text, 80, none).map((hit) => hit.text)).toEqual(["checksum verifier."]);
  });
});

describe("classifyListOrphans", () => {
  test("reports exactly findListOrphans' hits, in order, whatever the labels are", () => {
    const documents = [
      LOOSE_MULTI_PARAGRAPH_ITEM,
      `- Outer item text that runs on for a while so the quote below it is indented.

  > Why? Since imports are hoisted, keeping them all at the top prevents
  > surprising behavior.

  \`\`\`js
  const foo = 1;
  \`\`\`
`,
      `1. Outer step that sets the scene for the nested list below it.
   1. Note: plugin files between plugin packages installed with pip must
      have unique filenames.
   2. Any path in the search path is scanned for the namespace folder.
`,
      `# Heading

Ordinary prose that is not in a list at all, so nothing here can be a candidate.

- [a very long link label indeed](https://example.invalid/a/rather/long/path/that/will/not/fit)
- second item
`,
    ];
    for (const source of documents) {
      for (const width of [40, 80, 116, 346]) {
        const { orphans, classified } = classifyDocument(source, width);
        expect(classified.map((hit) => hit.text)).toEqual(orphans);
      }
    }
  });

  test("every kind is reachable, and each label follows the boundary map", () => {
    const plain = renderDocumentDetailed(LOOSE_MULTI_PARAGRAPH_ITEM, 80);
    const at = 3; // the rendered line the hit lands on
    const kindFor = (ends: BlockEnds): string | undefined =>
      classifyListOrphans(plain.text, 80, ends, { codeRanges: plain.codeRanges })[0]?.kind;

    expect(kindFor({ ends: new Map(), mapped: true })).toBe("shear");
    expect(kindFor({ ends: new Map([[at, "paragraph"]]), mapped: true })).toBe("paragraph-boundary");
    expect(kindFor({ ends: new Map([[at, "block"]]), mapped: true })).toBe("block-boundary");
    // a document whose probe did not align is reported as such rather than guessed at
    expect(kindFor({ ends: new Map([[at, "paragraph"]]), mapped: false })).toBe("unmapped");
  });

  test("a block end that is not a paragraph boundary is labelled as one — a fence, a quote", () => {
    const source = `- Outer item text that runs on for a while so the quote below it is indented.

  > Why? Since imports are hoisted, keeping them all at the top prevents
  > surprising behavior.

  \`\`\`js
  const foo = 1;
  \`\`\`
`;
    const { orphans, classified } = classifyDocument(source, 80);
    expect(orphans).toEqual(["indented.", "surprising behavior."]);
    expect(classified.map((hit) => hit.kind)).toEqual(["block-boundary", "block-boundary"]);
  });

  test("longestToken measures the hit's neighbourhood, not the hit", () => {
    const rendered = [
      "    • alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "      lambda",
      "      https://example.invalid/one/rather/long/unbreakable/path/segment",
    ].join("\n");
    const hits = classifyListOrphans(rendered, 64, { ends: new Map(), mapped: true });
    expect(hits.map((hit) => hit.text)).toEqual(["lambda"]);
    expect(hits[0]?.longestToken).toBe(64);
  });
});

describe("probeBlockEnds / readBlockEnds", () => {
  test("aligns even though the probe changes where the library breaks a line", () => {
    // `marked-terminal` reflows by `.length`, so a probe *can* move a word to the next
    // line. The alignment is on the visible character stream for exactly that reason,
    // and `mapped` is the invariant that says so.
    const { mapped } = classifyDocument(LOOSE_MULTI_PARAGRAPH_ITEM, 80);
    expect(mapped).toBe(true);
  });

  test("inline markup at the end of a probed block still renders as markup", () => {
    // Both halves of the placement rule (`PROBE_TRAILER`): a probe after a closing `**`
    // defeats emphasis, and a probe before a link's closing paren invalidates the href.
    // A blockquote is the case that can show it — `marked-terminal`'s `text` renderer
    // returns a list item's block text verbatim, so inline markup inside a list item is
    // emitted literally either way and would not expose a broken rule.
    const source = `> **Bold to the very end of the paragraph, which runs on long enough to wrap once**
>
> A [labelled link](https://example.invalid/some/path) closing the second one
>
> Trailing text so the two blocks above are not last.
`;
    for (const width of [40, 80, 116]) {
      const plain = renderDocumentDetailed(source, width);
      const probed = renderDocumentDetailed(probeBlockEnds(source), width);
      expect(readBlockEnds(plain.text, probed.text).mapped).toBe(true);
      // the emphasis really was parsed, in both renders, so `mapped` means something here
      expect(stripAnsi(plain.text)).not.toContain("**");
      expect(stripAnsi(probed.text)).not.toContain("**");
    }
  });

  test("a probe never reaches the terminal", () => {
    const probed = renderDocumentDetailed(probeBlockEnds(LOOSE_MULTI_PARAGRAPH_ITEM), 80).text;
    // the probes are in the render (that is the mechanism) but never in the visible text
    // the detector or the reader is handed — `readBlockEnds` is the only thing that sees them
    expect([...probed].some((char) => char === String.fromCharCode(17))).toBe(true);
    const plain = renderDocumentDetailed(LOOSE_MULTI_PARAGRAPH_ITEM, 80).text;
    expect([...plain].some((char) => char.charCodeAt(0) === 17 || char.charCodeAt(0) === 18)).toBe(false);
  });

  test("frontmatter is left alone — a probe there would reach the YAML parser", () => {
    const source = `---
title: A note
tags:
  - one
  - two
---

- Sustained throughput on the ingest path is bounded by the slowest of the three
  stages, and in every profile we have taken that stage is the checksum
  verifier.

  Buffering ahead of it helps only until the queue is deep enough to hide a
  single stall, after which the extra memory buys nothing at all.
`;
    const probed = probeBlockEnds(source);
    expect(probed.split("---")[1]).toBe(source.split("---")[1]);
    const { orphans, classified, mapped } = classifyDocument(source, 80);
    expect(mapped).toBe(true);
    expect(orphans).toEqual(["checksum verifier."]);
    expect(classified.map((hit) => hit.kind)).toEqual(["paragraph-boundary"]);
  });

  test("mismatched renders report mapped: false instead of a wrong line", () => {
    const plain = renderDocumentDetailed(LOOSE_MULTI_PARAGRAPH_ITEM, 80);
    const other = renderDocumentDetailed(probeBlockEnds("- a completely different document\n"), 80);
    expect(readBlockEnds(plain.text, other.text).mapped).toBe(false);
  });
});

describe("findContinuationOverIndent", () => {
  test("a well-formed item — every continuation at the marker's text column — is clean", () => {
    const source = ["    • first line of the item", "      continuation at the same column"].join("\n");
    expect(findContinuationOverIndent(source)).toEqual([]);
  });

  test("flags a continuation indented past its own item's text column, with the drift", () => {
    const source = ["    • first line of the item", "        drifted two columns right"].join("\n");
    const found = findContinuationOverIndent(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.expectedColumn).toBe(6);
    expect(found[0]?.actualColumn).toBe(8);
    expect(found[0]?.drift).toBe(2);
    expect(found[0]?.line).toBe(2);
    expect(found[0]?.text).toBe("drifted two columns right");
  });

  test("a nested item's own continuation is measured against the nested marker, not the parent", () => {
    const source = [
      "    • parent item",
      "      • nested item",
      "        continuation of the nested item, correctly aligned",
      "      still the parent's own continuation",
    ].join("\n");
    // line 3 aligns with the nested marker's text column (8) — clean.
    // line 4 is at column 6, *left* of the nested item, so it closes it and aligns with
    // the parent's text column (6) — also clean. Neither is an over-indent.
    expect(findContinuationOverIndent(source)).toEqual([]);
  });

  test("an ordered marker's wider prefix is derived, not assumed to be two columns", () => {
    const source = ["    10. an ordered item with a four-column marker", "        aligned continuation"].join("\n");
    expect(findContinuationOverIndent(source)).toEqual([]);
    const drifted = ["    10. an ordered item with a four-column marker", "          drifted continuation"].join("\n");
    expect(findContinuationOverIndent(drifted)).toHaveLength(1);
  });

  test("text back at column 0 closes every open list", () => {
    const source = ["    • an item", "a paragraph at column zero", "        deeply indented but not in a list"].join(
      "\n",
    );
    expect(findContinuationOverIndent(source)).toEqual([]);
  });

  test("a blank line does not close a loose item", () => {
    const source = ["    • an item", "", "        drifted second paragraph of the same item"].join("\n");
    expect(findContinuationOverIndent(source)).toHaveLength(1);
  });

  test("codeRanges exemption suppresses a fence's own indentation", () => {
    const source = ["    • an item with a fence", "        code line indented inside the fence"].join("\n");
    expect(findContinuationOverIndent(source)).toHaveLength(1);
    expect(findContinuationOverIndent(source, { codeRanges: [[2, 2]] })).toEqual([]);
  });

  test("is width-independent — the same input gives the same answer at any target", () => {
    const source = ["    • first line of the item", "        drifted two columns right"].join("\n");
    // no width argument exists at all; this asserts the shape of the contract
    expect(findContinuationOverIndent(source)).toHaveLength(1);
  });
});

describe("isTableLine — the accepted-by-design overflow class", () => {
  test("recognises box-drawing borders and body rows in both glyph tiers", () => {
    expect(isTableLine("┌───┬───┐")).toBe(true);
    expect(isTableLine("│ a │ b │")).toBe(true);
    expect(isTableLine("+---+---+")).toBe(true);
    expect(isTableLine("| a | b |")).toBe(true);
  });

  test("does not claim ordinary prose or a single pipe", () => {
    expect(isTableLine("a long paragraph of ordinary prose")).toBe(false);
    expect(isTableLine("    • an item mentioning a | pipe")).toBe(false);
  });
});

// WP-2g's instrument. The two detectors above cannot see this class at all — both
// require `isIndentedLine`, so a line that collapsed to column 0 is skipped by each.
describe("findColumnZeroMarkers", () => {
  test("reports a marker that escaped the indented block it belongs to", () => {
    const rendered = ["    • an item whose continuation was pushed over budget", "• a second item", "      its own continuation"].join(
      "\n",
    );
    expect(findColumnZeroMarkers(rendered).map((hit) => hit.line)).toEqual([2]);
  });

  test("ignores authored prose that merely starts like a marker", () => {
    const rendered = ["a paragraph of prose", "1. an authored numbered paragraph", "more prose at column zero"].join("\n");
    expect(findColumnZeroMarkers(rendered)).toEqual([]);
  });

  test("honours codeRanges on both the candidate line and its adjacency evidence", () => {
    const rendered = ["1. an authored numbered paragraph", "    indented fenced content"].join("\n");
    // without the ranges the indented fence reads as adjacency
    expect(findColumnZeroMarkers(rendered)).toHaveLength(1);
    expect(findColumnZeroMarkers(rendered, { codeRanges: [[2, 2]] })).toEqual([]);
    // and a marker *inside* a fence is never ours to judge
    expect(findColumnZeroMarkers(["    • an item", "• looks like a marker"].join("\n"), { codeRanges: [[2, 2]] })).toEqual([]);
  });

  test("recognizes both glyph tiers' bullets and ordered markers", () => {
    for (const marker of ["•", "◦", "‣", "-", "*", "+", "12."]) {
      const rendered = ["    • an item", `${marker} escaped`].join("\n");
      expect(`${marker}: ${findColumnZeroMarkers(rendered).length}`).toBe(`${marker}: 1`);
    }
  });
});

describe("parseWidths", () => {
  test("parses the existing comma list unchanged", () => {
    expect(parseWidths("80,100,160")).toEqual([80, 100, 160]);
    expect(parseWidths(" 80 , 100 ")).toEqual([80, 100]);
  });

  test("parses an inclusive range", () => {
    expect(parseWidths("40-44")).toEqual([40, 41, 42, 43, 44]);
    expect(parseWidths("40-360")).toHaveLength(321);
  });

  test("parses a mix of ranges and single widths, deduped", () => {
    expect(parseWidths("40-42,100,41")).toEqual([40, 41, 42, 100]);
  });

  test("rejects a descending range and non-positive widths", () => {
    expect(() => parseWidths("360-40")).toThrow(/ascending/);
    expect(() => parseWidths("0")).toThrow(/positive/);
    expect(() => parseWidths("abc")).toThrow(/positive/);
  });
});
