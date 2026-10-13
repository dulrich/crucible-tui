# The list pipeline — renderer reference

> **Historical as of `TS_BASELINE` (`c097c66`).** The TypeScript renderer this record cites as live code was deleted at WP-9 of `plans/mdview-rust-port.md`; its `src/*.ts` paths name that sha's tree, and the Rust port of each module is `crates/mdview/src/<name>.rs`. The measurements stand as recorded.

*Reference record for `src/`, moved out of `crates/mdview/AGENTS.md` at WP-4 of
`plans/docs-and-memory-curation.md`. **`crates/mdview/AGENTS.md` is the parent contract — read it
first**, and read its "How to read this file" for the two conventions everything below is
written under: every requirement is stated with the measurement that established it, and a
citation like `index.js:539-578` is historical evidence from `marked-terminal@7.3.0`
rather than a live dependency. There is deliberately **no `CLAUDE.md` symlink** beside this
file: it is an on-demand reference read, not a per-directory auto-loaded contract.*

**What this file settles:** composition, the two wrap paths, the de-drift, the claim
domains, and the retained passes.

**One live-code citation below is out of date on purpose, and here is the one correction
that fixes all nine of them.** Every `src/render.ts` citation in this file that names a
*seam* — the `text` override and its guards, `rewrapListBody`, `LIST_LINE_PREFIX`,
`currentListBudget`, `isHardBoundary`, `coalesceTightItemLines`, the `LIST_INDENT_PER_LEVEL`
grid, and the `{ columns, list: true }` push the `list` override makes — reads
**`src/list-layout.ts`** now. WP-R2 of `plans/post-refactor-code-quality-remediation.md`
moved the five visitors that share the per-render layout state (`list`, `text`, `paragraph`,
`heading`, `blockquote`), that state itself, and the module-level helpers only they call out
of `renderDocumentDetailed` into one factory, `createListTextLayout(layout, sentinel)`. It
landed **byte-identical**: not one measurement, guard, ordering or conditional in this record
changed, which is why the text below is left as it was written rather than re-edited around a
file rename. `src/render.ts` still owns lexing, the `LayoutContext`, visitor assembly, the
walk, the code-range sentinel (`wrapCode`/`extractCodeRanges`) and the post-processing pass.
See `crates/mdview/AGENTS.md`, "What each renderer method must do", for the live ownership table.

## The list pipeline

Four defects live in this family, all of them variations on one theme — *a line has to be
laid out at the width it will actually occupy, and only composition knows that width* —
and the passes below are what closed them. Since WP-5, **composition owns the marker, the
indent, the per-item budget and the de-drift**; `src/render.ts` owns the seams that wrap
prose and the two post-compose passes that cannot move.

### Composition pushes the item's **exact** marker width, per item

`src/lists.ts`'s `composeItem` pushes `{ columns: markerWidth, list: false }` onto the
`LayoutContext`'s prefix stack for the duration of that item's own parse — `"* "` is 2,
`"7. "` is 3, `"12. "` is 4 — so `paragraph`, `text`, `heading` and `html` all wrap at the
columns *this item* actually owes.

**The widest-marker estimate this replaced is deleted, and its rationale with it.** Until
WP-5 the level pushed one `4 + widest` entry for every item, where "widest" was computed
from the level's whole subtree (`listMarkerWidth`, `markerLineCount`,
`nestedMarkerLineCount`, all gone). That over-narrowed items 1–9 of a ten-item ordered list
by a column (family B1) and, because the estimate counted *nested* lists' markers too,
over-narrowed every item of an ordered list containing one (family B2). The older claim
that an item's index is not reachable at wrap time was true only while the library composed
items; `composeItem` **is** the item, and it knows its own number.

That entry is `list: false` deliberately: the level's own four columns are the `list: true`
entry `src/render.ts` pushes, and a second `list: true` here would double `listDepth()` and
break `substituteBullets`' outermost-list gate.

**Neutered and re-measured, so it is not a vacuous claim:** replacing the per-item budget
with the old estimate produces **3,954 diffs and 6 class-C violations**.

### Loose items are wrapped by `paragraph`, at the item's own budget

`marked`'s lexer stamps `loose = true` on a whole list if any item ends with a blank line
(`marked/lib/marked.cjs:557-561`). A loose item's text is wrapped by the `paragraph`
renderer, **before** the composer glues on the marker and the blanket indent. Wrapping it at
the full target width
is what produced the orphaned-line defect: the text came back 6+ columns over budget and
the post-compose wrap reflowed it a second time, shearing the tail word onto a line of its
own.

The rule: **`paragraph` wraps at the width its text will actually occupy.** It reads
`targetWidth - prefix.width()` off the stack, and the wrap happens inside
`renderBlockParagraph` (`src/blocks.ts`) with `wrapAnsi` and `Measure` — not by
constructing a second renderer, which is what this cost until WP-3.

**How a loose item reaches `paragraph` at all was misdescribed here until WP-2 of
`plans/own-the-token-walk.md`, and the correction matters to anyone reading the walk.** This
section, `src/render.ts`'s `text` seam and that plan's own contract table all said the
lexer gives a loose item **`paragraph` children**. It does not. `Tokenizer.prototype.list`
(`marked.cjs:550-561`) lexes every item's body with `state.top = false` and then only
*stamps* `loose`; it never re-lexes, so a loose item's children are `text` tokens exactly
like a tight item's. Measured at `marked@14.1.4`, `- one\n\n- two\n` gives
`loose = true` with `items[n].tokens` of `["text"]`.

What routes a loose item to `paragraph` is the **`top` argument**: `src/lists.ts` dispatches
each item through `parse(item.tokens, !!item.loose)`, and at `top === true` the block `text`
case *synthesizes* a paragraph token around the rendered body. So the fabricated token from
the walk's contract is not a top-level curiosity — **it is on the path of every loose list
item in the corpus**, which is why `src/walk.ts` reproduces its shape exactly, down to the
inner text token carrying no `tokens` key. A traced loose item dispatches
`text(hasTokens=true)` → `paragraph(tokens=["text"])` → `text(hasTokens=false)`; a tight one
dispatches `text(hasTokens=true)` and stops. A `space` token between two paragraphs inside
one loose item terminates the coalescing run, so that item yields two synthesized paragraphs
rather than one. All of this is pinned in `tests/walk.test.ts`.

**The gate is the stack's total, not "are we inside a list."** It read `listDepth()` until
WP-2g, which left quoted prose four columns over budget at every width — see "A blockquote
owes columns exactly like a list" below for why that only ever looked fine.

Three things that must not be simplified away:

- **The marker width is derived, never hardcoded**, and since WP-5 it is the item's exact
  marker rather than a level-wide estimate. `"* "` is 2 columns, `"10. "` is 4.
- **Do not "coalesce and re-wrap" a paragraph result instead.** By the time this seam has a
  rendered paragraph, reflow has rendered its own wraps and an author's hard break as the
  same bare `\n`, and has hard-split any word longer than the width with no marker — so
  rejoining lines destroys authored breaks and corrupts long URLs and paths. (This is the
  WP-2b failure mode, and it is exactly what makes the *tight* path's coalescing safe: see
  below. Do not carry either conclusion across.)
- **A continuation line may not be allowed to start with `*` or `N.`.** `isPointedLine`
  takes any such line for a marker line — a continuation line is still at column 0 when it
  runs — and in an *ordered* list the numbering pass then hands it that item's number and
  rewrites the first `"* "` anywhere in it. The item's text is corrupted and every later
  item is renumbered. Since this seam chooses where lines break, it also chooses whether
  that fires: a colliding continuation is re-wrapped a column narrower and given one
  leading space, which `isPointedLine`'s exact-multiple-of-four indent group cannot match.
  Measured: **one occurrence in a 1,000-file corpus sample before the guard, none after.**

**Two shapes are guarded, not one** (WP-3): `MARKER_SHAPED_LINE` and the detectors' broader
`COLUMN_ZERO_MARKER`, united as `isGuardShapedLine` in `src/list-lines.ts`. The second was
added because the harness's detector ratchet caught WP-3 raising `findColumnZeroMarkers` by
exactly one — a top-level prose line that re-wrapped onto `+ sources` immediately above an
indented list. `isPointedLine` does not recognise `+`, so that line was never a renumbering
hazard; it was a line that reads as a bullet nobody wrote, which is what that detector is
for. **And the guard runs at every budget now**, where it used to run only inside a list or
blockquote: the old override took an early return at prefix width 0 and the guard sat below
it, so a top-level paragraph never got one — and the regression above *was* a top-level
paragraph. At column 0 the renumbering half of the hazard genuinely does not apply; the
legibility half does, and the cost is one paragraph re-wrapped a column narrower.

**No width gate can see the defect this closes**: an orphaned line is *under* the target
width. It is covered by the orphan metric in `tests/render-lists-wrapping.test.ts` against
`tests/fixtures/loose-list.md`, by the detector ratchet in the parity harness, and by
nothing else.

### Tight items are parsed by `text` — and wrapped on **two different paths**

The mirror image of the loose case, and a **different seam**. A *tight* item is never
wrapped in a paragraph token, so `Parser.parse(item.tokens, false)` dispatches its block
`text` token straight to the `text` renderer. The library's `text` (`index.js:84-89`)
returned the raw `token.text` through an `identity` option and **never dispatched
`token.tokens`**, so nothing reflowed it *and* nothing parsed it: the author's own line
breaks arrived verbatim, and `**bold**` and `[label](url)` reached the terminal literally.
A **tight list item was the only container in the whole renderer that reached the terminal
as raw markdown** — `heading` (`:116-119`), `paragraph` (`:201-211`) and `tablecell`
(`:260-265`) all called `parser.parseInline(token.tokens)`.

`src/inline.ts`'s `renderInlineText` is that one-line function today; the wrapper in
`src/render.ts` is where the work is. Three independent conditions identify a tight item's
own text, and any one failing means the raw text is returned untouched:

1. `listDepth() > 0` — inside a list;
2. `inlineDepth === 0` — **not** inside a renderer that dispatches inline tokens
   (`paragraph` and `heading` bracket themselves with that counter);
3. the token carries `tokens` — block text tokens do, inline ones do not.

**Condition 3 is load-bearing, not decorative.** Over 600 corpus files this seam saw
**11,443 tight-item block text tokens and 413 inline text tokens inside lists, 242 of them
multi-line** — a loose item's source lines. Coalescing those is precisely the WP-2b failure
mode, and only `tokens` separates them.

**The wrap is split across two paths, and the split is deliberate — state it explicitly.**

- **Coalesced items** — where a multi-line item's soft-wrapped source lines were joined back
  into one logical line per hard-break-delimited segment — **are wrapped here**, at
  `targetWidth - prefix.width()`, with the same marker-shaped-line guard the loose path uses
  — **always fired on this path, and sized so the guarded line misses the four-column grid**
  (see below; it was one space unconditionally, the coalesced path's own pre-WP-5 rule kept
  byte-for-byte, until WP-1 of `plans/renderer-deferred-work.md`).
- **Uncoalesced items** — a single authored line, or segments separated by genuine hard
  breaks, which is *most* tight items — are **left to `rewrapListBody` after composition**,
  on purpose. `marked`'s inline lexer hands this seam `&#39;`-spelled entities, and
  `transform` (`src/blocks.ts`) decodes them **during composition, after the seam** — so a
  wrap decided here measures `&#39;` at five columns where the terminal shows one, and moves
  the wrap point of nearly every apostrophe-carrying item. The post-compose pass sees decoded
  bytes; this seam does not. (The coalesced path accepts that skew deliberately: it always
  has, its bytes are pinned by the parity gate, and re-ordering it would move every
  soft-wrapped item in the corpus.)

**The two paths guard differently, and that asymmetry is load-bearing — do not "unify" it.**
Both seams give a continuation line a leading space when it would otherwise begin `*` or
`12.`, and both re-wrap a column narrower first so the space costs no width. What differs is
*when* the guard may be skipped and *how wide* it is, because the two seams hand their lines
to different downstream passes:

- **`rewrapListBody` (uncoalesced) skips the guard off-grid**, gated on `onGrid`
  (`src/render.ts`). Its lines are already composed and carry their prefix as literal spaces,
  so the only pass left that can claim a marker-shaped continuation is `substituteBullets`,
  whose `UNORDERED_MARKER_LINE` is anchored on the four-column grid. An off-grid line —
  `"    1. "` is seven columns — is claimed by nothing and needs no guard. Its comment records
  that the *unconditional* form was measured causing a collision at width 55 on
  `fenced-list.md`, where the guard space moved a line from column 7 onto the grid at 8.
- **The coalesced seam always fires the guard, and varies its width instead.** Its lines are
  *pre*-composition, still at column 0, and `claimLine`/`isPointedLine` (`src/lists.ts`) is
  grid-blind: it claims a column-0 `*` line whatever column the item ends up at, strips it of
  its pad, and leaves it at the level's own indent — where `substituteBullets` rewrites it
  anyway. So off-grid is *not* safe here and the `onGrid` gate cannot be borrowed. Measured at
  WP-1 of `plans/renderer-deferred-work.md`: gating this guard on `onGrid` turned one
  corrupted width into two on the same witness (`tests/fixtures/coalesced-guard-collision.md`,
  widths 64 *and* 65 instead of 65 alone). The free variable is the guard's **width**. A
  guarded line lands at exactly `prefix.width() + guard.length` — every column of that prefix
  renders as literal spaces — and one space misses the grid for every marker this composer
  emits (`"* "` at 6+1, `"12. "` at 8+1) *except* the one-digit ordered marker (`"1. "`, 7+1).
  There the seam narrows one column further and guards with two, but **only when all three of
  these hold**: the one space would land on the grid; a marker-shaped continuation survives the
  narrower wrap; and one of the survivors is `*`-shaped. The third is not fussiness —
  `UNORDERED_MARKER_LINE` matches `*` only, and a `12.`-shaped continuation on the grid is
  rewritten by nothing after composition, so for those the one space is still right and keeping
  it keeps their bytes. Each condition was priced on the private corpus at 2 axes: without the
  second, **116 combos moved and three detector counts rose**; without the third, 101 and two;
  with both, **52 combos and no ratchet movement at all**.

**The defect that rule replaced, so nobody reinstates the single space.** A one-digit ordered
item on the coalesced path composes at column 7. At width 65 the one unconditional guard space
moved a continuation carrying the author's own literal `*` to column 8 — exactly on the grid —
and `substituteBullets` rewrote the `*` into the depth's bullet glyph `◦`. **The rendered
output contained a nested list item nobody wrote**, at that width only; 64 and 66 were clean.
The guard caused exactly the collision it exists to prevent. **No gate in this repo could see
it**, and that is the durable half: `findContinuationOverIndent`'s drift-1 exemption forgives
*guard-shaped* lines, and `"◦ "` is guard-shaped — the detector swallowed the artifact the
corruption produced (see `scripts/AGENTS.md`).

Four more things that must not be simplified away:

- **A `\n` here is authored, and coalescing it is lossless** — which is *not* true one seam
  over. Markdown treats a single newline inside a paragraph as a soft break, i.e. one space,
  and because nothing reflowed the text no word has been hard-split.
- **A hard break is distinguishable, and it is `HARD_RETURN` on the parsed path.** Once
  inline tokens are dispatched, `br` fires inside an item, so this seam converts each marker
  into `HARD_RETURN + "\n"` — which `isHardBoundary` refuses to join across — and strips the
  markers on every return path. **No bare `\r` reaches the terminal**; that is a pinned
  invariant, not a hope. `HARD_BREAK_TAIL` (two trailing spaces, a trailing backslash, a
  literal `<br>`) is the *fallback* spelling and still guards every `return raw` path, where
  the source arrives unparsed. Measured over 600 corpus files: **11,675 soft breaks inside
  tight items, 1 hard break, 0 `HARD_RETURN`, 0 `SENTINEL`** — rare is not never, which is
  why this is a boundary and not a heuristic.
- **A hard break inside a *loose* item is still dropped, and that is a pre-existing defect**
  — the library preserved it; this repo's `paragraph` path collapses
  `first line  \n  second line` to one line. Measured identical at `8504bd0` (pre-WP-14), so
  the `text` seam did not cause it. Recorded in `plans/representative-corpus.md`, not fixed.
- **Fences, tables and nested lists are excluded by construction, not by inspection.** Each
  is its own token type and never reaches a `text` call — measured: **0 of 11,443 tight-item
  tokens contained a `SENTINEL`**. The sentinel check in the seam is belt and braces on that
  measurement. Do not replace it with a line-shape heuristic over the composed body.

**The defect was a property of the dispatch path, not of the marker.** Verified at the
library baseline, a tight item rendered `**b**` verbatim and a loose one rendered it bold,
because a loose item reached `paragraph` — which called `parseInline` — and a tight one did
not. The orphan population this seam's wrap closed: **1,823 orphans across 250 files at
width 100 in a 1,744-file corpus sample.**

**This paragraph said "a loose item's children are `paragraph` tokens" until WP-2 of
`plans/own-the-token-walk.md`; they are `text` tokens** (see the loose-item section above
for the measurement). What differs is `top`, not the child type, and the correction changes
what stops the double parse. Do not "extend" the seam to the loose path — a loose item's
block `text` token *does* arrive here and is parsed here, and it is the **synthesized**
paragraph's inner text token, which carries no `tokens`, that makes the second visit a
verbatim pass-through rather than a re-parse. Traced: `text(hasTokens=true)` →
`paragraph(tokens=["text"])` → `text(hasTokens=false)`. Condition 3 is what holds the whole
arrangement together, on both paths.

**The punctuation-leading continuation wrap — pinned in WP-5 of
`plans/renderer-deferred-work.md`, not fixed, and its causal record corrected twice
before landing.** `plans/marked-terminal-replacement.md`'s WP-6 deferred-finding note
first recorded this as a real cosmetic defect it could not attribute precisely: a
coalesced continuation whose first visible character is a piece of punctuation that
cannot start a word, one column right of the item's own text column. WP-5's own brief
then proposed a specific mechanism — `LIST_LINE_PREFIX` (`src/render.ts`) greedily
absorbing a pre-existing extra column and stamping it onto every continuation
`rewrapListBody` creates — and that theory does not hold either: instrumenting
`rewrapListBody` directly shows it never re-wraps a line for the reproduction below at
all, and a margin argument over the nesting arithmetic (`currentListBudget`'s per-level
`4`-column step against a guard that can only ever add 1) shows an ancestor's wider
budget can never be exceeded by a descendant's guard-widened line, so this mechanism
has no live reproduction to attribute to it.

**The verified mechanism is the same guard "The two paths guard differently" already
documents, misfiring on a shape neither half of that section considered.** A colon
inside a code span becomes the 9-byte `COLON_REPLACER` sentinel (`*#COLON|*`) during
inline parsing, and `undoColon` does not decode it back until `composeItem`
(`src/lists.ts`) — *after* the coalesced tight-item wrap has already measured and
wrapped the segment. The sentinel's literal leading `*` matches `MARKER_SHAPED_LINE`,
so the coalesced guard fires on it exactly as it fires on an author's own glued `*` —
correctly, by the same "the one space was always right for it" reasoning `src/render.ts`
already gives for `*#COLON|*root`. What that reasoning did not anticipate is what
happens *after* the guard: `undoColon` shrinks the 9-byte sentinel back to one `:`, but
the one guard space in front of it is untouched by that shrink, so the rendered line
is one column wider than an unguarded continuation of the same item — the exact
punctuation-leading artifact the older plan recorded. Witnessed at
`tests/fixtures/coalesced-colon-guard-continuation.md` (`tests/render-lists-guards.test.ts`,
"the coalesced colon-guard continuation drift"), reproducing at widths 50, 60, 90 and
101 in both glyph tiers, from repo-local content — no private corpus needed, unlike the
evidence the older plan pointed a future package at and that turned out to live in an
archive no session can open. **Not fixed here either**: the guard is correct for the
reason it exists, decoding earlier would reopen the emoji-substitution-inside-verbatim-
content hazard `COLON_REPLACER` exists to prevent (see "The sentinels" in `crates/mdview/AGENTS.md`,
"`COLON_REPLACER` is a first-class owned mechanism"), and a repair needs the guard to know an item's
*true* text column rather than merely which grid column it must avoid — the same
missing primitive `LIST_LINE_PREFIX` lacks, so the repair this witness is waiting for
and the one the older, wrongly-attributed theory described may turn out to be the same
future work after all, just for a different reason than either record gave first.

**A sentence in `src/list-lines.ts` is narrower than the code, and by design (WP-5 of
`plans/renderer-deferred-work.md`) neither it nor `src/detectors.ts` is being edited to
fix it.** `MARKER_SHAPED_LINE`'s doc comment there says the render seams defuse a marker-
shaped continuation by giving it "one leading guard space"; `src/detectors.ts:531-543`
(off-limits to this package) says the same in its own words. After WP-1 of
`plans/renderer-deferred-work.md` that is only the common case: the coalesced seam now
widens to **two** spaces when the one-space form would itself land on the grid, a
marker-shaped continuation survives the narrower re-wrap, and one of the survivors is
`*`-shaped (see "The two paths guard differently" above). Neither file is wrong about
today's corpus — the two-space path was measured firing on no corpus file at any tested
axis — so both sentences are accurate about what actually renders; they are just no longer
the whole truth about what the guard *can* emit. Noted here rather than in either module,
per this package's file scope.

### A nested item's continuations are pulled back to their own item, per level

The third defect in this family and the one worth the most: a continuation line inside a
**nested** item was indented past its own item's first line, one marker width **per ancestor
level**.

The mechanism is in composition and is deliberately reproduced. `composeUnordered` /
`composeOrdered` (`src/lists.ts`, transcribed from `bulletPointLines` / `numberedLines`,
`index.js:539-578`) prepend the marker's width in spaces — `toSpaces("* ")`, 2, or
`toSpaces("12. ")`, 4 — to **every line the claim predicate does not claim**. For the level's
own items that is exactly right: it puts a continuation under its own marker's text. But the
body also holds an inner list that has already rendered, and there the same pad moves that
list's *continuation* lines while leaving its *marker* lines alone. The blanket indent shifts
every line equally and contributes nothing to the *relative* drift.

**`realignEmbeddedContinuations` (`src/lists.ts`) subtracts it back out, per level, inside
`renderList`, after `fixNestedLists`.** This is `src/render.ts`'s old
`realignNestedContinuations` (WP-2e), moved into composition by WP-5 — same call point, same
arithmetic, same skips — and the module and the byte-domain are the two things that changed,
so a reader looking for the old name in `src/render.ts` will not find it.

**Why the pad is not simply not added.** Not padding an embedded list's continuations would
move the indent of a fenced block nested inside a list item, which is content inside a
`codeRange` and therefore **class C**: measured at WP-5's dispatch, a fence inside a nested
item sits exactly one pad-width right of its item's code column per ancestor level *today*.
The pad is kept because removing it moves fence bytes; the subtraction is kept because
token-type tagging cannot replace it — a list inside a **blockquote** child is own-content by
token type yet an embedded list on the page, F10's hybrid join hides a marker inside a text
line until `fixNestedLists` splits it, and the claim dents inside fences must survive
byte-for-byte.

**This is not a cosmetic fix, which is why it is here and not in a style note.** A
continuation shifted right is a continuation over budget, and the shallower post-compose wrap
then shears its tail word onto a line of its own — the same orphan the two seams above chase,
from a source neither could see. Running the re-alignment *before* that wrap makes the orphan
disappear **as a consequence** of the indent being right. Measured on the WP-2d regression
tier at every width 40-360, both glyph tiers, **colourless**: **over-indents 29,035 → 3,683
and orphans 6,469 → 3,060**, with nothing in either wrapping seam touched. Neutered and
re-measured at WP-5: removing the de-drift produces **2,355 diffs**.

Four things that must not be simplified away:

- **It subtracts the drift; it does not snap lines to a column.** A blockquote or a fenced
  block inside a list item is *legitimately* indented past its item's text column by its own
  renderer, and `findContinuationOverIndent` reports those too. Snapping every reported line
  to the item's text column flattens them. Subtracting exactly the width *this level* added
  preserves every legitimate relative offset at every depth — and correctly leaves that class
  of detector hit standing.
- **Per level, not once at the outermost list.** The amount to subtract is the marker width
  this call just added, and that is only knowable here: at the outermost list the ancestors'
  drifts have already summed, and with levels of differing marker width the sum cannot be
  decomposed back. Deriving it from the bottom-of-stack item's own `textColumn -
  markerColumn` is what makes ordered levels work with no special case.
- **Fenced code is never rewritten**, by the same sentinel walk `substituteBullets` uses. A
  line that starts inside a fence, or that carries a sentinel of its own, is left alone *and*
  is not allowed to move the item stack.
- **A de-indented line may not become a marker.** Landing on the four-column grid with a
  leading `*` or `12.` is all `isPointedLine` asks for. Unordered text columns are never on
  the grid (`4d + 2`); a ten-item ordered list's are (`4d + 4`), so the case is live and is
  guarded with one extra leading space, as both wrapping seams guard it.

The stack model — "which item does this rendered line belong to" — is `trackListLine` in
`src/list-lines.ts`, shared with `findContinuationOverIndent` deliberately: **a detector and
the fix it grades must not be able to disagree about where an item's text column is.** It sat
in `src/detectors.ts` until WP-5 of `plans/tn-review-remediation.md` moved it — *relocated,
not copied*, precisely because one implementation is the property and one file is not. The
move takes the detector module (a second `Marked` instantiation, the block-end probe, the
shear classifier, none of which has a production caller) out of the graph the shipped binary
is compiled from. **Its value is cohesion, not size**: measured with `bun build --target=bun`,
the bundle shrank by **151 bytes of 2.68 MB**, because the bundler already tree-shook every
detector function `render.ts` could not reach. The fixture is `tests/fixtures/nested-list.md`.

### The claim decision: ANSI-stripped for prose, **raw bytes for fence lines**

`claimLine` (`src/lists.ts`) asks `isPointedLine` whether a composed line is a marker line,
and it asks on two different byte-domains on purpose. This is WP-5's family **C1** and it is
the fix for a whole class of colour/colourless divergence.

Under any colour level, `applyStyle`'s newline encasing re-emits the open code at the head of
every line of an item's text — *ahead of that line's own indent* — so a **raw-byte** claim
can never match an embedded list's marker line. The coloured and colourless renders of a
nested list therefore disagreed at the base commit, and every pass that made a structural
decision on raw bytes was silently inert in a terminal. Two measurements pin how inert: the
old realignment spelling rewrote **0 lines under colour against 115,472 colourless**, and the
ordered-renumbering defect (family B1) is a **chalk-level-0 defect** — under `FORCE_COLOR=3`
the library already numbered correctly, because `isPointedLine` could not claim a styled
nested marker line. Claiming on `stripAnsi(line)` makes the decision about the columns a
reader sees, at both settings, which is what a layout decision was always about.

**Fence lines are the deliberate exception, in both directions.** A line that starts inside a
`SENTINEL` pair, or carries one, is content inside a recorded `codeRange`, where every byte —
*including* the accident that a raw-byte claim behaves differently under colour — is class C
and must not move. Those lines keep the raw-byte claim verbatim: a colourless fence line whose
content begins `"    * "` still loses its pad (the library's own dent, shipped in every render
to date), and a coloured one still keeps it. **Reproducing a defect inside a fence is the
contract; fixing it is forbidden.** Neutering this exception — the "obvious" simplification of
claiming every line on stripped bytes — immediately produces **20 class-C violations**.

> **Now governed by D-C's `hl-fence-claim` (lockstep, WP-9 of `plans/mdview-rust-port.md`).** The Rust port keeps the raw-byte claim for fence lines, but its highlighter is syntect rather than highlight.js 10.7.3, so *which* coloured fence lines start with an escape — and therefore keep their pad — differs from the TypeScript renderer's. D-C, ratified with the plan's approval on 2026-10-11, admits exactly that difference: the registry's `hl-fence-claim` entry (`scripts/divergences.ts`, witness `tests/fixtures/divergences/hl-fence-claim.md`) attributes a list-embedded fence line whose pad moved because its leading escape did. Colourless output is unchanged, and the 20-violation measurement above stands as the TypeScript renderer's, as of `TS_BASELINE` (`c097c66`).

Related and settled the same way: `isPointedLine`'s vocabulary stays the two literals `\*` and
`\d+\.` and nothing else, the indent stays an **exact** multiple of four, and no space is
required after the marker. Widening it to the glyph tier's bullets would claim a fence line
whose content begins `- ` and drop the pad from a line inside a `codeRange` — class C again.
The same argument applies one level up to `fixNestedLists`' `POINT_REGEX`.

### `rewrapListBody` — the primary wrap for uncoalesced tight items

**This is not a repair net, and it is not deletable. Both halves were measured in WP-5.** The
plan expected it to become a provable no-op once every seam wrapped at the item's exact
budget, and for the coalesced tight path, the loose `paragraph` path, `heading`, `html` and
tables that is now true. What the plan's model missed is that an **uncoalesced** tight item
was never wrapped by any seam at all: this pass was its **primary and only** wrap. The
deletion was gated falsifiably — replace the pass with identity, require `diffed=0` over the
corpus — and **the gate rejected it**. It cannot move into the `text` seam either, for the
entity-decoding reason stated above.

Its budget argument is **blockquote columns only** (`quoteColumns`, tracked by the
`blockquote` renderer), *not* the prefix stack's non-list total. Since WP-5 the stack also
carries one non-list entry per open **item** — `composeItem`'s exact marker width — and
counting those here would narrow the budget by every ancestor item's marker. That left
`outerColumns()` with no production reader, and WP-6 deleted it.

Two things it must never do, **both invisible to every gate `bun run verify` runs**, and both
of which it did until WP-2f:

**It must never rewrite a line that belongs to a fenced block.** The rendering policy
(`crates/mdview/AGENTS.md`) is unqualified — fenced code is never rewritten, because the corpus's
fences are gate commands
meant to be pasted and a wrapped command is a wrong command. This pass had no sentinel walk
and split fence content mid-command like any other long line, and no gate could see it.
Measured over a 1,000-file corpus sample of fence-carrying files at 80 and 116: **185 of
37,246 fenced source lines did not survive verbatim on the parent commit; 0 do not now**, with
no line newly broken.

- **The sentinel walk here is the stricter of the two *forms* the repo uses, and the
  one-line fence is what decides which form a pass needs.** `substituteBullets` may bail on "this line *started* inside a fence" alone,
  because it only rewrites a *leading* marker and a fence's opening physical line begins with
  the sentinel character itself. This pass rewrites the whole line, and `wrapCode` emits
  `SENTINEL` immediately followed by the block's first content line — so a **one-line** block
  carries all of its content on a line that both opens and closes the pair, where "started
  inside a fence" is false. A line that starts inside a fence **or merely carries a sentinel**
  is returned untouched. Nothing but `wrapCode` emits a sentinel, so the stricter form can only
  ever spare a genuine fence line.
- **An over-budget fence line inside a list item overflows.** That is what fenced code does
  everywhere else here, and it is self-consistent rather than a new exemption: those lines land
  inside a recorded `codeRange` and stay exempt from `--check` and both sweeps. Verified, not
  assumed — `tests/fixtures/fenced-list.md` asserts that *every* over-width line it renders is
  inside a recorded range, at six widths and both tiers. The visible consequence is real:
  `tests/fixtures/nested-list.md` emits an 81-column line at width 80, and the WP-2e assertion
  that no line of it exceeds the width had to start exempting code ranges — **it had been
  passing for the wrong reason**, because the fence was being wrongly re-wrapped.

**It must never break a line so that a continuation starts `*` or `N.`.** The pass chooses
where lines break, so it chooses whether `isPointedLine` claims one of them — and then
numbering renumbers, or `substituteBullets` turns the author's `*` into a bullet glyph.

- **Copying the other seams' guard verbatim makes this pass cause the collision it is meant to
  prevent.** They wrap text starting at column 0, which is *on* the four-column grid, so one
  leading space always takes a marker-shaped line off it. Here the continuation prefix is the
  line's own — `"    1. "` is **7** columns, already off the grid and already safe — and adding
  a space moves it *onto* the grid. Reproduced at width 55 on `fenced-list.md`: with the
  unconditional guard the author's bare `*` was still rewritten, and only because the guard had
  shifted the line from column 7 to 8. **The guard therefore fires only when the composed
  continuation would land on the grid.**
- **`substituteBullets` had to be tightened to the same grid**, or the guard cannot reach it.
  Its regex was a leading `*` at *any* indent, on the reasoning that a `*` at the start of a
  rendered line is always a marker. That reasoning predates this pass, which can put an
  author's bare `*` at the start of a continuation line. Every genuine marker is on the grid
  because the blanket indent only ever adds four columns at a time: measured over a 1,000-file
  sample at five widths, **79,410 substitutions, 0 of them off-grid**. Measured on
  `fenced-list.md` at every width in 40-360, both tiers: the parent commit rewrites the author's
  `*` at widths 54, 55, 100 and 101; this one at none.

The fixture is `tests/fixtures/fenced-list.md` — fences in loose, tight and nested items, a
one-line fence, marker-shaped fence content as decoys, and the bare-`*` continuation. **A green
sweep is not evidence for any of it**; the source-anchored counts above are.

### The retained passes, and why each is retained

WP-5's scope said it would delete four post-hoc correction passes, "one per historical defect".
**Measurement rejected three of the four deletions, and the fourth moved rather than died.**
These read as leftovers unless the file says they were measured, so:

| Pass | Status | The measurement |
|---|---|---|
| `realignNestedContinuations` | **moved** to `src/lists.ts` as `realignEmbeddedContinuations` | Token-type tagging cannot see every embedded list (blockquote children, F10's hybrid join, in-fence dents). It did gain the fix it existed for: decisions on ANSI-stripped bytes, where the old spelling was **inert under colour — 0 lines rewritten against 115,472 colourless** |
| `rewrapListBody` | **retained** | The primary and only wrap for uncoalesced tight items. Identity-substitution gate required `diffed=0`; **the gate rejected the deletion** |
| `coalesceTightItemLines` | **retained**, semantics unchanged | The `text` seam's coalescing half; WP-2b's forbidden case is excluded by condition 3, not by this pass |
| the `MARKER_SHAPED_LINE` guard | **retained** | Two shapes, not one, and it now runs at every budget (see the loose-item section) |
| `substituteBullets` | **retained** — WP-4 expected WP-5 to retire it | Three independent blockers: widening `isPointedLine` moves fence bytes (class C); the bullet a line gets is chosen by its **rendered indent**, which a blockquote shifts after composition returns (`- outer` / `  > - quoted` renders `•` then `‣`, not `•` then `◦`); and `fixNestedLists`' `POINT_REGEX` must find the literal `*` on the hybrid join line, so composition-time glyphs would leave every tight item's nested list glued to its parent's text |
| `rewriteTaskState` + `TASK_STATE_SENTINEL` | **retained** — the plan predicted deletion | See "Two deferred findings that are current, retained behaviour" in `crates/mdview/AGENTS.md` |

**The nested-list geometry measurements in this file are *colourless* measurements** (finding
F1), and that qualification used to be missing throughout. It matters: before WP-5 several
structural passes were provably inert under colour. **After WP-5 the coloured geometry matches
the colourless geometry**, so a claim like "renders `•` then `‣`" now holds at **both** colour
settings. Where a measurement is colourless-only, it says so.

**A note on the detector counts.** WP-5 landed with a non-zero detector delta against the
"non-increasing" gate, by user-approved carve-out, and the classification was established by
reproduction rather than argument: the increases are **colourless-only**, total **+1 to +4 on
12 of 20 axes** against populations of 500–4,300, and trace to **8 distinct (file, detector,
width) situations** — **32 increases against 38 decreases, net −6**. Every increase is a
**pre-existing wrapper artifact relocated by the deliberate budget change**, each confirmed by
rendering the *base* revision at adjacent widths and finding the identical artifact (widths
101–102 for the new `overIndent` line, 101–104 for the new `orphans` fragment). Because an
exact per-item budget moves wrap points, it necessarily moves which width trips a pre-existing
artifact; the detectors are heuristics over rendered text, so in aggregate a relocated artifact
is indistinguishable from a new one. **A future package re-checking this should re-run the
adjacent-width reproduction rather than re-derive it.**

### The typed rendered line — WP-R10 of `plans/rust-port-code-quality-remediation.md`

**Everything above describes the passes as string passes over a joined body, and that is how they were transcribed. Since WP-R10 the Rust pipeline carries a list as `Vec<RenderedLine>` instead**, and every pass reads structure from fields rather than re-walking sentinels and re-matching regexes over the joined text. The behaviour is unchanged — the work package's gate was render-diff `diffed=0` — and the history above stays true of `TS_BASELINE`.

`RenderedLine` (`crates/mdview/src/list_lines.rs`) is `{ fence, indent, marker, body }`:

- `fence` is `Inside` / `Carries` / `Prose` — the sentinel walk's two booleans as one field. "Started inside" is `Inside`; "touches a fence" is anything but `Prose`. The strictness difference recorded in "Why a sentinel walk exists at all" (`crates/mdview/AGENTS.md`) is now the choice between those two predicates, made once per pass.
- `indent` is the **raw** lead up to the first visible non-whitespace character. It is bytes, not a column count, because under colour an SGR sequence can sit between the indent and the `*` (`"    \x1b[0m* inner"`), and the line has to round-trip exactly.
- `marker` is `Bullet` (`*`) or `Ordered("12.")`, set only for a visible marker followed by whitespace whose bytes are contiguous; `body` is everything after it, the gap included.

**One entry, one exit.** Bytes become typed in `lists::compose` — the walk still returns `String` from every visitor (widening that is `docs/adr/0001-editor-path.md`'s successor, out of scope), so a nested list reaches its parent's composition as bytes and is typed there, once, by `RenderedLine::type_line`. They leave in `lists::emit_list`, called once by `ListTextLayout::list_body`; a nested list's emitted bytes go back up the walk and are re-typed by the parent's `compose`.

| Pass | Typed how |
|---|---|
| compose (unordered + ordered, one function) | types each line at entry; the claim decision still asks the *entry bytes* (`claimLine`'s two domains, unchanged); a pad is prepended to `indent`; an ordered item's first line gets `Marker::Ordered` in place of the `* ` |
| `indentLines` | prepends `TAB` to `indent` unless the line is empty or starts with a JS line terminator |
| `fixNestedLists` | the split point is still found by `FIX_NESTED` over the line's visible text — that join is made in bytes by the walk — but the head keeps its fields and only the glued remainder is re-typed, as the nested input it is |
| `realignEmbeddedContinuations` | trims the line's `indent` field; the item stack is still tracked by `track_list_line` over the visible text (the detectors' shared primitive) |
| `section` | appends two blank typed lines |
| `rewrapListBody` | the hanging prefix comes from the fields (indent + marker + one gap character when the indent is literal whitespace; otherwise the indent's literal lead, which is where `LIST_LINE_PREFIX`'s `^\s*` stopped); the head keeps its marker, continuations are marker-less |
| `substituteBullets` | **no longer a pass.** The glyph is chosen at emission (`bullet_glyph`): a `Marker::Bullet` line, not `Inside`, whose visible indent is spaces on the four-column grid, at depth `indent / 4`. `UNORDERED_MARKER_LINE` and the `visibleMap` re-detection are deleted |

**What the retained-passes table's `substituteBullets` row still means.** Its three blockers were about choosing glyphs *at composition*; the typed model does not do that. The marker is set at composition, but the glyph is still chosen at the outermost list's emission from the rendered indent — so the blockquote shift and the hybrid join's literal `*` both still hold, and the grid rule still keeps an off-grid author `*` literal.

**Measured cost.** Production SLOC of `lists.rs` + `list_layout.rs` + `list_lines.rs` rose (the WP-R10 report carries the figures); the spike projected +20 to +50 and the user accepted a net increase for the structural typing.

### A blockquote owes columns exactly like a list, and half the defect was ours

The fourth defect in this family, and the only one whose symptom is *outside* the block it
belongs to: **a list inside a blockquote rendered its markers at column 0**, out of the quote
entirely, while its siblings stayed at column 8.

**A rendered list marker at column 0 is never correct output.** Composition blanket-indents its
whole body before returning it, so the shallowest marker this tool can emit is at column 4, and
one inside a quote at 8. That invariant is the *only* instrument that can grade this case, and
`src/detectors.ts`'s `findColumnZeroMarkers` is it — see the detector section in
`scripts/AGENTS.md` for why the other two are structurally blind to it.

Two independent mechanisms, and **the severe one was this tool's own code**:

- **`wrapOverBudgetLines` preserved no indentation.** It re-wrapped an over-budget line as
  `wrapAnsi(line, targetWidth)`, and `src/wrap.ts` starts every emitted line at a *word* — so
  the line's leading indent was discarded whether or not it even had to be split, and an
  81-column indented line at width 80 came back as one line at column 0. Harmless for
  `paragraph` and `heading`, whose text starts at column 0 anyway; destructive for
  `blockquote`, which hands it an already-indented body.
- **The library's `blockquote` was `section(this.o.blockquote(indentify(this.tab,
  quote.trim())))`** (`index.js:106`; `indentify` at `:505`). The `trim()` stripped the rendered
  body's indent from its **first line only**, so a quoted list's first item sat four columns
  left of its own siblings. Real, but the mild one — visible only at widths where nothing wraps.

**Both are gone by construction now, and that is the shape of the whole WP-3 change.**
`src/blocks.ts`'s `renderBlockquote` simply does not trim the first line's indent away
(`trimKeepingFirstIndent`), so there is nothing to measure and paste back:
`firstLineIndentTrimmedAway` and `restoreFirstLineIndent` are deleted. And an owned
`paragraph`/`heading` takes its budget as a parameter, so `wrapOverBudgetLines` — the safety
net for a reflow that measured `.length` — is deleted with the two budget caches. **Five
mechanisms for one problem that no longer exists.**

What the pre-WP-3 arrangement measured, kept because it is the evidence that the seam is where
the fix belongs:

- The indent-preserving re-wrap belonged in the shared helper, not on the `blockquote` path:
  dropping a line's own indent is never right, so the caller is not what makes it wrong.
  `paragraph`/`heading` stayed byte-identical **by construction** — the preserving path was
  entered only for a line that *has* leading whitespace, and both callers hand the helper text
  starting at column 0. Verified anyway over **1,181 corpus files at four widths: every
  differing render is a blockquote-carrying file, 0 otherwise.**
- **`currentListBudget` had to learn that a list is not the only thing that still owes an
  indent.** A blockquote applies its indent for the same reason and at the same moment, so the
  post-compose wrap was re-splitting quoted list lines against a budget four columns too
  generous while the prose seams were already subtracting the quote in full — the two
  disagreeing about the same item.
- **The `paragraph` gate moving from "are we in a list" to "does anything still owe columns"
  was forced, not chosen.** A blockquote reflows its children at the full target width and then
  indents the result, so every wrapped line of quoted prose was four columns over budget — which
  only ever looked fine because the safety net was *deleting* the indent instead of honouring
  it. The moment it stopped, the net started shearing a word off each of those lines.
  **`heading` needed the same treatment for the same reason.** Measured over **599
  blockquote-free corpus files at four widths, byte-identical**: nothing outside a quote in that
  sample has a heading that wraps.

The fixture is `tests/fixtures/blockquote-list.md` — unordered, ordered and nested lists inside
quotes, a quote inside a quote, fences (including the one-line shape) inside a quote, plain
quoted prose as the control, and **a blockquote inside a list item**, which is *legitimately*
indented past its item's text column and which nothing here may flatten back. Measured over the
95 corpus files that put a list inside a blockquote, at widths 40/80/116/346: **column-0 markers
471 → 4** — the residual four are one authored numbered paragraph in one file, present
identically on the parent — and on the tier-pure sub-count of substituted bullet glyphs, **406 →
0**. Fenced source lines surviving verbatim over the same sample: **7,974 → 7,996 of 8,020, 0
newly broken.**

### Ordered numbering, and two deliberate non-changes

`composeOrdered` numbers each level from its own `token.items` and never looks at a line a
nested level produced. What it replaced — a single counter walked over the *whole composed
body*, asking `isPointedLine` per line — let a nested list's markers **consume the parent's
counter** and be rewritten into the parent's sequence by a plain string replace that finds the
first `"* "` anywhere in the line. Measured on the validation corpus: **486 of 4,779 files
(10.2%), 900 of 6,343 ordered lists (14.2%)** contain an ordered list with a nested list, and
every one of them rendered wrong. This is family **B1**, and it is a **colourless** defect:
under colour the styled marker lines were never claimed, so the library already numbered
correctly there.

Unordered parents were unaffected — padding never renumbers — which is why the parity stages
split by **list kind** rather than by width or tier.

- **`token.start` stays ignored.** The library read it and never used it, so a list authored
  `5.` renders `1.`. Honouring it is a diff family nobody has granted; deliberate deferral, not
  oversight.
- **The `line.replace("* ", marker)` on an item's first line is kept in the library's own
  spelling**, because composition put `"* "` at the head of that line one function earlier, so
  the first occurrence *is* the head. The landmine that spelling carries — rewriting a `"* "`
  inside an author's `**bold**` on a *continuation* line — is gone with the counter walk,
  because continuation lines no longer reach that branch.
