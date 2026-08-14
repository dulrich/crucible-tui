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
- `yaml` for frontmatter parsing, `string-width` for CJK/emoji-correct column
  measurement. **Table borders, padding and alignment are emitted by `src/table.ts`
  itself** — `cli-table3` assembled the finished string until WP-3 of
  `plans/tn-review-remediation.md`; see `src/AGENTS.md`'s "The residual, named rather
  than papered over" for why that had to stop being true.
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
src/table.ts        the wide-table allocator — the reason the tool exists — and,
                    since WP-3 of plans/tn-review-remediation.md, the border/cell
                    emitter that used to be cli-table3
src/text.ts         grapheme splitting + display-width padding, shared by table.ts
                    and wrap.ts (which used to reach into table.ts for them)
src/wrap.ts         ANSI-safe prose wrapping for what marked-terminal won't
src/glyphs.ts       Unicode/ASCII capability tier — the only module that reads env
src/width.ts        display-width measurement + the East Asian Ambiguous probe (WP-3);
                    the only module that imports string-width
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
| `src/AGENTS.md` | the `marked-terminal` override forensics, the two sentinels, the glyph tier, the command-line surface, ambiguous width and the probe, the rendering policy, the `emoji` re-decision |
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

### Dependencies (WP-5)

The premise this WP started from — "trim dependency fat to shrink the binary" —
inverted once it was measured. Record that inversion here so nobody re-derives it and
re-opens a removal pass that costs review time for zero benefit.

**Binary size is not a dependency problem.** The compiled binary (`bun build
--compile`, see "Conventions" above) is ~102 MB, almost entirely Bun's own embedded
runtime — present in every Bun-compiled binary regardless of what a project imports.
The actual runtime dependency closure (`marked`, `marked-terminal`, `cli-highlight`,
`@colors/colors`, `string-width`, `yaml`, and everything each pulls in transitively,
which still includes `cli-table3` — see below) is
**60 packages, ~8 MB**. The other **~57 MB of `node_modules`** (122 packages total) is
devDependency tooling — `eslint`, `typescript`, `typescript-eslint`, `jiti`,
`@types/bun`, and their own transitive closures — that never ships in the binary at
all. Dependency weight is therefore **~2% of the compiled artifact**. "Remove a
dependency to shrink the binary" is the wrong frame for this tool; no dependency was
removed on that basis, and none should be without re-measuring what actually changes.

**`cli-highlight` and `@colors/colors` must stay declared in `dependencies`, even though
a dependency-pruning tool will flag both as reachable transitively through
`marked-terminal`.** `src/lang.ts:13` imports `supportsLanguage` from `cli-highlight`
directly, and `src/table.ts:1` imports `@colors/colors/safe` directly — neither import
goes through `marked-terminal`'s own copy of either package. Dropping either
declaration would leave those imports resolving only because `marked-terminal` happens
to hoist a compatible version of the same package into `node_modules` — code that
works by accident of a *different* package's dependency tree, for **zero** install-size
saving, since the packages are already present in `node_modules` either way. **Do not
remove either declaration on a dependency-graph tool's say-so**; the tool is reading
reachability, not who actually imports what.

**`cli-table3` left `dependencies` in WP-3 of `plans/tn-review-remediation.md` and is
still physically installed, and both halves of that matter.** `src/table.ts` no longer
imports it — it emits its own borders — so declaring it would be declaring a package
this repo does not use. But `marked-terminal` requires `^0.6.5`, so it stays hoisted in
`node_modules`, stays in the runtime closure `scripts/gen-licenses.ts` walks, and stays
in `THIRD-PARTY-LICENSES.txt`. Verified by asserting on the tree, not by a green
`bun install`. Its physical removal belongs to the separate `marked-terminal`
replacement plan, not here. `@colors/colors` took the declaration slot it vacated,
deliberately: the emitter has to reproduce the old `style: { head: ["bold"], border:
["grey"] }` bytes, that package decides whether to colour at all, and reproducing its
decision by hand would be fidelity risk spent to change nothing on purpose.

**`highlight.js` is pinned at `10.7.3`** (a transitive pin, via `cli-highlight`), two
majors behind upstream, **and cannot be subset to shrink it**: `cli-highlight`
hardcodes a full `require` of highlight.js's entire bundled language set rather than
importing individual languages one at a time, so there is no seam to trim unused
languages through. Upgrading past the pin is out of scope for this WP — recorded here
so the staleness is a known, deliberate deferral, not something a future pass
rediscovers and "fixes" by bumping a major version with no compatibility check against
this tool's fence-language handling (`src/lang.ts`).

**Pins.** `package.json`'s `dependencies` are pinned to the exact versions already
installed and exercised by this test suite — `marked@14.1.4`, `marked-terminal@7.3.0`,
`cli-highlight@2.1.11`, `@colors/colors@1.5.0`, `string-width@7.2.0`, `yaml@2.9.0` —
rather than left on `^` ranges that could silently resolve to an untested minor on a fresh
`bun install` on a different machine. **This WP pins; it does not upgrade.** Bumping any
of these is a separate, deliberate decision with its own corpus/sweep verification
pass, not a side effect of installing on a new machine.

Plans: `plans/mdview.md` (the original build) and `plans/vault-readiness.md` (glyph tier,
fence languages, divider, embeds, and the multi-corpus sweep). The two sat at different
levels before extraction — the first predated the tool's own folder — and were flattened
into one `plans/` when this repo was split out.
