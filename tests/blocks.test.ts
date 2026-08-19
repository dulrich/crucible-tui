import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  renderBlockquote,
  renderCode,
  renderHeading,
  renderHr,
  renderHtml,
  renderParagraph,
} from "../src/blocks";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { createLayoutContext, type LayoutContext } from "../src/layout-context";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import { blockParityCases, blockParityFailures, type BlockParityCase } from "./helpers/block-parity";
import { forcedColorChildEnv } from "./helpers/color";

const ESC = "\u001b";

function context(overrides: { width?: number; color?: boolean; emoji?: boolean; wide?: boolean } = {}): LayoutContext {
  return createLayoutContext({
    width: overrides.width ?? 80,
    glyphs: UNICODE_GLYPHS,
    measure: overrides.wide ? WIDE_MEASURE : NARROW_MEASURE,
    resolveFenceLanguage: (raw) => raw,
    emoji: overrides.emoji ?? true,
    color: overrides.color ?? false,
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const asToken = (value: Record<string, unknown>): any => value;
/* eslint-enable @typescript-eslint/no-explicit-any */

const parse = (tokens: unknown[]): string =>
  tokens.map((token) => (token as { text?: string }).text ?? "").join("");

const children = (text: string): Record<string, unknown>[] => [{ type: "text", raw: text, text }];

const paragraph = (text: string): Record<string, unknown> => ({
  type: "paragraph",
  raw: text,
  text,
  tokens: children(text),
});

const heading = (depth: number, text: string): Record<string, unknown> => ({
  type: "heading",
  raw: text,
  depth,
  text,
  tokens: children(text),
});

// ---------------------------------------------------------------------------
// The class-A three, against the library.
// ---------------------------------------------------------------------------

describe("code, hr and html — byte parity with the marked-terminal methods they replaced", () => {
  // `bun test` is never a TTY, so the resolved policy is colour-off here and both sides
  // emit plain text. For `code` specifically that half is not merely blind to styling, it
  // is blind to the highlighter: `highlight()` returns the fence unstyled when
  // `ctx.color` is false and never calls the colorizer at all. The colour-on test below
  // is the one that exercises it.
  test("every case matches, colour off", () => {
    expect(blockParityFailures(false)).toEqual([]);
  });

  // **This was a subprocess until WP-2 of `plans/colour-policy.md`, and `code` was why.**
  // WP-1 made the colour *decision* a parameter, but `renderCode`'s colour-on branch still
  // called `cli-highlight`, whose styling was gated on its own bundled `chalk`'s
  // module-load level — 0 in this process — so an in-process colour-on run compared
  // unstyled output against a golden captured under `FORCE_COLOR=3` and failed for a
  // reason that had nothing to do with the transcription. `src/highlight.ts` reads the
  // policy it is handed and nothing else, so the case runs here, in one process, like the
  // inline table already did. The subprocess is kept alongside it (below) precisely to
  // prove the two agree — an in-process claim about colour is exactly the kind this repo
  // has shipped green and wrong before.
  test("every case matches with colour on, in this process", () => {
    // The table's `unresolvable language` case reaches highlight.js, which logs through
    // `console.error` before throwing (`src/lang.ts` exists so a real fence never does).
    // Captured rather than left to pollute the run — and asserted, so the case is known to
    // have taken the branch `renderCode`'s `catch` is written for.
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let cases: BlockParityCase[];
    try {
      cases = blockParityCases(true);
    } finally {
      console.error = original;
    }
    expect(captured.some((message) => message.includes("not-a-real-language"))).toBe(true);
    // Non-vacuity, asserted on the bytes rather than on a detector's opinion of the
    // environment: if neither side carries an escape the comparison proves nothing — and
    // for `code` it is worse than nothing, because an unstyled highlighter short-circuits
    // the branch under test.
    expect(cases.some((entry) => entry.ours.includes(ESC))).toBe(true);
    expect(cases.some((entry) => entry.theirs.includes(ESC))).toBe(true);
    expect(cases.filter((entry) => entry.ours !== entry.theirs)).toEqual([]);
  });

  // The same table, in a child under `FORCE_COLOR=3`, kept as the control on the move
  // above: it is the environment the golden bytes were captured in, and if anything in
  // this renderer ever starts resolving a colour question at module load again, these two
  // tests are what disagree.
  test("and the same cases match in a subprocess under FORCE_COLOR=3", async () => {
    const helper = resolve(import.meta.dir, "helpers/block-parity.ts");
    const child = `
      const argv = process.argv;
      // highlight.js logs an unresolvable language through console.error and then throws;
      // captured rather than left to pollute the test run's stderr.
      console.error = () => {};
      const { blockParityCases } = await import(argv[argv.length - 1]);
      const cases = blockParityCases(true);
      process.stdout.write(JSON.stringify({
        sawEscapes: cases.some((entry) => entry.ours.includes("\\u001b")),
        goldenSawEscapes: cases.some((entry) => entry.theirs.includes("\\u001b")),
        failures: cases.filter((entry) => entry.ours !== entry.theirs),
      }));
    `;
    const proc = Bun.spawn(["bun", "-e", child, "--", helper], {
      env: forcedColorChildEnv(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    expect(exitCode, `subprocess stderr: ${stderr}`).toBe(0);

    const parsed = JSON.parse(stdout) as {
      sawEscapes: boolean;
      goldenSawEscapes: boolean;
      failures: BlockParityCase[];
    };
    expect(parsed.sawEscapes).toBe(true);
    expect(parsed.goldenSawEscapes).toBe(true);
    expect(parsed.failures).toEqual([]);
  });
});

describe("code — the three branches of the library's highlight()", () => {
  const off = context({ color: false });

  test("colour off returns the fence verbatim, indented four columns, with section padding", () => {
    const token = asToken({ type: "code", raw: "", text: "const x = 1;", lang: "javascript" });
    expect(renderCode(off, token)).toBe("    const x = 1;\n\n");
  });

  test("indentify indents blank lines too — four trailing spaces, and they must survive", () => {
    // `indentify` (index.js:505) is `indent + text.split('\\n').join('\\n' + indent)`, so an
    // empty line gets the indent as well. This lands inside a `codeRange`, where any change
    // is parity class C, so "tidying" it away is the failure this pins against.
    const token = asToken({ type: "code", raw: "", text: "a\n\nb", lang: "plaintext" });
    expect(renderCode(off, token)).toBe("    a\n    \n    b\n\n");
  });

  test("colour off does not apply fixHardReturn — the library checks the level first", () => {
    // `highlight()` returns at :591 before reaching :595, so the `\\r` survives untouched.
    const token = asToken({ type: "code", raw: "", text: "a\rb", lang: "plaintext" });
    expect(renderCode(off, token)).toBe("    a\rb\n\n");
  });

  test("the fence language is normalised through the context resolver, not a module import", () => {
    const seen: Array<string | undefined> = [];
    const ctx = createLayoutContext({
      width: 80,
      glyphs: UNICODE_GLYPHS,
      measure: NARROW_MEASURE,
      resolveFenceLanguage: (raw) => {
        seen.push(raw);
        return "plaintext";
      },
      emoji: true,
      color: false,
    });
    renderCode(ctx, asToken({ type: "code", raw: "", text: "x", lang: "dataviewjs" }));
    expect(seen).toEqual(["dataviewjs"]);
  });
});

describe("hr", () => {
  test("emits exactly the rule it is handed, plus section padding", () => {
    // The rule text is computed by `renderRule` in `src/render.ts` — shared with the
    // frontmatter divider, and deliberately the only place that computes one — so this
    // renderer's whole job is styling it and adding the two newlines.
    expect(renderHr(context(), "-".repeat(79))).toBe(`${"-".repeat(79)}\n\n`);
    expect(renderHr(context(), "─────")).toBe("─────\n\n");
  });

  test("chalk.reset wraps it when colour is on, and reset is \\x1b[0m at both ends", () => {
    expect(renderHr(context({ color: true }), "---")).toBe(`${ESC}[0m---${ESC}[0m\n\n`);
  });

  test("an empty rule stays empty rather than picking up a bare escape pair", () => {
    // chalk's own guard: level 0 *or* an empty string returns the input untouched. At
    // width 1 the rule is empty, and this is the shape that reaches the terminal.
    expect(renderHr(context({ color: true }), "")).toBe("\n\n");
  });
});

describe("html", () => {
  test("grey, no section padding, no transform — the only leaf that adds nothing", () => {
    const token = asToken({ type: "html", raw: "", text: "<div>a &amp; b</div>", block: true });
    expect(renderHtml(context(), token, 80)).toBe("<div>a &amp; b</div>");
  });

  test("over-budget lines are wrapped under their own leading prefix", () => {
    const text = "    <span>alpha beta gamma delta epsilon</span>";
    const token = asToken({ type: "html", raw: "", text, block: true });
    expect(renderHtml(context(), token, 24).split("\n")).toEqual([
      "    <span>alpha beta",
      "    gamma delta",
      "    epsilon</span>",
    ]);
  });

  test("a line already within budget is returned untouched, so the pass is idempotent", () => {
    const token = asToken({ type: "html", raw: "", text: "<p>short</p>", block: true });
    expect(renderHtml(context(), token, 80)).toBe("<p>short</p>");
  });
});

// ---------------------------------------------------------------------------
// The class-B three: what they now do that the library did not.
// ---------------------------------------------------------------------------

describe("paragraph", () => {
  test("wraps at the budget it is handed, not at the context width", () => {
    // The whole reason both per-budget `marked-terminal` caches could be deleted: the width
    // is a parameter now, where the library took it only at construction.
    const token = asToken(paragraph("alpha beta gamma delta"));
    expect(renderParagraph(context(), token, parse, 12)).toBe("alpha beta\ngamma delta\n\n");
  });

  test("measures display columns, not UTF-16 code units — the defect this package exists for", () => {
    // Six CJK ideographs are 6 `.length` and 12 columns. The library fitted all six at
    // width 8 and overflowed the terminal by four columns; measuring correctly does not.
    const token = asToken(paragraph("一二三四五六"));
    expect(renderParagraph(context(), token, parse, 8)).toBe("一二三四\n五六\n\n");
  });

  test("the ambiguous-width resolution reaches the wrap through the context's Measure", () => {
    // The em dash is East Asian *Ambiguous*: one column under the narrow resolution, two
    // under the wide one, and `.length` says one either way. Threading `Measure` rather than
    // measuring at the point of use is what makes the same paragraph wrap differently on a
    // terminal that draws it wide — the reason `src/width.ts` is the single ruler.
    const token = asToken(paragraph("ab \u2014\u2014\u2014"));
    expect(renderParagraph(context(), token, parse, 6)).toBe("ab \u2014\u2014\u2014\n\n");
    expect(renderParagraph(context({ wide: true }), token, parse, 6)).toBe("ab\n\u2014\u2014\u2014\n\n");
  });

  test("runs the transform: emoji, then entity unescaping, then the colon sentinel", () => {
    const token = asToken(paragraph("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"));
    expect(renderParagraph(context(), token, parse, 80)).toBe("a & b <c> \"d\" 'e'\n\n");
  });

  test("undoes the colon sentinel a code span emitted", () => {
    // `src/inline.ts`'s `codespan` still emits `*#COLON|*` because the renderers that undo
    // it were the library's — and two of them are here now. Dropping this would render the
    // sentinel literally wherever a code span contains a colon.
    const token = asToken(paragraph("see *#COLON|*this*#COLON|*"));
    expect(renderParagraph(context(), token, parse, 80)).toBe("see :this:\n\n");
  });

  test("shortcode substitution follows the context's emoji setting", () => {
    const token = asToken(paragraph(":rocket:"));
    expect(renderParagraph(context({ emoji: true }), token, parse, 80)).toBe("🚀\n\n");
    expect(renderParagraph(context({ emoji: false }), token, parse, 80)).toBe(":rocket:\n\n");
  });

  test("an authored hard break ends a section and survives the wrap", () => {
    // `br` emits `\\r`; without the section split `wrapAnsi` would treat it as whitespace
    // and collapse the break into a space, which is a regression rather than an improvement.
    const token = asToken(paragraph("alpha\rbeta"));
    expect(renderParagraph(context(), token, parse, 80)).toBe("alpha\nbeta\n\n");
  });

  test("a literal <br /> ends a section too, because marked's gfm option is on", () => {
    const token = asToken(paragraph("alpha<br />beta"));
    expect(renderParagraph(context(), token, parse, 80)).toBe("alpha\nbeta\n\n");
  });

  test("styling is applied before the wrap, so it opens once and closes once", () => {
    // `paragraph` composes `chalk.reset` *outside* `this.transform` and reflows afterwards
    // (index.js:205-208) — the inverse of `heading`, which reflows first and therefore gets
    // chalk's line-break encasing on every wrapped line. Here the style sees a single line, so
    // it opens once at the top and closes once at the bottom and the wrap simply carries the
    // escapes along. Standardising the two orders would move bytes on every styled paragraph
    // in the corpus at forced colour, for nothing.
    const token = asToken(paragraph("alpha beta"));
    expect(renderParagraph(context({ color: true }), token, parse, 5)).toBe(
      `${ESC}[0malpha\nbeta${ESC}[0m\n\n`,
    );
  });

  test("an over-long word starts on a fresh line and is split grapheme-correctly", () => {
    // The library filled the current line's remainder first and split in UTF-16 code units,
    // which can cut a multi-unit character in half. This is the divergence kept on merit.
    const token = asToken(paragraph("ab abcdefghij"));
    expect(renderParagraph(context(), token, parse, 5)).toBe("ab\nabcde\nfghij\n\n");
  });
});

describe("heading", () => {
  test("prepends the section prefix, and it counts against the budget", () => {
    const token = asToken(heading(2, "alpha beta"));
    expect(renderHeading(context(), token, parse, 9)).toBe("## alpha\nbeta\n\n");
  });

  test("the hash run is one per level", () => {
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const token = asToken(heading(depth, "t"));
      expect(renderHeading(context(), token, parse, 80)).toBe(`${"#".repeat(depth)} t\n\n`);
    }
  });

  test("level 1 is magenta+underline+bold; every other level is green+bold", () => {
    // And the style is applied *after* the reflow (index.js:127-131), the inverse of
    // `paragraph` — so it wraps the whole already-wrapped block in one pair.
    const on = context({ color: true });
    expect(renderHeading(on, asToken(heading(1, "t")), parse, 80)).toBe(
      `${ESC}[35m${ESC}[4m${ESC}[1m# t${ESC}[22m${ESC}[24m${ESC}[39m\n\n`,
    );
    expect(renderHeading(on, asToken(heading(2, "t")), parse, 80)).toBe(
      `${ESC}[32m${ESC}[1m## t${ESC}[22m${ESC}[39m\n\n`,
    );
  });

  test("a wrapped heading closes and reopens its styling around the break", () => {
    const on = context({ color: true });
    expect(renderHeading(on, asToken(heading(2, "alpha beta")), parse, 9)).toBe(
      `${ESC}[32m${ESC}[1m## alpha${ESC}[22m${ESC}[39m\n${ESC}[32m${ESC}[1mbeta${ESC}[22m${ESC}[39m\n\n`,
    );
  });

  test("runs the same transform as paragraph", () => {
    expect(renderHeading(context(), asToken(heading(3, "a &amp; b")), parse, 80)).toBe("### a & b\n\n");
  });
});

describe("blockquote", () => {
  test("indents the whole body four columns and adds section padding", () => {
    expect(renderBlockquote(context(), "alpha\nbeta\n\n")).toBe("    alpha\n    beta\n\n");
  });

  test("keeps the first content line's own indent instead of trimming and restoring it", () => {
    // The library's `quote.trim()` ate it, and `src/render.ts` measured it off the input and
    // pasted it back onto the styled output afterwards. Not eating it is the same rendered
    // text in one pass — and it is the whole class-B story for this method.
    expect(renderBlockquote(context(), "    * alpha\n    * beta\n\n")).toBe(
      "        * alpha\n        * beta\n\n",
    );
  });

  test("a leading blank line is still nothing to give back", () => {
    // `trim` also ate newlines and tabs; only the spaces on the *last* line of the leading
    // whitespace run are a real first-line indent.
    expect(renderBlockquote(context(), "\n\n    alpha\n\n")).toBe("        alpha\n\n");
    expect(renderBlockquote(context(), "\t alpha\n\n")).toBe("    alpha\n\n");
  });

  test("an empty body produces nothing but the section padding", () => {
    expect(renderBlockquote(context(), "")).toBe("\n\n");
    expect(renderBlockquote(context(), "   \n\n")).toBe("\n\n");
  });

  test("grey italic when colour is on, with the indent inside the styling", () => {
    expect(renderBlockquote(context({ color: true }), "alpha\n\n")).toBe(
      `${ESC}[90m${ESC}[3m    alpha${ESC}[23m${ESC}[39m\n\n`,
    );
  });

  test("does not reflow — its children already did, at the budget it owed them", () => {
    const long = "x".repeat(200);
    expect(renderBlockquote(context({ width: 20 }), `${long}\n\n`)).toBe(`    ${long}\n\n`);
  });
});
