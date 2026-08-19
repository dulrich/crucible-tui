import { describe, expect, test } from "bun:test";
import {
  parseColourDirective,
  parseForceColor,
  resolveColor,
  resolveColourPolicy,
  resolveHyperlinks,
  type EnvironmentLike,
} from "../src/colour";

/**
 * The colour and hyperlink resolver, in full.
 *
 * **Every case here runs in this process, and that is the headline result of WP-1 of
 * `plans/colour-policy.md` rather than a convenience.** The behaviour these cases cover
 * used to live in `supports-color` and `supports-hyperlinks`, both of which resolve at
 * module load from `process.env` and `process.argv`, so the only way to test an
 * environment case was to spawn a subprocess with the variable set before its module graph
 * loaded — which is why `tests/inline.test.ts` carried five such subprocesses and
 * `tests/helpers/color.ts` carries a long note about why. The resolver is a pure function
 * of a record now. A subprocess proves nothing it cannot, and costs a process.
 *
 * The `FORCE_COLOR` triple and the hyperlink branch list are **ratified policy**
 * (Decisions 2 and 4), not this file's inventions: they were fixed by the user on
 * 2026-08-18, and a change to any of these expectations is a change to the spec.
 */

/** A terminal with nothing else set — `auto`'s floor answering yes. */
const TTY: EnvironmentLike = {};

describe("parseColourDirective — the shared spelling of every colour setting", () => {
  test("the three directives, exactly", () => {
    expect(parseColourDirective("auto")).toBe("auto");
    expect(parseColourDirective("always")).toBe("always");
    expect(parseColourDirective("never")).toBe("never");
  });

  test("case and surrounding whitespace are forgiven, matching the config module's leniency", () => {
    expect(parseColourDirective("ALWAYS")).toBe("always");
    expect(parseColourDirective("  Never  ")).toBe("never");
  });

  test("absent, empty and unrecognised are all 'not a directive'", () => {
    expect(parseColourDirective(undefined)).toBeUndefined();
    expect(parseColourDirective("")).toBeUndefined();
    expect(parseColourDirective("yes")).toBeUndefined();
    expect(parseColourDirective("1")).toBeUndefined();
  });
});

describe("parseForceColor — the three ratified edges", () => {
  test("'0' and 'false' are an explicit no", () => {
    expect(parseForceColor("0")).toBe("never");
    expect(parseForceColor("false")).toBe("never");
  });

  test("empty, 'true' and 1-3 are an explicit yes — presence is the signal", () => {
    expect(parseForceColor("")).toBe("always");
    expect(parseForceColor("true")).toBe("always");
    expect(parseForceColor("1")).toBe("always");
    expect(parseForceColor("2")).toBe("always");
    expect(parseForceColor("3")).toBe("always");
  });

  test("malformed values decide nothing and fall through to the next slot", () => {
    // **This is the edge where a 'byte-for-byte compatible with supports-color' claim would
    // have been false, and the plan says so.** That library runs a malformed value through
    // `parseInt`, gets NaN, and carries on into its TERM/CI/COLORTERM table — so its answer
    // for `garbage` is whatever the rest of the environment says. mdview has no such table
    // to fall into, so the value simply decides nothing.
    expect(parseForceColor("garbage")).toBeUndefined();
    expect(parseForceColor("-1")).toBeUndefined();
    expect(parseForceColor("4")).toBeUndefined();
    expect(parseForceColor("00")).toBeUndefined();
    // Untrimmed on purpose: a variable carrying whitespace was not set deliberately.
    expect(parseForceColor(" 1")).toBeUndefined();
  });

  test("absent is absent, which is not the same as malformed but resolves the same way", () => {
    expect(parseForceColor(undefined)).toBeUndefined();
  });
});

describe("resolveColor — the precedence table, slot by slot", () => {
  test("the floor: isTTY decides when nothing else says anything", () => {
    expect(resolveColor({ isTTY: true })).toBe(true);
    expect(resolveColor({ isTTY: false })).toBe(false);
    // An omitted `isTTY` is the safe direction, not an unknown one.
    expect(resolveColor({})).toBe(false);
  });

  test("slot 1 — the flag decides, and beats everything below it", () => {
    expect(resolveColor({ flag: "always", isTTY: false, env: { NO_COLOR: "1" } })).toBe(true);
    expect(resolveColor({ flag: "never", isTTY: true, env: { FORCE_COLOR: "3" } })).toBe(false);
  });

  test("slot 1 — the flag's 'auto' decides nothing and falls through", () => {
    expect(resolveColor({ flag: "auto", isTTY: true })).toBe(true);
    expect(resolveColor({ flag: "auto", isTTY: false })).toBe(false);
    expect(resolveColor({ flag: "auto", isTTY: false, env: { MDVIEW_COLOR: "always" } })).toBe(true);
  });

  test("slot 2 — MDVIEW_COLOR decides, and beats NO_COLOR below it", () => {
    expect(resolveColor({ env: { MDVIEW_COLOR: "always" }, isTTY: false })).toBe(true);
    expect(resolveColor({ env: { MDVIEW_COLOR: "never" }, isTTY: true })).toBe(false);
    expect(resolveColor({ env: { MDVIEW_COLOR: "always", NO_COLOR: "1" }, isTTY: false })).toBe(true);
  });

  test("slot 2 — MDVIEW_COLOR=auto falls through; malformed is noted and ignored", () => {
    expect(resolveColor({ env: { MDVIEW_COLOR: "auto", FORCE_COLOR: "3" }, isTTY: false })).toBe(true);
    const notes: string[] = [];
    expect(resolveColor({ env: { MDVIEW_COLOR: "sometimes" }, isTTY: true, warn: (m) => notes.push(m) })).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("MDVIEW_COLOR");
  });

  test("slot 2 — an empty MDVIEW_COLOR is malformed, not a directive", () => {
    const notes: string[] = [];
    expect(resolveColor({ env: { MDVIEW_COLOR: "" }, isTTY: true, warn: (m) => notes.push(m) })).toBe(true);
    expect(notes).toHaveLength(1);
  });

  test("slot 3 — NO_COLOR counts by presence, even empty", () => {
    // no-color.org's rule verbatim, and honoured here for the first time: the tool shipped
    // for its whole life with a `NO_COLOR` nothing in the stack read.
    expect(resolveColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe(false);
    expect(resolveColor({ env: { NO_COLOR: "0" }, isTTY: true })).toBe(false);
    expect(resolveColor({ env: { NO_COLOR: "false" }, isTTY: true })).toBe(false);
  });

  test("slot 3 — NO_COLOR beats FORCE_COLOR, which is the one ordering worth naming", () => {
    // A user who exported NO_COLOR said something about this machine; a FORCE_COLOR
    // inherited from some parent process did not.
    expect(resolveColor({ env: { NO_COLOR: "1", FORCE_COLOR: "3" }, isTTY: false })).toBe(false);
  });

  test("slot 4 — FORCE_COLOR decides when well-formed, falls through when not", () => {
    expect(resolveColor({ env: { FORCE_COLOR: "3" }, isTTY: false })).toBe(true);
    expect(resolveColor({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe(false);
    // Malformed: the config slot below gets its turn, and then the TTY floor.
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, config: "always", isTTY: false })).toBe(true);
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, isTTY: true })).toBe(true);
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, isTTY: false })).toBe(false);
  });

  test("slot 5 — the config file decides only when nothing above it did", () => {
    expect(resolveColor({ config: "always", isTTY: false })).toBe(true);
    expect(resolveColor({ config: "never", isTTY: true })).toBe(false);
    expect(resolveColor({ config: "auto", isTTY: true })).toBe(true);
    expect(resolveColor({ config: "auto", isTTY: false })).toBe(false);
    // Everything above it wins.
    expect(resolveColor({ config: "never", flag: "always", isTTY: false })).toBe(true);
    expect(resolveColor({ config: "never", env: { FORCE_COLOR: "1" }, isTTY: false })).toBe(true);
  });

  test("the whole ladder in one case: every slot present, the top one wins", () => {
    expect(
      resolveColor({
        flag: "never",
        config: "always",
        env: { MDVIEW_COLOR: "always", NO_COLOR: "", FORCE_COLOR: "3" },
        isTTY: true,
      }),
    ).toBe(false);
  });

  test("nothing is read from the real process — an empty input answers false", () => {
    // The regression pin for the whole package: this test process has an environment and a
    // command line, and neither may reach the resolver except through its argument.
    expect(resolveColor()).toBe(false);
  });
});

describe("resolveHyperlinks — the non-TTY ceiling", () => {
  test("off a terminal, always off, whatever else is set", () => {
    expect(resolveHyperlinks({ isTTY: false, env: { MDVIEW_HYPERLINKS: "always" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: false, env: { WT_SESSION: "x" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: false, env: { TERM: "alacritty" } })).toBe(false);
    expect(resolveHyperlinks({})).toBe(false);
  });

  test("NO_COLOR and a forced colour decision do not touch the hyperlink axis", () => {
    // Ratified as independent (Decision 4). The retired library asked `supportsColor` first
    // and answered no whenever colour was off; that prerequisite is deleted by name.
    expect(resolveHyperlinks({ isTTY: true, env: { NO_COLOR: "1", TERM: "alacritty" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { FORCE_COLOR: "3" } })).toBe(false);
  });
});

describe("resolveHyperlinks — MDVIEW_HYPERLINKS", () => {
  test("always and never decide on a terminal", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "always" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "never", TERM: "alacritty" } })).toBe(false);
  });

  test("auto hands over to detection", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "auto", TERM: "alacritty" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "auto" } })).toBe(false);
  });

  test("malformed is noted and ignored, exactly as MDVIEW_COLOR is", () => {
    const notes: string[] = [];
    expect(
      resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "maybe", TERM: "alacritty" }, warn: (m) => notes.push(m) }),
    ).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("MDVIEW_HYPERLINKS");
  });
});

describe("resolveHyperlinks — every retained branch, positive and negative", () => {
  test("WT_SESSION turns them on, ahead of the win32 refusal below it", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { WT_SESSION: "abc" }, platform: "win32" })).toBe(true);
    // Presence, not truthiness: Windows Terminal sets it to a GUID, and an empty one is
    // still Windows Terminal.
    expect(resolveHyperlinks({ isTTY: true, env: { WT_SESSION: "" }, platform: "win32" })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: {}, platform: "win32" })).toBe(false);
  });

  test("platform is an explicit input, never a hidden process.platform read", () => {
    // The whole reason it is a parameter: this branch is unreachable on the machine that
    // runs these gates, and an unreachable branch is the one that rots.
    expect(resolveHyperlinks({ isTTY: true, env: { TERM: "alacritty" }, platform: "win32" })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { TERM: "alacritty" }, platform: "linux" })).toBe(true);
  });

  test("CI and TEAMCITY_VERSION turn them off", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { CI: "true", TERM: "alacritty" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { TEAMCITY_VERSION: "2024.1", TERM: "alacritty" } })).toBe(false);
    // Truthiness, matching the transcribed source: an empty CI is not a CI.
    expect(resolveHyperlinks({ isTTY: true, env: { CI: "", TERM: "alacritty" } })).toBe(true);
  });

  test("iTerm.app — on from 3.1, off below it, on for every later major", () => {
    const iterm = (version: string): boolean =>
      resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "iTerm.app", TERM_PROGRAM_VERSION: version } });
    expect(iterm("3.0.9")).toBe(false);
    expect(iterm("3.1.0")).toBe(true);
    expect(iterm("3.4.19")).toBe(true);
    expect(iterm("2.9.9")).toBe(false);
    expect(iterm("4.0.0")).toBe(true);
    // No version at all parses to NaN, every comparison is false, and the answer is no.
    expect(resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "iTerm.app" } })).toBe(false);
  });

  test("WezTerm — on from the 20200620 date-major, off below it", () => {
    const wez = (version: string): boolean =>
      resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "WezTerm", TERM_PROGRAM_VERSION: version } });
    expect(wez("20200619-000000-000000")).toBe(false);
    expect(wez("20200620-160318-e00b076c")).toBe(true);
    expect(wez("20240203-110809-5046fc22")).toBe(true);
  });

  test("vscode — on from 1.72, off below it", () => {
    const code = (version: string): boolean =>
      resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: version } });
    expect(code("1.71.2")).toBe(false);
    expect(code("1.72.0")).toBe(true);
    expect(code("2.0.0")).toBe(true);
  });

  test("ghostty — on unconditionally, version or no version", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "ghostty" } })).toBe(true);
    expect(
      resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "ghostty", TERM_PROGRAM_VERSION: "0.1" } }),
    ).toBe(true);
  });

  test("an unrecognised TERM_PROGRAM falls through rather than answering", () => {
    // Load-bearing: a VTE terminal that also sets TERM_PROGRAM would otherwise lose its own
    // branch. Same source shape as upstream's switch with no default.
    expect(
      resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "SomethingElse", VTE_VERSION: "6003" } }),
    ).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { TERM_PROGRAM: "SomethingElse" } })).toBe(false);
  });

  test("VTE — 0.50.0 exactly is off, the recorded segfault", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "0.50.0" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "0.50.1" } })).toBe(true);
  });

  test("VTE — the dotted form compares on minor, from 0.50", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "0.49.9" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "0.52.0" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "1.0.0" } })).toBe(true);
  });

  test("VTE — the compact 3-4 digit form is 0.MM.PP, not a four-digit major", () => {
    // `4601` means 46.1.0 — major **zero**. Reading it as major 4601 would answer yes for
    // every GNOME-family terminal ever released, including the ones that cannot do this.
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "6003" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "5000" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "4601" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "490" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { VTE_VERSION: "7600" } })).toBe(true);
  });

  test("TERM=alacritty is the last yes; anything else is no", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { TERM: "alacritty" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { TERM: "xterm-256color" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: TTY })).toBe(false);
  });

  test("the deleted inputs are inert — FORCE_HYPERLINK and NETLIFY decide nothing", () => {
    // Both were live in the retired library and are deleted by name (Decision 4).
    // NETLIFY's bypass ran *before* the stream check and returned true, which contradicts
    // the ratified non-TTY ceiling outright.
    expect(resolveHyperlinks({ isTTY: true, env: { FORCE_HYPERLINK: "1" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: false, env: { NETLIFY: "true" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, env: { NETLIFY: "true" } })).toBe(false);
  });
});

describe("resolveColourPolicy — the two axes together", () => {
  test("a pipe with nothing set: no colour, no hyperlinks", () => {
    expect(resolveColourPolicy({ env: {}, isTTY: false })).toEqual({ color: false, hyperlinks: false });
  });

  test("a forced colour on a pipe does not invent hyperlink support", () => {
    expect(resolveColourPolicy({ flag: "always", env: {}, isTTY: false })).toEqual({
      color: true,
      hyperlinks: false,
    });
  });

  test("a capable terminal with NO_COLOR keeps its hyperlinks", () => {
    expect(resolveColourPolicy({ env: { NO_COLOR: "1", TERM: "alacritty" }, isTTY: true })).toEqual({
      color: false,
      hyperlinks: true,
    });
  });

  test("called with no argument at all it answers the safe way, reading nothing", () => {
    expect(resolveColourPolicy()).toEqual({ color: false, hyperlinks: false });
  });
});
