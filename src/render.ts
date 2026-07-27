import { Marked } from "marked";
import type { Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import stringWidth from "string-width";
import { renderTable } from "./table";
import { formatMetaBlock, splitFrontmatter } from "./frontmatter";
import { wrapAnsi } from "./wrap";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

// Obsidian wiki-links aren't markdown; style them before parsing so they render as
// recognizable links-to-nowhere instead of literal brackets. Adapted from
// example_tracker/apps/web/src/markdown.ts:7 (WIKI_LINK) — same regex, ANSI output
// instead of an HTML <span>.
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

// Obsidian's custom checkbox states aren't GFM tasklist syntax — marked's tasklist
// extension only recognizes " ", "x", "X". Adapted from
// example_tracker/apps/web/src/markdown.ts:15 (TASK_STATE_LINE) and :18-42
// (TASK_STATES), mapping to terminal glyphs instead of lucide icon markers (there is
// no DOM here to mount SVGs into).
const TASK_STATE_LINE = /^(\s*[-*+]\s+)\[(.)\](\s)/;

// Line-by-line pre-pass with a fence toggle, adapted from
// example_tracker/apps/web/src/markdown.ts:16 (FENCE_LINE), so neither rewrite runs
// inside a fenced code block. The web renderer only guards its task-state pass this
// way (see markdown.ts:45-46, which notes the wiki-link pass has "the same latent
// gap"); this tool closes that gap for both passes, since the corpus commonly quotes
// `[[slug]]` inside fenced example commands.
const FENCE_LINE = /^\s*(```|~~~)/;

const TASK_GLYPHS: Record<string, string> = {
  " ": "○",
  x: "✓",
  X: "✓",
  "/": "◐",
  "-": "✗",
  ">": "➤",
  "<": "◷",
  "?": "?",
  "!": "!",
  "*": "★",
  '"': "❝",
  l: "📍",
  b: "🔖",
  i: "ℹ",
  S: "🐖",
  I: "💡",
  p: "👍",
  c: "👎",
  f: "🔥",
  k: "🔑",
  w: "🏆",
  u: "⬆",
  d: "⬇",
};

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
        (_match, slug: string, alias?: string) => styleWikiLink(alias ?? slug),
      );
    })
    .join("\n");
}

// `marked-terminal` only ever calls `renderer.list()` — never `renderer.listitem()` —
// because `Renderer.prototype.list` iterates a list token's items and calls
// `this.listitem(...)` on its own *internal* Renderer instance, not on the extension
// object marked actually dispatches through. Confirmed by instrumenting both hooks
// against a two-level nested list: `list` fired twice (once per nesting level),
// `listitem` fired zero times. So the depth-tracking *and* the wrapping both have to
// live in the `list` override; there is no working `listitem` seam to hang the wrap
// on. (The originating brief for this WP said to override both — that half of it
// doesn't hold up against the actual dispatch path, verified empirically as above.)
//
// Because nested list tokens are rendered synchronously, depth-first, while an
// ancestor's own `list()` call is still on the stack (a nested list is reached via
// `this.parser.parse(item.tokens, …)` inside the *internal* `listitem`), a simple
// enter/exit counter on our `list` override is accurate at the point each level's
// body is produced.
//
// Geometry: `marked-terminal` prefixes every item's own bullet line with `"* "` (2
// cols) inside `listitem`, then blanket-indents the *entire* composed body (bullets,
// continuations, and any already-rendered nested sublists alike) by `tab` (4 cols)
// once per enclosing `list()` call — including once more for every ancestor list
// still on the stack above the current one, applied *after* this override returns.
// So immediately after our own captured original `list()` call returns (i.e. before
// any of those still-pending ancestor blankets are applied), a line's width already
// includes this level's own contribution (2 bullet + 4 indent = 6) but *not* the
// `4 * (ancestors still to come)` that will land on top of it later. If `depth` is
// this override's 1-indexed enter counter (1 for the outermost list, 2 for its
// direct nested lists, …), the number of ancestors still to apply their blanket
// after this frame returns is `depth - 1`, so the *current* line, right now, must
// already fit within `targetWidth - 4 * (depth - 1)`.
function currentListBudget(depth: number, targetWidth: number): number {
  return Math.max(1, targetWidth - 4 * (depth - 1));
}

// Matches a rendered list line's own leading prefix: `marked-terminal`'s blanket
// indent (plain spaces) optionally followed by a bullet/number marker it emits for
// the item's first line (`"* "` or `"12. "`). Continuation lines have no marker, just
// the indent. Measuring this per line (rather than assuming a fixed width) is what
// makes ordered-list markers — wider than `"* "` — work without special-casing them.
const LIST_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/;

// Matches an unordered item's leading marker exactly as `marked-terminal` emits it:
// leading whitespace (the not-yet-applied ancestor blankets aside, this level's own
// indent is already present), then a literal `*` immediately followed by the one
// space `listitem` always inserts after it. Anchored to the start of the line, so it
// only ever matches an actual marker position — never a `*` that merely appears
// inside wrapped body text (marked-terminal converts markdown `*emphasis*` to ANSI
// escapes before this string is built, so a literal `*` followed by a space at column
// 0 of a rendered line is, in practice, always the marker this override exists to
// replace). Ordered markers (`\d+\.`) never match `\*`, so numeric markers are never
// touched by this substitution.
const UNORDERED_MARKER_LINE = /^(\s*)\*(\s)/;

// `marked-terminal`'s own blanket indent is `this.tab` (4) columns per nesting level,
// applied even at the outermost level — see the brief's worked example (`"    * alpha"`
// at depth 1, `"        * beta"` at depth 2, …). Once a list's `fixNestedLists` pass has
// fully resolved a line's position (see `substituteBullets`'s doc comment for why that
// matters), its nesting depth can be read straight back out of its own indentation.
const LIST_INDENT_PER_LEVEL = 4;

/**
 * Replace the leading `"* "` marker `marked-terminal` emits for every unordered list
 * item with the glyph for that line's nesting depth (cycling past the configured
 * bullet set with `%`, so depth 4 wraps back to the first glyph). Depth is read back
 * out of the line's own indentation (`indent.length / 4`) rather than passed in as a
 * recursion-tracked argument — see below for why that is load-bearing, not a style
 * choice.
 *
 * **Why this cannot run per-recursion-level (deviation found empirically, not in the
 * brief).** `marked-terminal`'s `Renderer.prototype.list` ends with
 * `fixNestedLists(indentLines(this.tab, body), this.tab)` (`index.js:152`).
 * `fixNestedLists` repairs the *default* behaviour of a nested list's rendered text
 * landing on the same physical line as its parent item — it finds where a sub-list
 * begins using a regex hardcoded to the literal markers `POINT_REGEX` recognizes
 * (`\*` or `\d+\.`, `index.js:510-513`) and inserts the missing newline + indent there.
 * That repair runs **inside every level's own `originalList.call`**, including every
 * ancestor still on the stack above whichever level our override is currently
 * touching. Substituting a nested level's `"*"` for a glyph *before* an ancestor's own
 * `fixNestedLists` pass has run destroys the literal marker that pass depends on to
 * find the join point — verified by rendering a 2-level list with substitution done
 * per-recursion-level: the child's own bullet was correctly swapped, but the *parent*
 * level's subsequent `fixNestedLists` then failed to detect the (no-longer-`"*"`)
 * child marker and left the whole rendered nested list joined onto its parent's line
 * with no newline at all (`"    • level 0    ◦ level 1"` instead of two lines) — the
 * same corruption reproduces with any literal substitute, not just a Unicode one, so
 * it is `fixNestedLists`'s marker detection breaking, not a width/encoding issue.
 * The fix: only ever run this pass once, over the fully-resolved text of the
 * *outermost* list call for a given top-level list (`listDepth === 1`, checked at the
 * call site below) — by then every ancestor's `fixNestedLists` for this subtree has
 * already completed, so nothing downstream still needs the `"*"` literal.
 *
 * **Regression, found in review: a fenced code block nested inside a list item got its
 * `* `/bare-`*` content rewritten.** `mdview/AGENTS.md`'s rendering policy is
 * unqualified on this: "fenced code is never rewritten" — a wrapped or altered command
 * is a wrong command, no exceptions. No gate caught it: `--check` and both sweeps
 * exempt code ranges from width checking entirely, so corrupting a line *inside* one is
 * invisible to width-only gates, and none of the corpus fixtures happen to nest a fence
 * inside a list item.
 *
 * The fix reuses the mechanism already in this file rather than re-deriving code
 * ranges or parsing fences again: `code`'s override (`wrapCode`, below) resolves
 * depth-first — for a fence nested inside a list item, it always runs *before* the
 * enclosing `list()` call composes this level's `body` string — so by the time
 * `substituteBullets` sees `body`, every fenced block nested in it is already bracketed
 * in `SENTINEL` pairs (confirmed: exactly 2 sentinel characters in the body for a
 * single nested fence). This pass tracks open/close state across `SENTINEL`
 * occurrences as it scans, character by character within each line — a single
 * `SENTINEL` pair can open and close on the *same* physical line (a one-line code
 * block), so the toggle happens per occurrence, not per line — and uses the state a
 * line *starts* in (before that line's own occurrences are counted) to decide whether
 * that line's leading marker is eligible for substitution at all. A line whose starting
 * state is "inside a fence" is left completely untouched, regardless of what its first
 * characters look like.
 */
function substituteBullets(body: string, glyphs: GlyphSet): string {
  let insideCode = false;
  return body
    .split("\n")
    .map((line) => {
      const startedInsideCode = insideCode;
      for (const ch of line) {
        if (ch === SENTINEL) insideCode = !insideCode;
      }
      if (startedInsideCode) return line;

      return line.replace(UNORDERED_MARKER_LINE, (_match, indent: string, gap: string) => {
        const depth = Math.max(1, Math.round(indent.length / LIST_INDENT_PER_LEVEL));
        const bullet = glyphs.bullets[(depth - 1) % glyphs.bullets.length] ?? glyphs.bullets[0] ?? "*";
        return `${indent}${bullet}${gap}`;
      });
    })
    .join("\n");
}

/**
 * Re-wrap only the lines of a rendered list body that are still over budget at this
 * nesting level. Lines already within budget are left untouched — that is what makes
 * this idempotent and safe to run on a body that already contains a correctly
 * (tighter-budgeted) wrapped nested sublist: nested content was wrapped against a
 * strictly smaller budget (deeper depth), so it always already fits the shallower
 * budget here and this pass never touches it.
 */
function rewrapListBody(body: string, depth: number, targetWidth: number): string {
  const budget = currentListBudget(depth, targetWidth);
  return body
    .split("\n")
    .map((line) => {
      if (stringWidth(line) <= budget) return line;

      const match = LIST_LINE_PREFIX.exec(line);
      const prefix = match ? `${match[1] ?? ""}${match[2] ?? ""}` : "";
      const prefixWidth = stringWidth(prefix);
      const rest = line.slice(prefix.length);
      const continuationPrefix = " ".repeat(prefixWidth);

      const wrapped = wrapAnsi(rest, Math.max(1, budget - prefixWidth));
      return wrapped
        .map((wrappedLine, index) => (index === 0 ? `${prefix}${wrappedLine}` : `${continuationPrefix}${wrappedLine}`))
        .join("\n");
    })
    .join("\n");
}

// Fenced code is exempted, never rewritten — the user's explicit decision: hard-
// wrapping a shell command changes what a reader copies, and this corpus's fences are
// gate commands meant to be pasted verbatim. So fences pass through exactly as
// `marked-terminal` renders them (whatever width that is), and `--check` must skip
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

export interface RenderResult {
  text: string;
  /** 1-based, inclusive [start, end] line ranges that `--check` must not flag. */
  codeRanges: Array<[number, number]>;
}

/**
 * Strip `SENTINEL` markers out of the rendered document, recording the 1-based line
 * range each open/close pair bounded. A stray unmatched opening marker (should not
 * happen — `preprocessBody` sanitizes the source, and every `code` override call
 * emits markers in balanced pairs) is dropped rather than left dangling: it can never
 * manufacture a range on its own.
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

/**
 * Re-wrap only the lines of already-rendered output that are still over budget.
 * Idempotent and safe on already-correct input: a line within `targetWidth` is
 * returned untouched, so calling this on output that was already reflowed
 * correctly is a no-op.
 *
 * Two distinct callers need this:
 *
 * - `html`: needed because a line *starting* with a block-level tag (e.g.
 *   `<script>`) makes marked open an `html` token that swallows the rest of the
 *   paragraph, and `marked-terminal`'s own `html` renderer returns that
 *   unreflowed — unlike `paragraph`/`heading`/`blockquote`, it never reads
 *   `reflowText` at all. This does not attempt to re-parse the swallowed
 *   markdown; the width guarantee is what matters, not recovering inline
 *   formatting.
 * - `paragraph`/`heading`/`blockquote`: these *do* read `reflowText`, but
 *   `marked-terminal`'s own reflow measures word width with plain `.length`
 *   (UTF-16 code units), not `string-width`. For most text that is the same
 *   number, but for a handful of Unicode punctuation marks `string-width`
 *   counts wider than `.length` does (measured against this repo's corpus:
 *   e.g. `↔`, `—`), so a line `marked-terminal` believes fits exactly at
 *   `targetWidth` can come out 1-2 columns over by the stricter measurement
 *   `--check` uses. This is a safety net over an already-working reflow, not a
 *   replacement for it — confirmed by corpus sweep, this only ever touches a
 *   small residual (worst case 3 lines across the whole corpus at three
 *   widths), not the dominant list-item defect this WP was scoped for.
 */
function wrapOverBudgetLines(rendered: string, targetWidth: number): string {
  return rendered
    .split("\n")
    .map((line) => (stringWidth(line) <= targetWidth ? line : wrapAnsi(line, targetWidth).join("\n")))
    .join("\n");
}

/**
 * Render a markdown document to ANSI for the terminal: the frontmatter block (when
 * present) as a readable metadata block, followed by the rendered prose body. Wires
 * `marked` + `marked-terminal`, overriding:
 *
 * - `table` with WP-3's `renderTable` — `marked-terminal`'s own table renderer never
 *   receives the terminal width and must not be left in place;
 * - `list` to track nesting depth, reflow over-budget lines (`marked-terminal` never
 *   reflows list items at all — see `currentListBudget` above), and substitute the
 *   glyph tier's bullet for the leading `"* "` marker (WP-2);
 * - `hr` to draw the glyph tier's rule character instead of `marked-terminal`'s
 *   hardcoded `-` (WP-2);
 * - `code` to bracket fenced output in sentinels so `--check` can exempt it;
 * - `html` to reflow swallowed block-HTML paragraphs;
 * - `paragraph`/`heading`/`blockquote` with a thin safety-net re-wrap (see
 *   `wrapOverBudgetLines`) over `marked-terminal`'s own `reflowText`, which measures
 *   width with plain `.length` and can undercount a handful of Unicode punctuation
 *   marks relative to `string-width`.
 *
 * `glyphs` defaults to `UNICODE_GLYPHS` rather than reading the environment — every
 * environment-dependent decision is concentrated in `cli.ts`'s call to
 * `resolveGlyphs`, so this function (and everything that calls it directly, such as
 * `scripts/sweep.ts` and every test) stays deterministic regardless of the machine's
 * `TERM` or locale.
 *
 * `renderDocument` is a thin wrapper over `renderDocumentDetailed` for callers that
 * only need the final text (every existing caller and test).
 */
export function renderDocumentDetailed(
  source: string,
  targetWidth: number,
  glyphs: GlyphSet = UNICODE_GLYPHS,
): RenderResult {
  const { meta, body } = splitFrontmatter(source);
  const metaBlock = meta !== null ? `${formatMetaBlock(meta, targetWidth)}\n\n` : "";

  const processedBody = preprocessBody(body, glyphs);

  const instance = new Marked();
  const extension = markedTerminal({ width: targetWidth, reflowText: true });
  const renderer = extension.renderer;
  if (renderer) {
    renderer.table = (token: Tokens.Table) => renderTable(token, targetWidth, glyphs);

    let listDepth = 0;
    const originalList = renderer.list;
    if (originalList) {
      renderer.list = function wrappedList(token: Tokens.List) {
        listDepth += 1;
        try {
          // `this` is contextually `_Renderer` here (the target this function is
          // assigned to declares `this: _Renderer`); forwarding it is what keeps
          // `originalList`'s own internal `this.o`/`this.tab`/`this.parser` reads
          // working exactly as they would un-overridden.
          const result = originalList.call(this, token);
          if (result === false) return false;
          const rewrapped = rewrapListBody(result, listDepth, targetWidth);
          // Bullet substitution only runs once this is the outermost call for this
          // top-level list (`listDepth === 1`) — see `substituteBullets`'s doc comment
          // for why running it at every recursion level corrupts `marked-terminal`'s
          // own `fixNestedLists` marker detection for ancestors still on the stack.
          return listDepth === 1 ? substituteBullets(rewrapped, glyphs) : rewrapped;
        } finally {
          listDepth -= 1;
        }
      };
    }

    // `marked-terminal`'s own `hr` hardcodes `-` (`Renderer.prototype.hr`, `index.js:135`,
    // via its internal `hr()` helper at `index.js:612`: `new Array(width).join('-')`,
    // i.e. `width - 1` dashes — an off-by-one baked into the library, preserved here
    // rather than corrected, since WP-3's frontmatter divider must match it exactly).
    // For the ASCII tier this override is a provable no-op: `glyphs.rule === "-"`
    // short-circuits before touching `result` at all, so the ASCII path returns
    // byte-identical output to today's. For the Unicode tier, the dash run is exactly
    // `targetWidth - 1` characters (this function's own `targetWidth`, matching
    // `this.o.width` the extension was constructed with), so replacing that exact
    // literal run — whatever styling/section wrapping `originalHr` added around it —
    // swaps the glyph without touching anything else in the string.
    const originalHr = renderer.hr;
    if (originalHr) {
      renderer.hr = function wrappedHr(token: Tokens.Hr) {
        const result = originalHr.call(this, token);
        if (result === false || glyphs.rule === "-") return result;
        const dashes = "-".repeat(Math.max(0, targetWidth - 1));
        if (dashes === "") return result;
        return result.split(dashes).join(glyphs.rule.repeat(dashes.length));
      };
    }

    const originalCode = renderer.code;
    if (originalCode) {
      renderer.code = function wrappedCode(token: Tokens.Code) {
        const result = originalCode.call(this, token);
        return result === false ? false : wrapCode(result);
      };
    }

    const originalHtml = renderer.html;
    if (originalHtml) {
      renderer.html = function wrappedHtml(token: Tokens.HTML | Tokens.Tag) {
        const result = originalHtml.call(this, token);
        return result === false ? false : wrapOverBudgetLines(result, targetWidth);
      };
    }

    // Safety net over `marked-terminal`'s own `reflowText` — see
    // `wrapOverBudgetLines`'s doc comment for why these three still occasionally
    // need it despite already being reflowed.
    const originalParagraph = renderer.paragraph;
    if (originalParagraph) {
      renderer.paragraph = function wrappedParagraph(token: Tokens.Paragraph) {
        const result = originalParagraph.call(this, token);
        return result === false ? false : wrapOverBudgetLines(result, targetWidth);
      };
    }

    const originalHeading = renderer.heading;
    if (originalHeading) {
      renderer.heading = function wrappedHeading(token: Tokens.Heading) {
        const result = originalHeading.call(this, token);
        return result === false ? false : wrapOverBudgetLines(result, targetWidth);
      };
    }

    const originalBlockquote = renderer.blockquote;
    if (originalBlockquote) {
      renderer.blockquote = function wrappedBlockquote(token: Tokens.Blockquote) {
        const result = originalBlockquote.call(this, token);
        return result === false ? false : wrapOverBudgetLines(result, targetWidth);
      };
    }
  }
  instance.use(extension);

  const renderedBody = instance.parse(processedBody, { async: false });
  const { text: strippedBody, codeRanges: bodyRanges } = extractCodeRanges(renderedBody);

  // Deliberately a second, separate pass from `extractCodeRanges` above rather than
  // folded into its character walk: `extractCodeRanges` only ever treats the code-range
  // `SENTINEL` (code point 0) specially, and `TASK_STATE_SENTINEL` (code point 1) is
  // not a newline, so its presence during that walk cannot shift any code range's line
  // numbers — but keeping the two strips as two distinct, separately-named steps means
  // a bug in either one can never silently affect the other's bookkeeping.
  const cleanedBody = stripTaskStateSentinel(strippedBody);

  // `metaBlock` never passes through `code`/`rewriteTaskState`, so it never carries
  // either sentinel; its own line count is a fixed offset onto the body's ranges once
  // the two are joined.
  const metaLineOffset = metaBlock === "" ? 0 : metaBlock.split("\n").length - 1;
  const codeRanges: Array<[number, number]> = bodyRanges.map(([start, end]) => [
    start + metaLineOffset,
    end + metaLineOffset,
  ]);

  return { text: `${metaBlock}${cleanedBody}`, codeRanges };
}

export function renderDocument(
  source: string,
  targetWidth: number,
  glyphs: GlyphSet = UNICODE_GLYPHS,
): string {
  return renderDocumentDetailed(source, targetWidth, glyphs).text;
}
