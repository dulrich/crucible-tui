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
  instead of merely accurate. Read the following as history, in the same register as the
  `marked-terminal` and `cli-table3` entries below.

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

  `marked-terminal` did prose/list/code rendering until
  `plans/marked-terminal-replacement.md` replaced it method by method (WP-2 to WP-5)
  and removed it (WP-6, landing byte-identical); `src/AGENTS.md` carries the measured
  reasons each behaviour is required, and reads its `index.js:NNN` citations as
  historical evidence rather than live code.
- `yaml` for frontmatter parsing, `string-width` for CJK/emoji-correct column
  measurement. **Table borders, padding and alignment are emitted by `src/table.ts`
  itself** — `cli-table3` assembled the finished string until WP-3 of
  `plans/tn-review-remediation.md`; see `src/AGENTS.md`'s "The residual, named rather
  than papered over" for why that had to stop being true. The replaced library's own
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

```text
src/cli.ts          arg parsing, width resolution, pager, --check, glyph flags
src/render.ts       marked lexer wiring, the owned renderer object, the two
                    sentinels and the code-range walk, the tight-item text seam,
                    and the post-compose list wrap
src/walk.ts         the owned token walk — TokenWalker, which replaced marked's
                    Parser as the tree walker (WP-2 of plans/own-the-token-walk.md);
                    the whole Parser contract, cited site by site, in its header
src/layout-context.ts  the one immutable per-render value the visitors read —
                    width, glyph tier, Measure, prefix stack, fence-language
                    resolver, emoji and colour (WP-2)
src/inline.ts       the owned inline visitors, the emoji pass and the colon
                    sentinel (WP-2)
src/wikilink.ts     wiki-link recognition (frozen), the carrier pair (code points
                    2/3) that marks a label through the lexer and the walk, and the
                    post-walk pass that styles each balanced pair through
                    src/style.ts and strips every carrier; replaced styleWikiLink's
                    pre-lexer SGR (WP-4 of plans/colour-policy.md)
src/colour.ts       the one colour/hyperlink decision — resolveColourPolicy over
                    the ratified precedence matrix, and owned OSC-8 terminal
                    detection; reads no process state at all (WP-1 of
                    plans/colour-policy.md); hyperlinks gained their own
                    flag/config precedence slots at WP-3 of
                    plans/colour-modes.md
src/ansi.ts         the one terminal-sequence grammar, both directions — scan()
                    into an ordered span sequence (SGR, OSC-8, DCS, malformed;
                    non-text spans are width 0 by construction) and the owned
                    OSC-8 link() with tmux DCS wrapping; replaced ansi-escapes
                    (WP-3 of plans/colour-policy.md)
src/style.ts        the one styling authority — the narrow committed style table
                    and the policy-driven emitter (chalk's applyStyle, plus the
                    plain wrap frontmatter needs); replaced @colors/colors
                    (WP-2 of plans/colour-policy.md)
src/highlight.ts    the owned syntax colorizer over highlight.js direct — the
                    theme, the span grammar and both call branches cli-highlight
                    had, plus supportsLanguage (WP-2)
src/blocks.ts       the owned block leaves — code, hr, html, paragraph, heading,
                    blockquote — and the shared transform (WP-3)
src/lists.ts        owned list composition: list, listitem, checkbox, ordered
                    numbering, task states, the per-item budget, the per-level
                    de-drift and bullet substitution (WP-4/WP-5)
src/frontmatter.ts  YAML split and metadata block formatting
src/table.ts        the wide-table allocator — the reason the tool exists — and,
                    since WP-3 of plans/tn-review-remediation.md, the border/cell
                    emitter that used to be cli-table3; its head/border styling
                    goes through src/style.ts under the resolved policy (WP-2 of
                    plans/colour-policy.md)
src/text.ts         grapheme splitting + display-width padding, shared by table.ts
                    and wrap.ts (which used to reach into table.ts for them)
src/wrap.ts         ANSI-safe prose wrapping — the renderer's reflow engine;
                    span-native at both split paths since WP-3 of
                    plans/colour-policy.md, so no sequence is ever cut
src/glyphs.ts       Unicode/ASCII capability tier — the only module that reads env
                    (src/colour.ts is handed one instead of reading it)
src/width.ts        display-width measurement + the East Asian Ambiguous probe (WP-3);
                    the only module that imports string-width
src/lang.ts         fence-language alias map + the supportsLanguage() fallback,
                    reached through src/highlight.ts
src/config.ts       XDG config load + corpus-manifest path resolution, and the
                    color/hyperlinks directives
src/detectors.ts    orphan / continuation-over-indent detectors
                    (see scripts/AGENTS.md)
src/list-lines.ts   the rendered-line primitives both render.ts and detectors.ts
                    share — stripAnsi (a derivation of src/ansi.ts's scanner
                    since WP-3 of plans/colour-policy.md, so it removes OSC-8
                    and DCS as well as SGR), the marker regexes, trackListLine
                    (WP-5 of plans/tn-review-remediation.md); imports only
                    width.ts and ansi.ts, so render.ts reaches them without
                    pulling in the detectors
src/overflow.ts     the width gate and the code-range exemption predicate — one
                    implementation, imported by --check, the sweep and the detectors
corpus/             the bundled public-safe default manifest
scripts/corpus.ts   corpus discovery + evaluation — the sweep's library half (WP-4)
scripts/sweep.ts    the sweep CLI: flags, summary, exit code (see scripts/AGENTS.md)
tests/              unit tests + markdown fixtures
tests/helpers/containment.ts  the publication guard's rules (see tests/AGENTS.md)
dist/mdview         compiled binary (gitignored; see PATH install below)
```

## Child docs — the index

This root file carries what a session needs whatever it touches: identity, the two-names
decision, the Stack, the Layout tree, the Run/verify contract, Conventions and the
dependency record. Everything subtree-specific lives in a child `AGENTS.md` beside the
code it describes, each with its own `CLAUDE.md` symlink. Read the root, then the nearest
child.

| File | Carries |
|---|---|
| `src/AGENTS.md` | what the owned renderer must do and the measured defect behind each requirement, what owning the walk moved off `marked.use()`, the parity classes, the list pipeline, the sentinels, the glyph tier, the command-line surface, ambiguous width and the probe, the rendering policy, the `emoji` re-decision |
| `scripts/AGENTS.md` | the corpus sweep and its manifests, the corpus growth findings, the defect detectors, the fast and durable measurement tiers |
| `tests/AGENTS.md` | the publication containment guard's rules and internals, and the width-sensitive fixture trap |

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
bun run test:security
```

That list is the explanation of what `verify` does, not a second thing to run by hand —
every command in it is byte-identical to the gate that already existed for it, plus three
that existed but were not wired into any single chain before WP-1: the compiled build, a
smoke of the built artifact (a build step alone cannot see a broken binary), and license
freshness in `--check` mode (renders to memory and compares against
`THIRD-PARTY-LICENSES.txt`, so a failing local run never leaves the tree dirty — the
default `bun run gen-licenses`, with no flag, still writes).

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
(`trivy fs --scanners vuln --skip-db-update --exit-code 1 --severity CRITICAL,HIGH .`) —
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
trivy fs --scanners vuln --exit-code 0 --severity CRITICAL,HIGH .
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
**14 packages** (measured at WP-3 of `plans/colour-policy.md`, which removed
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
devDependency tooling: `eslint`, `typescript`, `typescript-eslint`, `jiti`,
`@types/bun`, and their own transitive closures, which never ship in the binary at
all. Dependency weight is therefore a **couple of percent of the compiled artifact**.
"Remove a dependency to shrink the binary" is the wrong frame for this tool; no
dependency was removed on that basis, and none should be without re-measuring what
actually changes. (This section recorded 60 packages when it was written at WP-5; the
count is a measurement, not a target, and it is re-measured rather than adjusted.)

**The declaration rule is unchanged and it is what removed both styling packages.** A
package this repo's source imports is declared here, whatever a reachability tool says —
`node-emoji` is declared because `src/inline.ts` imports it by
name, `highlight.js` because `src/highlight.ts` does. (`ansi-escapes` was declared under
the same rule for the same file's `ansiEscapes.link` call, and left at WP-3 of
`plans/colour-policy.md` the moment that import did — see the OSC-8 paragraph below.) `cli-highlight` and
`@colors/colors` were declared under exactly that rule while `src/lang.ts` imported
`supportsLanguage` and `src/table.ts` imported `@colors/colors/safe`; **WP-2 of
`plans/colour-policy.md` deleted both imports, so both declarations went with them.**
What replaced them is this repo's own code: `src/style.ts` holds a narrow committed style
table (the `[open, close]` pairs this renderer is authorized to emit, `38`/`48`
introducers banned by an independent assertion) and the emitter over it, and
`src/highlight.ts` is the colorizer `cli-highlight` used to be, over `highlight.js`
direct. The bytes did not move: the forced-colour render of every gate-corpus file is
byte-identical across that package at every width and both glyph tiers.

**And the rule runs in both directions, which WP-1 of `plans/colour-policy.md` is the
first package to exercise.** `supports-color` and `supports-hyperlinks` were promoted to
direct dependencies in WP-6 under exactly the sentence above, and they were undeclared
again the moment `src/colour.ts` took over the two decisions they were consulted for and
no file here imported either. Nothing about the rule changed; the imports did. **A
package this repo's source stopped importing is undeclared here, even if it is still
installed** — which `supports-color` still is, and legitimately: `cli-highlight → chalk@4
→ supports-color` kept it in the runtime closure until WP-2 removed `cli-highlight`, and
the devDependency `eslint` keeps it in `bun.lock` now. Undeclaring a package and removing
it from the closure are two different events, and at WP-1 they happened to two different
packages: the licence file lost `supports-hyperlinks` alone, 46 → 45. **Both halves
completed at WP-2**, one package apart from each other: `supports-color` left the runtime
closure with the `cli-highlight → chalk@4` path that was its only remaining requirer, and
it is still in `bun.lock` — dev-only — exactly as recorded.

**`cli-table3` is gone from `node_modules` entirely, and that closes a two-part note
this section used to carry.** It left `dependencies` in WP-3 of
`plans/tn-review-remediation.md`, when `src/table.ts` stopped importing it and started
emitting its own borders, but stayed physically installed because `marked-terminal`
required `^0.6.5` — so it stayed in the closure `scripts/gen-licenses.ts` walks and in
`THIRD-PARTY-LICENSES.txt`. WP-6 of `plans/marked-terminal-replacement.md` removed the
only thing requiring it, and it left with a nested `chalk@5.6.2`; the licence file went
1,059 → 990 lines, 49 → 46 packages. `@colors/colors` took the declaration slot it
vacated, deliberately: the emitter had to reproduce the old `style: { head: ["bold"],
border: ["grey"] }` bytes, that package decided whether to colour at all, and
reproducing its decision by hand looked like fidelity risk spent to change nothing on
purpose. **That last clause turned out to be the defect.** Its decision consulted the
environment and *not* `isTTY` — `cli-table3` called `colors.supportsColor()` with no
stream argument — so a plain `mdview wide-table.md | cat` emitted 205 grey pairs and 12
bold pairs into a pipe with no colour requested at all, which is what Decision 1 of
`plans/colour-policy.md` forbids. WP-2 of that plan took the declaration back out: the
two pairs are committed literals in `src/style.ts` and the gate is the resolved policy.

**A `chalk@4.1.2` still sits in the tree** — as **eslint's** transitive now, `cli-highlight`
having left at WP-2 — so it is a devDependency of a devDependency and ships in nothing.
This repo neither imports it nor reads its level. It used to say the colour answer came
from `supports-color` — the same implementation `chalk` wraps, measured to agree with it
on a 36-cell environment matrix — and since WP-1 of `plans/colour-policy.md` the answer is
`src/colour.ts`'s own, resolved from inputs handed in rather than asked of any library
(`src/AGENTS.md`, "Colour"). What `chalk@4` still decided after that was `cli-highlight`'s
syntax colours, and **that disagreement is closed**: `src/highlight.ts` applies the same
byte pairs through `src/style.ts` under the resolved policy, and `chalk`'s own
`applyStyle` rules — the nested re-open and the line-break encasing — are transcribed
there rather than imported.

**`ansi-escapes` was the last third-party escape *emitter*, and WP-3 of
`plans/colour-policy.md` closed that half of the rule.** It was one function —
`ansiEscapes.link` — called once, in `src/inline.ts`, and it carried two things this repo
had to own: the OSC-8 byte grammar itself, and an `isTmux` constant computed from
`process.env` **at module load** (`base.js:12`), which is exactly the shape the
policy-dependency half of the rule removes. `src/ansi.ts` is the transcription (`link` and
`wrapOsc`, cited line by line there); the tmux answer is `resolveTmux`'s
(`src/colour.ts`), resolved once per render from an environment handed in and carried on
the policy; and the destination is sanitized at emission, which the library did not do and
could not have, since it never saw document content. The package left with its own
transitive `environment` — 16 → **14** packages, `THIRD-PARTY-LICENSES.txt` 368 → **338**
lines. **The renderer now emits no escape byte that this repo does not spell**: SGR through
`src/style.ts`'s committed table, syntax colours through `src/highlight.ts`, OSC-8 and its
tmux envelope through `src/ansi.ts`. **There is no exception left**: this sentence carried
one — `styleWikiLink`'s pre-lexer pair (`src/render.ts`) — and WP-4 of the same plan retired
it. That function spelled `\x1b[36m\x1b[4m…\x1b[24m\x1b[39m` by hand and put it into the
*markdown source*, before the lexer, at every colour level including colourless, so it
violated all three halves of the rule at once: it decided (nothing gated it), it emitted
(bytes no committed table authorized), and it put tool-generated escapes into the one input
every downstream claim is about. `src/wikilink.ts` replaced it with a **carrier pair** —
control code points 2 and 3, the same idiom the two existing sentinels use — marking the
label through the lexer and the walk; a pass over the finished document styles each balanced
pair through `src/style.ts` under the resolved policy and removes every carrier, balanced or
not. **No ESC byte this tool generates now enters the lexer** (asserted directly, by
comparing authored-ESC positions and counts across `preprocessBody` rather than by demanding
ESC absence, which Decision 1's fidelity rule for authored escapes forbids). The colour axis
over the fixed gate corpus reads `sgrAny` **5 → 0** with `charDiff=0` held, and the
forced-colour render did not move a byte in any of the 84 colour-on combos measured.

**And the same module is what layout reads.** The dependency-ownership rule is about who
*decides* and who *emits*; WP-3 added the third question — what layout can *see* — because
`stripAnsi` removed SGR only and `src/wrap.ts` kept a second private copy of that same
SGR-only vocabulary. Both are derivations of `src/ansi.ts`'s scanner now, which is why an
OSC-8 hyperlink is no longer measured as its own destination URL.

**`highlight.js` is pinned at `10.7.3`**, two majors behind upstream — and since WP-2 of
`plans/colour-policy.md` that is **this repo's own direct pin**, not a transitive one. It
still cannot be subset to shrink it: the package's entry point is the full bundled
language set, and `src/highlight.ts` calls `hljs.highlightAuto` for an unlabelled fence,
which needs every grammar loaded by construction. What changed is only who owns the pin.

**It is a domain-data dependency and stays.** The dependency-ownership rule
(`plans/colour-policy.md`) removes *policy* dependencies (anything reading env/argv/TTY at
module load to decide) and *emission* dependencies (anything writing escape bytes);
grammars are neither. `cli-highlight` was one package doing both jobs at once — grammar
lookup plus a `chalk`-gated theme — which is why the split fell where it did.

**This used to be blocked rather than deferred, and WP-2 of `plans/colour-policy.md`
unblocked it without bumping anything.** The record below is kept because the distinction
it draws is the useful part; what has changed is that the blocker is gone. "Deferred"
describes a choice — do it later, on purpose, when it is someone's priority — and until
WP-2 there was no such choice available: the pin was transitive, owned by
`cli-highlight@2.1.11`'s own dependency declaration, and this repo had no `highlight.js`
import of its own to bump, because `src/lang.ts` reached `cli-highlight`'s
`supportsLanguage` and never `highlight.js` directly. **Both facts are now false**:
`src/highlight.ts` imports `highlight.js` by name and `package.json` pins it, so a bump is
this repo's decision to make. It is a *deferred* one, and the cost it was always going to
carry is unchanged — see below. Moving past
`10.7.3` is now a straight version bump in `package.json` — and it is still **not** a
change a future session should make unilaterally, for the reason that always sat under
the blocker: highlight.js's major versions change *which spans it emits*, so every fenced
block in the corpus can change its forced-colour bytes, which is parity class C. It needs
its own compatibility check against `src/lang.ts`'s fence-language handling, its own
per-token-class byte comparison against `src/highlight.ts`'s theme (the `10.x` class
vocabulary is what that theme is total over — `11.x` renamed several scopes), and its own
corpus pass. Recorded here so a future pass does not "fix" the staleness by bumping a
major version with nothing else in place.

**Pins.** `package.json`'s `dependencies` are pinned to the exact versions already
installed and exercised by this test suite — `marked@14.1.4`, `highlight.js@10.7.3`,
`node-emoji@2.2.0`, `string-width@7.2.0`, `yaml@2.9.0` — rather
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

Plans: `plans/mdview.md` (the original build) and `plans/vault-readiness.md` (glyph tier,
fence languages, divider, embeds, and the multi-corpus sweep). The two sat at different
levels before extraction — the first predated the tool's own folder — and were flattened
into one `plans/` when this repo was split out.
