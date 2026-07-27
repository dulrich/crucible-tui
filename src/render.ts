import { Marked } from "marked";
import type { Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import stringWidth from "string-width";
import { renderTable } from "./table";
import { formatMetaBlock, splitFrontmatter } from "./frontmatter";
import { wrapAnsi } from "./wrap";

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

function rewriteTaskState(line: string): string {
  const match = TASK_STATE_LINE.exec(line);
  if (!match) return line;

  const [full, prefix, char, gap] = match;
  // noUncheckedIndexedAccess: capture groups type as string | undefined even though
  // the outer regex guarantees them once `match` is non-null.
  if (full === undefined || prefix === undefined || char === undefined || gap === undefined) {
    return line;
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

function preprocessBody(body: string): string {
  let inFence = false;
  return stripSentinelChar(body)
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      const withTaskState = rewriteTaskState(line);
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
 * - `list` to track nesting depth and reflow over-budget lines (`marked-terminal`
 *   never reflows list items at all — see `currentListBudget` above);
 * - `code` to bracket fenced output in sentinels so `--check` can exempt it;
 * - `html` to reflow swallowed block-HTML paragraphs;
 * - `paragraph`/`heading`/`blockquote` with a thin safety-net re-wrap (see
 *   `wrapOverBudgetLines`) over `marked-terminal`'s own `reflowText`, which measures
 *   width with plain `.length` and can undercount a handful of Unicode punctuation
 *   marks relative to `string-width`.
 *
 * `renderDocument` is a thin wrapper over `renderDocumentDetailed` for callers that
 * only need the final text (every existing caller and test).
 */
export function renderDocumentDetailed(source: string, targetWidth: number): RenderResult {
  const { meta, body } = splitFrontmatter(source);
  const metaBlock = meta !== null ? `${formatMetaBlock(meta, targetWidth)}\n\n` : "";

  const processedBody = preprocessBody(body);

  const instance = new Marked();
  const extension = markedTerminal({ width: targetWidth, reflowText: true });
  const renderer = extension.renderer;
  if (renderer) {
    renderer.table = (token: Tokens.Table) => renderTable(token, targetWidth);

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
          return rewrapListBody(result, listDepth, targetWidth);
        } finally {
          listDepth -= 1;
        }
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

  // `metaBlock` never passes through `code`, so it never carries sentinels; its own
  // line count is a fixed offset onto the body's ranges once the two are joined.
  const metaLineOffset = metaBlock === "" ? 0 : metaBlock.split("\n").length - 1;
  const codeRanges: Array<[number, number]> = bodyRanges.map(([start, end]) => [
    start + metaLineOffset,
    end + metaLineOffset,
  ]);

  return { text: `${metaBlock}${strippedBody}`, codeRanges };
}

export function renderDocument(source: string, targetWidth: number): string {
  return renderDocumentDetailed(source, targetWidth).text;
}
