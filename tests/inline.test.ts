import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { UNICODE_GLYPHS } from "../src/glyphs";
import {
  detectInlineColor,
  renderBr,
  renderCodespan,
  renderDel,
  renderEm,
  renderImage,
  renderInlineText,
  renderLink,
  renderStrong,
} from "../src/inline";
import { createLayoutContext, type LayoutContext } from "../src/layout-context";
import { NARROW_MEASURE } from "../src/width";
import { inlineParityFailures, type ParityCase } from "./helpers/inline-parity";

const ESC = "\u001b";

function context(overrides: { emoji?: boolean; color?: boolean } = {}): LayoutContext {
  return createLayoutContext({
    width: 80,
    glyphs: UNICODE_GLYPHS,
    measure: NARROW_MEASURE,
    resolveFenceLanguage: (raw) => raw,
    emoji: overrides.emoji ?? true,
    color: overrides.color ?? false,
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
  // `bun test` is never a TTY, so `chalk` is at level 0 here and both sides emit plain
  // text. That half is real but blind to styling; the subprocess test below is the one
  // that sees escape sequences. Running both is the point — see `tests/helpers/color.ts`.
  test("every case matches, colour off, shortcodes on", () => {
    expect(detectInlineColor()).toBe(false);
    expect(inlineParityFailures(true)).toEqual([]);
  });

  test("every case matches, colour off, shortcodes off", () => {
    expect(inlineParityFailures(false)).toEqual([]);
  });

  test("every case matches with colour forced on, in a fresh subprocess", async () => {
    const helper = resolve(import.meta.dir, "helpers/inline-parity.ts");
    const inlineModule = resolve(import.meta.dir, "../src/inline.ts");
    const child = `
      const argv = process.argv;
      const { inlineParityFailures } = await import(argv[argv.length - 2]);
      const { detectInlineColor } = await import(argv[argv.length - 1]);
      process.stdout.write(JSON.stringify({
        color: detectInlineColor(),
        emojiOn: inlineParityFailures(true),
        emojiOff: inlineParityFailures(false),
      }));
    `;
    const proc = Bun.spawn(["bun", "-e", child, "--", helper, inlineModule], {
      env: { ...process.env, FORCE_COLOR: "3" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(exitCode, `subprocess stderr: ${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout) as { color: boolean; emojiOn: ParityCase[]; emojiOff: ParityCase[] };
    // If this is false the whole test is vacuous: the library emits no escape sequences
    // at level 0, so a colour-blind comparison would pass whatever the owned emitters do.
    expect(parsed.color).toBe(true);
    expect(parsed.emojiOn).toEqual([]);
    expect(parsed.emojiOff).toEqual([]);
  });
});

describe("inline visitors — the exact bytes, with the colour decision supplied", () => {
  // These do not need a subprocess: the owned emitters branch on `LayoutContext.color`,
  // which is precisely what makes them testable at both settings in one process, and
  // what stops the non-TTY/`@colors` divergence from reaching the output.
  const on = context({ color: true });
  const off = context({ color: false });

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

describe("inline visitors — the library behaviours that must not be tidied up", () => {
  const ctx = context({ color: false });

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
    const rendered = renderLink(context({ color: false, emoji: true }), token, parse);
    expect(rendered).toContain("\u{1F680} ");
    const literal = renderLink(context({ color: false, emoji: false }), token, parse);
    expect(literal).toContain(":rocket:");
  });
});

describe("detectInlineColor — the renderer's own enablement rule", () => {
  test("it is off under a non-TTY test run, where chalk is at level 0", () => {
    expect(detectInlineColor()).toBe(false);
  });

  test("it does not consult @colors/colors, which answers differently here", async () => {
    // `src/table.ts` deliberately keeps `@colors`' environment-only rule, which says yes
    // in this very process. If the two ever agreed by construction this assertion would
    // be pointless; they do not, which is exactly why the decision is carried as a value.
    const colors = (await import("@colors/colors/safe")).default as unknown as { enabled: boolean };
    expect(colors.enabled).toBe(true);
    expect(detectInlineColor()).toBe(false);
  });

  test("it is on in a subprocess with FORCE_COLOR set before module load", async () => {
    const modulePath = resolve(import.meta.dir, "../src/inline.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { detectInlineColor } = await import(process.argv[process.argv.length - 1]);
         process.stdout.write(String(detectInlineColor()));`,
        "--",
        modulePath,
      ],
      { env: { ...process.env, FORCE_COLOR: "3" }, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(stdout).toBe("true");
  });
});

/**
 * The colour decision, pinned by behaviour rather than by implementation.
 *
 * WP-6 moved `detectInlineColor` off `marked-terminal`'s `chalk` probe and onto
 * `supports-color`, the library `chalk` is a wrapper over, on the evidence of a 36-cell
 * environment matrix the two agreed on completely (see `src/inline.ts`). These four cases
 * are the part of that matrix a test can run without a pty, and they are chosen for one
 * property: **each one fails if the rule is ever replaced by a TTY check.** A hand-rolled
 * `process.stdout.isTTY` answers *false* for all four, so a reimplementation that "looked
 * fine locally" cannot pass them. Each runs in a fresh subprocess because the answer is
 * resolved at module load, exactly as `chalk`'s level was.
 */
describe("detectInlineColor — the environment cases a TTY check would get wrong", () => {
  const ask = async (env: Record<string, string>, argv: string[] = []): Promise<string> => {
    const modulePath = resolve(import.meta.dir, "../src/inline.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { detectInlineColor } = await import(process.argv[process.argv.length - 1]);
         process.stdout.write(String(detectInlineColor()));`,
        // After the `--`, deliberately: `bun -e` consumes anything flag-shaped before it,
        // so a flag placed earlier never reaches the child's `process.argv` and the case
        // would pass or fail for a reason that has nothing to do with the rule under test.
        "--",
        ...argv,
        modulePath,
      ],
      { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return stdout;
  };

  test("FORCE_COLOR=1 turns it on with no TTY anywhere", async () => {
    expect(await ask({ FORCE_COLOR: "1" })).toBe("true");
  });

  test("FORCE_COLOR=false turns it off, and is not read as the truthy string it is", async () => {
    expect(await ask({ FORCE_COLOR: "false" })).toBe("false");
  });

  test("a --color flag on the command line turns it on", async () => {
    expect(await ask({}, ["--color"])).toBe("true");
  });

  test("an empty FORCE_COLOR still means on — presence is the signal, not the value", async () => {
    expect(await ask({ FORCE_COLOR: "" })).toBe("true");
  });

  test("--no-color turns it off, and loses to an explicit FORCE_COLOR", async () => {
    expect(await ask({}, ["--no-color"])).toBe("false");
    // Measured, not assumed, and it is the order the replaced `chalk` probe also had:
    // the environment variable is consulted first and short-circuits the flag sniff.
    expect(await ask({ FORCE_COLOR: "1" }, ["--no-color"])).toBe("true");
  });
});
