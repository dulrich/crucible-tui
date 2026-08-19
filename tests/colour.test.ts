import { describe, expect, test } from "bun:test";
import {
  parseColourDirective,
  parseForceColor,
  resolveColor,
  resolveColourPolicy,
  resolveHyperlinks,
  resolveTmux,
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
  /**
   * **The precedence order is untouched by WP-2 of `plans/colour-modes.md`; only what a
   * slot's "no" *means* moved** (Decisions 4-5). Each case below keeps the exact input it
   * had when it was a boolean assertion, so the ladder itself is still under test at the
   * same points — what changed is the expected value, from `true`/`false` to one of the
   * three `SgrMode`s, and the change is only ever `false` -> `"formats"` on the three
   * explicit `never`-directive routes (`--color=never`, `MDVIEW_COLOR=never`, config
   * `never`). Every kill-switch case (`NO_COLOR` presence, `FORCE_COLOR=0`) and the TTY
   * floor still read `"none"`, which is the boolean `false` these cases used to assert.
   */
  test("the floor: isTTY decides when nothing else says anything", () => {
    expect(resolveColor({ isTTY: true })).toBe("full");
    expect(resolveColor({ isTTY: false })).toBe("none");
    // An omitted `isTTY` is the safe direction, not an unknown one.
    expect(resolveColor({})).toBe("none");
  });

  test("slot 1 — the flag decides, and beats everything below it", () => {
    expect(resolveColor({ flag: "always", isTTY: false, env: { NO_COLOR: "1" } })).toBe("full");
    // **A byte-moving route** (Decision 5): an explicit `never` directive is format-preserving.
    expect(resolveColor({ flag: "never", isTTY: true, env: { FORCE_COLOR: "3" } })).toBe("formats");
  });

  test("slot 1 — the flag's 'auto' decides nothing and falls through", () => {
    expect(resolveColor({ flag: "auto", isTTY: true })).toBe("full");
    expect(resolveColor({ flag: "auto", isTTY: false })).toBe("none");
    expect(resolveColor({ flag: "auto", isTTY: false, env: { MDVIEW_COLOR: "always" } })).toBe("full");
  });

  test("slot 2 — MDVIEW_COLOR decides, and beats NO_COLOR below it", () => {
    expect(resolveColor({ env: { MDVIEW_COLOR: "always" }, isTTY: false })).toBe("full");
    // The second byte-moving route.
    expect(resolveColor({ env: { MDVIEW_COLOR: "never" }, isTTY: true })).toBe("formats");
    expect(resolveColor({ env: { MDVIEW_COLOR: "always", NO_COLOR: "1" }, isTTY: false })).toBe("full");
  });

  test("slot 2 — MDVIEW_COLOR=auto falls through; malformed is noted and ignored", () => {
    expect(resolveColor({ env: { MDVIEW_COLOR: "auto", FORCE_COLOR: "3" }, isTTY: false })).toBe("full");
    const notes: string[] = [];
    expect(resolveColor({ env: { MDVIEW_COLOR: "sometimes" }, isTTY: true, warn: (m) => notes.push(m) })).toBe("full");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("MDVIEW_COLOR");
  });

  test("slot 2 — an empty MDVIEW_COLOR is malformed, not a directive", () => {
    const notes: string[] = [];
    expect(resolveColor({ env: { MDVIEW_COLOR: "" }, isTTY: true, warn: (m) => notes.push(m) })).toBe("full");
    expect(notes).toHaveLength(1);
  });

  test("slot 3 — NO_COLOR counts by presence, even empty", () => {
    // no-color.org's rule verbatim, and honoured here for the first time: the tool shipped
    // for its whole life with a `NO_COLOR` nothing in the stack read.
    expect(resolveColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe("none");
    expect(resolveColor({ env: { NO_COLOR: "0" }, isTTY: true })).toBe("none");
    expect(resolveColor({ env: { NO_COLOR: "false" }, isTTY: true })).toBe("none");
  });

  test("slot 3 — NO_COLOR beats FORCE_COLOR, which is the one ordering worth naming", () => {
    // A user who exported NO_COLOR said something about this machine; a FORCE_COLOR
    // inherited from some parent process did not.
    expect(resolveColor({ env: { NO_COLOR: "1", FORCE_COLOR: "3" }, isTTY: false })).toBe("none");
  });

  test("slot 4 — FORCE_COLOR decides when well-formed, falls through when not", () => {
    expect(resolveColor({ env: { FORCE_COLOR: "3" }, isTTY: false })).toBe("full");
    expect(resolveColor({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe("none");
    // Malformed: the config slot below gets its turn, and then the TTY floor.
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, config: "always", isTTY: false })).toBe("full");
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, isTTY: true })).toBe("full");
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, isTTY: false })).toBe("none");
  });

  test("slot 5 — the config file decides only when nothing above it did", () => {
    expect(resolveColor({ config: "always", isTTY: false })).toBe("full");
    // The third and last byte-moving route.
    expect(resolveColor({ config: "never", isTTY: true })).toBe("formats");
    expect(resolveColor({ config: "auto", isTTY: true })).toBe("full");
    expect(resolveColor({ config: "auto", isTTY: false })).toBe("none");
    // Everything above it wins.
    expect(resolveColor({ config: "never", flag: "always", isTTY: false })).toBe("full");
    expect(resolveColor({ config: "never", env: { FORCE_COLOR: "1" }, isTTY: false })).toBe("full");
  });

  test("the whole ladder in one case: every slot present, the top one wins", () => {
    expect(
      resolveColor({
        flag: "never",
        config: "always",
        env: { MDVIEW_COLOR: "always", NO_COLOR: "", FORCE_COLOR: "3" },
        isTTY: true,
      }),
    ).toBe("formats");
  });

  test("nothing is read from the real process — an empty input answers none", () => {
    // The regression pin for the whole package: this test process has an environment and a
    // command line, and neither may reach the resolver except through its argument.
    expect(resolveColor()).toBe("none");
  });
});

/**
 * **Decision 5, stated as a test rather than only as prose**: the format-preserving mode is
 * reachable by the three explicit `never` directives and by nothing else, and every
 * kill-switch keeps today's `"none"`.
 *
 * This is the non-vacuity guard for the whole byte-movement claim of WP-2. If a future edit
 * makes `NO_COLOR` resolve to `"formats"`, the ratified kill-switch contract is broken and
 * bytes move on an input no plan authorized — and the per-slot cases above would each still
 * pass individually, because each one asserts one slot. This asserts the *partition*.
 */
describe("resolveColor — the exhaustive list of routes that reach `formats` (Decision 5)", () => {
  test("the three explicit `never` directives, and only those three", () => {
    expect(resolveColor({ flag: "never" })).toBe("formats");
    expect(resolveColor({ env: { MDVIEW_COLOR: "never" } })).toBe("formats");
    expect(resolveColor({ config: "never" })).toBe("formats");
  });

  test("every kill-switch and every unrequested route stays `none`, exactly as today", () => {
    // Kill-switches: an established cross-tool convention with an installed base.
    expect(resolveColor({ env: { NO_COLOR: "" }, isTTY: true })).toBe("none");
    expect(resolveColor({ env: { FORCE_COLOR: "0" }, isTTY: true })).toBe("none");
    expect(resolveColor({ env: { FORCE_COLOR: "false" }, isTTY: true })).toBe("none");
    // Nothing requested at all, off a terminal — the landed G1 gate's input (Decision 4).
    expect(resolveColor({ isTTY: false })).toBe("none");
    expect(resolveColor({ flag: "auto", isTTY: false })).toBe("none");
    expect(resolveColor({ env: { MDVIEW_COLOR: "auto" }, isTTY: false })).toBe("none");
    expect(resolveColor({ config: "auto", isTTY: false })).toBe("none");
    // A malformed value decides nothing, so it cannot reach `formats` either.
    expect(resolveColor({ env: { MDVIEW_COLOR: "sometimes" }, isTTY: false })).toBe("none");
    expect(resolveColor({ env: { FORCE_COLOR: "garbage" }, isTTY: false })).toBe("none");
  });

  test("`always` at every slot is `full`, so the top of the ladder did not move either", () => {
    expect(resolveColor({ flag: "always" })).toBe("full");
    expect(resolveColor({ env: { MDVIEW_COLOR: "always" } })).toBe("full");
    expect(resolveColor({ env: { FORCE_COLOR: "3" } })).toBe("full");
    expect(resolveColor({ config: "always" })).toBe("full");
    expect(resolveColor({ isTTY: true })).toBe("full");
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

/**
 * `flag`/`config` on `HyperlinkInput` (WP-3 of `plans/colour-modes.md`, Decision 6,
 * cycle-3 f5's exact type relationship). One case per matrix row of the hyperlink axis,
 * highest precedence first: the non-TTY ceiling (already covered above, and re-asserted
 * here against the two new slots for completeness) → `flag` → `MDVIEW_HYPERLINKS` → `config`
 * → terminal detection. `--plain`'s own row is a CLI-boundary short-circuit rather than a
 * slot in this ladder — it never calls this function at all — and is tested at
 * `tests/cli.test.ts`'s `main` level instead.
 */
describe("resolveHyperlinks — flag and config (WP-3 of plans/colour-modes.md, Decision 6)", () => {
  test("the non-TTY ceiling stays absolute over flag and config both", () => {
    expect(resolveHyperlinks({ isTTY: false, flag: "always" })).toBe(false);
    expect(resolveHyperlinks({ isTTY: false, config: "always" })).toBe(false);
    expect(resolveHyperlinks({ isTTY: false, flag: "always", config: "always" })).toBe(false);
  });

  test("flag decides, and beats everything below it — env, config and terminal detection alike", () => {
    expect(resolveHyperlinks({ isTTY: true, flag: "always", env: { MDVIEW_HYPERLINKS: "never" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, flag: "never", env: { MDVIEW_HYPERLINKS: "always" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, flag: "never", env: { TERM: "alacritty" } })).toBe(false);
    expect(resolveHyperlinks({ isTTY: true, flag: "always", config: "never" })).toBe(true);
  });

  test("flag's 'auto' decides nothing and falls through to the env slot", () => {
    expect(resolveHyperlinks({ isTTY: true, flag: "auto", env: { MDVIEW_HYPERLINKS: "always" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, flag: "auto", env: { TERM: "alacritty" } })).toBe(true);
  });

  test("MDVIEW_HYPERLINKS decides when flag does not, and beats config below it", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "always" }, config: "never" })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, env: { MDVIEW_HYPERLINKS: "never" }, config: "always" })).toBe(false);
  });

  test("config decides only when flag and env both say nothing", () => {
    expect(resolveHyperlinks({ isTTY: true, config: "always" })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, config: "never", env: { TERM: "alacritty" } })).toBe(false);
    // 'auto' at config falls through to terminal detection, same as every other slot.
    expect(resolveHyperlinks({ isTTY: true, config: "auto", env: { TERM: "alacritty" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true, config: "auto" })).toBe(false);
  });

  test("terminal detection is the floor, exactly as before this WP", () => {
    expect(resolveHyperlinks({ isTTY: true, env: { TERM: "alacritty" } })).toBe(true);
    expect(resolveHyperlinks({ isTTY: true })).toBe(false);
  });

  test("the whole ladder in one case: flag, env, config and detection all present, flag wins", () => {
    expect(
      resolveHyperlinks({
        isTTY: true,
        flag: "never",
        env: { MDVIEW_HYPERLINKS: "always" },
        config: "always",
      }),
    ).toBe(false);
  });
});

describe("resolveColourPolicy — the two axes together", () => {
  test("a pipe with nothing set: no colour, no hyperlinks", () => {
    expect(resolveColourPolicy({ env: {}, isTTY: false })).toEqual({
      sgr: "none",
      hyperlinks: false,
      tmux: false,
    });
  });

  test("a forced colour on a pipe does not invent hyperlink support", () => {
    expect(resolveColourPolicy({ flag: "always", env: {}, isTTY: false })).toEqual({
      sgr: "full",
      hyperlinks: false,
      tmux: false,
    });
  });

  test("a capable terminal with NO_COLOR keeps its hyperlinks", () => {
    expect(resolveColourPolicy({ env: { NO_COLOR: "1", TERM: "alacritty" }, isTTY: true })).toEqual({
      sgr: "none",
      hyperlinks: true,
      tmux: false,
    });
  });

  test("called with no argument at all it answers the safe way, reading nothing", () => {
    expect(resolveColourPolicy()).toEqual({ sgr: "none", hyperlinks: false, tmux: false });
  });
});

/**
 * `hyperlinkFlag`/`hyperlinkConfig` on `ColourPolicyInput`, mapped into the `HyperlinkInput`
 * this function hands `resolveHyperlinks` (WP-3 of `plans/colour-modes.md`, Decision 6).
 * `resolveHyperlinks`'s own precedence is `tests/colour.test.ts`'s describe block above this
 * one; these cases are about the mapping itself, and about the two axes staying independent
 * through **one** input object — the conflict-test requirement (`--color=always
 * --hyperlinks=never` and the converse) the plan asks for.
 */
describe("resolveColourPolicy — hyperlinkFlag/hyperlinkConfig mapping (WP-3 of plans/colour-modes.md)", () => {
  test("hyperlinkFlag reaches resolveHyperlinks as its flag", () => {
    expect(resolveColourPolicy({ isTTY: true, hyperlinkFlag: "always" }).hyperlinks).toBe(true);
    expect(resolveColourPolicy({ isTTY: true, hyperlinkFlag: "never" }).hyperlinks).toBe(false);
  });

  test("hyperlinkConfig reaches resolveHyperlinks as its config, below hyperlinkFlag", () => {
    expect(resolveColourPolicy({ isTTY: true, hyperlinkConfig: "always" }).hyperlinks).toBe(true);
    expect(
      resolveColourPolicy({ isTTY: true, hyperlinkFlag: "never", hyperlinkConfig: "always" }).hyperlinks,
    ).toBe(false);
  });

  test("--color=always --hyperlinks=never through one input object: colour on, hyperlinks off", () => {
    expect(resolveColourPolicy({ flag: "always", hyperlinkFlag: "never", isTTY: true })).toEqual({
      sgr: "full",
      hyperlinks: false,
      tmux: false,
    });
  });

  test("the converse — --color=never --hyperlinks=always through one input object: hue dropped, hyperlinks on", () => {
    expect(resolveColourPolicy({ flag: "never", hyperlinkFlag: "always", isTTY: true })).toEqual({
      sgr: "formats",
      hyperlinks: true,
      tmux: false,
    });
  });

  test("regular color flag/config do not leak into the hyperlink axis, and vice versa", () => {
    // `flag`/`config` decide `sgr`; `hyperlinkFlag`/`hyperlinkConfig` decide `hyperlinks`.
    // Neither axis's slot is consulted by the other's resolver — each of these on-a-terminal
    // cases is decided by the *other* axis's own floor (isTTY for colour, terminal detection
    // for hyperlinks), not by the flag this case sets for the axis it is not testing.
    expect(resolveColourPolicy({ flag: "never", isTTY: true }).hyperlinks).toBe(false);
    expect(resolveColourPolicy({ hyperlinkFlag: "always", isTTY: false }).sgr).toBe("none");
  });
});

describe("resolveTmux — the destination fact the OSC-8 emitter needs (WP-3)", () => {
  test("TMUX present, whatever TERM says", () => {
    expect(resolveTmux({ TMUX: "/tmp/tmux-1000/default,123,0" })).toBe(true);
    expect(resolveTmux({ TMUX: "", TERM: "xterm-256color" })).toBe(true);
  });

  test("the two TERM prefixes upstream matches, and only as prefixes", () => {
    expect(resolveTmux({ TERM: "tmux-256color" })).toBe(true);
    expect(resolveTmux({ TERM: "screen.xterm-256color" })).toBe(true);
    expect(resolveTmux({ TERM: "xterm-screen" })).toBe(false);
  });

  test("nothing set, and an unrelated terminal, are both false", () => {
    expect(resolveTmux({})).toBe(false);
    expect(resolveTmux({ TERM: "xterm-ghostty" })).toBe(false);
  });

  test("it rides the policy, so an injected environment decides it with no subprocess", () => {
    expect(resolveColourPolicy({ env: { TMUX: "x", TERM: "alacritty" }, isTTY: true }).tmux).toBe(true);
  });
});
