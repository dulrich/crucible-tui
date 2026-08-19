# mdview — `scripts/`

The corpus sweep (`scripts/sweep.ts` and its library half `scripts/corpus.ts`), the
manifests it resolves, what the corpus has actually measured, and the defect detectors
that see *under* the width gate. **The root `AGENTS.md` is the parent document — read it
first.** The sweep's own ambiguous-width policy — why it never reads `MDVIEW_AMBIGUOUS`,
never consults the cache and never probes — is documented with the rest of ambiguous
width, in `src/AGENTS.md`'s "The sweep keeps the two axes independent, on purpose".

### Corpus sweep

`scripts/sweep.ts` renders whole corpora in one process at **80/100/116/160/346** columns,
honoring `codeRanges`. **116 and 346 are two of the user's three real terminal widths**
(the tiled layouts are 116 / 172 / 346) and were added in WP-2c; before that the sweep ran
80/100/160, none of which anyone reads at. Widths are only ever added here, never swapped
out — the dated full-corpus runs in the private archive's `measurements/` are recorded
against the older set and have to stay comparable. It replaced a shell loop that spawned the ~102 MB binary per file, and is
~13× faster.

**The sweep is two files, split in WP-4: `scripts/corpus.ts` is the library, and
`scripts/sweep.ts` is its CLI.** The library owns the manifest, the walk, the sampling
policy (`selectCorpusFiles`) and `sweepCorpus`; the CLI owns `parseArgs`, `printResult`
and the exit code. The split is not tidiness — `scripts/emoji-audit.ts` is a second
consumer, and it had already **copied** the sampling predicate and drifted: its copy
ignored `--limit` entirely and read `--all` straight off `process.argv`, so the same flags
selected different files depending on which script read them, and no gate could see it.
Both now parse with `parseArgs` and select with `selectCorpusFiles`.

**Anything in the library that looks like a defect is a recorded measurement, not an
oversight**, and `tests/sweep.test.ts` pins each one: `--limit` does nothing on a corpus
that declares no `sample`; the missing-root result reports a hardcoded `elapsedSeconds:
0` where every other path measures wall time; `shearsUnmapped` accumulates the **orphan**
count; a file-read error is unprefixed while a render error carries `width N: `; widths
are iterated first-seen, which fixes what lands in `overflow[0]`; and `parseArgs` ignores
unknown arguments silently. The four `CorpusResult` states are built by one factory that
**requires** `name`, `skipped` and `elapsedSeconds` at every call site, precisely so the
hardcoded `0` cannot be defaulted away. `parseArgs` is written flag-by-flag on purpose —
a declarative flag spec was measured against this parser and deletes nothing, while
making it harder to audit line-by-line against an archived run.

**Corpus roots are not hardcoded — they load from a versioned JSON manifest** (WP-1).
This is what lets this tool live in a public repo with zero knowledge of any local path:
the manifest is the only thing that knows where a corpus actually lives, and the
bundled one that ships with the source knows nothing private at all.

Manifest resolution, highest precedence first:

1. `--manifest <path>` (a sweep-only CLI flag)
2. `MDVIEW_CORPUS_MANIFEST` environment variable
3. config key `corpusManifest` (`src/config.ts`, XDG config path)
4. the bundled default at `corpus/default-manifest.json` — **public-safe, relative
   root, an explicit wildcard-free path list (WP-1, `plans/gate-corpus-reframe.md`):
   the 10 `tests/fixtures/*.md` fixtures plus 4 clean `tests/fixtures/witnesses/`
   defect witnesses — 14 files, fixed**

The sweep always prints which manifest it resolved and why, before any corpus output.
**When the resolved manifest is the bundled default, it prints an unmissable notice on
its own line** — a green run against the bundled default proves almost nothing (it's
14 files, the gate corpus, not the validation corpus); do not mistake it for a
validation run.

**This manifest used to be a glob over live documents** — `README.md`, `AGENTS.md`,
`plans/*.md`, `tests/fixtures/*.md` — and that meant its own bytes moved every time any
of those files was edited, ratcheting the colour axis with no renderer change behind
most of the moves. WP-1 of `plans/gate-corpus-reframe.md` replaced it with the explicit
list above, enforced by a committed eligibility assertion and exact-set pin
(`tests/gate-corpus.test.ts`): every entry is a direct `tests/fixtures/*.md` path, or a
fixture path named by a `witness-index.json` record whose `test_file` exists in the
repo. A third test in the same file pins the resolver contract this relies on:
a wildcard-free manifest entry resolves to exact-path membership, never a prefix or
substring match (`matchSegment`, `scripts/corpus.ts:347`). See "The seeds, and what
defines them" below for the colour-axis history this fixed.

**Witness class accounting (WP-1).** Candidates are the 6 unique fixture files named by
`tests/fixtures/witnesses/witness-index.json`'s 7 records, measured at the 5 default
widths × both glyph tiers (identical results in both tiers):

| Witness fixture | Result | Joined? | Pinned by |
|---|---|---|---|
| `defect-0-crlf-frontmatter.md` | overflow=0 errors=0 | yes | — |
| `defect-1-2-unparseable-frontmatter.md` | overflow=0 errors=0 | yes | — |
| `defect-2-success-path-overwide.md` | overflow at 80/100/116/160 | **no** | `tests/witnesses.test.ts` "witness: defect 2 -- a successfully parsed, over-width block is still caught"; `tests/frontmatter.test.ts` describe("defect 2") — the width gate catching this block *is* the pinned behaviour |
| `defect-3-nested-mapping.md` | overflow=0 errors=0 | yes | — |
| `defect-cjk-excerpt.md` | overflow at 80/100/116 | **no** | `tests/witnesses.test.ts` "witness: synthetic CJK excerpt -- un-exempt by design"; `tests/frontmatter.test.ts` describe("defect 1"), "a CJK excerpt can exceed the target" — deliberately left un-exempt, so overflowing is the pinned behaviour |
| `defect-wp14-list-item-inline-markup.md` | overflow=0 errors=0 | yes | — |

4 join, 2 stay out — both exclusions are witnesses *of* the width gate catching
something on purpose, not gaps in it. 10 fixtures + 4 witnesses = the 14-file manifest
above, matching the plan's projection exactly.

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
The root `AGENTS.md`, `src/render.ts` and `scripts/sweep.ts` all previously cited
private repos by name — one of them by file *and line number* — and the containment
guard (`tests/AGENTS.md`) is what now holds the line. Keep the reasoning; drop the
coordinates.

#### Corpus growth findings — 79 overflows, and 77 of them are one bug

Widening corpus membership put **79 width overflows** on the board, **0 errors**. Every
one is classified. They are not 79 problems:

| Class | Count | Construct |
|---|---|---|
| Accepted by design | 2 | a table of ≥9 columns emitted at its minimum feasible width, at target 80 only — the precedent set in `plans/mdview.md` |
| Renderer defect | 77 | the frontmatter meta block's **degraded** paths, which never consult `targetWidth` |
| Source pathology | 0 | none, despite appearances — see below |

The 77 split three ways, all of them in `src/frontmatter.ts`:

- **46** (23 files) — the parse-failure diagnostic that `formatMetaBlock`'s `catch`
  emits. It is `dim()`ed and passed through verbatim; the parser's message text runs a
  fixed ~104 columns, so it overflows at 80 and 100 and is clean from 116 up.
- **26** (16 files) — the raw frontmatter that the same `catch` echoes beneath the
  diagnostic. One long authored scalar comes back at its full source width, measured
  between 118 and 568 columns. `formatMapping`'s success path wraps this correctly
  through `wrapValue`; only the failure path does not.
- **5** (1 file) — a nested mapping at depth ≥ 1, `JSON.stringify`ed straight into the
  line by `formatMapping`. Every sibling branch routes through `wrapValue`; this one
  does not, so a machine payload lands at 1,044 columns at **every** target, 346
  included.

**A wide line is not evidence of an unwrappable source.** Two of these were flagged in
advance as probable source pathology on width alone (1,044 and 568 columns). Both are the
defect above: the 1,044-column line has break opportunities that `hardSplit` already
knows how to take, and the 568-column one is ordinary prose full of spaces. What settles
the class is the code path that produced the line, never the number.

**This stayed a triage because the fix is a design call, not a wrap call.** The degraded
path exists to show what the file says when the parser could not, and folding it changes
exactly that: the diagnostic carries a caret aligned to a source column, and the echoed
block is verbatim source that stops being valid the moment it wraps. Hard-wrap with a
continuation indent, truncate with a marker, or treat the block as fence-like and exempt
it — each is defensible, each needs its own pinning test, and picking one is its own WP.

Neither ratchet moved: `--max-orphans` and `--max-over-indent` have **no committed
constants** here at all. They are CLI-only, unset by default, and their threshold values
live in the private archive with the regression corpus they ratchet.

#### The table allocator is not broken, and the width gate is nearly blind

Two corrections from `plans/representative-corpus.md`'s WP-6, both of which invalidate
claims made confidently in this repo's own briefs. Read them before opening either subject
again.

**The three-column table overflow does not exist.** It was reported as a table rendering
106–114 columns against a target of 100, and named as a defect distinct from the accepted
≥9-column case. The reproduction snippet had lost the escape byte from its ANSI strip, so
it was measuring SGR codes as printable columns. A census of **4,963 tables over 29,778
renders** found **26 overflowing renders**, and every single one has `allocFits === false`,
`rendered === minFeasible`, and **at least 9 columns** — the precedent already accepted in
`plans/mdview.md`. There is no second table defect. `src/table.ts` allocates correctly.

**Width overflow barely fires on realistic documents: 1 in 575 README combos, and 0 in
1,000 prose combos.** This is the repo's headline gate, the thing `--check` and both sweeps
exist to measure, and on the material users actually open it is almost never the signal.
That is *why* `src/detectors.ts` exists and why a green sweep is such weak evidence — see
the two sections below. Do not rank a corpus on overflow; a sprint tried and had to throw
the metric out.

**Do not weight a corpus by file count, either.** The largest vendor collection in the
reference set is **~51% self-duplicated**: 1,571 markdown files, **771 unique**, with 766
groups mirrored byte-for-byte under `.github/plugins/`. Every volume-weighted figure
computed against it is wrong by roughly a factor of two, which strengthens rather than
weakens the rule it was originally cited for.

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
fixture had no long bullets; the highlight path is dead under tests because the renderer
skips highlighting whenever the colour decision is false — `src/blocks.ts`'s `highlightCode`
returns raw code when `LayoutContext.color` is false, which is every non-TTY run; tier purity
was unmeasured; code ranges are exempt). **When a gate passes, check that it passes for the
right reason.**

That third one is worth naming precisely, because the mechanism outlived every dependency
that carried it: the rule was `marked-terminal`'s `highlight()` short-circuiting at
`chalk.level === 0`, WP-3 of `plans/marked-terminal-replacement.md` transcribed it into this
repo's own renderer, where the decision was `supports-color`'s answer, and WP-1 of
`plans/colour-policy.md` made it `resolveColourPolicy`'s (`src/colour.ts`) — threaded in as a
value, with no library asked. Same gate, same blindness, owned twice over. Since WP-2 of that
plan the *whole* highlighting path obeys it, `cli-highlight`'s own `chalk` having been the
last thing that did not — see `src/AGENTS.md`'s "Colour" section and its rendering policy.

#### The differential harness is the instrument for that bar

`scripts/render-diff.ts` (WP-1 of `plans/marked-terminal-replacement.md`) is the committed
form of the byte-comparison above — the same library-plus-CLI shape as
`scripts/corpus.ts` + `scripts/sweep.ts`, with `import.meta.main` gating the CLI so
`tests/render-diff.test.ts` imports the functions directly. It renders a
`(file × width × tier × ambiguous-mode)` grid on two revisions and records four channels
per combo — `textSha`, `codeContentSha`, `codeRanges`, `detectors` — never bodies, so a
baseline over the private corpus stays a reviewable artifact. **`codeContentSha` is the
channel this section exists to demand**; the parity classes it feeds are documented once,
in `src/AGENTS.md`'s "Parity: four classes".

Two traps, each recorded because it already cost a package real time:

- **`--baseline`/`--against` is unsound against a live working tree.** It compares two
  reads that can be half an hour apart, so a file the user edits mid-run reports as a
  failure that re-renders identical. Use `--rev-a`/`--rev-b` for any binding gate.
- **The file is binary to `grep` and `rg`.** It embeds three raw NUL bytes as a composite
  group-key separator (~line 537, `` `${r.width}\x00${r.tier}\x00${r.ambiguous}` ``), so
  both tools skip it silently without `-a`/`--text` — a search for a symbol that is right
  there returns nothing and reads exactly like "that channel does not exist". Recorded
  rather than fixed: the key works, and changing it is a source edit no measurement has
  asked for. Note that `src/render.ts` deliberately avoids the same hazard, spelling its
  own sentinel `String.fromCharCode(0)` because a raw NUL twice landed in that file during
  editing; this script did not get the same treatment.


#### The colour axis — the instrument for "colour must not change characters"

WP-1 of `plans/own-the-token-walk.md`. The invariant it measures: **a colour decision may
change which bytes a render emits; it must never change which *characters* it emits.** It
is a measurement only — it changes no rendered byte, and it repairs none of the producers
it makes visible.

```bash
bun run sweep -- --colour-mode both                       # the three buckets, no ratchet
bun run sweep -- --colour-mode both --max-char-diff 66 --max-sgr 25   # what verify runs
bun run sweep -- --colour-mode on                         # the ordinary sweep, in colour
MDVIEW_CORPUS_MANIFEST=<private manifest> bun run sweep -- --colour-mode both   # opt-in
```

**`--colour-mode`, never `--color` or `--no-color`.** `has-flag` — which `supports-color`
consulted, and `@colors/colors` too until WP-2 of `plans/colour-policy.md` removed both from
the runtime closure — scans the whole of `process.argv`, so a harness flag
by either of those names was sniffed by the very packages whose decision was under
measurement, and the instrument silently changed what it was reading. **Neither package is
installed now and the spelling still stands**: `mdview`'s own `--color` flag is a real
directive (`src/cli.ts`, the top slot of the ratified precedence matrix), so a harness flag
by that name would now be read by the *renderer* rather than by a library — the same failure
with a different owner. The spelling is a contract, pinned in `tests/sweep.test.ts`; do not
"correct" it to the American spelling or to the conventional flag name.

**Each colour mode is a whole fresh process, and the reason it *had* to be is gone.**
`scripts/corpus.ts` statically imports `renderDocumentDetailed`, and `supports-color`,
`cli-highlight`'s own `chalk` theme and `@colors/colors` each resolved their colour decision
**at module load**, once, for the life of the process — so a second render in one process
could not be in a different colour mode, and mutating `FORCE_COLOR` between renders did
nothing, because Bun's module cache hands back the module that already resolved (the same
finding `tests/helpers/color.ts:15-46` records from the test side). WP-1 of
`plans/colour-policy.md` retired the first of those three and WP-2 the other two, so **no
module-load global decides colour in this renderer any more** and one process could now vary
the mode per render. **The two-child design stays regardless**, and deliberately: it is what
makes each child's mode observable from its own output rather than from an environment the
parent believes it set, and collapsing it is a gate change with its own evidence to bring
(`plans/colour-policy.md`'s WP-5), not a side effect of the packages leaving. So the parent
re-execs
`scripts/sweep.ts --colour-child on|off`, one child per mode, with `FORCE_COLOR` set and
`NO_COLOR` deleted **explicitly, on both children, always** — never inherited, because a
developer or runner with `FORCE_COLOR` exported would otherwise run both children in the
same mode and produce a gate that cannot fail. Each child emits one `{strippedSha,
hasSgr}` digest per `(file, width)` as JSONL — never body text, so the axis stays
affordable over the private corpus — and the parent joins the two streams by key.

**`tests/colour-axis.test.ts` asserts the two children resolve *opposite* modes from
observed output**, not from the environment the parent intended to set, and asserts it
again with a hostile ambient `FORCE_COLOR`/`NO_COLOR` in place. That test is the reason to
believe any number below.

**Three buckets, and the ratchets read the totals, not the disjoint buckets.** Every
`(file, width)` lands in exactly one of `charDiffOnly`, `sgrOnly` and `both`; the printed
line carries all three plus `charDiff` (`charDiffOnly + both`) and `sgrAny`
(`sgrOnly + both`). **`--max-char-diff` reads `charDiff` and `--max-sgr` reads `sgrAny`.**
The disjoint `sgrOnly` bucket is *not* an unwanted-SGR counter: it cannot see unwanted SGR
in a combo that also differs in characters. On the bundled corpus's current 14-file
population every `sgrOnly` combo happens to have `both=0`, so `sgrOnly` and `sgrAny`
currently agree (20 = 20) — that is a fact about which files are in the population, not a
guarantee of the metric. A larger population the plan measured showed the split for real:
64 disjoint against a `sgrAny` of 125. A reader who takes `sgrOnly` for "the unwanted SGR
count" is reading the wrong number in general, which is why both are on the same line.

**The seeds, and what defines them.** Measured by this instrument over the fixed gate
corpus `corpus/default-manifest.json` defines (WP-1, `plans/gate-corpus-reframe.md`) —
**14 files × the 5 default widths = 70 combos** — at both glyph tiers, which agree
exactly:

| | combos | identical | charDiffOnly | sgrOnly | both | **charDiff** | **sgrAny** | errors |
|---|---|---|---|---|---|---|---|---|
| unicode | 70 | 19 | 31 | 20 | 0 | **31** | **20** | 0 |
| ascii | 70 | 19 | 31 | 20 | 0 | **31** | **20** | 0 |

`scripts/verify.ts` runs the unicode pass with `--max-char-diff 31 --max-sgr 20`. **Both
are ratchets, not targets** — the corpus is what it is today, and what must not happen is
either number going up.

**Per-file composition (one-file-manifest isolation, WP-1).** `charDiff=31` is
`blockquote-list.md` (5) + `coalesced-colon-guard-continuation.md` (1) + `fenced-list.md`
(5) + `loose-list.md` (5) + `nested-list.md` (5) + `tight-list.md` (5) +
`defect-wp14-list-item-inline-markup.md` (5) — the same three known colour-only defects
named below, now firing on a smaller, fixed population. `sgrAny=20` is `simple.md`'s one
wiki-link (`styleWikiLink`, 5 combos) plus the three frontmatter-bearing witnesses —
`defect-0-crlf-frontmatter.md`, `defect-1-2-unparseable-frontmatter.md`,
`defect-3-nested-mapping.md` — each contributing 5 via `src/frontmatter.ts`'s
`DIM_START`/`DIM_END` around metadata keys, which fires in the colourless render
regardless of the colour decision (this is measured directly here, where the table-border
styling below was gated on `@colors/colors`' own answer and so could not appear at all). The
other 7 of 14 files are `identical` at every width and every combo.

**That composition is the seed's, and the *measured* number has since fallen.** WP-1 of
`plans/colour-policy.md` put `src/frontmatter.ts`'s dim behind the resolved policy, so the
three frontmatter witnesses stopped contributing: `sgrAny` measures **5** — `simple.md`'s
wiki-link alone, which is WP-4's to remove — against a seed of 20. The seed is a ratchet and
is left where it is until the plan's WP-5 replaces both counters with exact gates; what must
not happen is the measured number going *up*.

**History — the population used to drift, and WP-1 of `plans/gate-corpus-reframe.md`
replaced it because of that.** Before this WP, the corpus was a **glob over live
documents** — `README.md`, `AGENTS.md`, `plans/*.md`, `tests/fixtures/*.md` — so editing
any of those files, including a one-line Status-line edit or a brand-new plan, moved the
population and therefore the ratchets, with no renderer change in the commit. Five
re-seeds chased that drift, only one of them behind an actual source change: **62 → 65**
(WP-2, `plans/own-the-token-walk.md`, which rewrote root `AGENTS.md` as a side effect of
owning the token walk) **→ 66** (`plans/styled-runs-and-colour-policy.md` was written,
adding a globbed file whose own text also demonstrated one of the three colour-only
defects below) **→ 70** (that plan's rev 2 replaced rev 1's prose — a same-file edit with
zero source changes) **→ 73 → 75** (further revisions, measured but never landed before
this WP; see `plans/gate-corpus-reframe.md`'s Context for the full instability record).
The withdrawn `plans/styled-runs-and-colour-policy.md` spent a whole sub-package building
per-file ratchet *attribution* to manage that instability instead of removing its cause.
User direction (2026-08-18) was a fixed, explicit, wildcard-free corpus instead of
attribution machinery, and that is what `corpus/default-manifest.json` now is.

**The attribution rule, revised for a fixed population (WP-1).** A fixed population does
not freeze member *contents* — `tests/fixtures/*.md` and the four clean witnesses can
still change — so a move is still attributed, but by **commit shape** rather than by
isolating one document out of a glob: **member-only commit** (a population-content
change — editing a manifest member's bytes, or changing which witnesses join) is
re-seeded in the same commit, with the diff as evidence; **no-member-touched commit**
(every manifest member's bytes are unchanged) means any move — **including a downward
one** — is a renderer finding, not a re-seed; a **mixed member+renderer commit** gets no
diff-only attribution and no re-seed at all — **commit splitting is mandatory**, so each
side lands as one of the two decidable shapes. The one-file-manifest isolation the
history above used is still the right *instrument* for a member-only re-seed's evidence;
what changed is that there is no longer a glob to isolate a document out of, since every
manifest member is already named explicitly.

**What this axis structurally could not see, and what closed it.** The colourless child sets
`FORCE_COLOR=0` (`colourChildEnv`), which `supports-color` *and* `@colors/colors` both
honoured — so a producer gated on either never leaked into this measurement, whatever its
rule was in the real world. `src/table.ts`'s border and head styling was exactly that case:
it read `@colors/colors`' answer, which does **not** consult `isTTY`, so piping `mdview` into
a file with no `FORCE_COLOR` set emitted `\x1b[90m` around every border and `\x1b[1m` around
every head cell — **205 grey pairs and 12 bold pairs on `wide-table.md` alone, measured** —
while this axis reported the same combo as `identical`, because the leak was gated on a
decision that itself honours `FORCE_COLOR=0`.

WP-2 of `plans/colour-policy.md` removed that gate with the package: the table styles through
`src/style.ts` under the resolved policy, so the piped default emits nothing and there is no
longer a producer this instrument is blind to *by construction*. The seed did not move
(`sgrAny=5` before and after), which is the expected result and not an accident — the escapes
that disappeared were only ever emitted in the mode this axis does not sample.

`src/frontmatter.ts`'s dim was **never** gated on either package; it is what made three
frontmatter witnesses land in `sgrOnly` rather than `identical` until WP-1 put it behind the
policy. `sgrAny` counts escapes that survive `FORCE_COLOR=0`; it is still not a complete leak
audit — a producer that consulted something other than `FORCE_COLOR` would be invisible again
— see `plans/colour-policy.md`.

**The population is the fixed gate corpus, and nothing else.** There is no second
file-selection mechanism for the axis: the parent hands each child its own command line
with `--colour-mode` removed, so both children resolve the same manifest, corpora and
widths through the same parser. `corpus/default-manifest.json`'s `globs` key is now an
explicit, wildcard-free path list (WP-1, `plans/gate-corpus-reframe.md`) — no
`plans/*.md`, no `README.md`, no root `AGENTS.md` — so nothing outside a deliberate edit
to `corpus/default-manifest.json` itself, or to one of the fourteen files it names, can
move these seeds again. A WP that does either and trips a ratchet re-measures with the
command above and re-seeds `scripts/verify.ts` in the same commit, per the attribution
rule above.

**The width axis is asserted, not assumed.** `renderDocumentDetailed(source, targetWidth,
…)` takes its width as a **positional number** (`src/render.ts:776-782`); passing an
options object renders every width identically and produces counts about nothing. That
mistake has invalidated this exact quantity **four times across three authors**, so
`tests/colour-axis.test.ts` pins it directly — the same file must digest differently at
40 and at 100 — independent of which population the manifest names.

**What the numbers were made of, and what closed them.** `charDiff=31`'s mechanisms were
`src/lists.ts`' `fixNestedLists` regex whose `\S` matches an SGR reset's `m`;
`src/lists.ts`' raw-byte empty-line filter; `src/wrap.ts`' escape-only run becoming a
zero-width word — plus two more the first repair exposed, `src/render.ts`'s hard-break
seam and its three marker-shape guards (with `substituteBullets`), all of them the same
defect: a layout decision made on bytes rather than on columns. A worked witness:
`tests/fixtures/tight-list.md` at 80 columns wrapped a `<br />` hard return one
way colourless and another under colour, and the two renders differed in *line
count*. **WP-3 of `plans/colour-policy.md` repaired all five: the measured `charDiff` is
0 over the fixed corpus at both tiers, with the colourless render byte-identical in 140
of 140 combos** (the direction was pinned before the work — the colourless side is the
frozen baseline and only the coloured side moves). The seed stays at 31 until WP-5
replaces both counters with the three exact gates; what must not happen is the measured
number going up.

`sgrAny=20`'s two mechanisms are `src/render.ts:62-65` (`styleWikiLink`,
hardcoded `\x1b[36m\x1b[4m`, no colour decision at all) and `src/frontmatter.ts`'s
`DIM_START`/`DIM_END`, both unconditional; the second went behind the policy at WP-1, so
the measured number is **5** — `simple.md`'s wiki-link alone, WP-4's to remove.

**OSC-8 used to be outside what this can see, and WP-3 brought it inside.** `stripAnsi`
(`src/list-lines.ts`) removed SGR only, so a hyperlink — and the tmux DCS envelope around
it — passed through the strip intact: counted as visible text by the character channel,
invisible to `hasSgr`. It is a derivation of `src/ansi.ts`'s scanner now, so `hasSgr`
means "carries any terminal sequence" and the character channel measures the columns a
reader sees. **Neither seed moved with that change**, and the reason is structural rather
than lucky: hyperlinks are off on every non-TTY destination, so neither child of this axis
emits one. The paragraph this replaces said the widening would "silently change what
`hasSgr` means" — it did change it, deliberately and in one recorded package, and the pin
in `tests/colour-axis.test.ts` was inverted in the same commit rather than left to be
discovered.

**The axis flag is on the sweep and deliberately not on `scripts/render-diff.ts`.** That
harness imports **both revisions into one process** (`loadRevision`; when this was written the
module cache resolved `supports-color` once for both, and the same would be true of any
colour-deciding module either revision loads), which is exactly right for a differential — both
sides are measured in the same mode — and exactly why a `--colour-mode` flag there could
only mean "re-exec myself", with no per-render switch to offer. A caller that wants both
modes runs the CLI twice, once under `FORCE_COLOR=3` and once under `FORCE_COLOR=0`, with
`NO_COLOR` unset in both; that is how WP-2's "full 20-axis T2, both colour modes" is run.

##### The escape-site census

The superseded plan claimed "40 removable escape sites". **That census was wrong in kind**,
not merely in count: it mixed terminal-protocol logic that must stay with styling that
might move. Re-censused below over all of `src/` and `scripts/`, in four categories. The
successor plan sizes its work from this table, so a miscategorised row costs real
estimation error.

(Searching for these is subject to the NUL trap two sections up: `scripts/render-diff.ts`
is binary to `grep` and `rg` without `-a`/`--text`, and a site sitting right there reads as
absent. Every row below was found with `-a`.)

**Producers — they put escape bytes into rendered text.**

| Site | What it emits | Obeys `ctx.color`? |
|---|---|---|
| `src/style.ts` (`applyStyle`) | the one styling primitive; every SGR pair in prose comes through here. Was `src/inline.ts:205-226` until WP-2 of `plans/colour-policy.md` moved it, with the byte table, into the module that owns styling | **yes** — returns the input untouched when the policy is off |
| `src/inline.ts:339,348,363,382,420,424,427` | its inline call sites — strong, em, codespan, del, link | via `applyStyle` |
| `src/blocks.ts:151,195,213,426,457,518` | its block call sites — code, hr, html, heading, paragraph, blockquote | via `applyStyle` |
| `src/lists.ts:380` | its list-item call site | via `applyStyle` |
| `src/inline.ts`'s `renderLink`, through `src/ansi.ts`'s `link` | **OSC-8**, not SGR, plus the tmux DCS envelope | **yes, on the other axis** — `ctx.hyperlinks`, since WP-1 of `plans/colour-policy.md`; it was `supportsHyperlinks.stdout`, a load-time global, when this census was taken. The *emitter* was `ansiEscapes.link` until WP-3 of the same plan; it is this repo's transcription now, and the href is sanitized at emission |
| `src/render.ts:62-65` (`styleWikiLink`) | hardcoded `[36m[4m…`, injected **before the lexer** | **no** |
| `src/frontmatter.ts`'s `dim` | the `2m`/`22m` pair around metadata — outside the token stream entirely | **yes** — an explicit `color` argument since WP-1, through `src/style.ts`'s plain wrap since WP-2; it was two hardcoded constants and no decision at all |
| `src/table.ts` (`styleBorder`/`styleHead`) | `grey`/`bold` for borders and headers | **yes** — `renderTable`'s `color` argument since WP-2; it was `@colors/colors`' own module-load answer, which did not consult `isTTY` |
| `src/blocks.ts`'s `highlightCode` | the syntax theme inside fences | **yes** — `ctx.color`, gating `src/highlight.ts` since WP-2; it was `cli-highlight`'s bundled `chalk` level, decided at module load |
| ~~`src/inline.ts:283` (`detectInlineColor`)~~ | **deleted** at WP-1 of `plans/colour-policy.md` with every consumer — the authority the first row obeys is `resolveColourPolicy` (`src/colour.ts`), threaded through `LayoutContext.color` | n/a |

**Layout-consumers — they read or strip escapes to decide where characters go.** These are
the sites a style-last restructure has to satisfy, and the colour-only defects all lived
here. **The "why it looks at escapes" column is now history for the first four rows** —
WP-3 of `plans/colour-policy.md` repaired each one, and the entries are kept in the
register this file uses for a defect that has been closed: the mechanism is the useful
part, and each is the same mistake.

| Site | Why it looks at escapes |
|---|---|
| `src/list-lines.ts`'s `stripAnsi` | the one strip implementation in the repo; everything below calls it. A derivation of `src/ansi.ts`'s scanner since WP-3 — it removed SGR only before that, so OSC-8 and DCS were invisible to every consumer here |
| `src/wrap.ts` | splits a styled token so wrapping measures display width, not bytes — **an escape-only run became a zero-width word here**, and the private SGR-only tokenizer that did the splitting cut OSC-8 sequences in half. Both split paths consume `src/ansi.ts`'s spans since WP-3 |
| `src/lists.ts`'s `fixNestedLists` | its `\S` matched an SGR reset's `m`; the decision is made on visible text and applied at the mapped byte offset since WP-3 |
| `src/lists.ts`'s empty-line filter | filtered empty lines by raw bytes, so a line of escapes alone survived; `stripAnsi(line) !== ""` since WP-3 |
| `src/lists.ts`' `substituteBullets` and `realignEmbeddedContinuations` | bullet substitution and the de-drift claim on stripped text — the de-drift since WP-5 of `plans/tn-review-remediation.md`, the substitution since WP-3 of this plan (its anchored regex could not match an encased marker line) |
| `src/render.ts`'s `isHardBoundary` and its three marker-shape guards | a hard-break tail and a marker shape, both anchored on raw lines; asked of `stripAnsi(line)` since WP-3, which is what made the guards fire under colour at all |
| `src/blocks.ts:313` | drops a trailing line that is blank once stripped |
| `src/render.ts:667-668` | the emoji trailing-space strip has to match *across* the SGR that closes the segment |
| `src/detectors.ts:120,315,327,396,516,603,641` | measurement, not rendering — no rendered byte depends on these, but they read the same escapes |
| `scripts/corpus.ts:693`, `:859` | the sweep's orphan line lookup, and this axis's own digest |

**Final-output-consumers — a strip on the way out to a terminal or a file: there are
none.** `src/cli.ts` writes the renderer's string through unchanged, and the width gate
(`src/overflow.ts` via `src/width.ts`) measures with `string-width`, which strips SGR
*inside the dependency* rather than at a site in this repo. This is the row that matters
for the successor: `--plain` has no existing seam to hook, so it is new construction, not a
move. **The second half of that sentence used to read "and `stripAnsi` cannot serve as that
seam while it removes SGR only" — that blocker is gone.** Since WP-3 of
`plans/colour-policy.md` it removes every sequence kind the renderer can emit
(`src/ansi.ts`'s `scan`/`stripSequences`), so a future `--plain` has a correct seam
available; it still has to decide *where* to apply it, which is the part that was never
about the strip.

**Unrelated-protocol — terminal control that is not styling and must stay.**

| Site | What it is |
|---|---|
| `src/width.ts:410` | `\x1b[6n` — the DSR cursor-position request the ambiguous-width probe sends |
| `src/width.ts:363` | the regex that reads the terminal's DSR reply |
| `src/width.ts:366` | escapes that reply for a diagnostic line, so it can be printed safely |
| `src/width.ts:526` | `\x1b[<n>G\x1b[K` — moving to a column and erasing the line, cleaning up after the probe |
| `src/cli.ts:102` | the `--help` text describing the probe; prose, not an escape |

**Six of these were miscategorised by the count this replaces**: the four `src/width.ts`
rows are DSR terminal protocol with nothing to do with colour, and `src/frontmatter.ts`'s
two are producers rather than coping code.

#### Defect detectors — the gates that can see *under* the width

`src/detectors.ts` (WP-2d) is the answer to the section above. Every list-wrap defect this
tool has shipped was **under** the target width, and `--check` and both sweeps only test
for *exceeding* it, so no green sweep in this repo's history has ever been evidence about
that class. Three detectors, all width-blind by design where the width is not the point,
plus WP-8's classifier that labels the first one's hits:

| Detector | Finds |
|---|---|
| `findListOrphans(rendered, width)` | a line in a list item with <= 2 words, after a nearly-full line, followed by more prose in the same item |
| `findContinuationOverIndent(rendered)` | a continuation line indented past **its own item's** text column |
| `findColumnZeroMarkers(rendered)` | a rendered list marker at **column 0** — outside the block it belongs to (WP-2g) |
| `classifyListOrphans(rendered, width, blockEnds)` (WP-8) | the same candidate set, each hit labelled `shear` / `paragraph-boundary` / `block-boundary` / `unmapped` using the `marked` token stream. `findShearOrphans` is the filtered view — the layout faults only |

Seven things about this module are load-bearing:

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
  "A blockquote owes columns exactly like a list" in `src/AGENTS.md`.
- **`findContinuationOverIndent` is structurally blind to guard-shaped corruption, and no
  other gate in this repo covers it.** This is a durable trap, not a note about one bug.
  The detector forgives a drift of exactly one column on a line the shared
  `isGuardShapedLine` predicate claims (`src/detectors.ts`, `src/list-lines.ts`), because
  that column *is* the wrapping seams' deliberate guard space and grading it as a defect
  was grading the fix as the bug. The exemption is correct and must stay. What it costs is
  this: **the artifact a mis-landed guard produces is itself guard-shaped**, so the detector
  swallows it. WP-1 of `plans/renderer-deferred-work.md` found a coalesced one-digit ordered
  item whose guard space moved a continuation onto the four-column grid, where
  `substituteBullets` rewrote the author's literal `*` into the bullet glyph `◦` — a nested
  list item nobody wrote — and the resulting `"◦ "` line, sitting exactly one column past
  its item's text column, was exempted by this clause. `findListOrphans` and
  `findColumnZeroMarkers` both reported 0, and the line was under the target width, so
  `--check` and both sweeps were blind by construction. **Do not read a guard-shaped line as
  verified by this detector.** The only instrument that catches this class is a committed
  witness asserted per width — `tests/fixtures/coalesced-guard-collision.md` and the WP-1
  group in `tests/render-lists.test.ts` — and any future change to either wrapping seam's
  guard owes one. **Do not "fix" the detector to cover it**: its counts are historical, every
  dated figure in the private archive's `measurements/` was taken with this body, and a
  drift there looks exactly like a fix.
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
  open — the metric blind spots the orphan detector documents, and the legitimate
  over-indent class above — so switching them on by default would turn both gates red for
  known, tracked reasons and destroy their value as a signal.
- **The loose-list blind spot is real but small, and it is NOT why the detector fires so
  often.** This is the correction that matters most in this section, because the opposite
  belief drove a whole sprint. `findListOrphans`' docblock documents that the list composer
  drops the blank line between two paragraphs of a loose item — `bulletPointLines`'
  `.filter(identity)` in the renderer this repo replaced, transcribed into `src/lists.ts`'s
  `renderList` in WP-4 and kept deliberately, because not dropping it would move bytes —
  making a paragraph boundary and a genuine shear the same shape in rendered text — and
  the reasonable inference was that a detector firing on ~39–51% of real files was
  mostly that artefact. WP-8 measured
  it against the token stream: over 479 files, 2,395 file-widths and 3,223 hits, the split
  is **2,837 `shear` / 144 `paragraph-boundary` / 242 `block-boundary`**. The blind spot is
  **4.5% of the metric**, and subtracting it moves the firing rate by about two points.
  The material simply does not contain the construct: 533 loose multi-paragraph item
  boundaries against 32,614 indented prose-block ends. **The real driver is long
  unbreakable tokens** — 62% of shears sit beside a run that does not fit the item's budget
  at all, a bare URL or a reference-style image label. The firing rate is a fact about
  link-dense list items, not about loose ones.
- **`unmapped` is no longer always zero, and WP-14 is why.** WP-8 measured 0 `unmapped`
  across the pool and the classifier's docblock said so. Once WP-14 made list items parse
  their inline tokens, `readBlockEnds`' probe became defeatable inside an item: 49 hits
  over 7 file-width combos in 2 files. Post-WP-14 the population is **2,817 orphans /
  2,417 shear / 128 paragraph-boundary / 223 block-boundary / 49 unmapped**, with 175 files
  firing at least one shear (was 215). `unmapped` is the honest answer, not a failure —
  the probe reports non-alignment rather than guessing a label. Not fixed; recorded.

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

##### Two curated sets now live in the archive, and they answer different questions

WP-9 of `plans/representative-corpus.md` added a second one beside the regression set. Both
live in the private archive; neither replaces the other.

| | the regression set (WP-2d) | the durable set (WP-9) |
|---|---|---|
| content | ~50 minimal excerpts, delta-debugged | 91 whole publishable documents, **referenced, not copied** |
| source | the private vault | the vendored README / skills / clippings strata |
| keyed on | defect class × construct | shape, with one named witness per member |
| manifest | `walkAll` over a directory | **explicit per-file** |
| answers | "does this defect still reproduce?" | "does the renderer still survive what a user opens?" |

Three things about the durable set that matter from this side of the boundary:

- **It is a selection manifest, not a copy** — not one markdown byte is duplicated. That is
  what makes the clippings stratum includable at all: it is third-party copyrighted prose
  that may not be vendored, so a member records the `sha256` pinned at ingestion plus a
  `requiresRecreate` flag and resolves only after the archive's recreate script has run.
  Those hashes pin a **vault snapshot, not the live web** — one post already drifted when
  its author revised it after ingestion.
- **Its full sweep exits non-zero by design.** Six of its renders overflow; the set was
  assembled precisely to contain documents that trip the gates. Read `errors=0` as the
  health signal there, never the exit code.
- **A real coverage gap, recorded rather than papered over: all six overflows are table
  overflows**, at 9, 10 and 19 columns. The pool contains **no non-table width-overflow
  witness**, which is consistent with the census two sections above — overflow fires on 1
  in 575 README combos and every instance had 9+ columns. If a non-table overflow defect is
  ever fixed, its witness has to be synthesised.

Run verification from this repo's root. This instruction used to read "run from
``, **not** the repo root": while this tool was a subfolder of a mono-repo, the
parent's `node_modules` resolved a different `string-width` and gave false readings.
Extraction removed the parent, so there is no longer a second resolution to get wrong —
but the failure mode is worth knowing, because it is silent and looks like a real
measurement.

