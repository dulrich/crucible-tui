# mdview — `tests/`

The publication containment guard — `tests/helpers/containment.ts` holds its rules,
`tests/containment.test.ts` runs them — the width-sensitive fixture trap, and where the
five largest test files' `describe` groups now live after their WP-R3 split. **The root
`AGENTS.md` is the parent document — read it first.**

**Since WP-9 of `plans/mdview-rust-port.md` this directory tests the instruments, not the renderer.** The renderer's TypeScript tests were deleted with it (`TS_BASELINE` = `c097c66`); the renderer's tests are Rust now (`cargo test`, `crates/mdview/`), including the frontmatter and WP-14 witnesses (`crates/mdview/tests/witnesses.rs`, which `tests/fixtures/witnesses/witness-index.json` names). What stays here exercises `scripts/`: the sweep, the colour axis, the render differential, the detectors and overflow gate, the import-graph DAG and the containment guard. Tests that need a render send one request to the built binary (`tests/helpers/render.ts`), which is why `verify` runs `bun test` after `build:rust`.

### The five-file split (WP-R3) — history

Most of the files below were deleted at WP-9; the record of where each `describe` block landed is kept as of `TS_BASELINE`.

`plans/post-refactor-code-quality-remediation.md`'s WP-R3 split every test file at or
above 1,000 lines along its own existing `describe` groups, mechanically — no assertion
or fixture changed, only which file holds which block, and `LONG_PATH`
("Width-sensitive fixtures are a trap here", below) travels intact everywhere it lands.

`tests/render-lists.test.ts` became `tests/render-lists-wrapping.test.ts` (the loose- and
tight-list double-wrap witnesses), `tests/render-lists-nesting.test.ts` (nested-list and
blockquote continuation, including fenced code inside a list item) and
`tests/render-lists-guards.test.ts` (the coalesced-path and colon-guard collision
witnesses, and the three colour-cannot-move-a-character repairs).

`tests/sweep.test.ts` became `tests/sweep-manifest.test.ts` (manifest parsing, corpus
selection and symlink disclosure), `tests/sweep-cli.test.ts` (`parseArgs`'s ordinary
measurement flags) and `tests/sweep-colour-axis.test.ts` (the colour-axis flags,
`stripColourModeArgs`, `printColourAxis`, and `renderWithForcedColor`'s own
non-vacuity — grouped there because what that block exercises is the coloured-render
harness itself, not corpus selection, even though it sat between the manifest and
symlink blocks in the original file).

`tests/wikilink.test.ts` became `tests/wikilink-tokenizer.test.ts` (recognition — the
tokenizer extension, the two regexes, the frozen cases, C4's pass-through grant, the
lexer-input witness), `tests/wikilink-emission.test.ts` (the precedence matrix, C5's
OSC-8 repair, C2's wrap repair, the ownership-class probe sweep, and the emoji/entity
assumption) and `tests/wikilink-table.test.ts` (C6's table-cell span contract).

`tests/table.test.ts` became `tests/table-normalization.test.ts` (`splitToken`,
`wrapText`, `cellText`, and the three span-cell contract blocks), `tests/table-allocation.test.ts`
(`allocateWidths` and every `renderTable` sizing/collapse/CJK/column-count invariant) and
`tests/table-emission.test.ts` (per-cell padding, the border set, multi-line
composition, `chromeWidth`, alignment, the chrome invariant, and border/head styling
policy) — `LONG_PATH` is duplicated byte-for-byte into all three, since each
independently asserts against it.

`tests/render.test.ts` split by production owner rather than by a fixed three-way
template, since the plan's contract for that file was to group by which production
module each block actually exercises: `tests/render-wikilinks.test.ts` (wiki-links,
verbatim contexts, embeds — all `TS_BASELINE` `src/wikilink.ts`'s), `tests/render-list-layout.test.ts`
(list reflow and the WP-14 inline-markup-inside-a-list-item witness — both exercise
`TS_BASELINE` `src/list-layout.ts`'s wrap paths, which is where WP-R2 moved `wrappedText` and the
tight-item coalesce), `tests/render-frontmatter.test.ts` (frontmatter integration, the
divider, and the codeRanges regression the divider's line offset causes — all
`TS_BASELINE` `src/frontmatter.ts`'s), `tests/render-emoji.test.ts` (the emoji shortcode substitution
witness — `TS_BASELINE` `src/inline.ts`'s emoji pass) and `tests/render-core.test.ts` (the
`formats`-mode reset framing, width/prose coverage, the fenced-code exemption and
sentinel walk, fence-language normalization, and the task-state pre-pass and its
adjacency-to-wiki-links boundary — the parts of `renderDocument`/`renderDocumentDetailed`
that are `TS_BASELINE` `src/render.ts`'s own orchestration rather than any one owned module's).

### Containment — this repo is published, and it grew up next to private ones

`tests/helpers/containment.ts` holds the rules; `tests/containment.test.ts` runs them
over every file here, **itself included**. They are part of `bun test`, so they are
covered by `bun run verify` and need no separate command. **The scan's boundary is the
whole repository minus generated/vendor skips and exactly the publication strip set —
the fixed defaults (`plans/ reviews/ references/ runs/ INITIATIVE.md DEVELOPMENT.md FEEDBACK.md .publication.json`) plus `.publication.json`'s `strip`, read live by `publicationStrip` so guard and projection cannot drift —
full stop, independent of any corpus manifest** (WP-1, `plans/gate-corpus-reframe.md`):
`collectFiles` (`tests/helpers/containment.ts`) never reads `corpus/default-manifest.json`
at all. The gate corpus and this guard are related only by one narrow, separately-pinned
assertion — no gate-corpus entry may begin `runs/`, and no corpus root may be or resolve
into `runs/` (`tests/containment.test.ts`) — which keeps the `runs/` exemption and the
gate corpus provably disjoint; it does not make the guard's scope a function of the
corpus, in either direction.

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
| `foreign-path` | a path-shaped citation whose first segment is not a directory this repo has (the strip set's control-plane directories, such as the gitignored `runs/`, count even where a checkout lacks them), not an installed package (nor a listed former one — see below), and not the sanctioned fake root — i.e. a neighbour's internal layout |
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

**Where a second checkout may live, and why it is not arbitrary.** The neighbour rule walks
**every ancestor to `/`**, collecting sibling directory names at each level, and `ownNames`
seeds itself from `basename(root)`. Two consequences that cost a sprint's worth of clones
before they were measured:

- A checkout under a **different ancestor chain** (a temp dir, say) inherits that chain's
  unrelated directory names as forbidden tokens. Measured: a worktree in the system temp
  directory produced nine findings naming other tools' scratch directories, none of them
  about this repo's content.
- A checkout whose **leaf directory is not named for the repo** loses its own name to the
  neighbour set, so the real checkout becomes "foreign" and every self-mention is flagged.
  Measured: 30 findings, all of them the repo's own name in its own README.

**A worktree at `<code-root>/.worktrees/<label>/<repo-name>` scans clean — measured, 0
findings.** The dot-named parent is invisible both to this rule (dot-directories are not
collected) and to the fleet's initiative discovery, so a scratch checkout cannot register as
a phantom initiative; the leaf keeps the repo's name; the ancestor chain matches the real
checkout's. Prefer that over a full clone: clones parked in a plain directory inside the code
root are discoverable as repositories, and three of them accumulated 633 MB and broke a
downstream generator before anyone noticed.

**This was blocked entirely until 2026-07-29**, because `collectFiles` tested `SKIP_DIRS`
only inside its `isDirectory()` branch. **In a worktree `.git` is a file**, holding
`gitdir: <absolute path to the main checkout>`, so the guard scanned it and failed on a path
**git itself wrote** — a self-inflicted finding that made worktrees unusable and pushed
dispatched work into clones. The skip now matches by name before type. Two regression tests
pin it.

**If you check a dependency out beside your clone, that is handled — but on evidence.**
The neighbour rule drops a name that collides with an installed package *only* when the
directory proves it is that package: a `package.json` naming itself. Otherwise reading a
dependency's source next door — as this repo's own history needed for `marked-terminal`,
back when it was still installed and `crates/mdview/AGENTS.md` pointed readers at its file:line
citations directly — would turn every mention of it into a finding, and a guard that fails
for reasons unrelated to your change is a guard that gets switched off.
`marked-terminal` itself is no longer that live case: WP-6 of
`plans/marked-terminal-replacement.md` removed the package, and `crates/mdview/AGENTS.md`'s "How to
read this file" withdrew the instruction — its `index.js:NNN` citations are historical
evidence now, not a pointer at an installed neighbour, and the case they were the example
of is `DOCUMENTED_FORMER_PACKAGES` below, not this rule.

**A dependency this repo *removed* still gets cited, and the guard has to allow that.** The
`foreign-path` rule reads its package whitelist from `node_modules`, so uninstalling a
dependency turns every citation of its internals — in the plan that removed it, in the
forensics that justified the replacement — into a finding overnight. That is what happened
when WP-6 of `plans/marked-terminal-replacement.md` dropped `marked-terminal` and the plan's
own citation of the file it replaced was flagged. `DOCUMENTED_FORMER_PACKAGES` in
`tests/helpers/containment.ts` names each such package with the reason it is there: the two
that removal took out (`marked-terminal`, `cli-table3`), and `cli-highlight`, removed by WP-2
of `plans/colour-policy.md` — whose `dist/theme.js` and `dist/index.js` are the transcription
source for `TS_BASELINE` `src/highlight.ts`'s theme vocabulary and span grammar and are cited in that
module and in two plans. **The list grows exactly this way, one entry per recorded removal,
and it is the sanctioned response to that guard going red for this reason** — the alternative
is deleting the citation that is the evidence for the decision. **It is not a general escape
hatch and must not become one:** an entry is
legitimate only for a package that was genuinely a declared dependency of *this* repo and
was genuinely removed by a recorded work package, both checkable from
`THIRD-PARTY-LICENSES.txt`'s history. It cannot launder a private sibling's name, because a
sibling was never an npm dependency here, and it changes nothing about rules 2 and 3 — a
neighbour directory that happens to carry one of those names still has to prove itself with
a self-naming `package.json`, exactly as an installed one does.

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

**Ordinary words are the neighbour rule's sharp edge, and it constrains code, not only
prose.** `isDistinctive` lets a name be flagged mid-sentence only when it carries a separator
or a digit and is at least four characters. Everything else is flagged **only inside a code
span** — a backtick span or a double-quoted string. Several directories beside this checkout
are single ordinary English words, and three of them are words you will reach for while
writing code: 'archive', 'data' and 'scratch'. So a real git subcommand named after the first
of those, sitting in a spawn argument list; a variable called after the second, interpolated
into a template literal; or the third inside a double-quoted error message — each turns the
guard red, while the same words in running prose are fine. This is a live constraint on
**writing code here**, not just on citing paths, and it is invisible until it fires: WP-1 of
the renderer-replacement plan tripped all three in one new file.

**The sanctioned escape is a single-quoted string literal.** `CODE_SPAN` matches backtick
spans and double-quoted strings only; single quotes are excluded deliberately, because in
prose they are apostrophes and treating them as delimiters mis-brackets whole sentences. A
single-quoted literal is therefore not code context and does not trip the rule — which is why
`scripts/render-diff.ts` spells one git subcommand in single quotes where every other string
literal in that file is double-quoted, with a comment saying so. Renaming the identifier is
the other fix and usually reads better. **Do not weaken `isDistinctive`, and do not subtract
these names from the neighbour set** to make a file pass; the rule is load-bearing and these
collisions are the price of it reading the filesystem instead of a hardcoded list.

**Width-sensitive fixtures are a trap here.** `tests/fixtures/wide-table.md` is the
`--check` gate's fixture and its whole purpose is being wide, and `table.test.ts`'s
`LONG_PATH` feeds column-width assertions. When a path in either has to be replaced,
**the replacement must be no shorter** — shortening one silently weakens a binding gate
while every test stays green.

To render a file interactively:

```bash
./target/x86_64-unknown-linux-musl/release/mdview example/plan.md
```


## Why each TypeScript file remains

Under the three-stage port rule (user, 2026-10-15; `plans/rust-port-stage-3.md`) every tracked `.ts` file needs a live consumer. All run in verify's `bun test tests` step; each tests a TS instrument (or is a helper for those tests), so stays TypeScript.

| File | Guards | Verify step or decision served | Why TypeScript |
|---|---|---|---|
| `tests/ansi.test.ts` | `scripts/measure/ansi.ts` scanner spans, strip, OSC-8 | `bun test tests` | tests a TS instrument |
| `tests/overflow.test.ts` | `scripts/measure/overflow.ts` width gate | `bun test tests` | tests a TS instrument |
| `tests/render-diff-cli.test.ts` | `render-diff.ts` CLI: policy/emoji axes, channels, non-vacuity | `bun test tests` | tests a TS instrument |
| `tests/render-diff.test.ts` | differential harness internals | `bun test tests` | tests a TS instrument |
| `tests/colour-axis.test.ts` | `colour-axis.ts` gates | `bun test tests` | tests a TS instrument |
| `tests/sweep-colour-axis.test.ts` | sweep `--colour-mode` arg handling/printing | `bun test tests` | tests a TS instrument |
| `tests/sweep-cli.test.ts` | `sweep.ts` arg parsing | `bun test tests` | tests a TS instrument |
| `tests/sweep-manifest.test.ts` | sweep manifest/symlink membership | `bun test tests` | tests a TS instrument |
| `tests/gate-corpus.test.ts` | the bundled gate corpus manifest | `bun test tests` | tests a TS instrument |
| `tests/detectors.test.ts` | `scripts/measure/detectors.ts` | `bun test tests` | tests a TS instrument |
| `tests/scripts-acyclic.test.ts` | `scripts/` import DAG stays acyclic | `bun test tests` | tests a TS instrument |
| `tests/containment.test.ts` | publication containment guard | `bun test tests` | tests a TS instrument |
| `tests/helpers/containment.ts` | containment guard logic | imported by `containment.test.ts`, `gen-licenses.ts`, `render-diff.ts`, `revision.ts` | TS ruling |
| `tests/helpers/osc8.ts` | OSC-8 fixture bytes | imported by ansi/detectors/colour-axis tests | tests a TS instrument |
| `tests/helpers/render.ts` | one render via the built binary | imported by `render-diff`, `overflow` and `detectors` tests | tests a TS instrument |
