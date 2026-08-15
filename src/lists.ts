/**
 * Owned list composition — `list`, `listitem` and `checkbox` (WP-4 of
 * `plans/marked-terminal-replacement.md`).
 *
 * These three were the last block seams still executing `marked-terminal` code, and two of
 * the three were **unreachable as overrides**: `markedTerminal()`'s `funcs.reduce`
 * (`index.js:390-400`) makes every wrapper call `r[fn](...)` on one shared *internal*
 * `Renderer` instance, so `list()`'s own `this.listitem(...)` call and `listitem()`'s own
 * `this.checkbox(...)` call always resolved to the library's prototype methods no matter
 * what was assigned onto the extension object. Owning `list` is the only way to reach
 * either — which is why the two live defects this package fixes could not be fixed from
 * outside, and why three separate repair passes grew up around the seam instead.
 *
 * ## What this module reproduces, and what it deliberately changes
 *
 * The pipeline is transcribed from `marked-terminal@7.3.0` line by line:
 * `Renderer.prototype.list` (`index.js:139-153`), `Renderer.prototype.listitem`
 * (`:155-192`), `Renderer.prototype.checkbox` (`:194-199`), and the helpers `indentLines`
 * (`:501-503`), `POINT_REGEX` (`:510-513`), `fixNestedLists` (`:516-529`), `isPointedLine`
 * (`:532-534`), `toSpaces`/`BULLET_POINT`/`bulletPointLines` (`:536-548`),
 * `numberedPoint`/`numberedLine`/`numberedLines` (`:550-578`), the `defaultOptions.list`
 * function (`:580-584`) and `section` (`:586-588`).
 *
 * Exactly **two** behaviours are changed, both live defects, both enumerated in
 * `plans/marked-terminal-replacement.md`'s Verification amendment: **B1**, ordered
 * renumbering (see `composeOrdered`), and **B2**, task states (see `renderTaskState`).
 *
 * **B2 is closed here, but `src/render.ts`'s `rewriteTaskState` source pre-pass survives**,
 * and that is a measurement, not an omission. The plan's WP-4 text says this package
 * "deletes `rewriteTaskState`, `TASK_STATE_SENTINEL` and the GFM-lexer-defeating source
 * pre-pass entirely". Deleting it was implemented, gated against the validation corpus, and
 * **withdrawn**: `preprocessBody`'s fence toggle counts every ` ``` ` line while `marked`
 * pairs fences by nesting and info string, and the two go out of phase on real files — so
 * the pre-pass today rewrites task-shaped lines that `marked` treats as *code*, plus every
 * such line in an indented code block, which it never sees as a fence at all. Measured:
 * **211 such lines across 11 of 4,786 corpus files**, four combos flagged **class C** by
 * the WP-1 harness at two axes alone. Not rewriting them is a *fix*, and is still a change
 * to bytes inside a recorded `codeRange`, which is forbidden at every package. What lands
 * here is the half that needs no such change: the two positions the pre-pass's regex cannot
 * reach and the library therefore rendered — see `renderTaskState`.
 *
 * ## The marker literal is still `"* "`, and that is a decision, not an omission
 *
 * This package's brief specified emitting the glyph-tier bullet (`•`/`◦`/`‣`, or `-`)
 * directly at composition time so that `substituteBullets` could be deleted. **That does
 * not survive contact, for two independent measured reasons**, so the tier bullet is still
 * substituted in one pass over the finished body of the outermost list:
 *
 * 1. **`isPointedLine` would have to widen, and widening it moves fenced code.**
 *    `bulletPointLines` pads every line the predicate does *not* claim. A fenced block
 *    inside a list item is `indentify`-ed by four columns before `list` ever sees it, so a
 *    fence line whose content begins `- ` arrives as `"    - …"` — which a predicate
 *    widened to the ASCII tier's `-` bullet would claim, dropping the two-column pad from
 *    a line **inside a `codeRange`**. That is parity class C, forbidden at every package,
 *    and no width gate in this repo can see it (code ranges are exempt from all of them).
 *    The same argument applies one level up to `fixNestedLists`' `POINT_REGEX`.
 * 2. **The bullet a line gets is chosen by its rendered indent, not by its list depth, and
 *    the two disagree.** `substituteBullets` reads depth back out of `indent.length / 4`.
 *    A blockquote also indents by four, and it does so *after* its children have rendered,
 *    so a list inside a blockquote inside a list is drawn with the depth-**3** bullet at
 *    nesting depth 2. Verified at the base commit: `- outer` / `  > - quoted` renders `•`
 *    then `‣`, not `•` then `◦`. Emitting from the composer's own `listDepth()` would have
 *    changed those lines — a third, ungranted diff family.
 *
 * What owning composition *does* remove is the reason the substitution was restricted to
 * the outermost list: it is no longer racing `fixNestedLists`' marker detection for
 * ancestors still on the stack, it is simply the last pass over a finished body. Deleting
 * it outright belongs with the other post-composition passes, in WP-5.
 */
import type { Token, Tokens } from "marked";
import { transform } from "./blocks";
import type { GlyphSet } from "./glyphs";
import { applyStyle, createStyler } from "./inline";
import type { LayoutContext } from "./layout-context";

/**
 * `this.tab` — `index.js:59`, `sanitizeTab(this.o.tab, 4)` with no `tab` option passed by
 * this repo, so `new Array(5).join(' ')`: **four spaces, as a string**. Every helper below
 * receives that string, never the number.
 */
const TAB = "    ";

/** `BULLET_POINT` — `index.js:540`. The literal every item's first line is composed with. */
const BULLET_POINT = "* ";

/**
 * `this.o.listitem` — `defaultOptions.listitem`, `index.js:37`: `chalk.reset`.
 *
 * It wraps **every item's composed text** in `\x1b[0m…\x1b[0m` whenever the colour level is
 * non-zero, and is the identity at level 0. A parity run without `FORCE_COLOR` cannot see
 * whether this was reproduced at all, which is why both settings are gated.
 */
const LIST_ITEM = createStyler("reset");

/** `section()` — `index.js:586-588`. */
function section(text: string): string {
  return `${text}\n\n`;
}

/**
 * `indentLines()` — `index.js:501-503`.
 *
 * **Not `indentify` (`:505-508`).** This one's regex requires at least one character after
 * the line start, so an empty line stays empty; `indentify` indents every line including
 * empty ones. `code` and `blockquote` use `indentify`; `list` uses this one. Reaching for
 * the wrong one changes trailing whitespace on every blank line in every list in the
 * corpus.
 */
function indentLines(indent: string, text: string): string {
  return text.replace(/(^|\n)(.+)/g, `$1${indent}$2`);
}

// `index.js:510-513`. Kept exactly as the library spells it — `\*` and `\d+\.`, **not** the
// glyph tier's bullets. See this module's header for why widening this vocabulary is a
// class-C hazard rather than a tidy-up.
const BULLET_POINT_REGEX = "\\*";
const NUMBERED_POINT_REGEX = "\\d+\\.";
const POINT_REGEX = `(?:${BULLET_POINT_REGEX}|${NUMBERED_POINT_REGEX})`;

/**
 * `fixNestedLists()` — `index.js:516-529`, "prevents nested lists from joining their
 * parent list's last line".
 *
 * A nested list reaches its parent item through `parser.parse`'s concatenation, with no
 * separator: `"alpha" + "    * sub\n\n"` is one physical line. This regex finds the join —
 * last character of the parent's text, up to two spaces, a multiple-of-four run, then a
 * marker — and inserts the missing newline plus one level of indent.
 *
 * **Composing the nested list onto its own line instead was tried and rejected.** It is
 * byte-identical only while the parent's own text ends in zero, one or two spaces; at
 * three the regex cannot match at all (`(?: |  )?` leaves a non-multiple-of-four run) and
 * the library leaves the list joined, and at four or more it splits but keeps the extra
 * run. Reproducing those three cases structurally is strictly more code than transcribing
 * the regex that produces them.
 */
function fixNestedLists(body: string, indent: string): string {
  const regex = new RegExp(`(\\S(?: |  )?)((?:${indent})+)(${POINT_REGEX}(?:.*)+)$`, "gm");
  return body.replace(regex, `$1\n${indent}$2$3`);
}

/**
 * `isPointedLine()` — `index.js:532-534`: `^(?:<tab>)*(?:\*|\d+\.)`.
 *
 * Three things about it are load-bearing and all three are easy to "improve" by accident:
 * the indent is an **exact multiple of four** (which is what makes the one-column guard
 * space in `src/render.ts`'s wrapping seams work), **no space is required after the
 * marker** (so `1.5x` at column 0 is a marker), and the vocabulary is the two literals
 * above and nothing else (so a fence line beginning `- ` is *not* one, and keeps the
 * two-column pad the library gives it).
 */
function isPointedLine(line: string, indent: string): boolean {
  return new RegExp(`^(?:${indent})*${POINT_REGEX}`).test(line);
}

/** `toSpaces()` — `index.js:536-538`. */
function toSpaces(str: string): string {
  return " ".repeat(str.length);
}

/** `numberedPoint()` — `index.js:550-552`. */
function numberedPoint(n: number): string {
  return `${n}. `;
}

/**
 * Obsidian's custom checkbox states, mapped to terminal glyphs.
 *
 * Moved here from `src/render.ts` in WP-4 — it is the table both the surviving source
 * pre-pass (`rewriteTaskState`, which imports it back from here) and the composition-time
 * renderer below have to agree about. Kept aligned with an in-house web markdown renderer
 * working over the same corpus: same states, same meanings, terminal glyphs instead of
 * mounted SVG icons, because there is no DOM here.
 */
export const TASK_GLYPHS: Record<string, string> = {
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

/**
 * A GFM-recognised task marker as the **author** wrote it, read back off `item.raw`.
 *
 * `marked` has already consumed the checkbox by the time a renderer sees the item
 * (`marked.cjs:524-528`: `istask = /^\[[ xX]\] /`, then
 * `itemContents.replace(/^\[[ xX]\] +/, '')`), leaving only `item.checked`, a boolean —
 * which cannot tell `[x]` from `[X]`, and the ASCII tier ships the author's own literal.
 * The **space run** matters for the same reason: `marked` strips every space after the
 * bracket, so `- [x]  two` would otherwise come back a column narrower than it went in.
 * Both are recovered here. `( *)` and not `(\s*)` deliberately — `marked`'s own strip is
 * ` +`, so a tab after the bracket survives into the item text and must not be eaten twice.
 */
const RAW_TASK_STATE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]( *)/;

/**
 * Render a GFM task item's state — **parity class B, family B2**.
 *
 * ### What this replaces, and what it deliberately does not
 *
 * `Renderer.prototype.checkbox` (`index.js:194-199`) rendered **every** state as
 * `'[' + (checked ? 'X' : ' ') + '] '`, and `listitem:190` appended a second space after
 * it: uppercase, double-spaced, no glyph, in **both** glyph tiers. It was an unreachable
 * seam — `list()`'s internal `this.listitem(...)` ran against the library's own `Renderer`
 * instance — so the only way to stop it firing was to keep `marked` from ever lexing a
 * task item, which is what `src/render.ts`'s `rewriteTaskState` source pre-pass does.
 *
 * **That pre-pass is still there and this does not replace it.** Its regex is anchored on
 * `^\s*[-*+]\s+`, so exactly two positions escape it and reach `marked` as real GFM task
 * items: an item inside a **blockquote** (`>` is not in `[-*+]`) and an item in an
 * **ordered** list (`1.` is not either). Those are the only items that arrive here with
 * `item.task === true`, and they are precisely the ones the library was rendering wrong.
 * Rendering them under the same tier rule as everywhere else is family B2.
 *
 * **Deleting the pre-pass outright is out of reach and the measurement says so** — see
 * this WP's report, §4. `preprocessBody`'s fence toggle counts every ` ``` ` line, while
 * `marked` pairs fences by info-string and nesting, and the two go out of phase on real
 * corpus files; the pre-pass therefore rewrites task-shaped lines that `marked` treats as
 * **code**, and indented code blocks it never sees as fences at all. Measured: **211 such
 * lines in 11 of 4,786 corpus files.** Removing the pre-pass stops corrupting them —
 * which is a *fix*, and is still a change to bytes inside a recorded `codeRange`, i.e.
 * parity class C, forbidden at every package. Full removal needs its own package with its
 * own approved class.
 *
 * ### Why it mutates the token rather than prefixing the composed string
 *
 * `listitem` prefixed the *rendered* string (`:190`, `text += checkbox + ' '`), which is
 * why the library's checkbox never participated in an item's own wrap. The pre-pass does
 * the opposite — it edits the source, so the glyph is inside the text `src/render.ts`'s
 * `text` seam measures and wraps. Prefixing the composed string here would leave these
 * items wrapped against a budget two columns too generous, which is a difference in kind
 * from how every *other* task item in the document is laid out. Mutating the item's first
 * inline text token puts the glyph exactly where the pre-pass puts it.
 *
 * Returns a string prefix for the one case with no inline token to reach — an item whose
 * first child is a fence, a table or a nested list — which is the library's own fallback
 * shape.
 */
function renderTaskState(ctx: LayoutContext, item: Tokens.ListItem): string {
  if (!item.task) return "";

  const match = RAW_TASK_STATE.exec(item.raw ?? "");
  const char = match?.[1] ?? (item.checked ? "x" : " ");
  const gap = match?.[2] ?? " ";
  const glyph = ctx.glyphs.rewriteTaskStates ? TASK_GLYPHS[char] : undefined;
  // Per the plan's locked decision the ASCII tier leaves task states literal
  // (`- [x] done` stays `- [x] done`) rather than inventing ASCII substitutes.
  const prefix = glyph === undefined ? `[${char}]${gap}` : `${glyph}${gap}`;

  const first = item.tokens[0] as { type?: string; text?: string; tokens?: Token[] } | undefined;
  const inline =
    first !== undefined && (first.type === "text" || first.type === "paragraph") && Array.isArray(first.tokens)
      ? first.tokens
      : undefined;
  if (inline === undefined) return prefix;

  const head = inline[0] as Tokens.Text | undefined;
  if (head !== undefined && head.type === "text") {
    head.text = `${prefix}${head.text}`;
    head.raw = `${prefix}${head.raw}`;
  } else {
    inline.unshift({ type: "text", raw: prefix, text: prefix } as Token);
  }
  if (first !== undefined && typeof first.text === "string") first.text = `${prefix}${first.text}`;
  return "";
}

/**
 * One list item's composed text, without its marker — `Renderer.prototype.listitem`
 * (`index.js:155-192`) minus the `'\n' + BULLET_POINT` the caller prepends.
 *
 * The order is the library's and every step of it is observable:
 *
 * 1. the task-state prefix, when the item carries one (`:159-181`);
 * 2. `this.parser.parse(item.tokens, !!item.loose)` (`:184`);
 * 3. `text.trim()`, **only when the text contains a newline** (`:187-188`);
 * 4. `compose(this.o.listitem, this.transform)` (`:186`) — and `compose` runs **right to
 *    left** (`:655-664`), so it is `chalk.reset(undoColon(unescape(insertEmojis(text))))`.
 *
 * Step 3 before step 4 is not interchangeable: under colour, `chalk.reset`'s escape is the
 * first character of the transformed string, so a trim afterwards would trim nothing.
 */
function composeItem(
  ctx: LayoutContext,
  item: Tokens.ListItem,
  parse: (tokens: Token[], top: boolean) => string,
): string {
  let text = renderTaskState(ctx, item);
  text += parse(item.tokens, !!item.loose);
  const isNested = text.indexOf("\n") !== -1;
  if (isNested) text = text.trim();
  return applyStyle(ctx, LIST_ITEM, transform(ctx, text));
}

/**
 * `Renderer.prototype.list` — `index.js:139-153` — together with the `defaultOptions.list`
 * function (`:580-584`) it reaches through `this.o.list`.
 *
 * The library's shape is `section(fixNestedLists(indentLines(tab, list(body, ordered,
 * tab)), tab))` over a `body` built by concatenating `'\n' + '* ' + transform(itemText)`
 * per item. This is that, restructured so each item's lines stay attributable to the item
 * that produced them — which is the mechanism family B1 needs and a flat string cannot
 * offer.
 *
 * **The restructuring is provably equivalent, not approximately so.** The library does
 * `body.trim()`, then `split('\n')`, then `.filter(identity)`, then a per-line map.
 * `join('\n')` and `split('\n')` are inverses at segment boundaries, so the concatenation
 * of each segment's own `split`/`filter` is exactly the global one; and `trim()` on the
 * joined string can only reach the first segment's head and the last segment's tail,
 * because every segment begins with the non-blank `"* "`.
 *
 * `.filter(identity)` drops **empty** strings only, never whitespace-only ones — which is
 * where a loose item's blank lines disappear, and why a blockquote's `indentify`-ed blank
 * line (four spaces) survives instead.
 */
export function renderList(
  ctx: LayoutContext,
  token: Tokens.List,
  parse: (tokens: Token[], top: boolean) => string,
): string {
  const segments = token.items.map((item) => `${BULLET_POINT}${composeItem(ctx, item, parse)}`);
  if (segments.length > 0) {
    // `body.trim()` (`index.js:581`), split across the only two segments it can reach.
    segments[0] = (segments[0] as string).replace(/^\s+/, "");
    const last = segments.length - 1;
    segments[last] = (segments[last] as string).replace(/\s+$/, "");
  }
  const groups = segments.map((segment) => segment.split("\n").filter((line) => line !== ""));

  const lines = token.ordered ? composeOrdered(groups) : composeUnordered(groups);
  return section(fixNestedLists(indentLines(TAB, lines.join("\n")), TAB));
}

/**
 * `bulletPointLines()` — `index.js:545-548`. Every line `isPointedLine` does not claim is
 * padded by the marker's own width, which aligns a continuation under its item's text.
 *
 * It pads a nested list's continuation lines too, because they are not marker lines; that
 * drift is what `realignNestedContinuations` in `src/render.ts` subtracts back off. It is
 * reproduced here rather than fixed at source: not padding them would move the indent of a
 * fenced block nested inside a list item, which is content inside a `codeRange` and
 * therefore class C. Removing the drift *and* the pass that subtracts it, together, is
 * WP-5's — it owns every pass that sits beside it.
 */
function composeUnordered(groups: string[][]): string[] {
  const pad = toSpaces(BULLET_POINT);
  const lines: string[] = [];
  for (const group of groups) {
    for (const line of group) lines.push(isPointedLine(line, TAB) ? line : pad + line);
  }
  return lines;
}

/**
 * Ordered numbering — **parity class B, family B1**.
 *
 * ### What it replaces
 *
 * `numberedLines()` (`index.js:565-578`) walks the *whole composed body* with a single
 * counter and asks `isPointedLine` whether each line is a marker. A nested list's markers
 * are already in that body and they match, so every one of them **consumes the parent's
 * counter** and is rewritten into the parent's sequence by `numberedLine`'s
 * `line.replace(BULLET_POINT, …)` — a plain string replace, which finds the first `"* "`
 * *anywhere* in the line and not necessarily at its head. Reproduce it at the base commit:
 *
 * ```text
 * source              base commit renders     correct
 * 1. alpha                1. alpha                1. alpha
 *     - sub one               ◦ sub one               ◦ sub one
 *     - sub two               2. sub two              ◦ sub two
 * 2. beta                 3. beta                 2. beta
 * 3. gamma                4. gamma                3. gamma
 * ```
 *
 * Measured on the validation corpus: **486 of 4,779 files (10.2%), 900 of 6,343 ordered
 * lists (14.2%)** contain an ordered list with a nested list, and every one of them renders
 * wrong today. Unordered parents are unaffected — `bulletPointLines` only pads, it never
 * renumbers — which is why this package's parity stages split by list kind and not by width
 * or tier.
 *
 * **And it is a chalk-level-0 defect, which nothing in the plan knew.** `chalk.reset`'s
 * `applyStyle` encases newlines, inserting the open code immediately after each `\n` —
 * *ahead of that line's own indent*. `isPointedLine` needs the marker after an exact
 * multiple of four **spaces**, so once styling is on it can never claim a nested marker
 * line, the parent's counter is not consumed, and the library already numbers correctly.
 * Verified at the base commit under `FORCE_COLOR=3`: the worked example above renders
 * `1. 2. 3.` with both child bullets intact. So this fix is visible in the colourless path
 * — a pipe, `--check`, both sweeps, `bun test`, CI — and not in a terminal. The same
 * escape is why `realignNestedContinuations` is inert under colour; see this WP's report.
 *
 * ### What this does instead
 *
 * Numbers each level from its own `token.items`, one number per item, and never looks at a
 * line a nested level produced. The continuation pad still tracks the item's own marker
 * width (`toSpaces` of that number), which is what the library intended and what it
 * achieves whenever nothing is nested — so an ordered list with no nested list inside it is
 * byte-identical either way, and that is most of the corpus.
 *
 * The `line.replace(BULLET_POINT, marker)` on the item's first line is the library's own
 * spelling, kept: composition put `"* "` at the head of that line one function ago, so the
 * first occurrence *is* the head. The landmine the string-replace form carries — rewriting
 * a `"* "` inside an author's `**bold**` on a *continuation* line — is gone with the
 * counter walk, because continuation lines no longer go through this branch at all.
 *
 * **`token.start` stays ignored.** `Renderer.prototype.list` reads it at `:142` and never
 * uses it, so a list authored `5.` renders `1.`. Honouring it would be a third diff family
 * this package was not granted; it is recorded here as a deliberate deferral, not an
 * oversight.
 */
function composeOrdered(groups: string[][]): string[] {
  const lines: string[] = [];
  groups.forEach((group, index) => {
    const marker = numberedPoint(index + 1);
    const pad = toSpaces(marker);
    group.forEach((line, position) => {
      if (position === 0) {
        lines.push(line.replace(BULLET_POINT, marker));
        return;
      }
      lines.push(isPointedLine(line, TAB) ? line : pad + line);
    });
  });
  return lines;
}

/**
 * Substitute the glyph tier's bullet for the literal `"* "` composition emits.
 *
 * Kept as a separate pass over the finished body, and kept at the outermost list level
 * only — see this module's header for the two measurements that decided it. `glyphs` and
 * the code-range `sentinel` are threaded rather than reached for, so this module reads no
 * environment and owns no second copy of `src/render.ts`'s sentinel character.
 *
 * Depth is read back out of the line's own indentation (`indent.length / 4`) rather than
 * passed down the recursion, and that is the rule the rendered output actually follows: a
 * blockquote contributes four columns of its own, so a list inside a quoted list is drawn
 * with the third bullet even though its nesting depth is two.
 *
 * `insideCode` is tracked per **`sentinel` occurrence**, not per line, because a one-line
 * fenced block opens and closes on the same physical line. A line that *starts* inside a
 * fence is returned untouched: fenced code is never rewritten, and no width gate in this
 * repo can see it if it is.
 */
export function substituteBullets(body: string, glyphs: GlyphSet, sentinel: string): string {
  let insideCode = false;
  return body
    .split("\n")
    .map((line) => {
      const startedInsideCode = insideCode;
      for (const ch of line) {
        if (ch === sentinel) insideCode = !insideCode;
      }
      if (startedInsideCode) return line;

      return line.replace(UNORDERED_MARKER_LINE, (_match, indent: string, gap: string) => {
        const depth = Math.max(1, Math.round(indent.length / TAB.length));
        const bullet = glyphs.bullets[(depth - 1) % glyphs.bullets.length] ?? glyphs.bullets[0] ?? "*";
        return `${indent}${bullet}${gap}`;
      });
    })
    .join("\n");
}

/**
 * An unordered item's leading marker exactly as composition emits it: this level's own
 * indent, then the literal `*`, then the one space that always follows it.
 *
 * **The indent is the four-column grid, not `\s*`.** This pass runs after
 * `rewrapListBody`, which chooses where lines break and can therefore put an author's own
 * bare `*` at the start of a continuation line; `\s*` claimed it and rewrote the author's
 * text into a bullet glyph, and no width gate can see a substitution. Every genuine marker
 * line is on that grid because `indentLines` only ever adds four columns at a time —
 * measured over a 1,000-file corpus sample at five widths, 79,410 substitutions, 0 of them
 * off-grid.
 */
const UNORDERED_MARKER_LINE = /^((?: {4})+)\*(\s)/;
