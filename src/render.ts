import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import { renderTable } from "./table";
import { formatMetaBlockDetailed, splitFrontmatter } from "./frontmatter";
import { wrapAnsi } from "./wrap";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { resolveFenceLanguage } from "./lang";
import { stripAnsi, trackListLine, type OpenListItem } from "./detectors";
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
const TASK_STATE_LINE = /^(\s*[-*+]\s+)\[(.)\](\s)/;

// Line-by-line pre-pass with a fence toggle, so neither rewrite runs inside a fenced
// code block. Borrowed from the same renderer, which guards only its *task-state* pass
// this way and records in its own source that the wiki-link pass has the same latent
// gap. This tool closes that gap for both passes, since the corpus commonly quotes
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
//
// **A list is not the only thing that can still owe a blanket indent** (WP-2g).
// `blockquote` applies `indentify(this.tab, …)` to its whole rendered body for exactly
// the same reason and at exactly the same moment — after its children have returned —
// so a list inside a blockquote is `BLOCKQUOTE_INDENT_PER_LEVEL` columns wider than
// this arithmetic believed, at every level. `outerColumns` is those still-pending
// non-list columns, read off the same `pendingPrefix` stack the `paragraph`/`text`
// overrides already subtract in full: without it the two disagree about the same item,
// `paragraph` wrapping the text narrow enough and this pass then re-splitting the
// composed line against a budget four columns too generous.
function currentListBudget(depth: number, targetWidth: number, outerColumns: number): number {
  return Math.max(1, targetWidth - 4 * (depth - 1) - outerColumns);
}

// Matches a rendered list line's own leading prefix: `marked-terminal`'s blanket
// indent (plain spaces) optionally followed by a bullet/number marker it emits for
// the item's first line (`"* "` or `"12. "`). Continuation lines have no marker, just
// the indent. Measuring this per line (rather than assuming a fixed width) is what
// makes ordered-list markers — wider than `"* "` — work without special-casing them.
const LIST_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/;

// Matches an unordered item's leading marker exactly as `marked-terminal` emits it:
// this level's own indent (already applied by the time `substituteBullets` runs), then a
// literal `*` immediately followed by the one space `listitem` always inserts after it.
// Ordered markers (`\d+\.`) never match `\*`, so numeric markers are never touched.
//
// **The indent is the four-column grid, not `\s*` — this was `/^(\s*)\*(\s)/` and that
// was too loose (WP-2f).** The old comment reasoned that a literal `*` at the start of a
// rendered line "is, in practice, always the marker", but this pass runs *after*
// `rewrapListBody`, which chooses where lines break and can therefore put an author's
// own bare `*` at the start of a continuation line. `\s*` then claimed it and rewrote the
// author's text into a bullet glyph — and no width gate can see a substitution. The
// one-space guard both wrapping overrides use is sized for `isPointedLine`'s
// exact-multiple-of-four indent (`LIBRARY_POINTED_LINE`), so a looser regex here is a
// consumer that guard cannot defeat. Every genuine marker line is on that grid because
// `indentLines` only ever adds `LIST_INDENT_PER_LEVEL` at a time: measured over a
// 1,000-file corpus sample at five widths, **79,410 substitutions, 0 of them off-grid**.
const UNORDERED_MARKER_LINE = /^((?: {4})+)\*(\s)/;

// `marked-terminal`'s own blanket indent is `this.tab` (4) columns per nesting level,
// applied even at the outermost level — see the brief's worked example (`"    * alpha"`
// at depth 1, `"        * beta"` at depth 2, …). Once a list's `fixNestedLists` pass has
// fully resolved a line's position (see `substituteBullets`'s doc comment for why that
// matters), its nesting depth can be read straight back out of its own indentation.
const LIST_INDENT_PER_LEVEL = 4;

// `Renderer.prototype.blockquote` (`index.js:106`) indents its whole rendered body by
// `this.tab` — the same 4 columns — once its children have already rendered. It also
// `trim()`s that body first, which costs the first line its own indent — see
// `firstLineIndentTrimmedAway` (WP-2g).
const BLOCKQUOTE_INDENT_PER_LEVEL = 4;

// `"* "`, the literal `marked-terminal` emits for every unordered item
// (`BULLET_POINT`, `index.js:539`). Continuation lines of an unordered item get
// `toSpaces(BULLET_POINT)` — the same 2 columns — so this width is uniform per line
// kind, and our own glyph substitution preserves it (every tier bullet is 1 column).
const UNORDERED_MARKER_WIDTH = 2;

// `". "` — what `numberedPoint(n)` (`index.js:551`) appends after the number itself.
const ORDERED_MARKER_SUFFIX_WIDTH = 2;

/**
 * How many marker lines a list level can renumber, i.e. the largest number it can emit.
 *
 * **Not `token.items.length`.** `numberedLines` (`index.js:565-578`) walks the composed
 * body counting *pointed* lines, and `isPointedLine`'s regex is
 * `^(?:<tab>)*(?:\*|\d+\.)` — leading tabs allowed — so an already-rendered nested
 * list's marker lines still count against the *parent's* counter. A 3-item ordered list
 * whose items carry nested lists therefore numbers well past 3. Counting the whole
 * subtree is an upper bound that is exact whenever nothing nested is present.
 *
 * `token.start` is deliberately ignored: `Renderer.prototype.list` reads it
 * (`index.js:141`) and never uses it, so a list authored `5.` still renders `1.`.
 */
function markerLineCount(token: Tokens.List): number {
  let count = token.items.length;
  for (const item of token.items) count += nestedMarkerLineCount(item.tokens);
  return count;
}

function nestedMarkerLineCount(tokens: Token[] | undefined): number {
  let count = 0;
  for (const token of tokens ?? []) {
    if (token.type === "list") {
      count += markerLineCount(token as Tokens.List);
    } else {
      count += nestedMarkerLineCount((token as { tokens?: Token[] }).tokens);
    }
  }
  return count;
}

/**
 * A rendered line `marked-terminal` will mistake for a list marker of its own.
 *
 * When `list` composes its body, an item's continuation lines are still at column 0,
 * and `isPointedLine` (`index.js:531`) tests `^(?:<tab>)*(?:\*|\d+\.)` — no space
 * required after the `*`. So a wrapped line that merely *begins* with `**bold**` or
 * `1.5x` is taken for a marker line, and in an **ordered** list `numberedLine` then
 * rewrites it: it consumes that item's number and replaces the first `"* "` *anywhere*
 * in the line — inside the `**` pair — with `"N. "`. The item's text is corrupted and
 * every later item is renumbered. Measured live: 1 occurrence in a 1,000-file corpus
 * sample, 59 more lines one list-type away from it.
 *
 * This is a `marked-terminal` landmine, not ours, and it predates WP-2b — but WP-2b
 * decides where a loose item's lines break, so it decides whether the landmine is
 * stepped on, and re-wrapping a corpus sample lit it once in 1,000 files where the old
 * wrap lit it zero times. `wrappedParagraph` defuses it for the lines it owns: a
 * continuation line that starts like a marker is given a single leading space, which
 * `isPointedLine` cannot match (its indent group is *exactly* four spaces at a time),
 * so the library pads and numbers the line as the continuation it is. That paragraph is
 * re-wrapped one column narrower first, so the guard space costs no width.
 *
 * Only continuation lines are guarded. A paragraph's *first* line is marker-shaped or
 * not regardless of where it wraps, and for an item's first paragraph the real marker
 * lands in front of it anyway.
 */
const MARKER_SHAPED_LINE = /^(?:\*|\d+\.)/;

/**
 * The width of the widest marker this list level can emit — 2 for `"* "`, but 4 for an
 * ordered list that reaches `"10. "`. **Hardcoding 2 is the bug this function exists to
 * prevent**: an ordered list with ten or more marker lines pushes its own text two
 * columns further right than an unordered one, and a budget computed with 2 leaves the
 * tail of every long item over budget — which is exactly the shear this WP closes.
 *
 * The widest marker is used for every item of the level rather than the exact per-item
 * marker, because at paragraph time no marker has been emitted yet and the item index is
 * not reachable (`listitem` is a dead seam — see above). The cost is that items 1-9 of a
 * ten-item ordered list wrap one column early; the alternative — guessing narrow — is an
 * orphaned line, which is strictly worse and invisible to every gate.
 */
function listMarkerWidth(token: Tokens.List): number {
  if (!token.ordered) return UNORDERED_MARKER_WIDTH;
  return String(Math.max(1, markerLineCount(token))).length + ORDERED_MARKER_SUFFIX_WIDTH;
}

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
 * `* `/bare-`*` content rewritten.** `AGENTS.md`'s rendering policy is
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
 * `marked-terminal`'s `HARD_RETURN` (`index.js:26`), the marker `Renderer.prototype.br`
 * (`index.js:291-293`) emits in place of a hard break when `reflowText` is on.
 *
 * **It never reaches a tight list item** — measured, see `coalesceTightItemLines` — but
 * a coalescing pass must refuse to join across one if it ever does, so it is named here
 * rather than assumed absent.
 */
const HARD_RETURN = "\r";

/**
 * An authored hard line break, as it actually survives into a *tight* list item's text.
 *
 * **Not `HARD_RETURN`.** `marked-terminal`'s `Renderer.prototype.text` (`index.js:84-89`)
 * renders a block text token from its raw `token.text` field and never dispatches
 * `token.tokens`, so for a tight item no inline token is ever rendered — `br` does not
 * fire, no `HARD_RETURN` is produced, and the item's *markdown source syntax* arrives
 * verbatim instead. (This is the same library behaviour that makes `**bold**` render as
 * literal asterisks inside a tight item.) A hard break is therefore still visible, as
 * the source spelling that created it, immediately before the `\n`:
 *
 * - two or more trailing spaces,
 * - a trailing backslash,
 * - a literal `<br>` / `<br/>` / `<br />`.
 *
 * Measured over 600 corpus files: 11,675 soft breaks inside tight items, **1** hard
 * break (trailing spaces), **0** `HARD_RETURN`, **0** `SENTINEL`. Rare is not never —
 * the one instance must survive, which is why this is a boundary and not a heuristic.
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
 * corrupted long URLs and paths. **Nothing reflows a tight item** (`AGENTS.md`: "list
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
 * `isPointedLine` (`marked-terminal` `index.js:531`) as it is actually called on a
 * composed list body — `this.tab`, i.e. exactly four spaces, repeated zero or more
 * times, then a literal marker. The **exact-multiple-of-four** indent is the whole
 * point: a line one column off that grid can never be claimed as a marker, which is
 * what makes the one-space guard in `realignNestedContinuations` (and in the two
 * wrapping overrides, via `MARKER_SHAPED_LINE`) work.
 */
const LIBRARY_POINTED_LINE = new RegExp(`^(?: {${LIST_INDENT_PER_LEVEL}})*(?:\\*|\\d+\\.)`);

/**
 * Pull a nested item's continuation lines back to their own item's text column (WP-2e).
 *
 * **The defect.** `marked-terminal`'s `list()` calls `bulletPointLines` (unordered) or
 * `numberedLines` (ordered) over the whole composed body, and both prepend a marker's
 * width in spaces — `toSpaces(BULLET_POINT)`, 2, or `toSpaces(numberedPoint(n))`, 3+ —
 * to every line `isPointedLine` does *not* recognize (`index.js:539-578`). For this
 * level's **own** items that is exactly right: it aligns a continuation under its own
 * marker's text. But the body it walks also contains an inner list that already
 * rendered, and there the same pass moves the inner items' *continuation* lines while
 * leaving their *marker* lines alone (`isPointedLine` recognizes those — mdview
 * substitutes bullet glyphs only at `listDepth === 1`, so the literal `*` is still
 * there). So every continuation inside a nested item drifts one marker-width per
 * ancestor level past the column its own first line starts at. `indentLines`
 * (`index.js:501`) then adds `this.tab` to every line equally and contributes nothing
 * to the *relative* drift.
 *
 * Measured: 29,035 over-indents against 6,469 orphans in the WP-2d regression tier, and
 * 64-72% of the orphan residual at the user's real widths after WP-2c. It is not
 * cosmetic — a continuation shifted right is a continuation over budget, and the
 * shallower `rewrapListBody` then shears its tail word onto a line of its own. Running
 * *before* `rewrapListBody` is what makes the orphan disappear with the indent rather
 * than in addition to it.
 *
 * **This subtracts the drift; it does not snap lines to a column.** The distinction is
 * load-bearing and was found by measurement, not reasoning: a blockquote or a fenced
 * block inside a list item is *legitimately* indented past its item's text column by its
 * own renderer (`Renderer.prototype.blockquote`/`code` indent by `this.tab` before the
 * list ever sees them), and `findContinuationOverIndent` reports those too. Snapping
 * every flagged line to `item.textColumn` would flatten them. Subtracting exactly the
 * width this level just added preserves every legitimate *relative* offset underneath
 * it, at every depth, and leaves that class of detector hit standing — correctly.
 *
 * **How much did this level add?** Exactly the marker width of *its own* item, which is
 * `textColumn - markerColumn` of the item at the bottom of the stack (this level's items
 * are the ones whose marker sits at `LIST_INDENT_PER_LEVEL`, since `indentLines` has run
 * by the time we see the body). That derivation is what makes ordered lists work without
 * a special case: `numberedLines` pads with `String(n).length + 2`, and so does the
 * bottom-of-stack item's own marker. It is also why this pass must run **per level**
 * rather than once at the outermost list — see the call site.
 *
 * **Fenced code is never rewritten**, including a fence nested in a list item. Same
 * mechanism as `substituteBullets`: `code`'s override resolves depth-first, so every
 * fence in this body is already bracketed in `SENTINEL` pairs. A line that *starts*
 * inside a fence, or that carries a sentinel of its own (the opening and closing lines
 * of a block, where the marker sits mid-line), is returned untouched and is not allowed
 * to move the item stack either.
 *
 * **A de-indented line may not be allowed to become a marker.** Landing on the
 * four-column grid with a leading `*` or `12.` is all `isPointedLine` asks for, and an
 * ancestor's `numberedLine` would then hand that line the item's number and rewrite it.
 * Unordered text columns are never on the grid (`4d + 2`), but a ten-item ordered list's
 * are (`4d + 4`), so the case is live. Guarded the same way both wrapping overrides
 * guard it: one extra leading space, which the grid cannot match.
 */
function realignNestedContinuations(body: string, measure: Measure): string {
  const open: OpenListItem[] = [];
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

      const bare = stripAnsi(line);
      const item = trackListLine(bare, open, measure);
      if (item === null) return line;

      // This level's own items sit at `LIST_INDENT_PER_LEVEL`; anything deeper came from
      // an inner list that already rendered, and only those drifted.
      if (item.markerColumn <= LIST_INDENT_PER_LEVEL) return line;
      const ownItem = open[0];
      if (ownItem === undefined || ownItem.markerColumn !== LIST_INDENT_PER_LEVEL) return line;
      const addedWidth = ownItem.textColumn - ownItem.markerColumn;
      if (addedWidth <= 0) return line;

      const indent = (/^ */.exec(line) as RegExpExecArray)[0].length;
      // Leading whitespace must be literal spaces on both the raw and the stripped line,
      // or the slice below would cut into an escape sequence. Anything else is left alone.
      if (indent !== (/^ */.exec(bare) as RegExpExecArray)[0].length) return line;
      if (indent <= item.textColumn) return line;

      const rest = line.slice(indent);
      const target = Math.max(item.textColumn, indent - addedWidth);
      const realigned = `${" ".repeat(target)}${rest}`;
      if (LIBRARY_POINTED_LINE.test(bare) || !LIBRARY_POINTED_LINE.test(stripAnsi(realigned))) return realigned;
      return `${" ".repeat(target + 1)}${rest}`;
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
 *
 * **Fenced code is never rewritten, including a fence nested in a list item (WP-2f).**
 * This pass shipped without the `SENTINEL` walk `substituteBullets` and
 * `realignNestedContinuations` both use, and split fence content mid-command like any
 * other over-budget line. **No gate could see it**: `--check` and both sweeps exempt
 * recorded `codeRanges` from width checking, so corrupting a line *inside* one can never
 * make a width gate fail. Same mechanism as the other two passes — `code`'s override
 * (`wrapCode`) resolves depth-first, so every fence in this body is already bracketed in
 * `SENTINEL` pairs by the time `list` composes it.
 *
 * **The strictness here is the stricter of the two forms already in this file, and the
 * one-line fence is what decides it.** `substituteBullets` may bail on `startedInsideCode`
 * alone because it only ever rewrites a line's *leading* marker, and a fence's opening
 * physical line begins with the sentinel character itself, so its marker regex cannot
 * match there. This pass rewrites the *whole* line, and `wrapCode` emits
 * `SENTINEL + firstContentLine` — the opening physical line already carries real code,
 * and a one-line fenced block carries its entire content on a line that both opens and
 * closes the pair, where `startedInsideCode` is `false`. Bailing only on lines that
 * *start* inside a fence would therefore still split exactly the content this WP exists
 * to protect. So, as in `realignNestedContinuations`: a line that starts inside a fence
 * **or** merely carries a sentinel is returned untouched. Nothing but `wrapCode` ever
 * emits a sentinel, so the stricter form can only ever spare a genuine fence line.
 *
 * **An over-budget fence line therefore overflows**, exactly as fenced code does
 * everywhere else in this tool — the rendering policy is unqualified, and the width gates
 * already exempt these lines by construction, so the overflow is self-consistent rather
 * than a new exemption. Verified rather than assumed: such lines land inside a recorded
 * `codeRange` and stay exempt from `--check` and the sweep.
 *
 * **A continuation line this pass creates may not start `*` or `N.`.** It chooses where
 * lines break, so it chooses whether `isPointedLine` claims one of them — and in an
 * ordered list `numberedLine` then hands that line the item's number and renumbers every
 * later item, while `substituteBullets` (which runs after this pass, over the same body)
 * rewrites a leading `*` into a bullet glyph. Both wrapping overrides guard this via
 * `MARKER_SHAPED_LINE`; this pass shipped without it. Same remedy — re-wrap one column
 * narrower, then give the colliding continuation line one leading guard space, which the
 * exact-multiple-of-four indent group cannot match.
 *
 * **But the trigger is not the overrides' trigger, and copying it verbatim makes this
 * pass *cause* the collision.** Those overrides wrap text that starts at column 0, which
 * is on the four-column grid, so a marker-shaped continuation there is always claimable
 * and one space always takes it off the grid. Here the continuation prefix is whatever
 * the line's own prefix measured — `"    1. "` is **7** columns, already off the grid and
 * already safe — and adding a space to it moves the line *onto* the grid, manufacturing
 * exactly the claimable line the guard exists to prevent. Reproduced on
 * `tests/fixtures/fenced-list.md` at width 55: with the unconditional guard the author's
 * bare `*` was still rewritten to a bullet glyph, and only because the guard had shifted
 * the line from column 7 to column 8. So the guard fires only when the composed
 * continuation would land on the grid.
 */
function rewrapListBody(
  body: string,
  depth: number,
  targetWidth: number,
  outerColumns: number,
  measure: Measure,
): string {
  const budget = currentListBudget(depth, targetWidth, outerColumns);
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

// Shared by the `hr` override and the frontmatter divider (WP-3): the text of a
// horizontal rule at `targetWidth`, in the given glyph tier. `marked-terminal`'s own
// `hr()` helper (`index.js:612`) is `new Array(length).join(ch)`, which yields
// `length - 1` characters, not `length` — an off-by-one baked into the library that
// both call sites must reproduce exactly, since "the divider matches the document's
// own rule" means matching that rule as the library actually renders it, not redoing
// the arithmetic from scratch. Kept as the *only* place that computes this string so
// the `hr` override (which post-processes marked-terminal's own dash run — there is
// library output to rewrite) and the divider (which has no library output to
// post-process and must construct the rule from nothing) can never drift apart.
// **The repeat count is a column count divided by the glyph's width, not a character
// count** (WP-3). `─` (U+2500) is East Asian *Ambiguous*, so in wide mode it occupies 2
// columns and `repeat(targetWidth - 1)` would emit a rule twice the width of the
// document — over budget on every single frontmatter-carrying file, and a `--check`
// failure that has nothing to do with the prose. AGENTS.md's "every Unicode substitute
// is exactly 1 column, so the tier has no width impact" was a narrow-mode statement;
// the box-drawing set is ambiguous almost in its entirety.
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
 * How many columns `Renderer.prototype.blockquote`'s `quote.trim()` is about to strip
 * off the **first content line** of an already-rendered blockquote body — the second,
 * milder half of WP-2g.
 *
 * `blockquote` is `section(this.o.blockquote(indentify(this.tab, quote.trim())))`
 * (`index.js:106`; `indentify` is `index.js:505`). `indentify` then adds `tab` to
 * *every* line equally, so the trim is the only asymmetry — and it is a real one
 * whenever the body's first line is indented, which is exactly when the first child is
 * a list (`indentLines` has added 4) or a nested blockquote. The rendered list's first
 * item then sits four columns left of its own siblings: visible at any width, and the
 * whole defect at widths where nothing wraps.
 *
 * Only a run of literal spaces counts. `trimStart` also eats tabs and newlines, and a
 * leading blank line is genuinely nothing to restore — the columns to give back are the
 * ones on the *last* line of what the trim removes.
 */
function firstLineIndentTrimmedAway(body: string): number {
  const removed = body.slice(0, body.length - body.trimStart().length);
  const lastLine = removed.slice(removed.lastIndexOf("\n") + 1);
  return /^ *$/.test(lastLine) ? lastLine.length : 0;
}

/**
 * Give those columns back, on the rendered result rather than the input, because the
 * library trims what it is handed and there is no spelling of a leading indent that
 * `String.prototype.trim` will not eat.
 *
 * The spaces go at the very start of the line, *outside* any ANSI the blockquote style
 * opened it with. That is deliberate and it is safe: the default `o.blockquote` is a
 * foreground+italic chalk style, so unstyled leading spaces are indistinguishable from
 * styled ones, and every gate, sweep and detector in this tool measures ANSI-stripped
 * text where the two are literally the same string. Inserting *inside* the escape run
 * would mean parsing it, for no observable difference.
 */
function restoreFirstLineIndent(rendered: string, columns: number): string {
  if (columns <= 0) return rendered;
  const lines = rendered.split("\n");
  const index = lines.findIndex((line) => stripAnsi(line).trim() !== "");
  if (index === -1) return rendered;
  lines[index] = `${" ".repeat(columns)}${lines[index] as string}`;
  return lines.join("\n");
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
 *   widths) *for top-level prose*.
 *
 * **The `paragraph` caller is not confined to top-level prose.** A *loose* list
 * item is parsed into a paragraph token and dispatched through that override
 * with the list still on the stack (`listitem`/`checkbox` are dead seams;
 * `paragraph` is a live one). Until WP-2b that meant every loose item was
 * wrapped here at the **full** `targetWidth`, *before* `list` glued on its
 * marker and indent — leaving the text 6 columns over budget at depth 1 — and
 * `rewrapListBody` then reflowed it a second time, shearing the tail word onto a
 * line of its own: the orphaned-line defect, 12/9/6/7 orphans in
 * `tests/fixtures/loose-list.md` at widths 80/100/120/172.
 *
 * **Closed in WP-2b, and not here.** The fix is in the `paragraph` override
 * itself: inside a list it renders the item through a `marked-terminal` renderer
 * constructed at the item's *real* budget (`targetWidth` minus every marker and
 * indent still to be glued on — see `pendingPrefix` at the call site), so the
 * text arrives already fitting and `rewrapListBody` has nothing to shear. This
 * function is still that path's safety net, just measured against the budget
 * rather than the full width.
 *
 * **Three levers that look right and are not — all measured, do not retry:**
 *
 * - `reflowText: false` leaves list rendering byte-identical (orphans 47 -> 47
 *   over a 300-file corpus sample at width 100): the flag decides *who* wraps
 *   first, not at what width. It also regresses 60 of those 300 documents'
 *   non-list prose, because without the library's reflow the source's own line
 *   breaks survive and this function only touches lines that *exceed* the width.
 * - Wrapping here at `currentListBudget(depth, targetWidth)` is a no-op at depth
 *   1 by construction — that budget accounts only for *ancestor* indents still
 *   pending, and at depth 1 there are none.
 * - Correcting the arithmetic to the true paragraph-time budget and re-wrapping
 *   *here* still does not fix it: this function is a splitter, not a reflower. It
 *   only touches lines already over budget, and the library has by then wrapped
 *   the text at `targetWidth`, so the tail stays sheared.
 *
 * See `plans/crucible-tui-launch.md` WP-2/WP-2b; the fixture is
 * `tests/fixtures/loose-list.md` and the metric lives in `tests/render.test.ts`
 * (no width gate can see this defect — an orphan is *under* the width).
 *
 * **It re-wraps under the line's own prefix, and until WP-2g it did not** — it was
 * `wrapAnsi(line, targetWidth)`, which discards a line's leading indent outright.
 * `src/wrap.ts` tokenizes into words and inter-word spaces and starts each emitted line
 * at a word, so the indent is dropped whether or not the line actually has to be split:
 * an 81-column indented line at width 80 comes back as **one** line at **column 0**.
 * For `paragraph` and `heading` that is harmless — their text starts at column 0 anyway — but the
 * **`blockquote`** caller passes a body `indentify` has already indented, so every
 * over-budget line of a blockquote escaped the blockquote entirely. With a list inside
 * it, the escapee is a *marker* line: the rendered list's bullet at column 0, its
 * siblings still at 8. Measured over the 95 corpus files that put a list inside a
 * blockquote, at widths 80 and 116: **235 column-0 marker lines across 56 files**.
 *
 * The remedy is the shape `rewrapListBody` already uses — `LIST_LINE_PREFIX`, the
 * prefix's width, a continuation prefix of that many spaces — and it is applied here,
 * in the shared helper, rather than on the `blockquote` path alone: dropping a line's
 * indent is never the correct thing to do, so the caller is not what makes it wrong.
 * **`paragraph`/`heading` stay byte-identical by construction, not by measurement**:
 * the new path is entered only for a line with leading whitespace, and both of those
 * callers hand this function text that starts at column 0. Verified anyway — 1,181
 * corpus files at two widths, zero differing lines outside blockquote-carrying files.
 *
 * **No marker-shaped-line guard here, deliberately** (contrast `rewrapListBody`). The
 * callers that need one already have it — `wrappedParagraph` tests its own result — and
 * preserving the prefix strictly *reduces* the exposure this function creates, because
 * column 0 is itself on `isPointedLine`'s four-column grid and a preserved list prefix
 * (`"    • "`, 6) usually is not. Adding one would change `paragraph`/`heading` bytes to
 * defuse a collision this change does not introduce.
 *
 * **Fenced code is never rewritten, and this pass had no `SENTINEL` walk either
 * (WP-2g).** A fence inside a blockquote reaches here already bracketed — `wrapCode`
 * resolves depth-first — and an over-budget command line was being split mid-command,
 * invisibly, exactly as `rewrapListBody` split them until WP-2f. The strictness is that
 * pass's stricter form for that pass's reason: this function rewrites the *whole* line,
 * and a one-line fenced block carries all of its content on a line that both opens and
 * closes the sentinel pair, where "started inside a fence" is false. Reproduced on both
 * shapes before the walk went in; both are covered by `tests/fixtures/blockquote-list.md`.
 */
function wrapOverBudgetLines(rendered: string, targetWidth: number, measure: Measure): string {
  let insideCode = false;
  return rendered
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
      if (measure(line) <= targetWidth) return line;

      const match = LIST_LINE_PREFIX.exec(line);
      const indent = match?.[1] ?? "";
      const prefix = `${indent}${match?.[2] ?? ""}`;
      const rest = line.slice(prefix.length);
      // Two fall-throughs to the pre-WP-2g behaviour, both load-bearing. A line with no
      // leading whitespace is what `paragraph`/`heading` always hand us, and taking the
      // old path for it makes those two callers byte-identical rather than merely
      // measured-equal — note `LIST_LINE_PREFIX` would otherwise claim a *paragraph*
      // opening `"1. "` as a marker. And a line that is nothing but indent has no text
      // to hang a continuation under, so preserving its prefix would just leave the
      // whitespace over budget where the old path collapsed it away.
      if (indent === "" || rest === "") return wrapAnsi(line, targetWidth, measure).join("\n");

      const prefixWidth = measure(prefix);
      const continuationPrefix = " ".repeat(prefixWidth);
      return wrapAnsi(rest, Math.max(1, targetWidth - prefixWidth), measure)
        .map((wrapped, index) => (index === 0 ? `${prefix}${wrapped}` : `${continuationPrefix}${wrapped}`))
        .join("\n");
    })
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
 *   marks relative to `string-width`. `paragraph` does one thing more: inside a list
 *   it is the *only* wrap of a loose item's text, and renders it at the item's own
 *   budget rather than the full width (WP-2b — the orphaned-line defect).
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
  // the compiled binary. **That saving does not exist** (see `AGENTS.md`'s emoji
  // section) — `marked-terminal` imports `node-emoji` at module top level and the
  // option only picks a function at runtime (`this.emoji = this.o.emoji ?
  // insertEmojis : identity`), so the dependency is bundled either way.
  //
  // The real conclusion (also `AGENTS.md`): this is a *terminal-capability*
  // question, not a constant. Rendering `:rocket:` as 🚀 requires a terminal that
  // can draw it, which is exactly what `glyphs.tier` already models — Unicode
  // renders the glyph, ASCII cannot and keeps the literal shortcode — with
  // `emojiOverride` (threaded from `MdviewConfig.emoji`, `src/config.ts`) able to
  // force either direction regardless of tier. `emojiOverride ?? tier-based` is
  // deliberately computed **once, here**, and handed to all three `markedTerminal`
  // constructions below (this one and the two per-budget caches) so substitution
  // can never disagree between a document's top-level text and a loose list
  // item's or blockquote's, which render through a second, separately-constructed
  // extension — see `paragraphRendererAt`/`headingRendererAt`.
  //
  // The caches themselves need no *key* change: `budgetedParagraphs` and
  // `budgetedHeadings` are declared inside this function (recreated on every call
  // to `renderDocumentDetailed`), so every entry in a given call's map is already
  // built under this same call's single `emoji` value — there is no cross-tier
  // reuse for a compound key to prevent. The bug this WP actually guards against
  // is subtler: forgetting to pass `emoji` to those two constructions at all,
  // which would silently default them to the library's own `true` regardless of
  // tier — making list/blockquote-nested substitution disagree with top-level
  // substitution at the ASCII tier specifically. Pinned in
  // `tests/render.test.ts`'s emoji-tier describe block.
  //
  // `insertEmojis` (`marked-terminal`) appends a stray space after every glyph
  // (`emojiSign + ' '`) that was never in the source. Reflow absorbs it when more
  // text follows on the same line; at the true end of a rendered line it is
  // trailing whitespace this tool did not put there, and it survives independent
  // of ANSI styling (`chalk.reset`/`chalk.green.bold` etc. wrap the whole segment,
  // so the space sits *before* their closing SGR codes, not after). Stripped
  // uniformly, once, by `stripEmojiTrailingSpace` below, skipping fenced code
  // (`codeRanges`) so a literal emoji+space the user actually typed inside a fence
  // is never touched. Shortcodes inside fences stay literal regardless —
  // `marked-terminal`'s `code` renderer never runs the transform at all, so this
  // needs no special case there; verified by test.
  const emoji = emojiOverride ?? glyphs.tier === "unicode";
  const extension = markedTerminal({ width: targetWidth, reflowText: true, emoji });
  const renderer = extension.renderer;
  if (renderer) {
    renderer.table = (token: Tokens.Table) => renderTable(token, targetWidth, glyphs, measure);

    // Columns that block renderers still owe every line of whatever is being rendered
    // *right now*, because they are glued on only after that inner render returns: a
    // list level's own marker plus its blanket indent, a blockquote's indent. Each
    // block renderer pushes its own contribution for the duration of its call, so at
    // any point inside, the sum is exactly how much narrower than `targetWidth` the
    // text being produced has to be. This is what lets the `paragraph` override wrap a
    // *loose* list item once, at the width the item will actually occupy — see its
    // comment below and `wrapOverBudgetLines`'s.
    const pendingPrefix: Array<{ columns: number; list: boolean }> = [];
    const pendingPrefixWidth = (): number => pendingPrefix.reduce((sum, entry) => sum + entry.columns, 0);
    const listDepth = (): number => pendingPrefix.reduce((count, entry) => count + (entry.list ? 1 : 0), 0);
    // The still-pending columns that are *not* a list's own — today, an enclosing
    // blockquote's `indentify`. `currentListBudget` counts list levels itself (from
    // `depth`), so double-counting them here would narrow every nested list twice.
    const outerColumns = (): number =>
      pendingPrefix.reduce((sum, entry) => sum + (entry.list ? 0 : entry.columns), 0);

    // Non-zero while a renderer that dispatches *inline* tokens is on the stack. Only
    // `paragraph` and `heading` do so anywhere a list can reach (`table` is replaced
    // wholesale by `renderTable`, which never calls `parseInline`; `blockquote`'s
    // children are blocks). This is one of the three conditions that tell a *tight list
    // item's own block text token* apart from an ordinary inline text token — see the
    // `text` override below.
    let inlineDepth = 0;

    const originalList = renderer.list;
    if (originalList) {
      renderer.list = function wrappedList(token: Tokens.List) {
        pendingPrefix.push({ columns: LIST_INDENT_PER_LEVEL + listMarkerWidth(token), list: true });
        const depth = listDepth();
        const outer = outerColumns();
        try {
          // `this` is contextually `_Renderer` here (the target this function is
          // assigned to declares `this: _Renderer`); forwarding it is what keeps
          // `originalList`'s own internal `this.o`/`this.tab`/`this.parser` reads
          // working exactly as they would un-overridden.
          const result = originalList.call(this, token);
          if (result === false) return false;
          // **Per level, and before `rewrapListBody` — both are load-bearing** (WP-2e).
          //
          // *Per level*, because the drift this pass subtracts is the marker width
          // *this* call's `bulletPointLines`/`numberedLines` just added, and that is
          // only knowable here: at the outermost list the drifts of every ancestor have
          // already summed, and with ordered levels of differing marker widths (`"* "`
          // is 2, `"1. "` is 3, `"10. "` is 4) the sum cannot be decomposed back into
          // the per-level amounts a legitimate nested blockquote or fence has to be
          // measured against. Correcting at every level also means the drift never
          // reaches an inner `rewrapListBody` at all, so `currentListBudget`'s
          // 4-columns-per-ancestor arithmetic becomes exactly true rather than an
          // under-estimate.
          //
          // *Before* `rewrapListBody`, because a line that is no longer over-indented is
          // no longer over budget, so there is nothing left to shear — the orphan goes
          // away as a consequence of the indent being right, not as a second fix.
          const realigned = realignNestedContinuations(result, measure);
          const rewrapped = rewrapListBody(realigned, depth, targetWidth, outer, measure);
          // Bullet substitution only runs once this is the outermost call for this
          // top-level list (`depth === 1`) — see `substituteBullets`'s doc comment
          // for why running it at every recursion level corrupts `marked-terminal`'s
          // own `fixNestedLists` marker detection for ancestors still on the stack.
          return depth === 1 ? substituteBullets(rewrapped, glyphs) : rewrapped;
        } finally {
          pendingPrefix.pop();
        }
      };
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
    const originalText = renderer.text;
    if (originalText) {
      renderer.text = function wrappedText(token: Tokens.Text | Tokens.Escape | Tokens.Tag) {
        const result = originalText.call(this, token);
        if (result === false || typeof result !== "string") return result;
        if (listDepth() === 0 || inlineDepth > 0) return result;
        if (!Array.isArray((token as { tokens?: Token[] }).tokens)) return result;
        // Belt and braces on the "fences never reach here" measurement above: a body
        // carrying a code sentinel is returned untouched rather than reasoned about.
        if (!result.includes("\n") || result.includes(SENTINEL)) return result;

        const { segments, coalesced } = coalesceTightItemLines(result);
        // Nothing was joined — the item is a single line, or every break in it is a
        // genuine hard break. Leave it on the pre-WP-2c path rather than re-wrapping
        // text this WP has no reason to touch.
        if (!coalesced) return result;

        const budget = Math.max(1, targetWidth - pendingPrefixWidth());
        const wrapAt = (width: number): string =>
          segments.map((segment) => wrapAnsi(segment, Math.max(1, width), measure).join("\n")).join("\n");

        const wrapped = wrapAt(budget);
        // Same landmine, same guard as `wrappedParagraph` — see `MARKER_SHAPED_LINE`.
        // Every line after the first is still at column 0 when `bulletPointLines` /
        // `numberedLines` run, so one that *starts* `*` or `12.` is taken for a marker
        // line and, in an ordered list, is handed that item's number and rewritten.
        const collides = (text: string): boolean =>
          text.split("\n").slice(1).some((line) => MARKER_SHAPED_LINE.test(line));
        if (!collides(wrapped)) return wrapped;

        return wrapAt(budget - 1)
          .split("\n")
          .map((line, index) => (index > 0 && MARKER_SHAPED_LINE.test(line) ? ` ${line}` : line))
          .join("\n");
      };
    }

    // One `marked-terminal` renderer per distinct list budget, built lazily and reused.
    // Rendering a loose list item's paragraph through a renderer constructed at that
    // budget is what makes the library's *own* reflow produce correctly-sized lines,
    // rather than us un-wrapping and re-wrapping text it already broke — see the
    // `paragraph` override below for why re-wrapping is not an option.
    const budgetedParagraphs = new Map<number, NonNullable<typeof renderer.paragraph>>();
    const paragraphRendererAt = (budget: number): typeof renderer.paragraph => {
      const cached = budgetedParagraphs.get(budget);
      if (cached) return cached;
      // Same `emoji` value as the main construction above, deliberately — see that
      // comment. A per-budget renderer built with a different `emoji` setting would
      // make shortcode substitution depend on whether a paragraph happened to sit
      // inside a list, which is not a distinction this tool's output should make.
      const paragraph = markedTerminal({ width: budget, reflowText: true, emoji }).renderer?.paragraph;
      if (paragraph) budgetedParagraphs.set(budget, paragraph);
      return paragraph;
    };

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
        return result.split(dashes).join(renderRule(glyphs, targetWidth, measure));
      };
    }

    const originalCode = renderer.code;
    if (originalCode) {
      renderer.code = function wrappedCode(token: Tokens.Code) {
        // Normalize the declared language before it reaches marked-terminal's own
        // `highlight()`, which does not throw on an unknown language (its
        // `try`/`catch` never fires) — it logs via `console.error` unconditionally.
        // Never mutate `token`, which `marked` owns; pass a shallow copy carrying the
        // rewritten `lang` instead.
        const normalizedLang = resolveFenceLanguage(token.lang);
        const normalizedToken = normalizedLang === token.lang ? token : { ...token, lang: normalizedLang };
        const result = originalCode.call(this, normalizedToken);
        return result === false ? false : wrapCode(result);
      };
    }

    const originalHtml = renderer.html;
    if (originalHtml) {
      renderer.html = function wrappedHtml(token: Tokens.HTML | Tokens.Tag) {
        const result = originalHtml.call(this, token);
        return result === false ? false : wrapOverBudgetLines(result, targetWidth, measure);
      };
    }

    // Safety net over `marked-terminal`'s own `reflowText` — see
    // `wrapOverBudgetLines`'s doc comment for why these three still occasionally
    // need it despite already being reflowed.
    //
    // **Inside a list this override is not a safety net, it is the wrap** (WP-2b).
    // Every item of a *loose* list is parsed into a paragraph token and dispatched
    // here with the list still on the stack, so rendering it at the full
    // `targetWidth` — as this did until WP-2b — hands `list` text that is already
    // `pendingPrefixWidth()` columns too wide, and `rewrapListBody` then shears the
    // tail of each line onto a line of its own. Rendering it through a renderer built
    // at the item's real budget instead means the text arrives already fitting, and
    // `rewrapListBody`'s pass over it becomes the no-op it documents itself as.
    //
    // Why route through a second `markedTerminal` renderer rather than coalesce this
    // one's output and re-wrap it: by the time a result gets here, `reflowText` has
    // already destroyed the information needed to put it back together. Its wraps and
    // an author's own hard break are both a bare `\n` (`reflowText` splits on the
    // `HARD_RETURN` its `br` emits and joins every section back with `\n`), and a word
    // longer than the width has been hard-split mid-word with no marker, so rejoining
    // with a space corrupts long URLs and paths. Letting the library wrap at the right
    // width in the first place keeps both cases correct by construction, and keeps
    // multi-paragraph items separate for free — each paragraph is its own call here,
    // with nothing joining across them.
    const originalParagraph = renderer.paragraph;
    if (originalParagraph) {
      renderer.paragraph = function wrappedParagraph(token: Tokens.Paragraph) {
        // A paragraph dispatches inline tokens, so anything reaching the `text`
        // override from inside this call is an *inline* text token, never a tight list
        // item's own body — see that override's three conditions.
        inlineDepth += 1;
        try {
          // **The condition is "does anything still owe columns", not "are we in a
          // list"** (WP-2g). It read `listDepth() === 0` until then, on the WP-2b
          // reasoning that a top-level blockquote's own rendering was a separate
          // change — and that was true only while `wrapOverBudgetLines` was quietly
          // *deleting* the blockquote's indent instead of honouring it. A blockquote
          // reflows its children at the full `targetWidth` and then indents the result
          // by 4, so every wrapped line of blockquoted prose is 4 columns over budget;
          // once the safety net stopped discarding the indent to hide that, the net
          // started shearing a word off each of those lines instead — one-word
          // continuations through every quoted paragraph in the corpus. Same defect,
          // same remedy, same seam as a loose list item: render it at the width it
          // will actually occupy and the net goes back to being a no-op.
          if (pendingPrefixWidth() === 0) {
            const result = originalParagraph.call(this, token);
            return result === false ? false : wrapOverBudgetLines(result, targetWidth, measure);
          }

          const budget = Math.max(1, targetWidth - pendingPrefixWidth());
          // The library reflows by `.length`, so the safety net still applies — just at
          // the list's budget rather than the full width.
          const renderAt = (width: number): string | false => {
            const render = paragraphRendererAt(width) ?? originalParagraph;
            const rendered = render.call(this, token);
            return rendered === false ? false : wrapOverBudgetLines(rendered, width, measure);
          };

          const result = renderAt(budget);
          if (result === false) return false;
          const collides = (text: string): boolean =>
            text.split("\n").slice(1).some((line) => MARKER_SHAPED_LINE.test(line));
          if (!collides(result)) return result;

          // See `MARKER_SHAPED_LINE`: re-wrap a column narrower to make room, then give
          // each colliding continuation line the guard space.
          const guarded = renderAt(Math.max(1, budget - 1));
          if (guarded === false) return result;
          return guarded
            .split("\n")
            .map((line, index) => (index > 0 && MARKER_SHAPED_LINE.test(line) ? ` ${line}` : line))
            .join("\n");
        } finally {
          inlineDepth -= 1;
        }
      };
    }

    // The same lazy per-budget cache as `budgetedParagraphs`, for the same reason: a
    // heading inside a blockquote or a list item is reflowed by the library at the full
    // `targetWidth` and *then* indented, so every wrapped line of it is over budget and
    // the safety net shears a word off each one. Re-wrapping the result is not an option
    // here either — `reflowText` has already rendered its own breaks and an author's
    // hard break as the same bare `\n`.
    const budgetedHeadings = new Map<number, NonNullable<typeof renderer.heading>>();
    const headingRendererAt = (budget: number): typeof renderer.heading => {
      const cached = budgetedHeadings.get(budget);
      if (cached) return cached;
      // Same `emoji` value as the main construction above, for the same reason as
      // `paragraphRendererAt`.
      const heading = markedTerminal({ width: budget, reflowText: true, emoji }).renderer?.heading;
      if (heading) budgetedHeadings.set(budget, heading);
      return heading;
    };

    const originalHeading = renderer.heading;
    if (originalHeading) {
      renderer.heading = function wrappedHeading(token: Tokens.Heading) {
        // Like `paragraph`, a heading dispatches inline tokens — see the `text`
        // override. A heading is reachable inside a list item and inside a blockquote.
        inlineDepth += 1;
        const budget = Math.max(1, targetWidth - pendingPrefixWidth());
        let result: string | false;
        try {
          const render = (budget === targetWidth ? originalHeading : headingRendererAt(budget)) ?? originalHeading;
          result = render.call(this, token);
        } finally {
          inlineDepth -= 1;
        }
        return result === false ? false : wrapOverBudgetLines(result, budget, measure);
      };
    }

    const originalBlockquote = renderer.blockquote;
    if (originalBlockquote) {
      // `Renderer.prototype.blockquote` accepts either the token or an already-rendered
      // body string (`index.js:103-105` — it only calls the parser when handed an
      // object). Parsing the children here and handing the string on is what makes the
      // body observable to `firstLineIndentTrimmedAway` below; it is the same single
      // parse the library would have done, not a second render.
      const renderBlockquoteBody = originalBlockquote as unknown as (this: unknown, quote: string) => string | false;
      renderer.blockquote = function wrappedBlockquote(token: Tokens.Blockquote) {
        // A blockquote indents its rendered body by `tab` *after* its children have
        // rendered (`indentify`, `index.js:106`), so anything rendered inside it owes
        // those columns too. Only the list path reads this — a top-level blockquote's
        // own rendering is unchanged, by design: widening its blast radius is a
        // separate change from closing the loose-list defect.
        pendingPrefix.push({ columns: BLOCKQUOTE_INDENT_PER_LEVEL, list: false });
        let body: string;
        try {
          body = typeof token === "string" ? token : this.parser.parse(token.tokens);
        } finally {
          pendingPrefix.pop();
        }
        const lost = firstLineIndentTrimmedAway(body);
        const result = renderBlockquoteBody.call(this, body);
        if (result === false) return false;
        // Restore *before* the width pass, so a first line that the restored columns
        // push over budget is re-wrapped like any other rather than left overflowing.
        return wrapOverBudgetLines(restoreFirstLineIndent(result, lost), targetWidth, measure);
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
): string {
  return renderDocumentDetailed(source, targetWidth, glyphs, measure, emojiOverride).text;
}
