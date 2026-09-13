import * as nodeEmoji from "node-emoji";
import type { Token, Tokenizer, Tokens } from "marked";
import { link as osc8Link } from "./ansi";
import type { LayoutContext } from "./layout-context";
import { applyStyle, createStyler } from "./style";

/**
 * `del` — the owned **tokenizer** for `~text~` / `~~text~~` (2026-09-12 defect).
 *
 * `marked@14`'s own `del` runs its regex on the *raw* source, unlike `emStrong`, which
 * the lexer hands a `maskedSrc` with code spans, links and autolinks blanked out
 * (`marked.esm.js:1537`, the `blockSkip` pass). So `a ~300-line sidecar … the persona
 * `~/.codex/AGENTS.md`` lexed as one strikethrough from `~300` to the `~` *inside* the
 * later code span — the code span's opening backtick became literal text and every code
 * span after it in the paragraph inverted (yellow prose, plain code) until the paragraph
 * ended. GFM resolves this by precedence: a code span wins over a delimiter run, so the
 * closer inside backticks is not a closer. This override reproduces marked's `del`
 * exactly, but finds the closer on a `blockSkip`-masked copy (length-preserving, so the
 * slice offsets apply to the real source) and takes `raw`/`text` from the real source.
 * A closer that only exists inside a code span, link target or autolink no longer
 * matches; a `~text~` pair in plain prose still does.
 */
export const DEL_TOKENIZER = {
  del(this: Tokenizer, src: string): Tokens.Del | undefined {
    const blockSkip = this.rules.inline.blockSkip;
    let masked = src;
    let match: RegExpExecArray | null;
    blockSkip.lastIndex = 0;
    while ((match = blockSkip.exec(masked)) !== null) {
      masked =
        masked.slice(0, match.index) +
        "[" +
        "a".repeat(match[0].length - 2) +
        "]" +
        masked.slice(blockSkip.lastIndex);
    }
    const cap = this.rules.inline.del.exec(masked);
    const delim = cap?.[1];
    if (!cap || delim === undefined) return undefined;
    const raw = src.slice(0, cap[0].length);
    const text = src.slice(delim.length, cap[0].length - delim.length);
    return { type: "del", raw, text, tokens: this.lexer.inlineTokens(text) };
  },
};

/**
 * The owned inline visitors — `strong`, `em`, `codespan`, `del`, `br`, `link`, `image`
 * and inline `text`.
 *
 * **Every inline token this renderer dispatches is rendered here, and nowhere else.**
 * `marked-terminal` is not a dependency — it has no entry in `package.json` — and the
 * block renderers are `src/blocks.ts`'s and `src/lists.ts`'s. **Byte-identical output is
 * still the gate** (parity class A): these are deterministic string operations, so if
 * rendered text moves anywhere, that is a defect and not an improvement.
 *
 * *How that came to be true:* this was the first group taken off `marked-terminal` (WP-2 of
 * `plans/marked-terminal-replacement.md`), a strangler-fig step taken while the library did
 * still own every block renderer; WP-3 through WP-6 of that plan took the rest, method by
 * method, and removed the package. The removal record is
 * `docs/agents/dependency-history.md`.
 *
 * Everything here is written against `marked-terminal@7.3.0`'s `index.js` and reproduces
 * it deliberately, defects included. Where a behaviour looks wrong it is annotated as
 * such and left alone; correcting it is a later package's decision, taken against a
 * parity class that allows output to move.
 *
 * `src/table.ts` was the model this followed: own the emitter, take the escape sequences
 * from a table rather than writing them out inline, and say in the source *why* each byte
 * is the byte it is. The table was `@colors/colors`' until WP-2 of
 * `plans/colour-policy.md`; it is `src/style.ts`'s committed one now, and the two modules
 * that used to answer the colour question for themselves — `src/table.ts` and
 * `src/frontmatter.ts` — style through the same emitter under the same policy.
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
 * The chain machinery moved to `src/style.ts` in WP-2 of `plans/colour-policy.md`.
 *
 * `Styler`, `createStyler` and `applyStyle` — and the two `chalk` helpers they are built
 * from — lived here from WP-2 of `plans/marked-terminal-replacement.md` until this
 * package, together with a `STYLE_CODES` read of `@colors/colors`' full styles record
 * through a cast. They are unchanged; what moved is *where the bytes come from* (a narrow
 * committed table rather than a dependency's record) and *who else calls them*
 * (`src/table.ts` and `src/frontmatter.ts` now do, so the inline visitors are no longer
 * the only styling authority in the renderer). The chains below are the six
 * `marked-terminal`'s `defaultOptions` used, built the same way from the same names.
 */

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
 * - With OSC-8 support, the styled label is wrapped in an OSC-8 hyperlink and the URL has
 *   `+` percent-encoded (upstream comment: its own `textLength` breaks on `+` in URLs).
 * - Without it, the shape is `text (href)`.
 * - Either way the whole thing is wrapped in `chalk.blue`, over an href that is already
 *   `chalk.blue.underline` — which is what makes the close-code re-opening in `applyStyle`
 *   fire on essentially every link in the corpus.
 *
 * **The capability answer is `ctx.hyperlinks`, and WP-1 of `plans/colour-policy.md` is what
 * made it a value.** It used to be `supportsHyperlinks.stdout` — that library's own
 * module-load answer, which no caller could influence and which carried a `FORCE_HYPERLINK`
 * variable, two argv flag families and a pre-TTY `NETLIFY` bypass nobody here asked for. The
 * branch list that decided it is transcribed into `resolveHyperlinks` (`src/colour.ts`);
 * what reaches this line is the decision, already made.
 *
 * **And the emission is this repo's since WP-3 of the same plan.** `ansiEscapes.link` was
 * the last third-party escape emitter in the renderer; `src/ansi.ts`'s `link` is its
 * transcription (cited line by line there), with two differences that are the point of
 * taking it over: the destination is **sanitized** at emission per Decision 1 — a
 * document's own href is interpolated into a control sequence here, and it is the only
 * place in the renderer where that happens — and the tmux DCS envelope is chosen from
 * `ctx.tmux`, resolved once per render, rather than from a `process.env` read at the
 * library's module load. The `%20` replace below is untouched, and stays *outside* the
 * emitter: it is `marked-terminal`'s own workaround for its `textLength`, not part of the
 * sequence grammar.
 */
export function renderLink(ctx: LayoutContext, token: Tokens.Link, parseInline: ParseInline): string {
  const href = token.href;
  const text = parseInline(token.tokens);
  const hasText = Boolean(text) && text !== href;

  let out = "";
  if (ctx.hyperlinks) {
    const label = text ? applyStyle(ctx, HREF, emojify(ctx, text)) : applyStyle(ctx, HREF, href);
    out = osc8Link(label, href.replace(/\+/g, "%20"), ctx.tmux);
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
