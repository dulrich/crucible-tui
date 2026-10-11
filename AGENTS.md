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
- `marked` (**lexer only — and since 2026-08-17 that is finally true**) + **this repo's own
  renderer method bodies and its own tree walk** — every renderer method lives in
  `src/inline.ts`, `src/blocks.ts`, `src/lists.ts`, `src/table.ts` and `src/render.ts`, and
  the walk that calls them is `src/walk.ts`.

  **This line said "lexer only" before 2026-08-17 and it was false then**; it was corrected to
  "lexer and parser", and WP-2 of `plans/own-the-token-walk.md` made the original claim true
  instead of merely accurate — the walk is `src/walk.ts`'s `TokenWalker` now, and it landed
  byte-identically. **What `Parser` was actually doing, and the `=> string` renderer interface
  that made owning the walk the only way past it, is `src/walk.ts`'s own header table and
  `src/AGENTS.md`'s "The walk is this repo's, and the renderer object is no longer an
  extension"**, which is where that narrative now lives, whole. Read it as history, in the
  same register as the `marked-terminal` and `cli-table3` entries below.

  `marked-terminal` did prose/list/code rendering until
  `plans/marked-terminal-replacement.md` replaced it method by method (WP-2 to WP-5)
  and removed it (WP-6, landing byte-identical); `src/AGENTS.md` carries the measured
  reasons each behaviour is required, and reads its `index.js:NNN` citations as
  historical evidence rather than live code.
- `yaml` for frontmatter parsing, `string-width` for CJK/emoji-correct column
  measurement. **Table borders, padding and alignment are emitted by `src/table.ts`
  itself** — `cli-table3` assembled the finished string until WP-3 of
  `plans/tn-review-remediation.md`; see `docs/agents/ambiguous-width.md`'s "The residual,
  named rather than papered over" for why that had to stop being true. The replaced library's own
  table renderer never received the terminal width and dropped `token.align`
  entirely, which is why the allocator was the first thing this repo owned.
- **Bun/TypeScript over the Rust default the in-house scaffolding skill prescribes
  (its Gate 2)** — recorded per that gate's "record every choice" rule. Justification:
  `marked@^14` was already pinned across the sibling tools this tool was written beside;
  the wiki-link and task-state markdown logic it needs already existed in TypeScript in
  an in-house web renderer working over the same corpus; the only other CLI-only tool in
  that family is TypeScript; and a working prototype in this stack was measured against
  the corpus before the plan was written.

## Layout

One line per module — the *why* behind each is `src/AGENTS.md` and the reference files it
indexes, and the module's own header comment is longer than either.

```text
src/cli.ts          arg parsing, width resolution, pager, --check, glyph flags
src/render.ts       marked lexer wiring, the owned renderer object, the two sentinels and
                    the code-range walk, the post-compose wrap; the list/text layout seam
                    is src/list-layout.ts's
src/list-layout.ts  the list/text layout state machine — five visitors that share one
                    render's state (list, text, paragraph, heading, blockquote), the
                    inlineDepth/quoteColumns counters, the tight-item coalesce, the
                    per-level budget and the marker-collision guards
src/walk.ts         the owned token walk — TokenWalker, which replaced marked's Parser as
                    the tree walker; the whole Parser contract, cited site by site, in its
                    header; dispatches one repo-local token type (wikilink) Parser lacked
src/layout-context.ts  the one immutable per-render value the visitors read — width, glyph
                    tier, Measure, prefix stack, fence-language resolver, emoji, colour
src/inline.ts       the owned inline visitors, the emoji pass and the colon sentinel
src/wikilink.ts     wiki-link recognition — the inline tokenizer extension marked's lexer
                    dispatches inside its own lexing pass, the WikiLinkToken it produces,
                    and styleWikiLabel, which styles a label at emission through
                    src/style.ts's applyStyleChain and, when the context carries a
                    resolver, wraps it in an OSC-8 link
src/wikiresolve.ts  where a [[slug]] points — vault-root discovery, the lazy file index,
                    D2's resolution order and the file:// URI; pure over an injected
                    filesystem, built only by src/cli.ts, never by a visitor
src/colour.ts       the one colour/hyperlink decision — resolveColourPolicy over the
                    ratified precedence matrix, and owned OSC-8 terminal detection; reads
                    no process state at all
src/ansi.ts         the one terminal-sequence grammar, both directions — scan() into an
                    ordered span sequence (SGR, OSC-8, DCS, malformed; non-text spans are
                    width 0 by construction) and the owned OSC-8 link() with tmux DCS
                    wrapping
src/style.ts        the one styling authority — the narrow committed style table and the
                    policy-driven emitter (chalk's applyStyle, plus the plain wrap
                    frontmatter needs)
src/highlight.ts    the owned syntax colorizer over highlight.js direct — the theme, the
                    span grammar and both call branches cli-highlight had, plus
                    supportsLanguage
src/blocks.ts       the owned block leaves — code, hr, html, paragraph, heading,
                    blockquote — and the shared transform
src/lists.ts        owned list composition: list, listitem, checkbox, ordered numbering,
                    task states, the per-item budget, the per-level de-drift and bullet
                    substitution
src/frontmatter.ts  YAML split and metadata block formatting
src/table.ts        the wide-table allocator — the reason the tool exists — and the
                    border/cell emitter that used to be cli-table3; its head/border
                    styling goes through src/style.ts under the resolved policy
src/text.ts         grapheme splitting + display-width padding, shared by table.ts
                    and wrap.ts (which used to reach into table.ts for them)
src/wrap.ts         ANSI-safe prose wrapping — the renderer's reflow engine; span-native
                    at both split paths, so no sequence is ever cut
src/glyphs.ts       Unicode/ASCII capability tier — handed an env object by cli.ts, like
                    colour.ts; process.env itself is read only in cli.ts, config.ts,
                    width.ts and render.ts
src/width.ts        display-width measurement + the East Asian Ambiguous probe; the only
                    module that imports string-width
src/lang.ts         fence-language alias map + the supportsLanguage() fallback,
                    reached through src/highlight.ts
src/config.ts       XDG config load + corpus-manifest path resolution, and the
                    color/hyperlinks directives
src/detectors.ts    orphan / continuation-over-indent detectors (see scripts/AGENTS.md)
src/list-lines.ts   the rendered-line primitives both render.ts and detectors.ts share —
                    stripAnsi (a derivation of src/ansi.ts's scanner, so it removes OSC-8
                    and DCS as well as SGR), the marker regexes, trackListLine; imports
                    only width.ts and ansi.ts, so render.ts reaches them without pulling
                    in the detectors
src/overflow.ts     the width gate and the code-range exemption predicate — one
                    implementation, imported by --check, the sweep and the detectors
corpus/             the bundled public-safe default manifest
scripts/corpus.ts   corpus discovery + evaluation — the sweep's library half
scripts/sweep.ts    the sweep CLI: flags, summary, exit code (see scripts/AGENTS.md)
scripts/emoji-audit.ts  the emoji shortcode behavioural audit — renders every :shortcode:
                    in the corpus twice, substitution forced on then off, and keeps only
                    tokens whose bytes differ; a second consumer of corpus.ts and sweep.ts
scripts/colour-axis.ts  the colour axis — the four children, the v2 wire record, G1/G2/G3
                    and the join; a consumer of corpus.ts, never the reverse
scripts/render-diff.ts  the differential CLI: flags, corpus selection, baseline I/O,
                    pairing, printing, exit codes
scripts/revision.ts one revision's renderer, materialized and loaded, plus the comparison
                    tuple's vocabulary; reaches src/ only by dynamic absolute-path import
scripts/diff-classify.ts  the differential's pure half — combo records, the four-channel
                    diff, the class-A/B/C classification; no process, file, argv or clock
scripts/hash.ts     sha256Hex — the one digest both instruments compare against archived
                    runs; a leaf, imports nothing
scripts/sweep-options.ts  DEFAULT_WIDTHS + parseWidths — the width grammar both CLIs
                    parse; a leaf, imports nothing
scripts/gen-licenses.ts  generates THIRD-PARTY-LICENSES.txt from the actual installed
                    runtime dependency closure (dependencies + optionalDependencies,
                    transitively) — never devDependencies or all of node_modules
scripts/verify.ts   the canonical bun run verify entrypoint — every gate in fail-fast
                    order plus the build/smoke/license-freshness gates; a leaf, imports
                    nothing from scripts/
tests/              unit tests + markdown fixtures
tests/scripts-acyclic.test.ts  the gate that keeps scripts/ a DAG (see scripts/AGENTS.md)
tests/helpers/containment.ts  the publication guard's rules (see tests/AGENTS.md)
tests/helpers/block-parity.ts  the block-leaf parity table — code/hr/html against
                    marked-terminal, byte for byte
tests/helpers/block-parity-golden.ts  the frozen marked-terminal block-leaf byte
                    table, captured before removal
tests/helpers/color.ts  the forced-colour subprocess fixture — runs a table under
                    FORCE_COLOR=3 for the colour-on half of a parity test
tests/helpers/inline-parity.ts  the inline parity table — every owned inline visitor
                    against the marked-terminal method it replaced, byte for byte
tests/helpers/inline-parity-golden.ts  the frozen marked-terminal inline byte table,
                    captured before removal
dist/mdview         compiled binary (gitignored; see PATH install below)
```

## Child docs and reference files — the index

This root file carries what a session needs whatever it touches: identity, the two-names
decision, the Stack, the Layout tree, the Run/verify contract, Conventions and the live
dependency rules. Everything subtree-specific lives in a child `AGENTS.md` beside the code
it describes, each with its own `CLAUDE.md` symlink. Read the root, then the nearest child.

| File | Carries |
|---|---|
| `src/AGENTS.md` | what the owned renderer must do and the measured defect behind each requirement, what owning the walk moved off `marked.use()`, the parity classes, the sentinels, the task-state pre-pass, the colour-only-defect class, the glyph tier, the command-line surface, the rendering policy, the `emoji` re-decision — and the index to the reference files below |
| `scripts/AGENTS.md` | the corpus sweep and its manifests, the corpus growth findings, the defect detectors, the fast and durable measurement tiers |
| `tests/AGENTS.md` | the publication containment guard's rules and internals, and the width-sensitive fixture trap |

**The deep records live under `docs/agents/`, and are read on demand rather than loaded on
every turn** — they deliberately have **no `CLAUDE.md` symlink**, which is the whole point
of the split (WP-4 of `plans/docs-and-memory-curation.md`). Nothing was rewritten to move
them there; every section title is unchanged and every old home carries a pointer.

| File | Carries |
|---|---|
| `docs/agents/list-pipeline.md` | composition, the two wrap paths, the de-drift, the claim domains, and the retained passes |
| `docs/agents/wiki-link-record.md` | the wiki-link carrier defect and its fix: context table, precedence matrix, the three further defects, the three failed fix designs, and witness ownership |
| `docs/agents/colour.md` | the one owned colour/hyperlink decision, `SgrMode`'s three levels, the reader inventory, and the resolution history |
| `docs/agents/ambiguous-width.md` | the ambiguous-width question, the probe and its cache identity, why `wide` forces ASCII, and the table-emitter residual |
| `docs/agents/dependency-history.md` | the forensic record of every dependency removal — the evidence behind this file's dependency rules |

## Run

From the repository root, the verification contract is two commands (WP-1 of
`plans/tn-review-remediation.md` — one canonical entrypoint, called identically here and
from CI):

```bash
bun install
bun run verify
```

`bun run verify` (`scripts/verify.ts`) runs every gate in fail-fast order, printing which
step failed and exiting non-zero at the first one that does. In order, it runs:

```bash
bun run typecheck
bun run lint
bun test tests
bun run build
./dist/mdview --check --width 80 tests/fixtures/wide-table.md
bun run scripts/gen-licenses.ts --check
bun run src/cli.ts --check --width 80 tests/fixtures/wide-table.md
bun run sweep
bun run sweep -- --glyphs ascii
bun run sweep -- --colour-mode both
bun run test:security
```

That list is the explanation of what `verify` does, not a second thing to run by hand —
every command in it is byte-identical to the gate that already existed for it, plus three
that existed but were not wired into any single chain before WP-1 of
`plans/tn-review-remediation.md`: the compiled build, a smoke of the built artifact (a
build step alone cannot see a broken binary), and license freshness in `--check` mode
(renders to memory and compares against `THIRD-PARTY-LICENSES.txt`, so a failing local
run never leaves the tree dirty — the default `bun run gen-licenses`, with no flag, still
writes). The colour-axis sweep joined the chain afterward, for a different reason: three
exact gates, no thresholds, over the fixed gate corpus — a colour decision may change
which bytes a render emits, never which characters, and an undirected, piped render must
emit no terminal sequence at all (`scripts/AGENTS.md`, "The colour axis — three exact
gates over four children", carries the gate definitions and history).

**`verify` never runs `bun install`.** Local floats (`bun install`), CI freezes (`bun
install --frozen-lockfile`), and that asymmetry is deliberate — installation stays a
separate step, run once before `verify`, in both places.

**Flag order matters.** `bun run --cwd <dir> <script>` works; `bun --cwd <dir> run
<script>` does **not** — on Bun 1.3.11 it prints `bun run`'s help text and **exits 0**,
i.e. it silently passes without executing the script. Verified reproducible in a second,
unrelated package, so it is a Bun CLI behavior, not a quirk of this one. Never write the
second form into a gate: it is a gate that can never fail.

The `--check` step is the CLI's own self-smoke: it renders with no pager and exits
non-zero if any output line exceeds the target width. Every step `bun run verify` runs is
binding and must exit 0.

### Security gate bootstrap (trivy)

The security step runs `bun run test:security`
(`trivy fs --scanners vuln --include-dev-deps --skip-db-update --exit-code 1 --severity CRITICAL,HIGH .`) —
offline by design, so a normal `bun run verify` never touches the network for it. That
means it fails on a machine that has never run trivy before: trivy absent from PATH (exit
127), or a cold/stale vulnerability DB cache (trivy's own "cannot skip downloading DB" /
"--skip-db-update cannot be specified on the first run" errors; the DB also expires
roughly daily). `scripts/verify.ts` preflights for both cases and fails with a loud,
actionable message instead of a raw 127 or FATAL — it does **not** skip the gate with a
warning, because a security scan that can silently not-run is worse than no gate at all
(see "Flag order matters" above). One-time bootstrap, on a fresh clone or after the DB
goes stale:

```bash
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \
  | sh -s -- -b ~/.local/bin v0.73.0
trivy fs --scanners vuln --include-dev-deps --exit-code 0 --severity CRITICAL,HIGH .
```

The second command warms the DB cache (network required); after that, `bun run
test:security` and therefore `bun run verify` run fully offline via `--skip-db-update`
until the cache goes stale again.

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
  bundle. It is ~102 MB decimal / 97 MiB (the Bun runtime is embedded) and
  gitignored via `dist/`.

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

### Dependencies (WP-5, re-measured at WP-6/WP-7)

The premise this WP started from — "trim dependency fat to shrink the binary" —
inverted once it was measured. Record that inversion here so nobody re-derives it and
re-opens a removal pass that costs review time for zero benefit.

**The dependency classification rule (`plans/colour-policy.md`, "Decisions locked",
written here at that plan's WP-5).** Every runtime dependency this repo has ever carried
falls into exactly one of three classes, and only one of them is allowed to stay:

- **Domain data / algorithm dependencies stay.** `marked` (the lexer), `highlight.js`,
  `string-width`, `yaml`, `node-emoji` — each one is a grammar, a corpus, or an algorithm
  this repo does not want to re-derive, and none of them decides anything from
  environment/argv/TTY at module load or writes an escape byte on this repo's behalf.
- **Policy dependencies — anything reading env/argv/TTY at module load to decide — are
  owned here, not imported.** `supports-color` and `supports-hyperlinks` (removed WP-1 of
  `plans/colour-policy.md`), `@colors/colors` and `cli-highlight`'s bundled `chalk` theme
  (removed WP-2) were each exactly this: a decision this renderer needs, made by a
  package reading the process rather than by a value handed in. `src/colour.ts` is what
  replaced all of them — the one place that decision is made, from inputs threaded in
  explicitly.
- **Emission dependencies — anything writing terminal escape bytes — are owned here,
  not imported.** `ansi-escapes` (removed WP-3) was the last one: this repo's own
  `src/style.ts` (SGR) and `src/ansi.ts` (OSC-8, DCS) are the only places an escape byte
  is spelled now.

Applying that rule to this plan's own closure took runtime dependencies to **five, all
domain-data, zero load-time globals, zero third-party escape emission** — `marked`,
`highlight.js`, `string-width`, `yaml`, `node-emoji`, exactly the list above. **One
caveat, recorded rather than resolved:** `marked`'s lexer is the one keeper whose
interface is a real constraint rather than a preference — it has no source-offset API,
which is the interface gap `docs/adr/0001-editor-path.md`'s `{text, style, sourceStart,
sourceEnd}` return type is blocked behind, exactly as `src/walk.ts`'s header records for
the walk it replaced. Owning the lexer is not this plan's scope; the classification rule
above is what a future plan that does own it will still have to satisfy.

**Binary size is not a dependency problem.** The compiled binary (`bun build
--compile`, see "Conventions" above) is ~102 MB, almost entirely Bun's own embedded
runtime — present in every Bun-compiled binary regardless of what a project imports.
The actual runtime dependency closure — `marked`, `highlight.js`, `node-emoji`,
`string-width`, `yaml`, and everything each pulls in transitively — is
**13 packages** (measured at WP-3 of `plans/pictograph-width.md`, whose `string-width` 7.2.0 → 8.2.2 bump dropped `emoji-regex`; **14** at WP-3 of `plans/colour-policy.md`, which removed
`ansi-escapes` and, with it, `environment`; **16** after WP-2 of the same plan, which
removed `@colors/colors` and `cli-highlight`; **45** after WP-1, **46, ~8.6 MB**
at WP-7 before that; `bun run gen-licenses --check` walks exactly that closure and prints
the count). **29 packages left in one work package and the notice file went 974 → 368
lines**, because `cli-highlight` carried a CLI's worth of freight — `yargs`, `cliui`,
`mz`, `parse5`, the htmlparser2 tree adapter, `chalk@4` and its `supports-color` — into a
library this repo only ever called two functions of. That is the largest single closure
reduction in the repo's history and it was **not** taken for size: it is the
dependency-ownership rule (below) applied to policy and emission. The rest of
`node_modules` — **~63 MB installed in total** — is
devDependency tooling: `oxlint`, `typescript`,
`@types/bun`, and their own transitive closures, which never ship in the binary at
all. Dependency weight is therefore a **couple of percent of the compiled artifact**.
"Remove a dependency to shrink the binary" is the wrong frame for this tool; no
dependency was removed on that basis, and none should be without re-measuring what
actually changes. (This section recorded 60 packages when it was written at WP-5; the
count is a measurement, not a target, and it is re-measured rather than adjusted.)

**The declaration rule, and it runs in both directions.** A package this repo's source
imports is declared here, whatever a reachability tool says — `node-emoji` is declared
because `src/inline.ts` imports it by name, `highlight.js` because `src/highlight.ts` does.
And: **a package this repo's source stopped importing is undeclared here, even if it is
still installed** — `supports-color` is still in `bun.lock` as a devDependency's transitive,
and is undeclared, correctly. Undeclaring a package and removing it from the closure are two
different events.

**The removal forensics are `docs/agents/dependency-history.md`** — one file, ordered by plan
and work package, moved there whole at WP-4 of `plans/docs-and-memory-curation.md` with no
fact dropped. It carries: the declaration rule's own evidence paragraph and the two styling
packages it removed (`@colors/colors`, `cli-highlight`, WP-2 of `plans/colour-policy.md`);
`cli-table3`'s two-part exit (WP-3 of `plans/tn-review-remediation.md`, then WP-6 of
`plans/marked-terminal-replacement.md`) and the piped-colour defect its declaration slot
caused; `supports-color`/`supports-hyperlinks` (WP-1) and the both-directions story;
the `chalk@4.1.2` residue and what it stopped deciding; `ansi-escapes` (WP-3), the last
third-party escape *emitter*, and the OSC-8/tmux transcription that replaced it; the
third question that WP-3 added — what layout can *see*, and why `stripAnsi` and
`src/wrap.ts` are derivations of `src/ansi.ts`'s scanner now; and the `highlight.js` pin
history. The wiki-link carrier's own retirement paragraph is
`docs/agents/wiki-link-record.md`, the one owning home for that story.

**Pins.** `package.json`'s `dependencies` are pinned to the exact versions already
installed and exercised by this test suite — `marked@14.1.4`, `highlight.js@10.7.3`,
`node-emoji@2.2.0`, `string-width@8.2.2`, `yaml@2.9.0` — rather
than left on `^` ranges that could silently
resolve to an untested minor on a fresh `bun install` on a different machine. The four
promoted from transitive to direct in WP-6 of `plans/marked-terminal-replacement.md`
were pinned at **the versions already installed**, so the promotion added no package and
moved no byte; two of those four — `supports-color` and `supports-hyperlinks` — left the
list again at WP-1 of `plans/colour-policy.md`, `cli-highlight` and `@colors/colors`
at WP-2 (which pinned `highlight.js` at the version its own removal had left installed),
and the last of the four, `ansi-escapes@7.3.0`, at WP-3.
None of those removals moved a byte: the forced-colour render is byte-identical across
both packages. **This rule pins; it does not upgrade.** Bumping any of these is a separate,
deliberate decision with its own corpus/sweep verification pass, not a side effect of
installing on a new machine.

**One pin carries a caveat: `highlight.js` is held at `10.7.3`, two majors behind upstream,
and it is not a version a session bumps unilaterally.** Major versions change *which spans
it emits*, so every fenced block in the corpus can change its forced-colour bytes — parity
class C. What a bump owes before it lands, and why the pin was transitive until WP-2 of
`plans/colour-policy.md` made it this repo's own, is `docs/agents/dependency-history.md`,
"`highlight.js` — the one keeper with a pin history". **`string-width` has had one deliberate bump, 7.2.0 → 8.2.2 (`plans/pictograph-width.md`)**, and it is the worked example of what a pin bump owes: a measured render-time budget in both colour modes, a per-cluster cache in `src/width.ts` to meet it, and a cross-bump corpus pass with every class-B diff attributed — `docs/agents/dependency-history.md`, "`string-width` — the one bump, and what it cost".

Plans: the founding pair is `plans/mdview.md` (the original build) and
`plans/vault-readiness.md` (glyph tier, fence languages, divider, embeds, and the
multi-corpus sweep). The two sat at different levels before extraction — the first
predated the tool's own folder — and were flattened into one `plans/` when this repo was
split out. Every plan since has followed; every file in `plans/` carries a Status line
(provisional → audited → approved → implemented) directly under its title, so the
directory itself is the index — read it, don't enumerate it here.
