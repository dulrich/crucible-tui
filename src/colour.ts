/**
 * The one colour/hyperlink decision, made once, from inputs handed in explicitly.
 *
 * WP-1 of `plans/colour-policy.md`. Before this module there were five independent
 * authorities: `supports-color` (argv-sniffing at module load, no `NO_COLOR`),
 * `supports-hyperlinks` (its own load-time answer, plus a `FORCE_HYPERLINK` variable and
 * two argv flag families of its own), `@colors/colors`' environment-only `enabled` inside
 * `src/table.ts`, `cli-highlight`'s bundled `chalk` level, and `src/frontmatter.ts`
 * dimming unconditionally. They disagreed with each other and with the user's terminal.
 *
 * This module is the successor to the first two. It answers two questions —
 * *does this render emit SGR at all* and *does it emit OSC-8 hyperlinks* — and it answers
 * them from values passed in, never from a module-load read of the environment, argv or a
 * stream. `resolveColourPolicy` is a pure function of its input; the impurity lives at the
 * call sites that build that input, which is the same "config stays impure, render stays
 * pure and takes explicit values" split `glyphs` and `measure` already use
 * (`src/layout-context.ts`).
 *
 * **Nothing here reads `process`.** `platform` is an input for the same reason `env` and
 * `isTTY` are: a hidden `process.platform` read makes the Windows branches of hyperlink
 * detection untestable on this machine, and untestable branches are the ones that rot.
 *
 * What this module deliberately does **not** do: decide *which bytes* a style is, or emit
 * any. That is `src/style.ts`, which WP-2 built — and WP-2 is also what made this module's
 * answer the *only* one: it retired `@colors/colors` and `cli-highlight` from the tree, so
 * the third and fourth authorities above are gone rather than merely outranked, and the
 * fifth (`src/frontmatter.ts`) styles through the same emitter under this decision.
 *
 * **It stopped being on/off at WP-2 of `plans/colour-modes.md`** and is now a three-level
 * `SgrMode` — how *much* SGR, still never which bytes. The reason the widening is one line
 * of type here rather than a migration is that every SGR byte already passes through
 * `src/style.ts`'s committed table by *name*, so "drop hue, keep bold" is a filter over
 * that table and not a change to any producer.
 */

/** The three values every colour directive in this tool can take. */
export type ColourDirective = "auto" | "always" | "never";

/**
 * **The one canonical colour value** (WP-2 of `plans/colour-modes.md`, cycle-1 f7).
 *
 * Three levels, not two booleans, and the difference is the whole package: a pair of
 * independent flags (`color`, `hue`) can express `color=false, hue=true`, which is not a
 * state this renderer has, and every reader would then have to decide for itself which of
 * the two it meant. One value with three inhabitants makes the impossible state
 * unrepresentable and turns "which threshold does this reader use" into a question with a
 * written answer per reader (`src/AGENTS.md`, "The reader inventory").
 *
 * - `"full"` — every committed style emits: hue, format and control.
 * - `"formats"` — hue is dropped, format and control still emit (Decision 1: *`--no-color`
 *   means no hue, all other formatting preserved*; Decision 8: `reset` is control and
 *   emits whenever `sgr !== "none"`). Reachable **only** by the explicit `never` directive
 *   — flag, `MDVIEW_COLOR` or config — which is the exhaustive list of routes whose bytes
 *   this plan moves (Decision 5).
 * - `"none"` — this render emits no SGR of the tool's own at all. Authored escape bytes in
 *   the document are content and are untouched at every level, `none` included.
 *
 * The classification of a *style name* into hue/format/control is `src/style.ts`'s
 * `STYLE_CLASSES`, deliberately beside the committed table it classifies rather than here:
 * this module decides *how much* to emit, that one decides *which bytes* are which.
 */
export type SgrMode = "full" | "formats" | "none";

/**
 * The resolved decision for one render.
 *
 * Two independent axes, and their independence is the ratified spec (Decision 4):
 * `NO_COLOR` does not turn hyperlinks off, and a forced colour on a pipe does not turn
 * them on — a pipe has no hyperlink support to force.
 */
export interface ColourPolicy {
  /**
   * How much SGR this render emits.
   *
   * Was `color: boolean` until WP-2 of `plans/colour-modes.md`. The boolean survives one
   * level down, on `LayoutContext`, as a **constructor-derived** field
   * (`color === (sgr !== "none")`) — never as a second input.
   */
  readonly sgr: SgrMode;
  /** Whether this render emits OSC-8 hyperlinks. */
  readonly hyperlinks: boolean;
  /**
   * Whether the destination is inside tmux, which needs every OSC sequence wrapped in a
   * DCS envelope to pass it through (`resolveTmux`; emitted by `src/ansi.ts`'s `link`).
   * Not a second colour decision — a fact about the destination the emitter needs.
   */
  readonly tmux: boolean;
}

/** `process.env`-shaped, without being `process.env`. */
export type EnvironmentLike = Readonly<Record<string, string | undefined>>;

/** Everything the policy is resolved from — all of it passed in. */
export interface ColourPolicyInput {
  /** mdview's own `--color` flag, already parsed. **The only argv authority.** */
  readonly flag?: ColourDirective;
  /** The config file's `color` key (`src/config.ts`). */
  readonly config?: ColourDirective;
  /** The environment to read the four variables from. */
  readonly env?: EnvironmentLike;
  /** Whether the destination stream is a terminal. `auto`'s floor. */
  readonly isTTY?: boolean;
  /** `process.platform`'s value, passed rather than read. */
  readonly platform?: string;
  /**
   * Where a note about an ignored malformed value goes. Defaults to swallowing it:
   * the notes belong on the user-facing path (`src/cli.ts` passes a writer), not on
   * every library call that happens to render a document.
   */
  readonly warn?: (message: string) => void;
}

/** `resolveHyperlinks`' inputs — the plan's signature, exactly. */
export interface HyperlinkInput {
  readonly env?: EnvironmentLike;
  readonly isTTY?: boolean;
  readonly platform?: string;
  readonly warn?: (message: string) => void;
}

const NOOP = (): void => {};

/**
 * `auto`/`always`/`never`, or `undefined` for anything else.
 *
 * Trimmed and lowercased before matching, matching `src/config.ts`'s existing leniency
 * about how a hand-edited value was cased. An empty string is *not* a directive — it is
 * the malformed case, and the caller notes it.
 */
export function parseColourDirective(raw: string | undefined): ColourDirective | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "auto" || normalized === "always" || normalized === "never") return normalized;
  return undefined;
}

/**
 * `FORCE_COLOR`, as mdview policy rather than as a byte-for-byte copy of anything.
 *
 * The three edges are pinned in `tests/colour.test.ts` and were ratified by the user on
 * 2026-08-18:
 *
 * - `"0"` and `"false"` are an explicit **no**;
 * - `""`, `"true"` and `"1"`/`"2"`/`"3"` are an explicit **yes** — presence with no value
 *   is the signal, which is `supports-color@7.2.0`'s own reading;
 * - **anything else is not a directive at all** and falls through to the next slot.
 *
 * That last edge is where a "byte-for-byte compatible" claim would have been false.
 * `supports-color@7.2.0` runs `FORCE_COLOR=garbage` through `parseInt`, gets `NaN`, and
 * carries on into its `TERM`/`CI`/`COLORTERM` table — so *its* answer for a malformed
 * value is whatever the rest of the environment says. Reproducing that would mean
 * reproducing the whole detection table this plan exists to delete. Falling through to
 * the next slot is the same shape of answer (the value decided nothing) without the
 * table, and it is the behaviour every other malformed value in this tool already gets.
 *
 * Values are compared untrimmed: `FORCE_COLOR=" 1"` is malformed, not `1`. A variable
 * that carries whitespace was not set on purpose.
 */
export function parseForceColor(raw: string | undefined): ColourDirective | undefined {
  if (raw === undefined) return undefined;
  if (raw === "0" || raw === "false") return "never";
  if (raw === "" || raw === "true" || raw === "1" || raw === "2" || raw === "3") return "always";
  return undefined;
}

/**
 * Read one environment variable as a directive, noting a malformed value once.
 *
 * The note follows `src/config.ts:127`'s convention — name the source, name what was
 * expected, keep going. A malformed directive is never fatal: colour is a preference, and
 * refusing to render a document because a variable was misspelt would be the wrong trade.
 */
function directiveFromEnv(
  env: EnvironmentLike,
  name: string,
  warn: (message: string) => void,
): ColourDirective | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const parsed = parseColourDirective(raw);
  if (parsed === undefined) {
    warn(`mdview: ignoring malformed ${name}=${JSON.stringify(raw)}: expected auto, always or never`);
  }
  return parsed;
}

/**
 * The colour half of the matrix, highest precedence first (Decision 2).
 *
 * | Slot | Decides on |
 * |---|---|
 * | `--color` | `always`/`never`; `auto` falls through |
 * | `MDVIEW_COLOR` | `always`/`never`; `auto` falls through; malformed noted and ignored |
 * | `NO_COLOR` | **presence**, even empty (no-color.org) |
 * | `FORCE_COLOR` | well-formed values; malformed values fall through |
 * | config `color` | `always`/`never`; `auto` falls through |
 * | `isTTY` | `auto`'s floor |
 *
 * `NO_COLOR` sitting *above* `FORCE_COLOR` is deliberate and is the one ordering worth
 * naming: a user who exported `NO_COLOR` said something about this machine, and a
 * `FORCE_COLOR` inherited from some parent process did not.
 *
 * ## The three-level answer, and the one asymmetry in it (Decisions 4–5)
 *
 * **The precedence order above is untouched by WP-2 of `plans/colour-modes.md`** — every
 * slot decides at exactly the same point it always did, on exactly the same input. What
 * changed is only *what a slot's "no" means*, and it does not mean the same thing in every
 * slot:
 *
 * | Slot | `always` | `never` / off |
 * |---|---|---|
 * | `--color` flag | `"full"` | **`"formats"`** — an explicit directive |
 * | `MDVIEW_COLOR` | `"full"` | **`"formats"`** — an explicit directive |
 * | `NO_COLOR` | — | `"none"` — a kill-switch |
 * | `FORCE_COLOR` | `"full"` | `"none"` — `FORCE_COLOR=0` is a kill-switch |
 * | config `color` | `"full"` | **`"formats"`** — an explicit directive |
 * | `isTTY` floor | `"full"` | `"none"` — nothing was requested |
 *
 * **The three bolded cells are the entire rendered-byte movement this plan authorizes**
 * (Decision 5), and the split is not cosmetic. A `never` *directive* is a user saying
 * *this tool, this render, no colour* — Decision 1 reads that as "no hue, keep the
 * formatting", because dim/bold/italic are not colour. A kill-switch is a different
 * statement with an established cross-tool meaning and an installed base
 * (`NO_COLOR` presence, `FORCE_COLOR=0`), and it keeps today's bytes exactly: `"none"`.
 * The `isTTY` floor is `"none"` for a third reason again — nothing was requested at all,
 * and the landed G1 gate (a piped default render emits **zero** sequences,
 * `scripts/corpus.ts`) is ratified-by-implementation and wins over the withdrawn plan's
 * "formats survive `auto` in a pipe" row (Decision 4).
 */
export function resolveColor(input: ColourPolicyInput = {}): SgrMode {
  const env = input.env ?? {};
  const warn = input.warn ?? NOOP;

  if (input.flag === "always") return "full";
  if (input.flag === "never") return "formats";

  const fromEnv = directiveFromEnv(env, "MDVIEW_COLOR", warn);
  if (fromEnv === "always") return "full";
  if (fromEnv === "never") return "formats";

  if (env.NO_COLOR !== undefined) return "none";

  const forced = parseForceColor(env.FORCE_COLOR);
  if (forced === "always") return "full";
  if (forced === "never") return "none";

  if (input.config === "always") return "full";
  if (input.config === "never") return "formats";

  return input.isTTY === true ? "full" : "none";
}

/**
 * The compact-version parser from `supports-hyperlinks@3.2.0` (`index.js:10-27`),
 * transcribed including the form that makes it worth transcribing: a three- or
 * four-digit `VTE_VERSION` carries no dots, so `4601` means `46.1.0` — major **zero**,
 * minor 46, patch 1. Getting that wrong turns every GNOME-family terminal's answer into
 * a comparison against a four-digit major.
 *
 * Everything else splits on `.` and runs `parseInt` per part, `NaN` included: an absent
 * or unparseable version yields `NaN` components, every comparison against them is
 * false, and the branch answers "no". That is the upstream behaviour and it is the right
 * one — an unreadable version is not evidence of support.
 */
function parseVersion(versionString: string | undefined): { major: number; minor: number; patch: number } {
  const raw = versionString ?? "";
  if (/^\d{3,4}$/.test(raw)) {
    const match = /(\d{1,2})(\d{2})/.exec(raw) ?? [];
    return { major: 0, minor: parseInt(match[1] ?? "", 10), patch: parseInt(match[2] ?? "", 10) };
  }
  const parts = raw.split(".").map((part) => parseInt(part, 10));
  return { major: parts[0] as number, minor: parts[1] as number, patch: parts[2] as number };
}

/**
 * Owned terminal-capability detection for OSC-8, transcribed from
 * `supports-hyperlinks@3.2.0` (`index.js:9-126`) with the branch list and order of
 * Decision 4, and with four things **deleted by name**:
 *
 * - the pre-TTY `NETLIFY` bypass — it returns *true* before the stream is ever consulted,
 *   which directly contradicts the ratified non-TTY ceiling below;
 * - `FORCE_HYPERLINK` — replaced by `MDVIEW_HYPERLINKS`, which is this tool's own name for
 *   its own setting;
 * - both argv flag families (`--no-hyperlink`, `--hyperlink=…`) — this tool's own flags are
 *   its only argv authority, and a library scanning the whole of `process.argv` is exactly
 *   the class of hidden input WP-1 exists to remove;
 * - the `supportsColor(stream)` prerequisite — hyperlinks are an independent axis here, so
 *   `NO_COLOR` and `--color=never` leave them alone.
 *
 * The **non-TTY ceiling is absolute** and is checked first: a pipe cannot render a
 * hyperlink, so nothing — not `MDVIEW_HYPERLINKS=always`, not any terminal signature —
 * turns them on off a terminal.
 */
export function resolveHyperlinks(input: HyperlinkInput = {}): boolean {
  const env = input.env ?? {};
  const warn = input.warn ?? NOOP;

  // The ceiling. Everything below it only ever runs on a terminal.
  if (input.isTTY !== true) return false;

  const directive = directiveFromEnv(env, "MDVIEW_HYPERLINKS", warn);
  if (directive === "always") return true;
  if (directive === "never") return false;

  // Windows Terminal, which supports OSC-8 on a platform whose default console does not.
  if (env.WT_SESSION !== undefined) return true;
  if (input.platform === "win32") return false;
  if (env.CI) return false;
  if (env.TEAMCITY_VERSION) return false;

  const termProgram = env.TERM_PROGRAM;
  if (termProgram) {
    const version = parseVersion(env.TERM_PROGRAM_VERSION);
    switch (termProgram) {
      case "iTerm.app":
        if (version.major === 3) return version.minor >= 1;
        return version.major > 3;
      case "WezTerm":
        return version.major >= 20200620;
      case "vscode":
        return version.major > 1 || (version.major === 1 && version.minor >= 72);
      case "ghostty":
        return true;
      // No default: an unrecognised terminal program falls through to the checks below
      // rather than answering for them. Upstream behaviour, and load-bearing — a VTE
      // terminal that also sets TERM_PROGRAM would otherwise lose its own branch.
    }
  }

  const vteVersion = env.VTE_VERSION;
  if (vteVersion) {
    // 0.50.0 announced hyperlink support and segfaulted on it. Upstream's recorded
    // exclusion, kept: the version that says yes and crashes is worse than the ones that
    // say no.
    if (vteVersion === "0.50.0") return false;
    const version = parseVersion(vteVersion);
    return version.major > 0 || version.minor >= 50;
  }

  if (env.TERM === "alacritty") return true;

  return false;
}

/**
 * The whole decision for one render.
 *
 * Every call site that renders builds one of these; nothing downstream re-derives either
 * half. `src/cli.ts` builds it from the flag, the config and the real environment;
 * `src/render.ts` builds a default one for callers that pass none (the sweep, the
 * differential harness, every test that only cares about layout).
 */
export function resolveColourPolicy(input: ColourPolicyInput = {}): ColourPolicy {
  return {
    sgr: resolveColor(input),
    hyperlinks: resolveHyperlinks(input),
    tmux: resolveTmux(input.env ?? {}),
  };
}

/**
 * Whether this render's destination is inside tmux, which is the one thing an OSC-8
 * emitter needs to know beyond "emit or not": tmux only passes an OSC sequence through
 * when it is wrapped in its own DCS envelope (`src/ansi.ts`'s `link`).
 *
 * Transcribed from `ansi-escapes@7.3.0`, `base.js:12`:
 *
 * ```js
 * const isTmux = !isBrowser && (process.env.TERM?.startsWith('screen')
 *   || process.env.TERM?.startsWith('tmux') || process.env.TMUX !== undefined);
 * ```
 *
 * with two changes and no third: the `isBrowser` conjunct is dropped (this is a terminal
 * program; `environment`, the package that answered it, leaves the closure with
 * `ansi-escapes`), and **the environment is an argument rather than a module-load read of
 * `process.env`** — which is the whole point of resolving it here. It is deliberately
 * *not* gated on `hyperlinks`: what tmux is, and whether a link may be emitted at all,
 * are two different questions with two different answers, and the emitter asks both.
 */
export function resolveTmux(env: EnvironmentLike): boolean {
  const term = env.TERM;
  if (term !== undefined && (term.startsWith("screen") || term.startsWith("tmux"))) return true;
  return env.TMUX !== undefined;
}
