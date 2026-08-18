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
- `marked` (**lexer and parser**) + **this repo's own renderer method bodies** — every
  renderer method lives in `src/inline.ts`, `src/blocks.ts`, `src/lists.ts`, `src/table.ts`
  and `src/render.ts`. **This line said "lexer only" until 2026-08-17 and that was false**,
  in a way that matters structurally rather than pedantically: `src/render.ts:1397` calls
  `instance.parse(...)`, so **marked's `Parser` is the tree walker**, and the owned methods
  are callbacks it invokes — they re-enter it **9 times** via `this.parser.parse(tokens, top)`
  and `this.parser.parseInline(tokens)` (`src/render.ts:923,926,931,934,996,1108,1319,1372,1388`;
  a tenth match at `:290` is prose). **`Parser` is not a bare dispatcher**, and a plan that
  assumes it is will be wrong: `marked.cjs:1975-1990` coalesces consecutive block `text` tokens
  with `\n` and, when `top`, wraps the result in a **synthesized `paragraph` token** whose
  `tokens` array is fabricated; `parseInline` routes `escape` to `renderer.text` and takes an
  optional renderer override (`:2013`); `space` has no owned method and falls through to
  marked's default (`''`, `:1695`); an unknown type **throws** unless `silent`. `marked.use()`
  (`:2248-2268`) additionally binds the receiver — this is where `this.parser` comes from —
  falls back to the previous renderer when a method returns `false`, and coerces every falsy
  return to `''`. The consequence is a hard interface constraint:
  marked's renderer callbacks are typed `=> string` (`marked.d.ts:349-365`, `parseInline`
  at `:226`/`:234`), so **a renderer method cannot return anything but a string** — no
  styled spans, no source ranges. Any work that needs a richer return type (the
  style-last direction, or `docs/adr/0001-editor-path.md`'s
  `{text, style, sourceStart, sourceEnd}`) must **own the token walk** first; the lexer is
  the part worth keeping. `marked-terminal` did prose/list/code rendering until
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
src/render.ts       marked lexer wiring, the owned extension object, the two
                    sentinels and the code-range walk, the tight-item text seam,
                    and the post-compose list wrap
src/layout-context.ts  the one immutable per-render value the visitors read —
                    width, glyph tier, Measure, prefix stack, fence-language
                    resolver, emoji and colour (WP-2)
src/inline.ts       the owned inline visitors, the emoji pass and the colon
                    sentinel, and detectInlineColor() (WP-2)
src/blocks.ts       the owned block leaves — code, hr, html, paragraph, heading,
                    blockquote — and the shared transform (WP-3)
src/lists.ts        owned list composition: list, listitem, checkbox, ordered
                    numbering, task states, the per-item budget, the per-level
                    de-drift and bullet substitution (WP-4/WP-5)
src/frontmatter.ts  YAML split and metadata block formatting
src/table.ts        the wide-table allocator — the reason the tool exists — and,
                    since WP-3 of plans/tn-review-remediation.md, the border/cell
                    emitter that used to be cli-table3
src/text.ts         grapheme splitting + display-width padding, shared by table.ts
                    and wrap.ts (which used to reach into table.ts for them)
src/wrap.ts         ANSI-safe prose wrapping — the renderer's reflow engine
src/glyphs.ts       Unicode/ASCII capability tier — the only module that reads env
src/width.ts        display-width measurement + the East Asian Ambiguous probe (WP-3);
                    the only module that imports string-width
src/supports-color.d.ts  minimal ambient shim for supports-color, which ships no
                    types at this major; replaced src/marked-terminal.d.ts in role,
                    with no cast (WP-6)
src/lang.ts         fence-language alias map + supportsLanguage() fallback
src/config.ts       XDG config load + corpus-manifest path resolution
src/detectors.ts    orphan / continuation-over-indent detectors
                    (see scripts/AGENTS.md)
src/list-lines.ts   the rendered-line primitives both render.ts and detectors.ts
                    share — stripAnsi, the marker regexes, trackListLine (WP-5 of
                    plans/tn-review-remediation.md); imports only width.ts, so
                    render.ts reaches them without pulling in the detectors
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
| `src/AGENTS.md` | what the owned renderer must do and the measured defect behind each requirement, the parity classes, the list pipeline, the sentinels, the glyph tier, the command-line surface, ambiguous width and the probe, the rendering policy, the `emoji` re-decision |
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

**Binary size is not a dependency problem.** The compiled binary (`bun build
--compile`, see "Conventions" above) is ~102 MB, almost entirely Bun's own embedded
runtime — present in every Bun-compiled binary regardless of what a project imports.
The actual runtime dependency closure — `marked`, `cli-highlight`, `@colors/colors`,
`node-emoji`, `ansi-escapes`, `supports-color`, `supports-hyperlinks`, `string-width`,
`yaml`, and everything each pulls in transitively — is **46 packages, ~8.6 MB**
(measured at WP-7; `bun run gen-licenses --check` walks exactly that closure and prints
the count). The rest of `node_modules` — **~63 MB installed in total** — is
devDependency tooling: `eslint`, `typescript`, `typescript-eslint`, `jiti`,
`@types/bun`, and their own transitive closures, which never ship in the binary at
all. Dependency weight is therefore a **couple of percent of the compiled artifact**.
"Remove a dependency to shrink the binary" is the wrong frame for this tool; no
dependency was removed on that basis, and none should be without re-measuring what
actually changes. (This section recorded 60 packages when it was written at WP-5; the
count is a measurement, not a target, and it is re-measured rather than adjusted.)

**`cli-highlight` and `@colors/colors` must stay declared in `dependencies`, and the
premise that used to justify that has changed while the conclusion has not.** The
original argument was that a dependency-pruning tool would flag both as reachable
transitively through `marked-terminal`, so a declaration looked redundant. There is no
such path now — that package is gone — and the reason to keep both declared is simply
the plainer one it always rested on: `src/lang.ts` imports `supportsLanguage` from
`cli-highlight` directly and `src/table.ts` imports `@colors/colors/safe` directly, so
both are **first-party imports of this repo's own source**. The same rule covers the
four promoted in WP-6 — `node-emoji`, `ansi-escapes`, `supports-hyperlinks` and
`supports-color` — each of which `src/inline.ts` imports by name. **A package this
repo's source imports is declared here, whatever a reachability tool says**; the tool
is reading reachability, not who actually imports what.

**`cli-table3` is gone from `node_modules` entirely, and that closes a two-part note
this section used to carry.** It left `dependencies` in WP-3 of
`plans/tn-review-remediation.md`, when `src/table.ts` stopped importing it and started
emitting its own borders, but stayed physically installed because `marked-terminal`
required `^0.6.5` — so it stayed in the closure `scripts/gen-licenses.ts` walks and in
`THIRD-PARTY-LICENSES.txt`. WP-6 of `plans/marked-terminal-replacement.md` removed the
only thing requiring it, and it left with a nested `chalk@5.6.2`; the licence file went
1,059 → 990 lines, 49 → 46 packages. `@colors/colors` took the declaration slot it
vacated, deliberately: the emitter has to reproduce the old `style: { head: ["bold"],
border: ["grey"] }` bytes, that package decides whether to colour at all, and
reproducing its decision by hand would be fidelity risk spent to change nothing on
purpose. **A `chalk@4.1.2` still sits in the tree** as `cli-highlight`'s and eslint's
transitive; this repo neither imports it nor reads its level — `src/inline.ts` asks
`supports-color`, which is the same implementation `chalk` wraps and was measured to
agree with it on a 36-cell environment matrix (`src/AGENTS.md`, "Colour").

**`highlight.js` is pinned at `10.7.3`** (a transitive pin, via `cli-highlight`), two
majors behind upstream, **and cannot be subset to shrink it**: `cli-highlight`
hardcodes a full `require` of highlight.js's entire bundled language set rather than
importing individual languages one at a time, so there is no seam to trim unused
languages through.

**This is blocked, not deferred, and WP-5 of `plans/renderer-deferred-work.md`
corrected the record to say so.** "Deferred" describes a choice — do it later, on
purpose, when it is someone's priority. There is no such choice available here: the
pin is transitive, owned by `cli-highlight@2.1.11`'s own dependency declaration, and
this repo has no `highlight.js` import of its own to bump — `src/lang.ts` reaches
`cli-highlight`'s `supportsLanguage`, never `highlight.js` directly. Moving past
`10.7.3` requires either `cli-highlight` publishing a release pinned to a newer
`highlight.js` (upstream's choice, not this repo's) or replacing `cli-highlight`
itself, which is a dependency-swap with its own compatibility check against this
tool's fence-language handling (`src/lang.ts`) and its own parity pass — not a version
bump a future session can make unilaterally. Recorded here so a future pass does not
"fix" the staleness by bumping a major version with nothing else in place.

**Pins.** `package.json`'s `dependencies` are pinned to the exact versions already
installed and exercised by this test suite — `marked@14.1.4`, `cli-highlight@2.1.11`,
`@colors/colors@1.5.0`, `node-emoji@2.2.0`, `ansi-escapes@7.3.0`,
`supports-color@7.2.0`, `supports-hyperlinks@3.2.0`, `string-width@7.2.0`,
`yaml@2.9.0` — rather than left on `^` ranges that could silently resolve to an
untested minor on a fresh `bun install` on a different machine. The four promoted from
transitive to direct in WP-6 of `plans/marked-terminal-replacement.md` were pinned at
**the versions already installed**, so the promotion added no package and moved no
byte. **This rule pins; it does not upgrade.** Bumping any of these is a separate,
deliberate decision with its own corpus/sweep verification pass, not a side effect of
installing on a new machine.

Plans: `plans/mdview.md` (the original build) and `plans/vault-readiness.md` (glyph tier,
fence languages, divider, embeds, and the multi-corpus sweep). The two sat at different
levels before extraction — the first predated the tool's own folder — and were flattened
into one `plans/` when this repo was split out.
