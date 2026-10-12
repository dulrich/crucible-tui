import { describe, expect, test } from "bun:test";
import { parseArgs, printColourAxis, stripColourModeArgs } from "../scripts/sweep";

// The forced-colour subprocess fixture (`tests/helpers/color.ts`) and its `renderWithForcedColor`
// block were deleted with the TypeScript renderer at WP-9 of `plans/mdview-rust-port.md`
// (`TS_BASELINE` = `c097c66`): the policy-from-environment claim they pinned is now
// `tests/colour-axis.test.ts`'s, against the built binary.
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
