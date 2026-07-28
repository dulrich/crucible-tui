# mdview

Terminal markdown viewer for this repo's plans, execution briefs, and `INITIATIVE.md`
files: renders frontmatter as a metadata block and wraps wide tables losslessly instead
of overflowing or truncating them.

## Stack

- Bun + TypeScript, single flat package (no workspaces).
- `marked` (lexer) + `marked-terminal` (prose/list/code rendering) with a custom
  table renderer (`src/table.ts`, added in WP-3) — `marked-terminal` never passes
  terminal width to tables and drops `token.align` entirely.
- `yaml` for frontmatter parsing, `cli-table3` for table layout, `string-width` for
  CJK/emoji-correct column measurement.
- **Bun/TypeScript over the `project-setup` skill's Rust default (Gate 2)** — recorded
  per that gate's "record every choice" rule. Justification: `marked@^14` is already
  pinned fleet-wide (`example_tracker/apps/web`); the wiki-link and task-state
  markdown logic this tool needs already exists in TypeScript
  (`example_tracker/apps/web/src/markdown.ts`); `example_home` — the only other
  CLI-only tool in this repo — is TypeScript; and a working prototype in this stack
  was measured against the corpus before the plan was written.

## Layout

```text
src/cli.ts          arg parsing, width resolution, pager, --check, glyph flags
src/render.ts       marked/marked-terminal wiring + renderer overrides
src/frontmatter.ts  YAML split and metadata block formatting
src/table.ts        the wide-table allocator — the reason the tool exists
src/wrap.ts         ANSI-safe prose wrapping for what marked-terminal won't
src/glyphs.ts       Unicode/ASCII capability tier — the only module that reads env
src/lang.ts         fence-language alias map + supportsLanguage() fallback
src/config.ts       XDG config load + corpus-manifest path resolution
src/detectors.ts    orphan / continuation-over-indent detectors (see below)
corpus/             the bundled public-safe default manifest
scripts/sweep.ts    multi-corpus width sweep (see "Corpus sweep" below)
tests/              unit tests + markdown fixtures
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
| `paragraph`, inside a list | Every item of a **loose** list is a paragraph token dispatched through this override, so it — not `list` — is where that item's text gets wrapped. See below |
| `text`, inside a list | Every item of a **tight** list arrives here instead, as a raw block text token still carrying the author's own line breaks. See below |

#### Loose list items are wrapped by `paragraph`, at the item's own budget

`marked`'s lexer stamps `loose = true` on a whole list if any item ends with a blank
line, and each loose item is then parsed into a paragraph token. So a loose item's text
is wrapped by the `paragraph` override, **before** `list` glues on the item's marker and
its blanket indent. Wrapping it at the full target width there is what produced the
orphaned-line defect: the text came back 6+ columns over budget and `rewrapListBody`
reflowed it a second time, shearing the tail word onto a line of its own.

The rule, therefore: **inside a list, `paragraph` wraps at the width the item will
actually occupy**, not at the target width. `src/render.ts` keeps a stack of the columns
each enclosing block renderer still owes (a list level's marker plus its 4-column indent;
a blockquote's indent) and renders the item through a `marked-terminal` renderer built at
`targetWidth` minus that sum. `rewrapListBody` then finds every line already in budget
and its pass is the no-op it documents itself as.

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
bun install --cwd mdview
bun run --cwd mdview typecheck
bun run --cwd mdview lint
bun test mdview/tests
bun run mdview/src/cli.ts --check --width 80 mdview/tests/fixtures/wide-table.md
bun run --cwd mdview sweep
bun run --cwd mdview sweep -- --glyphs ascii
```

**Flag order matters.** `bun run --cwd <dir> <script>` works; `bun --cwd <dir> run
<script>` does **not** — on Bun 1.3.11 it prints `bun run`'s help text and **exits 0**,
i.e. it silently passes without executing the script. Verified reproducible against
`example_radar` too, so it is a Bun CLI behavior, not a quirk of this package. Never
write the second form into a gate: it is a gate that can never fail.

The `--check` gate is the CLI's own self-smoke: it renders with no pager and exits
non-zero if any output line exceeds the target width. All **seven** gates are binding
and must exit 0.

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
bun run --cwd mdview sweep                                   # unicode tier, resolved manifest
bun run --cwd mdview sweep -- --glyphs ascii                 # ascii tier
bun run --cwd mdview sweep -- --corpus <name> --all          # one corpus, full (no sampling)
bun run --cwd mdview sweep -- --manifest path/to/manifest.json  # override resolution
```

Each corpus in a manifest may set a `sample` (positive integer): if set, that corpus is
stride-sampled to that many files unless `--all` is passed; `--limit` overrides the
manifest's value. A corpus with no `sample` always sweeps every file it resolves.

Expected: `overflow=0 errors=0` on every corpus, **both tiers**. The sweep is what caught
the list-item reflow defect the fixture gate missed — `wide-table.md` has no long
bullets, so it stayed green while 250 of 256 real files overflowed.

**The corpora are the user's real data. Open them read-only; never write to them.**

#### The real validation corpus is private, and lives in `example-harness`

The manifest that actually exercises this tool against ~44.5k real files — an Obsidian
vault, research reports, every tracked initiative's docs — is generated and committed in
the separate `example-harness` repo's `example-corpus/` directory: `README.md`
(provenance), `scripts/gen-manifest.ts` (the generator, re-runnable against the
initiative tracker), `manifest.json` (its output), `measurements/` (dated full-corpus
runs), and `validity-memo.md` (what a green sweep does and does not prove). Point
`MDVIEW_CORPUS_MANIFEST` at that repo's `manifest.json` to reproduce those runs; see that
repo for every measured file count, date, and commit — none of that belongs here, since
this file ships to a public clone with none of it.

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
that class. Two detectors, both width-blind by design where the width is not the point:

| Detector | Finds |
|---|---|
| `findListOrphans(rendered, width)` | a line in a list item with <= 2 words, after a nearly-full line, followed by more prose in the same item |
| `findContinuationOverIndent(rendered)` | a continuation line indented past **its own item's** text column |

Four things about this module are load-bearing:

- **`findContinuationOverIndent` reports two classes it cannot tell apart, and its
  residual is not a to-do list.** It compares a line's column against its own item's
  text column, so a block that is *legitimately* indented past that column reads as a
  hit: a blockquote or a fence inside a list item, indented by its own renderer's
  `this.tab`. Those are correct renderings and the re-alignment pass deliberately leaves
  them alone. A second, genuine class also survives it — a list nested inside a
  **blockquote**, where `Renderer.prototype.blockquote`'s `indentify(this.tab,
  quote.trim())` strips the rendered list's indent from only its *first* line and then
  re-adds four columns to every line, leaving the first item's marker four columns left
  of where its own continuations land. Different mechanism, different fix, and not the
  list override's to make. **Read a non-zero count here before assuming a regression.**
- **`findListOrphans` is history.** It is the metric every number WP-2, WP-2b and WP-2c
  recorded was measured with, moved here from `tests/render.test.ts` unchanged. Editing
  its body silently invalidates every dated figure in the private archive's
  `measurements/`, and since the numbers only go down, a drift **looks exactly like a
  fix**. Add a detector; do not loosen this one. The move was verified against 58
  aggregate metrics and every per-file corpus count, byte-identical either side.
- **The fenced-code exemption is opt-in.** Both detectors take an optional `codeRanges`
  and honour it, because fences are never rewritten and their shape is not ours to
  guarantee — the same reason the width gates exempt them. It defaults to *off* because
  turning it on changes `findListOrphans`' historical counts. New callers pass it.
- **`--detect` is off by default and that is not timidity.** The two bundled sweeps'
  contract is `overflow=0 errors=0`; the detectors measure a class that is still partly
  open — `rewrapListBody`'s missing sentinel-awareness, the blockquote case above, and
  the two metric blind spots the orphan detector documents — so switching them on by
  default would turn both gates red for known, tracked reasons and destroy their value
  as a signal.

##### The fast tier: few notes, every width

The full sweep is many files × five widths. The fast tier inverts both axes — a frozen set
of ~50 real notes that have actually failed, rendered at **every** width in a range:

```bash
MDVIEW_CORPUS_MANIFEST=<regressions manifest> \
  bun run --cwd mdview sweep -- --corpus regressions --widths 40-360 --detect
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
its index, and the current threshold values live in the private `example-harness` archive —
a public clone has no regression corpus and no thresholds to pin.

Run verification from `mdview/`, **not the repo root** — the root resolves a different
`string-width` and gives false readings.

To render a file interactively:

```bash
bun run mdview/src/cli.ts some/plan.md
```

## Conventions

- `src/cli.ts` exports `main(args = Bun.argv.slice(2))` so tests call it directly
  without a subprocess, matching `example_home/scripts/render-config.ts`.
- No shebang on `src/cli.ts`; it is invoked as `bun run mdview/src/cli.ts`, matching
  every other standalone `.ts` entry point in this repo.
- No `INITIATIVE.md` or `FEEDBACK.md` for this tool — `example_home` has neither;
  `FEEDBACK.md` is user-owned and must never be agent-created.
- `bun build --compile` (the `build` script) produces a **standalone compiled
  binary** — a new pattern for this repo, where every other `bun build` produces a
  bundle. It is ~102 MB (the Bun runtime is embedded) and gitignored via `dist/`.

  **The binary does not track source. It must be rebuilt after any source edit:**

  ```bash
  bun run --cwd mdview build
  ```

  PATH install (already in place; `~/.local/bin` precedes `/usr/local/bin` on PATH):

  ```bash
  ln -sfn "$PWD/mdview/dist/mdview" ~/.local/bin/mdview         # from the repo root
  ```

  The symlink points at the build output, so a rebuild takes effect immediately — but
  editing source without rebuilding leaves `mdview` silently running the old code.

### Rendering policy

- **Fenced code is never rewritten.** Blocks pass through verbatim at whatever width
  they are, and `--check` skips lines inside them. This is deliberate: the corpus's
  fences are gate commands meant to be pasted, and a wrapped command is a wrong
  command. The trade is that `--check` guarantees "no non-code line exceeds the
  width", not "no line at all".

  **"Never" is unqualified, and a fence nested in a list item is the case that keeps
  testing it** — WP-2 rewrote one there, and WP-2f found a second pass doing the same
  (both shipped fully green, because the exemption that makes fences safe from width
  gates also makes them invisible to width gates). Such a line **overflows** rather than
  wrapping, exactly like a fence anywhere else; it stays inside a recorded `codeRange`
  and therefore stays exempt. Any pass that rewrites a composed list body needs the
  `SENTINEL` walk before it touches a line — there are three of them now, and the
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
- `.gitignore` is assembled from the chunk files in
  `skills/project-setup/references/gitignore/`; repo-local entries go under the
  `# --- project-specific ---` marker. `bun.lock` is **ignored**, matching every other
  tool in the fleet (the root `.gitignore` ignores it globally and no tool tracks one).

Plans: `plans/mdview.md` (repo root — the original build; written before `mdview/`
existed, so it stayed at root per the repo-wide plans routing rule) and
`mdview/plans/vault-readiness.md` (glyph tier, fence languages, divider, embeds, and the
multi-corpus sweep).
