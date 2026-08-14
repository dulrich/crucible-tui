import { markedTerminal } from "marked-terminal";
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
 * processes**: `bun test` is never a TTY, so `chalk` resolves to level 0 and the library
 * emits no escape sequences at all, which would make a colour-blind comparison pass
 * vacuously on exactly the axis this package changed. The colour-on half runs the same
 * table in a fresh subprocess under `FORCE_COLOR=3`, for the reason
 * `tests/helpers/color.ts` documents at length: `chalk` fixes its level at module load,
 * so setting the variable afterwards inside a shared test process does nothing.
 *
 * The stub parser is what makes arbitrary inputs reachable. Both sides call
 * `parseInline(token.tokens)`; this returns the concatenated `text` of those child tokens,
 * so a case can inject a newline, a carriage return or a raw escape sequence into a
 * visitor's children directly, without needing markdown that happens to produce one.
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

/** The receiver each library extension method rebinds onto its private renderer. */
const libraryReceiver = { options: {}, parser: { parseInline: stubParseInline } };

type LibraryMethod = (this: typeof libraryReceiver, token: unknown) => string | false;

function libraryMethods(emoji: boolean): Record<string, LibraryMethod> {
  // Same three options `renderDocumentDetailed` constructs the real extension with.
  const renderer = markedTerminal({ width: 80, reflowText: true, emoji }).renderer as unknown as Record<
    string,
    LibraryMethod
  >;
  return renderer;
}

/** One extension method, or a loud failure — the shim types every entry as optional. */
function libraryMethod(renderer: Record<string, LibraryMethod>, name: string): LibraryMethod {
  const method = renderer[name];
  if (!method) throw new Error(`marked-terminal exposes no inline ${name} method`);
  return method;
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
  const ctx = context(emoji, detectInlineColor());
  const library = libraryMethods(emoji);
  const cases: ParityCase[] = [];

  const add = (name: string, ours: string, theirs: string | false): void => {
    cases.push({ name, ours, theirs: theirs === false ? "<false>" : theirs });
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
    add(`strong/${label}`, renderStrong(ctx, token, stubParseInline), libraryMethod(library, "strong").call(libraryReceiver, token));
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
    add(`em/${label}`, renderEm(ctx, token, stubParseInline), libraryMethod(library, "em").call(libraryReceiver, token));
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
    add(`codespan/${label}`, renderCodespan(ctx, token), libraryMethod(library, "codespan").call(libraryReceiver, token));
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
    add(`del/${label}`, renderDel(ctx, token, stubParseInline), libraryMethod(library, "del").call(libraryReceiver, token));
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
    add(`link/${label}`, renderLink(ctx, token, stubParseInline), libraryMethod(library, "link").call(libraryReceiver, token));
  }

  const imageCases: Array<[string, string, string | null, string]> = [
    ["no title", "https://example.com/i.png", null, "alt text"],
    ["with title", "https://example.com/i.png", "The Title", "alt text"],
    ["empty alt", "https://example.com/i.png", null, ""],
  ];
  for (const [label, href, title, text] of imageCases) {
    const token = { type: "image", raw: href, href, title, text } as unknown as Tokens.Image;
    add(`image/${label}`, renderImage(token), libraryMethod(library, "image").call(libraryReceiver, token));
  }

  add("br", renderBr(), libraryMethod(library, "br").call(libraryReceiver, { type: "br", raw: "" }));

  for (const [label, text] of [
    ["plain", "some text"],
    ["with colons", "a:b"],
    ["with shortcode", "ship :rocket: it"],
  ] as Array<[string, string]>) {
    const token = { type: "text", raw: text, text } as unknown as Tokens.Text;
    add(`text/${label}`, renderInlineText(token), libraryMethod(library, "text").call(libraryReceiver, token));
  }

  return cases;
}

/** Every case whose two sides disagree. Empty is the pass condition. */
export function inlineParityFailures(emoji: boolean): ParityCase[] {
  return inlineParityCases(emoji).filter((entry) => entry.ours !== entry.theirs);
}
