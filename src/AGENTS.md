# mdview — `src/`

Renderer internals for the `mdview` command: what each `marked-terminal` override does
and why, the two sentinels, the glyph tier, the command-line surface, ambiguous-width
resolution and the probe, the rendering policy, and the `emoji` re-decision. **The root
`AGENTS.md` is the parent document — read it first**; identity, the two-names decision,
the Stack, the Layout tree, the Run/verify contract, Conventions and the dependency
record live there.

### What we override in `marked-terminal`, and why

The library is used for prose, lists, and code highlighting, but eight of its renderer
methods are replaced or wrapped, in five groups. Each override exists for a measured
reason — do not remove one without re-running the corpus sweep:

| Override | Reason |
|---|---|
| `table` | `marked-terminal` never passes the terminal width to tables and drops `token.align` entirely |
| `list` | It applies `reflowText` only in `paragraph`/`heading`/`blockquote` — **list items are never reflowed**, which was 90% of corpus overflow. Also where bullet-glyph substitution and the nested-continuation re-alignment happen |
| `hr` | The library hardcodes its rule character; the glyph tier has to reach it, and the rule must match the frontmatter divider exactly |
| `code` | Brackets fenced output so `--check` can exempt it, and normalizes `token.lang` through `src/lang.ts` before highlighting |
| `html`, and a safety net on `paragraph`/`heading`/`blockquote` | A block-level tag (e.g. a line starting `<script>`) swallows a paragraph and is returned unreflowed; the library's own reflow also measures with `.length` rather than `string-width`, undercounting a few Unicode marks |
| `paragraph`, inside a list **or a blockquote** | Every item of a **loose** list is a paragraph token dispatched through this override, so it — not `list` — is where that item's text gets wrapped. A blockquote's own prose reaches it the same way and owes the same columns. See below |
| `text`, inside a list | Every item of a **tight** list arrives here instead, as a raw block text token still carrying the author's own line breaks — and, since WP-14, **the only place a list item's inline markup gets parsed at all**. See below |
| `blockquote` | Parses its children itself so the body is observable, then gives back the first line's indent that the library's `quote.trim()` strips. See below |

#### Loose list items are wrapped by `paragraph`, at the item's own budget

`marked`'s lexer stamps `loose = true` on a whole list if any item ends with a blank
line, and each loose item is then parsed into a paragraph token. So a loose item's text
is wrapped by the `paragraph` override, **before** `list` glues on the item's marker and
its blanket indent. Wrapping it at the full target width there is what produced the
orphaned-line defect: the text came back 6+ columns over budget and `rewrapListBody`
reflowed it a second time, shearing the tail word onto a line of its own.

**Re-verified in WP-13, because WP-14's own source comment had denied it.** The lexer
really does hand a loose item `paragraph` children and a tight item `text` children, both
carrying the same inline `tokens` (`marked/lib/marked.cjs:557-561` stamps `loose`; the
block tokenizer makes the paragraph-vs-text choice). That asymmetry is the whole reason
WP-14's defect existed on one side only — see the tight-item section below.

The rule, therefore: **`paragraph` wraps at the width its text will actually occupy**,
not at the target width. `src/render.ts` keeps a stack of the columns each enclosing block
renderer still owes (a list level's marker plus its 4-column indent; a blockquote's
indent) and renders the paragraph through a `marked-terminal` renderer built at
`targetWidth` minus that sum. `rewrapListBody` then finds every line already in budget
and its pass is the no-op it documents itself as.

**The gate is that stack's total, not "are we inside a list"** — it read `listDepth()`
until WP-2g, which left quoted prose four columns over budget at every width. See "A
blockquote owes columns exactly like a list" below for why that only ever looked fine.

Three things that must not be simplified away:

- **The marker width is derived, never hardcoded.** `"* "` is 2 columns but `"10. "` is
  4, and the library's renumbering counter also runs over nested lists' marker lines, so
  the widest marker a level can emit is computed from its whole subtree.
- **Do not "coalesce and re-wrap" the paragraph result instead.** By then `reflowText`
  has rendered its own wraps and an author's hard break as the same bare `\n`, and has
  hard-split any word longer than the width with no marker — so rejoining lines destroys
  authored breaks and corrupts long URLs and paths.
- **A continuation line may not be allowed to start with `*` or `N.`.** The library's
  `isPointedLine` takes any such line for a marker line — an item's continuation lines
  are still at column 0 when it runs — and in an *ordered* list `numberedLine` then
  hands it that item's number and rewrites the first `"* "` anywhere in it. The item's
  text is corrupted and every later item is renumbered. Since this override chooses
  where lines break, it also chooses whether that fires, so a colliding continuation
  line is re-wrapped a column narrower and given one leading space, which the library's
  four-space indent group cannot match. Measured: one occurrence in a 1,000-file corpus
  sample before the guard, none after.

No width gate can see this class of defect: an orphaned line is *under* the target width.
It is covered by the orphan metric in `tests/render.test.ts` against
`tests/fixtures/loose-list.md`, and by nothing else.

#### Tight list items are coalesced by `text`, then wrapped at the item's own budget

The mirror image of the loose case, and a **different override**. A *tight* item is never
wrapped in a paragraph token, so `Parser.parse(item.tokens, false)` dispatches its block
`text` token straight to the `text` renderer — and `marked-terminal`'s own `text`
(`index.js:84-89`) returns the raw `token.text` and never dispatches `token.tokens`.
Nothing reflows it. The author's own source line breaks therefore arrive verbatim, and
adding the marker and indent pushes each authored line over the target, so
`rewrapListBody` splits it *per line* and shears the tail word onto a line of its own.

The rule: **inside a list, in a block position, on a token that carries `tokens`,
`text` coalesces the item's soft-wrapped lines back into one logical line per segment and
wraps once** at `targetWidth` minus the same pending-prefix stack the loose path uses.

**WP-14 gave this seam a second, prior job: parsing the item's inline markup.** Because
`marked-terminal`'s `text` returns `token.text` and never dispatches `token.tokens`, while
its `heading` (`:116-119`), `paragraph` (`:201-211`) and `tablecell` (`:260-265`) all call
`parser.parseInline(token.tokens)`, **a tight list item was the only container in the whole
renderer that reached the terminal as raw markdown** — `**bold**` and `[label](url)`
verbatim. This override now calls `parseInline` itself, then coalesces and re-wraps the
parsed text; the two jobs are sequential, not alternatives.

**The defect was a property of the token type, not of the marker — and it was never the
loose path.** WP-14's own comment claimed one override fixed tight and loose together;
WP-13 measured it and it is wrong. A loose item's children are `paragraph` tokens, so
`paragraph`'s `parseInline` had always parsed them. Verified at the library baseline: a
tight item renders `**b**` verbatim, a loose one renders it bold. What this override fixes
is every **tight** item — unordered, ordered, task — and every nested item whose own list
is tight, at any depth. Do not "extend" it to the loose path: a loose item's `paragraph`
token never arrives here, and the inline `text` tokens `parseInline` dispatches carry no
`tokens`, which is what stops a double parse.

Four things that must not be simplified away:

- **A `\n` here is authored, and coalescing it is lossless** — which is *not* true one
  seam over. Markdown treats a single newline inside a paragraph as a soft break, i.e.
  one space, and because nothing reflowed the text no word has been hard-split. This is
  precisely the information WP-2b found destroyed in the `paragraph` path; do not carry
  that conclusion across.
- **A hard break is distinguishable, and since WP-14 it is `HARD_RETURN` again.** This bullet
  used to read *"`Renderer.prototype.br` never fires for a tight item (nothing dispatches its
  inline tokens), so no `\r` is ever produced here"*, and the source spelling — two trailing
  spaces, a trailing backslash, a literal `<br>` — was the segment boundary. Dispatching
  inline tokens makes `br` fire inside an item for the first time, so `HARD_RETURN` now
  carries real traffic on this path: it is emitted, converted to `HARD_RETURN + "\n"` so
  WP-2c's `isHardBoundary` sees it, and stripped on the way out. **No bare `\r` reaches the
  terminal** — that is a pinned invariant, not a hope. Net effect on a tight item is an
  improvement: the break survives *and* the authored trailing spaces no longer do (before
  WP-14 the line came out as `"• first line  "`).
- **A hard break inside a *loose* item is still dropped, and that is a pre-existing defect,
  not WP-14's.** The library preserves it; this repo's `paragraph` path collapses
  `first line  \n  second line` to one line. Measured identical at `8504bd0` (pre-WP-14), so
  the `text` seam did not cause it. Recorded in `plans/representative-corpus.md`, not fixed.
- **Three conditions gate the pass, and all three are load-bearing:** inside a list, not
  inside a renderer that dispatches inline tokens (`paragraph`/`heading` keep an
  `inlineDepth` counter for this), and the token carries `tokens`. The same 600 files put
  413 *inline* text tokens inside lists through this seam, **242 of them multi-line** —
  a loose item's source lines before `reflowText` runs. Coalescing those is exactly the
  WP-2b failure mode; only `tokens` tells them apart.
- **Fences, tables and nested lists are excluded by construction, not by inspection.**
  Each is its own token type and never reaches a `text` call — measured: 0 of 11,443
  tight-item tokens contained a `SENTINEL`. Do not replace this with a line-shape
  heuristic over the composed list body.

Same guard as the loose path applies: a continuation line this pass creates may not be
allowed to start `*` or `N.`, or `isPointedLine` claims it.

#### A nested item's continuations are pulled back to their own item, per level

The third defect in this family, and the one that was worth the most: a continuation
line inside a **nested** item was indented past its own item's first line, one marker
width **per ancestor level**.

`marked-terminal`'s `list()` runs `bulletPointLines` or `numberedLines` over the whole
composed body (`index.js:539-578`), and both prepend a marker's width in spaces —
`toSpaces(BULLET_POINT)`, 2, or `toSpaces(numberedPoint(n))`, 3 or more — to every line
`isPointedLine` does not recognize. For the level's **own** items that is exactly right:
it puts a continuation under its own marker's text. But the body also holds an inner
list that has already rendered, and there the same pass moves that list's *continuation*
lines while leaving its *marker* lines alone — `isPointedLine` recognizes those, because
bullet substitution runs only at `listDepth === 1` and the literal `*` is still present.
`indentLines` then shifts every line equally and contributes nothing to the *relative*
drift. `realignNestedContinuations` in `src/render.ts` subtracts it back out.

**This is not a cosmetic fix, which is why it is here and not in a style note.** A
continuation shifted right is a continuation over budget, and the shallower
`rewrapListBody` then shears its tail word onto a line of its own — the same orphan the
two passes above chase, from a source neither of them could see. Running the
re-alignment *before* `rewrapListBody` is what makes the orphan disappear **as a
consequence** of the indent being right. Measured on the WP-2d regression tier at every
width 40-360, both glyph tiers: over-indents 29,035 → 3,683 and orphans 6,469 → 3,060,
with nothing in either wrapping override touched.

Four things that must not be simplified away:

- **It subtracts the drift; it does not snap lines to a column.** A blockquote or a
  fenced block inside a list item is *legitimately* indented past its item's text column
  by its own renderer, and `findContinuationOverIndent` reports those too. Snapping every
  reported line to the item's text column flattens them. Subtracting exactly the width
  *this level* added preserves every legitimate relative offset at every depth — and
  correctly leaves that class of detector hit standing.
- **Per level, not once at the outermost list.** The amount to subtract is the marker
  width this call just added, and that is only knowable here: at the outermost list the
  ancestors' drifts have already summed, and with levels of differing marker width
  (`"* "` is 2, `"1. "` is 3, `"10. "` is 4) the sum cannot be decomposed back. Deriving
  it from the bottom-of-stack item's own `textColumn - markerColumn` is what makes
  ordered levels work with no special case. Correcting at every level also makes
  `currentListBudget`'s four-columns-per-ancestor arithmetic exactly true rather than an
  under-estimate.
- **Fenced code is never rewritten**, by the same `SENTINEL` walk `substituteBullets`
  uses — `code`'s override resolves depth-first, so every fence in the body is already
  bracketed by the time `list` composes it. A line that starts inside a fence, or that
  carries a sentinel of its own, is left alone *and* is not allowed to move the item
  stack. `rewrapListBody` honours the same walk as of WP-2f — see below.
- **A de-indented line may not become a marker.** Landing on the four-column grid with a
  leading `*` or `12.` is all `isPointedLine` asks for. Unordered text columns are never
  on the grid (`4d + 2`); a ten-item ordered list's are (`4d + 4`), so the case is live
  and is guarded with one extra leading space, as both wrapping passes above guard it.

The stack model — "which item does this rendered line belong to" — is
`trackListLine` in `src/list-lines.ts`, shared with `findContinuationOverIndent`
deliberately: a detector and the fix it grades must not be able to disagree about where
an item's text column is. It sat in `src/detectors.ts` until WP-5 of
`plans/tn-review-remediation.md` moved it — **relocated, not copied**, precisely because
one implementation is the property and one *file* is not. The move takes the detector
module (a second `Marked` instantiation, the block-end probe, the shear classifier, none
of which has a production caller) out of the graph the shipped binary is compiled from.
**Its value is cohesion, not size**: measured with `bun build --target=bun`, the bundle
shrank by **151 bytes of 2.68 MB**, because the bundler already tree-shook every detector
function `render.ts` could not reach — see `src/list-lines.ts` for what was actually left
behind and why. The fixture is `tests/fixtures/nested-list.md`.

#### `rewrapListBody` rewrites neither a fence nor a marker

The last pass over a composed list body re-wraps the lines still over budget at that
level. Two things it must never do, **both invisible to every gate `bun run verify`
runs**, and both of which it did until WP-2f.

**It must never rewrite a line that belongs to a fenced block.** The rendering policy
below is unqualified — fenced code is never rewritten, because the corpus's fences are
gate commands meant to be pasted and a wrapped command is a wrong command. This pass had
no `SENTINEL` walk and split fence content mid-command like any other long line, and no
gate could see it: `--check` and both sweeps exempt recorded `codeRanges` from width
checking, so *corrupting* a line inside one cannot make a width gate fail. Measured over
a 1,000-file corpus sample of fence-carrying files at 80 and 116: **185 of 37,246 fenced
source lines did not survive verbatim on the parent commit; 0 do not now**, with no line
newly broken.

- **The sentinel walk here is the stricter of the two in this file, and the one-line
  fence decides it.** `substituteBullets` may bail on "this line *started* inside a
  fence" alone, because it only rewrites a *leading* marker and a fence's opening
  physical line begins with the sentinel character itself. This pass rewrites the whole
  line, and `wrapCode` emits `SENTINEL` immediately followed by the block's first content
  line — so the opening line already carries real code, and a **one-line** block carries
  all of its content on a line that both opens and closes the pair, where "started inside
  a fence" is false. So a line that starts inside a fence *or merely carries a sentinel*
  is returned untouched, as in `realignNestedContinuations`. Nothing but `wrapCode` emits
  a sentinel, so the stricter form can only ever spare a genuine fence line.
- **An over-budget fence line inside a list item overflows.** That is what fenced code
  does everywhere else here, and it is self-consistent rather than a new exemption: those
  lines land inside a recorded `codeRange` and stay exempt from `--check` and from both
  sweeps. Verified, not assumed — `tests/fixtures/fenced-list.md` asserts that *every*
  over-width line it renders is inside a recorded range, at six widths and both tiers.
  The visible consequence is real: `tests/fixtures/nested-list.md` now emits an 81-column
  line at width 80, and the WP-2e assertion that no line of it exceeds the width had to
  start exempting code ranges — **it had been passing for the wrong reason**, because the
  fence was being wrongly re-wrapped.

**It must never break a line so that a continuation starts `*` or `N.`.** The pass
chooses where lines break, so it chooses whether `isPointedLine` claims one of them —
and then `numberedLine` renumbers, or `substituteBullets` turns the author's `*` into a
bullet glyph. Both wrapping overrides guard this via `MARKER_SHAPED_LINE`; this one did
not.

- **Copying those overrides' guard verbatim makes this pass cause the collision it is
  meant to prevent.** They wrap text starting at column 0, which is *on* the four-column
  grid, so one leading space always takes a marker-shaped line off it. Here the
  continuation prefix is the line's own — `"    1. "` is **7** columns, already off the
  grid and already safe — and adding a space moves it *onto* the grid. Reproduced at
  width 55 on `fenced-list.md`: with the unconditional guard the author's bare `*` was
  still rewritten, and only because the guard had shifted the line from column 7 to 8.
  **The guard therefore fires only when the composed continuation would land on the
  grid**, and then does what the overrides do: re-wrap one column narrower, add one
  leading space.
- **`substituteBullets` had to be tightened to the same grid**, or the guard cannot
  reach it. Its regex was `/^(\s*)\*(\s)/` — a leading `*` at *any* indent — on the
  reasoning that a `*` at the start of a rendered line is always a marker. That reasoning
  predates this pass, which can put an author's bare `*` at the start of a continuation
  line. Every genuine marker is on the grid because `indentLines` only ever adds four
  columns at a time: measured over a 1,000-file sample at five widths, **79,410
  substitutions, 0 of them off-grid**. Measured on `fenced-list.md` at every width in
  40-360, both tiers: the parent commit rewrites the author's `*` at widths 54, 55, 100
  and 101; this one at none.

The fixture is `tests/fixtures/fenced-list.md` — fences in loose, tight and nested items,
a one-line fence, marker-shaped fence content as decoys, and the bare-`*` continuation.
A green sweep is not evidence for any of it; the source-anchored count above is.

#### A blockquote owes columns exactly like a list, and half the defect was ours

The fourth defect in this family, and the only one whose symptom is *outside* the block
it belongs to: **a list inside a blockquote rendered its markers at column 0**, out of
the quote entirely, while its siblings stayed at column 8.

**A rendered list marker at column 0 is never correct output.** `list` blanket-indents
its whole composed body before returning it, so the shallowest marker this tool can emit
is at column 4, and one inside a quote at 8. That invariant is the *only* instrument that
can grade this case, and `src/detectors.ts`'s `findColumnZeroMarkers` is it — see the
detector section in `scripts/AGENTS.md` for why the other two are structurally blind
to it.

Two independent mechanisms, and **the severe one was this tool's own code, not the
library's**:

- **`wrapOverBudgetLines` preserved no indentation.** It re-wrapped an over-budget line
  as `wrapAnsi(line, targetWidth)`, and `src/wrap.ts` starts every emitted line at a
  *word* — so the line's leading indent was discarded whether or not it even had to be
  split, and an 81-column indented line at width 80 came back as one line at column 0.
  Harmless for `paragraph` and `heading`, whose text starts at column 0 anyway;
  destructive for `blockquote`, which hands it a body `indentify` has already indented.
- **`Renderer.prototype.blockquote` is `section(this.o.blockquote(indentify(this.tab,
  quote.trim())))`** (`index.js:106`; `indentify` at `index.js:505`). The `trim()` strips
  the rendered body's indent from its **first line only**, so a quoted list's first item
  sits four columns left of its own siblings. Real, but the mild one — visible only at
  widths where nothing wraps.

Four things that must not be simplified away:

- **The indent-preserving re-wrap belongs in the shared helper, not on the `blockquote`
  path.** Dropping a line's own indent is never right, so the caller is not what makes it
  wrong. `paragraph`/`heading` stay byte-identical **by construction**, not by
  measurement: the preserving path is entered only for a line that *has* leading
  whitespace, and both of those callers hand the helper text starting at column 0 — which
  also stops `LIST_LINE_PREFIX` from claiming a paragraph that opens `"1. "` as a marker
  line. Verified anyway over 1,181 corpus files at four widths: **every differing render
  is a blockquote-carrying file, 0 otherwise**.
- **The first line's indent is restored on the rendered result, not on the input.** There
  is no spelling of a leading indent that `String.prototype.trim` will not eat, so the
  override parses the children itself (`this.parser.parse(token.tokens)` — the same
  single parse the library would have done, since its `blockquote` accepts a
  pre-rendered string), measures what the trim is about to take, and puts it back in
  front of the first content line. The spaces sit *outside* the blockquote style's escape
  run, which is invisible for a foreground-only style and identical in the ANSI-stripped
  text every gate measures. Restore **before** the width pass, or a first line the
  restored columns push over budget is left overflowing.
- **`currentListBudget` had to learn that a list is not the only thing that still owes an
  indent.** A blockquote applies its `indentify` for the same reason and at the same
  moment, so `rewrapListBody` was re-splitting quoted list lines against a budget four
  columns too generous while `paragraph`/`text` were already subtracting the quote in
  full — the two disagreeing about the same item. It now subtracts the non-list columns
  pending on the same stack.
- **`wrapOverBudgetLines` had no `SENTINEL` walk either.** A fence inside a blockquote
  reaches it already bracketed and was being split mid-command, invisibly, exactly as
  `rewrapListBody` split them until WP-2f — and it needs that pass's *stricter* walk for
  that pass's reason: it rewrites the whole line, and a one-line fenced block carries all
  of its content on a line that both opens and closes the pair. An over-budget fence line
  inside a quote now **overflows**, stays inside a recorded range, and stays exempt.

**The `paragraph` override's gate moved from "are we in a list" to "does anything still
owe columns", and that was forced rather than chosen.** A blockquote reflows its children
at the full `targetWidth` and then indents the result by four, so every wrapped line of
quoted prose is four columns over budget — which only ever looked fine because the safety
net was *deleting* the indent instead of honouring it. The moment it stopped, the net
started shearing a word off each of those lines instead. Same defect, same remedy and
same seam as a loose list item: render it at the width it will actually occupy and the
net goes back to being the no-op it documents itself as. **`heading` needed the same
treatment for the same reason** — it is reachable inside both a blockquote and a list
item, and it had no budgeted-renderer path at all. Measured over 599 blockquote-free
corpus files at four widths, that change is byte-identical: nothing outside a quote in
that sample has a heading that wraps.

**There is no marker-shaped-line guard in `wrapOverBudgetLines`, deliberately** — the
opposite call from `rewrapListBody`. The caller that needs one already has it
(`wrappedParagraph` tests its own result), and preserving the prefix strictly *reduces*
the exposure, because column 0 is itself on `isPointedLine`'s four-column grid and a
preserved list prefix usually is not. Adding one would change `paragraph`/`heading` bytes
to defuse a collision the change does not create.

The fixture is `tests/fixtures/blockquote-list.md` — unordered, ordered and nested lists
inside quotes, a quote inside a quote, fences (including the one-line shape) inside a
quote, plain quoted prose as the control, and **a blockquote inside a list item**, which
is *legitimately* indented past its item's text column and which nothing here may flatten
back. Measured over the 95 corpus files that put a list inside a blockquote, at widths
40/80/116/346: **column-0 markers 471 -> 4** — the residual four are one authored numbered
paragraph in one file, present identically on the parent — and on the tier-pure sub-count
of substituted bullet glyphs, **406 -> 0**. Fenced source lines surviving verbatim over
the same sample: **7,974 -> 7,996 of 8,020, 0 newly broken**.

#### Dead seams — do not try to use these

`marked-terminal` calls `renderer.list()` but **never** `renderer.listitem()`.
`markedTerminal()`'s `funcs.reduce` (`index.js:390-400`) makes each
`extension.renderer[fn]` call `r[fn](...)` on one shared *internal* `Renderer`
instance, so the library's internal `this.listitem(...)` and `this.checkbox(...)` calls
always reach the un-overridden prototype methods, whatever you assign. **`listitem` and
`checkbox` are not seams.** Anything that would live there has to be done as a text pass
inside `list`, or as a source rewrite before the lexer runs.

#### The two sentinels

Two control characters carry state through `marked-terminal` and are stripped from the
final output. They are control characters, not zero-width Unicode, **deliberately**: the
ASCII tier exists for terminals that cannot render UTF-8, so an "invisible" U+200B in
that path would be three bytes of exactly the thing the tier avoids.

| Sentinel | Code point | Purpose |
|---|---|---|
| `SENTINEL` | 0 | Brackets fenced-code output so `--check` and the sweep can record `codeRanges` and exempt them |
| `TASK_STATE_SENTINEL` | 1 | Sits between `[` and the state char so marked's GFM tasklist regex (`/^\[[ xX]\] /`) doesn't reclaim the item and rebuild it via the dead `checkbox` seam |

Both are stripped from the source before lexing and from the rendered output before it
reaches the terminal.

### Glyph tier

`src/glyphs.ts` resolves one capability tier that drives bullets, the rule character,
table borders, and task-state glyphs **together** — there is no per-feature toggle.

| | Unicode | ASCII |
|---|---|---|
| Bullets (by depth, cycling) | `•` `◦` `‣` | `-` |
| Rule / frontmatter divider | `─` | `-` |
| Table borders | box-drawing | `+` `-` `\|` |
| Task states | `○` / `✓` | `[ ]` / `[x]` |

Precedence, highest first: `--ascii` / `--unicode` (mutually exclusive; passing both
throws) → `MDVIEW_GLYPHS=ascii|unicode` → auto-detection. Auto-detection is ASCII when
`TERM` is one of `linux dumb vt100 vt220 ansi`, otherwise Unicode iff `LC_ALL ||
LC_CTYPE || LANG` matches `/utf-?8/i`. **The flags exist because no heuristic is a
contract** — do not tune the heuristic in place of them.

Every Unicode substitute is exactly 1 column, so the tier has **no width impact** and
`chromeWidth` stays `3N+1`. Both tiers are swept separately anyway (see "Corpus sweep"
in `scripts/AGENTS.md`); a change that widens a glyph must show up there.

**That paragraph is true only under *narrow* ambiguous-width measurement, and WP-3 found
out how narrowly.** `•`, `─` and the whole box-drawing set are East Asian *Ambiguous* and
measure 2 columns under `MDVIEW_AMBIGUOUS=wide`; only `◦`, `‣` and `✓` are 1 either way.
`resolveGlyphs` therefore takes the resolved ambiguous setting as a third argument and
refuses to hand this tier out in wide mode at all — ahead of `--unicode`. See "Ambiguous
width (WP-3)" below for the measurement and for why it is not repairable in the
allocator.

Bullet substitution runs **once, at the outermost list** (`listDepth === 1`), reading
depth from indentation. This is not a style choice: `marked-terminal`'s `fixNestedLists`
(`index.js:152`) finds sublist boundaries with a `POINT_REGEX` hardcoded to literal `\*`
and `\d+\.`, so the literal `*` must survive until ancestors resolve. Substituting
per-level collapses two levels onto one line. The pass skips any line that *starts*
inside a `SENTINEL` region — fenced code is never rewritten, including a fence nested in
a list item. It also matches the marker **only on the four-column grid** (WP-2f): a
leading `*` at an arbitrary indent is not necessarily a marker, because `rewrapListBody`
runs before this pass and can put an author's own bare `*` at the start of a continuation
line. See "`rewrapListBody` rewrites neither a fence nor a marker" above.

### Command-line surface (WP-4)

```
mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--probe] [--help]
mdview view <file.md> [options ...]
mdview highlight-as <fence> <language>
mdview probe [--refresh] [--no-cache] [--timeout MS]
mdview help [subcommand]
```

**`mdview <file.md>` with no subcommand is load-bearing, not a convenience.** It predates
subcommands and is the invocation the user runs daily, so `main` dispatches to a named
handler *only* when `args[0]` is exactly `view`, `highlight-as`, or `help`; everything
else — including every flag, all of which start with `-` — falls through to the same view
path as before. A new subcommand slots into that dispatch without disturbing it, and
WP-3's `probe` did exactly that — one added name in `main`, one in `runHelp`, and nothing
about the fall-through touched. `--probe` is *also* accepted on the view path, because
`plans/crucible-tui-launch.md` publishes both spellings (its "Public Interfaces" section
says `mdview --probe`, its WP-3 text says subcommand) and supporting both costs one line
of delegation, where picking one would make a published spelling a lie. The cost of the
shape is one edge case,
accepted knowingly: a file named exactly `view`, `help`, or `highlight-as` with no
extension must be given as `./view` or via `mdview view view`.

`main(args = Bun.argv.slice(2))` stays exported and stays **throwing**; tests call it
in-process and assert on thrown messages, which is what keeps the suite subprocess-free.
The `import.meta.main` block is therefore the *only* place errors are caught, rendering
them as a single `mdview: <message>` line on stderr with exit 1. Without that boundary Bun
wraps every carefully worded message in a source excerpt, a stack trace, and its own
version banner, and leaks the absolute install path while doing it. **Do not move the
catch into `main`, and do not add a second one.**

**Config** is JSON at `$XDG_CONFIG_HOME/mdview/config.json` (falling back to
`~/.config/...`). `highlightAs` maps a fence info-string to a highlighter language,
layered *over* `src/lang.ts`'s built-ins (`dataviewjs`→`javascript`, `dataview`→`sql`);
a user entry for a key with a built-in default wins. `src/cli.ts` calls
`setHighlightAliases` once at startup — module-level state in `lang.ts` rather than a
parameter, because `render.ts` calls `resolveFenceLanguage(token.lang)` with one argument
and was out of WP-4's scope.

The read and write paths are deliberately asymmetric, and the asymmetry is the design:
**reading is lenient, writing refuses.** A malformed config degrades to defaults with one
stderr notice naming the file and still renders the document; a bad *entry* is dropped
individually so it does not cost the others. But `highlight-as` **refuses** to write into
a file it cannot parse, because merging into a file it cannot understand would either
clobber content it can't see or silently discard it. Writes are atomic (temp file +
`rename`) and touch only `highlightAs[fence]`, preserving every other key — it round-trips
the *raw* JSON object, never the typed `MdviewConfig`, which would silently drop any key
this module doesn't know about the first time the subcommand ran.

**Man page:** roff source at `man/crucible-tui.1`, installed by `bun run install:man` as
**both** `~/.local/share/man/man1/mdview.1` and `.../crucible-tui.1` — symlinked, matching
the `dist/mdview` PATH convention, so edits take effect without reinstalling. Two links to
one source, because the tool answers to two names and a reader who knows the project as
`crucible-tui` should not get "No manual entry" for typing it. That split is deliberate
and settled — see "Two names, on purpose" at the top of the root `AGENTS.md`. Do not
reconcile the two names.

### Ambiguous width (WP-3)

`src/width.ts` owns one question: **how many columns is an East Asian *Ambiguous*
character?** Unicode's answer is "one or two, depending on the terminal, and you cannot
tell from the character" — and almost every non-ASCII character in this corpus is in
that class (`— – → ← … ≥ × • ○` and the whole box-drawing set; 90 em dashes in one real
document). `string-width@7` defaults to narrow, which is also TR11's own recommendation
when the context cannot be established, and that default was hardcoded at **26 call
sites across 7 modules** because the library takes the setting as a *per-call option*
and offers no global switch.

**`src/width.ts` is now the only file in `src/` or `scripts/` that imports
`string-width`**, and `tests/width.test.ts` asserts it. That is not tidiness: a module
that imports it directly silently opts out of whatever mode was resolved, and **no width
gate can see that**, because a check measured with the wrong ruler passes. It is the
same class of defect as the `cli-table3` v4/v7 disagreement below (closed in WP-3 of
`plans/tn-review-remediation.md`, by owning the emitter), and it is exactly the
kind that this repo has shipped green four times.

#### The mode is threaded, exactly like `GlyphSet`, and for the same stated reason

`src/glyphs.ts`'s header is the precedent: *"this module is the only place that reads the
environment; `render.ts` and `table.ts` stay pure and take a `GlyphSet` argument so every
test is deterministic regardless of the machine's `TERM` or locale."* A process-global
`ambiguousIsNarrow` in `width.ts` would be smaller and is precisely what that sentence
was written to prevent — it makes every test's result depend on what ran before it, and
the sweep's numbers depend on the machine that ran them.

So a `Measure` is a value: a callable `(text) => columns` carrying an `ambiguous` tag,
passed alongside the glyph set on the channel that already exists (`cli.ts` →
`renderDocumentDetailed` → `renderTable`), and **defaulting to `NARROW_MEASURE` at every
public entry point**. The default is not a convenience — it *is* rule 4 of the
resolution order — and the narrow branch calls `stringWidth(text)` with **no options
object at all**, byte-for-byte the call all 26 sites used to make. That makes narrow-mode
output identical to the parent commit *by construction* rather than by measurement.
Measured anyway: **4,368 renders (21 files × 104 widths × both tiers) byte-identical,
0 differing bytes, 0 `codeRanges` disagreements.**

#### Resolution order (highest first)

1. `MDVIEW_AMBIGUOUS=narrow|wide`. Any other value — unset, empty, a typo — is **ignored**
   and falls through. Never throws on a bad env var; that is the `MDVIEW_GLYPHS`
   contract and this matches it exactly.
2. A cached probe result for **this terminal identity**.
3. A live DSR probe, iff stdin *and* stdout are TTYs **and the caller opted in**.
   `allowProbe` defaults to *off*, which is the load-bearing direction: `--check`, the
   sweep and the whole test suite get "no terminal I/O, no cache writes" for free rather
   than each having to remember.
4. **Narrow.**

**The cache key is deliberately over-specified**: `TERM`, `TERM_PROGRAM`, `COLORTERM`,
`VTE_VERSION`, the multiplexer, and the locale. The locale is in the key because it is
conventionally *the* thing that changes a terminal's ambiguous-width behaviour.

*This paragraph has been rewritten twice against field data, and the history is the
point.* It first justified the key by claiming `TERM` alone cannot separate the validated
terminals "because a multiplexer rewrites it". **The validation disproved that**: zellij
did **not** rewrite `TERM` — ghostty under zellij reported `xterm-ghostty` — so that
specific mechanism never fired. The five-terminal survey of 2026-07-28 then supplied the
mechanism that is actually real:

| host | `TERM` | distinguishing field |
|---|---|---|
| ghostty + zellij | `xterm-ghostty` | `TERM` |
| urxvt | `rxvt-unicode-256color` | `TERM` |
| kitty | `xterm-kitty` | `TERM` |
| gnome-terminal | **`xterm-256color`** | **`VTE_VERSION=7600`** |
| anything + tmux | `tmux-256color` | *(the host that started the server — see below)* |
| mlterm | `mlterm` | `TERM` — **and the only measured `wide`** |

**`TERM` is a terminfo name, not an identity, and this machine already proves it**:
gnome-terminal reports the *generic* `xterm-256color`, the value plain xterm, alacritty
and terminator also claim. `VTE_VERSION` is what separates it. That is the real
justification; the multiplexer-rewrite story was speculation that happened to be wrong.

**Under tmux the key is dominated by tmux's own fields, and that is correct rather than a
collision.** The reason it is correct is **not** that the host fields vanish — it is that
**tmux answers DSR from its own grid model rather than relaying to the host**, measured by
running the probe in a fully detached session with nothing attached to render anything,
which still replied `\e[1;2R` in 5 ms. mdview's output is laid into tmux's grid and *tmux*
decides the wrapping, so tmux's opinion is the one that governs and sharing an answer
across hosts is the desired behaviour. A host that disagrees with its own multiplexer is
already rendering corrupt output for every program, and is not mdview's to reconcile.

**What tmux actually does to the environment** (measured 2026-07-28 by injecting known
values at server start and reading them back inside a pane): it overrides exactly the two
variables it owns — `TERM` → `tmux-256color`, `TERM_PROGRAM` → `tmux` — and **passes
everything else through unchanged, frozen at server-start time**. `COLORTERM` and
`VTE_VERSION` both survive; the default `update-environment` list carries neither, so an
*attaching* client contributes nothing. The consequence is that a pane's identity records
**whichever host started the server**, not whoever is looking at it:

| tmux server started from | identity under tmux | how |
|---|---|---|
| kitty / ghostty | `…\|colorterm=truecolor\|vte=\|mux=tmux` | field |
| urxvt | `…\|colorterm=rxvt-xpm\|vte=\|mux=tmux` | field |
| gnome-terminal | `…\|colorterm=truecolor\|vte=7600\|mux=tmux` | lab, **then field** |

The last row is worth its own note: it was **predicted from the injection experiment and
then confirmed live**, byte-for-byte, in a real gnome-terminal + tmux session. That is the
difference between this version of the paragraph and the three wrong ones — the rule was
stated first and the observation arrived afterwards to match it.

So tmux keys split **per server origin**, not per host and not into one bucket, and the
split persists for every client that ever attaches. The cost is bounded at one spurious
re-probe per origin, all of them agreeing, because tmux gives the same answer regardless.
Over-specifying costs a re-probe; under-specifying hands ghostty urxvt's answer.

**The one place the key is genuinely under-specified, found 2026-07-28 by installing a
terminal that can be configured either way.** mlterm's `col_size_of_width_a` is a
config-file setting: `=2` probed **wide** (`\e[2;3R`, cursor 1→3), `=1` probed **narrow**
(`\e[2;2R`), same binary, same session shape, and **byte-identical identity strings**
(`term=mlterm|program=|colorterm=truecolor|vte=|mux=none|locale=en_US.UTF-8`). Two correct
opposite answers under one key. The cache therefore serves the stale verdict across such a
flip until `--refresh`, and no field available to the identity can fix it, because the
setting never reaches the environment. Documented in the README as user-facing advice
rather than papered over. **Do not "fix" this by widening the key** — there is nothing to
widen it with; the honest options are a TTL or always re-probing on a TTY, and neither is
worth 5 ms per run against a setting most users change never.

This pair is also **the proof that the probe measures rendering rather than correlating
with `TERM`.** Six narrow terminals could not establish it; one terminal that answers both
ways under an unchanged identity does, and it is the only evidence in the repo that
distinguishes the design from a lookup table. Every `wide` claim before this was
`MDVIEW_AMBIGUOUS` or a test double.

**zellij is the opposite and overrides nothing.** Measured on two different hosts:
ghostty under zellij keeps `TERM=xterm-ghostty`, kitty under zellij keeps
`TERM=xterm-kitty`, and neither gains a `TERM_PROGRAM` it did not already have — kitty
sets none, so the field stays empty where tmux would have stamped `tmux`. Under zellij the
key therefore still identifies the **host**, correctly. This is also the cleanest argument
for keeping `mux` in the key at all: kitty bare and kitty-under-zellij differ in **exactly
one field**, and it is that one. **Do not generalise from one multiplexer to another** —
the two behave oppositely on environment, and `screen` differs from both again (it does
not strip `ZELLIJ`, which is why `detectMultiplexer` needs `TERM` as a tiebreaker).

**Keep the claim sized to the evidence.** This paragraph has now been wrong three times
while the code was right throughout: first "a multiplexer rewrites `TERM`" (zellij does
not), then "every host collapses to one key" and "tmux strips `VTE_VERSION`" (it strips
nothing — it overrides two variables and freezes the rest). Each wrong version was an
observation generalised into a mechanism. The rule above is stated as a rule because it
was measured as one.

Writes are atomic (temp file +
`rename`, `src/config.ts`'s pattern); every corrupt, truncated, wrong-version or
unreadable shape reads as a **miss** and re-probes, and an unwritable cache is a
`false` return, never a throw — a viewer that refuses to render because a file it
generated is corrupt has mistaken its plumbing for the user's request.

**The probe never moves the cursor to a cell it did not already own.** It asks where the
cursor is, writes one character *there*, asks again, and the difference is the answer;
then it returns to the recorded column and clears to end of line, which is exact because
nothing to the right of the cursor existed before. The obvious alternative — CR to
column 1, write, restore — overwrites whatever the shell prompt left there and cannot
put it back. Within two columns of the right margin it **refuses and says so** rather
than guessing, because the glyph would wrap and the erase would clear a line the probe
never wrote.

Cooked mode is restored in **three** layers, and the third is not belt-and-braces: a
`finally` covers a throw or a return, `process.on("exit")` covers `process.exit`, and
handlers for `SIGINT`/`SIGTERM`/`SIGHUP` cover an external `kill` — whose *default*
disposition terminates without emitting `exit` at all, which is the one path that would
strand the user's shell in raw mode. Verified against a scripted pty: killed mid-probe,
the tty comes back `icanon`. Ctrl-C is handled as a **byte** (`\x03`), not a signal,
because raw mode is exactly what turns `ISIG` off.

#### `wide` forces the ASCII glyph tier — arithmetic, not taste

The tier section above says *"every Unicode substitute is exactly 1 column, so the tier
has no width impact and `chromeWidth` stays `3N+1`"*. **That is a narrow-measurement
statement, and under `wide` it is false for most of the set**: `•` (U+2022), `─`
(U+2500) and the entire box-drawing charset are themselves Ambiguous and measure 2. Only
`◦`, `‣` and `✓` survive.

Two consequences, neither cosmetic and neither repairable in the allocator:

- **A table's border row cannot be made to fit.** A horizontal rule is one `─` per
  column of cell width, so the border row is exactly *twice* the content rows — and no
  allocation can shrink by its entire budget, so `allocateWidths` reports `fits: false`
  and the table is emitted at its minimum feasible width rather than as a wreck.
  Measured on `tests/fixtures/wide-table.md`: **160 columns at a target of 80, 200 at
  100 — exactly 2×**, pinned in `tests/width.test.ts`. **WP-3 of
  `plans/tn-review-remediation.md` did not move these numbers and was not supposed to**
  — it closed the *padding* defect below, which is a measurement problem; this is a
  glyph-choice problem, and refusing the tier is the choice.
- **A substituted bullet widens its own item.** `substituteBullets` swaps `"* "` for
  `"• "` *after* the budget arithmetic ran on the source marker, so every unordered item
  is one column over budget per level.

Measured over the bundled corpus at all five sweep widths: **wide + Unicode = 35
overflows of 60 combos; wide + ASCII = 0.** So `resolveGlyphs` takes the ambiguous
setting as a third argument and returns ASCII whenever it is `wide`, **ahead of
`--unicode` and `MDVIEW_GLYPHS`** — because `--unicode` asserts a *capability* ("this
terminal can draw these"), which remains true and is simply not the constraint that
binds. An explicit `--unicode` that gets overridden this way is named once on stderr
(`wideForcesAscii`), never swallowed. `MDVIEW_AMBIGUOUS=narrow` is the escape hatch.

`renderRule` divides the target by the rule glyph's *measured* width for the same
reason — `"─".repeat(targetWidth - 1)` is twice the document width in wide mode, which
would put the tool's own frontmatter divider over budget on every file that has one.

#### The residual, named rather than papered over — and then closed by owning the emitter

**The finding.** `cli-table3` bundled its own `string-width@4.2.3`, which has no
`ambiguousIsNarrow` option at all, so its cell padding could never honour wide mode. A
cell containing *k* ambiguous characters was padded *k* columns too wide, and since *k*
varies cell by cell within a column, **a table's right edge could be ragged by up to *k*
columns**. This paragraph used to end "not fixable from outside the library", and that
was exactly right: it pads to `colWidths` in its own units, so no amount of pre-padding,
pre-wrapping or budget adjustment on our side could make its count agree with ours
per-cell. The capped render/measure/reallocate loop that used to sit in `renderTable`
absorbed only the **aggregate** overage — which is why a table stayed inside the target
while its edge stayed crooked, and why a green width gate was never evidence about this.

**The fix, in WP-3 of `plans/tn-review-remediation.md`: stop being outside the library.**
`src/table.ts` now emits its own borders, junctions, padding and alignment from the
allocation `allocateWidths` already produced, padding with the `Measure` it was handed —
the same ruler the allocation used and the same one `--check` grades the result with. The
disagreement is not repaired, it is **impossible by construction**; the retry loop,
`MAX_FIT_PASSES` and `maxRenderedWidth` are gone with it, and the rendered geometry now
*equals* the allocated geometry (`tests/table.test.ts` asserts that equality directly).

Measured over this repo's own 41 markdown files at six widths, both tiers, both ambiguous
modes — 984 renders:

| Combination | Rendered tables | Ragged before | Ragged after |
|---|---|---|---|
| narrow, either tier | 180 each | 0 | 0 |
| **wide + ASCII** (what the CLI produces) | 180 | **66** | **0** |
| wide + Unicode (unreachable; `wideForcesAscii`) | 180 | 180 | 180 |

Narrow-mode output is **byte-identical** across those 492 renders — 0 differing bytes —
because narrow measurement is where the two `string-width` majors happened to agree on
this corpus, and because the emitter reproduces the library's escape-sequence layout and
its `@colors/colors` styling decision exactly rather than approximately. It is *not*
byte-identical in general: a narrow-mode table carrying U+26A0 changes, and improves —
that glyph is 1 column to `string-width@4` and 2 to `@7`, which is the original
reconciliation bug, and its edge went from a spread of 3 to 0.

**Do not read this as "wide mode + Unicode tables now work."** They do not, and the row
above says so: `─` and the whole box-drawing set are themselves Ambiguous, a border row
is still exactly 2× the content rows, and that is still handled by refusing the tier.

#### The sweep keeps the two axes independent, on purpose

`scripts/sweep.ts` takes `--ambiguous narrow|wide` and **never** reads `MDVIEW_AMBIGUOUS`,
never consults the cache, and never probes. It is a corpus *measurement* instrument whose
numbers are compared against dated runs in the private archive; a baseline that changed
ruler because of the machine's `TERM`, or because someone once ran `mdview probe`, could
not be compared to anything. It also does **not** apply the wide-forces-ASCII rule, so
`--ambiguous wide --glyphs unicode` stays reachable — that combination is how the finding
above was measured, and an instrument that cannot reproduce a finding is not an
instrument. It prints a NOTE saying the CLI never produces that combination.

`--check` is the other way round and for the opposite reason: it honours the env var and
the cache (it just never probes), because its whole claim is "the renderer hit the budget
it was given". A check measured with a different ruler than the allocation used is
asserting something else entirely.

#### What the orchestrator cannot verify

The probe's *arithmetic*, cleanup, timeout, interrupt and cache behaviour are covered by
`tests/width.test.ts` against a scripted terminal double, and end-to-end against a
scripted pty. **What no test here can establish is what a real terminal answers.** The
user runs urxvt and ghostty-inside-zellij; run `mdview probe` in each and read the
`ambiguous width` line. Nothing in this repo may claim those pass.

### Rendering policy

- **Fenced code is never rewritten.** Blocks pass through verbatim at whatever width
  they are, and `--check` skips lines inside them. This is deliberate: the corpus's
  fences are gate commands meant to be pasted, and a wrapped command is a wrong
  command. The trade is that `--check` guarantees "no non-code line exceeds the
  width", not "no line at all".

  **"Never" is unqualified, and a fence nested inside another block is the case that
  keeps testing it** — WP-2 rewrote one inside a list item, WP-2f found a second pass
  doing the same, and WP-2g a third doing it to a fence inside a *blockquote* (all three
  shipped fully green, because the exemption that makes fences safe from width gates also
  makes them invisible to width gates). Such a line **overflows** rather than wrapping,
  exactly like a fence anywhere else; it stays inside a recorded `codeRange` and
  therefore stays exempt. Any pass that rewrites already-rendered output needs the
  `SENTINEL` walk before it touches a line — there are **four** of them now, and the
  strictness each one needs is not the same. See the list-override section above.
- **Nothing is ever ellipsized.** Long tokens are hard-split at grapheme boundaries and
  rejoin losslessly. If a change can emit `…`, it is wrong.
- **Unknown fence languages degrade silently.** `src/lang.ts` maps aliases
  (`dataviewjs`→`javascript`, `dataview`→`sql` — Dataview's query language is SQL-like
  and highlights acceptably), then falls back to `plaintext` for anything
  `supportsLanguage()` rejects. Without this, highlight.js writes
  `Could not find the language 'x'` to **stderr, once per fence** — 280 `dataviewjs`
  fences in the vault, its largest fence category.

  That path is **dead under every test and gate**: `marked-terminal`'s `highlight()`
  returns early when `chalk.level === 0`, i.e. whenever stdout is not a TTY. Its
  try/catch around `highlightCli` never fires either, because highlight.js *logs* rather
  than throws. Exercising this behavior requires `FORCE_COLOR=3` and capturing
  `console.error`.
- **The viewer never narrates parser internals to stderr.** `yaml` reports recoverable
  oddities through `process.emitWarning`, which no `try`/`catch` can intercept, so Node's
  default handler prints a ~15-line stack trace. Obsidian templates trigger it
  (`created: {{today}}` parses as a flow mapping used as a key). `formatMetaBlock` passes
  `logLevel: "error"` — **not `"silent"`**, which also suppresses errors and would let
  `title: [unterminated` come back silently guessed as `["unterminated"]` instead of
  throwing and being shown raw. Verified value-neutral over 43,047 frontmatter blocks
  across every corpus: identical parse result or identical throw, every one.
- **Obsidian embeds** (`![[target]]`) render as `embed: target`. Previously the `!`
  leaked through as literal text next to the link (1,350 occurrences in the vault).
- **Frontmatter is followed by a rule** at the tier's rule character, matching the
  document's own `hr` rendering exactly — both come from `renderRule()` in `render.ts`.
  Rules are `targetWidth - 1` characters wide, because `marked-terminal`'s `hr` helper
  (`index.js:612`) builds them with `new Array(length).join(str)`, which yields
  `length - 1`. Match that, don't "fix" it, or the divider and the document's own rules
  disagree by one column.
- **Known limitation:** a markdown table nested *inside* a list item is re-wrapped as
  prose and its box drawing is mangled. The table renderer sizes to the full target
  width with no knowledge of the enclosing list indent. There are zero instances in the
  corpus (verified), so this is unfixed by choice rather than oversight.
- **Known limitation — many-column tables exceed the target width.** Each column has a
  minimum content width; below that a cell is unreadable. Once a table has enough
  columns, that floor times the column count already exceeds the target and the allocator
  has nowhere left to shrink:

  | Columns | Target | Rendered | Arithmetic |
  |---|---|---|---|
  | 9 | 80 | 82 | 9 × (6 + 2 padding) + 10 borders |
  | 19 | 100 | 153 | 19 × (6 + 2 padding) + 20 borders |

  **This is arithmetic, not a bug to be fixed in the allocator** — a 19-column table
  cannot be rendered in 100 columns. Any "fix" is a choice of *degradation* (drop cell
  padding, transpose to a record-per-row layout, or overflow deliberately), and each
  trades away something the tool currently guarantees. Incidence is a few thousandths of
  a percent of full-corpus combos — the dated counts live in the private archive's
  `measurements/`, not here — so the choice has been deferred rather than made. If you do
  fix it, note that dropping padding only buys 2 columns each and does not rescue the
  19-column case.
- `.gitignore` is assembled from the chunk files the in-house scaffolding skill ships;
  repo-local entries go under the `# --- project-specific ---` marker. **`bun.lock` is
  now tracked** (decided at WP-6b). It was ignored globally by the parent mono-repo's
  root `.gitignore` while this was a subfolder; extraction dropped that file, and the
  rule was restated locally (WP-6a) purely to keep the tracked set unchanged across the
  split — that restatement was never itself a decision to keep ignoring it going
  forward. **Pinning direct dependencies (WP-5) does not reach the transitive tree** —
  `highlight.js@10.7.3`, pulled in transitively via `cli-highlight`, is already two
  majors stale and would silently drift on a fresh `bun install` on a different machine
  with no lockfile to hold it — and a published application should ship the lockfile
  that was actually tested against, not trust every future clone to re-resolve the same
  transitive tree. The `.gitignore` rule and its old explanatory comment are removed;
  the lockfile is committed like any other tracked file from here on.

### The `emoji` re-decision

*Continues the root `AGENTS.md`'s "Dependencies (WP-5)" section, which owns the pins and
the declaration rules; this half lives here because it is about `src/render.ts`'s
behaviour.*

**`emoji` stays at its default `true` — re-decided 2026-07-29, and the reason to turn it
off turned out not to exist.**
`marked-terminal` ships a `:shortcode:` → emoji-glyph pass (`insertEmojis`, gated by its
own `emoji` option, default `true`). It was investigated once before (2026-07-28) and
rejected on 392 prose shortcodes across 59 files — but that test was a throwaway
subagent invocation nothing in the repo could re-run, and its 59 files were reachable
**only** by following symlinked subtrees the corpus was never meant to include. That is
a corpus-*membership* bug (`plans/corpus-symlink-membership.md`, WP-1/WP-2), not a
property of the user's real documents, and it has since been fixed by adding the two
roots that actually matter as **explicit** corpus members instead of symlink-following
into everything reachable.

The test itself is now committed: `scripts/emoji-audit.ts`. Method, unchanged and
non-negotiable: render each candidate token twice, `emoji` on vs off, and keep only
tokens whose rendered bytes actually *differ* — a behavioural test, never a `node-emoji`
lookup, so it cannot drift from what the library really substitutes. Fence-aware, since
`marked-terminal`'s `code` renderer never applies the transform, and table-aware for the
identical reason: this tool's own `renderTable` (`src/table.ts`) never dispatches inline
tokens either, so a shortcode inside a table cell is inert *here* regardless of the
`emoji` option. Both exemptions are verified per token, against the real renderer, not
assumed.

**Re-run over the corrected corpus (~44.7k files, unsampled, explicit roots, no
symlink-following): zero authored prose shortcodes in the user's own documents.** The
only hits anywhere — 10 tokens across 2 files — sit inside third-party repositories
cloned for reference into one research-collection root, each its own separate `.git`
checkout (an open-source CLI's changelog and an agent-persona doc from a cloned
agent-collection repo). That is vendored material the user did not author, and vendored
content is not grounds to keep this on. (A third cloned repo in the same root carries two
more shortcode-shaped tokens, but they sit in a table cell and are inert by construction
either way — not counted as prose.) Every other root — including a
personal notes archive of ~44k files, scanned in full, not sampled — shows **0** prose
shortcodes; the only occurrences elsewhere are already-fenced and already inert
(matching the original 19-fenced-hit finding, now reproduced against a corpus with two
more roots in it).

**The ~468 KB figure was asserted, never measured, and does not hold up.** Compiling
both ways (`bun build --compile`) and diffing the resulting binaries shows a delta in
the tens of bytes on a ~102 MB binary — noise, not savings, and two orders of magnitude
smaller than claimed. `emoji: false` is a runtime option read by `insertEmojis`, not a
build-time flag; `bun build --compile` bundles the whole dependency closure regardless
of which branch a runtime option takes, so there was never a binary-size case for this
either way.

**That is what settles it, and it is worth being precise about the shape of the
argument.** The corpus evidence above establishes only that turning substitution off
would be *harmless on today's corpus* — an absence of harm, not a benefit. With the
binary saving gone there is no benefit left to weigh against it, and a change with no
upside is not a change. The positive case runs the other way: in a modern terminal the
default expectation is that `:rocket:` renders as a glyph, and the planned
GitHub-README corpus (`README.md` files are dense with shortcodes) is about to make that
the common case rather than the rare one.

**The real conclusion is that this does not belong in a constant at all.** Substitution
is a *terminal capability* question, so it should follow the glyph tier the tool already
models: `--unicode` renders glyphs, `--ascii` cannot and must leave the literal
shortcode, with a user-config override.

**That work has since landed — WP-11 of `plans/representative-corpus.md`.** `emoji` is now
`emojiOverride ?? (glyphs.tier === "unicode")` (`src/render.ts`), threaded from
`MdviewConfig.emoji` (`src/config.ts`), so config can force either direction regardless of
tier. Every `marked-terminal` construction in a single render call — the main one and the
per-budget ones the `paragraph` and `heading` overrides build — is passed the **same**
`emoji` value deliberately; substitution must not depend on whether a paragraph happened to
sit inside a list item. The measured defect went with it: the stray space `insertEmojis`
appends (`emojiSign + ' '`, never in the source, surviving as trailing whitespace at end of
paragraph or heading and therefore changing rendered width — the one thing this tool exists
to control) is now stripped, fence-aware via `codeRanges` so a literal emoji-then-space the
user actually typed inside a fence survives. Shortcodes inside fences stay literal regardless, because
`marked-terminal`'s `code` renderer never runs the transform, so no special case was
needed for them.

**Corollary, corrected:** the file count from the prior measurement stands (12,363,
re-measured 12,385 a day later — corpus drift, not a method error), but the
characterisation "real user markdown that no gate in this repo has ever rendered" does
not: composition of that symlink-reachable set is **~73% agent scratch directories and
third-party package caches**, reachable only because a tracked root symlinks into a home
directory, and formally out of this corpus's scope (`plans/corpus-symlink-membership.md`,
"Decisions locked"). The remaining plausibly-real markdown in that set was not pulled in
by following symlinks — it was added properly, as the two explicit roots this section
now measures against. Any "verified across the whole corpus" claim made before
2026-07-29 still carries the hole that the swept corpus was missing those two roots; it
does not carry a hole shaped like "12,363 files of real markdown no gate has ever
rendered," because most of that set was never real markdown in the first place. The
glyph-tier work above has since superseded the old pins: see `tests/render.test.ts`'s
emoji-tier describe block for the behaviour now asserted per tier, including the
trailing-space defect those pins had only recorded.

