import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderDocument, renderDocumentDetailed } from "../src/render";
import { renderWithForcedColor } from "./helpers/color";

// The only symbol groups 6-11 shared with the rest of `render-lists.test.ts` before this
// split (WP-5 of `plans/renderer-deferred-work.md`, moving this file's own creation
// commit `5ddbb3b`'s "put the publication guard and the list suite in files named for
// what they grade" one level further: `src/lists.ts` was the only large `src/` module
// with no test file named for it). Copied rather than imported — nothing here imports a
// test file, and this is the one small piece that would otherwise force a cross-file
// import for a 4-line constant.
const WP2_TIERS = [
  ["unicode", UNICODE_GLYPHS],
  ["ascii", ASCII_GLYPHS],
] as const;

// ---------------------------------------------------------------------------
// WP-4 of `plans/marked-terminal-replacement.md` — owned list composition.
//
// `src/lists.ts` owns `list`, `listitem` and `checkbox`; nothing in this repo executes
// `marked-terminal` composition any more. Two behaviours changed deliberately, and they
// are the plan's Verification amendment's two enumerated families:
//
// - **B1**, ordered renumbering: the library's `numberedLines` walked a parent list's
//   already-composed body with one counter, and `isPointedLine` claimed the *nested*
//   list's markers, so a nested list consumed the parent's numbers and had its own
//   bullets rewritten into the parent's sequence.
// - **B2**, task states: `rewriteTaskState`'s source pre-pass cannot match a task item
//   whose line does not start with a bullet marker — a blockquoted one, or an ordered one
//   — so `Renderer.prototype.checkbox` fired there instead and emitted an uppercased
//   bracket plus two spaces, in both glyph tiers. Composition renders those two positions
//   under the tier rule now. **The pre-pass itself survives**, and the report's §4 records
//   the class-C measurement that stopped this package from deleting it.
//
// Everything else about a rendered list is unchanged, and was gated byte-identical over
// the private validation corpus before either family was introduced.
// ---------------------------------------------------------------------------

describe("owned list composition — ordered numbering (WP-4, family B1)", () => {
  test("a nested unordered list no longer consumes the parent's counter or loses its bullets", () => {
    const source = "1. alpha\n    - sub one\n    - sub two\n2. beta\n3. gamma\n";
    const lines = stripAnsi(renderDocument(source, 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual([
      "    1. alpha",
      "        ◦ sub one",
      "        ◦ sub two",
      "    2. beta",
      "    3. gamma",
    ]);
  });

  test("a nested ordered list numbers from 1 at its own level", () => {
    const source = "1. alpha\n    1. inner one\n    2. inner two\n2. beta\n";
    const lines = stripAnsi(renderDocument(source, 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual(["    1. alpha", "        1. inner one", "        2. inner two", "    2. beta"]);
  });

  test("an ordered list with nothing nested inside it is numbered exactly as before", () => {
    const lines = stripAnsi(renderDocument("1. alpha\n2. beta\n3. gamma\n", 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual(["    1. alpha", "    2. beta", "    3. gamma"]);
  });

  test("`token.start` stays deliberately ignored — a list authored `5.` still renders `1.`", () => {
    // `Renderer.prototype.list` read `listToken.start` at `index.js:142` and never used
    // it. Honouring it would be a third diff family this package was not granted; pinned
    // here so a future package changes it on purpose or not at all.
    const lines = stripAnsi(renderDocument("5. five\n6. six\n", 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual(["    1. five", "    2. six"]);
  });
});

describe("owned list composition — task states (WP-4, family B2)", () => {
  // The two positions `rewriteTaskState`'s source pre-pass cannot reach. Its regex is
  // anchored on a leading bullet marker, so a blockquote's `>` and an ordered list's `1.`
  // both defeat it, the item reaches `marked` as a real GFM task, and until WP-4
  // `Renderer.prototype.checkbox` rendered it as an uppercased bracket plus two spaces —
  // in **both** glyph tiers. Composition renders it under the same tier rule as every
  // other task item instead.
  const UNREACHED = "> - [x] quoted\n\n1. [x] ordered\n2. [ ] ordered open\n";

  test("a blockquoted task item renders the tier glyph, not the library's checkbox", () => {
    const text = stripAnsi(renderDocument(UNREACHED, 70, UNICODE_GLYPHS));
    expect(text).toContain("✓ quoted");
    expect(text).not.toContain("[X]");
  });

  test("an ordered task item renders the tier glyph too, and numbering is unaffected", () => {
    const lines = stripAnsi(renderDocument(UNREACHED, 70, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.includes("ordered"));
    expect(lines).toEqual(["    1. ✓ ordered", "    2. ○ ordered open"]);
  });

  test("both positions keep the author's literal in the ASCII tier, single-spaced", () => {
    const text = stripAnsi(renderDocument(UNREACHED, 70, ASCII_GLYPHS));
    expect(text).toContain("[x] quoted");
    expect(text).toContain("[x] ordered");
    expect(text).toContain("[ ] ordered open");
    // The library's `checkbox` uppercased every state and `listitem` appended a second
    // space after it. Neither may survive anywhere.
    expect(text).not.toContain("[X]");
    expect(text).not.toContain("]  ");
  });

  test("the author's own state character survives in the ASCII tier, upper or lower", () => {
    const text = stripAnsi(renderDocument("> - [x] lower\n> - [X] upper\n", 70, ASCII_GLYPHS));
    expect(text).toContain("[x] lower");
    expect(text).toContain("[X] upper");
  });

  test("extra spaces after the checkbox survive, in both tiers", () => {
    // `marked` strips every space after the bracket, not one (`marked.cjs:528`), so the
    // run has to be read back off `item.raw` or the item comes back a column narrower
    // than it was authored.
    expect(stripAnsi(renderDocument("> - [x]  two\n", 70, ASCII_GLYPHS))).toContain("[x]  two");
    expect(stripAnsi(renderDocument("> - [x]  two\n", 70, UNICODE_GLYPHS))).toContain("✓  two");
  });

  test("a task item carrying inline markup keeps the state ahead of the markup", () => {
    expect(stripAnsi(renderDocument("> - [x] **bold** tail\n", 70, UNICODE_GLYPHS))).toContain("✓ bold tail");
  });

  test("the positions the pre-pass DOES reach are untouched by composition", () => {
    // A top-level task item never reaches `item.task` at all: the pre-pass has already
    // rewritten the source in the unicode tier, and defeated GFM's lexer with
    // `TASK_STATE_SENTINEL` in the ASCII tier. This is the byte-identical half.
    expect(stripAnsi(renderDocument("- [x] top\n", 70, UNICODE_GLYPHS))).toContain("✓ top");
    expect(stripAnsi(renderDocument("- [x] top\n", 70, ASCII_GLYPHS))).toContain("[x] top");
  });

  test("an Obsidian custom state inside a blockquote is still literal — the deferred residue", () => {
    // Characterisation, not endorsement. `[>]` is not GFM tasklist syntax, so `item.task`
    // is false and composition never sees a state to render; the pre-pass cannot reach a
    // `>`-prefixed line either. Closing this means deleting the pre-pass, which this
    // package measured and could not do — see the WP-4 report, §4: the pre-pass and
    // `marked` disagree about fence pairing, so removing it changes bytes inside recorded
    // `codeRange`s (parity class C) on 11 of 4,786 corpus files.
    //
    // **WP-4 of `plans/renderer-deferred-work.md` re-measured this and the residue grades a
    // population the corpus does not contain.** Across **35,614 files** there is **no
    // blockquoted task item of any kind** — GFM or Obsidian custom — and **no non-GFM state
    // in an ordered list**: 0 hits in 0 files, by a token walk over every list item at every
    // nesting depth, by a fence-gated source scan, and by a fence-*un*gated upper bound that
    // counts matches even inside code. The behaviour pinned below is unchanged and correct;
    // what changed is what closing it would be worth. The class-C exception to close it was
    // requested and **withheld** — see `src/AGENTS.md`, "The task-state pre-pass". (The
    // "11 of 4,786" above is superseded there too: it is 84 lines in 2 files, all fenced.)
    expect(stripAnsi(renderDocument("> - [>] moved\n", 70, UNICODE_GLYPHS))).toContain("[>] moved");
    expect(stripAnsi(renderDocument("- [>] moved\n", 70, UNICODE_GLYPHS))).toContain("➤ moved");
  });

  // -------------------------------------------------------------------------------
  // **P3 — the regression guard, and the reason the pre-pass cannot simply be deleted.**
  //
  // WP-4 of `plans/renderer-deferred-work.md` measured what happens if `rewriteTaskState`
  // is removed and non-GFM states move to composition. On a task item whose *text* begins
  // with an ordered marker, `marked` recognises a real GFM task item, strips `[ ] ` per
  // spec, and CommonMark then lexes the remainder as a **nested ordered list**:
  // `item.tokens[0].type === "list"` (verified against the pinned `marked@14.1.4`, tight
  // and loose alike). `renderTaskState` cannot undo that — the damage is at *lex* time, so
  // its `inline === undefined` fallback returns the prefix as a string and the nested list
  // renders under it, renumbering every item to `1.`.
  //
  // Measured population: 2 corpus files, 50 source lines, 202 changed rendered lines over
  // 4 combos, both glyph tiers — with `overflow` and all three detector counts unchanged,
  // so **no gate in `verify` can see it**. That is why it is pinned here instead.
  //
  // **A package that deletes the pre-pass owns this test.** It will fail the moment the
  // pre-pass goes, and the correct response is not to relax it: it is to suppress the
  // nested lex for task items, which is new design work with its own plan.
  // -------------------------------------------------------------------------------
  test("a task item whose text begins with an ordered marker keeps the author's numbering (P3)", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/task-ordered-text.md`, "utf8");
    for (const [tier, glyphs] of WP2_TIERS) {
      const text = stripAnsi(renderDocument(source, 80, glyphs));
      const state = tier === "unicode" ? "○" : "[ ]";
      const done = tier === "unicode" ? "✓" : "[x]";
      // The author's own numbers survive, on the item's own line — not renumbered to `1.`
      // on a line of their own underneath it.
      expect(`${tier}: ${text.includes(`${state} 1. Alpha initialized`)}`).toBe(`${tier}: true`);
      expect(`${tier}: ${text.includes(`${state} 2. Beta configured`)}`).toBe(`${tier}: true`);
      expect(`${tier}: ${text.includes(`${done} 3. Gamma verified`)}`).toBe(`${tier}: true`);
      // …and no item renumbered to `1.` twice, which is the shape the defect produces.
      expect(`${tier}: ${text.split("1. Alpha initialized").length - 1}`).toBe(`${tier}: 1`);
      expect(`${tier}: ${text.includes("1. Beta configured")}`).toBe(`${tier}: false`);
      // The control half: same shape, text not starting with an ordered marker.
      expect(`${tier}: ${text.includes(`${state} Delta initialized`)}`).toBe(`${tier}: true`);
      expect(`${tier}: ${text.includes(`${done} Epsilon verified`)}`).toBe(`${tier}: true`);
    }
  });

  test("a task-shaped line inside a fence is untouched, in both tiers", () => {
    const source = "```text\n- [x] literal, not a real task\n```\n";
    for (const [tier, glyphs] of WP2_TIERS) {
      const text = stripAnsi(renderDocument(source, 70, glyphs));
      expect(`${tier}: ${text.includes("- [x] literal, not a real task")}`).toBe(`${tier}: true`);
    }
  });
});

describe("owned list composition — invariants the composer must not break (WP-4)", () => {
  test("a fenced block inside a list item is reproduced byte-identically", () => {
    // Every width gate in this repo exempts code ranges, so this channel is the only one
    // that can see a fence being rewritten — the failure mode `src/AGENTS.md`'s rendering
    // policy is unqualified about, and the one a green gate is no evidence for.
    const body = ["* not a bullet, this is code", "1. also not a marker", "- and neither is this"];
    const source = `- item\n\n  \`\`\`text\n${body.map((line) => `  ${line}`).join("\n")}\n  \`\`\`\n`;
    for (const [tier, glyphs] of WP2_TIERS) {
      for (const width of [40, 60, 100]) {
        const { text, codeRanges } = renderDocumentDetailed(source, width, glyphs);
        const lines = stripAnsi(text).split("\n");
        // The recorded range's first physical line is the one the opening sentinel sits
        // on, which for a fence inside a list item is the item's own blank continuation;
        // the block's content is what follows. Blank lines are dropped rather than
        // asserted on — this test is about the content bytes, and `--check`'s exemption
        // covers the whole range either way.
        const inside = codeRanges
          .flatMap(([start, end]) => lines.slice(start - 1, end).map((line) => line.trim()))
          .filter((line) => line !== "");
        expect(`${tier} w${width}: ${inside.join(" | ")}`).toBe(`${tier} w${width}: ${body.join(" | ")}`);
      }
    }
  });

  test("a nested list always begins on its own line", () => {
    // The corruption a botched marker substitution produced once before: the whole nested
    // list joined onto its parent's line with no newline at all.
    const lines = stripAnsi(renderDocument("- level 0\n    - level 1\n", 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual(["    • level 0", "        ◦ level 1"]);
  });

  test("the bullet tier is chosen by rendered indent, so a blockquote shifts it by one", () => {
    // Pinned, not endorsed: `substituteBullets` reads depth back out of the line's own
    // indent, and a blockquote contributes four columns of its own *after* its children
    // have rendered. Composing the bullet from the composer's own list depth would render
    // the depth-2 glyph here and would be a third, ungranted diff family. See
    // `src/lists.ts`'s header.
    const lines = stripAnsi(renderDocument("- outer\n  > - quoted\n", 60, UNICODE_GLYPHS))
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines).toEqual(["    • outer", "            ‣ quoted"]);
  });

  test("every item's composed text is wrapped in chalk.reset under FORCE_COLOR=3", async () => {
    // `defaultOptions.listitem` is `chalk.reset` (`index.js:37`) and it wraps every item.
    // A parity run without forced colour cannot see whether that was reproduced at all,
    // which is exactly how it would have gone missing.
    const { text } = await renderWithForcedColor("- alpha\n- beta\n", 60);
    const items = text.split("\n").filter((line) => line.includes("alpha") || line.includes("beta"));
    expect(items).toHaveLength(2);
    for (const line of items) {
      expect(`${JSON.stringify(line)} carries a reset: ${line.includes(`${String.fromCharCode(27)}[0m`)}`).toBe(
        `${JSON.stringify(line)} carries a reset: true`,
      );
    }
    expect(
      stripAnsi(text)
        .split("\n")
        .filter((line) => line.trim() !== ""),
    ).toEqual(["    • alpha", "    • beta"]);
  });
});

// ---------------------------------------------------------------------------
// WP-5 (`plans/marked-terminal-replacement.md`) — owned list-item layout.
//
// The item's own budget: `composeItem` pushes the *exact* width of the item's marker
// (`"* "` 2, `"7. "` 3, `"12. "` 4) for the duration of its parse, so the wrapping
// seams read the item's true budget instead of the widest marker the whole level could
// emit (family B1), and instead of an estimate inflated by nested lists' markers
// (family B2). Composition decides pad, claim and de-drift on ANSI-stripped bytes
// (`src/lists.ts`), so the coloured and colourless renders of a nested list agree
// (family C1) — they did not, at any width, before this package.
// ---------------------------------------------------------------------------
describe("owned list-item layout — exact per-item budgets (WP-5, families B1/B2)", () => {
  test("items 1-9 of a ten-item ordered list wrap one column later than item 10", () => {
    // 33 columns of content fit exactly in item 1's budget at width 40 (40 - 4 - 3);
    // item 10's marker is one wider, so the same content must wrap. Before WP-5 both
    // wrapped: every item was budgeted for the widest marker the level could emit.
    const fits33 = "abcde fghij klmno pqrst uvwxy zab";
    expect(fits33).toHaveLength(33);
    const filler = Array.from({ length: 8 }, (_, i) => `${i + 2}. f${i}`).join("\n");
    const source = `1. ${fits33}\n${filler}\n10. ${fits33}`;
    const lines = renderDocument(source, 40).split("\n");
    const first = lines.find((line) => line.includes("1. abcde"));
    const tenth = lines.find((line) => line.includes("10. abcde"));
    expect(first).toBe(`    1. ${fits33}`); // 40 columns exactly — no early wrap
    expect(tenth).toBe("    10. abcde fghij klmno pqrst uvwxy"); // one column narrower: wraps
    expect(lines).toContain("        zab"); // item 10's continuation, at its own text column
  });

  test("a three-item ordered list is not budgeted for its nested lists' markers", () => {
    // The deleted `markerLineCount` counted nested markers against the parent, so this
    // list (3 items + 9 nested markers = 12) was budgeted for `"12. "` — every item
    // wrapped two columns early. The exact budget is `"1. "`.
    const fits33 = "abcde fghij klmno pqrst uvwxy zab";
    const nested = "\n    - a\n    - b\n    - c";
    const source = `1. ${fits33}${nested}\n2. two${nested}\n3. three${nested}`;
    const lines = renderDocument(source, 40).split("\n");
    expect(lines.find((line) => line.includes("1. abcde"))).toBe(`    1. ${fits33}`);
    // and the nested lists still compose under their own budgets, unrenumbered
    expect(lines.filter((line) => /^\s+[◦]\s/.test(line))).toHaveLength(9);
    expect(lines.filter((line) => /^\s+\d+\.\s/.test(stripAnsi(line)))).toHaveLength(3);
  });

  test("a table inside a ten-item ordered list is allocated the item's exact width", () => {
    // The table allocator reads the same prefix stack, so the exact per-item entry
    // widens item 1's table by the column item 10's wider marker used to cost it.
    // Wide enough that the allocator is budget-constrained: before WP-5 the level's
    // widest marker ("10. ") capped this table at 38 columns; the exact "1. " budget
    // is 39 (46 - 4 - 3), and the allocator uses every column it is given.
    const row = `| ${"a".repeat(40)} | b |\n| --- | --- |\n| c | d |`;
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`);
    items[0] = `1. head\n\n   ${row.split("\n").join("\n   ")}`;
    const lines = renderDocument(items.join("\n"), 46)
      .split("\n")
      .map((line) => stripAnsi(line));
    const border = lines.find((line) => line.trimStart().startsWith("┌"));
    expect(border).toBeDefined();
    expect(stringWidth((border as string).trimStart())).toBe(46 - 7);
  });
});

describe("owned list-item layout — colour/colourless convergence (WP-5, family C1)", () => {
  const NESTED = [
    "- alpha item with a fairly long text that wraps at narrow width for sure yes",
    "  - sub item with also a fairly long text that wraps at narrow width for sure",
    "- beta",
  ].join("\n");

  test("a nested list's geometry is identical with and without colour", async () => {
    // Before WP-5 the composed pad and the de-drift both read raw bytes, and
    // `chalk.reset`'s newline encasing puts an escape ahead of every line's indent —
    // so under colour the pad landed on marker lines too and the de-drift was inert
    // (measured in WP-4: 0 lines rewritten forced vs 115,472 colourless). The
    // decisions are made on stripped bytes now; only styling may differ.
    const plain = renderDocument(NESTED, 40)
      .split("\n")
      .filter((line) => line.trim() !== "");
    const { text } = await renderWithForcedColor(NESTED, 40);
    const coloured = stripAnsi(text)
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(coloured).toEqual(plain);
  });

  test("a nested list inside an ordered item agrees at both colour settings", async () => {
    const source = [
      "1. alpha parent item with enough text here to wrap at the chosen narrow width",
      "    - sub one with a long enough text to wrap at the chosen narrow width here",
      "    - sub two",
      "2. beta",
    ].join("\n");
    const plain = renderDocument(source, 44)
      .split("\n")
      .filter((line) => line.trim() !== "");
    const { text } = await renderWithForcedColor(source, 44);
    const coloured = stripAnsi(text)
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(coloured).toEqual(plain);
  });

  test("a fence inside a nested list item renders its content at one indent, byte-identical, at three widths", () => {
    const source = [
      "- alpha",
      "  - sub item",
      "",
      "    ```sh",
      "    echo hello",
      "    * decoy line",
      "    echo world",
      "    ```",
      "- beta",
    ].join("\n");
    const per = [40, 80, 120].map((width) =>
      renderDocument(source, width)
        .split("\n")
        .filter((line) => line.includes("echo") || line.includes("decoy")),
    );
    // Byte-identical across widths — a fence never rewraps — and identical to the
    // base-commit bytes (pinned literally: the claim dent on the marker-shaped decoy
    // is the library's own rendering, inside a recorded code range, class C to move).
    expect(per[0]).toEqual(per[1] as string[]);
    expect(per[1]).toEqual(per[2] as string[]);
    expect(per[0]).toEqual(["                echo hello", "            * decoy line", "                echo world"]);
  });
});

describe("owned list-item layout — the surviving guards (WP-5)", () => {
  test("a continuation wrapped onto `12.` in a two-digit ordered list is guarded, and numbering holds", () => {
    // A ten-item list's continuation column (4 + 4) is on the composer's grid, so a
    // continuation starting `12.` would be claimed as a marker line and lose its pad.
    // `rewrapListBody`'s on-grid guard adds the one space the grid cannot match.
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`);
    items[9] = `10. padding words sized so the break lands just before 12. release notes follow here`;
    const lines = renderDocument(items.join("\n"), 40)
      .split("\n")
      .map((line) => stripAnsi(line));
    const numbers = lines
      .map((line) => /^ {4}(\d+)\.\s/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // the author's "12." survives as text, never as a marker line on the grid
    const flowed = lines.join("\n").replace(/\s+/g, " ");
    expect(flowed).toContain("12. release notes");
    for (const line of lines) {
      expect(/^(?: {4})+12\.\s/.test(line)).toBe(false);
    }
  });

  test("the bullet tier follows rendered indent through a blockquote, not nesting depth", () => {
    // `- outer` / `  > - quoted` renders `•` then `‣` — the quote contributes four
    // columns of its own, so the quoted list is drawn with the depth-3 bullet at
    // nesting depth 2. This is the measured reason `substituteBullets` reads depth
    // from `indent.length / 4` and stays a post-composition pass (§6.5 of this WP's
    // brief records the stop condition that kept it).
    const source = "- outer\n  > - quoted";
    const lines = renderDocument(source, 60)
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines[0]).toBe("    • outer");
    expect(lines.find((line) => line.includes("quoted"))).toBe("            ‣ quoted");
  });
});
