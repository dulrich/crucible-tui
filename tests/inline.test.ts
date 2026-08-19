import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { UNICODE_GLYPHS } from "../src/glyphs";
import {
  renderBr,
  renderCodespan,
  renderDel,
  renderEm,
  renderImage,
  renderInlineText,
  renderLink,
  renderStrong,
} from "../src/inline";
import { type SgrMode } from "../src/colour";
import { createLayoutContext, type LayoutContext } from "../src/layout-context";
import { NARROW_MEASURE } from "../src/width";
import { inlineParityCases, inlineParityFailures, type ParityCase } from "./helpers/inline-parity";

const ESC = "\u001b";

function context(overrides: { emoji?: boolean; sgr?: SgrMode } = {}): LayoutContext {
  return createLayoutContext({
    width: 80,
    glyphs: UNICODE_GLYPHS,
    measure: NARROW_MEASURE,
    resolveFenceLanguage: (raw) => raw,
    emoji: overrides.emoji ?? true,
    sgr: overrides.sgr ?? "none",
  });
}

function inline(text: string): { tokens: never[] } & Record<string, unknown> {
  return { type: "text", raw: text, text, tokens: [] } as unknown as { tokens: never[] } & Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const asToken = (value: Record<string, unknown>): any => value;
/* eslint-enable @typescript-eslint/no-explicit-any */

const parse = (tokens: unknown[]): string =>
  tokens.map((token) => (token as { text?: string }).text ?? "").join("");

const withChildren = (fields: Record<string, unknown>, text: string): Record<string, unknown> => ({
  ...fields,
  text,
  raw: text,
  tokens: [inline(text)],
});

describe("inline visitors — byte parity with the marked-terminal methods they replaced", () => {
  // **All four combinations run in this process, and WP-1 of `plans/colour-policy.md` is
  // what made that possible.** The coloured half used to need a fresh subprocess with
  // `FORCE_COLOR` set before its module graph loaded, because the colour decision was a
  // `supports-color` module global and nothing in-process could move it. It is a parameter
  // now, so the table is built at the setting the test names and the two halves cost one
  // process between them. (`tests/helpers/color.ts` records the subprocess finding as
  // history: it was still true for `cli-highlight`'s bundled `chalk` until WP-2 of the same
  // plan retired that package, and `tests/blocks.test.ts`'s block table moved in-process
  // then for the same reason this one did.)
  test("every case matches, colour off, shortcodes on", () => {
    expect(inlineParityFailures(true, false)).toEqual([]);
  });

  test("every case matches, colour off, shortcodes off", () => {
    expect(inlineParityFailures(false, false)).toEqual([]);
  });

  test("every case matches with colour on, shortcodes on", () => {
    expect(inlineParityFailures(true, true)).toEqual([]);
  });

  test("every case matches with colour on, shortcodes off", () => {
    expect(inlineParityFailures(false, true)).toEqual([]);
  });

  test("the colour-on table really is coloured — the two above are not vacuous", () => {
    // The library emitted nothing at level 0, so a colour-blind comparison would pass
    // whatever the owned emitters do. This is the assertion the old subprocess made with
    // `detectInlineColor()`; it is made on the observed bytes now, which is stronger.
    // `strong/plain` deliberately, not "some case": several inputs in this table carry an
    // authored escape of their own (the nested-style cases hand a visitor an already-styled
    // child on purpose), so "any case contains ESC" is true at both settings and would be a
    // pin that cannot fail. This case's input is the four letters of the word.
    const find = (cases: ParityCase[]): ParityCase => {
      const entry = cases.find((candidate) => candidate.name === "strong/plain");
      if (entry === undefined) throw new Error("the parity table lost its strong/plain case");
      return entry;
    };
    const coloured = find(inlineParityCases(true, true));
    expect(coloured.ours).toContain(ESC);
    expect(coloured.theirs).toContain(ESC);
    expect(find(inlineParityCases(true, false)).ours).not.toContain(ESC);
  });
});

describe("inline visitors — the exact bytes, with the colour decision supplied", () => {
  // These do not need a subprocess: the owned emitters branch on `LayoutContext.sgr`,
  // which is precisely what makes them testable at both settings in one process, and
  // what stops the non-TTY/`@colors` divergence from reaching the output.
  const on = context({ sgr: "full" });
  const off = context({ sgr: "none" });

  test("strong is bold, and nothing when colour is off", () => {
    const token = asToken(withChildren({ type: "strong" }, "loud"));
    expect(renderStrong(on, token, parse)).toBe(`${ESC}[1mloud${ESC}[22m`);
    expect(renderStrong(off, token, parse)).toBe("loud");
  });

  test("em is italic", () => {
    const token = asToken(withChildren({ type: "em" }, "quiet"));
    expect(renderEm(on, token, parse)).toBe(`${ESC}[3mquiet${ESC}[23m`);
    expect(renderEm(off, token, parse)).toBe("quiet");
  });

  test("del is dim, then grey, then strikethrough — in that nesting order", () => {
    const token = asToken(withChildren({ type: "del" }, "gone"));
    expect(renderDel(on, token, parse)).toBe(`${ESC}[2m${ESC}[90m${ESC}[9mgone${ESC}[29m${ESC}[39m${ESC}[22m`);
  });

  test("a nested close code is re-opened rather than left to end the style early", () => {
    // A code span inside a strikethrough closes with `39m`, which is also grey's close.
    // Left alone, the rest of the strikethrough would lose its colour.
    const token = asToken(withChildren({ type: "del" }, `a ${ESC}[33mb${ESC}[39m c`));
    expect(renderDel(on, token, parse)).toContain(`${ESC}[33mb${ESC}[39m${ESC}[90m c`);
  });

  test("a newline closes the style before it and reopens after", () => {
    const token = asToken(withChildren({ type: "strong" }, "one\ntwo"));
    expect(renderStrong(on, token, parse)).toBe(`${ESC}[1mone${ESC}[22m\n${ESC}[1mtwo${ESC}[22m`);
  });

  test("a link wraps a blue-underlined href in blue, re-opening the shared close code", () => {
    const token = asToken({
      type: "link",
      raw: "x",
      href: "https://example.com/x",
      title: null,
      text: "label",
      tokens: [inline("label")],
    });
    const rendered = renderLink(on, token, parse);
    // The href's own `39m` is *followed by* a blue re-open rather than replaced by one:
    // `chalk`'s `stringReplaceAll` re-emits the close and then appends the open, so the
    // colour resumes without the close ever being removed. Getting this backwards was the
    // first wrong guess written against this seam, and it is invisible without the bytes.
    const href = `${ESC}[34m${ESC}[4mhttps://example.com/x${ESC}[24m${ESC}[39m${ESC}[34m`;
    if (!rendered.includes("(")) {
      // OSC-8 path — this machine's terminal capability, not something to assert against.
      expect(rendered).toContain(href);
      return;
    }
    expect(rendered).toBe(`${ESC}[34mlabel (${href})${ESC}[39m`);
  });

  test("a link percent-encodes plus signs in the url but not in the label", () => {
    const token = asToken({
      type: "link",
      raw: "x",
      href: "https://example.com/a+b",
      title: null,
      text: "a+b",
      tokens: [inline("a+b")],
    });
    const rendered = renderLink(off, token, parse);
    expect(rendered).toContain("a+b");
    if (rendered.includes("%20")) {
      // OSC-8 path: the label keeps its plus signs, the url does not.
      expect(rendered).toContain("https://example.com/a%20b");
    } else {
      expect(rendered).toBe("a+b (https://example.com/a+b)");
    }
  });
});

/**
 * **The `formats` mode, pinned at the direct visitor with exact-pair assertions** — WP-2 of
 * `plans/colour-modes.md`, and cycle-3 f6 is the reason it is *here* rather than in a
 * document-level render. A paragraph is framed in `reset` (`0m` both directions, Decision
 * 8), so a document-level "does the formats render contain an escape" check passes even if
 * the hue filter is completely dead. Asserting the whole byte string of one visitor's
 * output is the only form that fails when the filter stops working, and it is what these
 * cases do.
 *
 * The six chains, and what each is under the classification (`STYLE_CLASSES`,
 * `src/style.ts`):
 *
 * | Visitor | Chain | Under `formats` |
 * |---|---|---|
 * | `strong` | `bold` | unchanged — format |
 * | `em` | `italic` | unchanged — format |
 * | `codespan` | `yellow` | **nothing at all** — hue-only chain |
 * | `del` | `dim` · `gray` · `strikethrough` | `2m`/`22m` and `9m`/`29m`; `90m`/`39m` gone |
 * | `link` | `blue` | **nothing at all** — hue-only chain |
 * | `link`'s href | `blue` · `underline` | `4m`/`24m` only |
 *
 * A chain that filters down to nothing emits **nothing** rather than an empty open/close
 * pair, which is why the codespan and link cases assert the bare text and not a residue.
 */
describe("inline visitors — the exact bytes under `formats` (the hue/format split)", () => {
  const formats = context({ sgr: "formats" });
  const off = context({ sgr: "none" });

  test("strong keeps its bold — format class, byte-identical to `full`", () => {
    const token = asToken(withChildren({ type: "strong" }, "loud"));
    expect(renderStrong(formats, token, parse)).toBe(`${ESC}[1mloud${ESC}[22m`);
  });

  test("em keeps its italic — format class", () => {
    const token = asToken(withChildren({ type: "em" }, "quiet"));
    expect(renderEm(formats, token, parse)).toBe(`${ESC}[3mquiet${ESC}[23m`);
  });

  test("codespan's yellow is hue-only, so it emits nothing — not an empty pair", () => {
    const token = asToken({ type: "codespan", raw: "x", text: "x" });
    expect(renderCodespan(formats, token)).toBe("x");
    // And the whole point of the mode: `formats` is not `none` in general, but for a
    // hue-only producer the two agree exactly.
    expect(renderCodespan(formats, token)).toBe(renderCodespan(off, token));
  });

  test("del keeps dim and strikethrough, loses grey — the exact-pair case (cycle-3 f6)", () => {
    const token = asToken(withChildren({ type: "del" }, "gone"));
    const rendered = renderDel(formats, token, parse);
    // The positive half, as a whole byte string rather than as a `toContain`.
    expect(rendered).toBe(`${ESC}[2m${ESC}[9mgone${ESC}[29m${ESC}[22m`);
    // The negative half, named individually so a failure says which code came back.
    expect(rendered).toContain(`${ESC}[2m`);
    expect(rendered).toContain(`${ESC}[22m`);
    expect(rendered).toContain(`${ESC}[9m`);
    expect(rendered).toContain(`${ESC}[29m`);
    expect(rendered).not.toContain(`${ESC}[90m`);
    expect(rendered).not.toContain(`${ESC}[39m`);
  });

  test("the surviving links still nest outermost-first, which is what rebuilding buys", () => {
    // `dim` is the outer link and `strikethrough` the inner one; dropping `gray` from
    // between them must not reorder them or leave the closes crossed. Editing `openAll` as
    // a string instead of rebuilding the chain is the way to get this wrong.
    const token = asToken(withChildren({ type: "del" }, "x"));
    const rendered = renderDel(formats, token, parse);
    expect(rendered.indexOf(`${ESC}[2m`)).toBeLessThan(rendered.indexOf(`${ESC}[9m`));
    expect(rendered.indexOf(`${ESC}[29m`)).toBeLessThan(rendered.indexOf(`${ESC}[22m`));
  });

  test("a link loses its blue wrap entirely and its href keeps only the underline", () => {
    const token = asToken({
      type: "link",
      raw: "x",
      href: "https://example.com/x",
      title: null,
      text: "label",
      tokens: [inline("label")],
    });
    const rendered = renderLink(formats, token, parse);
    if (!rendered.includes("(")) {
      // OSC-8 path — a terminal capability, never asserted against here.
      expect(rendered).toContain(`${ESC}[4mhttps://example.com/x${ESC}[24m`);
      return;
    }
    expect(rendered).toBe(`label (${ESC}[4mhttps://example.com/x${ESC}[24m)`);
    expect(rendered).not.toContain(`${ESC}[34m`);
    expect(rendered).not.toContain(`${ESC}[39m`);
  });

  test("the visible text is identical in all three modes — the filter moves no character", () => {
    const source = asToken(withChildren({ type: "del" }, "gone"));
    // eslint-disable-next-line no-control-regex
    const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, "");
    expect(strip(renderDel(formats, source, parse))).toBe(strip(renderDel(off, source, parse)));
    expect(strip(renderDel(context({ sgr: "full" }), source, parse))).toBe(
      strip(renderDel(off, source, parse)),
    );
  });
});

describe("inline visitors — the library behaviours that must not be tidied up", () => {
  const ctx = context({ sgr: "none" });

  test("codespan still emits the colon sentinel the block renderers undo", () => {
    const token = asToken({ type: "codespan", raw: "a:b", text: "a:b" });
    expect(renderCodespan(ctx, token)).toBe("a*#COLON|*b");
  });

  test("codespan does not parse its children, so markup inside backticks stays literal", () => {
    const token = asToken({ type: "codespan", raw: "**x**", text: "**x**" });
    expect(renderCodespan(ctx, token)).toBe("**x**");
  });

  test("fixHardReturn's upstream defect is reproduced, not fixed", () => {
    // `text.replace(HARD_RETURN, /\n/g)` coerces the regex to its source text and
    // replaces only the first occurrence. Neither is a newline; both are the bytes the
    // library shipped, so both are this package's obligation.
    const token = asToken(withChildren({ type: "em" }, "a\rb\rc"));
    expect(renderEm(ctx, token, parse)).toBe("a/\\n/gb\rc");
  });

  test("br emits the hard-return marker, because every construction sets reflowText", () => {
    expect(renderBr()).toBe("\r");
  });

  test("image reassembles the source shape with an en dash and a trailing newline", () => {
    const withTitle = asToken({ type: "image", raw: "x", href: "u", title: "T", text: "alt" });
    expect(renderImage(withTitle)).toBe("![alt – T](u)\n");
    const without = asToken({ type: "image", raw: "x", href: "u", title: null, text: "alt" });
    expect(renderImage(without)).toBe("![alt](u)\n");
  });

  test("inline text is the token's own text — no unescaping, no substitution", () => {
    const token = asToken({ type: "text", raw: "ship :rocket: it", text: "ship :rocket: it" });
    expect(renderInlineText(token)).toBe("ship :rocket: it");
  });

  test("shortcode substitution in a link label keeps the stray trailing space", () => {
    // `insertEmojis` appends a space that was never in the source. `src/render.ts` strips
    // it downstream, fence-aware; stripping it here as well would strip it twice.
    const token = asToken({
      type: "link",
      raw: "x",
      href: "https://example.com/x",
      title: null,
      text: ":rocket:",
      tokens: [inline(":rocket:")],
    });
    const rendered = renderLink(context({ sgr: "none", emoji: true }), token, parse);
    expect(rendered).toContain("\u{1F680} ");
    const literal = renderLink(context({ sgr: "none", emoji: false }), token, parse);
    expect(literal).toContain(":rocket:");
  });
});
/**
 * The colour decision is no longer discovered here, and this is what replaced the two
 * describes that used to discover it.
 *
 * Until WP-1 of `plans/colour-policy.md` this file ended with `detectInlineColor` — one
 * block asserting it was false under `bun test` and disagreed with `@colors/colors`, and
 * one running five environment cases through fresh subprocesses because the answer
 * resolved at module load and could not be varied in-process. That function is gone; the
 * behaviour those cases covered is `tests/colour.test.ts`'s, where it is a pure function
 * over an environment record and needs no subprocess for any of it.
 *
 * What stays here is the part that is about **this module**: nothing in it reads a global
 * to decide anything, so a flag on the command line cannot change what a visitor emits.
 */
describe("the inline visitors take the colour decision and read nothing else", () => {
  test("a --color flag in the wrapper argv is inert — the decision comes from the context", async () => {
    // `supports-color@7.2.0` scanned the whole of `process.argv` for `--color` through
    // `has-flag`, so **this exact invocation used to render styled output**: a flag aimed at
    // `bun`, or at nothing at all, silently turned styling on inside the renderer. That
    // sniff is what WP-1 deleted, and this is its regression pin. It is a subprocess because
    // argv is the thing under test and this process's own argv belongs to the test runner.
    const glyphsPath = resolve(import.meta.dir, "../src/glyphs.ts");
    const inlinePath = resolve(import.meta.dir, "../src/inline.ts");
    const contextPath = resolve(import.meta.dir, "../src/layout-context.ts");
    const child = `
      const argv = process.argv;
      const { UNICODE_GLYPHS } = await import(argv[argv.length - 3]);
      const { renderStrong } = await import(argv[argv.length - 2]);
      const { createLayoutContext } = await import(argv[argv.length - 1]);
      const ctx = createLayoutContext({
        width: 80,
        glyphs: UNICODE_GLYPHS,
        measure: Object.assign((text) => text.length, { ambiguous: "narrow" }),
        resolveFenceLanguage: (raw) => raw,
        emoji: false,
        sgr: "none",
      });
      const inner = { type: "text", raw: "loud", text: "loud" };
      const token = { type: "strong", raw: "loud", text: "loud", tokens: [inner] };
      const parse = (tokens) => tokens.map((entry) => entry.text ?? "").join("");
      process.stdout.write(renderStrong(ctx, token, parse));
    `;
    const proc = Bun.spawn(
      // After the `--`, deliberately: `bun -e` consumes anything flag-shaped before it, so a
      // flag placed earlier never reaches the child's `process.argv` at all and the case
      // would pass for a reason that has nothing to do with the rule under test.
      ["bun", "-e", child, "--", "--color", glyphsPath, inlinePath, contextPath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, `subprocess stderr: ${stderr}`).toBe(0);
    expect(stdout).toBe("loud");
    expect(stdout).not.toContain(ESC);
  });

  test("the same visitor with the decision set the other way does emit, so the pin is not vacuous", () => {
    const token = asToken(withChildren({ type: "strong" }, "loud"));
    expect(renderStrong(context({ sgr: "full" }), token, parse)).toBe(`${ESC}[1mloud${ESC}[22m`);
  });
});
