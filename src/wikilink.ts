/**
 * Wiki-link recognition — the **inline tokenizer extension**, the token it produces, and
 * the prose visitor that renders it. WP-2 of `plans/wiki-link-tokenizer.md`.
 *
 * ## What this replaced, and the defect that forced it
 *
 * Until this package recognition was a **pre-lexer regex substitution** over source lines
 * (`markWikiLinks`, called from `preprocessBody`): every `[[…]]` on every line the fence
 * toggle did not skip was rewritten to a carrier-wrapped `alias ?? slug` *before* `marked`'s
 * lexer ran, and a post-walk pass styled each balanced carrier pair.
 *
 * That mechanism could not know what a construct the lexer had not yet built would turn out
 * to own, so it fired inside verbatim contexts — indented code, block HTML, container-nested
 * code — and inside link and image destinations and titles, HTML attribute values and
 * comments, autolinks, bare URLs and reference definitions. The substitution was
 * **irreversible**: the brackets, the `|`, the `!`, the `#fragment` and the slug itself
 * (whenever an alias was present) were gone before the lexer ran, so nothing downstream
 * could restore them. Block HTML was the worst case — `extractCodeRanges` only brackets
 * `wrapCode` output, so that corruption carried no `codeRange` and no gate could see it.
 * Three fix designs for the pre-pass failed three audit cycles (leaf restore; byte-offset
 * line map; line-count map); the full record is `src/AGENTS.md`, "The wiki-link carrier
 * defect".
 *
 * **The tokenizer needs none of that bookkeeping.** Recognition happens *inside* the lexing
 * pass, so a verbatim context is protected **by construction**: the inline tokenizer is
 * simply never offered a position inside a `code` token, a block `html` token, a
 * container-nested code block, a formed codespan, a link/image destination or title, or an
 * HTML tag or comment. There are no source coordinates left to get wrong.
 *
 * ## What the carriers were, and why they are gone
 *
 * `WIKI_LINK_OPEN`/`WIKI_LINK_CLOSE` were control code points 2 and 3, the same sentinel
 * idiom `SENTINEL` (0) and `TASK_STATE_SENTINEL` (1) use, marking a label through the lexer
 * and the walk so a post-walk pass could style it under the resolved policy. They existed
 * because the *pre-pass* had to hand a decision it could not make to a pass that could. The
 * tokenizer hands the walk a token instead, and the visitor below styles it at emission —
 * so the carriers have nothing left to carry. Both code points now mean **nothing** to this
 * renderer and pass through as content (grant C4 of the plan; code points 0 and 1 keep
 * their strips, which have internal meaning). The invariant that survives is the one that
 * mattered: **this tool generates no carrier byte and no escape byte that enters the
 * lexer.**
 *
 * ## Recognition semantics, and the two deliberate changes
 *
 * `WIKI_LINK` below is still byte-for-byte the regex `src/render.ts` carried, kept exported
 * because it is the provenance record — the same pattern an in-house web markdown renderer
 * applies to the same corpus, so two tools rendering one note agree about what a wiki-link
 * *is*. `WIKI_LINK_TOKENIZER` is that regex in the form an inline tokenizer needs:
 * **anchored, non-global**, and with `\n` excluded from all three negated character classes
 * (locked decision D2 — an Obsidian slug is a filename, so a newline in one makes no sense,
 * and the line-scoped behaviour the per-line pre-pass had is preserved exactly).
 *
 * The label is **`alias ?? slug`, always lexed into child tokens** (locked decision D5) via
 * `this.lexer.inlineTokens(label)`. That is parity, not a new feature: the pre-pass wrote
 * the label back into the *source*, so a bare slug's own markup already reached the lexer —
 * `[[**bold**]]` has always rendered bold. Two consequences follow and both are deliberate:
 * a label's children can include `link`/`url` tokens, which reach `renderLink` and its OSC-8
 * emission (grant C5 — that is what repairs the malformed sequence a URL-shaped slug used to
 * produce); and in a **cell** those children are flattened to plain text instead, by
 * `src/table.ts`'s own flattener, exactly as `strong`/`em`/`del`/link children already
 * flatten there (locked decision D3).
 *
 * Three behaviours worth naming because they changed at the cutover and were granted at
 * approval rather than discovered:
 *
 * - a **codespan interior** that syntactically forms is now literal — the tokenizer can
 *   never be offered a position inside one (D1). A `[[` that opens *before* a backtick still
 *   wins positionally, which is byte-for-byte what the line-level regex did (D1's scope note);
 * - a wiki-link inside a **link or image label** breaks the outer construct, where the
 *   pre-pass's rewrite let it survive — an enumerated, granted loss (C3);
 * - an **unescaped `|`** inside a cell's `[[…]]` splits the cell per GFM (D4). The
 *   authored-correct spelling is the escaped `[[s\|Alias]]`, which `marked` unescapes when it
 *   splits the row, so the tokenizer sees a real `|` and reads it as the alias separator.
 */
import type { Token } from "marked";
import type { TokenizerExtension, TokenizerThis } from "marked";
import { link as osc8Link } from "./ansi";
import type { LayoutContext } from "./layout-context";
import { type StyleName, applyStyleChain } from "./style";

/**
 * The wiki-link pattern, moved here from `src/render.ts:41` **verbatim** — see the
 * "Recognition semantics" note above. Exported so a test can assert the recognition
 * boundary directly rather than inferring it from rendered output, and kept as the
 * provenance record the tokenizer form below is derived from.
 */
export const WIKI_LINK = /(!)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/**
 * The same pattern in the form an inline tokenizer needs.
 *
 * Three differences from `WIKI_LINK`, each required and each narrow — the first two decide
 * what matches, the third only what the match hands back:
 *
 * - **anchored and non-global.** `marked`'s inline loop offers a tokenizer the remaining
 *   source and asks "does a token start *here*"; a `g`-flagged, unanchored regex would carry
 *   `lastIndex` across calls and could match further along the string, consuming source the
 *   loop never offered.
 * - **`\n` excluded from all three negated classes** (`[^\]|#\n]+`, `[^\]|\n]*`,
 *   `[^\]\n]+`). The pre-pass was applied line by line, so its opening and closing brackets
 *   could never be in the same string and a multiline `[[a\nb]]` did not match. The lexer
 *   offers whole inline runs, newlines included, so without this exclusion the tokenizer
 *   would start matching a construct that has never been a wiki-link here (locked D2).
 * - **the `#fragment` is captured** (group 3, `#` itself excluded), which shifts the alias to
 *   group 4. Added by WP-2 of `plans/follow-wiki-links.md` so `styleWikiLabel` can hand the
 *   fragment to the resolver and the `file://` URI can carry it; the group is *non-capturing
 *   in `WIKI_LINK`* and stays that way, because that regex is the provenance record shared
 *   with an in-house web renderer and this repo does not edit it. Adding parentheses changes
 *   **what the match exposes, never what it matches** — the recognition set is byte-for-byte
 *   what it was, which is what the recognition witnesses in `tests/wikilink-tokenizer.test.ts`
 *   pin.
 */
export const WIKI_LINK_TOKENIZER = /^(!)?\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]+))?\]\]/;

/**
 * Cyan + underline, as an ordered chain of names rather than a prebuilt `Styler`.
 *
 * The names are what both consumers need: `styleWikiLabel` below hands them to
 * `applyStyleChain` (`src/style.ts`), and `src/table.ts` records them as a `CellSpan`'s
 * `styles` so the fragment emitter can hand *the same* applicator *the same* chain. Order is
 * outermost-first, so the bytes are exactly `chalk.cyan.underline`'s — the four codes
 * `styleWikiLink` hardcoded before any of this was owned (`\x1b[36m\x1b[4m` /
 * `\x1b[24m\x1b[39m`), now produced by the committed style table.
 */
export const WIKI_LINK_STYLES: readonly StyleName[] = ["cyan", "underline"];

/**
 * The token the extension produces — **repo-local**, because `marked` has no wiki-link and
 * the walk that dispatches this is this repo's (`src/walk.ts`).
 *
 * `tokens` is the label's own inline children, lexed by `this.lexer.inlineTokens` at
 * tokenize time, so the walk renders them exactly as it renders any other inline run.
 * `slug` and `alias` are kept even though the label is derived from them, because they are
 * the authored content and a successor that navigates a wiki-link needs the *target*, not
 * the label — see `docs/adr/0001-editor-path.md`. **That successor arrived for the viewer**
 * (`plans/follow-wiki-links.md`): `styleWikiLabel` below hands `slug` and `fragment` to the
 * resolver on the context, and the label becomes an OSC-8 `file://` link to the note the
 * slug names.
 */
export interface WikiLinkToken {
  readonly type: "wikilink";
  readonly raw: string;
  readonly slug: string;
  readonly alias?: string;
  /**
   * The `#…` text with the `#` removed — the heading or block an Obsidian link points
   * *inside* the target note at. Present only when authored, exactly like `alias`, so a
   * `[[a]]` and a `[[a#]]` are distinguishable (the latter carries `""`; it authored an
   * empty fragment and the resolver is handed one). Never part of `slug`: the fragment
   * group has always been excluded from it, and the label has never shown it.
   */
  readonly fragment?: string;
  readonly embed: boolean;
  readonly tokens: Token[];
}

/**
 * The extension `src/render.ts` registers on its `Marked` instance.
 *
 * `level: "inline"` puts it in the inline loop, where `marked` tries extension tokenizers
 * **first** at each position (`marked.cjs:1551-1563`) and then falls through to its own —
 * which is exactly the precedence the plan's matrix enumerates row by row.
 *
 * `start` is the naive index of `[[`. Its only job is to stop `inlineText` from swallowing a
 * position this tokenizer would have claimed: `marked` clips `cutSrc` for `inlineText` alone
 * (`:1639-1652`), so a `start` that is merely *not too late* is sufficient and cannot break
 * any other tokenizer's parse. A bang-aware backtrack is unnecessary — `inlineText`'s own
 * stop-set already includes `!`.
 *
 * There is **no `renderer` field**, deliberately. `marked.use()` accepts a renderer-less
 * extension, and a renderer here would be dead code: this repo owns the walk, so the token
 * is dispatched by `TokenWalker` to `renderer.wikilink`, never by `marked`'s `Parser`.
 */
export const wikiLinkExtension: TokenizerExtension = {
  name: "wikilink",
  level: "inline",
  start(src: string): number {
    return src.indexOf("[[");
  },
  tokenizer(this: TokenizerThis, src: string): WikiLinkToken | undefined {
    const match = WIKI_LINK_TOKENIZER.exec(src);
    if (!match) return undefined;

    const [raw, bang, slug, fragment, alias] = match;
    // noUncheckedIndexedAccess: group 2 is not optional in the pattern, but capture groups
    // type as `string | undefined` regardless.
    if (raw === undefined || slug === undefined) return undefined;

    return {
      type: "wikilink",
      raw,
      slug,
      ...(fragment === undefined ? {} : { fragment }),
      ...(alias === undefined ? {} : { alias }),
      embed: bang !== undefined,
      // **The label is `alias ?? slug`, lexed into children** (D5). `this` is `{ lexer }`
      // and `inlineTokens` is synchronous and re-entrant-safe at `marked@14.1.4` — measured,
      // not assumed (the plan's probe m), and pinned by the nested-markup witnesses.
      tokens: this.lexer.inlineTokens(alias ?? slug),
    };
  },
};

/**
 * The prose visitor: render the label's children, style the result, prefix an embed.
 *
 * Three things here are contract rather than detail:
 *
 * - **the children go through the walk's inline path**, so `strong`, `codespan`, `link` and
 *   `url` children render exactly as they would in ordinary prose. A `url` child reaching
 *   `renderLink` is what makes a URL-shaped slug emit a *well-formed* OSC-8 sequence: the
 *   old carrier pass ran over the finished document, long after the OSC-8 was emitted, and
 *   wrote this chain's close codes **inside the destination before the BEL** (grant C5);
 * - **the chain is applied through `applyStyleChain`** — the one shared applicator, which
 *   `src/table.ts`'s fragment emitter also calls. Under `formats` the cyan drops and the
 *   underline stays; under `none` nothing is emitted at all;
 * - **`embed: ` sits outside the styled span**, literal and unstyled, exactly where it sat
 *   outside the carriers and outside the SGR pair before them. It is also outside the
 *   *children*, so it is never lexed as markdown.
 *
 * **Styling now happens before the wrap, which is where every other styled span in this
 * renderer already is** (grant C2). The old pass styled a label that `src/wrap.ts` had
 * already split, so `applyStyle`'s line-break encasing closed and reopened the pair around
 * every generated break; `wrapAnsi` synthesizes no such pair, so a wrapped label now carries
 * one open and one close however many lines it crosses.
 *
 * ## Following the link (WP-2 of `plans/follow-wiki-links.md`)
 *
 * A styled label the terminal cannot follow was the whole of this visitor until that plan. It
 * now wraps that label in an OSC-8 hyperlink to the note the slug names, on exactly the terms
 * `renderLink` uses (`src/inline.ts`) — **style inside the sequence, `embed: ` outside it** —
 * and under exactly the same gate, `ctx.hyperlinks`, so `--plain`, `--hyperlinks=never`, a
 * pipe and `--check` are unaffected by construction (D5).
 *
 * Three conditions, all of which must hold, and each of which is why a render can be
 * byte-identical to the pre-plan one:
 *
 * - **`ctx.hyperlinks`** — the resolved hyperlink axis, the same field `renderLink` reads;
 * - **`ctx.resolveWikiLink` is present.** It is an optional context field (D6), so the
 *   renderer never touches the filesystem itself and a caller that hands no resolver —
 *   `bun run sweep`, the colour axis, every test that does not ask for this — renders exactly
 *   what it rendered before;
 * - **the styled label carries no OSC-8 open of its own (D7).** A label's children may already
 *   have emitted one: a URL-shaped slug or alias reaches `renderLink` by design (grant C5), and
 *   `src/ansi.ts`'s `link` has no nesting contract — an inner open replaces the active
 *   destination and its close does not restore the outer one, so wrapping would leave the rest
 *   of the line pointing at nothing. The child link wins and the resolver is not even consulted.
 *   The test is the literal introducer `ESC ] 8 ; ;`, which finds a tmux-enveloped child too:
 *   the envelope only doubles `ESC`, so the substring survives inside it.
 *
 * Only then is `ctx.resolveWikiLink(token.slug, token.fragment)` called, and only a defined
 * return wraps: an unresolved slug renders byte-identically to today, with no marker of any
 * kind (D3). The `+` → `%20` replace `renderLink` applies is deliberately **not** applied here
 * — that is `marked-terminal`'s own workaround for its `textLength`, not part of the sequence
 * grammar and not part of a `file://` URI, which `src/wikiresolve.ts` has already percent-encoded.
 */
export function styleWikiLabel(
  ctx: LayoutContext,
  token: WikiLinkToken,
  parseInline: (tokens: Token[]) => string,
): string {
  const label = applyStyleChain(ctx, WIKI_LINK_STYLES, parseInline(token.tokens));
  const linked = followWikiLink(ctx, token, label);
  return token.embed ? `embed: ${linked}` : linked;
}

/** ESC, U+001B. Built, never pasted — `src/ansi.ts`'s convention, for the same reason. */
const ESC = String.fromCharCode(0x1b);
/**
 * The OSC-8 introducer with its empty parameter field, `ESC ] 8 ; ;` — D7's test, and the
 * only place outside `src/ansi.ts` this repo spells any part of a sequence. It is a *probe*,
 * never emitted: `osc8Link` remains the one emitter.
 */
const OSC8_OPEN = `${ESC}]8;;`;

/**
 * D7's guard and the wrap itself, kept out of `styleWikiLabel` so the three conditions read as
 * one expression rather than a nest. Returns the label unchanged whenever any of them fails,
 * which is every render before this plan and every render the gates make.
 */
function followWikiLink(ctx: LayoutContext, token: WikiLinkToken, label: string): string {
  if (!ctx.hyperlinks || ctx.resolveWikiLink === undefined) return label;
  if (label.includes(OSC8_OPEN)) return label;
  const href = ctx.resolveWikiLink(token.slug, token.fragment);
  return href === undefined ? label : osc8Link(label, href, ctx.tmux);
}
