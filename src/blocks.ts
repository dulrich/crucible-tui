import { highlightToAnsi } from "./highlight";
import type { Tokens } from "marked";
import { COLON_REPLACER, emojify, fixHardReturn, type ParseInline } from "./inline";
import type { LayoutContext } from "./layout-context";
import { stripAnsi } from "./list-lines";
import { applyStyle, createStyler } from "./style";
import { wrapAnsi } from "./wrap";

/**
 * The owned block leaves — `code`, `hr`, `html`, `heading`, `paragraph` and `blockquote`.
 *
 * WP-3 of `plans/marked-terminal-replacement.md`, and the second strangler-fig step after
 * `src/inline.ts`. The library stays installed and still owns `list`, `listitem` and
 * `checkbox`; everything here used to be `marked-terminal`'s and is now this repo's.
 *
 * **Two parity classes live in this one file, deliberately.**
 *
 * - `code`, `hr` and `html` never called `reflowText` and never read `this.o.width`, so
 *   owning them is a transcription and byte-identical output is the gate (class A). They
 *   are written against `marked-terminal@7.3.0`'s `index.js` line for line, upstream
 *   defects included, exactly as `src/inline.ts` is.
 * - `heading`, `paragraph` and `blockquote` did reflow, and the library's reflow
 *   (`reflowText`, `index.js:405-499`) measures every wrapping decision with raw
 *   `String.prototype.length` — UTF-16 code units, not display columns. Those three now
 *   reflow through `src/wrap.ts`'s `wrapAnsi` against the `LayoutContext`'s `Measure`,
 *   which is the whole point of the plan and is allowed to move output (class B).
 *
 * The width is a **parameter**, not construction state. `marked-terminal` reads
 * `this.o.width` from a snapshot taken in its constructor (`index.js:58`), which is why
 * `src/render.ts` used to build three library instances per render and cache two of them
 * by budget. A visitor handed the `LayoutContext` reads `ctx.width` and subtracts
 * `ctx.prefix.width()` — the columns enclosing blocks still owe — and both caches, plus
 * every `wrapOverBudgetLines` safety net they needed, are gone.
 *
 * `src/table.ts` and `src/inline.ts` are the model this follows: own the emitter, take the
 * escape bytes from one table rather than writing them out inline, and record in the source
 * *why* each byte is the byte it is. That table was `@colors/colors`' until WP-2 of
 * `plans/colour-policy.md` and is `src/style.ts`'s committed one now; the syntax colorizer
 * `code` reaches is `src/highlight.ts`, this repo's, in place of `cli-highlight`.
 */

// ---------------------------------------------------------------------------
// The library's own helpers, transcribed
// ---------------------------------------------------------------------------

/**
 * `section()` — `index.js:586-588`: `text + '\n\n'`.
 *
 * Every block renderer but `html` ends with it, and the two trailing newlines are what
 * separate blocks in the final document. `wrapCode` in `src/render.ts` deliberately keeps
 * this padding *outside* its sentinel pair, so a code range covers the block's own content
 * lines and nothing borrowed from the block after it.
 */
function section(text: string): string {
  return `${text}\n\n`;
}

/**
 * `this.tab` — `index.js:59`, `sanitizeTab(this.o.tab, 4)` with no `tab` option passed by
 * this repo, so `new Array(5).join(' ')`: **four spaces, as a string**.
 */
const TAB = "    ";

/**
 * `indentify()` — `index.js:505-508`.
 *
 * **It indents every line, including empty ones**, so a blank line inside a fenced block
 * carries four trailing spaces. The sibling `indentLines` (`:501-503`) uses a regex that
 * requires at least one character and therefore does not. `code` and `blockquote` both use
 * *this* one; `list` uses the other. Reaching for the wrong one, or "tidying" the trailing
 * whitespace away, changes bytes inside a `codeRange` — parity class C, forbidden at every
 * package.
 */
function indentify(indent: string, text: string): string {
  if (!text) return text;
  return indent + text.split("\n").join(`\n${indent}`);
}

/**
 * `unescapeEntities()` — `index.js:642-649`, applied in this order.
 *
 * `unescape` defaults to `true` (`index.js:48`) and this repo never overrides it, so every
 * heading and paragraph has been decoding these five entities all along. Nothing in
 * `src/render.ts` ever mentioned it, which is exactly why it is the easiest half of
 * `this.transform` to drop on the floor when the renderer changes hands.
 */
function unescapeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "\u0027");
}

// ---------------------------------------------------------------------------
// The style chains
// ---------------------------------------------------------------------------

// `marked-terminal`'s `defaultOptions` (`index.js:30-55`) for the six block methods this
// module owns. `src/render.ts` overrides none of them, so the defaults are what shipped.
// Built through `src/style.ts`'s `createStyler`/`applyStyle` — the transcription of
// `chalk`'s own `applyStyle`, over the committed style table, gated on `ctx.sgr` — which
// since WP-2 of `plans/colour-modes.md` is also where the hue/format filter is applied, by
// style *name*. Nothing on this side of the call changed for it: `RESET` is control-class
// and frames a paragraph at every level but `none` (Decision 8), the hue chains below drop
// their hue links under `formats` and keep their format ones.
// Composing naively (`green(bold(x))`) diverges on real content: chalk
// re-opens a style after a nested style closed it, and encases line breaks. Both fire here
// — `heading` styles an already-reflowed multi-line block, and a paragraph carrying an
// image gets a newline from `renderImage`'s trailing `\n`.
const CODE = createStyler("yellow"); // chalk.yellow
const BLOCKQUOTE = createStyler("italic", createStyler("gray")); // chalk.gray.italic
const HTML = createStyler("gray"); // chalk.gray
const HEADING = createStyler("bold", createStyler("green")); // chalk.green.bold
const FIRST_HEADING = createStyler("bold", createStyler("underline", createStyler("magenta"))); // chalk.magenta.underline.bold
// `chalk.reset`, whose `open` and `close` are both `\x1b[0m`. `@colors/colors` carried an
// entry under that name with the same two bytes (checked when this file was written, when
// that package was the byte source); `src/style.ts`'s table commits them.
const RESET = createStyler("reset"); // chalk.reset, used by `hr` and `paragraph`

// ---------------------------------------------------------------------------
// `code` — index.js:91-100. Parity class A.
// ---------------------------------------------------------------------------

/**
 * `highlight()` — `index.js:590-602`, and **three branches that all matter**.
 *
 * 1. `:591` short-circuits to the raw, unstyled code whenever `chalk.level === 0`. That is
 *    the decision `LayoutContext.sgr` carries — since WP-1 of `plans/colour-policy.md`,
 *    `resolveColourPolicy`'s (`src/colour.ts`), threaded in rather than re-derived here.
 *    **It is the only gate on this path again**, and WP-2 is what made that true: until it
 *    landed, `cli-highlight` consulted its own bundled `chalk`'s module-load level, so
 *    under `--color=always` on a pipe this branch was *not* taken and the highlighter still
 *    emitted nothing. `src/highlight.ts` reads the policy it is handed and nothing else, so
 *    the forced-colour and `MDVIEW_COLOR=always` renders are the same bytes.
 * 2. `:598`, the success path, returns **the colorizer's own colours**. `opts.code`
 *    (`chalk.yellow`) is *not* applied here. An owned `code` that wraps its output in
 *    yellow would change content inside a `codeRange` — parity class C.
 * 3. `:600`, the `catch`, is where `chalk.yellow` is applied, over the **`fixHardReturn`-ed**
 *    code (`:595` reassigns `code` before the `try`).
 *
 * `fixHardReturn` is the upstream defect `src/inline.ts` documents on
 * `HARD_RETURN_REPLACEMENT`: it replaces the *first* `\r` with the five literal characters
 * `/\n/g`, never with a newline. **It fires inside fenced code**, which is a `codeRange`,
 * so it is reproduced rather than fixed — measured on the private corpus during WP-2 as
 * firing once across 4,728 files. WP-6 owns the decision to stop reproducing upstream
 * defects.
 *
 * `highlightOptions` is `{}`: `markedTerminal(options)` is called with one argument
 * throughout this repo, so the constructor's `highlightOptions || {}` (`:63`) takes the
 * fallback, and `Object.assign({}, { language }, {})` is just `{ language }` — including
 * when `language` is `undefined`, which is what makes the colorizer auto-detect for an
 * unlabelled fence (`highlightAuto`; see `src/highlight.ts` for why the two call branches
 * are not interchangeable).
 *
 * ## The gate is `sgr !== "full"`, and that is a named producer exception
 *
 * **Decision 3 of `plans/colour-modes.md` (cycle-3 f2), ratified at approval.** This is the
 * one reader in the renderer whose threshold is not "does this render emit SGR at all" —
 * fenced-code syntax highlighting runs under `full` and under nothing else, so `formats`
 * takes the same colourless branch `none` does. Two reasons, both measured rather than
 * asserted:
 *
 * 1. **`fixHardReturn` is a visible-content transform on this path.** It rewrites the first
 *    `\r` as the five literal characters `/\n/g` (`src/inline.ts`'s
 *    `HARD_RETURN_REPLACEMENT` documents the upstream defect), *inside* a `codeRange`.
 *    Reaching it under `formats` would break `visible(formats) === visible(off)`, which is
 *    the property WP-4's G2 gate is about. Keeping the gate at `full` makes that equality
 *    hold **by construction** for every fenced block, not by inspection —
 *    `tests/blocks.test.ts`'s hard-return witness is what says so out loud.
 * 2. **The theme is not hue-only**, so filtering it by property would be false advertising:
 *    `src/highlight.ts` carries `dim` (`type`), `italic` (`emphasis`), `bold` (`strong`)
 *    and `underline` (`link`), all format-class, all of which a property filter would keep.
 *    A fence would then be *partly* highlighted under `formats` — decoration with its
 *    colours removed and its emphases retained, which is not a state anyone asked for.
 *
 * What `formats` loses, enumerated (Decision 3 requires the enumeration): the theme's
 * bold/italic/underline/dim spans inside fenced code, and nothing else. The property-pure
 * alternative — highlighting under `formats` through a `fixHardReturn`-free path — is
 * recorded in the plan as the fallback if the exception is ever withdrawn.
 *
 * **Provenance decides here and only here.** Everywhere else the rule is Decision 8's:
 * decide by style property, never by producer. This function is the named exception, and
 * a future package adding a second one owes the same two-part justification.
 */
function highlightCode(ctx: LayoutContext, code: string, language: string | undefined): string {
  if (ctx.sgr !== "full") return code;
  const fixed = fixHardReturn(code);
  try {
    return highlightToAnsi(ctx, fixed, language);
  } catch {
    return applyStyle(ctx, CODE, fixed);
  }
}

/**
 * `code` — `index.js:91-100`. Parity class A.
 *
 * The declared language is normalised through `ctx.resolveFenceLanguage` before it reaches
 * the colorizer, because highlight.js **logs and then throws** on a language it does not
 * know: the `console.error` happens first, so catching the throw does not suppress the
 * message, and it would reach stderr on every unrecognised fence (see `src/lang.ts`). The
 * `catch` below is therefore reachable — it is what turns that throw into flat yellow — and
 * this comment used to say the opposite, from the days when `cli-highlight` sat in front.
 *
 * `token.escaped` is read by the library (`:94`) and never used; there is nothing to
 * reproduce. `src/render.ts` brackets the result in `SENTINEL` (`wrapCode`) so `--check`
 * can exempt it, and that stays its job until WP-6 carries code/prose metadata on rendered
 * lines instead.
 */
export function renderCode(ctx: LayoutContext, token: Tokens.Code): string {
  const language = ctx.resolveFenceLanguage(token.lang);
  return section(indentify(TAB, highlightCode(ctx, token.text, language)));
}

// ---------------------------------------------------------------------------
// `hr` — index.js:135-137. Parity class A.
// ---------------------------------------------------------------------------

/**
 * `hr` — `index.js:135-137`: `section(this.o.hr(hr('-', this.o.reflowText && this.o.width)))`.
 *
 * `rule` is the already-computed rule text and is deliberately a parameter rather than
 * something this module derives: `renderRule` in `src/render.ts` is shared with the
 * frontmatter divider and must stay **the only place that computes a rule**, so the two can
 * never drift apart about the library's own off-by-one (`index.js:612-615`,
 * `new Array(length).join(ch)`, i.e. `length - 1` characters) or about a rule glyph that is
 * East Asian Ambiguous and therefore two columns wide.
 *
 * **Byte-identical to the pre-WP-3 override by construction, not by measurement.** That
 * override called the library, then string-replaced the exact `targetWidth - 1` dash run
 * with `renderRule(...)`. The library's output is `chalk.reset(dashes) + '\n\n'` and the
 * dash run occurs exactly once in it, so replacing it is the same string as styling the
 * rule directly — including in the ASCII tier, where `renderRule` *is* `'-'.repeat(w - 1)`
 * and the override short-circuited to the library result untouched.
 */
export function renderHr(ctx: LayoutContext, rule: string): string {
  return section(applyStyle(ctx, RESET, rule));
}

// ---------------------------------------------------------------------------
// `html` — index.js:109-114. Parity class A.
// ---------------------------------------------------------------------------

/**
 * `html` — `index.js:109-114`: `this.o.html(html)`, i.e. `chalk.gray(token.text)`.
 *
 * **No `section()`**, no `this.transform`, no indent and no reflow — it is the only one of
 * the six that adds nothing at all. A block-HTML token routinely carries newlines, so the
 * line-break encasing in `applyStyle` is live on this path rather than theoretical.
 *
 * The width problem that creates is real, and `wrapHtmlLines` below is this repo's answer to
 * it — never the library's, which had none.
 */
export function renderHtml(ctx: LayoutContext, token: Tokens.HTML | Tokens.Tag, budget: number): string {
  return wrapHtmlLines(ctx, applyStyle(ctx, HTML, token.text), budget);
}

/**
 * A rendered line's own leading prefix: indentation, optionally followed by a marker the
 * enclosing list renderer emitted for an item's first line. Transcribed unchanged from the
 * `LIST_LINE_PREFIX` the deleted `wrapOverBudgetLines` used, so an over-budget HTML line
 * inside a list item hangs its continuation under the item's text column exactly as it did
 * before, rather than under the marker.
 */
const HTML_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/;

/**
 * Wrap an HTML block's own lines to `budget`, preserving each line's leading prefix.
 *
 * **This is mdview's, not `marked-terminal`'s.** A line *starting* with a block-level tag
 * makes `marked` open an `html` token that swallows the rest of the paragraph, and the
 * library returned that entirely unreflowed — `html` is the one block renderer that never
 * read `reflowText` at all. This does not attempt to re-parse the swallowed markdown; the
 * width guarantee is what matters, not recovering inline formatting.
 *
 * Transcribed from the `wrapOverBudgetLines` this package deleted, minus two things:
 *
 * - **The `SENTINEL` walk.** That function was shared with `paragraph`, `heading` and
 *   `blockquote`, whose results can contain a fenced block bracketed by `src/render.ts`'s
 *   code sentinel; an HTML token's cannot. `marked` never opens a `code` token inside an
 *   `html` one, and `preprocessBody` strips the sentinel byte out of the source before the
 *   lexer runs, so there is nothing for the walk to find.
 * - **The full `targetWidth`.** It is the *budget* now — `ctx.width` minus the columns
 *   enclosing blocks still owe. At the top level, where all but a handful of the corpus's
 *   HTML blocks live, the two are the same number and the output is byte-identical; inside a
 *   blockquote an over-budget HTML line used to be caught (four columns late) by the width
 *   pass over the *blockquote's* result, which no longer exists because nothing else needs
 *   it.
 *
 * Only over-budget lines are touched, so this is idempotent and a no-op on output that
 * already fits — and a line that is all indent, or has none, takes the plain path, because
 * there is either no text to hang a continuation under or no prefix worth preserving.
 */
function wrapHtmlLines(ctx: LayoutContext, rendered: string, budget: number): string {
  return rendered
    .split("\n")
    .map((line) => {
      if (ctx.measure(line) <= budget) return line;
      const match = HTML_LINE_PREFIX.exec(line);
      const indent = match?.[1] ?? "";
      const prefix = `${indent}${match?.[2] ?? ""}`;
      const rest = line.slice(prefix.length);
      if (indent === "" || rest === "") return wrapAnsi(line, budget, ctx.measure).join("\n");
      const prefixWidth = ctx.measure(prefix);
      const continuation = " ".repeat(prefixWidth);
      return wrapAnsi(rest, Math.max(1, budget - prefixWidth), ctx.measure)
        .map((wrapped, index) => (index === 0 ? `${prefix}${wrapped}` : `${continuation}${wrapped}`))
        .join("\n");
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// The reflow engine — what replaces `reflowText` (index.js:405-499)
// ---------------------------------------------------------------------------

/**
 * The section split `reflowText` performs at `:408-409` — on `marked-terminal`'s
 * `HARD_RETURN` (`index.js:26`, the `\r` its `br` emits in place of a newline when
 * `reflowText` is on, reproduced unconditionally by `src/inline.ts`'s owned `br`) — and the
 * one behaviour of the old engine that is **not** width measurement and that this reflow
 * deliberately keeps.
 *
 * A hard break — that marker, or, under GFM, a literal `<br />` — ends a section; the
 * sections are wrapped independently and rejoined with `\n` (`:498`). `wrapAnsi` on its own
 * would treat `\r` as ordinary whitespace and *collapse* an authored hard break into a
 * space, which is a regression rather than a class-B improvement, so the split happens
 * before the wrap.
 *
 * `marked`'s `gfm` option defaults to `true` and this repo never turns it off, so the GFM
 * form is the one that runs. `String.prototype.split` splits on every match regardless of
 * the `g` flag, exactly as the library's non-global `RegExp` did.
 *
 * The behaviour this *does not* keep is the other half of the same design: the library
 * joined its own wraps and an author's hard break back into the same bare `\n`, which is
 * precisely why `src/render.ts` could not un-wrap and re-wrap a rendered paragraph and had
 * to construct a second library instance at the right width instead. Wrapping at the right
 * width in the first place is what makes both those instances unnecessary.
 */
const HARD_BREAK_SECTION = /\r|<br \/>/;

/**
 * Wrap one section, dropping a trailing line with no visible content.
 *
 * `reflowText` pushed intermediate lines unconditionally (`:450`, `:459`, `:474`) but
 * guarded the *last* one of each section with `if (textLength(currentLine))` (`:495`) —
 * ANSI-stripped length, one of only two places the library measured anything but with raw
 * `.length`. So a section that reduces to nothing, or to escape sequences alone,
 * contributed no line at all. `wrapAnsi` always returns at least one line, and only its
 * last can be empty, so reproducing that guard is exactly this pop.
 */
function reflowSection(ctx: LayoutContext, text: string, budget: number): string[] {
  const lines = wrapAnsi(text, budget, ctx.measure);
  const last = lines[lines.length - 1];
  if (last !== undefined && stripAnsi(last) === "") lines.pop();
  return lines;
}

/**
 * The owned reflow: `src/wrap.ts`'s `wrapAnsi`, measuring through `LayoutContext.measure`.
 *
 * **This is the change the whole plan is for.** `reflowText` decided every wrap with raw
 * `String.prototype.length` — `:446` the overflow test, `:447` the does-it-fit test, `:452`
 * / `:471` / `:486` the column accounting, `:456` / `:465` / `:475` the hard-split, all of
 * them in UTF-16 code units. A CJK ideograph counts 1 there and 2 on the terminal, and so
 * does `↔`, at either ambiguous-width setting; the em dash `—` counts 1 there and 2 only
 * under the East Asian Ambiguous *wide* resolution, which is why `Measure` is threaded as a
 * value rather than fixed. Every `wrapOverBudgetLines` call in `src/render.ts` was a net
 * under that undercount, and every one of them is now gone.
 *
 * Two further divergences from the old engine are real, deliberate and reported as class B
 * rather than papered over:
 *
 * - **Whitespace runs.** `:438` split each escape-free fragment on `/[ \t\n]+/` and `:481`
 *   rejoined with a single space, so a newline *inside* a section did not survive. `wrapAnsi`
 *   tokenizes the same way (`WHITESPACE_RUN`), so this matches — but only because the
 *   sections were split off first, above.
 * - **Over-width words.** `:456-477` filled the current line's remainder with the head of an
 *   over-long word and then emitted `width`-sized chunks; `wrapAnsi`'s `splitStyledWord`
 *   flushes and starts the long word on a fresh line, and splits it grapheme-correctly so a
 *   CJK character or an emoji is never cut in half. That differs on pure ASCII, at zero
 *   colour, with no wide characters anywhere — long URLs and paths in a narrow column — and
 *   the divergence is kept on the merits: the library's version can and does cut a
 *   multi-code-unit character down the middle, which is the defect class this tool exists to
 *   remove.
 *
 * Not reproduced at all, because it is an outright upstream defect with no defensible
 * reading: `:443`'s `if (lastWasEscapeChar) addSpace = false;` dropped the space before the
 * first word after any escape sequence. `wrapAnsi` treats an escape as attached to its word
 * and keeps the space.
 */
function reflow(ctx: LayoutContext, text: string, budget: number): string {
  const lines: string[] = [];
  for (const part of text.split(HARD_BREAK_SECTION)) {
    for (const line of reflowSection(ctx, part, budget)) lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// `this.transform` — index.js:65
// ---------------------------------------------------------------------------

/**
 * `undoColon` — `index.js:617-619`, `str.replace(COLON_REPLACER_REGEXP, ':')` where the
 * regexp is a global, fully-escaped match on the literal `*#COLON|*`. A `split`/`join` on
 * that literal is the same operation with no escaping to get wrong.
 *
 * `src/inline.ts`'s `codespan` still *emits* the sentinel, and WP-6 measured that it must
 * keep doing so. If `heading` and `paragraph` stopped undoing it, every code span in a
 * paragraph would render `*#COLON|*` literally wherever the author wrote a colon; if
 * `codespan` stopped emitting it, `emojify` — which runs first in this composition and is
 * this repo's own pass now, not the library's — would substitute a glyph for every
 * shortcode inside backticks. Both halves are load-bearing and neither ends with the
 * dependency. See `COLON_REPLACER`'s own comment for the six probes that measured it.
 */
function undoColon(text: string): string {
  return text.split(COLON_REPLACER).join(":");
}

/**
 * `this.transform` — `index.js:65`: `compose(undoColon, this.unescape, this.emoji)`.
 *
 * **`compose` runs right-to-left** (`index.js:655-664`: `for (var i = funcs.length; i-- > 0;)`),
 * so the order is `insertEmojis` → `unescapeEntities` → `undoColon`. Emoji substitution
 * runs *first*, which is why `undoColon` sees text that already carries glyphs, and colon
 * restoration happens *last*, which is why the colon sentinel survives emoji substitution at
 * all — that is the whole reason `codespan` emits it.
 *
 * **Only `heading`, `paragraph` and `listitem` run it.** `code`, `blockquote`, `html` and
 * `hr` do not, and adding it to any of them would decode entities and substitute emoji in
 * places the library never did. It is exported for `src/lists.ts`, which owns `listitem`
 * since WP-4 and runs the same composition at `index.js:186`; one implementation, because
 * the two have to agree byte-for-byte about entity decoding and about emoji order.
 */
export function transform(ctx: LayoutContext, text: string): string {
  return undoColon(unescapeEntities(emojify(ctx, text)));
}

// ---------------------------------------------------------------------------
// `paragraph` — index.js:201-211. Parity class B.
// ---------------------------------------------------------------------------

/**
 * `paragraph` — `index.js:201-211`.
 *
 * **It styles and then reflows**, and `heading` does the opposite. `:205` is
 * `compose(this.o.paragraph, this.transform)`, so `chalk.reset` is applied to the whole
 * paragraph *before* `:208` reflows it — the reflow sees a string that already carries SGR
 * codes, and the paragraph's own styling therefore opens once at the start and closes once
 * at the end rather than per line. Standardising the two on one order would change bytes on
 * every styled paragraph in the corpus at forced colour for no reason anyone asked for, so
 * the inversion is preserved.
 *
 * Note also that `transform` runs *before* the reflow, so the reflow measures real colons,
 * never the 8-characters-longer colon sentinel. This one measures them too.
 *
 * `budget` is a parameter — `src/render.ts` computes `ctx.width - ctx.prefix.width()` and
 * calls this twice when the marker-collision guard fires. That guard stays at the call site
 * because it defends against a `marked-terminal` list landmine that WP-4 owns.
 */
export function renderParagraph(
  ctx: LayoutContext,
  token: Tokens.Paragraph,
  parseInline: ParseInline,
  budget: number,
): string {
  const styled = applyStyle(ctx, RESET, transform(ctx, parseInline(token.tokens)));
  return section(reflow(ctx, styled, budget));
}

// ---------------------------------------------------------------------------
// `heading` — index.js:116-133. Parity class B.
// ---------------------------------------------------------------------------

/**
 * `heading` — `index.js:116-133`.
 *
 * **It reflows and then styles**, the inverse of `paragraph` (see there). The style wraps
 * the whole already-wrapped block in one pair of codes, and `applyStyle` then closes and
 * reopens it around each `\n` — chalk's own `stringEncaseCRLFWithFirstIndex` behaviour,
 * transcribed in `src/inline.ts`, and live on this path whenever a heading wraps at all.
 *
 * `showSectionPrefix` defaults to `true` (`:51`) and this repo never overrides it, so the
 * `#`-run *and its trailing space* are prepended before the reflow and count against the
 * budget. `new Array(level + 1).join('#')` is `level` hashes.
 *
 * `firstHeading` (`chalk.magenta.underline.bold`) applies to level 1 only; every other level
 * gets `heading` (`chalk.green.bold`).
 */
export function renderHeading(
  ctx: LayoutContext,
  token: Tokens.Heading,
  parseInline: ParseInline,
  budget: number,
): string {
  const text = `${"#".repeat(token.depth)} ${transform(ctx, parseInline(token.tokens))}`;
  const chain = token.depth === 1 ? FIRST_HEADING : HEADING;
  return section(applyStyle(ctx, chain, reflow(ctx, text, budget)));
}

// ---------------------------------------------------------------------------
// `blockquote` — index.js:102-107. Parity class B.
// ---------------------------------------------------------------------------

/**
 * Trim the rendered body the way `quote.trim()` did — **except for the first content line's
 * own indent**, which is the one thing that trim should never have taken.
 *
 * `Renderer.prototype.blockquote` is `section(o.blockquote(indentify(tab, quote.trim())))`.
 * `indentify` then adds four columns to *every* line equally, so the trim is the only
 * asymmetry in the whole method — and it is a real one whenever the body's first line is
 * indented, which is exactly when the first child is a list (`indentLines` has already added
 * 4) or a nested blockquote. Untreated, the rendered list's first item sits four columns left
 * of its own siblings, at every width.
 *
 * `src/render.ts` used to compute those columns off the *input*
 * (`firstLineIndentTrimmedAway`) and paste them back onto the *output*
 * (`restoreFirstLineIndent`) after the library had already thrown them away, because there is
 * no spelling of a leading indent that `String.prototype.trim` will not eat. Owning the
 * method means simply not eating them: same rendered text, one pass instead of three, and no
 * arithmetic that has to agree with a library call in between.
 *
 * The one byte-level difference from the old save/restore is where the spaces sit relative to
 * the blockquote's own SGR codes: `restoreFirstLineIndent` prepended them *outside* the style
 * (it worked on the styled result and said so), and they are now inside it, because the trim
 * never removed them in the first place. Leading spaces are invisible either way and every
 * gate, sweep and detector in this tool measures ANSI-stripped text where the two strings are
 * identical — so this shows up only at forced colour, and only as a class-B enumeration entry.
 *
 * Only a run of literal spaces is kept. `trim` also eats tabs and newlines, and a leading
 * blank line is genuinely nothing to give back — the columns to keep are the ones on the
 * *last* line of what the leading whitespace run covers.
 */
function trimKeepingFirstIndent(body: string): string {
  const trimmedEnd = body.trimEnd();
  const lead = (/^\s*/.exec(trimmedEnd) as RegExpExecArray)[0];
  if (lead === "") return trimmedEnd;
  const rest = trimmedEnd.slice(lead.length);
  const lastLine = lead.slice(lead.lastIndexOf("\n") + 1);
  return /^ *$/.test(lastLine) ? `${lastLine}${rest}` : rest;
}

/**
 * `blockquote` — `index.js:102-107`.
 *
 * `body` is the already-parsed children, exactly as the library's own `:103-105` would have
 * produced them — it accepts either the token or a rendered string and only calls the parser
 * for the former. `src/render.ts` parses them itself so it can push the blockquote's four
 * owed columns onto the prefix stack for the duration, which is what makes every paragraph,
 * heading and list *inside* the quote wrap at its real budget instead of at the full width
 * and then need repairing.
 *
 * **No reflow of its own, and that is the library's behaviour, not an omission.**
 * `blockquote` never read `reflowText`; its children reflow themselves. What changes here is
 * that they now do so at the right width, so the width pass that used to run over this
 * method's result has nothing left to do.
 */
export function renderBlockquote(ctx: LayoutContext, body: string): string {
  return section(applyStyle(ctx, BLOCKQUOTE, indentify(TAB, trimKeepingFirstIndent(body))));
}
