# mdview — `src/`

Renderer internals for the `mdview` command: **what the owned renderer must do and the
measured defect that established each requirement**, the sentinels, the glyph tier, the
command-line surface, ambiguous-width resolution and the probe, the rendering policy, the
parity classes, and the `emoji` re-decision. **The root `AGENTS.md` is the parent document
— read it first**; identity, the two-names decision, the Stack, the Layout tree, the
Run/verify contract, Conventions and the dependency record live there.

| Section | What it settles |
|---|---|
| How to read this file | the two conventions, including what a `index.js:NNN` citation means |
| Why the renderer is owned at all | the three structural facts and what the removal measured |
| What each renderer method must do | the requirement table, and the four unassigned methods |
| Parity: four classes | A/B/C/D, and why class C is a content hash rather than a gate |
| The list pipeline | composition, the two wrap paths, the de-drift, the claim domains, the retained passes |
| The sentinels | four control characters, one literal, the wiki-link carriers, and why the walks differ |
| The task-state pre-pass | the 84 lines it still corrupts, why the "indented code" follow-up is retired, and the re-tokenisation that blocks its removal |
| Colourless gates cannot see colour-only defects | three measurements, one mechanism, the rule it earns, and the WP-3 closure (`charDiff` 31 → 0) |
| Glyph tier · Ambiguous width | the tier, the probe, and why `wide` forces ASCII |
| Command-line surface · Colour | the CLI shape, config asymmetry, and the one owned colour/hyperlink policy |
| Rendering policy · The `emoji` re-decision | the unqualified rules, and the tier-follows decision |

### How to read this file

Two conventions run through it, and both are load-bearing.

**Every requirement is stated with the measurement that established it.** This file is not
a description of what the code happens to do — the code says that, at length, in its own
doc comments. It is the record of *why each behaviour is required*, because almost every
one of them was derived by rendering a corpus and counting, and because at least four of
them have been "simplified away" once already by someone who could see the mechanism and
not the reason. A number in this file is a claim someone can re-run. Do not delete one
because its subject changed; re-frame it.

**A citation like `index.js:539-578` is historical evidence, not a live dependency.** It
names `marked-terminal@7.3.0`, the terminal renderer this repo used until WP-2 through
WP-6 of `plans/marked-terminal-replacement.md` replaced it method by method and then
removed it. That package is **not installed** — the current renderer is entirely this
repo's, spread over `src/render.ts`, `src/inline.ts`, `src/blocks.ts`, `src/lists.ts` and
`src/table.ts`. The citations stay because the requirements below were derived *from that
source*, transcribed line by line under a byte-identical parity gate, and a future reader
who wants to check a transcription needs the line numbers. `tests/helpers/containment.ts`'s
`DOCUMENTED_FORMER_PACKAGES` exists so those citations do not read as findings to the
publication guard — see `tests/AGENTS.md` for the narrow rule it follows.

`marked` itself — the **lexer** — is still a dependency and is cited the same way
(`marked/lib/marked.cjs:557-561`); it is present, pinned at `14.1.4`, and not going
anywhere.

### Why the renderer is owned at all

The tool has one defining invariant: **display-width-correct layout**. The library it was
built on conflicted with that invariant in three structural ways, each measured during
planning and each of which moved work from "must build" to "can delete":

1. **Width was taken only at construction.** `this.o` is an `Object.assign` snapshot
   (`index.js:58`) and `width` is read at `:128`, `:136` and `:208` and written nowhere.
   Rendering a loose list item's paragraph four columns narrower therefore meant
   constructing an **entire second renderer instance** and caching it by budget —
   `budgetedParagraphs` and `budgetedHeadings`, **three library instances per render**.
   An owned renderer takes the budget as a *parameter*, so both caches disappear, and — the
   part that matters more — a budget can be **per item** rather than per instance.
2. **`listitem` and `checkbox` were dead seams.** `markedTerminal()`'s `funcs.reduce`
   (`index.js:390-400`) makes each `extension.renderer[fn]` call `r[fn](...)` on one shared
   *internal* `Renderer` instance, so `list()`'s own `this.listitem(...)` call and
   `listitem()`'s own `this.checkbox(...)` call always reached the un-overridden prototype
   methods, whatever was assigned. Confirmed by instrumenting both hooks against a
   two-level nested list: `list` fired twice, `listitem` **zero times**. Two live defects
   were therefore unfixable from outside, and three separate repair passes grew up around
   the seam instead.
3. **Reflow measured `.length`, not display width.** `reflowText`
   (`index.js:405-499`, exactly 95 lines) counts UTF-16 code units. Every
   `wrapOverBudgetLines` call in `src/render.ts` existed as a safety net for that
   undercount, while `src/wrap.ts`'s `wrapAnsi` — ANSI-safe, already used in three places
   — was already this repo's own reflow engine. Ownership changed its role from safety net
   to primary engine.

The growth signature is the fourth reason and the one that made the case: across **21
commits touching `src/render.ts`, +1,918/−256 lines, the file never once shrank**, and the
steepest stretch added **+1,016 lines in eight commits**, every one of them a wrapper
correcting the same library's list and prose reflow. That is what a wrapper architecture
looks like when the layer underneath cannot be edited.

**What the removal actually measured.** WP-6 landed **parity class A — byte-identical**,
not the class B it had been granted: **96,900 combos per run** across all 20 corpora at
every default axis, colourless and under `FORCE_COLOR=3`, `diffed=0 classC=0 disallowed=0
errors=0`, with the coloured run proved non-vacuous (**21 SGR sequences per probe**,
identical on both revisions) and independently re-verified by the orchestrator at width 92
against a pre-removal checkout. `cli-table3` and a nested `chalk@5.6.2` left with the
library; `THIRD-PARTY-LICENSES.txt` went **1,059 → 990 lines, 49 → 46 packages**.

**And it did not shrink the code — say so plainly.** `src/render.ts` went **1,227 → 1,298
(+71: −4 code, +75 comment)**; all of `src/` **−28 code, +85 total**; the whole repo
**+433, of which +400 is `tests/`**. The plan predicted `src/render.ts` would fall below
1,000 lines; it **missed by 298**. Owning the renderer converted uncommented wrapper code
into commented owned code plus tests, and the tests are where the growth went. The premise
the plan opened with — unexplained growth against a library that could not express the
tool's invariant — is untouched by that number. *Net-negative was a prediction, it was
measured, and it was wrong.* Do not treat it as unmet scope.

### What each renderer method must do, and the defect behind it

`src/render.ts` builds one extension object and assigns sixteen methods onto it. Every one
is this repo's. Each exists for a measured reason — **do not remove or "simplify" one
without re-running the corpus sweep and the parity harness**.

| Method | Lives in | The requirement, and the defect that established it |
|---|---|---|
| `table` | `src/table.ts` | Allocate to the **budget**, not the target width, and honour `token.align`. The library's table renderer never received the terminal width at all and dropped `token.align` entirely. Since WP-3 the allocator is handed `targetWidth - prefix.width()`, because a table inside a blockquote used to be allocated the full width, indented four columns, and then split down the middle of its border rows by a repair pass — output that satisfied the width gate by being wrong |
| `list` | `src/lists.ts`, wrapped in `src/render.ts` | Own composition outright: markers, the blanket indent, the **per-item** budget, ordered numbering, task states, and the per-level de-drift. `listitem` and `checkbox` are reachable only from here (fact 2 above). The wrapper in `src/render.ts` adds exactly three things: depth tracking, the post-compose wrap for uncoalesced tight items, and bullet-glyph substitution at the outermost level |
| `hr` | `src/blocks.ts` | Emit the tier's rule character at the tier's width, and match the frontmatter divider exactly — one implementation (`renderRule`), two call sites. The library hardcoded its rule character |
| `code` | `src/blocks.ts`, bracketed in `src/render.ts` | Never reflow; normalise `token.lang` through `src/lang.ts` before highlighting; bracket the rendered block in `SENTINEL` so `--check` and both sweeps can exempt it |
| `html` | `src/blocks.ts` | Reflow at the real budget. A block-level tag (a line starting `<script>`) swallows a paragraph and the library returned it unreflowed |
| `paragraph` | `src/blocks.ts` | **Wrap at the width the text will actually occupy** — target width minus everything still owed by enclosing blocks — measuring through `Measure`, not `.length`. This is where a *loose* list item's text is wrapped, and where quoted prose is |
| `heading` | `src/blocks.ts` | The same, for the same reason: a heading is reachable inside both a list item and a blockquote, and had no budgeted path at all before WP-2g |
| `blockquote` | `src/blocks.ts` | Push four columns for the duration of its children's render, and do not trim the first line's own indent away |
| `text` | `src/inline.ts`, wrapped in `src/render.ts` | Parse a **tight** list item's inline markup — the one container in the whole renderer that reached the terminal as raw markdown — then coalesce and re-wrap what it coalesced |
| `strong` `em` `del` `codespan` `link` `image` `br` | `src/inline.ts` | Reproduce the library's inline bytes exactly (parity class A), including two upstream defects kept deliberately: `fixHardReturn` and the substitution pass's stray trailing space. See `src/inline.ts` for each |

**Four methods are deliberately unassigned: `listitem`, `checkbox`, `tablerow`,
`tablecell`.** They are **unreachable, not missing** — `list` is `src/lists.ts`'s and
composes its items itself; `table` is `src/table.ts`'s and never dispatches a cell token.
A mutation probe that makes all four throw renders the whole validation corpus at every
default axis without firing. Do not "complete the set" by assigning them. Until WP-2 of
`plans/own-the-token-walk.md` the accurate phrasing was that they "fall through to
`marked`'s own defaults"; there is nothing left to fall through *to*. `src/walk.ts`
dispatches exactly the eighteen token types `Parser` dispatched, and none of the four is
one of them — `list_item` is consumed inside `list` and a cell token is never dispatched at
all.

### The walk is this repo's, and the renderer object is no longer an extension

**`src/walk.ts` replaced `marked`'s `Parser` as the tree walker** (WP-2 of
`plans/own-the-token-walk.md`), byte-identically. Its own header carries the contract table
— every `marked.cjs` site, every behaviour, and the two behaviours it deliberately does not
carry over — and `tests/walk.test.ts` tests each row directly *and* differentially against
`Parser` itself on 32 sources. What follows is the part that belongs beside the renderer
methods rather than beside the walk.

**The renderer object is a plain object literal, and by the end that was the whole of what
the library ever supplied.** `markedTerminal()` (`index.js:364-401`) assigned twenty thin
wrappers onto `{ renderer: {}, useNewRenderer: true }`; sixteen were overwritten here, and
WP-4 measured **zero calls to any library renderer method across 95,720 combos**. What the
construction actually provided was the *shape* `marked.use()` expects — an object with a
`renderer` field. (`useNewRenderer` is not read anywhere in `marked@14.1.4`; it is a v15
migration flag.) That shape is gone too: the object is handed to `new TokenWalker(...)`, not
to `use()`.

**Two things `marked.use()` was doing for this renderer, and where each went.** It required
every key to exist on marked's own `Renderer` (`marked.cjs:2251`, which throws otherwise),
and it called each method with `this` bound to that `Renderer` — **which is where the
`this.parser` the visitors close over came from**. Both are now `src/walk.ts`'s: it checks
that every dispatched method is *supplied* (a stronger and more useful check than that its
name exists upstream — a key that was merely absent used to leave marked's HTML-emitting
default in place), and it dispatches against an object carrying `parser`, so `this.parser`
is the walker. `use()`'s third behaviour, falling back to the previous renderer on a `false`
return, is deliberately **not** reproduced: its target was marked's HTML defaults, every
method here is typed `=> string`, and its companion falsy-to-`''` coercion is the identity
on every string. **Nothing about a visitor's body or its `this` changed.**

### Parity: four classes, and why class C is a content hash

Every package of the renderer replacement declared which class of difference it was allowed
to produce, and `scripts/render-diff.ts` classifies each `(file × width × tier ×
ambiguous-mode)` combo on four independent channels: `textSha`, `codeContentSha`,
`codeRanges` and `detectors`.

- **Class A — byte-identical, required.** Deterministic string operations: the inline
  methods, unordered marker composition, the block leaves that never reflowed. If output
  moves, something is wrong.
- **Class B — deliberate improvement, enumerated and reviewed.** Content the library
  measured with `.length` and the owned renderer measures with `Measure` *will* render
  differently, and that is the fix. Each diff must be listed, attributed to a measurement
  change, and the overflow count must be **non-increasing** at every width and tier. A
  class-B diff on pure-ASCII content is not class B; it is a regression.
- **Class C — forbidden, always.** Any change to the content **inside** a `codeRange`, at
  any package, on any corpus.
- **Class D — enumerated defect repair.** Output may change **only** on inputs that
  reproduce a written, **committed** defect witness. Every diff is enumerated and attributed
  to that witness; `overflow` counts and the three detector counts are **non-increasing** at
  every axis; and `codeContentSha` is **unchanged** — class D never authorizes class C, which
  needs its own separately granted exception. Granted at approval of
  `plans/renderer-deferred-work.md` (2026-08-15), for that plan's defect repairs.

**Class B could not absorb class D, and merging them later would break both.** Class B is
about *measurement*: the library counted columns with `.length` and the owned renderer counts
them with `Measure`, so a diff is class B exactly when the two disagree — which is why "a
class-B diff on pure-ASCII content is not class B; it is a regression" is correct and stays
correct. ASCII has no width discrepancy, so an ASCII diff can never be attributed to a
measurement change, and that rule is the only thing that stops class B from becoming "any
diff I can argue for". A defect repair changes ASCII output *by construction* — the bug and
the fix are both pure ASCII — so under class B every repair in this plan reads as a
regression. The two classes are also policed differently: class B is bounded by *attribution
to a mechanism* (measurement), class D by *attribution to an artifact* (a committed witness
file that reproduces the defect and a test that names the widths). **Do not widen class B to
cover repairs, and do not let class D absorb measurement diffs** — a class with no
falsifiable admission test is not a parity class.

**Class C is checked by content hash and never by a gate's exit code, and that sentence is
the most important one in this file: fenced ranges are exempt from every width gate, and
fence corruption has shipped fully green three times.** `--check`, both sweeps and every
test skip lines inside a recorded `codeRange` — which is exactly what makes fences safe
from wrapping and exactly what makes corrupting one invisible. `codeContentSha` is the
sha256 of only the text those ranges cover, compared unconditionally, because it is the one
question no green gate answers.

**`codeRanges` is a separate channel from `codeContentSha`, and conflating them is a
mistake with consequences.** The ranges are *line offsets*: they shift benignly whenever
prose above a fence re-wraps, and a shifted range is not class C. What class C means is
that the **bytes inside** the ranges changed. A change that moves ranges without moving
bytes is still a real signal — it silently changes what `--check` exempts — which is why it
has its own channel.

Two operational notes that cost a package each to learn: the class-C channel
**over-reports**, because `extractCodeRanges` converts a character-granular sentinel pair
into whole 1-based *line* numbers, so a fence sharing its opening physical line with a list
item's own text drags that text into the range; and the harness's `--baseline`/`--against`
mode is **unsound against a live working tree** (it compares two reads up to half an hour
apart). Use `--rev-a`/`--rev-b` for any binding gate.

At every package, additionally: the three detector counts (`findListOrphans`,
`findContinuationOverIndent`, `findColumnZeroMarkers`) must be non-increasing, and the five
named regression fixtures — `loose-list.md`, `nested-list.md`, `fenced-list.md`,
`blockquote-list.md`, `wide-table.md` — must hold.

### The list pipeline

Four defects live in this family, all of them variations on one theme — *a line has to be
laid out at the width it will actually occupy, and only composition knows that width* —
and the passes below are what closed them. Since WP-5, **composition owns the marker, the
indent, the per-item budget and the de-drift**; `src/render.ts` owns the seams that wrap
prose and the two post-compose passes that cannot move.

#### Composition pushes the item's **exact** marker width, per item

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

#### Loose items are wrapped by `paragraph`, at the item's own budget

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
width. It is covered by the orphan metric in `tests/render.test.ts` against
`tests/fixtures/loose-list.md`, by the detector ratchet in the parity harness, and by
nothing else.

#### Tight items are parsed by `text` — and wrapped on **two different paths**

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
`tests/fixtures/coalesced-colon-guard-continuation.md` (`tests/render-lists.test.ts`,
"the coalesced colon-guard continuation drift"), reproducing at widths 50, 60, 90 and
101 in both glyph tiers, from repo-local content — no private corpus needed, unlike the
evidence the older plan pointed a future package at and that turned out to live in an
archive no session can open. **Not fixed here either**: the guard is correct for the
reason it exists, decoding earlier would reopen the emoji-substitution-inside-verbatim-
content hazard `COLON_REPLACER` exists to prevent (see "The sentinels" section below,
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

#### A nested item's continuations are pulled back to their own item, per level

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

#### The claim decision: ANSI-stripped for prose, **raw bytes for fence lines**

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

Related and settled the same way: `isPointedLine`'s vocabulary stays the two literals `\*` and
`\d+\.` and nothing else, the indent stays an **exact** multiple of four, and no space is
required after the marker. Widening it to the glyph tier's bullets would claim a fence line
whose content begins `- ` and drop the pad from a line inside a `codeRange` — class C again.
The same argument applies one level up to `fixNestedLists`' `POINT_REGEX`.

#### `rewrapListBody` — the primary wrap for uncoalesced tight items

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

**It must never rewrite a line that belongs to a fenced block.** The rendering policy below is
unqualified — fenced code is never rewritten, because the corpus's fences are gate commands
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

#### The retained passes, and why each is retained

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
| `rewriteTaskState` + `TASK_STATE_SENTINEL` | **retained** — the plan predicted deletion | See "Two deferred findings" below |

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

#### A blockquote owes columns exactly like a list, and half the defect was ours

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

#### Ordered numbering, and two deliberate non-changes

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

### The sentinels — four control characters, and one literal that is not a defect

**Five carriers, not three** (this section said "three carriers, not two" until WP-4 of
`plans/colour-policy.md` added the wiki-link pair — **recount when you add one**). Four are
control characters stripped from the final output; the fifth is a literal string that
round-trips within a render. All of them exist because something downstream would otherwise
misread the text.

| Carrier | Code point / spelling | Purpose |
|---|---|---|
| `SENTINEL` | 0 | Brackets fenced-code output so `--check` and the sweeps can record `codeRanges` and exempt them |
| `TASK_STATE_SENTINEL` | 1 | Sits between `[` and the state char so `marked`'s GFM tasklist regex (`/^\[[ xX]\] /`) does not reclaim the item and rebuild it |
| `WIKI_LINK_OPEN` / `WIKI_LINK_CLOSE` | 2 and 3 | Mark where a wiki-link's label starts and ends, so the label survives the lexer and the walk **unstyled** and a post-walk pass can style it under the resolved policy (`src/wikilink.ts`, WP-4 of `plans/colour-policy.md`) |
| `COLON_REPLACER` | the literal `*#COLON\|*` | `codespan` replaces every `:` in a code span with it; `undoColon` restores them after emoji substitution has run |

The four control characters are control characters, not zero-width Unicode, **deliberately**:
the ASCII tier exists for terminals that cannot render UTF-8, so an "invisible" U+200B in that
path would be three bytes of exactly the thing the tier avoids — and every gate here measures
display *width*, not code points, so nothing would have caught it. All are stripped from the
source before lexing (so a hostile or odd document cannot forge a range, a defeated regex or
a styled span) and from the rendered output before it reaches the terminal.

**The wiki-link pair is the one that replaced an escape rather than defeating a regex, and
that is why it exists at all.** `styleWikiLink` (`src/render.ts`, deleted) put a hardcoded
`\x1b[36m\x1b[4m…\x1b[24m\x1b[39m` into the *markdown source*, before the lexer, at every
colour level including colourless — so a plain `mdview note.md | cat` emitted colour nobody
asked for (Decision 1), the bytes bypassed the committed style table entirely, and the one
input every claim about the lexer is made against contained tool-generated escapes. Carriers
carry the same information — *this run is a wiki-link label* — with no styling decision baked
in, so the decision can be made once, at the end, by the same authority that makes every
other one. Two properties make the substitution byte-safe and both are asserted in
`tests/wikilink.test.ts`: the carriers measure **zero columns** (as the escapes they
replaced did, `string-width` having stripped those), so no wrap point moves; and
`src/ansi.ts`'s scanner classifies them as ordinary **text**, which is correct — a carrier is
not a terminal sequence, and it is gone before output either way.

**Two consequences worth knowing before you move the pass.** `stripAnsi` removes SGR, OSC-8
and DCS — **not** carriers, deliberately — so every layout decision taken between the walk
and the carrier pass (`substituteBullets`, the marker-shape guards, the detectors) sees
carrier bytes inside what it treats as visible text. That is why the pass's position is
specified rather than incidental: after `extractCodeRanges` (carriers are not newlines, so
they cannot shift a range's line numbers, and this pass adds none) and **before**
`stripEmojiTrailingSpace`, whose regex tolerates trailing SGR but knows nothing about
carriers — a carrier surviving into it would suppress the strip with colour off and not with
colour on, splitting the two modes apart on a line nothing is allowed to move. And
unbalanced carriers **degrade to stripping, never to leaked bytes**: an orphaned opener, an
orphaned closer and a second opener inside an open span are all simply removed, because the
one failure a carrier scheme must not have is a half-open style pair reaching a terminal.

**`COLON_REPLACER` is a first-class owned mechanism with a measured reason to exist, and WP-6
expected to delete it.** The reasoning that predicted its death was that it existed "only to
survive the library's emoji pass". It does not: **the emoji pass is this repo's own**
(`emojify`, `src/inline.ts`, composed into `transform` in `src/blocks.ts`) and it still runs
over composed block text, *after* inline rendering — so a code span's colons are still exposed
to it unless something hides them. Substituting the round-trip with identity on both sides and
measuring the consequence: `` `:rocket:` `` renders 🚀, `` `:smile:` `` in a list item renders
😄, `` `:tada:` `` in a blockquote renders 🎉 — **19,319 changed combos across 1,101 files and
76 class-C violations**. That is emoji substitution *inside verbatim content*, which is the one
thing a code span exists to prevent. Both halves are load-bearing: if `codespan` stopped
emitting it, shortcodes inside backticks would be substituted; if `heading`/`paragraph`/`listitem`
stopped undoing it, every code span containing a colon would render the sentinel literally.

Its literal spelling is kept rather than swapped for a third control character. It is
unobservable either way — every renderer that can receive a code span runs `undoColon` — and an
authored copy of the literal cannot reach it, because `marked` tokenizes the surrounding
asterisks as emphasis long before the pass. Changing it would be churn against a measured
no-op.

**A live, unrepaired defect: the wrap can split `COLON_REPLACER` itself, and `undoColon`'s
match then fails.** Recorded, not fixed — WP-5 of `plans/renderer-deferred-work.md`, from an
audit of what earlier packages in that plan had captured. `undoColon` is a `split`/`join` on
the literal 9-character token `*#COLON|*`; that match needs the whole token intact on one
line. The **coalesced** tight-item wrap (`src/render.ts`'s `text` override) measures and
wraps `segments` that still carry the sentinel — `transform`/`undoColon` does not run until
`composeItem` (`src/lists.ts`), *after* this wrap — so when a code span's colon sits inside an
otherwise-unbroken run of non-whitespace characters (a `key:value`-shaped token with nothing
either side for the wrap to break on instead), the sentinel is just more of that one
over-budget "word" to `wrapAnsi`'s hard-split, which is grapheme-safe but has no notion that
these particular 9 bytes must stay contiguous. Split it, and `undoColon`'s match finds neither
half: the raw escape ships to the user's terminal instead of `:`.

Independently reproduced repo-locally (no private corpus needed) — a tight item reading
"but omitting" a code span spelled `pricing.input_cache_read:3.5` (colon inside, nothing
either side of it to break on) renders, at width 38:

```text
"      pricing.input_cache_read*#COLON"
"      |*3.5 but omitting that one"
```

matching the shape found in real corpus data during WP-1 of the same plan (`"…*#COLON|"` /
`"|* 3.5…"`), present identically at both ends of that package — caused and fixed by nothing
in it. **No width gate can see this**: every affected line is *under* budget (that is what
let the wrap choose that break point at all), so `--check` and both sweeps are blind to it,
the same class of artifact as the coalesced-guard collision WP-1 did repair. Its population is
unmeasured — the question is how often a code span's colon sits inside a run with no
whitespace on either side, and answering it needs a corpus pass this package is not
authorized to run.

#### Why a sentinel *walk* exists at all, and why there are several

`--check` needs to know which rendered lines came out of a fence, and the only place that is
known is inside the `code` renderer — three or four passes before the line numbers exist. So
`wrapCode` brackets the rendered block, `extractCodeRanges` walks the fully rendered document
once, records the 1-based line range between each pair, and strips the markers back out. (The
trailing blank-line padding is deliberately left *outside* the pair, so a range covers exactly
the block's own content lines.)

Every pass that rewrites already-rendered output therefore needs its own walk before it touches
a line. **There are five of them today** — `rewrapListBody` (`src/render.ts`), and
`composeUnordered`, `composeOrdered`, `realignEmbeddedContinuations` and `substituteBullets`
(`src/lists.ts`) — plus `extractCodeRanges`, which consumes the markers rather than avoiding
them. (This file said "four" until WP-7: that count predates WP-5, which deleted
`wrapOverBudgetLines` and moved the composers in. **Recount when you add a pass.**) And **the
strictness each one needs is not the same**:
"started inside a fence" is enough for a pass that only rewrites a leading marker, and is
*wrong* for a pass that rewrites whole lines, because a one-line fenced block carries all its
content on a line that both opens and closes the pair. That recurring trap is the stated payoff
WP-6 hoped to remove by carrying code/prose metadata on rendered lines instead; it did not, and
the reason is recorded on `extractCodeRanges` and in the deferred findings below.

#### Two deferred findings that are current, retained behaviour

Both were measured, both are **user-approved deferrals recorded in
`plans/marked-terminal-replacement.md`'s WP-6 amendment, and neither is a defect or unmet
scope.** A future package that wants either must start from these numbers and bring its own
granted parity class.

- **The `extractCodeRanges` narrowing (field note F6 of
  `runs/dispatch/mt-wp-5-list-item-layout-brief.md:164` — dispatch-brief numbering, **not** the
  F6 of `reviews/2026-07-30-tn-code-review.md`, which is the unrelated, still-Open file-size
  finding) is implemented, measured, and deliberately not applied.** The narrowing — start on
  the next line when the opening marker
  has non-whitespace before it, end on the previous one when the closing marker has
  non-whitespace after it, drop a range that collapses — moves **not one rendered byte**. What
  it moves is *coverage*. The figures recorded here through WP-7 were **ranges change on 88 of
  4,837 files, coverage changes on 110 files, un-exempting 4,980 lines of which 2,422 are over
  budget — 97 files would newly fail `--check`**; they are retained because a number here is a
  claim someone can re-run, and **WP-2 of `plans/renderer-deferred-work.md` re-ran them.** They
  do not survive, and the correction is dimensional rather than arithmetic:

  - **"Ranges changed" and "coverage changed" are the same set**, so 88 and 110 cannot both
    describe one run. The narrowing only shrinks a boundary or drops a range, and each changes
    coverage; measured over 178,280 combos, **not one file** changed ranges without changing
    coverage. The two figures came from two different runs, patches or corpus snapshots, and no
    axis set or aggregation rule reconciles them.
  - **Re-measured at `c27766e`, 4,457 corpus files, 20 default axes, per-file union:** ranges and
    coverage both change on **97 files colourless** and **282 under `FORCE_COLOR=3`**;
    **235 lines are un-exempted per axis** (195 over budget at width 80), and **85 files newly
    fail `--check`** colourless / 164 forced. The old "4,980 lines / 2,422 over budget" were
    **20-axis sums**, counting each physical line once per axis — the per-axis figure is ~235.
  - **The corpus is not that corpus.** It enumerates 4,457 files today, not 4,837: it is live
    user data. A denominator here is a snapshot, never a constant.
  - **The narrowing as specified is ANSI-blind**, which is why colour triples the population: a
    rendered code block inside a list item is bracketed by SGR sequences, and the predicate
    counts those as the "non-whitespace" that triggers narrowing. Under colour it drops all five
    of `tests/fixtures/fenced-list.md`'s ranges at every tested width and both tiers. **Every
    gate in `verify` runs colourless and none of them can see this.**
  - **It raises two counts the parity contract requires to be non-increasing** — `overIndent`
    and `orphans` — by 24 combos colourless and 4,700 forced, because `src/detectors.ts` takes
    `codeRanges` as its exemption input. **No parity class, including class D, covers that.**
  - **The un-exempted lines are not all "prose that was never code."** On the coalesced
    tight-item seam a fence's content is composed onto the item's own physical line, so the
    narrowing drops a line that contains verbatim code this tool refuses to rewrap at any width.

  Fenced ranges are exempt from every width gate, so narrowing the exemption converts
  silent-but-correct output into a red gate on real content. A deliberate change to gate coverage
  is not something a dependency removal gets to make on its own authority. The patch and the
  original numbers live in `extractCodeRanges`' doc comment; WP-2's report holds the re-measured
  ones and recommends **not** landing the narrowing as specified.
- **`rewriteTaskState` and its sentinel are retained**, and the population is **84 lines across
  2 files**, not the 211-in-11 an earlier brief asserted. The pre-pass rewrites **5,619
  task-shaped source lines in 297 of 4,837 files**, but removing it changes the rendered output
  of only **5** files — `src/lists.ts`'s owned `checkbox`/`renderTaskState` now produce
  byte-identical output for every task item `marked` actually tokenizes as one. Of those 5,
  **2 change bytes inside a recorded `codeRange`** (the 84 lines, in *indented* code blocks,
  which `preprocessBody`'s fence toggle cannot see because it only counts ` ``` ` lines) —
  class C — and **the other 3 change prose**, all tracing to a single authored `[/]`. GFM's
  tasklist regex only ever matches ` `, `x` and `X`, so **every other Obsidian custom state is
  invisible to the lexer and this pass is the only thing rendering one as a glyph.** Deleting it
  would remove a feature, not dead weight.

  > **Two of the three claims in that bullet are wrong, and WP-4 of
  > `plans/renderer-deferred-work.md` measured them wrong before writing any code.** The bullet
  > is retained unedited, as the `extractCodeRanges` bullet above it is, so the error stays
  > legible. The corrections are the next section, "The task-state pre-pass".

`renderTaskState` (`src/lists.ts`) covers the two positions the pre-pass's line-anchored regex
cannot reach — a task item inside a **blockquote** (`>` is not in `[-*+]`) and one in an
**ordered** list — which are exactly the items the library rendered as `[X]  `, uppercase and
double-spaced, in *both* glyph tiers. That is family **B2**. It mutates the item's first inline
text token rather than prefixing the composed string, because the composed-string form (the
library's) left those items wrapped against a budget two columns too generous — a difference in
kind from how every other task item in the document is laid out.

#### The task-state pre-pass: what it corrupts, what it protects, and why the repair was declined

**WP-4 of `plans/renderer-deferred-work.md` asked for a class-C exception to delete the pre-pass
and render non-GFM task states at composition instead. It measured three populations first, and
the user withheld the exception on the measurement.** No behaviour changed; this is the record of
why, and it is the starting point for any future attempt.

Method: `2e90d71`, `--widths 100 --tiers unicode,ascii --ambiguous narrow` (8,930 combos), both
colour modes, plus full-lex source scans. **The corpus resolves 35,614 files; the differ's own
selection is 4,465.** Every "of 4,837 files" figure in this file is a *selection* count from an
earlier date — a denominator here is a snapshot, never a constant.

**P1 — the pre-pass corrupts 84 lines of verbatim code, and still does today.**
84 lines across 2 files, `classC=2` colourless. The **same 84 lines in the same 2 files over
4,465 files and over 35,614**, so the enumeration is complete rather than sampled. Their
state-char histogram is `{" ": 84}` — every one a GFM `[ ]` rewritten to `○` inside a code block:

```text
base:  "    - ○ Final commit pushed"
clean: "    - [ ] Final commit pushed"
```

Two consequences the earlier record got backwards:

- **They are *fenced*, not indented.** `codeBlockStyle` is `undefined` on all 84 and the source
  lines sit at **column 0**. The cause is the fence-*phase* disagreement alone: an unbalanced
  ` ``` ` makes `marked` swallow a long region as one code block (lines 939–1168 in one file,
  2527–2546 in the other) while `preprocessBody`'s toggle flips on **every** fence-shaped line,
  including ones `marked` treats as that block's *content*. **So the follow-up this file and
  `src/lists.ts` both proposed — "teach the pre-pass about indented code blocks" — would repair
  none of the 84 lines. That follow-up is retired, not deferred.**
- **The damage comes entirely from the branch composition already duplicates.** All 84 are GFM
  `[ ]`; `renderTaskState` reproduces that branch byte-for-byte. The non-GFM branch, the
  pre-pass's only irreplaceable function, causes **zero** class-C lines.

Because fenced ranges are exempt from every width gate, **no gate in `verify` can see this**. It
is a live, known, deliberately unrepaired defect.

**P2 — the position the pre-pass cannot reach is empty in the corpus.**
Across **35,614 files** there is **no blockquoted task item of any kind**, GFM or Obsidian
custom, and **no non-GFM state in an ordered list**: **0 hits in 0 files**, by three independent
measurements — a token walk over every list item at every nesting depth, a fence-gated source
scan, and a deliberately conservative fence-*un*gated upper bound that counts matches even inside
code. `tests/render-lists.test.ts`'s *"an Obsidian custom state inside a blockquote is still
literal — the deferred residue"* stays exactly as it is, and now carries the extra fact that the
residue it grades is a population **the corpus does not contain**. The gap is real; the win from
closing it is not measurable on this data.

**P3 — removing the pre-pass breaks two files, and `renderTaskState` cannot repair them.**
This is the entry a future plan starts from. Reproduction, invented and repo-local:

```text
### Phase 1
- [ ] 1. Alpha initialized
- [ ] 2. Beta configured
```

`marked@14.1.4`, raw lexer, no pre-pass in the path:

```text
list.loose = false          item0.task = true          item0.tokens = [list]
```

The item's text begins with an ordered marker, so once `marked` recognises a real GFM task item
and strips `[ ] ` per spec, CommonMark lexes the remainder as a **nested ordered list**:

```text
pre-pass present (today):   • ○ 1. Alpha initialized
                            • ○ 2. Beta configured
pre-pass removed:           • ○
                                1. Alpha initialized
                            • ○
                                1. Beta configured
```

Every item renumbers to `1.` and the author's own numbering is destroyed. Three facts fix the
disposition:

- **`renderTaskState` cannot undo it, because the damage is at *lex* time.** By the time
  composition runs, `item.tokens[0]` is a `list` token, so `renderTaskState`'s documented
  `inline === undefined` fallback returns the prefix as a string and the nested list renders
  under it. **The premise "composition already produces byte-identical output for every task item
  `marked` tokenizes" is false for any item whose text begins with a block-starting construct.**
- **Reproduces tight *and* loose**; `loose` is irrelevant. The control — `- [ ] Alpha initialized`,
  same shape with text not starting `N.` — is **byte-identical** before and after, which isolates
  the cause exactly.
- **Population: 2 files, 50 source lines, 202 changed rendered lines over 4 combos, both glyph
  tiers**, all tight, none carrying an indented continuation. `overflow` and all three detector
  counts stay 0, so **no gate sees this either.**

`tests/fixtures/task-ordered-text.md` and its test in `tests/render-lists.test.ts` pin today's
correct output. **A package that deletes the pre-pass owns that test**, and owes a repair for the
nested lex — suppressing it for task items is real design work, not a side effect.

#### The wiki-link carrier defect: unguarded pre-lexer substitution reaches verbatim contexts

**Recorded, not fixed — WP-1 of `plans/colour-modes.md` (rev 4 at `c381d1c`, the
record-not-fix downgrade reached after three fix designs failed across three audit
cycles).** `markWikiLinks` (`src/wikilink.ts:116-121`, called from `preprocessBody`,
`src/render.ts:251-274`) runs on every source line that `FENCE_LINE`
(`src/render.ts:51`, ``` ``` ``` and `~~~` only) does not toggle off. There is no
indented-code, block-HTML, or container guard, so the pass fires on a line that later
tokenizes as verbatim content exactly as it fires on ordinary prose.

**The substitution is irreversible by construction, which is why the defect cannot be
patched downstream, at a leaf or anywhere else.** `markWikiLinks` replaces the whole
`[[…]]` (or `![[…]]`) match with carrier-wrapped `alias ?? slug`
(`src/wikilink.ts:116-121`) — the fragment, the `|` separator, the `!`, and the slug
itself (whenever an alias is given) are all discarded before the lexer ever runs. A leaf
that later discovers it is rendering verbatim content has nothing left in the rendered
text to restore the authored brackets from.

**Context table**, verified 2026-08-19 by direct execution against this commit at width
80, `UNICODE_GLYPHS`, both colour policies (`{color:false,hyperlinks:false,tmux:false}` /
`{color:true,hyperlinks:false,tmux:false}`):

| Context | Today's behaviour | Status | Witness |
|---|---|---|---|
| Indented code | `[[slug]]`, `[[slug\|Alias]]`, `[[slug#head\|Alias]]` and `![[embed]]` all lose their authored brackets — each label survives as plain text — **inside a recorded `codeRange`**; under colour the cyan/underline pair lands inside that range too, beside the syntax highlighter's own `highlightAuto` SGR | corrupted-recorded | `tests/render.test.ts`, "defect record: indented code loses authored brackets — plain, alias, fragment, embed (pinned until the successor fix plan)" |
| Fenced code | Left untouched — `FENCE_LINE`'s toggle skips every line between a pair of ` ``` `/`~~~` fences | guarded-by-FENCE_LINE | `tests/wikilink.test.ts`, "a fenced [[slug]] example is verbatim in both modes — the fence toggle" |
| Block HTML | `[[slug]]` loses its brackets the same way, but **the corrupted line is not inside any recorded `codeRange`** — `extractCodeRanges` only ever brackets output `wrapCode` produced (fenced/indented code), and block HTML never passes through `wrapCode` — so this corruption carries no class-C protection or exemption at all | corrupted-recorded | `tests/render.test.ts`, "defect record: block HTML loses authored brackets and carries no codeRange exemption" |
| Blockquote-nested code | Same corruption as indented code, at the code's own nested position, inside a recorded `codeRange` | corrupted-recorded | `tests/render.test.ts`, "defect record: indented code nested inside a blockquote loses authored brackets" |
| List-nested code | Same corruption, inside a recorded `codeRange` | corrupted-recorded | `tests/render.test.ts`, "defect record: indented code nested inside a list item loses authored brackets" |
| Codespan interior | `` `[[note]]` `` recognizes and styles the label exactly as prose does — the pre-pass has always fired there (carriers ride the inline `text` token). Decided behaviour, not corruption — "recognition semantics stay frozen" (Decision 7, cycle-1 f6) | kept-recognizing | `tests/wikilink.test.ts`, "defect record: a codespan's wiki-link is still recognized and styled — kept by Decision 7" |
| Inline-HTML interior | `<span>[[note]]</span>` recognizes and styles the label too — for `<span>[[note]]</span>`, marked lexes `html("<span>")` + `text(carriers…)` + `html("</span>")`, so the carriers ride the inline `text` token between the two tag tokens, not the `html` visitor (cycle-1 f6) | kept-recognizing | `tests/wikilink.test.ts`, "defect record: an inline-HTML interior's wiki-link is still recognized and styled — kept by Decision 7" |
| Link labels (a wiki-link's own alias containing a Markdown link) | Does not match `WIKI_LINK` at all — the alias group is `[^\]]+`, and a nested `[label](url)` contains `]` — passes through as literal text, unaffected by this defect | recorded-unchanged | `tests/wikilink.test.ts`, "an alias containing a Markdown link does not match, and continues not to" (pre-existing, WP-4 of `plans/colour-policy.md`) |

**Three failed fix designs, and why each died** — one plan, three audit cycles, no fourth
mechanism proposed after the third failed:

1. **Restore at the leaves** (rev 1). A leaf renderer (`code`, `html`, …) that detects it
   is rendering verbatim content tries to undo the carrier substitution and reconstruct
   the authored `[[…]]`. Dead on arrival: the substitution already discarded the
   fragment, the `|` separator, the `!`, and the slug itself whenever an alias is present
   (`src/wikilink.ts:116-121`) — there is nothing left in the rendered text for a leaf to
   restore *from*. `runs/dispatch/colour-modes-plan-audit-report-cycle1.md`, finding 2.
2. **A byte-offset line map** (rev 2). Accumulate marked's block-token `raw` lengths
   before substitution runs, to know per source line which lines are block-verbatim, and
   skip those in `preprocessBody`. Failed on three independent grounds: marked
   normalizes CRLF to LF, so concatenated token `raw` lengths cannot reconstruct a CRLF
   source's line coordinates — the committed gate-corpus witness
   `tests/fixtures/witnesses/defect-0-crlf-frontmatter.md` breaks the map's own stop
   condition on the binding corpus; top-level accumulation cannot see code nested under
   `blockquote` or `list` tokens, which only ever appear in container children; and
   computing the map before `stripSentinelChar`/`stripTaskStateSentinel`/
   `stripWikiLinkCarriers` run is not classification-preserving — stripping code point 2
   alone changes a paragraph into indented code. `runs/dispatch/colour-modes-plan-audit-report-cycle2.md`,
   finding 1.
3. **A line-count map** (rev 3). Count physical lines per top-level token instead of
   bytes, to sidestep CRLF. Failed differently: token raw line counts are not additive
   across blank-line boundaries (a five-physical-line source splits into three tokens
   whose raw line counts sum to seven, with no rule for which token owns a shared blank
   line), and — more decisively — **marked elides reference definitions from the token
   array entirely**, keeping them only in `tokens.links` with no `raw` and no position, so
   a line-count walk has nothing to place a following code block against.
   `runs/dispatch/colour-modes-plan-audit-report-cycle3.md`, finding 1.

**A fix needs pre-lexer knowledge of which source lines are block-verbatim — source
anchoring marked's own lexer does not provide** (no source-offset API; the same interface
gap `src/walk.ts`'s header and `docs/adr/0001-editor-path.md` both cite for the styled-run
work this repo has already deferred once). That is a successor plan's job — plausibly by
owning the lexer — and the three failures above, together with the context table and the
witnesses it cites, are its starting record rather than a foundation to build on: a future
fix that changes any pinned byte will trip a named witness, which is the point. This
record sits beside, and does not amend, "The task-state pre-pass" above: that pass's own
class-C exception was requested and **the user withheld it** (`src/render.ts:186-192`,
this file's task-state section above). The two defects share a mechanism — an unguarded
pre-lexer substitution reaching fenced or indented code — but they are independently
dispositioned, and repairing one does not authorize repairing the other.

#### Colourless gates cannot see colour-only defects — and that is now a class, not an anecdote

Three separate measurements have found a defect that is invisible without `FORCE_COLOR`, and the
mechanism is the same each time: **a pass reasons about rendered text as if SGR sequences were not
in it.** Every gate `bun run verify` runs is colourless, so none of them can fail on any of these.

| Where | What only colour reveals |
|---|---|
| `extractCodeRanges`' proposed narrowing (WP-2, above) | the predicate counts a code block's own SGR brackets as the "non-whitespace" that triggers narrowing, tripling the affected population and dropping genuine ranges |
| `TASK_STATE_SENTINEL` (WP-4) | the sentinel reaches the syntax highlighter *inside* a code block; the highlighter wraps it in an SGR pair; the strip removes the character and leaves the pair |
| the ASCII tier's "byte-identical round-trip" | asserted here, pinned by `tests/glyphs.test.ts` and `tests/render-lists.test.ts` — **true colourless, false under colour** |

The task-state case, measured: the same axis set gives `classC=2` colourless and `classC=3` under
`FORCE_COLOR=3`, the extra combo being the **ASCII** tier of a file whose unicode tier already
failed. Inside a recorded `codeRange` it emits an orphaned, empty colour pair the author never
wrote:

```text
base:  "    - [\x1b[31m\x1b[39m ] \x1b[31mFinal\x1b[39m …"
clean: "    - [ ] \x1b[31mFinal\x1b[39m …"
```

**Rule this earns: a claim that a pass round-trips byte-identically is not established by a
colourless test.** Re-measure it under `FORCE_COLOR=3` before writing it down, and say which
colour mode a recorded figure was taken in — a parity figure without its colour mode is a
provenance gap, exactly as WP-2 found for the code-range populations.

#### The closure: layout stopped reasoning about bytes — WP-3 of `plans/colour-policy.md`

The class above is closed for the *layout* half, and the count that says so is the colour
axis: **`charDiff` 31 → 0 over the fixed gate corpus, both glyph tiers, with the
colour-off render byte-identical in 140 of 140 combos.** Read the second half of that
sentence as the binding one — the direction of repair was pinned before the work started
(cycle-3 f6): the colourless render is the frozen baseline, and every repair makes the
*stripped colour-on* render equal it. Not one of them was allowed to move the colourless
side. **`charDiff` itself is history**: WP-5 of the same plan replaced that ratchet, and
its `sgrAny` counterpart, with three exact per-combo gates over a three-child axis —
`scripts/AGENTS.md`'s colour-axis section carries the live definitions; `charDiff`'s
closure to 0 is what this section's own repairs are evidence for, not a number any gate
still reads.

The mechanism was always one sentence — **a layout decision made on bytes rather than on
columns** — and it had five instances, three recorded in the plan and two exposed by
repairing the first:

| Pass | The decision it made on bytes | What it produced under colour |
|---|---|---|
| `fixNestedLists` (`src/lists.ts`) | `\S` before a multiple-of-four indent matched an SGR reset's `m` | a join that does not exist, split at the escape — **7 lines of `"    ESC[0m"` in `nested-list.md` at width 80** |
| the empty-line filter (`src/lists.ts`) | `line !== ""` on raw bytes | an encased blank line survived a filter written to drop it, and was then indented |
| `wrapAnsi` (`src/wrap.ts`) | an escape-only run was a word | it consumed the pending space and left it trailing — `"…recorded at "` |
| `isHardBoundary` (`src/render.ts`) | `HARD_BREAK_TAIL` anchored at end-of-*bytes* | a styled `<br />` stopped ending a line, merging two rendered lines into one |
| the three marker-shape guards (`src/render.ts`) and `substituteBullets` (`src/lists.ts`) | anchored regexes over raw lines | the guards were **inert under colour** — not a missing space but a *different wrap*, because a seam that cannot see the collision does not re-wrap a column narrower either (`fenced-list.md` at width 116: 114 columns colourless, 116 under colour) |

The last row is the one worth remembering, because it is the reason this section exists.
Those guards had been described here for three work packages as if they ran; they ran on
half the renders. **The repair in every row is the same and it is not a special case**:
ask the question of `stripAnsi(line)` — or, where the answer is a *position* rather than a
predicate, of the visible text plus `visibleMap`'s offsets (`src/lists.ts`) so the edit
still lands on the right byte. `claimLine` had already made exactly this correction in
WP-5 of `plans/tn-review-remediation.md` for the marker claim; what WP-3 did was finish
applying it.

**And `stripAnsi` itself was part of the class.** It removed SGR only, so an OSC-8
hyperlink's destination URL counted as visible text everywhere in the repo — six
production call sites, three hand-maintained copies in tests, and a fourth private copy
inside `src/wrap.ts`'s tokenizer. It is a derivation of `src/ansi.ts`'s scanner now
(SGR, OSC-8, DCS, malformed), the copies are imports, and `wrapAnsi` consumes the span
sequence at **both** of its split paths — so no sequence can be cut and no sequence can be
measured as text. What that closes is the second half of the same defect: a pass that
reasons correctly about the escapes it knows and not at all about the ones it does not.

### Glyph tier

`src/glyphs.ts` resolves one capability tier that drives bullets, the rule character, table
borders, and task-state glyphs **together** — there is no per-feature toggle.

| | Unicode | ASCII |
|---|---|---|
| Bullets (by depth, cycling) | `•` `◦` `‣` | `-` |
| Rule / frontmatter divider | `─` | `-` |
| Table borders | box-drawing | `+` `-` `\|` |
| Task states | `○` / `✓` | `[ ]` / `[x]` |

Precedence, highest first: **resolved ambiguous width `wide`** (`src/glyphs.ts:113`, ahead of
everything — see below) → `--ascii` / `--unicode` (mutually exclusive; passing both throws) →
`MDVIEW_GLYPHS=ascii|unicode` → auto-detection. Auto-detection is ASCII when `TERM` is one of
`linux dumb vt100 vt220 ansi`, otherwise Unicode iff `LC_ALL || LC_CTYPE || LANG` matches
`/utf-?8/i`. **The flags exist because no heuristic is a contract** — do not tune the heuristic
in place of them.

Every Unicode substitute is exactly 1 column, so the tier has **no width impact** and
`chromeWidth` stays `3N+1`. Both tiers are swept separately anyway (see "Corpus sweep" in
`scripts/AGENTS.md`); a change that widens a glyph must show up there.

**That paragraph is true only under *narrow* ambiguous-width measurement, and WP-3 found out how
narrowly.** `•`, `─` and the whole box-drawing set are East Asian *Ambiguous* and measure 2
columns under `MDVIEW_AMBIGUOUS=wide`; only `◦`, `‣` and `✓` are 1 either way. `resolveGlyphs`
therefore takes the resolved ambiguous setting as a third argument and **refuses to hand this
tier out in wide mode at all**, which makes the combination `unicode × wide` unreachable from
the CLI. See "`wide` forces the ASCII glyph tier" below for the arithmetic.

Bullet substitution runs **once, at the outermost list** (`listDepth() === 1`), reading depth
back out of the line's own indentation. Owning composition removed the *original* reason for
that restriction — it is no longer racing marker detection for ancestors still on the stack —
but three independent blockers keep the pass where it is; they are in the retained-passes table
above. The pass skips any line that *starts* inside a `SENTINEL` region, and matches the marker
**only on the four-column grid** (WP-2f), because the post-compose wrap runs before it and can
put an author's own bare `*` at the start of a continuation line.

### Command-line surface (WP-4)

```
mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--color[=WHEN]] [--no-color] [--plain] [--hyperlinks[=WHEN]] [--probe] [--help]
mdview view <file.md> [options ...]
mdview highlight-as <fence> <language>
mdview probe [--refresh] [--no-cache] [--timeout MS]
mdview help [subcommand]
```

**`--no-color`, `--plain` and `--hyperlinks[=WHEN]` (WP-3 of `plans/colour-modes.md`)** follow
`--color`'s own conventions exactly, parsed in the same flat `for` loop in `parseArgs`:
`--no-color` is not a second field, it is parsed straight into the same `color` local as
`--color=never` — so `--no-color --color=always` and the reverse both resolve by the one
last-wins rule `--color` already has, and nothing downstream of `parseArgs` ever sees two
colour flags that could disagree. `--hyperlinks[=WHEN]` is `--color`'s shape transplanted onto
the independent hyperlink axis: bare means `always`, repeated last-wins, an unrecognised value
throws. `--plain` alone has no `=WHEN` form — it is a bare boolean, because "plain" is not a
point on the `auto`/`always`/`never` scale the other two flags share; see "Colour" below for
what it does at the CLI boundary, which is the part that is not just flag parsing.

**`mdview <file.md>` with no subcommand is load-bearing, not a convenience.** It predates
subcommands and is the invocation the user runs daily, so `main` dispatches to a named handler
*only* when `args[0]` is exactly `view`, `highlight-as`, or `help`; everything else — including
every flag, all of which start with `-` — falls through to the same view path as before. A new
subcommand slots into that dispatch without disturbing it, and WP-3's `probe` did exactly that
— one added name in `main`, one in `runHelp`, and nothing about the fall-through touched.
`--probe` is *also* accepted on the view path, because `plans/crucible-tui-launch.md` publishes
both spellings (its "Public Interfaces" section says `mdview --probe`, its WP-3 text says
subcommand) and supporting both costs one line of delegation, where picking one would make a
published spelling a lie. The cost of the shape is one edge case, accepted knowingly: a file
named exactly `view`, `help`, or `highlight-as` with no extension must be given as `./view` or
via `mdview view view`.

`main(args = Bun.argv.slice(2))` stays exported and stays **throwing**; tests call it in-process
and assert on thrown messages, which is what keeps the suite subprocess-free. The
`import.meta.main` block is therefore the *only* place errors are caught, rendering them as a
single `mdview: <message>` line on stderr with exit 1. Without that boundary Bun wraps every
carefully worded message in a source excerpt, a stack trace, and its own version banner, and
leaks the absolute install path while doing it. **Do not move the catch into `main`, and do not
add a second one.**

**Config** is JSON at `$XDG_CONFIG_HOME/mdview/config.json` (falling back to `~/.config/...`).
`highlightAs` maps a fence info-string to a highlighter language, layered *over* `src/lang.ts`'s
built-ins (`dataviewjs`→`javascript`, `dataview`→`sql`); a user entry for a key with a built-in
default wins. `color` is `auto`/`always`/`never` and is **a directive rather than a boolean**,
unlike the `emoji` key beside it: colour has an explicit third state a user may want to write
down (*I know this key exists and I want the default*), which is not the same statement as
omitting the key. It is the fifth slot in the precedence table under "Colour" below, so it
loses to anything said about this invocation. `hyperlinks` (WP-3 of `plans/colour-modes.md`)
sits beside it, read the identical way through the same `parseColourDirective`, and is its own
independent axis rather than a second reading of `color` — see "Colour" below for its own
precedence slot.

**The resolver is a value, built once, and there is no process state behind it.**
`src/cli.ts`'s `runView` calls `makeFenceLanguageResolver(config.highlightAs)` after
`loadConfig`, which merges the user's map over the built-ins, **freezes** it and closes over
it; the resolver is handed to `renderDocumentDetailed` and rides the `LayoutContext` as
`resolveFenceLanguage`. Calling the factory again produces an independent resolver rather
than re-pointing the first, which is the entire behavioural difference from what it replaced.
Callers that never had user aliases — `scripts/sweep.ts`, `scripts/render-diff.ts`, every
test that renders directly — get `resolveFenceLanguage`, the defaulted single-argument
wrapper over a built-ins-only resolver built once from a frozen constant.

**That shape is code-review finding F4, closed rather than contained** (WP-3 of
`plans/marked-terminal-replacement.md`). The history is worth keeping because the *reason*
for the global is the reason the seam had to exist first: `render.ts` reached the resolver by
module import and called `resolveFenceLanguage(lang)` with a single argument, so there was
nowhere to pass a configured map — and the only way to make `highlight-as` take effect was a
`setHighlightAliases` setter mutating an `effectiveAliases` module global for the whole
process. WP-2 built the seam (`LayoutContext`), WP-3 landed a value in it, and **the setter
and the global are gone.** The symptom they caused is the measurement that makes the point:
one test file could install an alias into another, reproduced as
`bun test tests/config.test.ts tests/lang.test.ts` going **31 pass → 30 pass / 1 fail** when
the isolating `afterEach` was deleted, with the full suite staying green only by an accident
of Bun's file ordering that had been measured to differ between two checkouts. Those
`beforeEach`/`afterEach` hooks are gone too — not because they were unnecessary, but because
there is nothing left for them to reset.

The read and write paths are deliberately asymmetric, and the asymmetry is the design:
**reading is lenient, writing refuses.** A malformed config degrades to defaults with one stderr
notice naming the file and still renders the document; a bad *entry* is dropped individually so
it does not cost the others. But `highlight-as` **refuses** to write into a file it cannot
parse, because merging into a file it cannot understand would either clobber content it can't
see or silently discard it. Writes are atomic (temp file + `rename`) and touch only
`highlightAs[fence]`, preserving every other key — it round-trips the *raw* JSON object, never
the typed `MdviewConfig`, which would silently drop any key this module doesn't know about the
first time the subcommand ran.

**Man page:** roff source at `man/crucible-tui.1`, installed by `bun run install:man` as **both**
`~/.local/share/man/man1/mdview.1` and `.../crucible-tui.1` — symlinked, matching the
`dist/mdview` PATH convention, so edits take effect without reinstalling. Two links to one
source, because the tool answers to two names and a reader who knows the project as
`crucible-tui` should not get "No manual entry" for typing it. That split is deliberate and
settled — see "Two names, on purpose" at the top of the root `AGENTS.md`. Do not reconcile the
two names.

### Colour: one owned decision, resolved from inputs handed in

**How much SGR this render emits is `LayoutContext.sgr`, a three-level `SgrMode`**; whether the
renderer emits OSC-8 hyperlinks is `LayoutContext.hyperlinks`. Both are resolved **once per
render**, by `resolveColourPolicy` (`src/colour.ts`), and threaded as
`renderDocumentDetailed`'s last parameter — WP-1 of `plans/colour-policy.md`, with the colour
half widened from a boolean at WP-2 of `plans/colour-modes.md`.

**Nothing in `src/colour.ts` reads `process`.** The environment, the destination's TTY-ness, the
platform, the parsed `--color` flag and the config file's `color` key are all arguments. That is
the same rule `glyphs` and `measure` already follow, extended to the last decision that was still
being made behind the renderer's back, and it is what makes every environment case testable in
one process — `tests/colour.test.ts` runs the whole matrix, including the Windows branches, with
no subprocess anywhere.

The ratified precedence, highest first, is `--color` → `MDVIEW_COLOR` → `NO_COLOR` (presence
counts, even empty) → `FORCE_COLOR` → config `color` → `isTTY`. Two edges are worth naming here
because they are policy rather than transcription: **`NO_COLOR` outranks `FORCE_COLOR`** (a user
who exported the first said something about this machine; a `FORCE_COLOR` inherited from some
parent process did not), and **a malformed `FORCE_COLOR` decides nothing and falls through** —
`"0"`/`"false"` are no, `""`/`"true"`/`"1"`-`"3"` are yes, and anything else is not a directive.
Hyperlinks are an independent axis with an absolute non-TTY ceiling; `NO_COLOR` does not touch
them. **The hyperlink axis's own precedence**, highest first, since WP-3 of
`plans/colour-modes.md` (Decision 6): the non-TTY ceiling (checked first inside
`resolveHyperlinks`, and still absolute — nothing below it can turn a hyperlink on off a
terminal) → `--hyperlinks` flag → `MDVIEW_HYPERLINKS` → config `hyperlinks` → terminal
detection. `HyperlinkInput` — the interface `resolveHyperlinks` is typed to — carries the new
`flag`/`config` fields; `resolveColourPolicy`'s own signature is unchanged, and it maps its
`ColourPolicyInput`'s new `hyperlinkFlag`/`hyperlinkConfig` fields into them (cycle-3 f5's exact
type relationship, so `resolveHyperlinks` never has to know the shape of the larger input).

**`--plain` sits above both axes and is not a fifth precedence slot — it is a short-circuit at
the CLI boundary, and where that happens matters.** Decision 2: the policy under `--plain` is
built by hand in `src/cli.ts`'s `runView` — `{ sgr: "none", hyperlinks: false, tmux:
resolveTmux(env) }` — **without calling either `resolveColor` or `resolveHyperlinks` at all**.
The alternative — giving `--plain` the top slot in each ladder and letting the existing
functions return early — was rejected (cycle-3 f4): even an early return still *evaluates* the
call, and both functions read `MDVIEW_COLOR`/`MDVIEW_HYPERLINKS` and call `warn` on a malformed
one before deciding anything else, so a `--plain` render would have printed a warning about an
environment variable it was about to ignore. Short-circuiting one level up — never calling the
resolver — is the only shape where a malformed value under `--plain` produces silence, which is
what `tests/cli.test.ts`'s no-warning-under-`--plain` cases assert. `tmux` is still resolved
under `--plain`: it is a fact about the destination an OSC-8 emitter would need, not a colour
decision, and resolving it costs nothing even though `--plain`'s `hyperlinks: false` means it
never gets used.

*History, because the conclusion inverted.* Until WP-6 this asked `marked-terminal` directly: a
throwaway extension was built, its `strong` was handed a probe string, and the answer was
whether anything came back around it. WP-6 replaced that with **`supports-color`, promoted from
transitive to direct**, on the argument that `chalk`'s rule — ~150 lines of stream, flag and
environment inspection — was the rule that had always governed this tool's output, and that a
tool reproducing only the TTY half would answer differently the first time it met `--color`,
`FORCE_COLOR=false`, `TERM=dumb` or a CI runner. The equality was measured rather than assumed:
both spellings ran against a **36-cell environment matrix** and **agreed on all 36**.

**That measurement still stands and is no longer the argument, because the goal changed.** The
question WP-6 answered was *what does `chalk` decide here*; the question the ratified policy asks
is *what should this tool decide*, and the two have different answers. `supports-color@7.2.0`
scans the whole of `process.argv` for `--color` through `has-flag`, so a flag aimed at the `bun`
wrapper — or at nothing at all — turned styling on inside the renderer; and it has **no reference
to `NO_COLOR` at all**, so the one environment variable with an actual cross-tool convention
behind it was ignored for the tool's entire life. Neither is a bug in that library. Both are
disqualifying for a policy this tool is supposed to own, which is why the dependency went.

**`chalk` itself is not a dependency of this repo and is not read anywhere.** A copy survives in
the tree at `4.1.2` only as **eslint's** transitive — a devDependency of a devDependency, in
nothing this ships; the nested `5.6.2` left with `marked-terminal` and the `4.1.2` that
`cli-highlight` pulled in left with it at WP-2.

**Two authorities disagreed with the policy above for exactly one work package, and closing
them is what WP-2 of `plans/colour-policy.md` did.** `src/table.ts` styled through
`@colors/colors`' own environment-only `enabled` flag, and `cli-highlight` gated syntax colour
on that `chalk@4`'s module-load level. So `MDVIEW_COLOR=always` on a pipe coloured everything
the renderer emitted and **nothing** either of those two emitted — measured on `tight-list.md`
at width 80, where the forced-colour render carried the highlighter's `31m`/`36m` token colours
and the `MDVIEW_COLOR=always` render did not, with identical visible text. `--color=always`
happened to agree with `FORCE_COLOR=3` only because `@colors` sniffed argv for `--color` too,
which was the same accident in a second package.

**Both packages are gone and every producer reads the resolved mode.** The styles come from
`src/style.ts` — a narrow committed table of exactly the `[open, close]` pairs this renderer is
authorized to emit, with `38`/`48` introducers rejected by an assertion independent of the
emitter — and the syntax colours from `src/highlight.ts`, this repo's transcription of
`cli-highlight`'s span walk over `highlight.js` direct. What that bought, measured at WP-2's
close over all fourteen gate-corpus files at three widths in both glyph tiers:
**`MDVIEW_COLOR=always` on a pipe is byte-identical to `FORCE_COLOR=3` in 84 of 84 combos**
(36 of the 84 differed before), and the forced-colour render itself did not move a byte.

**"Every producer" was one short until WP-4, and the exception was the oldest of them.**
`styleWikiLink` (`src/render.ts`) read no policy at all — it wrote a cyan/underline SGR pair
into the markdown *source* before the lexer, so it styled at every colour level including
colourless and its bytes were not in the committed table. `src/wikilink.ts` replaced it with a
carrier pair through the lexer and a post-walk pass over `applyStyle` (see "The sentinels"),
and the sentence above is now unqualified. Measured: the forced-colour render is byte-identical
across the change in all 84 colour-on combos, the colour-off render lost exactly those four
escape codes on the one gate-corpus file that carries a wiki-link and moved no visible
character on any of the 168 combos measured, and the colour axis's `sgrAny` went **5 → 0**.

**One colour-off consequence, and it is Decision 1 rather than a regression.** Because
`@colors` answered from the environment without consulting `isTTY`, a plain
`mdview file.md | cat` used to emit that package's table styling into the pipe — 205 grey pairs
and 12 bold pairs on `wide-table.md` alone, with no colour requested anywhere. Those escapes are
gone: the piped default now emits exactly what a `FORCE_COLOR=0` render always emitted, which is
what the ratified spec's first decision asks for. The visible text is identical, and the
sanitized colour-off renders every gate and sweep actually measures were byte-identical across
the package (84 of 84).

#### Three levels, not two: `SgrMode` and the hue/format split (WP-2 of `plans/colour-modes.md`)

`ColourPolicy.color: boolean` became **`sgr: "full" | "formats" | "none"`**, and that one type
is the whole of the colour-mode work. The predecessor plan
(`plans/styled-runs-and-colour-policy.md`, closed won't-implement) needed eight work packages
for the same semantics because hue and weight were fused into opaque byte strings at six
independent producers, and *"thread a policy to the producers"* cannot express *"drop hue,
keep bold"*. `plans/colour-policy.md` retired that premise without setting out to: since it
landed, every producer holds a **named** chain (`createStyler("gray")`, not `"\x1b[90m"`) and
exactly two emitters turn a chain into bytes. The name survives to the point of emission, so
the mode semantics are a **filter inside `src/style.ts`** rather than a renderer migration.

**What each level means.**

| Level | Emits | Reached by |
|---|---|---|
| `full` | every committed style | `always` at any slot; `FORCE_COLOR` truthy; the `isTTY` floor |
| `formats` | format and control classes; **no hue** | the three explicit `never` **directives** only — `--color=never`, `MDVIEW_COLOR=never`, config `never` |
| `none` | nothing of the tool's own | `NO_COLOR` presence; `FORCE_COLOR=0`; a non-TTY with nothing requested |

**The kill-switch/directive split is the load-bearing distinction and it is not cosmetic**
(Decision 5). A `never` *directive* is a user saying *this tool, this render, no colour*, and
Decision 1 reads that as "no hue, keep the formatting" — dim, bold, italic, underline and
strikethrough are not colour. `NO_COLOR` and `FORCE_COLOR=0` are kill-switches with an
established cross-tool meaning and an installed base, and they keep today's bytes exactly.
**Those three directive routes are the exhaustive list of inputs whose rendered bytes WP-2
moved**; `full` and `none` renders are byte-identical to the WP-1 commit across the gate
corpus at every width and both tiers, verified by scripted byte diff (336 combos, 0 differing)
as well as by `render-diff --expect a`. Any other moved byte is a defect, not a re-baseline.

**The classification is of style *names*, and it lives beside the table it classifies.**
`STYLE_CLASSES` (`src/style.ts`) is total over `STYLE_TABLE` by a `satisfies` constraint, so a
new committed style cannot be added without being classified:

- **hue** — `red green yellow blue magenta cyan gray`. The only class `formats` drops.
- **format** — `bold dim italic underline strikethrough`. **`dim` is a format, not a hue** —
  the user's own words at Decision 1, and the membership most at risk of being "corrected" by
  someone reading `2m` as a brightness. It is what keeps the frontmatter metadata block
  legible under `--color=never`.
- **control** — `reset` (Decision 8, cycle-1 f9). `0m` both directions, framing every
  paragraph, rule and list item. Emitted whenever `sgr !== "none"`.

**The filter runs before `chalk`'s two surgeries, and the ordering is the part to get right.**
`applyStyle`'s re-open surgery re-emits *this chain's own* close codes and appends the matching
open; its newline encasing reinserts *this chain's own* `openAll` after every line break. Run
either over the unfiltered chain and a `formats` render gets its hue back — on the second line
of every wrapped span, where no single-line assertion would see it. `filterChain` rebuilds the
chain through `createStyler` over the surviving names rather than string-editing `openAll`,
because the accumulation order (outermost-first open, innermost-first close) is a parity-class-A
obligation and re-running the original builder is the only spelling that cannot get it wrong.
A chain that filters to nothing emits **nothing** — not an empty open/close pair.

##### The reader inventory, with each reader's threshold

Every consumer of the colour decision, and which of the three levels it keys on. The table
exists because "derive a boolean and carry on" is exactly the change cycle-2 f4 rejected: it
would have run the highlighter — and `fixHardReturn`'s visible-content change — under
`formats`.

| Reader | Threshold | Why |
|---|---|---|
| `applyStyle` / `styleSpan` (`src/style.ts`) | all three | the filter itself; `none` returns the input, `formats` drops hue-class links, `full` is the identity |
| every inline visitor (`src/inline.ts`), every block leaf (`src/blocks.ts`), the list-item chain (`src/lists.ts`), `styleWikiLinkCarriers` (`src/wikilink.ts`) | `sgr !== "none"`, **via `applyStyle`** | they pass `ctx` through and implement no filter of their own — Decision 8's property rule in structural form |
| `renderTable` (`src/table.ts`) | all three | the producer the split divides: `bold` heads survive `formats`, `gray` borders do not |
| `formatMetaBlockDetailed` (`src/frontmatter.ts`) | `sgr !== "none"` in effect | it emits only `dim`, which is format-class, so `full` and `formats` are byte-identical here |
| **`highlightCode` (`src/blocks.ts`)** | **`sgr !== "full"` returns raw code** | Decision 3's named producer exception — see below |
| `LayoutContext.color` | derived, `sgr !== "none"` | **no production reader left.** Retained as the default threshold and tested for all three modes; deleting it is a future package's call |

**Decision 3 is a producer exception, named rather than hidden.** Fenced-code syntax
highlighting runs under `full` and nothing else, so a `formats` fence is byte-identical to a
`none` fence. Two reasons, both measured: the highlight branch carries `fixHardReturn`, a
**visible-content** transform inside a `codeRange` (it rewrites the first `\r` as the five
literal characters `/\n/g`), so reaching it under `formats` would break
`visible(formats) === visible(off)` — the property WP-4's G2 gate is about, which this keeps
true *by construction*; and the theme is not hue-only — it carries `dim`, `italic`, `bold` and
`underline` (`src/highlight.ts`), all format-class, so a property filter would have produced a
half-highlighted fence, decoration with its colours removed and its emphases kept. What
`formats` loses is enumerated: the theme's bold/italic/underline/dim spans inside fenced code,
and nothing else. The property-pure alternative — highlighting under `formats` through a
`fixHardReturn`-free path — is recorded in the plan as the fallback if the exception is ever
withdrawn. **A future package adding a second producer exception owes the same two-part
justification**; everywhere else the rule is Decision 8's.

**Two things this package deliberately did not touch, and both are user-withheld ground.** The
task-state pre-pass (`src/render.ts:186-192`; "The task-state pre-pass" above) keeps its
class-C exception withheld and its 84 corrupted lines exactly as they are — any task-state byte
movement anywhere is a defect. The wiki-link verbatim defect ("The wiki-link carrier defect"
above) stays recorded-not-fixed, and its pinned witnesses in `tests/render.test.ts` and
`tests/wikilink.test.ts` had their policy literals migrated (`color: true` → `sgr: "full"`,
`color: false` → `sgr: "none"`) with **not one expected byte moved** — they are the instrument
a future fix has to trip, and a migration that also tidied an expectation would have destroyed
it.

### Ambiguous width (WP-3)

`src/width.ts` owns one question: **how many columns is an East Asian *Ambiguous* character?**
Unicode's answer is "one or two, depending on the terminal, and you cannot tell from the
character" — and almost every non-ASCII character in this corpus is in that class
(`— – → ← … ≥ × • ○` and the whole box-drawing set; 90 em dashes in one real document).
`string-width@7` defaults to narrow, which is also TR11's own recommendation when the context
cannot be established, and that default was hardcoded at **26 call sites across 7 modules**
because the library takes the setting as a *per-call option* and offers no global switch.

**`src/width.ts` is now the only file in `src/` or `scripts/` that imports `string-width`**, and
`tests/width.test.ts` asserts it. That is not tidiness: a module that imports it directly
silently opts out of whatever mode was resolved, and **no width gate can see that**, because a
check measured with the wrong ruler passes. It is the same class of defect as the `cli-table3`
v4/v7 disagreement below (closed in WP-3 of `plans/tn-review-remediation.md`, by owning the
emitter), and it is exactly the kind this repo has shipped green four times.

#### The mode is threaded, exactly like `GlyphSet`, and for the same stated reason

`src/glyphs.ts`'s header is the precedent: *"this module is the only place that reads the
environment; `render.ts` and `table.ts` stay pure and take a `GlyphSet` argument so every test is
deterministic regardless of the machine's `TERM` or locale."* A process-global
`ambiguousIsNarrow` in `width.ts` would be smaller and is precisely what that sentence was
written to prevent — it makes every test's result depend on what ran before it, and the sweep's
numbers depend on the machine that ran them.

So a `Measure` is a value: a callable `(text) => columns` carrying an `ambiguous` tag, passed
alongside the glyph set on the channel that already exists (`cli.ts` → `renderDocumentDetailed`
→ `LayoutContext` → `renderTable`), and **defaulting to `NARROW_MEASURE` at every public entry
point**. The default is not a convenience — it *is* rule 4 of the resolution order — and the
narrow branch calls `stringWidth(text)` with **no options object at all**, byte-for-byte the
call all 26 sites used to make. That makes narrow-mode output identical to the parent commit *by
construction* rather than by measurement. Measured anyway: **4,368 renders (21 files × 104
widths × both tiers) byte-identical, 0 differing bytes, 0 `codeRanges` disagreements.**

Since WP-2 the `Measure`, the `GlyphSet`, the prefix stack, the fence-language resolver, the
`emoji` decision and the colour decision are one immutable `LayoutContext`
(`src/layout-context.ts`), constructed once per render and threaded explicitly. That is what
makes the layout state reachable from a visitor that is no longer a closure inside
`renderDocumentDetailed` — the whole point of the seam.

#### Resolution order (highest first)

1. `MDVIEW_AMBIGUOUS=narrow|wide`. Any other value — unset, empty, a typo — is **ignored** and
   falls through. Never throws on a bad env var; that is the `MDVIEW_GLYPHS` contract and this
   matches it exactly.
2. A cached probe result for **this terminal identity**.
3. A live DSR probe, iff stdin *and* stdout are TTYs **and the caller opted in**. `allowProbe`
   defaults to *off*, which is the load-bearing direction: `--check`, the sweep and the whole
   test suite get "no terminal I/O, no cache writes" for free rather than each having to
   remember.
4. **Narrow.**

**The cache key is deliberately over-specified**: `TERM`, `TERM_PROGRAM`, `COLORTERM`,
`VTE_VERSION`, the multiplexer, and the locale. The locale is in the key because it is
conventionally *the* thing that changes a terminal's ambiguous-width behaviour.

*This paragraph has been rewritten twice against field data, and the history is the point.* It
first justified the key by claiming `TERM` alone cannot separate the validated terminals
"because a multiplexer rewrites it". **The validation disproved that**: zellij did **not**
rewrite `TERM` — ghostty under zellij reported `xterm-ghostty` — so that specific mechanism
never fired. The five-terminal survey of 2026-07-28 then supplied the mechanism that is actually
real:

| host | `TERM` | distinguishing field |
|---|---|---|
| ghostty + zellij | `xterm-ghostty` | `TERM` |
| urxvt | `rxvt-unicode-256color` | `TERM` |
| kitty | `xterm-kitty` | `TERM` |
| gnome-terminal | **`xterm-256color`** | **`VTE_VERSION=7600`** |
| anything + tmux | `tmux-256color` | *(the host that started the server — see below)* |
| mlterm | `mlterm` | `TERM` — **and the only measured `wide`** |

**`TERM` is a terminfo name, not an identity, and this machine already proves it**:
gnome-terminal reports the *generic* `xterm-256color`, the value plain xterm, alacritty and
terminator also claim. `VTE_VERSION` is what separates it. That is the real justification; the
multiplexer-rewrite story was speculation that happened to be wrong.

**Under tmux the key is dominated by tmux's own fields, and that is correct rather than a
collision.** The reason it is correct is **not** that the host fields vanish — it is that **tmux
answers DSR from its own grid model rather than relaying to the host**, measured by running the
probe in a fully detached session with nothing attached to render anything, which still replied
`\e[1;2R` in 5 ms. mdview's output is laid into tmux's grid and *tmux* decides the wrapping, so
tmux's opinion is the one that governs and sharing an answer across hosts is the desired
behaviour. A host that disagrees with its own multiplexer is already rendering corrupt output
for every program, and is not mdview's to reconcile.

**What tmux actually does to the environment** (measured 2026-07-28 by injecting known values at
server start and reading them back inside a pane): it overrides exactly the two variables it
owns — `TERM` → `tmux-256color`, `TERM_PROGRAM` → `tmux` — and **passes everything else through
unchanged, frozen at server-start time**. `COLORTERM` and `VTE_VERSION` both survive; the
default `update-environment` list carries neither, so an *attaching* client contributes nothing.
The consequence is that a pane's identity records **whichever host started the server**, not
whoever is looking at it:

| tmux server started from | identity under tmux | how |
|---|---|---|
| kitty / ghostty | `…\|colorterm=truecolor\|vte=\|mux=tmux` | field |
| urxvt | `…\|colorterm=rxvt-xpm\|vte=\|mux=tmux` | field |
| gnome-terminal | `…\|colorterm=truecolor\|vte=7600\|mux=tmux` | lab, **then field** |

The last row is worth its own note: it was **predicted from the injection experiment and then
confirmed live**, byte-for-byte, in a real gnome-terminal + tmux session. That is the difference
between this version of the paragraph and the three wrong ones — the rule was stated first and
the observation arrived afterwards to match it.

So tmux keys split **per server origin**, not per host and not into one bucket, and the split
persists for every client that ever attaches. The cost is bounded at one spurious re-probe per
origin, all of them agreeing, because tmux gives the same answer regardless. Over-specifying
costs a re-probe; under-specifying hands ghostty urxvt's answer.

**The one place the key is genuinely under-specified, found 2026-07-28 by installing a terminal
that can be configured either way.** mlterm's `col_size_of_width_a` is a config-file setting:
`=2` probed **wide** (`\e[2;3R`, cursor 1→3), `=1` probed **narrow** (`\e[2;2R`), same binary,
same session shape, and **byte-identical identity strings**
(`term=mlterm|program=|colorterm=truecolor|vte=|mux=none|locale=en_US.UTF-8`). Two correct
opposite answers under one key. The cache therefore serves the stale verdict across such a flip
until `--refresh`, and no field available to the identity can fix it, because the setting never
reaches the environment. Documented in the README as user-facing advice rather than papered
over. **Do not "fix" this by widening the key** — there is nothing to widen it with; the honest
options are a TTL or always re-probing on a TTY, and neither is worth 5 ms per run against a
setting most users change never.

This pair is also **the proof that the probe measures rendering rather than correlating with
`TERM`.** Six narrow terminals could not establish it; one terminal that answers both ways under
an unchanged identity does, and it is the only evidence in the repo that distinguishes the
design from a lookup table. Every `wide` claim before this was `MDVIEW_AMBIGUOUS` or a test
double.

**zellij is the opposite and overrides nothing.** Measured on two different hosts: ghostty under
zellij keeps `TERM=xterm-ghostty`, kitty under zellij keeps `TERM=xterm-kitty`, and neither
gains a `TERM_PROGRAM` it did not already have — kitty sets none, so the field stays empty where
tmux would have stamped `tmux`. Under zellij the key therefore still identifies the **host**,
correctly. This is also the cleanest argument for keeping `mux` in the key at all: kitty bare and
kitty-under-zellij differ in **exactly one field**, and it is that one. **Do not generalise from
one multiplexer to another** — the two behave oppositely on environment, and `screen` differs
from both again (it does not strip `ZELLIJ`, which is why `detectMultiplexer` needs `TERM` as a
tiebreaker).

**Keep the claim sized to the evidence.** This paragraph has now been wrong three times while
the code was right throughout: first "a multiplexer rewrites `TERM`" (zellij does not), then
"every host collapses to one key" and "tmux strips `VTE_VERSION`" (it strips nothing — it
overrides two variables and freezes the rest). Each wrong version was an observation generalised
into a mechanism. The rule above is stated as a rule because it was measured as one.

Writes are atomic (temp file + `rename`, `src/config.ts`'s pattern); every corrupt, truncated,
wrong-version or unreadable shape reads as a **miss** and re-probes, and an unwritable cache is
a `false` return, never a throw — a viewer that refuses to render because a file it generated is
corrupt has mistaken its plumbing for the user's request.

**The probe never moves the cursor to a cell it did not already own.** It asks where the cursor
is, writes one character *there*, asks again, and the difference is the answer; then it returns
to the recorded column and clears to end of line, which is exact because nothing to the right of
the cursor existed before. The obvious alternative — CR to column 1, write, restore — overwrites
whatever the shell prompt left there and cannot put it back. Within two columns of the right
margin it **refuses and says so** rather than guessing, because the glyph would wrap and the
erase would clear a line the probe never wrote.

Cooked mode is restored in **three** layers, and the third is not belt-and-braces: a `finally`
covers a throw or a return, `process.on("exit")` covers `process.exit`, and handlers for
`SIGINT`/`SIGTERM`/`SIGHUP` cover an external `kill` — whose *default* disposition terminates
without emitting `exit` at all, which is the one path that would strand the user's shell in raw
mode. Verified against a scripted pty: killed mid-probe, the tty comes back `icanon`. Ctrl-C is
handled as a **byte** (`\x03`), not a signal, because raw mode is exactly what turns `ISIG` off.

#### `wide` forces the ASCII glyph tier — arithmetic, not taste

The tier section above says *"every Unicode substitute is exactly 1 column, so the tier has no
width impact and `chromeWidth` stays `3N+1`"*. **That is a narrow-measurement statement, and
under `wide` it is false for most of the set**: `•` (U+2022), `─` (U+2500) and the entire
box-drawing charset are themselves Ambiguous and measure 2. Only `◦`, `‣` and `✓` survive.

Two consequences, neither cosmetic and neither repairable in the allocator:

- **A table's border row cannot be made to fit.** A horizontal rule is one `─` per column of
  cell width, so the border row is exactly *twice* the content rows — and no allocation can
  shrink by its entire budget, so `allocateWidths` reports `fits: false` and the table is
  emitted at its minimum feasible width rather than as a wreck. Measured on
  `tests/fixtures/wide-table.md`: **160 columns at a target of 80, 200 at 100 — exactly 2×**,
  pinned in `tests/width.test.ts`. **WP-3 of `plans/tn-review-remediation.md` did not move these
  numbers and was not supposed to** — it closed the *padding* defect below, which is a
  measurement problem; this is a glyph-choice problem, and refusing the tier is the choice.
- **A substituted bullet widens its own item.** `substituteBullets` swaps `"* "` for `"• "`
  *after* the budget arithmetic ran on the source marker, so every unordered item is one column
  over budget per level.

Measured over the bundled corpus at all five sweep widths: **wide + Unicode = 35 overflows of 60
combos; wide + ASCII = 0.** So `resolveGlyphs` takes the ambiguous setting as a third argument
and returns ASCII whenever it is `wide` (`src/glyphs.ts:113`), **ahead of `--unicode` and
`MDVIEW_GLYPHS`** — because `--unicode` asserts a *capability* ("this terminal can draw these"),
which remains true and is simply not the constraint that binds. **`unicode × wide` is therefore
unreachable from the CLI.** An explicit `--unicode` overridden this way is named once on stderr
(`wideForcesAscii`, deliberately the *flag* only and not the env var: a flag going unmet is news
about this invocation; an exported variable would print on every render for the rest of that
shell's life). `MDVIEW_AMBIGUOUS=narrow` is the escape hatch.

`renderRule` divides the target by the rule glyph's *measured* width for the same reason —
`"─".repeat(targetWidth - 1)` is twice the document width in wide mode, which would put the
tool's own frontmatter divider over budget on every file that has one.

#### The residual, named rather than papered over — and then closed by owning the emitter

**The finding.** `cli-table3` bundled its own `string-width@4.2.3`, which has no
`ambiguousIsNarrow` option at all, so its cell padding could never honour wide mode. A cell
containing *k* ambiguous characters was padded *k* columns too wide, and since *k* varies cell by
cell within a column, **a table's right edge could be ragged by up to *k* columns**. This
paragraph used to end "not fixable from outside the library", and that was exactly right: it
padded to `colWidths` in its own units, so no amount of pre-padding, pre-wrapping or budget
adjustment on our side could make its count agree with ours per-cell. The capped
render/measure/reallocate loop that used to sit in `renderTable` absorbed only the **aggregate**
overage — which is why a table stayed inside the target while its edge stayed crooked, and why a
green width gate was never evidence about this.

**The fix, in WP-3 of `plans/tn-review-remediation.md`: stop being outside the library.**
`src/table.ts` emits its own borders, junctions, padding and alignment from the allocation
`allocateWidths` already produced, padding with the `Measure` it was handed — the same ruler the
allocation used and the same one `--check` grades the result with. The disagreement is not
repaired, it is **impossible by construction**; the retry loop, `MAX_FIT_PASSES` and
`maxRenderedWidth` are gone with it, and the rendered geometry now *equals* the allocated
geometry (`tests/table.test.ts` asserts that equality directly).

Measured over this repo's own 41 markdown files at six widths, both tiers, both ambiguous modes
— 984 renders:

| Combination | Rendered tables | Ragged before | Ragged after |
|---|---|---|---|
| narrow, either tier | 180 each | 0 | 0 |
| **wide + ASCII** (what the CLI produces) | 180 | **66** | **0** |
| wide + Unicode (unreachable; `wideForcesAscii`) | 180 | 180 | 180 |

Narrow-mode output is **byte-identical** across those 492 renders — 0 differing bytes — because
narrow measurement is where the two `string-width` majors happened to agree on this corpus, and
because the emitter reproduces the library's escape-sequence layout — one style wrap per *cell*,
not per line — and, at the time, `@colors/colors`' styling decision exactly rather than
approximately. (The *layout* is still reproduced; the *decision* is the resolved policy since
WP-2 of `plans/colour-policy.md`, and the two style pairs are committed literals in
`src/style.ts`.) It is *not* byte-identical in general: a
narrow-mode table carrying U+26A0 changes, and improves — that glyph is 1 column to
`string-width@4` and 2 to `@7`, which is the original reconciliation bug, and its edge went from
a spread of 3 to 0.

**`cli-table3` is gone from the tree entirely as of WP-6**, which removed the last thing
requiring it. The finding above is why `src/table.ts` stopped importing it; the dependency
removal is a separate fact and is recorded in the root `AGENTS.md`.

**Do not read this as "wide mode + Unicode tables now work."** They do not, and the row above
says so: `─` and the whole box-drawing set are themselves Ambiguous, a border row is still
exactly 2× the content rows, and that is still handled by refusing the tier.

#### The sweep keeps the two axes independent, on purpose

`scripts/sweep.ts` takes `--ambiguous narrow|wide` and **never** reads `MDVIEW_AMBIGUOUS`, never
consults the cache, and never probes. It is a corpus *measurement* instrument whose numbers are
compared against dated runs in the private archive; a baseline that changed ruler because of the
machine's `TERM`, or because someone once ran `mdview probe`, could not be compared to anything.
It also does **not** apply the wide-forces-ASCII rule, so `--ambiguous wide --glyphs unicode`
stays reachable — that combination is how the finding above was measured, and an instrument that
cannot reproduce a finding is not an instrument. It prints a NOTE saying the CLI never produces
that combination.

`--check` is the other way round and for the opposite reason: it honours the env var and the
cache (it just never probes), because its whole claim is "the renderer hit the budget it was
given". A check measured with a different ruler than the allocation used is asserting something
else entirely.

#### What the orchestrator cannot verify

The probe's *arithmetic*, cleanup, timeout, interrupt and cache behaviour are covered by
`tests/width.test.ts` against a scripted terminal double, and end-to-end against a scripted pty.
**What no test here can establish is what a real terminal answers.** The user runs urxvt and
ghostty-inside-zellij; run `mdview probe` in each and read the `ambiguous width` line. Nothing in
this repo may claim those pass.

### Rendering policy

- **Fenced code is never rewritten.** Blocks pass through verbatim at whatever width they are,
  and `--check` skips lines inside them. This is deliberate: the corpus's fences are gate
  commands meant to be pasted, and a wrapped command is a wrong command. The trade is that
  `--check` guarantees "no non-code line exceeds the width", not "no line at all".

  **"Never" is unqualified, and a fence nested inside another block is the case that keeps
  testing it** — WP-2 rewrote one inside a list item, WP-2f found a second pass doing the same,
  and WP-2g a third doing it to a fence inside a *blockquote* (**all three shipped fully green,
  because the exemption that makes fences safe from width gates also makes them invisible to
  width gates**). Such a line **overflows** rather than wrapping, exactly like a fence anywhere
  else; it stays inside a recorded `codeRange` and therefore stays exempt. Any pass that
  rewrites already-rendered output needs the sentinel walk before it touches a line — there are
  **five** of them, and the strictness each needs is not the same. See "Why a sentinel walk
  exists at all" above for the list, and the parity section for the channel that *can* see the
  damage when one is missing.
- **Nothing is ever ellipsized.** Long tokens are hard-split at grapheme boundaries and rejoin
  losslessly. If a change can emit `…`, it is wrong.
- **Unknown fence languages degrade silently.** `src/lang.ts` maps aliases
  (`dataviewjs`→`javascript`, `dataview`→`sql` — Dataview's query language is SQL-like and
  highlights acceptably), then falls back to `plaintext` for anything `supportsLanguage()`
  rejects. Without this, highlight.js writes `Could not find the language 'x'` to **stderr, once
  per fence** — 280 `dataviewjs` fences in the vault, its largest fence category.

  **The highlighting path is dead under every test and gate, and that is a property of the
  colour decision rather than of a library.** `highlightCode` (`src/blocks.ts`) returns the raw,
  unstyled code whenever `ctx.sgr` is not `"full"` — i.e. whenever the resolved policy
  (`src/colour.ts`) says so, which is every non-TTY run with nothing forced: `bun test`,
  `--check`, both sweeps, CI. **The gate narrowed from `ctx.color` at WP-2 of
  `plans/colour-modes.md`** (Decision 3, "Three levels, not two" above): the format-preserving
  `formats` mode takes this same dark branch, so `--color=never` no longer reaches the
  highlighter at all. It **used** to be the same gate the library's `highlight()`
  applied at `index.js:591` (`chalk.level === 0`); WP-1 of `plans/colour-policy.md` made the two
  able to disagree — `cli-highlight` was still reading its own `chalk`'s module-load level while
  this read the policy, so `--color=always` on a pipe took the styled branch *and* got an
  unstyled highlighter — and WP-2 removed that package, so `ctx.color` is the only gate on this
  path again. The `try`/`catch` is **not** dead, and the older claim that highlight.js "logs
  rather than throws" is only half right: on a language it does not know it logs through
  `console.error` **and then throws**, which is the branch that applies flat `chalk.yellow`.
  `src/lang.ts` normalises every fence language so a real document never reaches it;
  `tests/helpers/block-parity.ts`'s `unresolvable language` case reaches it deliberately, and
  `tests/blocks.test.ts` captures and asserts the message. **Exercising the styled path still
  requires a `full` policy** — every gate `verify` runs is colour-off, and `formats` is not
  colour-on for this producer — but it no longer requires a subprocess: an injected
  `{ sgr: "full" }` is enough now that no library resolves colour at module load. That is the same shape of trap as the fence exemption, one step less
  hidden: a gate that passes because the code under it never ran.
- **The viewer never narrates parser internals to stderr.** `yaml` reports recoverable oddities
  through `process.emitWarning`, which no `try`/`catch` can intercept, so Node's default handler
  prints a ~15-line stack trace. Obsidian templates trigger it (`created: {{today}}` parses as a
  flow mapping used as a key). `formatMetaBlock` passes `logLevel: "error"` — **not
  `"silent"`**, which also suppresses errors and would let `title: [unterminated` come back
  silently guessed as `["unterminated"]` instead of throwing and being shown raw. Verified
  value-neutral over 43,047 frontmatter blocks across every corpus: identical parse result or
  identical throw, every one.
- **Obsidian embeds** (`![[target]]`) render as `embed: target`. Previously the `!` leaked
  through as literal text next to the link (1,350 occurrences in the vault).
- **Frontmatter is followed by a rule** at the tier's rule character, matching the document's own
  `hr` rendering exactly — both come from `renderRule()` in `render.ts`, which is deliberately
  the only place a rule is computed. **Rules are `targetWidth - 1` characters wide**, and that
  off-by-one is reproduced on purpose: the library's `hr` helper (`index.js:612`) built them
  with `new Array(length).join(str)`, which yields `length - 1`, and `src/blocks.ts`'s
  `renderHr` reproduces it rather than inheriting it. **Match it, don't "fix" it**, or the
  divider and the document's own rules disagree by one column. (The repeat count is a *column*
  count divided by the glyph's measured width — see `renderRule` and the wide-mode section
  above.)
- **Known limitation:** a markdown table nested *inside* a list item is re-wrapped as prose and
  its box drawing is mangled. The table renderer sizes to the budget it is handed and has no
  knowledge of what a later pass will do to its rows. There are zero instances in the corpus
  (verified), so this is unfixed by choice rather than oversight.
- **Known limitation — many-column tables exceed the target width.** Each column has a minimum
  content width; below that a cell is unreadable. Once a table has enough columns, that floor
  times the column count already exceeds the target and the allocator has nowhere left to shrink:

  | Columns | Target | Rendered | Arithmetic |
  |---|---|---|---|
  | 9 | 80 | 82 | 9 × (6 + 2 padding) + 10 borders |
  | 19 | 100 | 153 | 19 × (6 + 2 padding) + 20 borders |

  **This is arithmetic, not a bug to be fixed in the allocator** — a 19-column table cannot be
  rendered in 100 columns. Any "fix" is a choice of *degradation* (drop cell padding, transpose
  to a record-per-row layout, or overflow deliberately), and each trades away something the tool
  currently guarantees. Incidence is a few thousandths of a percent of full-corpus combos — the
  dated counts live in the private archive's `measurements/`, not here — so the choice has been
  deferred rather than made. If you do fix it, note that dropping padding only buys 2 columns
  each and does not rescue the 19-column case.
- `.gitignore` is assembled from the chunk files the in-house scaffolding skill ships;
  repo-local entries go under the `# --- project-specific ---` marker. **`bun.lock` is now
  tracked** (decided at WP-6b). It was ignored globally by the parent mono-repo's root
  `.gitignore` while this was a subfolder; extraction dropped that file, and the rule was
  restated locally (WP-6a) purely to keep the tracked set unchanged across the split — that
  restatement was never itself a decision to keep ignoring it going forward. **Pinning direct
  dependencies (WP-5) does not reach the transitive tree** — `highlight.js@10.7.3` was the
  example, pulled in transitively via `cli-highlight`, two majors stale and free to drift on a
  fresh `bun install` on a different machine with no lockfile to hold it. (It is a *direct*
  pin since WP-2 of `plans/colour-policy.md`, so that particular package is now held twice;
  the rule it illustrates is unchanged and still applies to everything below the top level.)
  And a published
  application should ship the lockfile that was actually tested against, not trust every future
  clone to re-resolve the same transitive tree. The `.gitignore` rule and its old explanatory
  comment are removed; the lockfile is committed like any other tracked file from here on.

### The `emoji` re-decision

*Continues the root `AGENTS.md`'s "Dependencies (WP-5)" section, which owns the pins and the
declaration rules; this half lives here because it is about the renderer's behaviour.*

**`emoji` stays on by default — re-decided 2026-07-29, and the reason to turn it off turned out
not to exist.** The `:shortcode:` → emoji-glyph pass is `insertEmojis`/`emojify`
(`src/inline.ts` since WP-2, transcribed from `index.js:604-611`; `node-emoji` is a direct
dependency now rather than a transitive one). It was investigated once before (2026-07-28) and
rejected on 392 prose shortcodes across 59 files — but that test was a throwaway subagent
invocation nothing in the repo could re-run, and its 59 files were reachable **only** by
following symlinked subtrees the corpus was never meant to include. That is a
corpus-*membership* bug (`plans/corpus-symlink-membership.md`, WP-1/WP-2), not a property of the
user's real documents, and it has since been fixed by adding the two roots that actually matter
as **explicit** corpus members instead of symlink-following into everything reachable.

The test itself is now committed: `scripts/emoji-audit.ts` (repointed at `renderDocument` in
WP-6, since there is no library extension left to construct). Method, unchanged and
non-negotiable: render each candidate token twice, `emoji` on vs off, and keep only tokens whose
rendered bytes actually *differ* — a behavioural test, never a `node-emoji` lookup, so it cannot
drift from what the renderer really substitutes. Fence-aware, because the `code` renderer never
applies `transform`, and table-aware for the identical reason: `renderTable` (`src/table.ts`)
never dispatches inline tokens either, so a shortcode inside a table cell is inert *here*
regardless of the `emoji` value. Both exemptions are verified per token, against the real
renderer, not assumed.

**Re-run over the corrected corpus (~44.7k files, unsampled, explicit roots, no
symlink-following): zero authored prose shortcodes in the user's own documents.** The only hits
anywhere — 10 tokens across 2 files — sit inside third-party repositories cloned for reference
into one research-collection root, each its own separate `.git` checkout (an open-source CLI's
changelog and an agent-persona doc from a cloned agent-collection repo). That is vendored
material the user did not author, and vendored content is not grounds to keep this on. (A third
cloned repo in the same root carries two more shortcode-shaped tokens, but they sit in a table
cell and are inert by construction either way — not counted as prose.) Every other root —
including a personal notes archive of ~44k files, scanned in full, not sampled — shows **0**
prose shortcodes; the only occurrences elsewhere are already-fenced and already inert (matching
the original 19-fenced-hit finding, now reproduced against a corpus with two more roots in it).

**The ~468 KB figure was asserted, never measured, and does not hold up.** Compiling both ways
(`bun build --compile`) and diffing the resulting binaries shows a delta in the tens of bytes on
a ~102 MB binary — noise, not savings, and two orders of magnitude smaller than claimed. `emoji`
is a *runtime* value read by the substitution pass, not a build-time flag; `bun build --compile`
bundles the whole dependency closure regardless of which branch a runtime value takes, so there
was never a binary-size case for this either way.

**That is what settles it, and it is worth being precise about the shape of the argument.** The
corpus evidence above establishes only that turning substitution off would be *harmless on
today's corpus* — an absence of harm, not a benefit. With the binary saving gone there is no
benefit left to weigh against it, and a change with no upside is not a change. The positive case
runs the other way: in a modern terminal the default expectation is that `:rocket:` renders as a
glyph, and the planned GitHub-README corpus (`README.md` files are dense with shortcodes) is
about to make that the common case rather than the rare one.

**The real conclusion is that this does not belong in a constant at all.** Substitution is a
*terminal capability* question, so it follows the glyph tier the tool already models:
`--unicode` renders glyphs, `--ascii` cannot and must leave the literal shortcode, with a
user-config override.

**That work landed in WP-11 of `plans/representative-corpus.md`.** `emoji` is
`emojiOverride ?? (glyphs.tier === "unicode")` (`src/render.ts`), threaded from
`MdviewConfig.emoji` (`src/config.ts`), so config can force either direction regardless of tier.

**The hazard that value guarded against was three-way, then two-way, and is now one-way.** There
used to be *three* library constructions per render — a main one plus two per-budget caches,
built because width was taken only at construction — and forgetting to pass `emoji` to either
cache would have made substitution depend on whether a paragraph happened to sit inside a list
item. WP-3 deleted both caches and WP-6 deleted the last construction, so the value is computed
**once** and has exactly one consumer: the `LayoutContext`. **There are zero constructions now**;
the invariant is held by construction rather than by remembering to pass an option three times.
Pinned in `tests/render.test.ts`'s emoji-tier describe block.

The measured defect went with it: the stray space the substitution appends (`emojiSign + ' '`,
never in the source, surviving as trailing whitespace at end of paragraph, heading or list item
and therefore changing rendered width — the one thing this tool exists to control) is stripped
once, uniformly, by `stripEmojiTrailingSpace`, **fence-aware via `codeRanges`** so a literal
emoji-then-space the user actually typed inside a fence survives. It must not *also* be stripped
in `insertEmojis`, or it is stripped twice and the result is not what the library produced. The
implemented predicate is deliberately a **superset** of that rule — it strips a single
end-of-line space after any `Extended_Pictographic` character without proving the glyph came
from substitution — which is measured, intentional, and strictly narrows rendered width rather
than widening it.

Shortcodes inside fences stay literal regardless, because the `code` renderer never runs
`transform` — in `src/blocks.ts` as in the library it was transcribed from — so no special case
was needed for them. Shortcodes inside a **code span** stay literal for a different reason
entirely, and it is the one WP-6 expected to delete and could not: see `COLON_REPLACER` above.

**Corollary, corrected:** the file count from the prior measurement stands (12,363, re-measured
12,385 a day later — corpus drift, not a method error), but the characterisation "real user
markdown that no gate in this repo has ever rendered" does not: composition of that
symlink-reachable set is **~73% agent scratch directories and third-party package caches**,
reachable only because a tracked root symlinks into a home directory, and formally out of this
corpus's scope (`plans/corpus-symlink-membership.md`, "Decisions locked"). The remaining
plausibly-real markdown in that set was not pulled in by following symlinks — it was added
properly, as the two explicit roots this section now measures against. Any "verified across the
whole corpus" claim made before 2026-07-29 still carries the hole that the swept corpus was
missing those two roots; it does not carry a hole shaped like "12,363 files of real markdown no
gate has ever rendered," because most of that set was never real markdown in the first place.
The glyph-tier work above has since superseded the old pins: see `tests/render.test.ts`'s
emoji-tier describe block for the behaviour now asserted per tier, including the trailing-space
defect those pins had only recorded.
