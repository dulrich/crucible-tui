import type { Tokens } from "marked";
import { renderCode, renderHr, renderHtml } from "../../src/blocks";
import { UNICODE_GLYPHS } from "../../src/glyphs";
import { createLayoutContext, type LayoutContext } from "../../src/layout-context";
import { NARROW_MEASURE } from "../../src/width";
import { BLOCK_PARITY_GOLDEN } from "./block-parity-golden";

/**
 * The block-leaf parity table: the three owned block renderers that are **class A** against
 * the `marked-terminal` methods they replaced, on the same input, byte for byte.
 *
 * WP-3 of `plans/marked-terminal-replacement.md` is a class-B package *as a whole* — its
 * reflow measures display width where the library measured UTF-16 code units, and that
 * difference is the point. But three of the six methods it takes over never called
 * `reflowText` and never read `this.o.width`: `code`, `hr` and `html`. Owning those is a
 * transcription, a transcription is provable, and proving it separately is what separates
 * "I transcribed three methods correctly" from "my new reflow engine changed things" when
 * the class-B diffs arrive. `paragraph`, `heading` and `blockquote` are deliberately absent
 * from this table — they are *supposed* to move, and `tests/blocks.test.ts` pins what they
 * move to instead.
 *
 * Shaped after `tests/helpers/inline-parity.ts` and for the same reason: it has to run
 * **twice**. `bun test` is never a TTY, so the resolved policy is colour-off, no escape
 * sequences are emitted at all, and a colour-blind comparison would pass vacuously on the
 * axis WP-3 changed. Since WP-6 the two sides are `colorOff` and `colorOn` in
 * `./block-parity-golden.ts` rather than two live library answers.
 *
 * Colour matters more here than it did for the inline group, because `highlight()`
 * (`marked-terminal` `index.js:590-602`, transcribed into `src/blocks.ts`) *branches* on
 * it: with colour off it returns the fence's text unstyled and never calls the colorizer
 * at all, so the unforced half of this table cannot see the highlighting path even in
 * principle.
 *
 * **The colour-on half stopped needing its own process at WP-2 of
 * `plans/colour-policy.md`.** It ran in a child under `FORCE_COLOR=3` because
 * `cli-highlight` resolved its own `chalk`'s level at module load, so no argument could
 * make it style inside a test process; `src/highlight.ts` reads the policy it is handed.
 * `tests/blocks.test.ts` runs the colour-on table in-process *and* keeps the subprocess
 * beside it as the control that the two still agree.
 */

export interface BlockParityCase {
  name: string;
  ours: string;
  theirs: string;
}

const WIDTH = 80;

/**
 * The library's side of the table, frozen (WP-6).
 *
 * These bytes used to come from `markedTerminal({ width: 80, reflowText: true, emoji: true })`,
 * called with a receiver carrying `{ options: { gfm: true }, parser }` — the two fields each
 * extension wrapper rebound onto its private renderer, `gfm` because `code` reads it. WP-6
 * removed the dependency, so the same values are read from `./block-parity-golden.ts`,
 * captured from that exact call on the commit before the removal. A missing entry throws
 * rather than skipping the case.
 */
function goldenBytes(color: boolean, name: string): string {
  const value = BLOCK_PARITY_GOLDEN[color ? "colorOn" : "colorOff"][name];
  if (value === undefined) throw new Error(`no frozen byte string for block case ${name} (color=${color})`);
  return value;
}

// The two-mode parity harness stays a *boolean* harness on purpose: the frozen golden
// tables have exactly two sides, `colorOn` and `colorOff`, and those two sides are the
// pre-`SgrMode` renders this file exists to hold still. The mapping to the canonical value
// happens here and nowhere else — `true` is `"full"`, `false` is `"none"` — so WP-2 of
// `plans/colour-modes.md` moved no golden byte and could not have. `formats` is a third
// mode with no golden to compare against; it is pinned per producer in its own tests.
function context(color: boolean): LayoutContext {
  return createLayoutContext({
    width: WIDTH,
    glyphs: UNICODE_GLYPHS,
    measure: NARROW_MEASURE,
    // Identity, so both sides are handed the same language and the comparison is about the
    // renderer rather than about `src/lang.ts`'s normalisation (which has its own tests).
    resolveFenceLanguage: (raw) => raw,
    emoji: true,
    sgr: color ? "full" : "none",
  });
}

/**
 * `marked-terminal`'s own `hr()` helper at this width, spelled out rather than imported.
 *
 * `index.js:612-615` is `new Array(length).join(inputHrStr)`, which yields `length - 1`
 * characters — an off-by-one baked into the library that this repo reproduces in
 * `renderRule` because the frontmatter divider has to match the document's own rule. In the
 * ASCII tier `renderRule` *is* this string, which is what makes the owned `hr` a
 * transcription rather than a redesign.
 */
const ASCII_RULE = "-".repeat(WIDTH - 1);

export function blockParityCases(color: boolean): BlockParityCase[] {
  const ctx = context(color);

  const cases: BlockParityCase[] = [];
  const add = (name: string, ours: string): void => {
    cases.push({ name, ours, theirs: goldenBytes(color, name) });
  };

  const codeCases: Array<[string, string, string | undefined]> = [
    ["plain, no language", "const x = 1;", undefined],
    ["javascript", "const x = 1;\nconsole.log(x);", "javascript"],
    ["bash", "bun run verify", "bash"],
    // `indentify` indents blank lines too, so this one carries four trailing spaces on the
    // empty line — the trap that would turn a "tidy up" into a class-C failure.
    ["blank line inside", "a\n\nb", "plaintext"],
    // `fixHardReturn`'s upstream defect fires here, inside a code range, on the *first*
    // carriage return only. It is applied before the highlighter and only when colour is on.
    ["hard return", "before\rafter", "plaintext"],
    ["two hard returns", "a\rb\rc", "plaintext"],
    // A language highlight.js cannot resolve: it logs through `console.error` and throws,
    // so this is the one case that reaches `renderCode`'s `catch` — the only place
    // `chalk.yellow` is applied. `tests/blocks.test.ts` captures and asserts the message.
    ["unresolvable language", "whatever", "not-a-real-language"],
    ["empty", "", "plaintext"],
    ["trailing newline", "line\n", "plaintext"],
  ];
  for (const [label, text, lang] of codeCases) {
    const token = { type: "code", raw: text, text, lang, escaped: false } as unknown as Tokens.Code;
    add(`code/${label}`, renderCode(ctx, token));
  }

  add("hr", renderHr(ctx, ASCII_RULE));

  const htmlCases: Array<[string, string]> = [
    ["single line", "<div>hello</div>"],
    // `chalk.gray` closes and reopens around every line break; a block-HTML token routinely
    // carries them, so this is the live case rather than a theoretical one.
    ["multi line", "<div>\n  <span>a</span>\n</div>"],
    ["trailing newline", "<br>\n"],
    ["entities left alone", "<p>a &amp; b &lt;c&gt;</p>"],
    ["empty", ""],
  ];
  for (const [label, text] of htmlCases) {
    const token = { type: "html", raw: text, text, block: true } as unknown as Tokens.HTML;
    // A budget far wider than any case here, so the owned line-wrap is a provable no-op and
    // this compares the emission — which is all the library ever did for `html`.
    add(`html/${label}`, renderHtml(ctx, token, 1000));
  }

  return cases;
}

/** Every case whose two sides disagree. Empty is the pass condition. */
export function blockParityFailures(color: boolean): BlockParityCase[] {
  return blockParityCases(color).filter((entry) => entry.ours !== entry.theirs);
}
