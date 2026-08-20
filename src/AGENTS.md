# mdview — `src/`

Renderer internals for the `mdview` command: **what the owned renderer must do and the
measured defect that established each requirement**, the sentinels, the task-state surface,
the glyph tier, the command-line surface, the rendering policy, the parity classes, and the
`emoji` re-decision. **The root `AGENTS.md` is the parent document — read it first**;
identity, the two-names decision, the Stack, the Layout tree, the Run/verify contract,
Conventions and the live dependency rules live there.

**Four deep records moved out of this file at WP-4 of `plans/docs-and-memory-curation.md`**
— the list pipeline, the wiki-link carrier defect, colour, and ambiguous width — into
`docs/agents/`, indexed below. They are **on-demand reads with no `CLAUDE.md` symlink**, on
purpose: a session editing `src/` loads this contract every time and opens a reference file
only when it is working on that subsystem. Nothing was rewritten in the move, every section
title is unchanged, and each moved section leaves a pointer where it used to be.

| Section | What it settles |
|---|---|
| How to read this file | the two conventions, including what a `index.js:NNN` citation means |
| Why the renderer is owned at all | the three structural facts and what the removal measured |
| What each renderer method must do | the requirement table, and the four unassigned methods |
| The walk is this repo's | what `Parser` was doing, what `marked.use()` supplied, and why owning the walk was the only way past the `=> string` interface |
| Parity: four classes | A/B/C/D, and why class C is a content hash rather than a gate |
| The sentinels | two control characters, one literal, the retired wiki-link carrier pair, and why the walks differ |
| The task-state pre-pass | the 84 lines it still corrupts, why the "indented code" follow-up is retired, and the re-tokenisation that blocks its removal |
| Colourless gates cannot see colour-only defects | three measurements, one mechanism, the rule it earns, and the WP-3 closure (`charDiff` 31 → 0) |
| Glyph tier | the tier, and the precedence that puts resolved `wide` above every flag |
| Command-line surface | the CLI shape, the config asymmetry, and the resolver-as-value |
| Rendering policy · The `emoji` re-decision | the unqualified rules, and the tier-follows decision |

**The reference files — read the one you are working in.**

| File | Carries |
|---|---|
| `docs/agents/list-pipeline.md` | composition, the two wrap paths, the de-drift, the claim domains, and the retained passes |
| `docs/agents/wiki-link-record.md` | the wiki-link carrier defect and its fix: context table, precedence matrix, the three further defects, the three failed fix designs, and witness ownership |
| `docs/agents/colour.md` | the one owned colour/hyperlink decision, `SgrMode`'s three levels, the reader inventory, and the resolution history |
| `docs/agents/ambiguous-width.md` | the ambiguous-width question, the probe and its cache identity, why `wide` forces ASCII, and the table-emitter residual |
| `docs/agents/dependency-history.md` | the forensic record of every dependency removal (the live rules are the root `AGENTS.md`'s) |
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

**What `Parser` was doing, and why the walk was taken — merged in from the root `AGENTS.md`'s
Stack bullet at WP-4 of `plans/docs-and-memory-curation.md`.** The root told this story a
second time and at more length than a Stack bullet can carry; it is relocated here whole, so
this section is the one owning home, and the root keeps a three-line summary and a pointer.
Read it as history, in the same register as this file's `index.js:NNN` citations.

*What was true.* `src/render.ts` called `instance.use({ renderer })` and then
`instance.parse(processedBody, { async: false })`, so **marked's `Parser` was the tree
walker** and the sixteen owned methods were callbacks it invoked, re-entering it **9 times**
via `this.parser.parse(tokens, top)` and `this.parser.parseInline(tokens)`. **`Parser` was
not a bare dispatcher**, and a plan that assumed it was got that wrong twice: it coalesces
consecutive block `text` tokens with `\n`, consuming the loop index, and at `top` wraps the
result in a **synthesized `paragraph` token** whose `tokens` array is fabricated; it routes
`escape` to `renderer.text`; `space` had no owned method and fell through to marked's
default (`''`); an unknown type **throws**; `parseInline` takes an optional renderer
override; and `marked.use()` bound the receiver — the source of `this.parser` — fell back to
the previous renderer on a `false` return, and coerced every falsy return to `''`.

*What replaced it, and why.* `src/walk.ts`'s `TokenWalker` reproduces that whole contract —
see its header table, which cites every `marked.cjs` site, and `tests/walk.test.ts`, which
tests each row directly plus a 32-case differential against `Parser` itself. `render.ts` now
calls `instance.lexer(...)` for tokens and `walker.parse(...)` for the walk. **The reason is
a hard interface constraint that only walk ownership could remove**: marked's renderer
callbacks are typed `=> string` (`marked.d.ts:349-365`, `parseInline` at `:226`/`:234`), so
**a callback cannot return anything but a string** — no styled spans, no source ranges — and
any work that needs a richer return type (the style-last direction, or
`docs/adr/0001-editor-path.md`'s `{text, style, sourceStart, sourceEnd}`) was blocked behind
it. The lexer is the part worth keeping and was kept untouched. **The method signatures are
still `=> string`**: that package changed who calls them, nothing else, and landed
byte-identical across 440 combos in both colour modes. Widening the return type is the
successor's.

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

### The list pipeline — moved to `docs/agents/list-pipeline.md`

**The whole record is `docs/agents/list-pipeline.md`**, moved there at WP-4 of
`plans/docs-and-memory-curation.md` with every section title unchanged: "Composition pushes
the item's **exact** marker width, per item", "Loose items are wrapped by `paragraph`, at
the item's own budget", "Tight items are parsed by `text` — and wrapped on **two different
paths**" (including "The two paths guard differently"), "A nested item's continuations are
pulled back to their own item, per level", "The claim decision: ANSI-stripped for prose,
**raw bytes for fence lines**", "`rewrapListBody` — the primary wrap for uncoalesced tight
items", "The retained passes, and why each is retained", "A blockquote owes columns exactly
like a list, and half the defect was ours", and "Ordered numbering, and two deliberate
non-changes". Four defects, one theme: *a line has to be laid out at the width it will
actually occupy, and only composition knows that width.*

### The sentinels — two control characters, and one literal that is not a defect

**Three carriers, not five** (this section said "five carriers, not three" until WP-2 of
`plans/wiki-link-tokenizer.md` (`ab3518e`) retired the wiki-link pair — **recount when you
add or retire one**). Two are control characters stripped from the final output; the third
is a literal string that round-trips within a render. All of them exist because something
downstream would otherwise misread the text.

| Carrier | Code point / spelling | Purpose |
|---|---|---|
| `SENTINEL` | 0 | Brackets fenced-code output so `--check` and the sweeps can record `codeRanges` and exempt them |
| `TASK_STATE_SENTINEL` | 1 | Sits between `[` and the state char so `marked`'s GFM tasklist regex (`/^\[[ xX]\] /`) does not reclaim the item and rebuild it |
| `COLON_REPLACER` | the literal `*#COLON\|*` | `codespan` replaces every `:` in a code span with it; `undoColon` restores them after emoji substitution has run |

**A fourth carrier retired without replacement, and here is its provenance.**
`WIKI_LINK_OPEN`/`WIKI_LINK_CLOSE` — control code points 2 and 3 — marked a wiki-link
label's boundaries through the lexer and the walk so a post-walk pass could style it under
the resolved policy, from WP-4 of `plans/colour-policy.md` (which introduced the pair to
replace `styleWikiLink`'s hardcoded pre-lexer SGR) until WP-2 of
`plans/wiki-link-tokenizer.md` retired the whole mechanism: wiki-link recognition is now an
**inline tokenizer extension** (`wikiLinkExtension`, `src/wikilink.ts`) inside marked's own
lexing pass, so a label is styled at emission — `styleWikiLabel` over the shared
`applyStyleChain` (`src/style.ts`) — with nothing left to carry between the source and the
walk. Code points 2 and 3 now mean **nothing** to this renderer and pass through as content
(grant C4; see "The wiki-link carrier defect" — `docs/agents/wiki-link-record.md`, pointed
at below — for the full record and its closure).
Code points 0 and 1 keep their strips — they still have internal meaning.

The two control characters are control characters, not zero-width Unicode, **deliberately**:
the ASCII tier exists for terminals that cannot render UTF-8, so an "invisible" U+200B in
that path would be three bytes of exactly the thing the tier avoids — and every gate here
measures display *width*, not code points, so nothing would have caught it. Both are
stripped from the source before lexing (so a hostile or odd document cannot forge a range
or a defeated regex) and from the rendered output before it reaches the terminal.

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

#### The wiki-link carrier defect — moved to `docs/agents/wiki-link-record.md`

**The whole record is `docs/agents/wiki-link-record.md`**, moved there at WP-4 of
`plans/docs-and-memory-curation.md` with every section title unchanged: "The wiki-link
carrier defect — fixed, WP-2 of `plans/wiki-link-tokenizer.md` (`ab3518e`)" and its
re-verified context table, "The surface was wider than verbatim contexts: the precedence
matrix", "Three further defects the same mechanism caused" (C5's OSC-8 repair, C6a's cell
bleed, C6b's normalization), the three failed fix designs, C4's authored-2/3 pass-through,
D4's GFM pipe rule, and "Witness ownership — which tests fence what". The root `AGENTS.md`'s
own paragraph on the carrier's retirement is merged into that file too, so it is the one
owning home. **The live carrier census stays above**, in "The sentinels": three carriers,
not five; code points 2 and 3 mean nothing to this renderer now, 0 and 1 still strip.

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
everything — see `docs/agents/ambiguous-width.md`) → `--ascii` / `--unicode` (mutually
exclusive; passing both throws) →
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
the CLI. See "`wide` forces the ASCII glyph tier" (`docs/agents/ambiguous-width.md`) for the
arithmetic.

Bullet substitution runs **once, at the outermost list** (`listDepth() === 1`), reading depth
back out of the line's own indentation. Owning composition removed the *original* reason for
that restriction — it is no longer racing marker detection for ancestors still on the stack —
but three independent blockers keep the pass where it is; they are in the retained-passes table
(`docs/agents/list-pipeline.md`, "The retained passes, and why each is retained"). The pass
skips any line that *starts* inside a `SENTINEL` region, and matches the marker
**only on the four-column grid** (WP-2f), because the post-compose wrap runs before it and can
put an author's own bare `*` at the start of a continuation line.

### Command-line surface (WP-4)

```
mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--color[=WHEN]] [--no-color] [--plain] [--hyperlinks[=WHEN]] [--probe] [--help] [--licenses]
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
point on the `auto`/`always`/`never` scale the other two flags share; see "Colour: one owned
decision, resolved from inputs handed in" (`docs/agents/colour.md`) for what it does at the
CLI boundary, which is the part that is not just flag parsing.

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
omitting the key. It is the fifth slot in the precedence table in `docs/agents/colour.md`, so it
loses to anything said about this invocation. `hyperlinks` (WP-3 of `plans/colour-modes.md`)
sits beside it, read the identical way through the same `parseColourDirective`, and is its own
independent axis rather than a second reading of `color` — see `docs/agents/colour.md` for its
own precedence slot.

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

### Colour: one owned decision — moved to `docs/agents/colour.md`

**The whole record is `docs/agents/colour.md`**, moved there at WP-4 of
`plans/docs-and-memory-curation.md` with every section title unchanged: "Colour: one owned
decision, resolved from inputs handed in" (`resolveColourPolicy`, `src/colour.ts`, the
ratified precedence, the hyperlink axis's own ladder, and `--plain`'s CLI-boundary
short-circuit), "Three levels, not two: `SgrMode` and the hue/format split", and "The reader
inventory, with each reader's threshold" — which is where Decision 3's named producer
exception for fenced-code highlighting is enumerated. **What stays here**: "Colourless gates
cannot see colour-only defects" and its WP-3 closure, above, and the rendering policy's own
highlighting-path entry, below. The packages that used to make this decision are
`docs/agents/dependency-history.md`.

### Ambiguous width (WP-3) — moved to `docs/agents/ambiguous-width.md`

**The whole record is `docs/agents/ambiguous-width.md`**, moved there at WP-4 of
`plans/docs-and-memory-curation.md` with every section title unchanged: "Ambiguous width
(WP-3)" (`src/width.ts` as the only importer of `string-width`, and the threaded `Measure`),
"The mode is threaded, exactly like `GlyphSet`, and for the same stated reason", "Resolution
order (highest first)" with the probe, the over-specified cache key and the five-terminal
validation table, "`wide` forces the ASCII glyph tier — arithmetic, not taste", "The
residual, named rather than papered over — and then closed by owning the emitter" (the
`cli-table3` padding defect and the table emitter that made it impossible by construction),
"The sweep keeps the two axes independent, on purpose", and "What the orchestrator cannot
verify". **The glyph tier itself stays above** — its precedence rule's top slot, resolved
`wide`, is the arithmetic in that file.

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
  `plans/colour-modes.md`** (Decision 3, "Three levels, not two", `docs/agents/colour.md`): the
  format-preserving
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
  count divided by the glyph's measured width — see `renderRule` and "`wide` forces the ASCII
  glyph tier" in `docs/agents/ambiguous-width.md`.)
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
corpus-*membership* bug (`plans/corpus-symlink-membership.md`, WP-1/WP-2 — closed
won't-implement and deleted at `e4ce368`), not a property of the
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
corpus's scope (`plans/corpus-symlink-membership.md`, "Decisions locked" — closed
won't-implement and deleted at `e4ce368`). The remaining
plausibly-real markdown in that set was not pulled in by following symlinks — it was added
properly, as the two explicit roots this section now measures against. Any "verified across the
whole corpus" claim made before 2026-07-29 still carries the hole that the swept corpus was
missing those two roots; it does not carry a hole shaped like "12,363 files of real markdown no
gate has ever rendered," because most of that set was never real markdown in the first place.
The glyph-tier work above has since superseded the old pins: see `tests/render.test.ts`'s
emoji-tier describe block for the behaviour now asserted per tier, including the trailing-space
defect those pins had only recorded.
