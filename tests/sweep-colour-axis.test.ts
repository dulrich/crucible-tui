import { describe, expect, test } from "bun:test";
import { parseArgs, printColourAxis, stripColourModeArgs } from "../scripts/sweep";
import { forcedColorChildEnv, renderWithForcedColor } from "./helpers/color";
import { renderDocumentDetailed } from "../src/render";

describe("renderWithForcedColor", () => {
  const unsupportedLangFence = "```dataviewjs\nconsole.log(1)\n```\n";

  // DEVIATION, WP-3: this assertion is flipped from WP-1's original. `dataviewjs` used
  // to leak a highlight.js "language not found" diagnostic even under forced color —
  // that was the very bug this harness was built to make visible (see the module doc
  // comment in `tests/helpers/color.ts`). WP-3 fixes it: every fence language is now
  // normalized to one highlight.js supports before it reaches the gated `highlight()`
  // path (`src/lang.ts`), so no fence language reaches stderr any more, not even this
  // one, not even under forced color. Leaving the old assertion in place would mean
  // this test only passes when the bug it exists to catch is still present — i.e. it
  // would now fail forever by design, not by defect. A positive control proving the
  // console.error capture mechanism itself still works when a message *is* genuinely
  // emitted (calling the owned colorizer directly, bypassing the now-total normalization)
  // lives in `tests/render.test.ts`, so this flip cannot pass vacuously.
  test("a fence language that used to leak a highlight.js diagnostic under forced color now captures nothing (WP-3)", async () => {
    const { messages } = await renderWithForcedColor(unsupportedLangFence, 80);
    expect(messages).toEqual([]);
  });

  test("the normal (non-forced) render path captures nothing for the same input", () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      renderDocumentDetailed(unsupportedLangFence, 80);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
    expect(captured).toHaveLength(0);
  });

  /**
   * The helper's own non-vacuity, asserted on **observed output** rather than on the
   * environment it meant to set (WP-1 of `plans/colour-policy.md`).
   *
   * Every assertion built on `renderWithForcedColor` — the two above, and three in
   * `tests/lists.test.ts` — is about what a *coloured* render does. If the child ever came
   * back colourless the whole set would keep passing, silently, because a colourless render
   * simply never reaches the branches those tests are about. That is now a live risk in a
   * way it was not before: `MDVIEW_COLOR` and `NO_COLOR` both outrank the `FORCE_COLOR` the
   * helper sets, so an ambient one on a developer's machine or a CI runner would flip the
   * child. `forcedColorChildEnv` deletes both; this is the pin that the deletion works and
   * that the two modes really are opposite.
   */
  test("the forced-colour child and the in-process render resolve opposite modes", async () => {
    const saved = { mdview: process.env.MDVIEW_COLOR, no: process.env.NO_COLOR };
    try {
      // Both set *against* the mode the helper wants, so an inherited value would be
      // visible as a failure rather than as a quietly weaker test.
      process.env.MDVIEW_COLOR = "never";
      process.env.NO_COLOR = "1";
      // **The source carries a hue as well as a format, and that is required rather than
      // incidental since WP-2 of `plans/colour-modes.md`.** `MDVIEW_COLOR=never` is one of
      // the three explicit `never`-directive routes whose output that plan deliberately
      // moves (Decision 5): it resolves to `formats`, not to `none`, so the in-process
      // render is no longer colourless and the old `not.toContain("\u001b")` assertion
      // asserted the pre-WP-2 semantics. Bold alone would have made this case *vacuous* —
      // `bold` is format-class and `reset` is control-class, so `**loud** words` renders
      // byte-identically under `full` and `formats`. The codespan's yellow is hue-class, so
      // it is present on the forced side and absent on the ambient side, and the claim this
      // test is about — the two sides resolve **opposite** modes — is sharper than it was:
      // the boundary it now witnesses is the mode boundary itself.
      const source = "**loud** `words`\n";
      const { text: forced } = await renderWithForcedColor(source, 60);
      expect(forced).toContain("\u001b[1m");
      expect(forced).toContain("\u001b[33m");
      const ambient = renderDocumentDetailed(source, 60).text;
      expect(ambient).toContain("\u001b[1m");
      expect(ambient).not.toContain("\u001b[33m");
      expect(ambient).not.toBe(forced);
      // And the sanitizer is what makes it so, checked directly rather than only through
      // the child's behaviour.
      const env = forcedColorChildEnv({ MDVIEW_COLOR: "never", NO_COLOR: "1", FORCE_COLOR: "0" });
      expect("MDVIEW_COLOR" in env).toBe(false);
      expect("NO_COLOR" in env).toBe(false);
      expect(env.FORCE_COLOR).toBe("3");
    } finally {
      if (saved.mdview === undefined) delete process.env.MDVIEW_COLOR;
      else process.env.MDVIEW_COLOR = saved.mdview;
      if (saved.no === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = saved.no;
    }
  });
});

// The colour axis's CLI half (WP-1, `plans/own-the-token-walk.md`; three exact gates
// since WP-5, `plans/colour-policy.md`; the fourth `formats` child since WP-4,
// `plans/colour-modes.md`). The axis itself — the four children, the digests and the
// join — is `tests/colour-axis.test.ts`; what is pinned here is the flag surface, the
// passthrough that keeps every child looking at the same population, and the printed
// line's four counters.
describe("parseArgs: the colour axis flags (WP-1/WP-5/WP-4)", () => {
  test("the default is off, and every existing invocation is therefore unchanged", () => {
    const { options } = parseArgs([]);
    expect(options.colourMode).toBe("off");
    expect(options.colourChild).toBeUndefined();
  });

  test("--colour-mode takes on, off or both and rejects anything else", () => {
    expect(parseArgs(["--colour-mode", "on"]).options.colourMode).toBe("on");
    expect(parseArgs(["--colour-mode", "off"]).options.colourMode).toBe("off");
    expect(parseArgs(["--colour-mode", "both"]).options.colourMode).toBe("both");
    expect(() => parseArgs(["--colour-mode", "auto"])).toThrow(
      '--colour-mode must be "on", "off" or "both", got: auto',
    );
    expect(() => parseArgs(["--colour-mode"])).toThrow(
      '--colour-mode must be "on", "off" or "both", got: undefined',
    );
  });

  test("the flag is not spelled --color, and neither spelling is recognised", () => {
    // `has-flag`, which `supports-color` consulted and `@colors/colors` too until WP-2 of
    // `plans/colour-policy.md` removed both from the runtime closure, scans the whole of
    // `process.argv`. A harness flag spelled `--color` or `--no-color` therefore flipped the
    // ambient colour decision of the renderer under measurement — the instrument changing
    // the thing it reads. Neither package is installed now and the contract is unchanged for
    // a sharper reason: `--color` is `mdview`'s own flag and the top slot of the ratified
    // precedence matrix, so that spelling would be read by the renderer directly. Pinned as
    // a contract, not a style preference: this parser must never learn either spelling.
    expect(parseArgs(["--color"]).options.colourMode).toBe("off");
    expect(parseArgs(["--no-color"]).options.colourMode).toBe("off");
  });

  test("--max-char-diff and --max-sgr are gone: no such flag, no such option (WP-5)", () => {
    // Deleted, not renamed — their replacement is the three exact gates. An unknown flag
    // is silently ignored by this parser (documented behaviour, `parseArgs`'s own header),
    // so both spellings now fall straight through without turning the axis on or setting
    // anything: `colourMode` stays at its default and neither field exists on the type any
    // more (a compile-time check as much as a runtime one — see the deletion inventory in
    // `runs/dispatch/colour-policy-wp5-report.md`).
    const options = parseArgs(["--max-char-diff", "62", "--max-sgr", "20"]).options;
    expect(options.colourMode).toBe("off");
    expect("maxCharDiff" in options).toBe(false);
    expect("maxSgr" in options).toBe(false);
  });

  test("--colour-child is internal, validated, and accepts all four children (WP-5/WP-4)", () => {
    expect(parseArgs(["--colour-child", "on"]).options.colourChild).toBe("on");
    expect(parseArgs(["--colour-child", "off"]).options.colourChild).toBe("off");
    expect(parseArgs(["--colour-child", "default"]).options.colourChild).toBe("default");
    expect(parseArgs(["--colour-child", "formats"]).options.colourChild).toBe("formats");
    expect(() => parseArgs(["--colour-child", "both"])).toThrow(
      '--colour-child must be "on", "off", "default" or "formats", got: both',
    );
    expect(parseArgs(["--colour-mode", "both"]).options.colourChild).toBeUndefined();
  });
});

describe("stripColourModeArgs: what each child is handed (WP-1)", () => {
  test("only --colour-mode and its value are removed; every measurement flag survives", () => {
    expect(
      stripColourModeArgs([
        "--manifest",
        "example/manifest.json",
        "--colour-mode",
        "both",
        "--widths",
        "80,100",
        "--glyphs",
        "ascii",
        "--corpus",
        "repo",
        "--all",
      ]),
    ).toEqual([
      "--manifest",
      "example/manifest.json",
      "--widths",
      "80,100",
      "--glyphs",
      "ascii",
      "--corpus",
      "repo",
      "--all",
    ]);
  });

  test("an argv without the flag is passed through unchanged", () => {
    expect(stripColourModeArgs(["--widths", "80"])).toEqual(["--widths", "80"]);
    expect(stripColourModeArgs([])).toEqual([]);
  });
});

describe("printColourAxis prints the three exact gates and the join-error count (WP-5/WP-4)", () => {
  const axis = {
    corpus: "repo",
    combos: 110,
    g1: 0,
    g2: 0,
    g3: 0,
    g1Failures: [],
    g2Failures: [],
    g3Failures: [],
    errors: [],
    elapsedSeconds: 2.84,
  };

  test("the summary line carries combos and all four counters", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis(axis);
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toBe("[repo] colour-axis combos=110 g1=0 g2=0 g3=0 errors=0 elapsed=2.8s");
  });

  test("a G1 failure names the file, width and offending sequence", () => {
    // Written via `String.fromCharCode` and `JSON.stringify`, not typed literally, per
    // this repo's own sentinel convention — see `tests/colour-axis.test.ts`'s `ESC`.
    const esc = String.fromCharCode(27);
    const raw = `${esc}[31m`;
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        g1: 1,
        g1Failures: [{ corpus: "repo", file: "/example/a.md", width: 80, sequences: [{ kind: "sgr", raw }], malformed: false }],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toContain("g1=1");
    expect(captured[1]).toBe(`  colour-axis g1 width=80 /example/a.md: sequences=[sgr:${JSON.stringify(raw)}]`);
  });

  test("a G2 failure names the file, width, pair and the two visible-text hashes", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        g2: 1,
        g2Failures: [
          { corpus: "repo", file: "/example/a.md", width: 80, pair: "on-off", leftVisibleSha: "aaa", rightVisibleSha: "bbb" },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toContain("g2=1");
    expect(captured[1]).toBe("  colour-axis g2 width=80 /example/a.md: pair=on-off left=aaa right=bbb");
  });

  test("a G2 failure on the formats/off pair prints that pair's name (WP-4)", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        g2: 1,
        g2Failures: [
          {
            corpus: "repo",
            file: "/example/a.md",
            width: 80,
            pair: "formats-off",
            leftVisibleSha: "ccc",
            rightVisibleSha: "ddd",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[1]).toBe("  colour-axis g2 width=80 /example/a.md: pair=formats-off left=ccc right=ddd");
  });

  test("a G3 failure on the on child names the file, width, child, sequence and reason", () => {
    const originalLog = console.log;
    const esc = String.fromCharCode(27);
    const raw = `${esc}[92m`;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        g3: 1,
        g3Failures: [
          {
            corpus: "repo",
            file: "/example/a.md",
            width: 80,
            child: "on",
            sequence: { kind: "sgr", raw },
            reason: "sgr not in the committed style table",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toContain("g3=1");
    expect(captured[1]).toBe(
      `  colour-axis g3 width=80 /example/a.md: child=on sgr:${JSON.stringify(raw)} — sgr not in the committed style table`,
    );
  });

  test("a G3 failure on the formats child names its own child and vocabulary reason (WP-4)", () => {
    const originalLog = console.log;
    const esc = String.fromCharCode(27);
    const raw = `${esc}[31m`;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        g3: 1,
        g3Failures: [
          {
            corpus: "repo",
            file: "/example/a.md",
            width: 80,
            child: "formats",
            sequence: { kind: "sgr", raw },
            reason: "sgr not in the committed format/control vocabulary",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[1]).toBe(
      `  colour-axis g3 width=80 /example/a.md: child=formats sgr:${JSON.stringify(raw)} — sgr not in the committed format/control vocabulary`,
    );
  });

  test("a join-level error is printed under the line, mode-tagged, not folded into a gate", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        errors: [{ mode: "default", corpus: "repo", file: "/example/a.md", width: 80, reason: "missing" }],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toContain("errors=1");
    expect(captured[1]).toBe("  colour-axis error mode=default width=80 /example/a.md: missing");
  });

  test("a child-error carries its own message alongside the reason", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        errors: [
          {
            mode: "off",
            corpus: "repo",
            file: "/example/a.md",
            width: 80,
            reason: "child-error",
            message: "width 80: boom",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[1]).toBe("  colour-axis error mode=off width=80 /example/a.md: child-error (width 80: boom)");
  });
});
