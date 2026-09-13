import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { highlightToAnsi } from "../src/highlight";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { stripAnsi } from "../src/list-lines";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocument, renderDocumentDetailed } from "../src/render";


/**
 * **The `formats` mode at the document level** — WP-2 of `plans/colour-modes.md`.
 *
 * Two obligations that only a whole-document render can witness, plus the framing Decision 8
 * governs. Everything else about the mode is pinned at its own producer with exact-pair
 * assertions (`tests/inline.test.ts`, `tests/table-emission.test.ts`, `tests/frontmatter.test.ts`,
 * `tests/wikilink-emission.test.ts`, `tests/blocks.test.ts`), deliberately: cycle-3 f6 established
 * that a document-level probe is masked by the paragraph `reset` and cannot fail when the
 * hue filter is dead.
 *
 * 1. **Authored escapes are content and survive byte-for-byte** (cycle-2 f3). This is what
 *    killed rev 2's "formats ≡ full minus hue codes" identity gate: an authored `31m` is not
 *    the tool's to remove at *any* mode, so a filter that operated on the finished byte
 *    stream rather than on the tool's own style chains would have been unsound. The filter
 *    is over named chains at the emitter, so an authored sequence is never even a candidate.
 * 2. **The reset framing is present under `formats`** (Decision 8) — paragraphs and list
 *    items alike, which is the second `reset` chain (`src/lists.ts`) the decision names.
 */
describe("renderDocument under `formats` — authored escapes, and the reset framing", () => {
  const ESC = String.fromCharCode(27);
  const NONE = { sgr: "none", hyperlinks: false, tmux: false } as const;
  const FORMATS = { sgr: "formats", hyperlinks: false, tmux: false } as const;
  const FULL = { sgr: "full", hyperlinks: false, tmux: false } as const;
  const render = (source: string, policy: typeof NONE | typeof FORMATS | typeof FULL): string =>
    renderDocument(source, 60, UNICODE_GLYPHS, undefined, undefined, undefined, policy);

  const AUTHORED = `A paragraph with authored ${ESC}[31mred${ESC}[39m in it.\n`;

  test("an authored hue sequence survives `formats` byte-for-byte, in place and in order", () => {
    const out = render(AUTHORED, FORMATS);
    expect(out).toContain(`${ESC}[31mred${ESC}[39m`);
    expect(out.split(`${ESC}[31m`).length - 1).toBe(1);
    expect(out.split(`${ESC}[39m`).length - 1).toBe(1);
    // And the tool's own framing sits outside it rather than through it.
    expect(out).toBe(`${ESC}[0mA paragraph with authored ${ESC}[31mred${ESC}[39m in it.${ESC}[0m\n\n`);
  });

  test("the same authored sequence survives `none` and `full` too — fidelity is not modal", () => {
    for (const policy of [NONE, FORMATS, FULL]) {
      expect(render(AUTHORED, policy)).toContain(`${ESC}[31mred${ESC}[39m`);
    }
    expect(render(AUTHORED, NONE)).toBe(`A paragraph with authored ${ESC}[31mred${ESC}[39m in it.\n\n`);
  });

  test("a paragraph and a list item both keep their reset framing under `formats`", () => {
    // `src/blocks.ts`'s `RESET` and `src/lists.ts`'s `LIST_ITEM` — the two chains Decision 8
    // is about. `0m` opens and closes, so this is pinned as the whole byte string.
    expect(render("plain prose\n", FORMATS)).toBe(`${ESC}[0mplain prose${ESC}[0m\n\n`);
    expect(render("- a list item\n", FORMATS)).toBe(`    • ${ESC}[0ma list item${ESC}[0m\n\n`);
    // ... and are absent under `none`, so the assertions above are not vacuous.
    expect(render("plain prose\n", NONE)).toBe("plain prose\n\n");
    expect(render("- a list item\n", NONE)).toBe("    • a list item\n\n");
  });

  test("`formats` is exactly `full` minus the tool's own hue pairs on a mixed document", () => {
    // Stated as a *measured* relationship on one document rather than as an identity gate:
    // rev 2's identity was unsound in general (an authored hue must not be removed), so this
    // case deliberately carries no authored escape and is a per-document witness, not a rule.
    const source = "`code` and **bold**\n";
    expect(render(source, FULL)).toBe(`${ESC}[0m${ESC}[33mcode${ESC}[39m and ${ESC}[1mbold${ESC}[22m${ESC}[0m\n\n`);
    expect(render(source, FORMATS)).toBe(`${ESC}[0mcode and ${ESC}[1mbold${ESC}[22m${ESC}[0m\n\n`);
    expect(render(source, NONE)).toBe("code and bold\n\n");
  });

  test("the three modes differ only in escapes — every visible character is identical", () => {
    const source = `# Heading\n\n${AUTHORED}\n- item with \`code\` and **bold**\n\n| a | b |\n|---|---|\n| c | d |\n`;
    const base = stripAnsi(render(source, NONE));
    expect(stripAnsi(render(source, FORMATS))).toBe(base);
    expect(stripAnsi(render(source, FULL))).toBe(base);
  });
});

describe("renderDocument — Obsidian task states", () => {
  test("task states render as glyphs, not literal bracket markers", () => {
    const source = "- [x] done thing\n- [ ] todo thing\n- [/] in progress thing\n";
    const output = renderDocument(source, 80);
    const plain = stripAnsi(output);
    expect(plain).not.toContain("[x]");
    expect(plain).not.toContain("[ ]");
    expect(plain).not.toContain("[/]");
    expect(plain).toContain("✓");
    expect(plain).toContain("○");
    expect(plain).toContain("◐");
  });

  test("a task-state-looking line inside a fence is untouched", () => {
    const source = "```\n- [x] literal, not a real task\n```\n";
    const output = renderDocument(source, 80);
    expect(output).toContain("[x]");
  });
});

describe("renderDocument — width and prose coverage", () => {
  test("no line exceeds the target width for tests/fixtures/simple.md", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/simple.md`, "utf8");
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("headings, bold/italic, lists, blockquotes, and a fenced code block all render non-empty", () => {
    const source = [
      "# Heading one",
      "",
      "Some **bold** and some *italic* text.",
      "",
      "- item one",
      "- item two",
      "",
      "> a quoted blockquote",
      "",
      "```bash",
      "echo hello",
      "```",
      "",
    ].join("\n");

    const output = renderDocument(source, 80);
    expect(output.length).toBeGreaterThan(0);

    const plain = stripAnsi(output);
    expect(plain).toContain("Heading one");
    expect(plain).toContain("bold");
    expect(plain).toContain("italic");
    expect(plain).toContain("item one");
    expect(plain).toContain("item two");
    expect(plain).toContain("quoted blockquote");
    expect(plain).toContain("echo hello");
  });
});

describe("renderDocument — fenced code exemption and sentinels (WP-4a)", () => {
  test("a 200-char command line in a fence is emitted verbatim, unbroken", () => {
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["```bash", longCommand, "```", ""].join("\n");
    const output = renderDocument(source, 80);
    expect(output).toContain(longCommand);
  });

  test("renderDocumentDetailed reports a codeRanges entry covering the fence, sentinel-free", () => {
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["intro paragraph", "", "```bash", longCommand, "```", "", "outro paragraph"].join("\n");
    const { text, codeRanges } = renderDocumentDetailed(source, 80);

    expect(codeRanges.length).toBeGreaterThan(0);
    expect(text).not.toContain(String.fromCharCode(0));

    const lines = text.split("\n");
    const [start, end] = codeRanges[0] ?? [0, 0];
    const rangeText = lines.slice(start - 1, end).join("\n");
    expect(rangeText).toContain(longCommand);
  });

  test("--check-shape scenario: the fence line itself still exceeds 80 in the raw text", () => {
    // Confirms the exemption is doing real work — without it this fixture would
    // fail a naive per-line width check.
    const longCommand = `bun run design:verify ${"x".repeat(170)}`;
    const source = ["```bash", longCommand, "```", ""].join("\n");
    const { text } = renderDocumentDetailed(source, 80);
    const overLong = text.split("\n").some((line) => stringWidth(line) > 80);
    expect(overLong).toBe(true);
  });
});

describe("renderDocument — fence language normalization silences highlight.js diagnostics (WP-3)", () => {
  test("a dataviewjs fence renders through the forced-color harness with zero captured messages", async () => {
    const source = ["```dataviewjs", "dv.pages().sort(p => p.file.name)", "```", ""].join("\n");
    const { text, messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
    expect(text.length).toBeGreaterThan(0);
  });

  test("a dataview fence also renders through the forced-color harness with zero captured messages", async () => {
    const source = ["```dataview", "TABLE file.name FROM \"notes\"", "```", ""].join("\n");
    const { messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
  });

  test("an ad-note admonition fence (Obsidian, unsupported) also emits nothing", async () => {
    const source = ["```ad-note", "a note admonition", "```", ""].join("\n");
    const { messages } = await renderWithForcedColor(source, 80);
    expect(messages).toEqual([]);
  });

  // Positive control, so the three tests above cannot pass vacuously: prove the
  // console.error capture mechanism itself still detects a real highlight.js
  // "language not found" diagnostic when one is actually emitted. The owned colorizer
  // (`src/highlight.ts`, which replaced the retired package in WP-2 of
  // `plans/colour-policy.md`) calls `hljs.highlight` on any truthy language, and
  // highlight.js logs via `console.error` *and then* throws on one it does not know.
  // It is not reachable from `renderDocumentDetailed` after WP-3's fix — every fence
  // language is normalized to something supported before it gets there — so this
  // exercises the same entry point directly instead.
  test("positive control: the owned colorizer still emits a real console.error for a genuinely unsupported language", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      try {
        highlightToAnsi({ sgr: "full" }, "const x = 1;", "not-a-real-language-xyz");
      } catch {
        // highlight.js throws in addition to logging for a genuinely unknown language;
        // the console.error call happens before the throw, which is all this control
        // needs to prove the capture mechanism works. `src/blocks.ts` catches the same
        // throw and falls back to flat yellow.
      }
    } finally {
      console.error = original;
    }
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((message) => message.includes("not-a-real-language-xyz"))).toBe(true);
  });
});

/**
 * **The task-state surface is user-withheld ground, and this block is the fence around it**
 * — grant C1 of `plans/wiki-link-tokenizer.md`, enforcing the boundary at WP-1 so WP-2
 * cannot cross it by accident.
 *
 * The wiki-link fix carries a **class-C exception**: it is allowed to change rendered bytes
 * inside recorded `codeRanges`, because a verbatim context losing its authored brackets is
 * the defect being repaired. The task-state pre-pass shares a mechanism with it — both are
 * unguarded pre-lexer substitutions in `preprocessBody` reaching indented code — and its
 * *own* class-C exception was requested at WP-4 of `plans/renderer-deferred-work.md` and
 * **the user withheld it** (`src/render.ts:186-213`; `src/AGENTS.md`, "The task-state
 * pre-pass"). The two defects are independently dispositioned: repairing one does not
 * authorize repairing the other, and **any task-state byte that moves anywhere is a
 * defect**, not a side effect the wiki-link grant covers.
 *
 * So these pin the *output* of a surface no package in this plan may edit, across the full
 * axis the grant names — **Unicode/ASCII x `none`/`formats`/`full`** (cycle-3 f5) — with
 * task states adjacent to wiki-links on the same line, on neighbouring lines, and in the
 * fenced, blockquoted, ordered and indented-code variants that reach the pre-pass by
 * different routes. **WP-2 holds them unmodified.** If one fails at WP-2, the cutover has
 * moved a task-state byte and the correct response is to stop, not to re-pin.
 *
 * The last case is the sharp one: `    - [ ] indented [[note]]` is a line inside a recorded
 * `codeRange` where **both** pre-passes fire — the task-state rewrite (`[ ]` to the glyph,
 * the 84-line class-C defect this repo carries deliberately) and the wiki-link
 * substitution. WP-2 repairs the wiki-link half of that line under C1 and must leave the
 * task-state half exactly as it is, which is a distinction only a byte-exact pin can hold.
 */
describe("task-state adjacency — held unmodified through the tokenizer cutover", () => {
  const ESC = String.fromCharCode(27);
  const NONE = { sgr: "none", hyperlinks: false, tmux: false } as const;
  const FORMATS = { sgr: "formats", hyperlinks: false, tmux: false } as const;
  const FULL = { sgr: "full", hyperlinks: false, tmux: false } as const;
  const POLICIES = [
    ["none", NONE],
    ["formats", FORMATS],
    ["full", FULL],
  ] as const;

  /** `none`, `formats`, `full` — in that order, matching `POLICIES`. */
  type ByMode = readonly [string, string, string];

  interface AdjacencyCase {
    readonly name: string;
    readonly source: string;
    readonly unicode: ByMode;
    readonly ascii: ByMode;
    readonly codeRanges: Array<[number, number]>;
  }

  const cases: AdjacencyCase[] = [
    {
      name: "GFM states on the same line as a wiki-link",
      source: "- [ ] todo with [[note]]\n- [x] done with [[note]]\n",
      unicode: [
        "    • ○ todo with note\n    • ✓ done with note\n\n",
        `    • ${ESC}[0m○ todo with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n    • ${ESC}[0m✓ done with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    • ${ESC}[0m○ todo with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n    • ${ESC}[0m✓ done with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      ascii: [
        "    - [ ] todo with note\n    - [x] done with note\n\n",
        `    - ${ESC}[0m[ ] todo with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n    - ${ESC}[0m[x] done with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    - ${ESC}[0m[ ] todo with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n    - ${ESC}[0m[x] done with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      codeRanges: [],
    },
    {
      name: "a custom Obsidian state on the same line as a wiki-link",
      // `[/]` is invisible to GFM's tasklist regex, so the pre-pass is the *only* thing
      // rendering it as a glyph — the branch that makes the pass irreplaceable.
      source: "- [/] partial with [[note]]\n",
      unicode: [
        "    • ◐ partial with note\n\n",
        `    • ${ESC}[0m◐ partial with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    • ${ESC}[0m◐ partial with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      ascii: [
        "    - [/] partial with note\n\n",
        `    - ${ESC}[0m[/] partial with ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    - ${ESC}[0m[/] partial with ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      codeRanges: [],
    },
    {
      name: "task items on the lines either side of a wiki-link item",
      source: "- [ ] plain todo\n- see [[note]]\n- [x] plain done\n",
      unicode: [
        "    • ○ plain todo\n    • see note\n    • ✓ plain done\n\n",
        `    • ${ESC}[0m○ plain todo${ESC}[0m\n    • ${ESC}[0msee ${ESC}[4mnote${ESC}[24m${ESC}[0m\n    • ${ESC}[0m✓ plain done${ESC}[0m\n\n`,
        `    • ${ESC}[0m○ plain todo${ESC}[0m\n    • ${ESC}[0msee ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n    • ${ESC}[0m✓ plain done${ESC}[0m\n\n`,
      ],
      ascii: [
        "    - [ ] plain todo\n    - see note\n    - [x] plain done\n\n",
        `    - ${ESC}[0m[ ] plain todo${ESC}[0m\n    - ${ESC}[0msee ${ESC}[4mnote${ESC}[24m${ESC}[0m\n    - ${ESC}[0m[x] plain done${ESC}[0m\n\n`,
        `    - ${ESC}[0m[ ] plain todo${ESC}[0m\n    - ${ESC}[0msee ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n    - ${ESC}[0m[x] plain done${ESC}[0m\n\n`,
      ],
      codeRanges: [],
    },
    {
      name: "a fenced task line beside a real one — the fence toggle guards both pre-passes",
      source: "```\n- [ ] fenced [[note]]\n```\n\n- [ ] real [[note]]\n",
      unicode: [
        "    - [ ] fenced [[note]]\n\n    • ○ real note\n\n",
        `    - [ ] fenced [[note]]\n\n    • ${ESC}[0m○ real ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    - [ ] fenced ${ESC}[31m[[note]]${ESC}[39m\n\n    • ${ESC}[0m○ real ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      ascii: [
        "    - [ ] fenced [[note]]\n\n    - [ ] real note\n\n",
        `    - [ ] fenced [[note]]\n\n    - ${ESC}[0m[ ] real ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    - [ ] fenced ${ESC}[31m[[note]]${ESC}[39m\n\n    - ${ESC}[0m[ ] real ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      // The `31m` on the fenced brackets is the syntax highlighter's own guess over the
      // code range's content, not this tool styling a wiki-link — the fence keeps both
      // pre-passes off that line, which is why the brackets are still there to highlight.
      codeRanges: [[1, 1]],
    },
    {
      name: "a task item inside a blockquote — the position the line-anchored regex cannot reach",
      source: "> - [ ] quoted [[note]]\n",
      // **The one held case whose *wiki-link* bytes moved at WP-2, `full` only** — the task
      // state is byte-identical in every mode and both tiers, which is what this block is a
      // fence around. What moved is one `90m`: the blockquote's own `gray` chain now re-opens
      // after the wiki chain's `39m` close, because `applyStyle`'s nested-close surgery
      // finally *sees* that close. It could not before — the old carrier pass styled the
      // label over the finished document, long after `blockquote` had run. Parity, measured
      // on the unchanged paths: `> - [ ] quoted [label](url)`, `~~struck~~` and `` `code` ``
      // all emit exactly the same `90m` re-open today, because their closes are `39m` too.
      unicode: [
        "        • ○ quoted note\n\n",
        `${ESC}[3m        • ${ESC}[0m○ quoted ${ESC}[4mnote${ESC}[24m${ESC}[0m${ESC}[23m\n\n`,
        `${ESC}[90m${ESC}[3m        • ${ESC}[0m○ quoted ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[90m${ESC}[0m${ESC}[23m${ESC}[39m\n\n`,
      ],
      ascii: [
        "        - [ ] quoted note\n\n",
        `${ESC}[3m        - ${ESC}[0m[ ] quoted ${ESC}[4mnote${ESC}[24m${ESC}[0m${ESC}[23m\n\n`,
        `${ESC}[90m${ESC}[3m        - ${ESC}[0m[ ] quoted ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[90m${ESC}[0m${ESC}[23m${ESC}[39m\n\n`,
      ],
      codeRanges: [],
    },
    {
      name: "a task item in an ordered list — the other position `renderTaskState` covers",
      source: "1. [ ] ordered [[note]]\n",
      unicode: [
        "    1. ○ ordered note\n\n",
        `    1. ${ESC}[0m○ ordered ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    1. ${ESC}[0m○ ordered ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      ascii: [
        "    1. [ ] ordered note\n\n",
        `    1. ${ESC}[0m[ ] ordered ${ESC}[4mnote${ESC}[24m${ESC}[0m\n\n`,
        `    1. ${ESC}[0m[ ] ordered ${ESC}[36m${ESC}[4mnote${ESC}[24m${ESC}[39m${ESC}[0m\n\n`,
      ],
      codeRanges: [],
    },
    {
      name: "both pre-passes firing on one line inside a recorded codeRange",
      // **The sharp case, and the one this whole block exists to disambiguate.** `[ ]`
      // becomes the tier's glyph here *inside* a code range — the 84-line class-C defect
      // this repo carries on purpose, still carried — and the wiki-link substitution used to
      // corrupt the same line beside it. WP-2 repairs the second half under C1: the authored
      // `[[note]]` is back, byte for byte, on a line inside `codeRanges` `[[3, 3]]`.
      //
      // **The task-state half did not move**, which is the assertion that matters: the
      // marker `    - `, the `○`/`[ ]` glyph and its column are identical to WP-1's pins in
      // all six combinations, and the two tiers still differ from each other exactly as
      // `glyphs.rewriteTaskStates` says they should. The `31m` under `full` is the syntax
      // highlighter's own guess over the range's now-restored content, as in the fenced case
      // above — re-measured, not derived.
      source: "Intro.\n\n    - [ ] indented [[note]]\n",
      unicode: [
        "Intro.\n\n    - ○ indented [[note]]\n\n",
        `${ESC}[0mIntro.${ESC}[0m\n\n    - ○ indented [[note]]\n\n`,
        `${ESC}[0mIntro.${ESC}[0m\n\n    - ○ indented ${ESC}[31m[[note]]${ESC}[39m\n\n`,
      ],
      ascii: [
        "Intro.\n\n    - [ ] indented [[note]]\n\n",
        `${ESC}[0mIntro.${ESC}[0m\n\n    - [ ] indented [[note]]\n\n`,
        `${ESC}[0mIntro.${ESC}[0m\n\n    - [ ] indented ${ESC}[31m[[note]]${ESC}[39m\n\n`,
      ],
      codeRanges: [[3, 3]],
    },
  ];

  for (const entry of cases) {
    for (const [tier, glyphs, expected] of [
      ["unicode", UNICODE_GLYPHS, entry.unicode] as const,
      ["ascii", ASCII_GLYPHS, entry.ascii] as const,
    ]) {
      POLICIES.forEach(([mode, policy], index) => {
        // noUncheckedIndexedAccess: `ByMode` is a fixed triple and `POLICIES` is the same
        // length, so the index is total — the local is what says so to the compiler.
        const want = expected[index] as string;
        test(`${entry.name} (${tier}, ${mode})`, () => {
          const result = renderDocumentDetailed(
            entry.source,
            80,
            glyphs,
            undefined,
            undefined,
            undefined,
            policy,
          );
          expect(result.text).toBe(want);
          expect(result.codeRanges).toEqual(entry.codeRanges);
        });
      });
    }
  }

  /**
   * **The held half, named directly** (WP-2).
   *
   * Two of the seven shapes above moved *wiki-link* bytes at the cutover, both authorized:
   * the blockquote case gained one `90m` re-open under `full` (the enclosing chain's own
   * nested-close surgery, which every other `39m`-closing span already triggers there), and
   * the indented-code case had its authored `[[note]]` restored under grant C1. Because the
   * pins above are whole-document and byte-exact, those two had to be re-measured — so this
   * test states the invariant those pins are a *fence around* without any wiki-link bytes in
   * it at all: the task-state rendering itself, glyph and column, is what WP-1 measured.
   *
   * Every expectation here is a substring of the corresponding WP-1 pin, unchanged.
   */
  test("every task-state glyph and its column are exactly WP-1's, in both tiers", () => {
    const held: Array<[number, string, string]> = [
      // [case index, unicode task-state run, ascii task-state run]
      [0, "    • ○ todo with ", "    - [ ] todo with "],
      [1, "    • ◐ partial with ", "    - [/] partial with "],
      [2, "    • ○ plain todo", "    - [ ] plain todo"],
      [3, "    • ○ real ", "    - [ ] real "],
      [4, "        • ○ quoted ", "        - [ ] quoted "],
      [5, "    1. ○ ordered ", "    1. [ ] ordered "],
      [6, "    - ○ indented ", "    - [ ] indented "],
    ];
    expect(held.length).toBe(cases.length);

    for (const [index, unicodeRun, asciiRun] of held) {
      const entry = cases[index] as AdjacencyCase;
      for (const [glyphs, run] of [
        [UNICODE_GLYPHS, unicodeRun] as const,
        [ASCII_GLYPHS, asciiRun] as const,
      ]) {
        for (const [, policy] of POLICIES) {
          const { text } = renderDocumentDetailed(
            entry.source,
            80,
            glyphs,
            undefined,
            undefined,
            undefined,
            policy,
          );
          // Asserted on *stripped* bytes, deliberately: the question is which glyph landed in
          // which column, and a colour mode is not allowed to answer it differently.
          expect(stripAnsi(text)).toContain(run);
        }
      }
    }
  });

  test("the axis is the full one the grant names — 7 shapes x 2 tiers x 3 modes", () => {
    // A guard on the guard: shrinking the axis is how a fence like this goes quietly
    // inert, and cycle-3 f5 added the colour axis precisely because it was missing.
    expect(cases.length).toBe(7);
    expect(POLICIES.length).toBe(3);
  });
});

describe("del tokenizer — a closer inside a code span is not a closer (2026-09-12)", () => {
  // marked's own `del` matched `~300 … `~/.x`` as one strikethrough, swallowing the code
  // span's opening backtick and inverting every code span after it in the paragraph.
  const source = "a ~300-line thing and the persona `~/.codex/AGENTS.md` is `unreachable` here\n";
  test("single tilde followed by a code-span tilde stays literal; code spans stay code", async () => {
    const plain = stripAnsi(renderDocument(source, 100));
    expect(plain).toContain("~300-line thing and the persona ~/.codex/AGENTS.md is unreachable here");
    const { text } = await renderWithForcedColor(source, 100);
    expect(text).not.toContain("\u001b[9m");
    expect(text).toContain("\u001b[33m~/.codex/AGENTS.md\u001b[39m");
    expect(text).toContain("\u001b[33munreachable\u001b[39m");
  });
  test("a real ~~strike~~ and a plain ~strike~ still tokenize", async () => {
    const { text } = await renderWithForcedColor("x ~~gone~~ y ~also~ z\n", 100);
    expect(text.split("\u001b[9m").length - 1).toBe(2);
  });
});
