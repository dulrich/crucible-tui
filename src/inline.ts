import colors from "@colors/colors/safe";
import ansiEscapes from "ansi-escapes";
import * as nodeEmoji from "node-emoji";
import supportsColor from "supports-color";
import supportsHyperlinks from "supports-hyperlinks";
import type { Token, Tokens } from "marked";
import type { LayoutContext } from "./layout-context";

/**
 * The owned inline visitors — `strong`, `em`, `codespan`, `del`, `br`, `link`, `image`
 * and inline `text`.
 *
 * WP-2 of `plans/marked-terminal-replacement.md`. This is the first group taken off
 * `marked-terminal`, and it is a strangler-fig step: the library stays installed and
 * still owns every block renderer. **Byte-identical output is the gate** (parity class A)
 * — the library's inline methods are deterministic string operations, so if rendered text
 * moves anywhere, that is a defect and not an improvement.
 *
 * Everything here is written against `marked-terminal@7.3.0`'s `index.js` and reproduces
 * it deliberately, defects included. Where a behaviour looks wrong it is annotated as
 * such and left alone; correcting it is a later package's decision, taken against a
 * parity class that allows output to move.
 *
 * `src/table.ts` is the model this follows: own the emitter, keep `@colors/colors` as the
 * source of the escape sequences, and say in the source *why* each byte is the byte it is.
 */

/**
 * The colon sentinel, originally `marked-terminal` `index.js:15` and now this repo's.
 *
 * `codespan` replaces every `:` in a code span with this, and the block renderers undo it
 * (`undoColon`, `src/blocks.ts`, composed into `transform` and applied by `heading`,
 * `paragraph` and `src/lists.ts`'s `listitem`). Its purpose is to stop shortcode
 * substitution from turning `:smile:` inside backticks into an emoji glyph.
 *
 * **WP-6 expected to delete this round-trip with the dependency and measurement said no.**
 * The reasoning that predicted its death was that it exists "only to survive the library's
 * emoji pass". It does not: the pass is *this repo's* now (`emojify`, below) and it still
 * runs over composed block text, after inline rendering, so a code span's colons are still
 * exposed to it unless something hides them. Substituting the round-trip with identity on
 * both sides and rendering six probes measured the consequence directly — `` `:rocket:` ``
 * renders 🚀, `` `:smile:` `` in a list item renders 😄, `` `:tada:` `` in a blockquote
 * renders 🎉 — which is emoji substitution *inside verbatim content*, the one thing a code
 * span exists to prevent. See this WP's report.
 *
 * The literal spelling is kept rather than swapped for a control character like the other
 * two sentinels. It is unobservable either way — every renderer that can receive a code
 * span runs `undoColon` — and an authored `*#COLON|*` cannot reach it, because `marked`
 * tokenizes the surrounding asterisks as emphasis long before this pass. Changing it would
 * be churn against a measured no-op.
 */
export const COLON_REPLACER = "*#COLON|*";

/**
 * `marked-terminal`'s hard-break marker (`index.js:26`).
 *
 * `\r`, chosen upstream because `marked`'s lexer normalises real carriage returns away
 * before a renderer ever sees one, so it is free to mean "a break the reflow pass must
 * not close up". `src/render.ts` declares the same constant for its own list-item work.
 */
const HARD_RETURN = "\r";

/**
 * The replacement `fixHardReturn` actually applies — an upstream defect, reproduced.
 *
 * `marked-terminal` `index.js:76-78`:
 *
 * ```js
 * function fixHardReturn(text, reflow) {
 *   return reflow ? text.replace(HARD_RETURN, /\n/g) : text;
 * }
 * ```
 *
 * `HARD_RETURN` is the *string* `'\r'` (the regex form is a separate constant upstream),
 * so this is `String.prototype.replace(searchString, replaceString)`: it replaces only the
 * **first** occurrence, and it coerces the regex it was handed as a replacement into its
 * source text — the five literal characters `/`, `\`, `n`, `/`, `g`. It never inserts a
 * newline, which is plainly what it was written to do.
 *
 * Spelled as a coercion of the same literal rather than as a hand-escaped string so the
 * provenance is checkable and a transcription slip is impossible. Reachable only from `em`
 * and `codespan`; see this package's report for the measured firing count on both corpora.
 */
const HARD_RETURN_REPLACEMENT = String(/\n/g);

export function fixHardReturn(text: string): string {
  return text.replace(HARD_RETURN, HARD_RETURN_REPLACEMENT);
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

/**
 * `@colors/colors`' style table — the escape sequences, without its enablement gate.
 *
 * Two things are being separated here, and keeping them separate is the whole of trap 3
 * in this package's brief:
 *
 * - **Which bytes a style is.** `@colors/colors` decides that, per
 *   `plans/marked-terminal-replacement.md`'s decision 1, and it agrees with what the
 *   library emitted: every pair this module needs is byte-identical to `chalk`'s
 *   (`bold` `1m`/`22m`, `italic` `3m`/`23m`, `dim` `2m`/`22m`, `strikethrough` `9m`/`29m`,
 *   `underline` `4m`/`24m`, `yellow` `33m`/`39m`, `blue` `34m`/`39m`, `gray` `90m`/`39m`).
 *   Pinned by test rather than trusted.
 * - **Whether to emit them at all.** That is `LayoutContext.color`, and it must *not* be
 *   `@colors`' own answer — see `detectInlineColor()`.
 *
 * Calling `colors.bold(x)` would fuse the two: those functions consult the global
 * `colors.enabled`, so they would silently answer the enablement question with the wrong
 * rule, and `colors.enable()`/`disable()` is a global mutation `src/table.ts:489-506`
 * explicitly depends on not happening. Reading the table instead takes the bytes and
 * leaves the gate.
 *
 * The cast is needed because `@colors/colors`' bundled `safe.d.ts` is a 2018 community
 * typing that predates this export and describes only the style *functions*; the package's
 * own main module assigns `colors.styles` unconditionally, on every entry point. The
 * test that pins the eight pairs above is what makes the cast safe.
 */
const STYLE_CODES = (colors as unknown as { styles: Record<string, { open: string; close: string }> }).styles;

export interface Styler {
  readonly open: string;
  readonly close: string;
  readonly openAll: string;
  readonly closeAll: string;
  readonly parent?: Styler;
}

/**
 * One link in a style chain, built exactly as `chalk`'s `createStyler` builds it
 * (`chalk@5.6.2`, `chalk/source/index.js`): `openAll` accumulates outermost-first, `closeAll`
 * innermost-first. `chalk.dim.gray.strikethrough` is therefore
 * `\x1b[2m\x1b[90m\x1b[9m` … `\x1b[29m\x1b[39m\x1b[22m`, and the nesting order is not
 * cosmetic — it is the byte order class A is measured against.
 */
export function createStyler(name: string, parent?: Styler): Styler {
  const code = STYLE_CODES[name];
  if (!code) throw new Error(`mdview: no style named ${name} in the colour table`);
  return {
    open: code.open,
    close: code.close,
    openAll: parent === undefined ? code.open : parent.openAll + code.open,
    closeAll: parent === undefined ? code.close : code.close + parent.closeAll,
    parent,
  };
}

// `chalk`'s own `stringReplaceAll` (`chalk/source/utilities.js`), transcribed. It differs from
// `String.prototype.replaceAll` in that it re-emits the *substring as well as* the
// replacer — the point is to re-open a style after a nested style closed it, not to
// remove the close.
function stringReplaceAll(string: string, substring: string, replacer: string): string {
  let index = string.indexOf(substring);
  if (index === -1) return string;

  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + replacer;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);

  returnValue += string.slice(endIndex);
  return returnValue;
}

// `chalk`'s `stringEncaseCRLFWithFirstIndex`, transcribed. Closes the styling before every
// line break and reopens it after, which is a workaround for a styling bleed on one
// terminal (chalk PR #92) and, here, simply part of the bytes being reproduced.
function stringEncaseCRLFWithFirstIndex(string: string, prefix: string, postfix: string, first: number): string {
  let index = first;
  let endIndex = 0;
  let returnValue = "";
  do {
    const gotCR = string[index - 1] === "\r";
    returnValue += string.slice(endIndex, gotCR ? index - 1 : index) + prefix + (gotCR ? "\r\n" : "\n") + postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);

  returnValue += string.slice(endIndex);
  return returnValue;
}

/**
 * Apply a style chain, reproducing `chalk`'s `applyStyle` exactly.
 *
 * **Wrapping in `open` … `close` is not sufficient and the difference is reachable from
 * ordinary markdown.** Two behaviours beyond the wrap:
 *
 * 1. If the input already contains an escape, every occurrence of *this chain's* close
 *    code gets the matching open appended after it, innermost link outward — the close is
 *    re-emitted and *then* the style resumes, which is `stringReplaceAll`'s whole point and
 *    is easy to get backwards. This fires on the very first `link` in a document: `link` is
 *    a blue wrap around an already-blue-and-underlined href, both closing with `39m`, so
 *    the href's close is followed by a blue re-open. It fires on `del` too, whenever a
 *    strikethrough span contains a code span — grey's close is `39m` as well.
 * 2. If the input contains a newline, the styling is closed before it and reopened after.
 *
 * Both are in the library's output today, so both are class-A obligations, not polish.
 */
export function applyStyle(ctx: LayoutContext, chain: Styler, input: string): string {
  // `chalk`'s own guard: level 0, or an empty string, and the input comes back untouched.
  if (!ctx.color || !input) return input;

  let string = input;
  const { openAll, closeAll } = chain;

  if (string.includes("\u001b")) {
    let styler: Styler | undefined = chain;
    while (styler !== undefined) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }

  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) {
    string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  }

  return openAll + string + closeAll;
}

// The six chains `marked-terminal`'s `defaultOptions` (`index.js:30-54`) uses for the
// inline methods this module owns. `src/render.ts` overrides none of them, so the defaults
// are what shipped.
const STRONG = createStyler("bold"); // chalk.bold
const EM = createStyler("italic"); // chalk.italic
const CODESPAN = createStyler("yellow"); // chalk.yellow
const DEL = createStyler("strikethrough", createStyler("gray", createStyler("dim"))); // chalk.dim.gray.strikethrough
const LINK = createStyler("blue"); // chalk.blue
const HREF = createStyler("underline", createStyler("blue")); // chalk.blue.underline

/**
 * Whether the renderer's inline styling emits SGR codes — **`supports-color`'s answer,
 * measured equal to the library's, not a hand-rolled approximation.**
 *
 * The rule that has always governed this tool's rendered output is `chalk`'s, and `chalk`'s
 * rule is not "is stdout a TTY". It is ~150 lines of stream, flag and environment
 * inspection, and a tool that reproduced only the TTY half would answer differently the
 * first time it met `--color`, `FORCE_COLOR=false`, `TERM=dumb` or a CI runner — silently,
 * with every local gate still green.
 *
 * Until WP-6 this asked `marked-terminal`: a throwaway extension was built, its `strong`
 * (which is `chalk.bold` and nothing else) was handed a probe string, and the answer was
 * whether anything came back around it. That made the decision `chalk@5.6.2`'s, made by
 * `chalk`, *by construction* — and it was the one deliberate library coupling this module
 * carried, recorded here as a debt owed an owned answer once the library went.
 *
 * **The owned answer is `supports-color`, promoted from transitive to direct**, and it is a
 * promotion in exactly the sense `@colors/colors` and `cli-highlight` already are: the
 * package is already in the runtime closure — `supports-hyperlinks@3.2.0`, a direct
 * dependency two lines above, requires `supports-color@^7.0.0` — so declaring it adds
 * **zero** packages and zero install size, and the alternative of promoting `chalk` itself
 * is what `plans/marked-terminal-replacement.md`'s decision 1 already rejected. It is also
 * the same module `chalk` is a wrapper over: `chalk@5.6.2` vendors a copy of this exact
 * library and its `level` is that copy's answer, so "ask `supports-color`" and "ask
 * `chalk`" are the same question put to two builds of one implementation.
 *
 * **Two builds is not one build, so the equality was measured rather than assumed.** The
 * two spellings were run against a 36-cell environment matrix — bare non-TTY, a real pty,
 * `FORCE_COLOR` at `0/1/2/3/true/false/empty`, `NO_COLOR`, `TERM` at
 * `dumb/vt100/linux/screen/xterm-256color`, `COLORTERM`, `CI` alone and with
 * `GITHUB_ACTIONS`/`TRAVIS`, `TEAMCITY_VERSION`, `TERM_PROGRAM`, and the `--color`,
 * `--no-color`, `--color=256/always/never` argv flags — and **agreed on all 36**. See this
 * WP's report for the matrix. One cell is worth naming because this comment used to assert
 * the opposite: under `CI=1 GITHUB_ACTIONS=1` with a non-TTY stdout **both** answer *false*,
 * because the non-TTY early return runs before the CI table is ever consulted. The old
 * "under GitHub Actions chalk still colours" claim was wrong about both libraries; it is
 * removed rather than carried forward, and the conclusion it was offered in support of —
 * do not hand-roll a TTY check — is unaffected and still the reason this is a dependency.
 *
 * Resolved at module load, like `chalk`'s level was, which is why
 * `tests/inline.test.ts`'s forced-colour case runs in a subprocess. Cheap enough to call
 * once per render (a property read), and deliberately not memoised at module scope: this
 * module holds no process state.
 */
export function detectInlineColor(): boolean {
  return supportsColor.stdout !== false;
}

/**
 * `insertEmojis`, `marked-terminal` `index.js:604-611`, reproduced including two
 * peculiarities that are load-bearing for parity:
 *
 * - the **whole match** is handed to `emoji.get`, colons and all, not the capture group;
 * - a substituted glyph is followed by a space that was never in the source.
 *
 * That stray space is a measured defect — it is trailing whitespace at end of line, and
 * width is the one thing this tool exists to control — and `src/render.ts` already strips
 * it downstream, fence-aware, in `stripEmojiTrailingSpace`. **It must not also be stripped
 * here**, or it gets stripped twice and the result is not what the library produced.
 */
function insertEmojis(text: string): string {
  return text.replace(/:([A-Za-z0-9_\-+]+?):/g, (match) => {
    const glyph = nodeEmoji.get(match);
    if (!glyph) return match;
    return `${glyph} `;
  });
}

export function emojify(ctx: LayoutContext, text: string): string {
  // `this.emoji` is `insertEmojis` when the option is on and `identity` when it is off
  // (`index.js:61`). The option is `emojiOverride ?? tier === unicode`, computed once per
  // render and carried on the context.
  return ctx.emoji ? insertEmojis(text) : text;
}

// ---------------------------------------------------------------------------
// The visitors
// ---------------------------------------------------------------------------

/** Dispatch inline children, i.e. `this.parser.parseInline(tokens)` at the call site. */
export type ParseInline = (tokens: Token[]) => string;

/**
 * Inline `text` — `index.js:84-89`.
 *
 * The library reads `token.text` and returns it through `this.o.text`, which is `identity`
 * (`index.js:47`, and `src/render.ts` passes no `text` option). So: the token's text,
 * unchanged. **No entity unescaping and no emoji substitution happen here** — the
 * `transform` that does both is applied by the block renderers, which are still the
 * library's.
 *
 * `src/render.ts` wraps this seam for an unrelated and much larger reason (it is where a
 * *tight* list item's inline markup gets parsed at all); that wrapper is untouched by this
 * package and this function is only what its inner call used to return.
 */
export function renderInlineText(token: Tokens.Text | Tokens.Escape | Tokens.Tag): string {
  return token.text;
}

/** `strong` — `index.js:268-273`. `chalk.bold` over the parsed children. */
export function renderStrong(ctx: LayoutContext, token: Tokens.Strong, parseInline: ParseInline): string {
  return applyStyle(ctx, STRONG, parseInline(token.tokens));
}

/**
 * `em` — `index.js:275-281`. Parsed children, then `fixHardReturn`, then `chalk.italic`.
 * The `fixHardReturn` call is the defect described on `HARD_RETURN_REPLACEMENT`; it is
 * reproduced, not fixed, because this package's parity class does not permit output to move.
 */
export function renderEm(ctx: LayoutContext, token: Tokens.Em, parseInline: ParseInline): string {
  return applyStyle(ctx, EM, fixHardReturn(parseInline(token.tokens)));
}

/**
 * `codespan` — `index.js:283-289`.
 *
 * Note what it does **not** do: it reads `token.text` rather than parsing children, so
 * markdown inside backticks stays literal. Then `fixHardReturn`, then every `:` becomes
 * `COLON_REPLACER` *before* the style is applied — the sentinel is inside the yellow, which
 * is where the library put it and therefore where the block renderers' `undoColon` expects
 * to find it. WP-6 measured what happens if this stops emitting it, and the answer is emoji
 * substitution inside a code span; see `COLON_REPLACER`.
 */
export function renderCodespan(ctx: LayoutContext, token: Tokens.Codespan): string {
  const text = fixHardReturn(token.text);
  return applyStyle(ctx, CODESPAN, text.replace(/:/g, COLON_REPLACER));
}

/**
 * `br` — `index.js:291-293`: `this.o.reflowText ? HARD_RETURN : '\n'`.
 *
 * Every `markedTerminal` construction `src/render.ts` ever made passed `reflowText: true`
 * — the main one and both per-budget caches — so the branch was constant and the marker is
 * what ships. There are no constructions left (WP-6) and this stays a constant rather than
 * becoming a context field, because `reflowText` was a property of the library's own reflow
 * pass and WP-3 replaced that outright: the marker survives, the option it was gated on
 * does not.
 */
export function renderBr(): string {
  return HARD_RETURN;
}

/** `del` — `index.js:295-300`. `chalk.dim.gray.strikethrough`, and no `fixHardReturn`. */
export function renderDel(ctx: LayoutContext, token: Tokens.Del, parseInline: ParseInline): string {
  return applyStyle(ctx, DEL, parseInline(token.tokens));
}

/**
 * `link` — `index.js:302-345`, the only substantial method in the group.
 *
 * Reproduced in full apart from one branch that is **provably dead in this configuration**:
 * the `this.options.sanitize` protocol filter (`:310-321`). `sanitize` was removed from
 * `marked`'s options years before `marked@14.1.4`, which is the pinned version and the
 * contract these visitors are written against — the identifier does not occur anywhere in
 * `marked/lib/marked.cjs`, so `this.options.sanitize` is `undefined` on every call and the
 * branch cannot be entered. Reproducing dead code would be reproducing the *appearance* of
 * a protection that is not running; it is omitted, and named here so the omission is a
 * recorded decision rather than an oversight. If a future package re-enables anything like
 * it, it belongs in this tool's own preprocessing, not smuggled in as library fidelity.
 *
 * The rest, exactly:
 *
 * - `hasText` is `text && text !== href` — a bare autolink renders as the href alone.
 * - Emoji substitution runs on the link *text* only, never on the href.
 * - With OSC-8 support, the styled label is wrapped in `ansiEscapes.link` and the URL has
 *   `+` percent-encoded (upstream comment: its own `textLength` breaks on `+` in URLs).
 * - Without it, the shape is `text (href)`.
 * - Either way the whole thing is wrapped in `chalk.blue`, over an href that is already
 *   `chalk.blue.underline` — which is what makes the close-code re-opening in `applyStyle`
 *   fire on essentially every link in the corpus.
 *
 * `supportsHyperlinks.stdout` is the same module instance the library resolved, evaluated
 * at its own module load, so the capability answer cannot differ between the two halves of
 * a half-migrated renderer.
 */
export function renderLink(ctx: LayoutContext, token: Tokens.Link, parseInline: ParseInline): string {
  const href = token.href;
  const text = parseInline(token.tokens);
  const hasText = Boolean(text) && text !== href;

  let out = "";
  if (supportsHyperlinks.stdout) {
    const label = text ? applyStyle(ctx, HREF, emojify(ctx, text)) : applyStyle(ctx, HREF, href);
    out = ansiEscapes.link(label, href.replace(/\+/g, "%20"));
  } else {
    if (hasText) out += `${emojify(ctx, text)} (`;
    out += applyStyle(ctx, HREF, href);
    if (hasText) out += ")";
  }
  return applyStyle(ctx, LINK, out);
}

/**
 * `image` — `index.js:347-359`.
 *
 * `src/render.ts` configures no `image` option, so the library's own fallback is what runs:
 * the markdown source shape put back together, unstyled, with a **trailing newline** and an
 * **en dash** before the title. Both are easy to normalise away by accident and both are
 * part of the bytes.
 *
 * Obsidian's `![[embed]]` never reaches here — `preprocessBody` rewrites it long before the
 * lexer sees it — so this is the plain-markdown image path only.
 */
export function renderImage(token: Tokens.Image): string {
  let out = `![${token.text}`;
  if (token.title) out += ` – ${token.title}`;
  return `${out}](${token.href})\n`;
}
