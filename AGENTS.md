# mdview

Terminal markdown viewer for this repo's plans, execution briefs, and `INITIATIVE.md`
files: renders frontmatter as a metadata block and wraps wide tables losslessly instead
of overflowing or truncating them.

## Two names, on purpose

The repository and project are **`crucible-tui`**; the command, the package, the
`MDVIEW_*` environment variables and the `~/.config/mdview/` directory are all
**`mdview`**, and that is a **settled decision, not an unfinished rename** (2026-07-28).

`mdview` describes what the tool does — it views markdown. It will stop being accurate
if editing, a file tree, or the other TUI-application functions arrive, and *that* is the
event that would justify renaming the command; shipping churn before then would cost every
user their config path and muscle memory to buy nothing. `crucible-tui` is the name of the
project those functions would belong to. The split follows `ripgrep`/`rg` and
`the-silver-searcher`/`ag`: repo name and command name are allowed to differ.

Concretely: the man page source is `man/crucible-tui.1` and installs as **both** `mdview.1`
and `crucible-tui.1`, so `man` resolves either name to the same page. **Do not "fix" the
two names to agree.** If a future WP does rename the
command, it owns the whole set at once — binary, package, env vars, config dir, and a
compatibility shim for the old config path — and it updates this section rather than
deleting it.

## Stack

- Bun + TypeScript, single flat package (no workspaces).
- `marked` (lexer) + `marked-terminal` (prose/list/code rendering) with a custom
  table renderer (`src/table.ts`, added in WP-3) — `marked-terminal` never passes
  terminal width to tables and drops `token.align` entirely.
- `yaml` for frontmatter parsing, `cli-table3` for table layout, `string-width` for
  CJK/emoji-correct column measurement.
- **Bun/TypeScript over the Rust default the in-house scaffolding skill prescribes
  (its Gate 2)** — recorded per that gate's "record every choice" rule. Justification:
  `marked@^14` was already pinned across the sibling tools this tool was written beside;
  the wiki-link and task-state markdown logic it needs already existed in TypeScript in
  an in-house web renderer working over the same corpus; the only other CLI-only tool in
  that family is TypeScript; and a working prototype in this stack was measured against
  the corpus before the plan was written.

## Layout

```text
src/cli.ts          arg parsing, width resolution, pager, --check, glyph flags
src/render.ts       marked/marked-terminal wiring + renderer overrides
src/frontmatter.ts  YAML split and metadata block formatting
src/table.ts        the wide-table allocator — the reason the tool exists
src/wrap.ts         ANSI-safe prose wrapping for what marked-terminal won't
src/glyphs.ts       Unicode/ASCII capability tier — the only module that reads env
src/width.ts        display-width measurement + the East Asian Ambiguous probe (WP-3);
                    the only module that imports string-width
src/lang.ts         fence-language alias map + supportsLanguage() fallback
src/config.ts       XDG config load + corpus-manifest path resolution
src/detectors.ts    orphan / continuation-over-indent detectors (see below)
corpus/             the bundled public-safe default manifest
scripts/sweep.ts    multi-corpus width sweep (see "Corpus sweep" below)
tests/              unit tests + markdown fixtures
tests/helpers/containment.ts  the publication guard's rules (see "Containment" below)
dist/mdview         compiled binary (gitignored; see PATH install below)
```

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
| `text`, inside a list | Every item of a **tight** list arrives here instead, as a raw block text token still carrying the author's own line breaks. See below |
| `blockquote` | Parses its children itself so the body is observable, then gives back the first line's indent that the library's `quote.trim()` strips. See below |

#### Loose list items are wrapped by `paragraph`, at the item's own budget

`marked`'s lexer stamps `loose = true` on a whole list if any item ends with a blank
line, and each loose item is then parsed into a paragraph token. So a loose item's text
is wrapped by the `paragraph` override, **before** `list` glues on the item's marker and
its blanket indent. Wrapping it at the full target width there is what produced the
orphaned-line defect: the text came back 6+ columns over budget and `rewrapListBody`
reflowed it a second time, shearing the tail word onto a line of its own.

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

Four things that must not be simplified away:

- **A `\n` here is authored, and coalescing it is lossless** — which is *not* true one
  seam over. Markdown treats a single newline inside a paragraph as a soft break, i.e.
  one space, and because nothing reflowed the text no word has been hard-split. This is
  precisely the information WP-2b found destroyed in the `paragraph` path; do not carry
  that conclusion across.
- **A hard break is still distinguishable, but not as `HARD_RETURN`.** `Renderer.prototype.br`
  never fires for a tight item (nothing dispatches its inline tokens), so no `\r` is ever
  produced here — the *markdown source spelling* survives instead: two or more trailing
  spaces, a trailing backslash, or a literal `<br>`. Those are the segment boundaries.
  Measured over 600 corpus files: 11,675 soft breaks, 1 hard break, 0 `\r`.
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
`trackListLine` in `src/detectors.ts`, shared with `findContinuationOverIndent`
deliberately: a detector and the fix it grades must not be able to disagree about where
an item's text column is. The fixture is `tests/fixtures/nested-list.md`.

#### `rewrapListBody` rewrites neither a fence nor a marker

The last pass over a composed list body re-wraps the lines still over budget at that
level. Two things it must never do, **both invisible to all seven gates**, and both of
which it did until WP-2f.

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
detector section below for why the other two are structurally blind to it.

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
`chromeWidth` stays `3N+1`. Both tiers are swept separately anyway (below); a change
that widens a glyph must show up there.

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

## Run

From the repository root, run gates sequentially, stopping at the first failure:

```bash
bun install
bun run typecheck
bun run lint
bun test tests
bun run src/cli.ts --check --width 80 tests/fixtures/wide-table.md
bun run sweep
bun run sweep -- --glyphs ascii
```

**Flag order matters.** `bun run --cwd <dir> <script>` works; `bun --cwd <dir> run
<script>` does **not** — on Bun 1.3.11 it prints `bun run`'s help text and **exits 0**,
i.e. it silently passes without executing the script. Verified reproducible in a second,
unrelated package, so it is a Bun CLI behavior, not a quirk of this one. Never write the
second form into a gate: it is a gate that can never fail.

The `--check` gate is the CLI's own self-smoke: it renders with no pager and exits
non-zero if any output line exceeds the target width. All **seven** gates are binding
and must exit 0.

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
and settled — see "Two names, on purpose" at the top of this file. Do not reconcile the
two names.

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
same class of defect as the `cli-table3` v4/v7 disagreement below, and it is exactly the
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

*This paragraph originally justified the over-specification by claiming `TERM` alone
cannot separate the two terminals this tool is validated against, "because a multiplexer
rewrites it". **The validation run disproved that.*** Measured 2026-07-28: ghostty under
zellij reported `TERM=xterm-ghostty`, not a rewritten `screen`/`tmux-256color`, and urxvt
reported `rxvt-unicode-256color` — so `TERM` alone *would* have separated these two. The
key is still right, for the weaker and honest reason: `TERM` is a *terminfo* name, not an
identity, two emulators can and do claim the same one, and a multiplexer rewriting it is a
real behaviour that merely did not happen here. Over-specifying costs one re-probe;
under-specifying hands ghostty urxvt's answer. Keep the claim sized to the evidence. Writes are atomic (temp file +
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

- **A table's border row cannot be made to fit.** `cli-table3` draws a horizontal rule as
  one `─` per column of cell width, so the border row is exactly *twice* the content
  rows. `renderTable`'s re-render loop reduces the budget by the observed overage — but
  here the overage **is** the entire budget, `allocateWidths` reports `fits: false`, and
  the loop correctly declines to collapse the table rather than emitting a wreck.
  Measured on `tests/fixtures/wide-table.md`: **160 columns at a target of 80, 200 at
  100 — exactly 2×**, pinned in `tests/width.test.ts`.
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

#### The residual, named rather than papered over

**`cli-table3` bundles its own `string-width@4.2.3`, which has no `ambiguousIsNarrow`
option at all**, so its cell padding can never honour wide mode. A cell containing *k*
ambiguous characters is padded *k* columns too wide, and since *k* varies cell by cell
within a column, **a table's right edge can be ragged by up to *k* columns in wide
mode**. This is not fixable from outside the library: it pads to `colWidths` in its own
units, so no amount of pre-padding, pre-wrapping or budget adjustment on our side can
make its count agree with ours per-cell.

What the existing re-render loop *does* absorb, with evidence: the **aggregate** overage.
It measures the finished table with our `Measure` and re-allocates against a reduced
budget, so with unambiguous borders (the ASCII tier — i.e. the tier wide mode actually
gets) the widest line stays within the target: ambiguous-carrying tables at targets 80
and 100 came back at 80 and 83. What it cannot absorb is an overage equal to the whole
budget, which is the box-drawing case above.

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

### Corpus sweep

`scripts/sweep.ts` renders whole corpora in one process at **80/100/116/160/346** columns,
honoring `codeRanges`. **116 and 346 are two of the user's three real terminal widths**
(the tiled layouts are 116 / 172 / 346) and were added in WP-2c; before that the sweep ran
80/100/160, none of which anyone reads at. Widths are only ever added here, never swapped
out — the dated full-corpus runs in the private archive's `measurements/` are recorded
against the older set and have to stay comparable. It replaced a shell loop that spawned the 102 MB binary per file, and is
~13× faster.

**Corpus roots are not hardcoded — they load from a versioned JSON manifest** (WP-1).
This is what lets this tool live in a public repo with zero knowledge of any local path:
the manifest is the only thing that knows where a corpus actually lives, and the
bundled one that ships with the source knows nothing private at all.

Manifest resolution, highest precedence first:

1. `--manifest <path>` (a sweep-only CLI flag)
2. `MDVIEW_CORPUS_MANIFEST` environment variable
3. config key `corpusManifest` (`src/config.ts`, XDG config path)
4. the bundled default at `corpus/default-manifest.json` — **public-safe, relative
   roots only, covers this repo's own docs and `tests/fixtures/`**

The sweep always prints which manifest it resolved and why, before any corpus output.
**When the resolved manifest is the bundled default, it prints an unmissable notice on
its own line** — a green run against the bundled default proves almost nothing (it's
~5 files); do not mistake it for a validation run.

```bash
bun run sweep                                   # unicode tier, resolved manifest
bun run sweep -- --glyphs ascii                 # ascii tier
bun run sweep -- --corpus <name> --all          # one corpus, full (no sampling)
bun run sweep -- --manifest example/manifest.json  # override resolution
```

Each corpus in a manifest may set a `sample` (positive integer): if set, that corpus is
stride-sampled to that many files unless `--all` is passed; `--limit` overrides the
manifest's value. A corpus with no `sample` always sweeps every file it resolves.

Expected: `overflow=0 errors=0` on every corpus, **both tiers**. The sweep is what caught
the list-item reflow defect the fixture gate missed — `wide-table.md` has no long
bullets, so it stayed green while 250 of 256 real files overflowed.

**The corpora are the user's real data. Open them read-only; never write to them.**

#### The real validation corpus is private, and this repo does not know where it is

The manifest that actually exercises this tool against ~44.5k real files — an Obsidian
vault, research reports, every tracked initiative's docs — is generated and committed in
a **separate private archive repo**, which this file deliberately neither names nor
locates. That archive holds its own `README.md` (provenance), the manifest generator, the
generated manifest, `measurements/` (dated full-corpus runs), and a validity memo (what a
green sweep does and does not prove). Point `MDVIEW_CORPUS_MANIFEST` at a manifest to
reproduce those runs; every measured file count, date and commit lives in the archive,
because none of it belongs in a repo that ships publicly.

**Describing the archive by role rather than by path is the rule, not an accident here.**
This file, `src/render.ts` and `scripts/sweep.ts` all previously cited private repos by
name — one of them by file *and line number* — and the containment guard below is what
now holds the line. Keep the reasoning; drop the coordinates.

#### ⚠ The sweep proves width, and only width

`--check` and both sweeps **exempt fenced-code ranges from checking**. That exemption is
correct for width — fences are never rewritten, so their width is not ours to guarantee —
but it means **content corruption inside a fence is invisible to every one of the seven
gates**. WP-2 shipped exactly that bug fully green: a bullet-substitution pass rewrote
`* not a bullet` inside a fence nested in a list item, and nothing caught it.

So: **a change that touches rendered text is not verified by a green sweep.** Byte-compare
the code-range *content* against the previous commit — render each corpus file on both
revisions, extract the `codeRanges`-covered text, and diff. A green sweep plus an unchanged
code-range dump is the real bar.

This is the fourth time a gate here passed for a narrower reason than it appeared (the
fixture had no long bullets; the highlight path is dead under tests because
`marked-terminal` skips highlighting when stdout isn't a TTY; tier purity was unmeasured;
code ranges are exempt). **When a gate passes, check that it passes for the right reason.**

#### Defect detectors — the gates that can see *under* the width

`src/detectors.ts` (WP-2d) is the answer to the section above. Every list-wrap defect this
tool has shipped was **under** the target width, and `--check` and both sweeps only test
for *exceeding* it, so no green sweep in this repo's history has ever been evidence about
that class. Three detectors, all width-blind by design where the width is not the point:

| Detector | Finds |
|---|---|
| `findListOrphans(rendered, width)` | a line in a list item with <= 2 words, after a nearly-full line, followed by more prose in the same item |
| `findContinuationOverIndent(rendered)` | a continuation line indented past **its own item's** text column |
| `findColumnZeroMarkers(rendered)` | a rendered list marker at **column 0** — outside the block it belongs to (WP-2g) |

Five things about this module are load-bearing:

- **The first two detectors are structurally blind to the column-0 class, and that is
  why the third exists.** Both require `isIndentedLine`, so a line that collapsed to
  column 0 is skipped by each of them — no count either of them produces is evidence
  about WP-2g's defect, in either direction. The corollary bit twice: fixing the collapse
  makes previously invisible lines *newly* measurable, so the fast tier's orphan count
  goes **up** where the rendering got better. `findColumnZeroMarkers` is the instrument
  that can actually see it, and its adjacency clause is not a free zero — authored prose
  legitimately opens a line with `-` or `1.` at column 0, so the marker shape alone
  reports 30 hits over 599 blockquote-free corpus files and requiring the nearest
  non-blank neighbour to be *indented* takes that to 2. **Pass `codeRanges`**, or an
  indented fence under an authored `1.` paragraph reads as adjacency.
- **`findContinuationOverIndent` reports two classes it cannot tell apart, and its
  residual is not a to-do list.** It compares a line's column against its own item's
  text column, so a block that is *legitimately* indented past that column reads as a
  hit: a blockquote or a fence inside a list item, indented by its own renderer's
  `this.tab`. Those are correct renderings and the re-alignment pass deliberately leaves
  them alone. **Read a non-zero count here before assuming a regression.** The *second*
  class it used to carry — a list nested inside a blockquote — was closed in WP-2g; see
  "A blockquote owes columns exactly like a list" above.
- **`findListOrphans` is history.** It is the metric every number WP-2, WP-2b and WP-2c
  recorded was measured with, moved here from `tests/render.test.ts` unchanged. Editing
  its body silently invalidates every dated figure in the private archive's
  `measurements/`, and since the numbers only go down, a drift **looks exactly like a
  fix**. Add a detector; do not loosen this one. The move was verified against 58
  aggregate metrics and every per-file corpus count, byte-identical either side.
- **The fenced-code exemption is opt-in.** All three detectors take an optional
  `codeRanges` and honour it, because fences are never rewritten and their shape is not
  ours to guarantee — the same reason the width gates exempt them. It defaults to *off*
  because turning it on changes `findListOrphans`' historical counts. New callers pass it.
- **`--detect` is off by default and that is not timidity.** The two bundled sweeps'
  contract is `overflow=0 errors=0`; the detectors measure a class that is still partly
  open — the two metric blind spots the orphan detector documents, and the legitimate
  over-indent class above — so switching them on by default would turn both gates red for
  known, tracked reasons and destroy their value as a signal.

##### The fast tier: few notes, every width

The full sweep is many files × five widths. The fast tier inverts both axes — a frozen set
of ~50 real notes that have actually failed, rendered at **every** width in a range:

```bash
MDVIEW_CORPUS_MANIFEST=<regressions manifest> \
  bun run sweep -- --corpus regressions --widths 40-360 --detect
```

`--widths` accepts an inclusive range (`40-360`), the existing comma list, or a mix
(`40-80,116,346`). The range form exists because **orphan defects are sharply
width-sensitive**: an orphan only exists when an authored line plus its marker and indent
straddles the target, so a note fails at some widths and is clean at others. A three-width
gate samples that essentially at random — the old 80/100/160 set was telling us about
80/100/160 and nothing else. The floor of 40 is the narrowest realistic tiled pane
(user-confirmed); 360 clears the widest real layout, 346.

**Measured: 50 notes × 321 widths = 16,050 renders in ~9 s**, both glyph tiers, against
the ~8 min the full sweep takes. The two tiers are complementary — many files × few widths
for breadth, few files × every width for depth.

`--max-orphans N` / `--max-over-indent N` make it exit non-zero above a threshold. They
are a **ratchet, not a target**: the regression corpus is a set of notes that are
*currently known-broken*, so its expected count is not zero, and pinning it to zero would
just mean never running it. What must not happen is the number going up. The set itself,
its index, and the current threshold values live in the private archive — a public clone
has no regression corpus and no thresholds to pin.

Run verification from this repo's root. This instruction used to read "run from
``, **not** the repo root": while this tool was a subfolder of a mono-repo, the
parent's `node_modules` resolved a different `string-width` and gave false readings.
Extraction removed the parent, so there is no longer a second resolution to get wrong —
but the failure mode is worth knowing, because it is silent and looks like a real
measurement.

### Containment — this repo is published, and it grew up next to private ones

`tests/helpers/containment.ts` holds the rules; `tests/sweep.test.ts` runs them over
every file here, **itself included**. They are part of `bun test`, so they are covered by
the seven gates and need no separate command.

**It used to be a denylist of five literal private strings, and that shape cannot work.**
A denylist can only contain the leaks somebody already found: it was extended twice by
hand after near-misses and was still a name behind both times, most recently while a doc
comment cited a private repo's internal file *and line numbers*. Worse, the five literals
**were** the disclosure — publishing them would have named two private repos and the
machine's home layout — and a history scrub over those same strings would have rewritten
the guard's own constants into placeholders.

The rules are the inverse shape. **Nothing private is named anywhere in this repo.** Each
rule describes what this repo's *own* content looks like and flags everything else:

| Rule | Flags |
|---|---|
| `foreign-path` | a path-shaped citation whose first segment is not a directory this repo has, not an installed package, and not the sanctioned fake root — i.e. a neighbour's internal layout |
| `home-path` | an absolute path under a home-like root naming any account but the sanctioned fake one — i.e. the machine's directory layout |
| `neighbour-name` | a bare mention of a directory that actually sits around this checkout, read from the filesystem at run time and never written down — i.e. a name in prose, which is not path-shaped and which no path rule can see |

Four things about this are load-bearing:

- **It catches names nobody has enumerated, and that is the whole point.** The path rule
  keys on *shape*, so a sibling added next year is flagged the first time it is cited;
  the neighbour rule reads the directories that are actually there rather than a list.
  Reshaping the guard this way immediately found three references the hand-maintained
  denylist and a careful manual audit had both missed, including the user's account name
  sitting in a table fixture as test data.
- **There is no self-exception, deliberately.** The old guard excluded its own file —
  which is exactly where a denylist hides. The rule fixtures are assembled from parts at
  run time (`["widget_factory", "internal", …].join("/")`) so the test file does not itself
  contain the shapes it tests for, and the scan covers it like any other file.
- **`example` is the one sanctioned fake vocabulary** — `example/…` relative,
  `/home/example/…` absolute. Documentation and test data that needs a plausible path
  uses it. Anything else is a finding, including in fixtures: two of the leaks this
  replaced were sitting in fixture markdown.
- **Nothing here can go inert.** The path and home rules need no configuration at all and
  are sufficient on their own; the neighbour rule needs only directories that necessarily
  exist. A missing `node_modules` is a hard error rather than an empty package set. The
  optional supplement below either applies or says out loud that it did not.

**If you check a dependency out beside your clone, that is handled — but on evidence.**
The neighbour rule drops a name that collides with an installed package *only* when the
directory proves it is that package: a `package.json` naming itself. Otherwise reading
`marked-terminal`'s source next door — which this file tells you to do — would turn every
mention of it into a finding, and a guard that fails for reasons unrelated to your change
is a guard that gets switched off.

**Do not "simplify" that by subtracting every installed package name from the neighbour
set.** The path rule already treats a package name as a safe first segment (it must, so
`marked/lib/marked.cjs` can be cited), which means the neighbour rule is the *only* thing
catching a private sibling whose name collides with a package —
`<pkg-named-sibling>/private/layout.ts` slips past the path rule and is caught here.
Subtract the intersection wholesale and both rules go blind at once. Three tests pin this,
including the hole the evidence-based exemption deliberately leaves open.

**The supplement, and why it is only a supplement.** Private strings that are neither
path-shaped nor directory names — a person, a client, a host — cannot be derived, so a
*list* is the only instrument. That list is private, and this repo reaches it the way it
reaches the corpus manifest: it is **told a path** and knows nothing about the other end.

```bash
MDVIEW_PRIVATE_NAMES=<path to a {"names": [...]} JSON file> bun test tests
```

Two states, and only two. **Unset**: the three always-on rules run — which is the binding
guard — and the test writes a line to stderr saying the supplement was not applied.
**Set**: the file must exist and parse to a non-empty list of non-empty strings, or the
test **throws**. A pointer at a file that has moved is precisely how an opt-in check rots
into one that can never fail, so it is a hard error rather than a quiet fall-back.

**Width-sensitive fixtures are a trap here.** `tests/fixtures/wide-table.md` is the
`--check` gate's fixture and its whole purpose is being wide, and `table.test.ts`'s
`LONG_PATH` feeds column-width assertions. When a path in either has to be replaced,
**the replacement must be no shorter** — shortening one silently weakens a binding gate
while every test stays green.

To render a file interactively:

```bash
bun run src/cli.ts example/plan.md
```

## Conventions

- `src/cli.ts` exports `main(args = Bun.argv.slice(2))` so tests call it directly
  without a subprocess, matching the in-house convention for CLI-only tools.
- No shebang on `src/cli.ts`; it is invoked as `bun run src/cli.ts`, matching
  every other standalone `.ts` entry point in the family this tool came from.
- `INITIATIVE.md` exists here but did not while this was a subfolder — a tool folder in
  that family carried none, and the standalone repo is its own initiative. Its YAML
  frontmatter is agent-maintained; **the body is the user's**, and `# Blocked on User` is
  append-only.
- **No `FEEDBACK.md`, ever agent-created.** It is the user's scratchpad: read it if it
  exists, never write it, never scaffold it.
- `bun build --compile` (the `build` script) produces a **standalone compiled
  binary** — a new pattern for this repo, where every other `bun build` produces a
  bundle. It is ~102 MB (the Bun runtime is embedded) and gitignored via `dist/`.

  **The binary does not track source. It must be rebuilt after any source edit:**

  ```bash
  bun run build
  ```

  PATH install (already in place; `~/.local/bin` precedes `/usr/local/bin` on PATH):

  ```bash
  ln -sfn "$PWD/dist/mdview" ~/.local/bin/mdview         # from the repo root
  ```

  The symlink points at the build output, so a rebuild takes effect immediately — but
  editing source without rebuilding leaves `mdview` silently running the old code.

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

### Dependencies (WP-5)

The premise this WP started from — "trim dependency fat to shrink the binary" —
inverted once it was measured. Record that inversion here so nobody re-derives it and
re-opens a removal pass that costs review time for zero benefit.

**Binary size is not a dependency problem.** The compiled binary (`bun build
--compile`, see "Conventions" above) is ~98 MB, almost entirely Bun's own embedded
runtime — present in every Bun-compiled binary regardless of what a project imports.
The actual runtime dependency closure (`marked`, `marked-terminal`, `cli-highlight`,
`cli-table3`, `string-width`, `yaml`, and everything each pulls in transitively) is
**60 packages, ~8 MB**. The other **~57 MB of `node_modules`** (122 packages total) is
devDependency tooling — `eslint`, `typescript`, `typescript-eslint`, `jiti`,
`@types/bun`, and their own transitive closures — that never ships in the binary at
all. Dependency weight is therefore **~2% of the compiled artifact**. "Remove a
dependency to shrink the binary" is the wrong frame for this tool; no dependency was
removed on that basis, and none should be without re-measuring what actually changes.

**`cli-highlight` and `cli-table3` must stay declared in `dependencies`, even though a
dependency-pruning tool will flag both as reachable transitively through
`marked-terminal`.** `src/lang.ts:13` imports `supportsLanguage` from `cli-highlight`
directly, and `src/table.ts:1` imports `Table` from `cli-table3` directly — neither
import goes through `marked-terminal`'s own copy of either package. Dropping either
declaration would leave those imports resolving only because `marked-terminal` happens
to hoist a compatible version of the same package into `node_modules` — code that
works by accident of a *different* package's dependency tree, for **zero** install-size
saving, since the packages are already present in `node_modules` either way. **Do not
remove either declaration on a dependency-graph tool's say-so**; the tool is reading
reachability, not who actually imports what.

**`highlight.js` is pinned at `10.7.3`** (a transitive pin, via `cli-highlight`), two
majors behind upstream, **and cannot be subset to shrink it**: `cli-highlight`
hardcodes a full `require` of highlight.js's entire bundled language set rather than
importing individual languages one at a time, so there is no seam to trim unused
languages through. Upgrading past the pin is out of scope for this WP — recorded here
so the staleness is a known, deliberate deferral, not something a future pass
rediscovers and "fixes" by bumping a major version with no compatibility check against
this tool's fence-language handling (`src/lang.ts`).

**`emoji: false` was investigated and rejected — but read *which* evidence rejected it.**
`marked-terminal` ships a `:shortcode:` → emoji-glyph pass (`insertEmojis`, gated by
its own `emoji` option, default `true`); turning it off saves ~468 KB in the compiled
binary, which is why it was investigated at all. **Measured 2026-07-28, and the answer
depends entirely on which walk you use — which is the part worth remembering.**

Method: render each candidate token twice, `emoji` on vs off, and keep only tokens whose
rendered bytes actually *differ*. A behavioural test rather than a `node-emoji` lookup,
so it cannot drift from what the library really substitutes. Fence-aware, since
`marked-terminal`'s `code` renderer never applies the transform.

| Walk | Files | Prose shortcodes that change rendering |
|---|---|---|
| What `scripts/sweep.ts` actually sweeps | 45,129 | **0** — all 19 hits sit inside fences, inert |
| Following symlinked subtrees as well | +12,363 | **392**, across 59 files; 282 whitespace-isolated |

The 392 are `star`×117, `wrench`×69, `bulb`×41, `thread`×31, `warning`×18 and a long
tail — unmistakably authored, not colon-delimited accidents.

**Every one of them is invisible to the sweep.** `walkMarkdown` gates on
`Dirent.isDirectory()`, which is `false` for a symlinked directory, so a symlinked
subtree is silently never swept — `scripts/sweep.ts` documents this itself and flags it
as an open question. The swept corpus therefore reports `emoji: false` as perfectly safe,
and it is not.

**`emoji: false` is therefore not set** — see the comment at `src/render.ts`'s
`markedTerminal()` construction, which points back here. The decision follows the files
the user actually reads, not the files the gate happens to walk: flipping it would strip
glyphs from 59 real documents to save ~468 KB of a ~98 MB binary (**0.5%**). No gate here
would catch that regression — neither sweep measures *content*, only width. **If you
re-open this, re-run the behavioural test over the symlink-following walk**; the sweep
corpus alone will tell you it is safe.

**Corollary, and it deserves its own WP:** those 12,363 symlink-reachable files are real
user markdown that no gate in this repo has ever rendered. The effective corpus is ~21%
smaller than the manifest implies, and every "verified across the whole corpus" claim
made before 2026-07-28 — including this file's — carries that hole.

**Pins.** `package.json`'s `dependencies` are pinned to the exact versions already
installed and exercised by this test suite — `marked@14.1.4`, `marked-terminal@7.3.0`,
`cli-highlight@2.1.11`, `cli-table3@0.6.5`, `string-width@7.2.0`, `yaml@2.9.0` — rather
than left on `^` ranges that could silently resolve to an untested minor on a fresh
`bun install` on a different machine. **This WP pins; it does not upgrade.** Bumping any
of these is a separate, deliberate decision with its own corpus/sweep verification
pass, not a side effect of installing on a new machine.

Plans: `plans/mdview.md` (the original build) and `plans/vault-readiness.md` (glyph tier,
fence languages, divider, embeds, and the multi-corpus sweep). The two sat at different
levels before extraction — the first predated the tool's own folder — and were flattened
into one `plans/` when this repo was split out.
