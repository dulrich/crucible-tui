import { describe, expect, test } from "bun:test";
import {
  findContinuationOverIndent,
  findListOrphans,
  isTableLine,
  stripAnsi,
} from "../src/detectors";
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
