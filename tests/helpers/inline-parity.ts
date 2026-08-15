import type { Token, Tokens } from "marked";
import { UNICODE_GLYPHS } from "../../src/glyphs";
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
} from "../../src/inline";
import { createLayoutContext, type LayoutContext } from "../../src/layout-context";
import { NARROW_MEASURE } from "../../src/width";
import { INLINE_PARITY_GOLDEN } from "./inline-parity-golden";

/**
 * The inline parity table — every owned visitor against the library method it replaced,
 * on the same input, byte for byte.
 *
 * WP-2 of `plans/marked-terminal-replacement.md` is a **parity class A** package: the
 * output may not move. The corpus harness (`scripts/render-diff.ts`) proves that over real
 * documents; this proves it per method, on inputs a corpus does not reliably contain —
 * a hard break inside emphasis, a style whose own close code already appears in its
 * children, a link whose text is its href.
 *
 * It lives in a helper rather than in the test file because it has to run **twice, in two
 * processes**: `bun test` is never a TTY, so the colour decision resolves to off and no
 * escape sequences are emitted at all, which would make a colour-blind comparison pass
 * vacuously on exactly the axis WP-2 changed. The colour-on half runs the same table in a
 * fresh subprocess under `FORCE_COLOR=3`, for the reason `tests/helpers/color.ts` documents
 * at length: the decision is fixed at module load, so setting the variable afterwards
 * inside a shared test process does nothing. **That split survived WP-6 unchanged and now
 * selects between two frozen tables** — `colorOff` and `colorOn` in
 * `./inline-parity-golden.ts` — rather than between two live library answers.
 *
 * The stub parser is what makes arbitrary inputs reachable. It is what the *library* side
 * was called with when these bytes were captured, and it is still what the owned side is
 * called with here: it returns the concatenated `text` of a token's children, so a case can
 * inject a newline, a carriage return or a raw escape sequence into a visitor's children
 * directly, without needing markdown that happens to produce one.
 */

export interface ParityCase {
  name: string;
  ours: string;
  theirs: string;
}

/** `parseInline`, stubbed: the children's own text, concatenated. */
function stubParseInline(tokens: Token[]): string {
  return tokens.map((token) => (token as { text?: string }).text ?? "").join("");
}

/** A child token list that makes `stubParseInline` return exactly `text`. */
function children(text: string): Token[] {
  return [{ type: "text", raw: text, text } as unknown as Token];
}

/**
 * The library's side of the table, frozen (WP-6).
 *
 * These bytes used to come from `markedTerminal({ width: 80, reflowText: true, emoji })`,
 * called live with a receiver carrying `options` and `parser` — the two fields each
 * extension wrapper rebound onto its private renderer. WP-6 removed the dependency, so the
 * same values are read from `./inline-parity-golden.ts`, captured from that exact call on
 * the commit before the removal. What is compared, and on how many cases, is unchanged;
 * only where the right-hand side comes from moved. A missing entry is a loud failure
 * rather than a skipped case, so adding a case below without capturing its counterpart
 * cannot pass quietly.
 */
function goldenBytes(emoji: boolean, color: boolean, name: string): string {
  const table = INLINE_PARITY_GOLDEN[color ? "colorOn" : "colorOff"][emoji ? "emojiOn" : "emojiOff"];
  const value = table[name];
  if (value === undefined) {
    throw new Error(`no frozen byte string for inline case ${name} (emoji=${emoji}, color=${color})`);
  }
  return value;
}

function context(emoji: boolean, color: boolean): LayoutContext {
  return createLayoutContext({
    width: 80,
    glyphs: UNICODE_GLYPHS,
    measure: NARROW_MEASURE,
    resolveFenceLanguage: (raw) => raw,
    emoji,
    color,
  });
}

const ESC = "\u001b";
const YELLOW = `${ESC}[33m`;
const YELLOW_OFF = `${ESC}[39m`;
const BOLD_OFF = `${ESC}[22m`;

/**
 * Build the whole table for one `emoji` setting.
 *
 * `color` is not a parameter: the owned side reads `detectInlineColor()`, which is
 * `chalk`'s own answer for this process, so both sides are gated by the same decision and
 * the comparison is meaningful whichever process it runs in.
 */
export function inlineParityCases(emoji: boolean): ParityCase[] {
  const color = detectInlineColor();
  const ctx = context(emoji, color);
  const cases: ParityCase[] = [];

  const add = (name: string, ours: string): void => {
    cases.push({ name, ours, theirs: goldenBytes(emoji, color, name) });
  };
  const strongCases: Array<[string, string]> = [
    ["plain", "bold words"],
    ["nested style", `has ${YELLOW}code${YELLOW_OFF} inside`],
    // The re-open path: the children already carry this style's own close code.
    ["own close code present", `a${BOLD_OFF}b`],
    ["newline", "first\nsecond"],
    ["carriage return then newline", "first\r\nsecond"],
    ["empty", ""],
  ];
  for (const [label, text] of strongCases) {
    const token = { type: "strong", raw: text, text, tokens: children(text) } as unknown as Tokens.Strong;
    add(`strong/${label}`, renderStrong(ctx, token, stubParseInline));
  }

  const emCases: Array<[string, string]> = [
    ["plain", "emphasised"],
    // `fixHardReturn`'s upstream defect is reachable only from `em` and `codespan`.
    ["hard return", "before\rafter"],
    ["two hard returns", "a\rb\rc"],
    ["nested style", `has ${YELLOW}code${YELLOW_OFF} inside`],
  ];
  for (const [label, text] of emCases) {
    const token = { type: "em", raw: text, text, tokens: children(text) } as unknown as Tokens.Em;
    add(`em/${label}`, renderEm(ctx, token, stubParseInline));
  }

  const codespanCases: Array<[string, string]> = [
    ["plain", "value"],
    ["colons", "a:b:c"],
    ["shortcode", ":rocket:"],
    ["hard return", "before\rafter"],
    ["empty", ""],
  ];
  for (const [label, text] of codespanCases) {
    const token = { type: "codespan", raw: text, text } as unknown as Tokens.Codespan;
    add(`codespan/${label}`, renderCodespan(ctx, token));
  }

  const delCases: Array<[string, string]> = [
    ["plain", "struck out"],
    // Grey's close code is the same `39m` a code span closes with, so this exercises the
    // innermost-outward re-open walk across a three-link chain.
    ["nested style", `struck ${YELLOW}code${YELLOW_OFF} out`],
    ["newline", "first\nsecond"],
  ];
  for (const [label, text] of delCases) {
    const token = { type: "del", raw: text, text, tokens: children(text) } as unknown as Tokens.Del;
    add(`del/${label}`, renderDel(ctx, token, stubParseInline));
  }

  const linkCases: Array<[string, string, string]> = [
    ["labelled", "https://example.com/page", "the label"],
    // A bare autolink: `marked` gives text === href, and `hasText` goes false.
    ["bare", "https://example.com/page", "https://example.com/page"],
    ["no text", "https://example.com/page", ""],
    ["plus in url", "https://example.com/a+b+c", "spaces"],
    ["shortcode in label", "https://example.com/page", "ship it :rocket:"],
    ["styled label", "https://example.com/page", `a ${YELLOW}b${YELLOW_OFF} c`],
  ];
  for (const [label, href, text] of linkCases) {
    const token = {
      type: "link",
      raw: href,
      href,
      title: null,
      text,
      tokens: children(text),
    } as unknown as Tokens.Link;
    add(`link/${label}`, renderLink(ctx, token, stubParseInline));
  }

  const imageCases: Array<[string, string, string | null, string]> = [
    ["no title", "https://example.com/i.png", null, "alt text"],
    ["with title", "https://example.com/i.png", "The Title", "alt text"],
    ["empty alt", "https://example.com/i.png", null, ""],
  ];
  for (const [label, href, title, text] of imageCases) {
    const token = { type: "image", raw: href, href, title, text } as unknown as Tokens.Image;
    add(`image/${label}`, renderImage(token));
  }

  add("br", renderBr());

  for (const [label, text] of [
    ["plain", "some text"],
    ["with colons", "a:b"],
    ["with shortcode", "ship :rocket: it"],
  ] as Array<[string, string]>) {
    const token = { type: "text", raw: text, text } as unknown as Tokens.Text;
    add(`text/${label}`, renderInlineText(token));
  }

  return cases;
}

/** Every case whose two sides disagree. Empty is the pass condition. */
export function inlineParityFailures(emoji: boolean): ParityCase[] {
  return inlineParityCases(emoji).filter((entry) => entry.ours !== entry.theirs);
}
