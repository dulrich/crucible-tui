import type { Token, Tokens } from "marked";
import {
  renderBlockquote,
  renderHeading as renderBlockHeading,
  renderParagraph as renderBlockParagraph,
} from "./blocks";
import { renderInlineText } from "./inline";
import { type LayoutContext } from "./layout-context";
import { MARKER_SHAPED_LINE, REWRITABLE_MARKER_LINE, isGuardShapedLine, stripAnsi } from "./list-lines";
import { renderList, substituteBullets } from "./lists";
import { type RendererHost } from "./walk";
import { wrapAnsi } from "./wrap";
import { type Measure } from "./width";

/**
 * The list/text layout state machine — the five visitors that share a per-render
 * layout state, and the module-level helpers only they call.
 *
 * **What this module is, in one sentence.** `renderDocumentDetailed` (`src/render.ts`)
 * lexes, builds the `LayoutContext`, assembles the renderer object, runs `TokenWalker`
 * and post-processes the result; *this* is the layout state that five of those visitors
 * mutate and read while the walk is running, extracted from inside that function at WP-R2
 * of `plans/post-refactor-code-quality-remediation.md`. Nothing about a visitor's body,
 * its `this`, or the order anything runs in changed in that move — it landed
 * byte-identical, which is the only class of diff the work package allowed.
 *
 * **The state is two counters and a stack this module does not own.**
 *
 * - `inlineDepth` — non-zero while a visitor that dispatches *inline* tokens is on the
 *   stack. Raised by `paragraph`, `heading` and the `text` seam's own `parseInline` call;
 *   read by `text` as condition 2 of the tight-list-item test. It has exactly one owner
 *   *because* it is read by one visitor and written by three, and splitting those across
 *   two modules is how a counter silently stops balancing.
 * - `quoteColumns` — columns of enclosing blockquote indent, kept in step with the
 *   `blockquote` visitor's own push/pop in the same `try`/`finally`, because
 *   `rewrapListBody`'s budget needs *quote* columns alone (see `currentListBudget`).
 * - the pending-prefix stack itself is **not** this module's: it lives on the
 *   `LayoutContext` (`src/layout-context.ts`), and the three aliases below are the same
 *   local aliases `renderDocumentDetailed` used to declare, so every call site reads
 *   exactly as it did.
 *
 * **It closes over one `LayoutContext` and is constructed once per render.** That is the
 * whole of its scope: it is not a renderer extension API, it registers nothing, and it
 * exports one factory returning five methods that `renderDocumentDetailed` assigns onto
 * the renderer object itself. Visitor assembly stays there; the state and its logic are
 * here.
 *
 * **The methods are still typed the way `TokenWalker` dispatches them** — `function`
 * declarations with an explicit `this: RendererHost`, never arrows, because `this.parser`
 * *is* the walker and each one re-enters the walk through it (`src/walk.ts`'s header
 * carries where that receiver came from).
 *
 * The subsystem record is `docs/agents/list-pipeline.md` — composition, the two wrap
 * paths, the de-drift, the claim domains and the retained passes — and `src/AGENTS.md` is
 * the contract these visitors answer to.
 */

// **`listitem` and `checkbox` were dead seams until WP-4, and that is why `src/lists.ts`
// exists.** `marked-terminal` only ever called `renderer.list()` — never
// `renderer.listitem()` — because `Renderer.prototype.list` iterated a list token's items
// and called `this.listitem(...)` on its own *internal* Renderer instance, not on the
// extension object marked dispatches through. Confirmed by instrumenting both hooks
// against a two-level nested list: `list` fired twice (once per nesting level),
// `listitem` fired zero times. So the depth-tracking *and* the wrapping both had to live
// in the `list` override, and the only way to reach the other two was to own composition
// outright — which `src/lists.ts` now does.
//
// Because nested list tokens are rendered synchronously, depth-first, while an
// ancestor's own `list()` call is still on the stack (a nested list is reached via
// `this.parser.parse(item.tokens, …)` inside `composeItem`), a simple
// enter/exit counter on our `list` renderer is accurate at the point each level's
// body is produced — `listDepth()` below is that counter, and `substituteBullets`'
// outermost-list gate is its one remaining consumer.
//
// The widest-marker budget estimate that used to live here (`listMarkerWidth`,
// `markerLineCount`, `nestedMarkerLineCount`) is gone (WP-5): every wrapping seam reads
// the item's exact budget off the prefix stack — the level pushes its 4-column indent,
// the item pushes its own marker's width (`src/lists.ts`'s `composeItem`). What remains
// below (`currentListBudget`, `LIST_LINE_PREFIX`, `rewrapListBody`) is not the old
// repair net but the *primary wrap for uncoalesced tight items* — see
// `rewrapListBody`'s comment for the measured reason it cannot move into the `text`
// seam, and this WP's report for the identity-substitution gate that bounds exactly
// what it still touches.

// `marked-terminal`'s own blanket indent is `this.tab` (4) columns per nesting level,
// applied even at the outermost level — see the brief's worked example (`"    * alpha"`
// at depth 1, `"        * beta"` at depth 2, …). Once a list's `fixNestedLists` pass has
// fully resolved a line's position (see `substituteBullets`'s doc comment for why that
// matters), its nesting depth can be read straight back out of its own indentation.
const LIST_INDENT_PER_LEVEL = 4;

// A blockquote indents its whole rendered body by 4 columns once its children have already
// rendered — `Renderer.prototype.blockquote`'s `indentify(this.tab, …)` (`index.js:106`)
// until WP-3, and `src/blocks.ts`'s `renderBlockquote` since. The library also `trim()`ed
// that body first, which cost the first line its own indent and needed a save/restore dance
// to put back; the owned renderer simply does not trim it away (see
// `trimKeepingFirstIndent`).
const BLOCKQUOTE_INDENT_PER_LEVEL = 4;

/**
 * Is this rendered line *shaped* like a marker line — asked of the columns a reader sees.
 *
 * **Every marker-shape question in this file goes through here since WP-3 of
 * `plans/colour-policy.md`**, and each of them used to be asked of the raw bytes. All
 * three wrapping seams below defuse a marker-shaped continuation line by giving it a
 * guard space, and all three were silently inert under colour: `applyStyle`'s newline
 * encasing puts the open code at the head of every line, so a line that reads `* or N..`
 * to a reader begins with `ESC[33m` to an anchored regex and matched nothing. The
 * measured consequence is not a missing space — it is a *different wrap*, because a seam
 * that does not see the collision does not re-wrap a column narrower either:
 * `tests/fixtures/fenced-list.md` at width 116 wrapped its paragraph at 114 columns
 * colourless and at 116 under colour, a two-line divergence with no styling in it.
 *
 * The guard space itself is still inserted at the head of the raw line — ahead of the
 * encoding's own open code — which is where it belongs: it is a column, and columns come
 * before bytes on the page.
 */
const marksVisible = (pattern: RegExp, line: string): boolean => pattern.test(stripAnsi(line));

// `MARKER_SHAPED_LINE` and `COLUMN_ZERO_MARKER` moved to `src/list-lines.ts` in WP-4 of
// `plans/marked-terminal-replacement.md`, and `isGuardShapedLine` is the union both
// wrapping seams below guard with. The second of the two used to be declared here *and* in
// `src/detectors.ts`, spelled with `\u` escapes in one file and literal glyphs in the other,
// kept in step by hand with no gate able to see them drift; this file's own note said the
// move belonged to whichever of WP-4 or WP-7 next had both files open. See those regexes'
// doc comments for what each one is asking and why they are two shapes rather than one.

/**
 * `marked-terminal`'s `HARD_RETURN` (`index.js:26`), the marker `Renderer.prototype.br`
 * (`index.js:291-293`) emits in place of a hard break when `reflowText` is on.
 *
 * **It reaches a list item since WP-14**, and that is a change: WP-2c measured zero of
 * them here and said so, because `marked-terminal`'s raw-text path meant `br` never fired
 * inside an item. The `text` override now dispatches the item's inline tokens, so it does,
 * and that override converts each marker into `HARD_RETURN` + `\n` precisely so this
 * constant keeps meaning what it meant — a break a coalescing pass must refuse to join
 * across. The guard in `isHardBoundary` was written for the case "if it ever does"; it now
 * carries real traffic rather than none.
 */
const HARD_RETURN = "\r";

/**
 * An authored hard line break, as it survives into a list item's text on the paths that
 * still return `marked-terminal`'s raw source.
 *
 * **Not `HARD_RETURN`.** `marked-terminal`'s `Renderer.prototype.text` (`index.js:84-89`)
 * renders a block text token from its raw `token.text` field and never dispatches
 * `token.tokens`, so on that path no inline token is ever rendered — `br` does not fire,
 * no `HARD_RETURN` is produced, and the item's *markdown source syntax* arrives verbatim
 * instead. (This is the same library behaviour that made `**bold**` render as literal
 * asterisks inside an item, which is the defect WP-14 closed.) A hard break is therefore
 * still visible, as the source spelling that created it, immediately before the `\n`:
 *
 * - two or more trailing spaces,
 * - a trailing backslash,
 * - a literal `<br>` / `<br/>` / `<br />`.
 *
 * Measured over 600 corpus files: 11,675 soft breaks inside tight items, **1** hard
 * break (trailing spaces), **0** `HARD_RETURN`, **0** `SENTINEL`. Rare is not never —
 * the one instance must survive, which is why this is a boundary and not a heuristic.
 *
 * **Since WP-14 this is the fallback spelling, not the primary one.** A list item whose
 * inline tokens were dispatched carries `HARD_RETURN` instead, and `isHardBoundary` tests
 * that first. This regex still guards every `return raw` path out of the `text` override —
 * a body carrying a code sentinel, a token with no inline tokens — where the source
 * spelling is still exactly what arrives.
 */
const HARD_BREAK_TAIL = /(?: {2,}|\\|<br\s*\/?>)$/i;

/**
 * True when the break between two authored lines must be preserved, not coalesced.
 *
 * **Every question here is asked of the visible text — repair 3 of WP-3 of
 * `plans/colour-policy.md`.** All three used to be asked of the raw bytes, and all three
 * answered differently under colour: a line is not blank when it carries `applyStyle`'s
 * newline encasing, and `HARD_BREAK_TAIL` is anchored at end-of-line, where a styled
 * `<br />` leaves a close code (`ESC[39m`) after the tag. Measured on
 * `tests/fixtures/tight-list.md` at width 80: colour-off kept the author's break after
 * `<br />` and colour-on coalesced across it, merging two rendered lines into one. The
 * boundary is a fact about the text the author wrote, so it is decided on the text a
 * reader sees; `HARD_RETURN` is this renderer's own marker and is asked of the raw bytes,
 * where it lives.
 */
function isHardBoundary(before: string, after: string): boolean {
  const visibleBefore = stripAnsi(before);
  if (visibleBefore.trim() === "" || stripAnsi(after).trim() === "") return true;
  if (before.includes(HARD_RETURN) || after.includes(HARD_RETURN)) return true;
  return HARD_BREAK_TAIL.test(visibleBefore);
}

/**
 * Join a tight list item's authored soft-wrapped lines back into one logical line per
 * hard-break-delimited segment.
 *
 * **Why this is safe here and was not safe in WP-2b.** WP-2b could not coalesce because
 * by the time it saw a *loose* item's text, `reflowText` had already rendered its own
 * wraps and the author's hard break as the same bare `\n`, and had hard-split any word
 * longer than the width with no marker — so rejoining destroyed authored breaks and
 * corrupted long URLs and paths. **Nothing reflows a tight item** (`src/AGENTS.md`: "list
 * items are never reflowed"), so every `\n` here is one the author typed, no word has
 * been split, and markdown's own rule — a single newline inside a paragraph is a *soft*
 * break, semantically one space — makes joining with a single space exactly lossless.
 * Verified against the corpus, not assumed: see `HARD_BREAK_TAIL`.
 */
function coalesceTightItemLines(text: string): { segments: string[]; coalesced: boolean } {
  const lines = text.split("\n");
  const segments: string[] = [];
  let current = lines[0] ?? "";
  let coalesced = false;

  for (let i = 1; i < lines.length; i += 1) {
    const before = lines[i - 1] as string;
    const after = lines[i] as string;
    if (isHardBoundary(before, after)) {
      segments.push(current);
      current = after;
      continue;
    }
    const left = current.replace(/\s+$/, "");
    const right = after.replace(/^\s+/, "");
    current = left === "" ? right : right === "" ? left : `${left} ${right}`;
    coalesced = true;
  }
  segments.push(current);
  return { segments, coalesced };
}

/**
 * The one budget the post-compose wrap needs: what a line of *this* level's body may
 * measure right now, before the ancestors above it apply their blanket indents.
 *
 * A line composed at level `depth` will still gain exactly four columns per ancestor
 * list level (their `indentLines`) and four per enclosing blockquote (its `indentify`) —
 * and nothing else: an ancestor's *pad* is added to embedded continuations and then
 * subtracted again by `realignEmbeddedContinuations` (`src/lists.ts`), so it nets to
 * zero and must not be budgeted for. That is why this takes the enclosing blockquotes'
 * columns explicitly (`quoteColumns`, tracked by the `blockquote` renderer below) and
 * **not** the stack's own non-list total: since WP-5 the prefix stack also carries one
 * non-list entry per open *item* (`composeItem`'s exact marker width), and counting
 * those here would narrow this budget by every ancestor item's marker — the
 * double-count its own brief warned about. The `outerColumns()` accessor that used to
 * supply that total had no reader left after this change and was deleted in WP-6.
 */
function currentListBudget(depth: number, targetWidth: number, quoteColumns: number): number {
  return Math.max(1, targetWidth - 4 * (depth - 1) - quoteColumns);
}

// Matches a rendered list line's own leading prefix: the composer's blanket
// indent (plain spaces) optionally followed by a bullet/number marker it emits for
// the item's first line (`"* "` or `"12. "`). Continuation lines have no marker, just
// the indent. Measuring this per line (rather than assuming a fixed width) is what
// makes ordered-list markers — wider than `"* "` — work without special-casing them.
const LIST_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/;

/**
 * Wrap the lines of a composed list body that are still over budget at this nesting
 * level. Lines already within budget are left untouched — that is what makes this
 * idempotent and safe to run on a body that already contains a correctly
 * (tighter-budgeted) wrapped nested sublist.
 *
 * **This is not a repair net any more, and it is not deletable — both halves of that
 * were measured in WP-5.** The plan expected this pass to become a provable no-op once
 * every seam wrapped at the item's exact budget, and for the *coalesced* tight path,
 * the loose `paragraph` path, `heading`, `html` and tables, that is now true: those
 * seams read the exact per-item budget off the prefix stack and nothing they produce
 * is ever over budget here. What the plan's model missed is that an **uncoalesced**
 * tight item — a single authored line, or hard-break segments, which is *most* tight
 * items — was never wrapped by any seam at all: this pass was its primary wrap, not a
 * repair. And it cannot move to the `text` seam: `marked`'s inline lexer hands that
 * seam `&#39;`-spelled entities that `transform` only decodes during composition, so a
 * seam-side wrap measures five columns where the terminal shows one and moves the wrap
 * point of nearly every apostrophe-carrying item (measured on this repo's own plans
 * corpus while building WP-5). This pass sees the decoded bytes; the seam does not.
 * So it stays, with one change: its budget is exact now (see `currentListBudget` — the
 * old non-list-column argument double-counts since `composeItem` pushes per-item
 * entries), and everything it wraps is an uncoalesced item's line or an unbreakable
 * long token, which the identity-substitution gate in WP-5's report enumerates.
 *
 * **Fenced code is never rewritten, including a fence nested in a list item (WP-2f).**
 * A line that starts inside a fence **or** merely carries a sentinel is returned
 * untouched — the stricter of the two walks in this file, because `wrapCode` emits
 * `SENTINEL + firstContentLine` and a one-line fenced block carries its whole content
 * on a line that both opens and closes the pair. Nothing but `wrapCode` ever emits a
 * sentinel, so the stricter form can only ever spare a genuine fence line. An
 * over-budget fence line therefore overflows, inside a recorded `codeRange`, exempt
 * from every width gate — self-consistent rather than a new exemption.
 *
 * **A continuation line this pass creates may not start `*` or `N.`** — a leading `*`
 * on the four-column grid is rewritten into a bullet glyph by `substituteBullets`,
 * which runs after this pass. The guard fires only when the composed continuation
 * would land on the grid: its prefix is the line's own (`"    1. "` is seven columns,
 * off the grid and already safe), and the unconditional form was measured *causing*
 * the collision it defends against — width 55 on `fenced-list.md`, where the guard
 * space itself moved the line from column 7 onto the grid at 8.
 *
 * `sentinel` is a parameter rather than a module constant only because WP-R2 moved this
 * pass out of `src/render.ts`, which is still the module that owns the code-range marker
 * (`wrapCode` emits it, `extractCodeRanges` consumes it). It is the same character, handed
 * down the same way the factory below takes it.
 */
function rewrapListBody(
  body: string,
  depth: number,
  targetWidth: number,
  quoteColumns: number,
  measure: Measure,
  sentinel: string,
): string {
  const budget = currentListBudget(depth, targetWidth, quoteColumns);
  let insideCode = false;
  return body
    .split("\n")
    .map((line) => {
      const startedInsideCode = insideCode;
      let carriesSentinel = false;
      for (const ch of line) {
        if (ch === sentinel) {
          insideCode = !insideCode;
          carriesSentinel = true;
        }
      }
      if (startedInsideCode || carriesSentinel) return line;
      if (measure(line) <= budget) return line;

      const match = LIST_LINE_PREFIX.exec(line);
      const prefix = match ? `${match[1] ?? ""}${match[2] ?? ""}` : "";
      const prefixWidth = measure(prefix);
      const rest = line.slice(prefix.length);
      const continuationPrefix = " ".repeat(prefixWidth);

      const wrapAt = (width: number): string[] => wrapAnsi(rest, Math.max(1, width), measure);
      const onGrid = prefixWidth % LIST_INDENT_PER_LEVEL === 0;
      const collides = (lines: string[]): boolean =>
        onGrid && lines.slice(1).some((l) => marksVisible(MARKER_SHAPED_LINE, l));

      let wrapped = wrapAt(budget - prefixWidth);
      const guarded = collides(wrapped);
      if (guarded) wrapped = wrapAt(budget - prefixWidth - 1);

      return wrapped
        .map((wrappedLine, index) => {
          if (index === 0) return `${prefix}${wrappedLine}`;
          const space = guarded && marksVisible(MARKER_SHAPED_LINE, wrappedLine) ? " " : "";
          return `${continuationPrefix}${space}${wrappedLine}`;
        })
        .join("\n");
    })
    .join("\n");
}

/**
 * The five methods this seam supplies, in the exact shape `WalkRendererMethods`
 * (`src/walk.ts`) declares them — so `renderDocumentDetailed` assigns them straight onto
 * the renderer object with no adaptation.
 */
export interface ListTextLayout {
  list(this: RendererHost, token: Tokens.List): string;
  text(this: RendererHost, token: Tokens.Text | Tokens.Escape | Tokens.Tag): string;
  paragraph(this: RendererHost, token: Tokens.Paragraph): string;
  heading(this: RendererHost, token: Tokens.Heading): string;
  blockquote(this: RendererHost, token: Tokens.Blockquote): string;
}

/**
 * Build the layout state machine for one render.
 *
 * Called once per `renderDocumentDetailed` invocation, immediately after the
 * `LayoutContext` it closes over. `sentinel` is the code-range marker — `src/render.ts`
 * owns it, because `wrapCode` and `extractCodeRanges` are its two passes, so it is handed
 * down rather than imported back out of the module that imports this one.
 */
export function createListTextLayout(layout: LayoutContext, sentinel: string): ListTextLayout {
  // The context's own three values, under the names every body below already used. They
  // are the same values `renderDocumentDetailed` was handed: `layout.width` is
  // `targetWidth`, and `glyphs`/`measure` are threaded, never detected here.
  const { width: targetWidth, glyphs, measure } = layout;
  // The code-range sentinel under its usual spelling, so the guards below read as they did.
  const SENTINEL = sentinel;

  // Columns that block renderers still owe every line of whatever is being rendered
  // *right now*, because they are glued on only after that inner render returns: a
  // list level's own marker plus its blanket indent, a blockquote's indent. Each
  // block renderer pushes its own contribution for the duration of its call, so at
  // any point inside, the sum is exactly how much narrower than `targetWidth` the
  // text being produced has to be. This is what lets the `paragraph` renderer wrap a
  // *loose* list item once, at the width the item will actually occupy — see its
  // comment below.
  //
  // The stack itself lives on the `LayoutContext` (`src/layout-context.ts`), which is
  // what makes it reachable from a visitor that is not a closure declared inside
  // `renderDocumentDetailed` — the whole point of the seam. These names stay as local
  // aliases so that every call site below reads exactly as it did before WP-R2 moved
  // them here; `src/render.ts` keeps its own `pendingPrefixWidth` alias for the two
  // visitors (`table`, `html`) that stayed behind.
  const pendingPrefix = layout.prefix;
  const pendingPrefixWidth = (): number => layout.prefix.width();
  const listDepth = (): number => layout.prefix.listDepth();

  // Non-zero while a renderer that dispatches *inline* tokens is on the stack. Only
  // `paragraph` and `heading` do so anywhere a list can reach (`table` is replaced
  // wholesale by `renderTable`, which never calls `parseInline`; `blockquote`'s
  // children are blocks). This is one of the three conditions that tell a *tight list
  // item's own block text token* apart from an ordinary inline text token — see the
  // `text` override below.
  //
  // All three of its writers are in this module, and that is the point of the module
  // having a boundary at all: a counter mutated from two files is a counter nothing can
  // prove balances.
  let inlineDepth = 0;

  // Columns of enclosing blockquote indent, tracked here because `rewrapListBody`'s
  // budget needs *quote* columns alone and the prefix stack cannot give them to it any
  // more: since WP-5 its non-list entries are a mix of blockquote indents and
  // `composeItem`'s per-item marker widths, and the pass must not budget for the
  // latter (see `currentListBudget`). The `blockquote` renderer below keeps this in
  // step with its own push/pop, in the same try/finally.
  let quoteColumns = 0;

  // **The owned list composer** (WP-4 of `plans/marked-terminal-replacement.md`;
  // layout owned in WP-5). `src/lists.ts` owns `list`, `listitem` and `checkbox`;
  // nothing here delegates to `marked-terminal` any more. `parse` is handed in as a
  // closure over `this` for the same reason the inline visitors' `parseInline` is: it
  // is the *parser's* recursion, per call, and belongs to `marked` rather than to the
  // layout context.
  //
  // Since WP-5 composition owns the whole layout of the body it returns: the pad, the
  // per-level de-drift that used to be `realignNestedContinuations` here (now
  // `realignEmbeddedContinuations`, `src/lists.ts`, run inside `renderList` after
  // `fixNestedLists`), and the marker/fence-line claims, decided on ANSI-stripped
  // bytes so the coloured and colourless renders agree (family C1). The level pushes
  // only its own 4-column blanket indent; the exact width of each item's marker is
  // pushed per item by `composeItem`, which is what lets `paragraph`/`text`/`heading`
  // wrap at the item's true budget (families B1/B2) and is why the `rewrapListBody`
  // repair pass that used to run here could be deleted (proven a no-op first — see
  // this WP's report).
  function ownedList(this: RendererHost, token: Tokens.List): string {
    pendingPrefix.push({ columns: LIST_INDENT_PER_LEVEL, list: true });
    const depth = listDepth();
    try {
      const result = renderList(
        layout,
        token,
        (tokens: Token[], top: boolean) => this.parser.parse(tokens, top),
        SENTINEL,
      );
      // The post-compose wrap — the primary wrap for *uncoalesced* tight items, and
      // provably idle for everything else now that every seam reads the exact
      // per-item budget; see `rewrapListBody`'s comment for why it cannot move into
      // the `text` seam (entity decoding happens between the two).
      const rewrapped = rewrapListBody(result, depth, targetWidth, quoteColumns, measure, SENTINEL);
      // Bullet substitution runs once this is the outermost call for this top-level
      // list (`depth === 1`) — see `src/lists.ts`'s header for the two measurements
      // that keep it a separate pass rather than folding it into composition.
      return depth === 1 ? substituteBullets(rewrapped, glyphs, SENTINEL) : rewrapped;
    } finally {
      pendingPrefix.pop();
    }
  }

  // **Inside a tight list item, `text` is where that item's text gets wrapped**
  // (WP-2c). `marked`'s lexer only wraps an item in a paragraph token when the list is
  // *loose*; a **tight** item's tokens go straight to `Parser.parse(item.tokens,
  // false)`, whose block `text` case dispatches here. `marked-terminal`'s own `text`
  // (`index.js:84-89`) returns the raw `token.text`, so the author's own line breaks
  // arrive verbatim — nothing has reflowed them — and `rewrapListBody` then splits
  // each authored line that the 6 columns of marker and indent push over the target,
  // shearing its tail word onto a line of its own. That tail is the orphan: 1,823 of
  // them across 250 files at width 100 in a 1,744-file corpus sample.
  //
  // **WP-14 added a second job to the same seam** — parsing that raw source, which the
  // library never did — and the two are sequential, not alternatives: parse first, then
  // coalesce and re-wrap the parsed text. The three conditions below still select
  // exactly the same tokens; only what happens to the ones they select changed. Soft
  // breaks still arrive verbatim afterwards, because a soft newline stays inside the
  // inline text token that carries it.
  //
  // Three independent conditions identify a tight item's own text, and any one of
  // them failing means we leave the result exactly as the library produced it:
  //
  // 1. `listDepth() > 0` — we are inside a list;
  // 2. `inlineDepth === 0` — we are not inside something that dispatches inline
  //    tokens, so this is a *block* position;
  // 3. the token carries `tokens` — block text tokens do, inline ones do not.
  //
  // Condition 3 is load-bearing, not decorative: over 600 corpus files this seam saw
  // 11,443 tight-item block text tokens **and 413 inline text tokens inside lists, 242
  // of them multi-line** (a loose item's source lines, before `reflowText` runs). The
  // multi-line inline ones are exactly WP-2b's forbidden case — coalescing them is the
  // thing that corrupts URLs — and only `tokens` separates them from ours.
  //
  // Fenced code, tables and nested lists are safe **by construction, not by
  // inspection**: each is its own token type and never reaches a `text` call. Measured
  // to confirm: 0 of those 11,443 tokens contained a `SENTINEL`.
  //
  // **WP-2 replaced the inner call only.** What used to be `originalText.call(this,
  // token)` — the library's `text`, which per `index.js:84-89` is `token.text` returned
  // through an `identity` option and nothing else — is now `renderInlineText(token)`.
  // Everything around it, including the three conditions, `inlineDepth`, both sentinel
  // guards and the coalesce/re-wrap, is unchanged and out of that package's scope.
  function wrappedText(this: RendererHost, token: Tokens.Text | Tokens.Escape | Tokens.Tag): string {
    // The library's `text` was typed `string | false` and this seam guarded for both;
    // the owned one returns `token.text`, which every token `parseInline` and the block
    // `text` case dispatch here carries, so the guard has nothing left to catch.
    const raw = renderInlineText(token);
    if (listDepth() === 0 || inlineDepth > 0) return raw;
    const inlineTokens = (token as { tokens?: Token[] }).tokens;
    if (!Array.isArray(inlineTokens)) return raw;
    // Belt and braces on the "fences never reach here" measurement above: a body
    // carrying a code sentinel is returned untouched rather than reasoned about.
    if (raw.includes(SENTINEL)) return raw;

    // **This is where a list item's inline markup gets parsed at all** (WP-14).
    //
    // `raw` is `marked-terminal`'s own answer, and its own answer is the markdown
    // *source*: `Renderer.prototype.text` (`index.js:84-89`) reads `token.text` and
    // returns it through `this.o.text`, which is `identity` (`index.js:47`). It never
    // dispatches `token.tokens`. Its `heading` (`:116-119`), `paragraph` (`:201-211`),
    // `tablecell` (`:260-265`) and — transitively, through `parser.parse` —
    // `blockquote` (`:102-107`) all call `parser.parseInline(token.tokens)` instead,
    // which is exactly why `**bold**` and `[label](url)` reach the terminal parsed
    // everywhere *except* a list item, and why a blockquote nested *inside* a list
    // item is fine while the item's own text is not.
    //
    // **Both a tight and a loose item route here, and WP-2 of
    // `plans/own-the-token-walk.md` restored the description WP-13 removed.**
    //
    // The record has now been written twice in each direction, so here is the measurement
    // rather than another assertion. WP-14's original comment said a loose item's children
    // reach the block `text` case with `top === true` and are wrapped in a **synthesised**
    // paragraph whose text token has no `tokens`. WP-13 called that "not what `marked`
    // does" and replaced it with "the block tokenizer gives a tight item `text` children
    // and a loose item `paragraph` children". **WP-13's correction is the wrong one**, and
    // owning the walk (`src/walk.ts`) is what made it checkable: `Tokenizer.prototype.list`
    // (`marked.cjs:550-561`) lexes every item body with `state.top = false` and then only
    // *stamps* `loose` — it never re-lexes — so `- one\n\n- two\n` yields `loose = true`
    // with `items[n].tokens` of `["text"]`, not `["paragraph"]`. Pinned in
    // `tests/walk.test.ts`.
    //
    // What decides the path is the **`top` argument**, not the child token type.
    // `src/lists.ts` dispatches every item through `parse(item.tokens, !!item.loose)`:
    //
    // - **tight** (`top === false`) — the block `text` case emits the rendered body raw,
    //   and this seam is the only thing that parses it. One dispatch:
    //   `text(hasTokens=true)`.
    // - **loose** (`top === true`) — the same block `text` token arrives here first and
    //   *is* parsed here, and its result is then wrapped in the synthesised paragraph, so
    //   `paragraph` runs too. Three dispatches: `text(hasTokens=true)` →
    //   `paragraph(tokens=["text"])` → `text(hasTokens=false)`.
    //
    // **Condition 3 is what keeps the loose path from double-parsing**, and it is the
    // synthesised token that makes it work: the paragraph's inner text token is
    // `{type, raw, text}` with **no `tokens` key** (`src/walk.ts`, block `text` case), so
    // the second visit takes the `raw` return above and passes the already-rendered body
    // through verbatim. `src/walk.ts` reproduces that token shape byte-for-byte for
    // exactly this reason; adding an empty `tokens` array to it would re-parse every loose
    // item in the corpus.
    //
    // **Loose items were never broken**, and that part of the record stands: at the
    // library baseline a tight item rendered `**b**` verbatim and a loose one rendered it
    // bold, because the loose path reached `paragraph` and `paragraph` called
    // `parseInline`. The seam still fixes tight items of every marker kind — unordered,
    // ordered, task — plus every nested item whose own list is tight, at any depth.
    //
    // `inlineDepth` is raised for the duration, upholding this seam's own condition 2
    // for the recursive calls `parseInline` makes: the text tokens inside `strong`,
    // `em`, `link` and `del` come back through here, and they must take the library
    // path. They also carry no `tokens`, so condition 3 already stops them — the
    // counter is the documented invariant, held rather than relied on twice.
    inlineDepth += 1;
    let parsed: string;
    try {
      parsed = this.parser.parseInline(inlineTokens);
    } finally {
      inlineDepth -= 1;
    }
    if (typeof parsed !== "string" || parsed.includes(SENTINEL)) return raw;

    // Now that inline tokens *are* dispatched, `br` fires, and with `reflowText` on it
    // emits `HARD_RETURN` rather than a newline (`index.js:291-293`) — a marker
    // `reflowText` later turns back into a line break for the three block renderers
    // that reflow. **Nothing reflows a list item**, so this seam owes that conversion
    // itself, or an authored hard break arrives as a bare `\r` that walks the cursor
    // back to column 0. It is spelled as `HARD_RETURN` *plus* the newline so the
    // marker survives into `coalesceTightItemLines`, whose `isHardBoundary` already
    // refuses to join across one (see `HARD_RETURN`'s comment, which named this case
    // as "rare is not never" while `marked-terminal`'s raw-text path still made it
    // unreachable). `settle` drops the markers on the way out, on every return path.
    //
    // This replaces `HARD_BREAK_TAIL` as the mechanism for list items, and does not
    // retire it: that regex reads the *source spelling* of a hard break, which is
    // still what an unparsed body carries on the `raw` returns above.
    const result = parsed.split(HARD_RETURN).join(`${HARD_RETURN}\n`);
    const settle = (text: string): string => text.split(HARD_RETURN).join("");

    const { segments, coalesced } = result.includes("\n")
      ? coalesceTightItemLines(result)
      : { segments: [result], coalesced: false };
    // Nothing was joined — the item is a single line, or every break in it is a
    // genuine hard break. Leave it unwrapped: `rewrapListBody` wraps these lines
    // after composition, and that division of labour is deliberate (WP-5 measured
    // the alternative). `marked`'s inline lexer escapes `'`, `"`, `&`, `<` and `>`
    // as HTML entities in the text this seam sees, and `transform` (`src/blocks.ts`)
    // only decodes them *after* composition — so a wrap decided here measures
    // `&#39;` at five columns where the terminal will show one, and moves the wrap
    // point of nearly every tight item that contains an apostrophe. The composed
    // body the post-compose wrap sees is already decoded, so its measurements are
    // the terminal's. (The coalesced path below accepts that skew deliberately —
    // it always has, its bytes are pinned by the parity gate, and re-ordering it
    // would move every soft-wrapped item in the corpus.)
    if (!coalesced) return settle(result);

    const budget = Math.max(1, targetWidth - pendingPrefixWidth());
    // `segments` carry live ANSI whenever the resolved policy says colour, so the
    // re-wrap has to be the ANSI-aware one — which it already was: `wrapAnsi` segments
    // escape sequences out as atomic zero-width units and `measure` is `string-width`,
    // which strips them before counting. That path was built for exactly this content
    // (see `src/wrap.ts`'s module comment, which names list items carrying live ANSI as
    // its reason to exist).
    //
    // **What a wiki-link contributes to this seam has changed twice, and it is now the
    // ordinary case rather than a special one.** It was `styleWikiLink`'s hard-coded
    // escapes; WP-4 of `plans/colour-policy.md` made it a pair of carrier control
    // characters (code points 2/3), zero columns to `Measure` and *text* to
    // `src/ansi.ts`'s scanner; and WP-2 of `plans/wiki-link-tokenizer.md` retired those
    // too. A wiki label reaching this seam is now an ordinary styled span — SGR when the
    // policy says so, nothing when it does not — indistinguishable here from a `strong` or
    // a `link`, and handled by the same segmentation that already existed for them. The
    // colourless wrap is unmoved either way, since the label's visible text is what it
    // always was.
    const wrapAt = (width: number): string =>
      segments.map((segment) => wrapAnsi(segment, Math.max(1, width), measure).join("\n")).join("\n");

    const wrapped = wrapAt(budget);
    // Same landmine, same guard as the `paragraph` renderer — see `MARKER_SHAPED_LINE`.
    // Every line after the first is still at column 0 when `bulletPointLines` /
    // `numberedLines` run, so one that *starts* `*` or `12.` is taken for a marker
    // line and, in an ordered list, is handed that item's number and rewritten.
    const collides = (text: string): boolean =>
      text.split("\n").slice(1).some((line) => marksVisible(MARKER_SHAPED_LINE, line));
    if (!collides(wrapped)) return settle(wrapped);

    // **The guard is as many spaces as it takes to land *off* the four-column grid, and
    // it is only widened where the one-space form is provably wrong** — WP-1 of
    // `plans/renderer-deferred-work.md`. It was one space, unconditionally, until then (the
    // coalesced path's own pre-WP-5 rule, kept byte-for-byte because changing it was
    // outside that package's scope), and the unconditional single space *caused* the
    // collision it exists to prevent:
    //
    // A one-digit ordered item composes at 4 columns of level indent plus a 3-column
    // `"1. "` marker, so its continuations sit at column **7** — off the grid, already
    // safe from `substituteBullets`. At width 65 the one guard space moved a continuation
    // that began with the author's literal `*` to column **8**, exactly on the grid, where
    // `substituteBullets` (`src/lists.ts`, `UNORDERED_MARKER_LINE` `/^((?: {4})+)\*(\s)/`)
    // claimed it and rewrote the `*` into the depth's bullet glyph — **a nested list item
    // nobody wrote**. Widths 64 and 66 were clean; the witness is
    // `tests/fixtures/coalesced-guard-collision.md`. No gate in this repo could see it:
    // `findContinuationOverIndent`'s drift-1 exemption forgives *guard-shaped* lines and
    // `"◦ "` is guard-shaped (recorded as a blind spot in `scripts/AGENTS.md`).
    //
    // **This path cannot borrow `rewrapListBody`'s `onGrid` gate, and that asymmetry is
    // the finding.** There, the gate is right: its lines are already composed, carrying
    // their prefix as literal spaces, so an off-grid marker-shaped continuation is claimed
    // by nothing and needs no guard. Here the lines are *pre*-composition, still at column
    // 0, and `claimLine`/`isPointedLine` (`src/lists.ts`) is grid-blind — it claims a
    // column-0 `*` line whatever column the item will end up at, strips it of its pad and
    // leaves it at the level's own indent, where `substituteBullets` rewrites it anyway.
    // Gating this guard on `onGrid` was measured turning one corrupted width (65) into two
    // (64 *and* 65) on the same witness. So the guard must always fire; only its *width*
    // is a free variable, and it is chosen so the composed column misses the grid.
    //
    // `pendingPrefixWidth()` is the item's true text column here — the level's blanket
    // indent, this item's own marker width (pushed per item by `composeItem`) and any
    // enclosing blockquote columns, every one of which renders as literal spaces — so a
    // guarded line lands at exactly `pendingPrefixWidth() + guard.length`. One space misses
    // the grid for every marker this composer emits (`"* "` → 6+1, `"12. "` → 8+1) except
    // the one-digit ordered marker (`"1. "` → 7+1); one space is also the *only* landing
    // that costs a single column, so the wider guard is reached for last, not first.
    //
    // **The three conditions below are the whole of the repair, and none is decorative.**
    // The seam already re-wraps one column narrower before guarding, and that re-wrap
    // usually moves the break so that no continuation begins with the marker token at all —
    // nothing is prepended and this path is byte-identical to the parent commit whatever
    // the item's column. The wider guard is reached only when **all three** hold: the one
    // space would land on the grid; a marker-shaped continuation survives the narrower
    // wrap; and one of the survivors is `*`-shaped. Then the seam narrows one column
    // further — which again usually dissolves the collision outright, drift 0, and is why
    // width 65 now renders the same shape as width 64 — and prepends two spaces to whatever
    // still starts with a marker token.
    //
    // **The third condition is `REWRITABLE_MARKER_LINE`, not `MARKER_SHAPED_LINE`, and the
    // difference is the whole of the blast radius.** The collision being repaired is
    // `substituteBullets`' `UNORDERED_MARKER_LINE` — `/^((?: {4})+)\*(\s)/` — which needs a
    // literal `*` **followed by whitespace**. Two populations `MARKER_SHAPED_LINE` claims are
    // therefore not rewritten by anything after composition and must keep their bytes:
    //
    // - a `12.`-shaped continuation, because `composeOrdered` renumbers position 0 alone and
    //   `fixNestedLists`' `POINT_REGEX` needs a non-space *before* the indent, which a guarded
    //   line never has; and
    // - a line whose `*` is glued to its next character — `*#COLON|*root`, the escaped-colon
    //   spelling `undoColon` decodes during composition, is the common one in this corpus.
    //   `UNORDERED_MARKER_LINE` cannot match it, so the one space was always right for it.
    //
    // **Every step of the narrowing was priced, not assumed** — private corpus, `--widths
    // 65,100 --tiers unicode --ambiguous narrow`, 8,846 combos. Firing the wider form on
    // column alone, without asking whether anything survived: **116 combos moved, three
    // detector counts rose** (`overIndent` +20 at 65, +8 at 100; `orphans` +1). On survival
    // but not on shape: 101 combos, two counts rose. On `startsWith("*")` rather than the
    // rewritable shape: 52 combos and a clean 2-axis probe, but a 41-file hot set replayed at
    // 15 widths × both tiers still moved `overIndent` by +1 at 12 of 30 axes — the glued-`*`
    // population above, widened for nothing. The form below is the smallest that repairs the
    // defect. Widening the *narrowing* instead of the guard is not an escape: extending the
    // re-wrap search to `budget - 8` still left 29 items unresolved and cost up to eight
    // columns of an item's width to get there.
    const guardLandsOnGrid = (pendingPrefixWidth() + 1) % LIST_INDENT_PER_LEVEL === 0;
    const rewritable = (text: string): boolean =>
      text
        .split("\n")
        .slice(1)
        .some((line) => marksVisible(REWRITABLE_MARKER_LINE, line));
    const guarded = (text: string, guard: string): string =>
      text
        .split("\n")
        .map((line, index) => (index > 0 && marksVisible(MARKER_SHAPED_LINE, line) ? `${guard}${line}` : line))
        .join("\n");

    const narrowed = wrapAt(budget - 1);
    if (!guardLandsOnGrid || !rewritable(narrowed)) return settle(guarded(narrowed, " "));
    return settle(guarded(wrapAt(budget - 2), "  "));
  }

  // **`paragraph`, `heading` and `blockquote` — the three that reflowed** (WP-3).
  //
  // What used to be here, and what it cost: `marked-terminal` takes its width only at
  // construction (`this.o` is an `Object.assign` snapshot, `index.js:58`, and `width` is
  // read at `:128`, `:136` and `:208` and written nowhere), so rendering a loose list
  // item's paragraph or a blockquoted heading four columns narrower meant constructing an
  // **entire second library instance** and caching it by budget — `budgetedParagraphs`
  // and `budgetedHeadings`, three instances per render — and then running a
  // `wrapOverBudgetLines` net over the result anyway, because the library's own reflow
  // measured in UTF-16 code units. `blockquote` additionally had to measure the first-line
  // indent the library's `quote.trim()` was about to eat and paste it back afterwards.
  //
  // All of that is gone. An owned renderer takes the budget as a parameter and measures
  // through `ctx.measure`, so there is nothing to repair: the caches, the net,
  // `firstLineIndentTrimmedAway` and `restoreFirstLineIndent` were five mechanisms for one
  // problem that no longer exists.
  //
  // `inlineDepth` still bracket each of the two that dispatch inline tokens, exactly as
  // before and for a reason that has nothing to do with width: it is condition 2 of the
  // tight-list-item test in the `text` override above, and dropping it would silently
  // change list-item rendering.
  function ownedParagraph(this: RendererHost, token: Tokens.Paragraph): string {
    // A paragraph dispatches inline tokens, so anything reaching the `text` override from
    // inside this call is an *inline* text token, never a tight list item's own body.
    inlineDepth += 1;
    try {
      const budget = Math.max(1, targetWidth - pendingPrefixWidth());
      const parseInline = (tokens: Token[]): string => this.parser.parseInline(tokens);
      const result = renderBlockParagraph(layout, token, parseInline, budget);
      // **The `marked-terminal` list landmine, and the one correction pass this package
      // deliberately keeps** — see `MARKER_SHAPED_LINE`. A wrapped continuation line that
      // merely *begins* `*` or `12.` is taken for a marker by `isPointedLine`, and in an
      // ordered list `numberedLine` then consumes that item's number and rewrites the
      // line. This defends against a defect in a renderer WP-4 owns; removing it here
      // would land its consequences in someone else's parity diff.
      //
      // **Two shapes, not one** (WP-3). The second is `COLUMN_ZERO_MARKER`, the
      // detectors' own broader bullet set, and it was added because the harness's new
      // detector ratchet caught this package raising `findColumnZeroMarkers` by exactly
      // one: a top-level prose line that happened to re-wrap onto `+ sources`,
      // immediately above an indented list. `isPointedLine` does not recognise `+`, so
      // that line was never a renumbering hazard — it was simply a line that reads as a
      // bullet nobody wrote, which is precisely what that detector is for.
      //
      // **And it runs at every budget now, where it used to run only inside a list or a
      // blockquote.** That asymmetry was an artefact rather than a decision: the old
      // override took an early return on `pendingPrefixWidth() === 0` and the guard sat
      // below it, so a top-level paragraph never got one. The regression above was a
      // top-level paragraph, so a guard that skips them cannot close it. At column 0 the
      // renumbering half of the hazard genuinely does not apply — no list is on the stack
      // — but the legibility half does, and the cost is one paragraph re-wrapped a column
      // narrower.
      const marker = (line: string): boolean => isGuardShapedLine(stripAnsi(line));
      const collides = (text: string): boolean => text.split("\n").slice(1).some(marker);
      if (!collides(result)) return result;

      // Re-wrap a column narrower to make room, then give each colliding continuation
      // line the guard space, which `isPointedLine`'s exact-multiple-of-four indent
      // group cannot match. Unchanged from the pre-WP-3 remedy, deliberately: re-wrapping
      // progressively narrower until no line starts marker-shaped was tried here and
      // rejected — it did not close the detector regression it was aimed at (see this
      // package's report), it costs an extra full paragraph render per attempt, and it
      // defeats `tests/render-lists-guards.test.ts`'s own guard fixture by avoiding the
      // situation the fixture exists to reproduce.
      return renderBlockParagraph(layout, token, parseInline, Math.max(1, budget - 1))
        .split("\n")
        .map((line, index) => (index > 0 && marker(line) ? ` ${line}` : line))
        .join("\n");
    } finally {
      inlineDepth -= 1;
    }
  }

  function ownedHeading(this: RendererHost, token: Tokens.Heading): string {
    // Like `paragraph`, a heading dispatches inline tokens — see the `text` override. A
    // heading is reachable inside a list item and inside a blockquote, which is the whole
    // reason it needs a budget rather than the target width.
    inlineDepth += 1;
    try {
      const budget = Math.max(1, targetWidth - pendingPrefixWidth());
      return renderBlockHeading(layout, token, (tokens: Token[]) => this.parser.parseInline(tokens), budget);
    } finally {
      inlineDepth -= 1;
    }
  }

  function ownedBlockquote(this: RendererHost, token: Tokens.Blockquote): string {
    // A blockquote indents its rendered body by four columns *after* its children have
    // rendered, so anything rendered inside it owes those columns too — pushed here for
    // the duration of the children's render, which is what makes a quoted paragraph,
    // heading or list wrap at the width it will actually occupy rather than at the full
    // target and then need repairing.
    pendingPrefix.push({ columns: BLOCKQUOTE_INDENT_PER_LEVEL, list: false });
    quoteColumns += BLOCKQUOTE_INDENT_PER_LEVEL;
    let body: string;
    try {
      body = this.parser.parse(token.tokens);
    } finally {
      quoteColumns -= BLOCKQUOTE_INDENT_PER_LEVEL;
      pendingPrefix.pop();
    }
    return renderBlockquote(layout, body);
  }

  return {
    list: ownedList,
    text: wrappedText,
    paragraph: ownedParagraph,
    heading: ownedHeading,
    blockquote: ownedBlockquote,
  };
}
