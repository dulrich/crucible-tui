import { Marked } from "marked";
import type { MarkedExtension, Token, Tokens } from "marked";
import { renderTable } from "./table";
import {
  renderBlockquote,
  renderCode as renderBlockCode,
  renderHeading as renderBlockHeading,
  renderHr as renderBlockHr,
  renderHtml as renderBlockHtml,
  renderParagraph as renderBlockParagraph,
} from "./blocks";
import { formatMetaBlockDetailed, splitFrontmatter } from "./frontmatter";
import { wrapAnsi } from "./wrap";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
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
} from "./inline";
import { resolveFenceLanguage, type FenceLanguageResolver } from "./lang";
import { createLayoutContext } from "./layout-context";
import { MARKER_SHAPED_LINE, REWRITABLE_MARKER_LINE, isGuardShapedLine } from "./list-lines";
import { TASK_GLYPHS, renderList, substituteBullets } from "./lists";
import { NARROW_MEASURE, type Measure } from "./width";

// Obsidian wiki-links aren't markdown; style them before parsing so they render as
// recognizable links-to-nowhere instead of literal brackets. This regex is deliberately
// the same one an in-house web markdown renderer already uses against the same corpus —
// same pattern, ANSI output instead of an HTML <span>. Two documents rendered by two
// tools must decide what a wiki-link *is* the same way, or they disagree about the same
// note. The one addition here is a leading optional `!` group (see `styleWikiLink`'s
// call site in `preprocessBody`) to catch Obsidian's `![[embed]]` syntax, which that
// renderer's pattern does not recognize at all.
const WIKI_LINK = /(!)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

// Obsidian's custom checkbox states aren't GFM tasklist syntax — marked's tasklist
// extension only recognizes " ", "x", "X". Line pattern and state table are kept
// aligned with the same web renderer for the same reason, mapping to terminal glyphs
// instead of icon markers (there is no DOM here to mount SVGs into).
//
// **The table moved to `src/lists.ts` in WP-4 and is imported back.** `renderTaskState`
// there renders the two positions this line-anchored regex cannot reach — a task item in a
// blockquote, and one in an ordered list — and the two must agree about what each state
// looks like. One table, imported one way: `render.ts` already depends on `lists.ts`, and
// `lists.ts` depends on nothing here.
const TASK_STATE_LINE = /^(\s*[-*+]\s+)\[(.)\](\s)/;

// Line-by-line pre-pass with a fence toggle, so neither rewrite runs inside a fenced
// code block. Borrowed from the same renderer, which guards only its *task-state* pass
// this way and records in its own source that the wiki-link pass has the same latent
// gap. This tool closes that gap for both passes, since the corpus commonly quotes
// `[[slug]]` inside fenced example commands.
const FENCE_LINE = /^\s*(```|~~~)/;


function styleWikiLink(label: string): string {
  // cyan + underline, per the plan's suggestion (plans/mdview.md WP-2).
  return `\x1b[36m\x1b[4m${label}\x1b[24m\x1b[39m`;
}

// GFM's own tasklist recognition (`istask = /^\[[ xX]\] /`, marked.cjs:524) only ever
// matches these three characters. Every other Obsidian custom state (`/`, `-`, `>`,
// `<`, `?`, `!`, `*`, `"`, and the rest of `TASK_GLYPHS`'s keys) is invisible to it.
const GFM_RECOGNIZED_CHARS = new Set([" ", "x", "X"]);

// A second sentinel, distinct from the code-range `SENTINEL` (code point 0, declared
// below) — deliberately a different code point (1) so the two mechanisms stay visibly
// separate and a bug in one strip pass can never interact with the other's
// line-counting walk (`extractCodeRanges` only treats code point 0 specially; this
// character passes through that walk as ordinary text and is stripped in its own pass
// afterward — see `renderDocumentDetailed`).
//
// REVISION, caught in review: the first version of this fix used a zero-width space
// (U+200B) instead of a control-character sentinel. That was wrong for the tier it
// shipped in — `string-width` measuring U+200B as 0 columns is a statement about this
// tool's own width *accounting*, not about what an ASCII-only terminal actually does
// with an unrecognized multi-byte UTF-8 sequence (mojibake / replacement glyphs on
// exactly the terminals the ASCII tier exists for: `LC_ALL=C`, `TERM=linux`/`vt100`/
// `dumb`). The ASCII tier's whole contract is "no Unicode in the output"; leaving
// U+200B in the rendered text broke that contract silently, since every gate here
// checks display *width*, not code points. A sentinel that gets stripped before the
// text ever reaches the terminal — the same idiom `SENTINEL` already uses for code
// ranges — has no such failure mode: nothing invisible-but-present ever ships.
const TASK_STATE_SENTINEL = String.fromCharCode(1);

// Same rationale as `stripSentinelChar` below: this control character has no
// legitimate place in markdown source, so stripping it unconditionally prevents a
// hostile or odd document from smuggling one in and forging a fake defeated-task-regex
// marker of its own.
function stripTaskStateSentinel(text: string): string {
  return text.split(TASK_STATE_SENTINEL).join("");
}

// Per the plan's locked decision: the ASCII tier leaves task states literal
// (`- [x] done` stays `- [x] done`) rather than inventing ASCII substitutes.
//
// Deviation from the brief, found empirically. The brief specifies this as
// "`rewriteTaskState` returns the line unmodified," which is correct and sufficient
// for every Obsidian custom state — those never match GFM's tasklist regex, so
// `marked`'s lexer never treats them as a task item and they reach the final render as
// plain, untouched text. But for the three characters GFM itself recognizes (` `, `x`,
// `X`), returning the line genuinely unmodified is NOT enough: `marked`'s lexer still
// detects `- [x] `/`- [ ] ` as a real task item from the raw text alone, and when it
// does, `marked-terminal`'s `listitem` (`index.js:159-181`) discards the literal
// `[x]`/`[ ]` from the item's own tokens and reconstructs it via
// `Renderer.prototype.checkbox` (`index.js:194`: `'[' + (checked ? 'X' : ' ') + '] '`)
// instead — always uppercase `X`, and, combined with the extra `' '` `listitem`
// appends after it, always exactly *two* spaces before the item text. Verified:
// rendering `- [x] done` with a genuinely-unmodified line produces `[X]  done`
// (uppercase, double space), not the literal `- [x] done` the plan requires.
//
// `checkbox` looked like the natural override seam, but it is not reachable: every
// `marked-terminal` renderer method is a thin wrapper — `markedTerminal()`'s
// `funcs.reduce` (`index.js:390-400`) makes each `extension.renderer[fn]` call
// `r[fn](...)` on one shared *internal* `Renderer` instance `r`, not on `this`. Marked
// itself dispatches the top-level block methods (`table`/`list`/`hr`/`code`/`html`/
// `paragraph`/`heading`/`blockquote`) directly against `extension.renderer`, which is
// why overriding those works — but `list()`'s own internal `this.listitem(...)` call
// (and `listitem()`'s own `this.checkbox(...)` call) both run with `this === r`, so
// they always resolve to `r`'s original, un-overridden prototype methods regardless of
// what we assign onto `extension.renderer.checkbox`. Same dead seam as `listitem`,
// documented above `rewrapListBody`, just one level deeper.
//
// Backslash-escaping the brackets (`\[x\]`) was also tried and also fails, for a
// different reason: it does defeat the lexer's task regex, but `marked-terminal`'s own
// `Renderer.prototype.text` (`index.js:84-89`) renders a list item's plain-text token
// via its raw `token.text` field directly — it never calls `parseInline`/consults
// `token.tokens`, so the inline "escape" token that would normally turn `\[` back into
// `[` never runs. The backslashes survive into the final output verbatim.
//
// The fix that actually works: insert `TASK_STATE_SENTINEL` between the `[` and the
// state character, defeating the lexer's adjacency requirement, then strip that
// sentinel out of the fully-rendered document (`renderDocumentDetailed`) before
// returning it — so the shipped output is byte-identical to the literal source text,
// not merely display-equivalent to it.
// **WP-6 measured this pass's remaining effect and did not delete it.** The plan slated it
// for deletion in WP-4; WP-4 withdrew that and recorded "211 such lines across 11 of 4,786
// corpus files". Re-measured against the validation corpus as it stands, at all twenty
// default axes, by substituting this function with the identity and diffing:
//
//   - **5,619 task-shaped source lines in 297 of 4,837 files** are rewritten here;
//   - **the rendered output of only 5 files changes** if the pass is removed, because
//     `src/lists.ts`'s owned `checkbox`/`renderTaskState` (WP-4) now produces byte-identical
//     output for every task item `marked` actually tokenizes as one;
//   - **2 of those 5 change bytes inside a recorded `codeRange`** — 84 distinct lines in
//     indented code blocks, which `preprocessBody`'s fence toggle cannot see because it
//     only tracks ` ``` ` lines. Not rewriting them is a *repair*, and is still parity class
//     C, which no package may produce without a granted exception;
//   - **the other 3 change prose**, and all three trace to a single authored `[/]`. GFM's
//     tasklist regex only ever matches ` `, `x` and `X` (`GFM_RECOGNIZED_CHARS` above), so
//     every other Obsidian custom state is invisible to the lexer and this pass is the
//     *only* thing that renders one as a glyph. Deleting it would not be a cleanup; it
//     would remove custom task-state rendering from the tool.
//
// So this stays, and the honest narrowing — teaching it about indented code blocks so the
// 84 lines stop being rewritten — is the class-C-flagged repair a later package should
// carry, not a side effect of a dependency removal. See this WP's report.
function rewriteTaskState(line: string, glyphs: GlyphSet): string {
  const match = TASK_STATE_LINE.exec(line);
  if (!match) return line;

  const [full, prefix, char, gap] = match;
  // noUncheckedIndexedAccess: capture groups type as string | undefined even though
  // the outer regex guarantees them once `match` is non-null.
  if (full === undefined || prefix === undefined || char === undefined || gap === undefined) {
    return line;
  }

  if (!glyphs.rewriteTaskStates) {
    if (!GFM_RECOGNIZED_CHARS.has(char)) return line;
    return `${prefix}[${TASK_STATE_SENTINEL}${char}]${gap}${line.slice(full.length)}`;
  }

  const glyph = TASK_GLYPHS[char];
  if (glyph === undefined) return line;

  return `${prefix}${glyph}${gap}${line.slice(full.length)}`;
}

// The code-block sentinel: a NUL character used internally to mark the 1-based line
// range a fenced code block renders to, so `--check` can exempt it (fences pass
// through verbatim by user decision — see `wrapCode` below).
//
// Deviation from the brief: the brief specifies writing this as the source-code
// backslash-u string escape for code point zero. Typing that exact escape sequence
// through this editing session was unreliable — twice it landed as an actual raw NUL
// byte physically embedded in this source file, i.e. exactly the hazard the brief
// warns against. `String.fromCharCode(0)` produces the identical runtime character
// with no such risk and is used here instead; see the WP-4a report for detail.
const SENTINEL = String.fromCharCode(0);

// A NUL byte has no legitimate place in markdown source, so stripping it
// unconditionally — even inside fences — prevents a hostile or odd document from
// forging a fake code range via the sentinel mechanism below.
function stripSentinelChar(body: string): string {
  return body.split(SENTINEL).join("");
}

function preprocessBody(body: string, glyphs: GlyphSet): string {
  let inFence = false;
  // Strip both sentinel bytes from the incoming source before either mechanism runs —
  // same reasoning for each, kept as two separate calls so neither strip's
  // implementation needs to know the other's code point exists.
  return stripTaskStateSentinel(stripSentinelChar(body))
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      const withTaskState = rewriteTaskState(line, glyphs);
      return withTaskState.replace(
        WIKI_LINK,
        (_match, bang: string | undefined, slug: string, alias?: string) => {
          const label = styleWikiLink(alias ?? slug);
          // `![[target]]` is Obsidian's embed syntax; render it as a labelled embed
          // reference rather than dropping the `!` on the floor (the plain-link case,
          // `bang === undefined`, is unchanged — no glyph either way, since this must
          // read identically under both glyph tiers and needs no capability detection).
          return bang ? `embed: ${label}` : label;
        },
      );
    })
    .join("\n");
}

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

/** True when the break between two authored lines must be preserved, not coalesced. */
function isHardBoundary(before: string, after: string): boolean {
  if (before.trim() === "" || after.trim() === "") return true;
  if (before.includes(HARD_RETURN) || after.includes(HARD_RETURN)) return true;
  return HARD_BREAK_TAIL.test(before);
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
 */
function rewrapListBody(
  body: string,
  depth: number,
  targetWidth: number,
  quoteColumns: number,
  measure: Measure,
): string {
  const budget = currentListBudget(depth, targetWidth, quoteColumns);
  let insideCode = false;
  return body
    .split("\n")
    .map((line) => {
      const startedInsideCode = insideCode;
      let carriesSentinel = false;
      for (const ch of line) {
        if (ch === SENTINEL) {
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
      const collides = (lines: string[]): boolean => onGrid && lines.slice(1).some((l) => MARKER_SHAPED_LINE.test(l));

      let wrapped = wrapAt(budget - prefixWidth);
      const guarded = collides(wrapped);
      if (guarded) wrapped = wrapAt(budget - prefixWidth - 1);

      return wrapped
        .map((wrappedLine, index) => {
          if (index === 0) return `${prefix}${wrappedLine}`;
          const space = guarded && MARKER_SHAPED_LINE.test(wrappedLine) ? " " : "";
          return `${continuationPrefix}${space}${wrappedLine}`;
        })
        .join("\n");
    })
    .join("\n");
}

// Fenced code is exempted, never rewritten — the user's explicit decision: hard-
// wrapping a shell command changes what a reader copies, and this corpus's fences are
// gate commands meant to be pasted verbatim. So fences pass through at whatever width
// `src/blocks.ts`'s `renderCode` produces (it never reflows), and `--check` must skip
// lines inside them rather than flag them. The mechanism: wrap the rendered block in
// `SENTINEL` markers, then walk the fully rendered document once to record the
// 1-based line range between each pair, and strip the sentinels back out. The
// trailing blank-line padding `section()` adds is deliberately left *outside* the
// sentinel pair (trimmed off, then reattached after the closing marker) so the
// recorded range covers exactly the code block's own content lines — nothing
// borrowed from the following block, nothing left dangling.
function wrapCode(rendered: string): string {
  const trimmed = rendered.replace(/\n+$/, "");
  const trailing = rendered.slice(trimmed.length);
  return `${SENTINEL}${trimmed}${SENTINEL}${trailing}`;
}

// Shared by the `hr` override and the frontmatter divider (WP-3): the text of a
// horizontal rule at `targetWidth`, in the given glyph tier. `marked-terminal`'s own
// `hr()` helper (`index.js:612`) is `new Array(length).join(ch)`, which yields
// `length - 1` characters, not `length` — an off-by-one baked into the library that
// both call sites must reproduce exactly, since "the divider matches the document's
// own rule" means matching that rule as the library actually renders it, not redoing
// the arithmetic from scratch. That off-by-one is now reproduced by `src/blocks.ts`'s
// own `renderHr` rather than inherited from a library call, which is why this is kept as
// the *only* place that computes the string: the rule and the frontmatter divider are
// two independent constructions of it and must never drift apart.
// **The repeat count is a column count divided by the glyph's width, not a character
// count** (WP-3). `─` (U+2500) is East Asian *Ambiguous*, so in wide mode it occupies 2
// columns and `repeat(targetWidth - 1)` would emit a rule twice the width of the
// document — over budget on every single frontmatter-carrying file, and a `--check`
// failure that has nothing to do with the prose. src/AGENTS.md's "every Unicode
// substitute is exactly 1 column, so the tier has no width impact" was a narrow-mode
// statement; the box-drawing set is ambiguous almost in its entirety.
//
// In narrow mode, and in the ASCII tier at either setting, `measure(rule)` is 1 and this
// is `repeat(targetWidth - 1)` exactly as before — byte-identical by construction rather
// than by measurement.
function renderRule(glyphs: GlyphSet, targetWidth: number, measure: Measure): string {
  const glyphColumns = Math.max(1, measure(glyphs.rule));
  return glyphs.rule.repeat(Math.max(0, Math.floor((targetWidth - 1) / glyphColumns)));
}

export interface RenderResult {
  text: string;
  /**
   * 1-based, inclusive [start, end] line ranges that `--check` must not flag.
   *
   * Two sources feed this, on the same principle: a range covers output this renderer
   * reproduces **verbatim from the file** and therefore may not reflow. Fenced code
   * blocks are the original case; a frontmatter block that failed to parse and is being
   * echoed raw is the second (`frontmatter.ts`, `MetaBlockResult.verbatimRanges`).
   * A frontmatter block that *did* parse contributes nothing — that output is our own
   * layout and stays under the gate.
   */
  codeRanges: Array<[number, number]>;
}

/**
 * Strip `SENTINEL` markers out of the rendered document, recording the 1-based line
 * range each open/close pair bounded. A stray unmatched opening marker (should not
 * happen — `preprocessBody` sanitizes the source, and every `code` override call
 * emits markers in balanced pairs) is dropped rather than left dangling: it can never
 * manufacture a range on its own.
 *
 * **F6 (`reviews/2026-07-30-tn-code-review.md`) is measured here and deliberately not
 * applied.** WP-4's landing note records that this walk "converts a character-granular
 * `SENTINEL` pair into whole 1-based *line* numbers, so when a fence inside a list item
 * shares its opening physical line with the item's own text, that marker line is inside the
 * recorded range", and assigns the narrowing to WP-6.
 *
 * WP-6 implemented the narrowing — start on the next line when the opening marker has
 * non-whitespace before it, end on the previous one when the closing marker has
 * non-whitespace after it, drop a range that collapses — and measured it against the
 * validation corpus at all twenty default axes: **not one rendered byte moves**, and the
 * recorded ranges change on **88 of 4,837 files**. That is the correct answer to a real
 * defect, and it is still a change to what `--check` and both sweeps exempt: the lines it
 * un-exempts are list-item prose that was never code, and some of them are over budget, so
 * documents that pass the width gate today would begin to fail it. The WP-1 harness
 * classifies it as class C, because its code-content channel cannot tell "the bytes inside
 * a range changed" from "the range moved".
 *
 * A deliberate change to gate coverage is not something a dependency removal gets to make
 * on its own authority — the precedent is WP-4's user-approved class-C exception. The
 * narrowing is therefore left undone, with its measurement recorded so the next package
 * starts from the number rather than from the argument.
 */
function extractCodeRanges(renderedWithSentinels: string): RenderResult {
  const codeRanges: Array<[number, number]> = [];
  let text = "";
  let line = 1;
  let openLine: number | null = null;

  for (const ch of renderedWithSentinels) {
    if (ch === SENTINEL) {
      if (openLine === null) {
        openLine = line;
      } else {
        codeRanges.push([openLine, line]);
        openLine = null;
      }
      continue;
    }
    text += ch;
    if (ch === "\n") line += 1;
  }

  return { text, codeRanges };
}

// Matches one Unicode emoji glyph (an optional variation selector after it, since
// `node-emoji` sometimes includes U+FE0F) immediately followed by exactly the single
// space `insertEmojis` appends, immediately followed by whatever ANSI SGR codes close
// that segment's styling (`chalk.reset`/`chalk.green.bold`/etc. wrap the *whole*
// rendered string, so the appended space sits before their closing codes, not after —
// verified with `FORCE_COLOR=3`, see `tests/helpers/color.ts`), then end of line. Under
// `bun test` (no TTY, chalk level 0) there are no SGR codes at all and the second group
// matches empty, so the same expression covers both.
const TRAILING_ANSI_SGR_SOURCE = "(?:\\x1b\\[[0-9;]*m)*";
const EMOJI_TRAILING_SPACE = new RegExp(`(\\p{Extended_Pictographic}\\uFE0F?) (${TRAILING_ANSI_SGR_SOURCE})$`, "u");

/**
 * Strip the stray space `insertEmojis` (`marked-terminal`) appends after every
 * substituted glyph, wherever it survived to the true end of a rendered line (WP-11).
 *
 * That space was never in the source. Reflow already absorbs it mid-line — the next
 * word on the same line gets rejoined with a single space regardless — so this only
 * ever fires at the end of a paragraph, a heading, or a list item, which is exactly
 * where the pre-WP-11 pinned tests recorded it surviving. Applying one rule uniformly
 * here, on the fully rendered body, replaces three inconsistent per-renderer behaviors
 * (paragraph and heading keep it, a list item happens to drop it only when it is the
 * list's last line — an accident of `marked-terminal`'s own `list()` doing
 * `body.trim()` on the whole concatenated body, not a deliberate per-item trim; see the
 * WP-11 report) with one: no trailing space the source did not have, anywhere.
 *
 * The implemented predicate is deliberately a **superset** of that rule: it strips a
 * single end-of-line space after *any* `Extended_Pictographic` character, without
 * proving the glyph came from `insertEmojis`. So an authored trailing space does lose
 * out when it follows a pictographic character — `"Acme (c) "` keeps its space,
 * `"Acme ©️ "` does not. That difference is intentional and measured: the residue is
 * invisible trailing whitespace at end of line, it strictly narrows rendered width
 * rather than widening it, and distinguishing an authored glyph from a substituted one
 * would mean tracking substitution provenance through `marked-terminal`'s renderer for
 * no observable gain. Anything before end-of-line, and any authored space after a
 * non-pictographic character, is untouched.
 *
 * Skips every line inside a code range (`codeRanges`, 1-based inclusive, ascending by
 * construction) — fenced *and* indented, since `extractCodeRanges` records both: that
 * content is exempted, verbatim-from-source output by this tool's own contract, so a
 * literal emoji-then-space sequence the user actually typed inside one must survive
 * untouched, not be mistaken for this artifact.
 */
function stripEmojiTrailingSpace(body: string, codeRanges: ReadonlyArray<readonly [number, number]>): string {
  if (codeRanges.length === 0) {
    return body
      .split("\n")
      .map((line) => line.replace(EMOJI_TRAILING_SPACE, "$1$2"))
      .join("\n");
  }

  let rangeIndex = 0;
  return body
    .split("\n")
    .map((line, index) => {
      const lineNumber = index + 1;
      while (rangeIndex < codeRanges.length) {
        const current = codeRanges[rangeIndex];
        if (current === undefined || current[1] >= lineNumber) break;
        rangeIndex += 1;
      }
      const current = codeRanges[rangeIndex];
      const inCode = current !== undefined && lineNumber >= current[0] && lineNumber <= current[1];
      return inCode ? line : line.replace(EMOJI_TRAILING_SPACE, "$1$2");
    })
    .join("\n");
}

/**
 * Render a markdown document to ANSI for the terminal: the frontmatter block (when
 * present) as a readable metadata block, followed by the rendered prose body. Wires
 * `marked` as the lexer. **No renderer method here is `marked-terminal`'s, and neither is
 * the extension object** (WP-4 and WP-6 of `plans/marked-terminal-replacement.md`). Every
 * method is this repo's:
 *
 * - `table` is `renderTable` (`src/table.ts`) — `marked-terminal`'s own table renderer
 *   never receives the terminal width and must not be left in place;
 * - every inline visitor is `src/inline.ts`'s (WP-2), byte-identical to the library's;
 * - `hr`, `code`, `html`, `paragraph`, `heading` and `blockquote` are `src/blocks.ts`'s
 *   (WP-3), with `src/wrap.ts`'s `wrapAnsi` as the reflow engine, measuring through the
 *   `LayoutContext`'s `Measure` rather than the library's `String.prototype.length`;
 * - `list` is `src/lists.ts`'s (WP-4), which owns `listitem` and `checkbox` with it —
 *   both were unreachable as overrides, which is why the defects it fixes could not be
 *   fixed from outside. It is wrapped here to track nesting depth, re-wrap over-budget
 *   lines (composition never reflows list items at all — see `currentListBudget` above)
 *   and substitute the glyph tier's bullet for the leading `"* "` marker;
 * - `text` is `src/inline.ts`'s, wrapped here because a *tight* list item's own body is
 *   the one place the library never parsed inline markup at all.
 *
 * **WP-6 removed the dependency.** What was left on the execution path by then was what
 * `markedTerminal()` ran at construction and nothing else — measured over the full
 * validation corpus at all twenty default axes with every remaining library method
 * counted: **0 calls** — so the construction was replaced by the object literal
 * `marked.use()` actually wants. See it below for what that object has to be and why the
 * four methods this file does not assign are unreachable rather than missing.
 *
 * `code` is still bracketed in sentinels here so `--check` can exempt it. WP-6's plan text
 * expected to replace that with structured metadata on rendered lines; it did not, and
 * `extractCodeRanges` records the measurement that stopped it — the narrowing that change
 * implies moves the *coverage* of 88 files in the validation corpus without moving a byte
 * of rendered text, which is a diff family needing its own granted parity class.
 *
 * `glyphs` defaults to `UNICODE_GLYPHS` rather than reading the environment — every
 * environment-dependent decision is concentrated in `cli.ts`'s call to
 * `resolveGlyphs`, so this function (and everything that calls it directly, such as
 * `scripts/sweep.ts` and every test) stays deterministic regardless of the machine's
 * `TERM` or locale.
 *
 * **`measure` is threaded on exactly that channel and for exactly that reason** (WP-3).
 * East Asian Ambiguous characters render at 1 or 2 columns depending on the terminal,
 * and `src/width.ts` is now the only module that decides which — by env var, cache or
 * DSR probe, all of it resolved in `cli.ts` and handed down as a value. It defaults to
 * `NARROW_MEASURE`, which is both `string-width`'s own default and rule 4 of that
 * resolution order, so every existing caller renders exactly as it did before.
 *
 * `renderDocument` is a thin wrapper over `renderDocumentDetailed` for callers that
 * only need the final text (every existing caller and test).
 */
export function renderDocumentDetailed(
  source: string,
  targetWidth: number,
  glyphs: GlyphSet = UNICODE_GLYPHS,
  measure: Measure = NARROW_MEASURE,
  emojiOverride?: boolean,
  resolveFenceLanguageFor: FenceLanguageResolver = resolveFenceLanguage,
): RenderResult {
  const { meta, body } = splitFrontmatter(source);
  // The divider is appended *into* `metaBlock` itself, before `metaLineOffset` below is
  // computed from it — not emitted separately into the final concatenation. Emitting it
  // anywhere else would silently shift every code range by the divider's line count,
  // since `metaLineOffset` is derived purely from `metaBlock`'s own newline count.
  // Matches the same rule text a `---` in the body would produce at this width/tier
  // (`renderRule`, shared with the `hr` override below) — present only when frontmatter
  // is present, so a document with none renders byte-identical to before this WP.
  const metaResult = meta !== null ? formatMetaBlockDetailed(meta, targetWidth, measure) : null;
  const metaBlock =
    metaResult !== null ? `${metaResult.text}\n${renderRule(glyphs, targetWidth, measure)}\n\n` : "";

  const processedBody = preprocessBody(body, glyphs);

  const instance = new Marked();
  // WP-11 (representative-corpus): shortcode substitution follows the glyph tier.
  //
  // It was twice proposed to set `emoji: false` unconditionally to save ~468 KB in
  // the compiled binary. **That saving does not exist** (see `src/AGENTS.md`'s emoji
  // section) — the substitution table is `node-emoji`, imported at module top level by
  // `src/inline.ts` exactly as `marked-terminal` imported it before WP-6, and this value
  // only picks between substituting and not at runtime. The dependency is bundled either
  // way, and it is a direct dependency now rather than a transitive one.
  //
  // The real conclusion (also `src/AGENTS.md`): this is a *terminal-capability*
  // question, not a constant. Rendering `:rocket:` as 🚀 requires a terminal that
  // can draw it, which is exactly what `glyphs.tier` already models — Unicode
  // renders the glyph, ASCII cannot and keeps the literal shortcode — with
  // `emojiOverride` (threaded from `MdviewConfig.emoji`, `src/config.ts`) able to
  // force either direction regardless of tier. `emojiOverride ?? tier-based` is
  // deliberately computed **once, here**.
  //
  // **The hazard this guards against was three-way, then two-way, and is now one-way.**
  // There used to be *three* `markedTerminal` constructions per render — a main one plus
  // two per-budget caches, built because the library took its width only at construction —
  // and forgetting to pass `emoji` to either cache would have made shortcode substitution
  // depend on whether a paragraph happened to sit inside a list. WP-3 deleted both caches
  // (the owned block renderers take the budget as a parameter) and WP-6 deleted the last
  // construction, so this value now has exactly one consumer: the `LayoutContext` built on
  // the next statement. Pinned in `tests/render.test.ts`'s emoji-tier describe block.
  //
  // `insertEmojis` (`src/inline.ts`, transcribed from `marked-terminal`) appends a stray
  // space after every glyph (`emojiSign + ' '`) that was never in the source. Reflow
  // absorbs it when more text follows on the same line; at the true end of a rendered
  // line it is trailing whitespace this tool did not put there, and it survives independent
  // of ANSI styling (`chalk.reset`/`chalk.green.bold` etc. wrap the whole segment,
  // so the space sits *before* their closing SGR codes, not after). Stripped
  // uniformly, once, by `stripEmojiTrailingSpace` below, skipping fenced code
  // (`codeRanges`) so a literal emoji+space the user actually typed inside a fence
  // is never touched. Shortcodes inside fences stay literal regardless — the `code`
  // renderer never runs the transform at all, in `src/blocks.ts` as in the library it was
  // transcribed from, so this needs no special case there; verified by test. Shortcodes
  // inside a *code span* stay literal for a different reason, and it is the one WP-6
  // expected to delete and could not — see `COLON_REPLACER` in `src/inline.ts`.
  const emoji = emojiOverride ?? glyphs.tier === "unicode";

  // **The one `LayoutContext` for this render** (WP-2 of
  // `plans/marked-terminal-replacement.md`). Everything the owned visitors need, as one
  // immutable value constructed here and threaded explicitly: the target width, the glyph
  // tier and the `Measure` — both of which this repo already requires to be threaded
  // rather than detected at the point of use — the pending-prefix column stack, the
  // fence-language resolver as a seam, whether shortcode substitution runs, and whether
  // inline styling emits SGR codes at all.
  //
  // `detectInlineColor()` is called once per render rather than once per style, and it
  // asks the library rather than re-deriving `chalk`'s rule; see its doc comment for why a
  // hand-rolled TTY check would have silently stopped colouring under CI. It is
  // deliberately *not* `@colors/colors`' own `enabled` flag, which `src/table.ts` keeps
  // for itself: two enablement rules in one binary is the existing, deliberate state, and
  // unifying them here would change table output.
  const layout = createLayoutContext({
    width: targetWidth,
    glyphs,
    measure,
    resolveFenceLanguage: resolveFenceLanguageFor,
    emoji,
    color: detectInlineColor(),
  });

  // **The extension object, owned** (WP-6 of `plans/marked-terminal-replacement.md`).
  //
  // Until this package this line read `markedTerminal({ width, reflowText: true, emoji })`
  // and the object it returned was used purely as a *carrier*: `marked-terminal`'s factory
  // (`index.js:364-401`) assigns twenty thin wrappers onto `{ renderer: {}, useNewRenderer:
  // true }`, and the sixteen assigned below overwrote sixteen of them. WP-4 measured **zero
  // calls to any library renderer method across 95,720 combos**, so what the construction
  // actually supplied was the extension *shape* `marked.use()` expects — which is an object
  // literal with a `renderer` field, and nothing else. `useNewRenderer` is not read anywhere
  // in `marked@14.1.4` (it is a v15 migration flag), so dropping it changes nothing.
  //
  // The four the library assigned and this file does not — `listitem`, `checkbox`,
  // `tablerow`, `tablecell` — are unreachable rather than unassigned, and they were
  // unreachable *before* this change too: `list` is `src/lists.ts`'s and composes items
  // itself, `table` is `src/table.ts`'s and never dispatches a cell token. They now fall
  // through to `marked`'s own defaults instead of to the library's, which is a difference
  // only a call could observe. Pinned by a mutation probe that makes all four throw and
  // renders the whole validation corpus at every default axis — see this WP's report.
  //
  // `marked.use()` requires every key to exist on its own `Renderer` (`marked.cjs:2251`,
  // which throws otherwise) and calls each one with `this` bound to that `Renderer`, which
  // is where the `this.parser` the visitors below close over comes from. Both were already
  // true through the library's wrappers; neither is new.
  const renderer: NonNullable<MarkedExtension["renderer"]> = {};
  // **The allocator gets the budget, not the target width** (WP-3), and that changed
  // here because the thing that used to hide the difference is gone.
  //
  // A table is the one block whose rendered lines nothing downstream can re-wrap without
  // destroying them: its columns are a fixed allocation and its borders are a grid. Until
  // this package a table inside a blockquote was allocated the full `targetWidth`,
  // indented four columns afterwards, and then handed to `wrapOverBudgetLines`, which
  // duly split every border row in half — output that satisfied the width gate by being
  // wrong, which is exactly the failure mode `scripts/AGENTS.md` records when it says the
  // sweep proves width and only width. With that pass deleted the same table would simply
  // overflow, so the allocation has to be right the first time.
  //
  // `layout.prefix.width()` rather than the `pendingPrefixWidth` alias below only because
  // this assignment sits above the aliases; it is the same stack. At the top level it is
  // zero and the allocation is byte-identical to before. Inside a list item it is the
  // marker plus the indent, which is exactly what `list` glues back on afterwards, so the
  // composed line lands at `targetWidth` and `rewrapListBody`'s pass over it is the no-op
  // it documents itself as.
  renderer.table = (token: Tokens.Table) =>
    renderTable(token, Math.max(1, targetWidth - layout.prefix.width()), glyphs, measure);

  // **The owned inline visitors** (WP-2). These were the first group taken off the
  // library, and they had to be byte-identical to it because the block renderers around
  // them were still the library's when they landed. Those are owned too now (WP-3/WP-4),
  // and the bytes stayed put. See
  // `src/inline.ts` for what each reproduces and why, including the two upstream
  // defects (`fixHardReturn`, and `insertEmojis`'s stray trailing space) that are
  // deliberately kept because this package's parity class forbids output moving.
  //
  // `parseInline` is handed in as a closure over `this` rather than read off the
  // context: it is the *parser's* recursion, per call, and belongs to `marked`, not to
  // the layout. `image` needs neither, and `br` needs nothing at all.
  //
  // Not assigned: `tablerow` and `tablecell`, which are unreachable because `table` is
  // replaced wholesale by `renderTable` and that never dispatches cell tokens.
  renderer.strong = function ownedStrong(token: Tokens.Strong) {
    return renderStrong(layout, token, (tokens) => this.parser.parseInline(tokens));
  };
  renderer.em = function ownedEm(token: Tokens.Em) {
    return renderEm(layout, token, (tokens) => this.parser.parseInline(tokens));
  };
  renderer.codespan = (token: Tokens.Codespan) => renderCodespan(layout, token);
  renderer.br = () => renderBr();
  renderer.del = function ownedDel(token: Tokens.Del) {
    return renderDel(layout, token, (tokens) => this.parser.parseInline(tokens));
  };
  renderer.link = function ownedLink(token: Tokens.Link) {
    return renderLink(layout, token, (tokens) => this.parser.parseInline(tokens));
  };
  renderer.image = (token: Tokens.Image) => renderImage(token);

  // Columns that block renderers still owe every line of whatever is being rendered
  // *right now*, because they are glued on only after that inner render returns: a
  // list level's own marker plus its blanket indent, a blockquote's indent. Each
  // block renderer pushes its own contribution for the duration of its call, so at
  // any point inside, the sum is exactly how much narrower than `targetWidth` the
  // text being produced has to be. This is what lets the `paragraph` renderer wrap a
  // *loose* list item once, at the width the item will actually occupy — see its
  // comment below.
  //
  // The stack itself now lives on the `LayoutContext` (`src/layout-context.ts`), which
  // is what makes it reachable from a visitor that is no longer a closure declared
  // inside this function — the whole point of the seam. These four names stay as local
  // aliases so that every call site below reads exactly as it did, and this WP's diff
  // shows the seam being introduced rather than fifteen unrelated call-site rewrites.
  const pendingPrefix = layout.prefix;
  const pendingPrefixWidth = (): number => layout.prefix.width();
  const listDepth = (): number => layout.prefix.listDepth();

  // Non-zero while a renderer that dispatches *inline* tokens is on the stack. Only
  // `paragraph` and `heading` do so anywhere a list can reach (`table` is replaced
  // wholesale by `renderTable`, which never calls `parseInline`; `blockquote`'s
  // children are blocks). This is one of the three conditions that tell a *tight list
  // item's own block text token* apart from an ordinary inline text token — see the
  // `text` override below.
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
  renderer.list = function ownedList(token: Tokens.List) {
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
      const rewrapped = rewrapListBody(result, depth, targetWidth, quoteColumns, measure);
      // Bullet substitution runs once this is the outermost call for this top-level
      // list (`depth === 1`) — see `src/lists.ts`'s header for the two measurements
      // that keep it a separate pass rather than folding it into composition.
      return depth === 1 ? substituteBullets(rewrapped, glyphs, SENTINEL) : rewrapped;
    } finally {
      pendingPrefix.pop();
    }
  };

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
  renderer.text = function wrappedText(token: Tokens.Text | Tokens.Escape | Tokens.Tag) {
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
    // **Only a *tight* item routes here, and that is the whole scope of the defect.**
    // This comment claimed the opposite when WP-14 landed — that a loose item's
    // children reached the block `text` case with `top === true` and were wrapped in a
    // synthesised paragraph whose text token had no `tokens`, so one override fixed
    // tight and loose together. That mechanism is not what `marked` does; WP-13
    // re-measured it and corrected the record.
    //
    // What decides it is the **token type an item's children carry**, not the marker.
    // `marked`'s list lexer stamps `loose` (`marked/lib/marked.cjs:557-561`) and the
    // block tokenizer then gives a **tight** item `text` children and a **loose** item
    // `paragraph` children — both carrying the same inline `tokens`. `listitem`
    // dispatches either through `Parser.parse(item.tokens, !!item.loose)`
    // (`marked-terminal` `index.js:184`), so a loose item's children land on the
    // `paragraph` case, whose override already calls `parseInline`. **Loose items were
    // never broken.** Verified at the library baseline: a tight item renders `**b**`
    // verbatim, a loose one renders it bold.
    //
    // So this override fixes tight items of every marker kind — unordered, ordered,
    // task — plus every nested item whose own list is tight, at any depth. It does not
    // touch the loose path and must not: a loose item's `paragraph` token never reaches
    // here, and the `text` tokens `parseInline` dispatches from inside it carry no
    // `tokens`, so condition 3 excludes them. That is what stops a double parse.
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
    // `segments` now carry live ANSI wherever `chalk` has a colour level, so the
    // re-wrap has to be the ANSI-aware one — which it already was: `wrapAnsi`
    // segments escape sequences out as atomic zero-width units and `measure` is
    // `string-width`, which strips them before counting. That path was built for
    // exactly this content (see `src/wrap.ts`'s module comment, which names list
    // items carrying live ANSI as its reason to exist) and was already exercised here
    // by `styleWikiLink`'s hard-coded escapes, which reach this seam through
    // `preprocessBody` at every colour level.
    const wrapAt = (width: number): string =>
      segments.map((segment) => wrapAnsi(segment, Math.max(1, width), measure).join("\n")).join("\n");

    const wrapped = wrapAt(budget);
    // Same landmine, same guard as the `paragraph` renderer — see `MARKER_SHAPED_LINE`.
    // Every line after the first is still at column 0 when `bulletPointLines` /
    // `numberedLines` run, so one that *starts* `*` or `12.` is taken for a marker
    // line and, in an ordered list, is handed that item's number and rewritten.
    const collides = (text: string): boolean =>
      text.split("\n").slice(1).some((line) => MARKER_SHAPED_LINE.test(line));
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
        .some((line) => REWRITABLE_MARKER_LINE.test(line));
    const guarded = (text: string, guard: string): string =>
      text
        .split("\n")
        .map((line, index) => (index > 0 && MARKER_SHAPED_LINE.test(line) ? `${guard}${line}` : line))
        .join("\n");

    const narrowed = wrapAt(budget - 1);
    if (!guardLandsOnGrid || !rewritable(narrowed)) return settle(guarded(narrowed, " "));
    return settle(guarded(wrapAt(budget - 2), "  "));
  };

  // **The owned block leaves** (WP-3 of `plans/marked-terminal-replacement.md`): `hr`,
  // `code`, `html`, `paragraph`, `heading` and `blockquote`. See `src/blocks.ts` for what
  // each reproduces, line by line — including the three branches of `highlight()` that
  // decide whether a fence is coloured by `cli-highlight`, by `chalk.yellow`, or not at
  // all, and the two orders `paragraph` and `heading` apply styling and reflow in.
  //
  // `hr`, `code` and `html` never called the library's `reflowText` and never read
  // `this.o.width`, so owning those three was a transcription and was gated on
  // byte-identical output across the private corpus at both colour settings before the
  // other three were touched at all.
  //
  // `renderRule` is passed in rather than reached for: it is shared with the frontmatter
  // divider above and must stay the only place that computes a rule. The pre-WP-3 `hr`
  // override called the library and then string-replaced its exact `targetWidth - 1` dash
  // run with this same value, which is the same string as styling the rule directly —
  // byte-identical by construction, including in the ASCII tier where that override
  // short-circuited and returned the library's output untouched.
  renderer.hr = () => renderBlockHr(layout, renderRule(glyphs, targetWidth, measure));

  // `wrapCode` and `SENTINEL` are unchanged and stay `src/render.ts`'s job until WP-6
  // carries code/prose metadata on rendered lines instead of reconstructing ranges from
  // sentinel bytes. The fence-language normalisation that used to shallow-copy the token
  // now happens inside `renderBlockCode`, through the same `ctx.resolveFenceLanguage`
  // seam WP-2 built — so nothing mutates a token `marked` owns, and there is no copy to
  // make either.
  renderer.code = (token: Tokens.Code) => wrapCode(renderBlockCode(layout, token));

  // The one block renderer the library never reflowed, so its width pass is this repo's
  // own and moves into `src/blocks.ts` with it — at the real budget now rather than the
  // full `targetWidth`, which is the same number for every HTML block outside a
  // blockquote or a list item.
  renderer.html = (token: Tokens.HTML | Tokens.Tag) =>
    renderBlockHtml(layout, token, Math.max(1, targetWidth - pendingPrefixWidth()));

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
  renderer.paragraph = function ownedParagraph(token: Tokens.Paragraph) {
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
      const marker = isGuardShapedLine;
      const collides = (text: string): boolean => text.split("\n").slice(1).some(marker);
      if (!collides(result)) return result;

      // Re-wrap a column narrower to make room, then give each colliding continuation
      // line the guard space, which `isPointedLine`'s exact-multiple-of-four indent
      // group cannot match. Unchanged from the pre-WP-3 remedy, deliberately: re-wrapping
      // progressively narrower until no line starts marker-shaped was tried here and
      // rejected — it did not close the detector regression it was aimed at (see this
      // package's report), it costs an extra full paragraph render per attempt, and it
      // defeats `tests/render-lists.test.ts`'s own guard fixture by avoiding the
      // situation the fixture exists to reproduce.
      return renderBlockParagraph(layout, token, parseInline, Math.max(1, budget - 1))
        .split("\n")
        .map((line, index) => (index > 0 && marker(line) ? ` ${line}` : line))
        .join("\n");
    } finally {
      inlineDepth -= 1;
    }
  };

  renderer.heading = function ownedHeading(token: Tokens.Heading) {
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
  };

  renderer.blockquote = function ownedBlockquote(token: Tokens.Blockquote) {
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
  };
  instance.use({ renderer });

  const renderedBody = instance.parse(processedBody, { async: false });
  const { text: strippedBody, codeRanges: bodyRanges } = extractCodeRanges(renderedBody);

  // Deliberately a second, separate pass from `extractCodeRanges` above rather than
  // folded into its character walk: `extractCodeRanges` only ever treats the code-range
  // `SENTINEL` (code point 0) specially, and `TASK_STATE_SENTINEL` (code point 1) is
  // not a newline, so its presence during that walk cannot shift any code range's line
  // numbers — but keeping the two strips as two distinct, separately-named steps means
  // a bug in either one can never silently affect the other's bookkeeping.
  const cleanedBody = stripTaskStateSentinel(strippedBody);

  // WP-11: one uniform pass over the body strips `insertEmojis`'s stray trailing
  // space wherever it survived to end-of-line, skipping fenced ranges. `bodyRanges`
  // (not the offset `codeRanges` below) is correct here — `cleanedBody`'s own line
  // numbering starts at 1 for the body, the same numbering `extractCodeRanges` used to
  // record `bodyRanges` in the first place; the `metaLineOffset` shift below is only
  // for the *returned* `codeRanges`, which describe the final `metaBlock`-prefixed text.
  const emojiCleanedBody = stripEmojiTrailingSpace(cleanedBody, bodyRanges);

  // `metaBlock` never passes through `code`/`rewriteTaskState`, so it never carries
  // either sentinel; its own line count is a fixed offset onto the body's ranges once
  // the two are joined.
  const metaLineOffset = metaBlock === "" ? 0 : metaBlock.split("\n").length - 1;
  // The meta block's own ranges need no offset — it is emitted first, so its line
  // numbering is already the document's. They are listed first for the same reason.
  const codeRanges: Array<[number, number]> = [
    ...(metaResult?.verbatimRanges ?? []),
    ...bodyRanges.map(([start, end]): [number, number] => [start + metaLineOffset, end + metaLineOffset]),
  ];

  return { text: `${metaBlock}${emojiCleanedBody}`, codeRanges };
}

export function renderDocument(
  source: string,
  targetWidth: number,
  glyphs: GlyphSet = UNICODE_GLYPHS,
  measure: Measure = NARROW_MEASURE,
  emojiOverride?: boolean,
  resolveFenceLanguageFor?: FenceLanguageResolver,
): string {
  return renderDocumentDetailed(source, targetWidth, glyphs, measure, emojiOverride, resolveFenceLanguageFor).text;
}
