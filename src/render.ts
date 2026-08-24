import { Marked } from "marked";
import type { Tokens } from "marked";
import { renderTable } from "./table";
import {
  renderCode as renderBlockCode,
  renderHr as renderBlockHr,
  renderHtml as renderBlockHtml,
} from "./blocks";
import { formatMetaBlockDetailed, splitFrontmatter } from "./frontmatter";
import { resolveColourPolicy, type ColourPolicy } from "./colour";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import {
  renderBr,
  renderCodespan,
  renderDel,
  renderEm,
  renderImage,
  renderLink,
  renderStrong,
} from "./inline";
import { resolveFenceLanguage, type FenceLanguageResolver } from "./lang";
import { createLayoutContext } from "./layout-context";
import { createListTextLayout } from "./list-layout";
import { TASK_GLYPHS } from "./lists";
import { TokenWalker, type WalkRendererMethods } from "./walk";
import { NARROW_MEASURE, type Measure } from "./width";
import { type WikiLinkToken, styleWikiLabel, wikiLinkExtension } from "./wikilink";

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
//
// **"Nothing invisible-but-present ever ships" is true colourless and false under colour,
// measured at WP-4 of `plans/renderer-deferred-work.md`.** The character is stripped, but
// under `FORCE_COLOR=3` it has already been handed to the syntax highlighter *inside a code
// block* by the time the strip runs, and the highlighter wraps it in an SGR pair that the
// strip does not remove. The ASCII tier then emits, inside verbatim content:
//
//   base:  "    - [\x1b[31m\x1b[39m ] \x1b[31mFinal\x1b[39m …"
//   clean: "    - [ ] \x1b[31mFinal\x1b[39m …"
//
// — an orphaned, empty colour pair the author never wrote, inside a recorded `codeRange`,
// i.e. parity class C. This is a **third** class-C combo that appears only under colour
// (`classC=2` colourless, `classC=3` forced, same axis set). See `src/AGENTS.md`,
// "Colourless gates cannot see colour-only defects", for why this keeps recurring.
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
//
// **WP-4 of `plans/renderer-deferred-work.md` is that later package. It measured the two
// bullets above and found both wrong, and the narrowing the paragraph directly above
// prescribes is retired rather than deferred.** The paragraph is left standing rather than
// edited so the error stays legible; what replaces it, measured at `2e90d71` over 35,614
// files (the corpus resolves 35,614; the differ's own selection is 4,465 — the "4,837"
// above was a *selection* count, never a corpus count):
//
//   - **the 84 lines are in *fenced* blocks, every one of them.** `codeBlockStyle` is
//     `undefined` on all 84 and the source lines sit at **column 0** — not one is indented.
//     The cause is the fence-*phase* disagreement: an unbalanced ` ``` ` makes `marked`
//     swallow a long region as a single code block (measured: lines 939–1168 in one file,
//     2527–2546 in the other), while the toggle in `preprocessBody` below flips on **every**
//     fence-shaped line, including ones `marked` is treating as that block's *content*, so
//     the two run in opposite phase and this function rewrites inside `marked`'s code.
//     **Teaching this pass about indented code blocks would therefore repair none of them.**
//   - **the 84 are the same 84 over 4,465 files and over 35,614** — the enumeration is
//     complete, not a sample — and their state-char histogram is `{" ": 84}`: **every one
//     is a GFM `[ ]`**. The branch that does the class-C damage is the one
//     `src/lists.ts`'s `renderTaskState` already reproduces byte-for-byte; the non-GFM
//     branch below, this pass's only irreplaceable function, causes **zero** of it.
//   - **"the other 3 change prose, all tracing to a single authored `[/]`" is wrong.** One
//     of the three is that. The other two are a 202-line re-tokenisation that removing this
//     pass *causes* — see `src/AGENTS.md`, "The task-state pre-pass", and the fixture
//     `tests/fixtures/task-ordered-text.md` that guards it.
//
// **The class-C exception to stop rewriting the 84 was requested at WP-4 and the user
// withheld it**, because the same removal breaks more than it repairs. The 84 lines are
// still corrupted today, deliberately, and this pass stays exactly as it is.
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

/**
 * The whole of what this tool does to a document *before* `marked`'s lexer sees it.
 *
 * **Exported for one reason, and it is a gate rather than a convenience** (WP-4 of
 * `plans/colour-policy.md`): the lexer-input witness in `tests/wikilink.test.ts` asserts
 * that this function introduces **no new ESC byte**, by comparing the positions and counts
 * of authored ESC before and after it and by transforming ESC-free sources directly. That
 * claim is about this function's output specifically, and it is not observable from
 * rendered output — a renderer that emits colour correctly can still be putting escapes
 * into its own parser's input, which is exactly what `styleWikiLink` did for the tool's
 * whole life.
 *
 * The witness deliberately asserts *no new* ESC rather than *no* ESC. Decision 1 of that
 * plan scopes "zero escape bytes" to tool-generated ones and requires authored ESC to pass
 * through verbatim, so an absence assertion here would contradict the spec it is meant to
 * enforce and would fail on any document that legitimately contains one.
 */
export function preprocessBody(body: string, glyphs: GlyphSet): string {
  let inFence = false;
  // Strip both sentinel bytes from the incoming source before any mechanism runs — same
  // reasoning for each, kept as two separate calls so neither strip's implementation needs
  // to know the other's code point exists. A NUL would forge a code range; a code point 1
  // would forge a defeated-task-regex marker.
  //
  // **There were three, and the wiki-link pair left with the pre-pass** (WP-2 of
  // `plans/wiki-link-tokenizer.md`). `stripWikiLinkCarriers` sanitized code points 2/3
  // because the *carriers* had internal meaning and a document that wrote them itself could
  // forge a styled span. Recognition is the lexer's now, nothing here emits a carrier, and
  // so those two code points mean nothing to this renderer — under Decision 1's fidelity
  // rule (`plans/colour-policy.md`) a byte this tool assigns no meaning passes through as
  // content, which is grant C4 of the tokenizer plan.
  return stripTaskStateSentinel(stripSentinelChar(body))
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      // **The wiki-link half of this pass is gone** (WP-2 of
      // `plans/wiki-link-tokenizer.md`): `markWikiLinks` ran here, rewriting every `[[…]]`
      // on every non-fence line before the lexer could tell prose from a link destination,
      // an HTML attribute or an indented code block. `src/wikilink.ts`'s inline tokenizer
      // extension does the recognition inside the lexing pass instead, where a verbatim
      // context is protected by construction. What remains is the task-state pre-pass,
      // which is `src/AGENTS.md`'s own separately-dispositioned, user-withheld ground —
      // the two shared a mechanism, not a disposition.
      return rewriteTaskState(line, glyphs);
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
 * **F6 (`runs/dispatch/mt-wp-5-list-item-layout-brief.md:164`, dispatch-brief field-note
 * numbering) is measured here and deliberately not applied.** That label is **not** the F6 of
 * `reviews/2026-07-30-tn-code-review.md`, which is the still-Open *file-size* finding
 * ("implementation and test vertical slices were not decomposed at 1,000 lines") and has
 * nothing to do with code ranges; this comment cited that review until WP-2 of
 * `plans/renderer-deferred-work.md`, and `src/AGENTS.md` repeated the mis-attribution.
 * WP-4's landing note records that this walk "converts a character-granular
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
 *
 * **The two paragraphs above are retained as the record of what WP-6 believed, and WP-2 of
 * `plans/renderer-deferred-work.md` re-ran them: the figures do not survive and the
 * narrowing above must not be applied as written.** Re-measured at `c27766e` over 4,457
 * corpus files (the corpus is live data and no longer enumerates 4,837), ranges and coverage
 * change on the **same** set — 97 files colourless, **282 under `FORCE_COLOR=3`** — so "88"
 * and "110" cannot both describe one run, and 4,980/2,422 were 20-axis sums of a ~235-line
 * per-axis population. Three findings, any one of which blocks it: the predicate is
 * **ANSI-blind**, so an SGR sequence beside a marker reads as the "non-whitespace" that
 * triggers narrowing and under colour it drops **all five** of `tests/fixtures/fenced-list.md`'s
 * ranges — which every gate in `verify` misses because they all run colourless; it **raises**
 * `overIndent` and `orphans`, which no parity class, including class D, permits; and on the
 * coalesced tight-item seam it un-exempts lines carrying real fence content, not only prose.
 * See `src/AGENTS.md`'s deferral entry.
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
 * The policy a caller that passes none gets.
 *
 * **This is the one deliberate impurity in the threading, and it is the same impurity that
 * was here before WP-1 of `plans/colour-policy.md` — moved, named, and made per-call.**
 * `detectInlineColor()` used to be called from inside this function, and its answer was a
 * `supports-color` module global resolved once for the whole process, before the first
 * argument was ever parsed. This reads the environment *now*, at the call, through the one
 * resolver, and any caller that wants determinism passes a policy instead.
 *
 * Keeping the default environment-derived rather than a flat `{color: false}` is load-bearing
 * for exactly one consumer: the colour axis (`scripts/corpus.ts`) re-execs the sweep four
 * times (WP-4 of `plans/colour-modes.md` added the fourth: `on`, `off`, an env-sanitized
 * `default`, and `formats`, pinned via `MDVIEW_COLOR=never` — WP-5 of
 * `plans/colour-policy.md` had it at three) with the colour mode pinned — or, for
 * `default`, deliberately left undecided — in each child's environment, and joins the
 * four digest streams. A default that ignored the environment would make every child
 * render identically — a gate that cannot fail, which is the shape the root `AGENTS.md`
 * forbids by name.
 */
function defaultColourPolicy(): ColourPolicy {
  return resolveColourPolicy({
    env: process.env,
    isTTY: process.stdout.isTTY === true,
    platform: process.platform,
  });
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
 * counted: **0 calls** — so the construction was replaced by a plain object literal.
 *
 * **That literal is consumed by `TokenWalker` (`src/walk.ts`), not by `marked.use()`**
 * (WP-2 of `plans/own-the-token-walk.md`): the walk is this repo's, and the object it
 * dispatches against is a `WalkRendererMethods`. The only `use()` call left in this file
 * registers the wiki-link *tokenizer* extension — `instance.use({ extensions:
 * [wikiLinkExtension] })`, a different call, reaching the lexing pass and nothing else.
 * See the object below for what it has to be and why the four methods this file does not
 * assign are unreachable rather than missing.
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
  policy: ColourPolicy = defaultColourPolicy(),
): RenderResult {
  const { meta, body } = splitFrontmatter(source);
  // The divider is appended *into* `metaBlock` itself, before `metaLineOffset` below is
  // computed from it — not emitted separately into the final concatenation. Emitting it
  // anywhere else would silently shift every code range by the divider's line count,
  // since `metaLineOffset` is derived purely from `metaBlock`'s own newline count.
  // Matches the same rule text a `---` in the body would produce at this width/tier
  // (`renderRule`, shared with the `hr` override below) — present only when frontmatter
  // is present, so a document with none renders byte-identical to before this WP.
  const metaResult =
    meta !== null ? formatMetaBlockDetailed(meta, targetWidth, measure, policy.sgr) : null;
  const metaBlock =
    metaResult !== null ? `${metaResult.text}\n${renderRule(glyphs, targetWidth, measure)}\n\n` : "";

  const processedBody = preprocessBody(body, glyphs);

  const instance = new Marked();
  // **The one extension this repo registers** (WP-2 of `plans/wiki-link-tokenizer.md`).
  //
  // `use({ extensions })` writes `opts.extensions.inline` (`marked.cjs:2215-2222`) and
  // `opts.extensions.startInline` (`:2232-2237`), which is what `instance.lexer(...)` reads
  // — so this affects the **lexing** pass and nothing else. The walk is still this repo's:
  // the extension carries no `renderer` field, so `opts.extensions.renderers` stays empty
  // and `marked`'s own pre-dispatch hook has nothing to dispatch even in principle.
  // `TokenWalker` routes the `wikilink` token to `renderer.wikilink` below.
  //
  // This is `marked` used one level deeper than before and still lexer-only: the
  // dependency-classification rule (root `AGENTS.md`) is unmoved — a tokenizer extension is
  // grammar, it reads no environment and writes no escape byte.
  instance.use({ extensions: [wikiLinkExtension] });
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
  // The colour decision is `policy`'s, resolved by `src/colour.ts` from inputs handed in
  // explicitly, and this is the only place it enters the render. It used to be
  // `detectInlineColor()`, called here, re-deriving a `supports-color` module global that
  // had already resolved — argv sniff included — before this function ever ran.
  //
  // **It is the only authority, and every producer reads it.** `src/table.ts` styled
  // through `@colors/colors`' own environment-only `enabled` flag, and fenced-code
  // highlighting gated on `cli-highlight`'s bundled `chalk` level, until WP-2 of
  // `plans/colour-policy.md` retired both packages. The table styles come from
  // `src/style.ts`'s committed table now and the colorizer is `src/highlight.ts`, so this
  // decision reaches `renderTable` — handed `layout.sgr` below — exactly as it reaches
  // every other producer, and there is no authority left for it to fail to reach. The
  // record of what those two used to decide, and the measurement that closed the gap, is
  // `src/layout-context.ts`'s `color` field and `docs/agents/colour.md`.
  const layout = createLayoutContext({
    width: targetWidth,
    glyphs,
    measure,
    resolveFenceLanguage: resolveFenceLanguageFor,
    emoji,
    sgr: policy.sgr,
    hyperlinks: policy.hyperlinks,
    tmux: policy.tmux,
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
  // itself, `table` is `src/table.ts`'s and never dispatches a cell token. Pinned by a
  // mutation probe that makes all four throw and renders the whole validation corpus at
  // every default axis — see that WP's report. **Since WP-2 of
  // `plans/own-the-token-walk.md` they are not renderer keys at all**: `TokenWalker`
  // dispatches only the eighteen types `Parser` dispatched, and a cell or an item token
  // never was one of them, so there is nothing left for them to fall through *to*.
  //
  // **This object is no longer a `marked` extension** (WP-2 of
  // `plans/own-the-token-walk.md`). It used to be handed to `instance.use({ renderer })`,
  // which required every key to exist on `marked`'s own `Renderer` (`marked.cjs:2251`,
  // which throws otherwise) and wrapped each one so it was called with `this` bound to that
  // `Renderer` — which is where the `this.parser` the visitors below close over came from.
  // Both jobs moved to `src/walk.ts`, which checks that every dispatched method is
  // *supplied* rather than that its name exists upstream, and carries `parser` on the
  // object it dispatches against. Every visitor below is unchanged, including its `this`.
  const renderer: Partial<WalkRendererMethods> = {};
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
  //
  // The last argument is the resolved colour policy, added by WP-2 of
  // `plans/colour-policy.md`: the head and border styles used to be `@colors/colors`'
  // decision inside `src/table.ts`, taken from the environment without consulting `isTTY`,
  // and they are this render's decision now like every other producer's. It is the
  // three-level `sgr` rather than a boolean since WP-2 of `plans/colour-modes.md` — a table
  // is the producer that splits across the modes (bold heads survive `formats`, grey borders
  // do not), so a boolean could not carry the answer it needs.
  renderer.table = (token: Tokens.Table) =>
    renderTable(
      token,
      Math.max(1, targetWidth - layout.prefix.width()),
      glyphs,
      measure,
      layout.sgr,
    );

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
  // The one visitor whose token is not `marked`'s (WP-2 of
  // `plans/wiki-link-tokenizer.md`). It threads the full `LayoutContext` rather than a
  // colour gate alone, because the label's children are dispatched through the inline walk
  // and a `link`/`url` child reaches `renderLink` — which needs `hyperlinks` and `tmux`.
  // That is the whole of grant C5: the label is lexed clean, so the OSC-8 a URL-shaped slug
  // produces is well-formed instead of carrying this chain's close codes inside its
  // destination.
  renderer.wikilink = function ownedWikiLink(token: WikiLinkToken) {
    return styleWikiLabel(layout, token, (tokens) => this.parser.parseInline(tokens));
  };

  // Columns that block renderers still owe every line of whatever is being rendered
  // *right now*, because they are glued on only after that inner render returns: a
  // list level's own marker plus its blanket indent, a blockquote's indent. Each
  // block renderer pushes its own contribution for the duration of its call, so at
  // any point inside, the sum is exactly how much narrower than `targetWidth` the
  // text being produced has to be.
  //
  // The stack itself lives on the `LayoutContext` (`src/layout-context.ts`), which is
  // what makes it reachable from a visitor that is no longer a closure declared inside
  // this function — the whole point of the seam. This alias stays local so that the two
  // call sites left in this file (`html` below, and `table` above, which reads
  // `layout.prefix.width()` directly only because it is assigned above the alias) read
  // exactly as they did. The other readers moved with the state machine: `src/list-layout.ts`
  // declares the same three aliases (`pendingPrefix`, `pendingPrefixWidth`, `listDepth`)
  // over the same stack.
  const pendingPrefixWidth = (): number => layout.prefix.width();

  // **The list/text layout state machine** (WP-R2 of
  // `plans/post-refactor-code-quality-remediation.md`). Five visitors — `list`, `text`,
  // `paragraph`, `heading`, `blockquote` — share a per-render layout state: the
  // `inlineDepth` counter that tells a tight list item's own block text token apart from
  // an inline one, the `quoteColumns` counter `rewrapListBody`'s budget needs, and the
  // pending-prefix stack they push and pop. That state and those five bodies lived inside
  // this function until WP-R2 moved them, unchanged and byte-identical, into
  // `src/list-layout.ts` — which is where the measured reason behind each of them is
  // recorded now.
  //
  // Visitor *assembly* stays here, deliberately: this is still the one place that says
  // which method the walk dispatches to, and the five below read as five assignments like
  // the eleven around them. What moved out is the state and its logic, not the wiring —
  // and the seam takes the `LayoutContext` and the code-range `SENTINEL` as values, so it
  // decides nothing this function has not already resolved.
  const listText = createListTextLayout(layout, SENTINEL);
  renderer.list = listText.list;
  renderer.text = listText.text;
  renderer.paragraph = listText.paragraph;
  renderer.heading = listText.heading;
  renderer.blockquote = listText.blockquote;

  // **The owned block leaves** (WP-3 of `plans/marked-terminal-replacement.md`): `hr`,
  // `code` and `html` are assigned here; `paragraph`, `heading` and `blockquote` are the
  // other three, assigned above from `src/list-layout.ts` because they share this render's
  // layout state. See `src/blocks.ts` for what each reproduces, line by line — including
  // the three branches `highlightCode` takes for a fence (the raw, unstyled code whenever
  // the resolved policy's `sgr` is not `full`; `highlightToAnsi`'s themed spans otherwise
  // — `src/highlight.ts`, this repo's colorizer over `highlight.js` direct; and the flat
  // yellow `CODE` styler when that throws on a language it does not know) and the two
  // orders `paragraph` and `heading` apply styling and reflow in.
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

  // **The seam this repo now owns** (WP-2 of `plans/own-the-token-walk.md`). This was
  // `instance.use({ renderer })` followed by `instance.parse(processedBody, { async: false })`
  // — one call that lexed *and* walked, with `marked`'s `Parser` as the tree walker and the
  // sixteen methods above as its callbacks. The lexer half is kept verbatim; the walk is
  // `src/walk.ts`, which reproduces `Parser`'s full contract (see its header table) and
  // rendered byte-identically across the full differential harness at every axis.
  //
  // `instance.lexer(processedBody)` lexes with `instance.defaults`, where `instance.parse`
  // lexed with `{ ...instance.defaults, async: false }`. Those are the same values —
  // `_getDefaults()` already sets `async: false` (`marked.cjs:17-30`) and `use()` only ever
  // reasserted it — and the lexer reads neither `async` nor `renderer`, so the token stream
  // is identical. `extractCodeRanges` below still receives one flat string; `RenderResult`
  // does not move in this package.
  const walker = new TokenWalker(renderer);

  const renderedBody = walker.parse(instance.lexer(processedBody));
  const { text: strippedBody, codeRanges: bodyRanges } = extractCodeRanges(renderedBody);

  // Deliberately a second, separate pass from `extractCodeRanges` above rather than
  // folded into its character walk: `extractCodeRanges` only ever treats the code-range
  // `SENTINEL` (code point 0) specially, and `TASK_STATE_SENTINEL` (code point 1) is
  // not a newline, so its presence during that walk cannot shift any code range's line
  // numbers — but keeping the two strips as two distinct, separately-named steps means
  // a bug in either one can never silently affect the other's bookkeeping.
  const cleanedBody = stripTaskStateSentinel(strippedBody);

  // **The wiki-link carrier pass stood here and is gone** (WP-2 of
  // `plans/wiki-link-tokenizer.md`). It walked the finished document, styled each balanced
  // pair of code points 2/3 that `preprocessBody` had put into the *source*, and stripped
  // every carrier — an arrangement whose whole reason was that a pre-lexer pass could not
  // make a styling decision and had to defer one to a pass that could. Recognition is the
  // lexer's now and `renderer.wikilink` styles at emission, so there is no deferred decision
  // and no carrier left to consume. Two consequences that used to be pinned here: a wrapped
  // label is no longer encased per line (it is styled *before* the wrap, like every other
  // styled span — grant C2), and a label in a table cell is styled per fragment by
  // `src/table.ts` instead of by a document-wide pass that crossed padding and borders
  // (grant C6a).
  //
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
  policy?: ColourPolicy,
): string {
  return renderDocumentDetailed(
    source,
    targetWidth,
    glyphs,
    measure,
    emojiOverride,
    resolveFenceLanguageFor,
    policy,
  ).text;
}
