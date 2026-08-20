import type { MarkedToken, Token, Tokens } from "marked";
import type { WikiLinkToken } from "./wikilink";

/**
 * **The owned token walk** (WP-2 of `plans/own-the-token-walk.md`).
 *
 * `src/render.ts` used to hand its token stream to `marked`'s own `Parser` —
 * `instance.use({ renderer })` followed by `instance.parse(processedBody, { async: false })` —
 * so the sixteen renderer methods this repo owns were *callbacks* `Parser` invoked, and they
 * re-entered it nine times through `this.parser.parse(tokens, top)` and
 * `this.parser.parseInline(tokens)`. That is what typed every one of them `=> string`
 * (`marked.d.ts:349-365`, `parseInline` at `:226`/`:234`): a callback cannot return a styled
 * span or a source range if the walker that calls it only knows how to concatenate strings.
 * Removing that constraint is the whole point of this module — **not** changing any output.
 * This package is parity-class A and moved no byte; the return type changes in the successor.
 *
 * **The lexer stays.** `render.ts` still calls `instance.lexer(...)`. This is not
 * "replace marked"; it is "own the tree walk", which is the one part that dictates the
 * interface.
 *
 * ## Reproduced from `node_modules/marked/lib/marked.cjs`, not discovered by diffing
 *
 * `Parser` is not a bare dispatcher, and assuming it was is what killed the predecessor plan
 * (`plans/style-last-rendering.md`). Every behaviour below is transcribed from the cited site
 * and pinned by a direct test in `tests/walk.test.ts`, including the two branches the
 * committed corpus never reaches (`image` and `space`) — corpus parity cannot prove a branch
 * the corpus never takes, and that is exactly where a walk rewrite hides its bug.
 *
 * | Behaviour | `marked.cjs` | Reproduced at |
 * |---|---|---|
 * | ten block cases, `space hr heading code table blockquote list html paragraph text` | `:1938-1994` | `parse` |
 * | ten inline cases, `escape html link image strong em codespan br del text` | `:2016-2064` | `parseInline` |
 * | block `text` coalescing — consecutive block `text` tokens joined with `\n`, **consuming the loop index** | `:1975-1982` | `parse`'s `text` case |
 * | the **synthetic `paragraph`** at `top` — a token the lexer never emitted, with a hand-built `tokens` array | `:1983-1990` | `parse`'s `text` case |
 * | `escape` routed to `renderer.text` | `:2028-2031` | `parseInline`'s `escape` case |
 * | `space` falling through to a default that returns `''` | `:1940-1943`, `:1695` | `parse`'s `space` case |
 * | `parseInline`'s optional renderer override | `:2013` | `parseInline`'s second parameter |
 * | unknown type **throws**, with that exact message | `:1995-2003`, `:2065-2073` | both `default` cases |
 * | the receiver every method is called with carries `.parser` | `:1905`, `:2262` | the constructor's `{ ...methods, parser: this }` |
 *
 * **One inline case is this repo's own and has no `marked.cjs` row: `wikilink`** (WP-2 of
 * `plans/wiki-link-tokenizer.md`). It is produced by an inline **tokenizer extension**
 * (`src/wikilink.ts`), which `marked`'s lexer dispatches at `:1551-1563` and which
 * `marked`'s `Parser` would have routed through `options.extensions.renderers` — the
 * pre-dispatch hook this walk deliberately does not carry over (see below). So the case
 * below *is* that hook, for the one extension this repo registers, and the method it
 * dispatches to is a first-class `WalkRendererMethods` entry rather than a side table.
 *
 * `wikilink` is **optional**, like `space` and for a related reason: it is the only
 * dispatched type whose token a plain `marked` lex never produces, so a walk consumer that
 * never registers the extension has nothing to supply. An effective renderer that lacks it
 * and is handed one anyway takes the ordinary unknown-type throw, which is the honest
 * answer — the alternative is a token silently rendering as nothing.
 *
 * `list_item` is a lexer-produced structural type consumed inside `list` (`src/lists.ts`), and
 * `def` is folded into `tokens.links` and never pushed onto the stream at all
 * (`marked.cjs:1425-1440`) — neither is dispatched, by `Parser` or by this walk, so both land
 * on the throwing default exactly as they did before.
 *
 * ## What dropping `marked.use()` moved here, and the one thing it deliberately did not
 *
 * `use()` (`marked.cjs:2246-2269`) did three things to every method it copied, and this module
 * now owns two of them:
 *
 * 1. **The receiver.** `use()` wrapped each method as `rendererFunc.apply(renderer, args)`,
 *    where `renderer` is marked's own `_Renderer` instance and `_Parser`'s constructor had
 *    set `renderer.parser = this` (`:1905`). *That* is where the `this.parser` the visitors in
 *    `src/render.ts` close over came from. `TokenWalker` reproduces it by the same mechanism
 *    rather than an imitation of it: the methods are copied onto one object that carries
 *    `parser`, and every dispatch is a plain method call on that object, so `this` is it.
 * 2. **The key-existence check.** `use()` threw if a key did not already exist on marked's
 *    `Renderer` (`:2251`), which is why `src/render.ts:882` recorded that constraint. It is
 *    gone with `use()`, and the constructor below replaces it with the check that was actually
 *    wanted: every dispatched method must be *supplied*, checked once at construction.
 * 3. **The `false` fallback and the falsy-to-`''` coercion** (`:2262-2267`:
 *    `if (ret === false) ret = prevRenderer.apply(renderer, args); return ret || ''`).
 *    **The coercion is reproduced by construction and the fallback is deliberately not
 *    reproduced.** Every one of the sixteen methods is typed `=> string` and returns one, so
 *    `ret || ''` is the identity on every value that can actually arrive: it maps a non-empty
 *    string to itself and `''` to `''`. The fallback's target was marked's *default*
 *    `_Renderer`, whose methods emit **HTML** — reaching it would have been a defect, never a
 *    feature, and there is no previous renderer to fall back to once the owned object is the
 *    only one. The constructor's completeness check is what closes the hole the fallback used
 *    to paper over, and it closes it at construction instead of mid-render.
 *
 * Two further narrowings, both recorded rather than silent:
 *
 * - **`options.silent` is not wired.** marked's two `default` cases log and return `''` from
 *   the *whole* parse when `silent` is set (`:1996-2000`). `_getDefaults()` sets
 *   `silent: false` (`marked.cjs:17-30`) and `renderDocumentDetailed` passed only
 *   `{ async: false }`, so that branch was unreachable here and is not carried over. A walk
 *   that can silently render nothing is worse than one that throws.
 * - **The `options.extensions.renderers` pre-dispatch hook** (`:1929-1937`, `:2005-2012`) is
 *   not carried over. It is unreachable at the seam this replaces: `_getDefaults()` sets
 *   `extensions: null` and `use()` only ever writes `opts.extensions` for a pack containing an
 *   `extensions` array (`:2158-2245`), which `src/render.ts`'s `{ renderer }` pack does not.
 */

/**
 * The receiver every renderer method is invoked with. It exists so a method can re-enter the
 * walk — `this.parser.parse(tokens, top)` and `this.parser.parseInline(tokens)` at the nine
 * sites in `src/render.ts` — and it carries nothing else, because nothing else was ever read
 * off marked's `_Renderer` by an owned method.
 */
export interface RendererHost {
  readonly parser: TokenWalker;
}

/**
 * The eighteen dispatched token types, mapped to the seventeen methods that render them —
 * `escape` shares `text`'s method, which is why `text` is typed for its token too.
 *
 * `space` is **optional and defaults to `''`**, which is not a convenience: this repo assigns
 * sixteen keys and `space` is one of the two it does not, so under `marked` a `space` token
 * fell through to `_Renderer.prototype.space` returning `''` (`marked.cjs:1694-1696`). Making
 * it optional here reproduces that, and keeps the door open for a walk consumer that wants to
 * see blank-line structure. Every other method is **required**, checked at construction.
 */
export interface WalkRendererMethods {
  space?(this: RendererHost, token: Tokens.Space): string;
  hr(this: RendererHost, token: Tokens.Hr): string;
  heading(this: RendererHost, token: Tokens.Heading): string;
  code(this: RendererHost, token: Tokens.Code): string;
  table(this: RendererHost, token: Tokens.Table): string;
  blockquote(this: RendererHost, token: Tokens.Blockquote): string;
  list(this: RendererHost, token: Tokens.List): string;
  html(this: RendererHost, token: Tokens.HTML | Tokens.Tag): string;
  paragraph(this: RendererHost, token: Tokens.Paragraph): string;
  text(this: RendererHost, token: Tokens.Text | Tokens.Escape | Tokens.Tag): string;
  link(this: RendererHost, token: Tokens.Link): string;
  image(this: RendererHost, token: Tokens.Image): string;
  strong(this: RendererHost, token: Tokens.Strong): string;
  em(this: RendererHost, token: Tokens.Em): string;
  codespan(this: RendererHost, token: Tokens.Codespan): string;
  br(this: RendererHost, token: Tokens.Br): string;
  del(this: RendererHost, token: Tokens.Del): string;
  /**
   * The one dispatched type `marked` does not define — see the header. Optional because a
   * consumer that does not register `wikiLinkExtension` can never be handed the token;
   * `src/render.ts`, which does register it, assigns this on every render.
   */
  wikilink?(this: RendererHost, token: WikiLinkToken): string;
}

/**
 * What the walk actually dispatches: `marked`'s own union plus this repo's one extension
 * token. `MarkedToken` is closed, so the extension type has to be added here rather than
 * cast away at each site — which is what keeps the `case "wikilink"` below exhaustive
 * rather than merely reachable.
 */
export type WalkToken = MarkedToken | WikiLinkToken;

/** The methods plus the `parser` back-reference — what a dispatch is actually made against. */
export type WalkRenderer = RendererHost & WalkRendererMethods;

/**
 * The subset `parseInline` may be overridden with, mirroring `Parser.parseInline`'s optional
 * second argument (`marked.cjs:2013`). marked constructs a `_TextRenderer` for exactly this
 * purpose and — measured at `14.1.4` — never passes it: `textRenderer` is assigned at `:1906`
 * and read nowhere. `src/render.ts` never passes an override either. It is supported and
 * tested regardless, because it is part of the contract this walk replaces and a successor
 * that wants a plain-text flattener will want it.
 */
export type InlineRenderer = Pick<
  WalkRenderer,
  "parser" | "text" | "html" | "link" | "image" | "strong" | "em" | "codespan" | "br" | "del" | "wikilink"
>;

/**
 * Every method that must be supplied. `space` is absent deliberately — see
 * `WalkRendererMethods`. The list is the ten block cases plus the ten inline cases, minus
 * `space` (optional) and minus `escape` (routed to `text`).
 */
const REQUIRED_METHODS = [
  "hr",
  "heading",
  "code",
  "table",
  "blockquote",
  "list",
  "html",
  "paragraph",
  "text",
  "link",
  "image",
  "strong",
  "em",
  "codespan",
  "br",
  "del",
] as const satisfies ReadonlyArray<keyof WalkRendererMethods>;

/** marked's own message, byte-for-byte (`marked.cjs:1996`, `:2066`). */
function unknownTokenError(type: string): Error {
  return new Error(`Token with "${type}" type was not found.`);
}

/**
 * The walk. One instance per render, constructed from the renderer methods it dispatches to;
 * `parse` and `parseInline` are the two entry points, and the same instance is reachable from
 * inside every method as `this.parser`, which is what makes the recursion work.
 */
export class TokenWalker {
  /**
   * The dispatch target. It is a *copy* of the supplied methods with `parser` added rather
   * than a mutation of the caller's object: `_Parser`'s constructor mutates
   * (`this.renderer.parser = this`, `marked.cjs:1905`) because its renderer is marked's own,
   * but `src/render.ts` builds its object literally and should not have a field appear on it.
   * The copy is shallow, so every method is the same closure it was — over `layout`,
   * `targetWidth`, `inlineDepth` and the prefix stack — and `this` at call time is this copy.
   */
  readonly renderer: WalkRenderer;

  constructor(methods: Partial<WalkRendererMethods>) {
    for (const name of REQUIRED_METHODS) {
      if (typeof methods[name] !== "function") {
        // The replacement for `marked.use()`'s key-existence throw (`marked.cjs:2251`), moved
        // from "the key exists on marked's Renderer" to "the method is supplied here". Under
        // `use()` a missing key silently left marked's HTML-emitting default in place; this
        // fails at construction, before a byte is rendered.
        throw new Error(`renderer method '${name}' is required by the token walk`);
      }
    }
    this.renderer = { ...(methods as WalkRendererMethods), parser: this };
  }

  /**
   * The block walk — `Parser.prototype.parse` (`marked.cjs:1925-2004`).
   *
   * `top` is `true` for the document's own token list and for a blockquote's children, and
   * `false` for a **tight** list item's, which is how `src/render.ts`'s `text` seam and
   * `src/lists.ts` tell the two apart: `renderList` routes items through
   * `parse(item.tokens, !!item.loose)` (the `loose` stamp is `marked.cjs:557-561`), so a tight
   * item's `text` children skip the synthetic paragraph below and land on the raw `body`.
   * That trap is reproduced here, not rediscovered.
   */
  parse(tokens: Token[], top = true): string {
    const renderer = this.renderer;
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      // `Token` is `MarkedToken | Tokens.Generic` and the index is checked, so neither the
      // switch nor the throw can narrow without this. It is the same cast marked's own
      // TypeScript source makes at this line (`const token = anyToken;`).
      const token = tokens[i] as MarkedToken;
      switch (token.type) {
        case "space": {
          // Not assigned by `src/render.ts`; `''` is `_Renderer.prototype.space`
          // (`marked.cjs:1694-1696`), which is what a `space` token has always produced here.
          out += renderer.space ? renderer.space(token) : "";
          continue;
        }
        case "hr": {
          out += renderer.hr(token);
          continue;
        }
        case "heading": {
          out += renderer.heading(token);
          continue;
        }
        case "code": {
          out += renderer.code(token);
          continue;
        }
        case "table": {
          out += renderer.table(token);
          continue;
        }
        case "blockquote": {
          out += renderer.blockquote(token);
          continue;
        }
        case "list": {
          out += renderer.list(token);
          continue;
        }
        case "html": {
          out += renderer.html(token);
          continue;
        }
        case "paragraph": {
          out += renderer.paragraph(token);
          continue;
        }
        case "text": {
          // **Coalescing, and the synthetic paragraph** (`marked.cjs:1974-1991`) — the two
          // behaviours a "thirty lines of dispatch" model of `Parser` misses entirely.
          //
          // Consecutive block `text` tokens are rendered individually and joined with `\n`,
          // and the loop index is **consumed** by the inner `++i` so the run is visited once.
          // Then, at `top` only, the joined body is handed to `paragraph` inside a token the
          // lexer never emitted: `type/raw/text` plus a one-element `tokens` array holding a
          // *bare* text token. That inner token has **no `tokens` key**, which is load-bearing
          // — condition 3 of the tight-item test in `src/render.ts`'s `text` override reads
          // exactly that key to tell a block text token from an inline one.
          //
          // The local is `Tokens.Text | Tokens.Tag` because `Tokens.Tag` is also stamped
          // `type: "text"` (`marked.d.ts:103-110`) and so cannot be narrowed out here. Only
          // the inline walk ever produces one; the union is what `renderer.text` already
          // accepts, and marked's own source carries the same widened local at this line.
          let textToken: Tokens.Text | Tokens.Tag = token;
          let body = renderer.text(textToken);
          while (i + 1 < tokens.length && tokens[i + 1]?.type === "text") {
            textToken = tokens[++i] as Tokens.Text | Tokens.Tag;
            body += "\n" + renderer.text(textToken);
          }
          if (top) {
            out += renderer.paragraph({
              type: "paragraph",
              raw: body,
              text: body,
              tokens: [{ type: "text", raw: body, text: body }],
            });
          } else {
            out += body;
          }
          continue;
        }
        default: {
          throw unknownTokenError(token.type);
        }
      }
    }
    return out;
  }

  /**
   * The inline walk — `Parser.prototype.parseInline` (`marked.cjs:2009-2075`).
   *
   * Two things here are contract rather than detail: `escape` has no method of its own and is
   * routed to `text` (`:2028-2031`, which is why `src/render.ts:1053` types its `text` for
   * `Tokens.Escape`), and the renderer is a *parameter*, so an override dispatches to itself
   * rather than to this walk's renderer.
   *
   * **The override contract extends to `wikilink` unchanged, and that is the point.** The
   * effective renderer is `override ?? main`, and the `wikilink` case dispatches through
   * *it*, not through `this.renderer` — so a plain-text flattener handed in as an override
   * gets to decide how a wiki-link flattens, exactly as it decides how a `link` does. An
   * override that does not carry the method takes the unknown-type throw below, which is the
   * same answer this walk gives for any type its renderer cannot render.
   */
  parseInline(tokens: Token[], renderer: InlineRenderer = this.renderer): string {
    let out = "";
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as WalkToken;
      switch (token.type) {
        case "wikilink": {
          // `src/wikilink.ts`'s extension token. Dispatched through the *effective*
          // renderer, and throwing when that renderer has no method for it — see the
          // override contract above and the header's note on why the method is optional.
          const wikilink = renderer.wikilink;
          if (wikilink === undefined) throw unknownTokenError(token.type);
          out += wikilink.call(renderer, token);
          break;
        }
        case "escape": {
          out += renderer.text(token);
          break;
        }
        case "html": {
          out += renderer.html(token);
          break;
        }
        case "link": {
          out += renderer.link(token);
          break;
        }
        case "image": {
          out += renderer.image(token);
          break;
        }
        case "strong": {
          out += renderer.strong(token);
          break;
        }
        case "em": {
          out += renderer.em(token);
          break;
        }
        case "codespan": {
          out += renderer.codespan(token);
          break;
        }
        case "br": {
          out += renderer.br(token);
          break;
        }
        case "del": {
          out += renderer.del(token);
          break;
        }
        case "text": {
          out += renderer.text(token);
          break;
        }
        default: {
          throw unknownTokenError(token.type);
        }
      }
    }
    return out;
  }
}
