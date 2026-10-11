import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  STYLE_CLASSES,
  STYLE_TABLE,
  applyStyle,
  createStyler,
  emitsUnder,
  styleSpan,
  type StyleClass,
  type StyleCode,
  type StyleName,
} from "../src/style";
import type { SgrMode } from "../src/colour";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { NARROW_MEASURE } from "../src/width";
import { renderDocument } from "../src/render";
import { resolveFenceLanguage } from "../src/lang";

const ESC = "\u001b";
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (text: string): string => text.replace(ANSI, "");
// eslint-disable-next-line no-control-regex
const SINGLE_SGR = /^\u001b\[([0-9;]+)m$/;

/**
 * The committed style table and the emitter over it — WP-2 of `plans/colour-policy.md`.
 *
 * Three separable claims, asserted separately on purpose:
 *
 * 1. **The table is exactly the ratified inventory** — checked here against a list written
 *    out independently of `src/style.ts`, parameter by parameter, so widening the table and
 *    widening its consumer in one edit cannot pass. Decision 3 of the plan.
 * 2. **The emitter reproduces `chalk`'s `applyStyle`** — nesting, re-open, encasing — and
 *    `styleSpan` reproduces the plain wrap `src/frontmatter.ts` emits.
 * 3. **Every producer in Decision 3's enumeration really emits its style** under an injected
 *    TTY policy (the styling inventory below). That one exists so a *deleted* style is a red
 *    test rather than a silently plainer document.
 */

// The ratified inventory, transcribed from the plan's Decision 3 and the producers' own
// `chalk.…` comments rather than read from the module under test.
const RATIFIED: Record<string, [number, number]> = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  strikethrough: [9, 29],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
};

describe("the committed style table is narrow, and every parameter is checked", () => {
  test("the table is exactly the ratified inventory — no entry more, no entry fewer", () => {
    expect(Object.keys(STYLE_TABLE).sort()).toEqual(Object.keys(RATIFIED).sort());
  });

  test("every open and close is the ratified SGR parameter, spelled as a bare CSI", () => {
    for (const [name, [open, close]] of Object.entries(RATIFIED)) {
      const entry: StyleCode = STYLE_TABLE[name as StyleName];
      expect(entry.open, `${name}.open`).toBe(`${ESC}[${open}m`);
      expect(entry.close, `${name}.close`).toBe(`${ESC}[${close}m`);
    }
  });

  test("no entry carries an extended-colour introducer, and every hue is base palette", () => {
    for (const [name, entry] of Object.entries(STYLE_TABLE)) {
      for (const code of [entry.open, entry.close]) {
        const match = SINGLE_SGR.exec(code);
        expect(match, `${name}: ${JSON.stringify(code)} is not a single bare SGR sequence`).not.toBeNull();
        const parameters = (match?.[1] ?? "").split(";").map(Number);
        // One parameter per sequence: `38;5;n` and `48;2;r;g;b` cannot be spelled at all.
        expect(parameters.length, `${name} has more than one SGR parameter`).toBe(1);
        const parameter = parameters[0] as number;
        expect([38, 48].includes(parameter), `${name} uses an extended-colour introducer`).toBe(false);
        const allowed =
          parameter <= 9 || // attributes
          (parameter >= 21 && parameter <= 29) || // attribute closes
          (parameter >= 30 && parameter <= 37) || // base foreground
          parameter === 39 || // foreground close
          (parameter >= 90 && parameter <= 97); // bright base foreground
        expect(allowed, `${name}: SGR ${parameter} is outside the ratified palette`).toBe(true);
        // Backgrounds were never emitted by this renderer and are not authorized.
        expect(parameter >= 40 && parameter <= 49, `${name} sets a background`).toBe(false);
        expect(parameter >= 100 && parameter <= 107, `${name} sets a bright background`).toBe(false);
      }
    }
  });

  test("the styles the retired packages' records carried and this one does not", () => {
    // `@colors/colors`' styles record is what `src/inline.ts` used to read, and it carries
    // these as well. The table is *narrow*: it holds what this renderer emits, and these
    // are the entries the plan's Decision 3 refused to inherit.
    for (const name of ["inverse", "hidden", "bgRed", "bgBlue", "brightRed", "blackBG", "rainbow"]) {
      expect(Object.keys(STYLE_TABLE)).not.toContain(name);
    }
  });

  test("createStyler throws on a name the table has no entry for", () => {
    expect(() => createStyler("nope" as StyleName)).toThrow(/no style named nope/);
  });
});

describe("the emitter — chalk's applyStyle, and the plain wrap beside it", () => {
  const on = { sgr: "full" } as const;
  const off = { sgr: "none" } as const;
  const BOLD = createStyler("bold");
  const DEL = createStyler("strikethrough", createStyler("gray", createStyler("dim")));

  test("colour off returns the input untouched, whatever the chain", () => {
    expect(applyStyle(off, DEL, "text")).toBe("text");
    expect(styleSpan(off, BOLD, "text")).toBe("text");
  });

  test("a chain accumulates outermost-first and closes innermost-first", () => {
    expect(DEL.openAll).toBe(`${ESC}[2m${ESC}[90m${ESC}[9m`);
    expect(DEL.closeAll).toBe(`${ESC}[29m${ESC}[39m${ESC}[22m`);
    expect(applyStyle(on, DEL, "x")).toBe(`${DEL.openAll}x${DEL.closeAll}`);
  });

  test("a nested close is re-emitted and the style re-opened after it", () => {
    // The `link`-around-`href` case, which fires on the first link in any document: both
    // chains close with `39m`, so the inner close is followed by a blue re-open.
    const BLUE = createStyler("blue");
    expect(applyStyle(on, BLUE, `a${ESC}[39mb`)).toBe(`${ESC}[34ma${ESC}[39m${ESC}[34mb${ESC}[39m`);
  });

  test("a line break is closed before and re-opened after", () => {
    expect(applyStyle(on, BOLD, "a\nb")).toBe(`${ESC}[1ma${ESC}[22m\n${ESC}[1mb${ESC}[22m`);
  });

  test("styleSpan does neither — it is the frontmatter rule, and it wraps an empty string", () => {
    const DIM = createStyler("dim");
    expect(styleSpan(on, DIM, "a\nb")).toBe(`${ESC}[2ma\nb${ESC}[22m`);
    expect(styleSpan(on, DIM, `a${ESC}[22mb`)).toBe(`${ESC}[2ma${ESC}[22mb${ESC}[22m`);
    expect(styleSpan(on, DIM, "")).toBe(`${ESC}[2m${ESC}[22m`);
    // Where `applyStyle` returns an empty input untouched, as chalk does.
    expect(applyStyle(on, DIM, "")).toBe("");
  });
});

/**
 * The hue/format/control classification and the filter over it — WP-2 of
 * `plans/colour-modes.md`.
 *
 * **Written out independently of `src/style.ts`, exactly as the table inventory above is,
 * and for the same reason**: the classification is a *ratified* answer (Decisions 1 and 8),
 * not a convenience, so a future edit that reclassifies `dim` as a hue — which is the
 * specific mistake Decision 1 was written to forbid — has to disagree with a list here to
 * land. Reading `STYLE_CLASSES` into the expectation would make that edit self-approving.
 */
describe("the style classification — hue, format, control", () => {
  const RATIFIED_CLASSES: Record<StyleName, StyleClass> = {
    // Decision 1: the seven hues, and only these, are what an explicit `never` drops.
    red: "hue",
    green: "hue",
    yellow: "hue",
    blue: "hue",
    magenta: "hue",
    cyan: "hue",
    gray: "hue",
    // Decision 1 again: "bold, dim, italic, underline, strikethrough survive", and **dim
    // is a format, not a hue** — the user's own words, and the membership most at risk of
    // being "corrected" by someone reading `2m` as a brightness.
    bold: "format",
    dim: "format",
    italic: "format",
    underline: "format",
    strikethrough: "format",
    // Decision 8 (cycle-1 f9): `reset` is neither, and is emitted whenever `sgr !== "none"`.
    reset: "control",
  };

  test("every committed style is classified, and classified as ratified", () => {
    expect(Object.keys(STYLE_CLASSES).sort()).toEqual(Object.keys(STYLE_TABLE).sort());
    for (const [name, expected] of Object.entries(RATIFIED_CLASSES)) {
      expect(STYLE_CLASSES[name as StyleName]).toBe(expected);
    }
  });

  test("the table and the classification cover exactly the same names", () => {
    // The compile-time `satisfies` says this too; asserting it at runtime is what catches a
    // future edit that widens one of the two through a cast.
    expect(Object.keys(RATIFIED_CLASSES).sort()).toEqual(Object.keys(STYLE_TABLE).sort());
  });

  test("`none` emits nothing, `full` emits everything, `formats` emits everything but hue", () => {
    for (const name of Object.keys(STYLE_TABLE) as StyleName[]) {
      expect(emitsUnder(name, "none")).toBe(false);
      expect(emitsUnder(name, "full")).toBe(true);
      expect(emitsUnder(name, "formats")).toBe(STYLE_CLASSES[name] !== "hue");
    }
  });

  test("`reset` survives `formats` — Decision 8, stated as a case of its own", () => {
    // Paragraphs, rules and list items are framed in it (`src/blocks.ts`, `src/lists.ts`),
    // so this one membership decides whether a `formats` document keeps its framing.
    expect(emitsUnder("reset", "formats")).toBe(true);
    expect(emitsUnder("reset", "none")).toBe(false);
  });
});

/**
 * The filter at the emitter — the same three claims the unfiltered emitter makes, made
 * again under `formats`, because the interesting failures are the ones where the filter and
 * `chalk`'s two surgeries interact.
 */
describe("the emitter under `formats` — the filter, and the two surgeries over it", () => {
  const formats: { sgr: SgrMode } = { sgr: "formats" };
  const full: { sgr: SgrMode } = { sgr: "full" };
  const none: { sgr: SgrMode } = { sgr: "none" };
  const BOLD = createStyler("bold");
  const GRAY = createStyler("gray");
  const DEL = createStyler("strikethrough", createStyler("gray", createStyler("dim")));
  const DIM = createStyler("dim");

  test("a format-only chain is untouched by the filter", () => {
    expect(applyStyle(formats, BOLD, "x")).toBe(applyStyle(full, BOLD, "x"));
  });

  test("a hue-only chain emits nothing at all — not an empty open/close pair", () => {
    expect(applyStyle(formats, GRAY, "x")).toBe("x");
    expect(styleSpan(formats, GRAY, "x")).toBe("x");
    // The residue this rules out, spelled so the failure is legible if it ever appears.
    expect(applyStyle(formats, GRAY, "x")).not.toContain(ESC);
  });

  test("a mixed chain keeps its non-hue links in their original nesting order", () => {
    expect(applyStyle(formats, DEL, "x")).toBe(`${ESC}[2m${ESC}[9mx${ESC}[29m${ESC}[22m`);
  });

  test("the re-open surgery runs over the FILTERED chain, so it cannot restore a dropped hue", () => {
    // This is the case that fails if the filter is applied after the surgery rather than
    // before it: `stringReplaceAll` re-emits *this chain's own* close codes and appends the
    // matching open. Over the unfiltered `DEL` the grey link would find the `39m` in the
    // input and put `90m` straight back into a `formats` render.
    const rendered = applyStyle(formats, DEL, `a${ESC}[39mb`);
    expect(rendered).not.toContain(`${ESC}[90m`);
    expect(rendered).toBe(`${ESC}[2m${ESC}[9ma${ESC}[39mb${ESC}[29m${ESC}[22m`);
  });

  test("the newline encasing re-opens the FILTERED chain, not the original", () => {
    // Same failure mode, one surgery over: the encasing reinserts `openAll` after every
    // line break, so an unfiltered `openAll` here would leak a hue on every line but the
    // first — invisible in any single-line assertion.
    const rendered = applyStyle(formats, DEL, "a\nb");
    expect(rendered).toBe(
      `${ESC}[2m${ESC}[9ma${ESC}[29m${ESC}[22m\n${ESC}[2m${ESC}[9mb${ESC}[29m${ESC}[22m`,
    );
    expect(rendered).not.toContain(`${ESC}[90m`);
  });

  test("`none` still returns the input untouched, whatever the chain's classes", () => {
    expect(applyStyle(none, DEL, "x")).toBe("x");
    expect(styleSpan(none, DEL, "x")).toBe("x");
  });

  test("styleSpan's no-guard empty-string emission survives `formats` — pinned, not a bug", () => {
    // `dim` is format-class, so `formatMetaBlock("")`'s bare `2m`/`22m` pair around nothing
    // is emitted under `formats` exactly as it is under `full`. It looks like filter residue
    // and is not: `styleSpan` has no empty-string guard by measurement (see `src/style.ts`),
    // and adding one here would move a forced-colour byte in `tests/frontmatter.test.ts`.
    expect(styleSpan(formats, DIM, "")).toBe(`${ESC}[2m${ESC}[22m`);
    expect(styleSpan(full, DIM, "")).toBe(`${ESC}[2m${ESC}[22m`);
    expect(styleSpan(none, DIM, "")).toBe("");
    // The contrast that says the pair is `dim`'s and not the filter's: a hue-only chain
    // over the same empty string emits nothing.
    expect(styleSpan(formats, GRAY, "")).toBe("");
  });

  test("applyStyle keeps chalk's own empty-input guard at every mode", () => {
    expect(applyStyle(formats, DIM, "")).toBe("");
    expect(applyStyle(full, DIM, "")).toBe("");
  });

  test("the filter never touches visible text, at any mode", () => {
    const input = `a${ESC}[39mb\nc`;
    for (const gate of [none, formats, full]) {
      expect(stripAnsi(applyStyle(gate, DEL, input))).toBe(stripAnsi(input));
    }
  });

  test("a chain built per call is filtered correctly too — the memo is keyed, not global", () => {
    // The `WeakMap` in `src/style.ts` is keyed on the chain object. A fresh chain with the
    // same shape must get the same answer, and a *different* chain must not inherit it.
    expect(applyStyle(formats, createStyler("strikethrough", createStyler("gray")), "x")).toBe(
      `${ESC}[9mx${ESC}[29m`,
    );
    expect(applyStyle(formats, createStyler("gray", createStyler("strikethrough")), "x")).toBe(
      `${ESC}[9mx${ESC}[29m`,
    );
    expect(applyStyle(formats, createStyler("cyan"), "x")).toBe("x");
  });
});

/**
 * The non-vacuity inventory: every producer Decision 3 enumerates, asserted on the bytes
 * of one render under an **explicitly injected** TTY policy.
 *
 * This is the test that fails when a style is deleted rather than merely re-routed. It
 * renders `tests/fixtures/styling-inventory.md`, which carries one instance of every
 * construct, and asserts the exact opening sequence each producer emits — including the
 * four the plan's rev 2 missed (paragraph reset, hr reset, HTML gray, list-item reset),
 * which are invisible to a "does it contain any escape" check because `0m` is shared.
 */
describe("the styling inventory — every producer emits, under an injected TTY policy", () => {
  const source = readFileSync(resolve(import.meta.dir, "fixtures/styling-inventory.md"), "utf8");
  const rendered = renderDocument(
    source,
    100,
    UNICODE_GLYPHS,
    NARROW_MEASURE,
    false,
    resolveFenceLanguage,
    { sgr: "full", hyperlinks: false, tmux: false },
  );
  const plain = renderDocument(
    source,
    100,
    UNICODE_GLYPHS,
    NARROW_MEASURE,
    false,
    resolveFenceLanguage,
    { sgr: "none", hyperlinks: false, tmux: false },
  );

  // name -> the exact byte sequence that producer opens with
  const producers: Array<[string, string]> = [
    ["frontmatter dim", `${ESC}[2m`],
    ["first heading (magenta underline bold)", `${ESC}[35m${ESC}[4m${ESC}[1m`],
    ["heading (green bold)", `${ESC}[32m${ESC}[1m`],
    ["paragraph reset", `${ESC}[0m`],
    ["inline strong (bold)", `${ESC}[1m`],
    ["inline em (italic)", `${ESC}[3m`],
    ["inline codespan (yellow)", `${ESC}[33m`],
    ["inline del (dim gray strikethrough)", `${ESC}[2m${ESC}[90m${ESC}[9m`],
    ["inline link (blue)", `${ESC}[34m`],
    ["inline href (blue underline)", `${ESC}[34m${ESC}[4m`],
    ["wiki-link (cyan underline)", `${ESC}[36m${ESC}[4m`],
    ["blockquote (gray italic)", `${ESC}[90m${ESC}[3m`],
    ["html (gray)", `${ESC}[90m`],
    ["table border (gray)", `${ESC}[90m`],
    ["table head (bold)", `${ESC}[1m`],
    ["syntax: comment (green)", `${ESC}[32m`],
    ["syntax: keyword (blue)", `${ESC}[34m`],
    ["syntax: number (green)", `${ESC}[32m`],
    ["syntax: function (yellow)", `${ESC}[33m`],
  ];

  for (const [name, open] of producers) {
    test(`${name} emits ${JSON.stringify(open)}`, () => {
      expect(rendered).toContain(open);
    });
  }

  // Shared opening bytes make "contains" too weak for four of the producers, so each of
  // these is pinned on the exact line it belongs to instead.
  const lines = rendered.split("\n");
  const strip = stripAnsi;
  // Matched on *stripped* bytes: a styled line's needle is routinely split by an escape
  // (`const` is a keyword span, so the raw line reads `…[34mconst[39m answer…`).
  const lineWith = (needle: string): string =>
    lines.find((line) => strip(line).includes(needle) && line.includes(ESC)) ?? "";

  test("the hr is wrapped in reset, at the rule's own line", () => {
    // The *document's* rule, not the frontmatter divider above it — the divider is
    // `renderRule`'s output emitted by `src/render.ts` outside the `hr` visitor and carries
    // no styling at all, which is exactly the pair this assertion has to tell apart.
    const rules = lines.filter((line) => strip(line).includes("─".repeat(10)));
    expect(rules.length).toBeGreaterThanOrEqual(2);
    const divider = rules[0] as string;
    const rule = rules[rules.length - 1] as string;
    expect(divider).not.toContain(ESC);
    // The reset opens immediately before the first rule glyph and closes at end of line.
    // (The line can *begin* with the preceding HTML block's own grey pair — `renderHtml`
    // emits no trailing newline of its own — which is why this is not a `startsWith`.)
    expect(rule).toContain(`${ESC}[0m─`);
    expect(rule.endsWith(`${ESC}[0m`)).toBe(true);
  });

  test("a list item is wrapped in reset, on its own composed line", () => {
    const item = lineWith("a list item");
    expect(item).toContain(`${ESC}[0m`);
    expect(item).toContain("a list item");
  });

  test("a table border row is grey and its head cells bold", () => {
    const border = lines.find((line) => line.includes("┌")) ?? "";
    expect(border).toContain(`${ESC}[90m`);
    const head = lineWith("middle");
    expect(head).toContain(`${ESC}[1m`);
  });

  test("the block HTML line is grey", () => {
    expect(lineWith("raw-html")).toContain(`${ESC}[90m`);
  });

  test("a fenced block carries the highlighter's token colours", () => {
    const fence = lineWith("const answer");
    expect(fence).toContain(`${ESC}[34m`); // keyword
    expect(fence).toContain(`${ESC}[32m`); // number
  });

  test("the unlabelled fence goes through highlightAuto and is styled too", () => {
    // `resolveFenceLanguage(undefined)` is `undefined` by design, which is the branch that
    // reaches `hljs.highlightAuto`; if it were collapsed into `hljs.highlight` this fence
    // would throw and come back as the `catch` branch's flat yellow.
    const auto = lineWith("auto-detected");
    expect(auto).toContain(ESC);
  });

  // The negative half: with the policy off, the same render carries no escape from any of
  // these producers — **no exception, since WP-4 of `plans/colour-policy.md`**. This test
  // read "the only escapes left are the wiki-link's" and expected exactly
  // `36m`/`4m`/`24m`/`39m`, because `styleWikiLink` injected that pair into the source
  // before the lexer at every colour level. It is gone: recognition is the lexer's since
  // WP-2 of `plans/wiki-link-tokenizer.md`, and the label is styled by a visitor under the
  // same gate as everything else. Decision 1 of the colour plan — zero tool-generated escape
  // bytes with the policy off — is total over this fixture.
  //
  // **The carrier half of this test is rephrased, not retired** (grant C4). Code points 2/3
  // were the carrier pair, and this asserted the pass stripped them unconditionally. There is
  // no pass and no carrier now, so the claim is the one that survives the mechanism: **the
  // tool generates none**, therefore a source containing none produces none. An *authored*
  // 2 or 3 passes through as content — pinned in `tests/wikilink-tokenizer.test.ts`.
  test("with the policy off, no producer emits an escape at all", () => {
    const escapes = [...plain.matchAll(ANSI)].map((match) => match[0]);
    expect(escapes).toEqual([]);
    // Non-vacuous: the fixture this is measured over is itself carrier-free.
    expect(source).not.toContain(String.fromCharCode(2));
    expect(source).not.toContain(String.fromCharCode(3));
    expect(plain).not.toContain(String.fromCharCode(2));
    expect(plain).not.toContain(String.fromCharCode(3));
    expect(rendered).not.toContain(String.fromCharCode(2));
    expect(rendered).not.toContain(String.fromCharCode(3));
  });

  test("and the visible text is identical either way", () => {
    expect(stripAnsi(rendered)).toBe(stripAnsi(plain));
  });
});
