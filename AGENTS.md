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

A second command, `jsonedit`, now ships from this repo (`crates/jsonedit/`, `plans/jsonedit.md`); mdview is unchanged.

## Stack

- **The renderer is Rust** — `crates/mdview/`, a static musl binary built with `cargo auditable` beside `crates/jsonedit/` in one Cargo workspace (`Cargo.toml`, `members = ["crates/*"]`, toolchain pinned by `rust-toolchain.toml` to 1.98.1). `comrak` lexes, and `crates/mdview/src/lex.rs` adapts its tree into the marked-shaped tokens this repo's own walk and visitors read; `syntect` + `two-face` highlight.
- **Bun + TypeScript remain, for the scripts and instruments only** (`scripts/`, `tests/`): the corpus sweep, the colour axis, the render differential, the generators and `verify`. They drive the built binary through its hidden `mdview __parity` subcommand and never render in-process.
- **The Bun/TypeScript-over-Rust override is closed.** The scaffolding skill's Gate 2 default is Rust, and this repo recorded a justified exception for the original build (`marked@^14` pinned across the sibling tools, the wiki-link logic already in TypeScript, a prototype measured first). `plans/mdview-rust-port.md` ported the renderer behaviour for behaviour under byte-parity gates, and WP-9 deleted the TypeScript renderer. **`TS_BASELINE` = `c097c66`** is the last commit carrying it; every fact below that needs the TypeScript renderer cites that sha.
- What the TypeScript renderer had to own, and why — `marked-terminal` replaced method by method, `cli-table3`'s emitter, the walk taken from marked's `Parser` — is history now, carried in `crates/mdview/AGENTS.md` (the port's behavioural spec, moved from `src/AGENTS.md`) and `docs/agents/dependency-history.md`. Its `src/*.ts` citations name `TS_BASELINE`'s tree.

## Layout

One line per module — the *why* is `crates/mdview/AGENTS.md` and the module's own header.

```text
crates/mdview/src/  the renderer (each module's header names the TS_BASELINE src/*.ts it ports)
  main.rs           thin entrypoint; lib.rs dispatches `__parity` or the CLI
  cli.rs            arg parsing, width resolution, the view path, --check, --licenses
  pager.rs          less -R, stdout fallback, BrokenPipe as quiet success
  config.rs         XDG config load, color/hyperlinks directives, highlight-as write
  probe.rs          the East Asian Ambiguous probe and its cache
  render.rs         render entry: frontmatter, lex, context, visitors, walk, post-pass
  lex.rs            comrak tree -> marked-shaped tokens (token.rs is the schema)
  walk.rs           the owned token walk
  context.rs        the immutable per-render layout context
  list_layout.rs    the list/text layout state machine
  lists.rs          list composition, numbering, task states, de-drift, bullets
  blocks.rs         code, hr, html, paragraph, heading, blockquote
  inline.rs         inline visitors, the emoji pass, the colon sentinel
  table.rs          the wide-table allocator and emitter (table/tests*.rs)
  wikilink.rs       wiki-link styling and OSC-8 following; wikiresolve.rs resolves slugs
  frontmatter/      YAML split, core-schema parse, JS value model, metadata block
  style.rs          the committed SGR table and emitter; colour.rs the one policy decision
  ansi.rs           the sequence grammar and the OSC-8 emitter
  highlight.rs      syntect colorizer; lang.rs fence aliases; hljs_map.rs (generated)
  width.rs          the string-width port (width/tables.rs generated); text.rs, wrap.rs
  glyphs.rs         the Unicode/ASCII tier
  list_lines.rs     rendered-line primitives; overflow.rs the width gate
  emoji_data.rs     generated shortcode map
  parity.rs         the hidden `mdview __parity` JSONL servers the instruments drive
crates/mdview/tests/  integration tests: witnesses, golden replay (golden/), protocol
crates/mdview/notices/  vendored licence notices gen-licenses copies (see its README.md)
crates/mdview/syntaxes/ vendored grammars compiled in by build.rs
crates/jsonedit/    the jsonedit bin crate; its invariants are crates/jsonedit/AGENTS.md
scripts/            the Bun instruments (module map and DAG: scripts/AGENTS.md)
scripts/measure/    measurement-only modules moved out of src/ at WP-9: detectors,
                    list-lines, overflow, the ansi scanner, the width Measure, the
                    frontmatter split, manifest resolution
scripts/verify.ts   the canonical `bun run verify`
corpus/             the bundled public-safe gate manifest
tests/              the instruments' bun tests + markdown fixtures (tests/AGENTS.md)
target/             Cargo build output (gitignored)
```

## Child docs and reference files — the index

This root file carries what a session needs whatever it touches: identity, the two-names decision, the Stack, the Layout tree, the Run/verify contract, Conventions and the live dependency rules. Everything subtree-specific lives in a child `AGENTS.md` beside the code it describes, each with its own `CLAUDE.md` symlink. Read the root, then the nearest child.

| File | Carries |
|---|---|
| `crates/mdview/AGENTS.md` | the renderer's behavioural spec: what each visitor must do and the measured defect behind it, the parity classes, the sentinels, the task-state pre-pass, the colour-only-defect class, the glyph tier, the command-line surface, the rendering policy, the `emoji` re-decision — and the index to the reference files below |
| `scripts/AGENTS.md` | the corpus sweep and its manifests, the corpus growth findings, the defect detectors, the colour axis, the render differential |
| `tests/AGENTS.md` | the publication containment guard's rules and internals, and the width-sensitive fixture trap |
| `crates/jsonedit/AGENTS.md` | jsonedit's ten safe-edit invariants, the dialect and structural-check rules, the indent-dominance threshold, and the test approach |

**The deep records live under `docs/agents/`, and are read on demand rather than loaded on every turn** — they deliberately have **no `CLAUDE.md` symlink** (WP-4 of `plans/docs-and-memory-curation.md`). Their `src/*.ts` citations are historical as of `TS_BASELINE`.

| File | Carries |
|---|---|
| `docs/agents/list-pipeline.md` | composition, the two wrap paths, the de-drift, the claim domains, and the retained passes |
| `docs/agents/wiki-link-record.md` | the wiki-link carrier defect and its fix: context table, precedence matrix, the three further defects, the three failed fix designs, and witness ownership |
| `docs/agents/colour.md` | the one owned colour/hyperlink decision, `SgrMode`'s three levels, the reader inventory, and the resolution history |
| `docs/agents/ambiguous-width.md` | the ambiguous-width question, the probe and its cache identity, why `wide` forces ASCII, and the table-emitter residual |
| `docs/agents/dependency-history.md` | the forensic record of every dependency removal — the evidence behind this file's dependency rules |

## Run

From the repository root, the verification contract is two commands (WP-1 of `plans/tn-review-remediation.md` — one canonical entrypoint, called identically here and from CI):

```bash
bun install
bun run verify
```

`bun run verify` (`scripts/verify.ts`) runs every gate in fail-fast order, printing which step failed and exiting non-zero at the first one that does. In order, it runs:

```bash
bun run typecheck
bun run lint
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
bun run build:rust
./target/x86_64-unknown-linux-musl/release/mdview --check --width 80 tests/fixtures/wide-table.md
./target/x86_64-unknown-linux-musl/release/jsonedit --check crates/jsonedit/tests/fixtures/valid.json
bun test tests
bun run scripts/gen-licenses.ts --check
bun run scripts/gen-emoji-table.ts --check
bun run scripts/gen-width-tables.ts --check
bun run scripts/gen-hljs-map.ts --check
bun run scripts/render-diff.ts --rev-a rust:HEAD --rev-b rust:. --policy P0,P1,P2,P3,P4 --require-nonzero sgr,fences
bun run sweep
bun run sweep -- --glyphs ascii
bun run sweep -- --colour-mode both
bun run test:security
```

That list is the explanation of what `verify` does, not a second thing to run by hand. Since WP-9 of `plans/mdview-rust-port.md`: the Bun build, its artifact smoke and the `TS_BASELINE` `src/cli.ts --check` self-smoke are gone with the TypeScript renderer, and so are the four TS-vs-Rust differentials (frontmatter census, table-allocator diff, lexer diff, CLI diff); `bun test` runs **after** `build:rust`, because the instruments' tests drive the built binary; and the render differential is Rust-vs-Rust, the working tree against `HEAD` over the T0 gate corpus, class-A or registry-attributed. License freshness runs in `--check` mode (renders to memory, never leaves the tree dirty — the default `bun run gen-licenses` still writes). The colour axis is three exact gates, no thresholds, over the fixed gate corpus — a colour decision may change which bytes a render emits, never which characters, and an undirected, piped render must emit no terminal sequence at all (`scripts/AGENTS.md`).

**`verify` never runs `bun install`.** Local floats (`bun install`), CI freezes (`bun install --frozen-lockfile`), and that asymmetry is deliberate — installation stays a separate step, run once before `verify`, in both places.

**Flag order matters.** `bun run --cwd <dir> <script>` works; `bun --cwd <dir> run <script>` does **not** — on Bun 1.3.11 it prints `bun run`'s help text and **exits 0**, i.e. it silently passes without executing the script. Verified reproducible in a second, unrelated package, so it is a Bun CLI behavior, not a quirk of this one. Never write the second form into a gate: it is a gate that can never fail.

The `--check` step is the CLI's own self-smoke: it renders with no pager and exits non-zero if any output line exceeds the target width. Every step `bun run verify` runs is binding and must exit 0.

### Rust host prerequisites and install

One-time, on a fresh host (`verify` never runs `rustup` or `cargo install`):

```bash
rustup toolchain install 1.98.1 --profile minimal -c clippy,rustfmt -t x86_64-unknown-linux-musl
cargo install cargo-auditable --locked
```

Use the explicit install: rustup's auto-install from `rust-toolchain.toml` (default profile) failed on this host. Build with `bun run build:rust`; install is a symlink per binary, and it does not track source — **rebuild after any edit**, or the command silently runs the old code:

```bash
ln -sfn "$PWD/target/x86_64-unknown-linux-musl/release/mdview" ~/.local/bin/mdview       # from the repo root
ln -sfn "$PWD/target/x86_64-unknown-linux-musl/release/jsonedit" ~/.local/bin/jsonedit   # from the repo root
```

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

- `INITIATIVE.md` exists here but did not while this was a subfolder — a tool folder in
  that family carried none, and the standalone repo is its own initiative. Its YAML
  frontmatter is agent-maintained; **the body is the user's**, and `# Blocked on User` is
  append-only.
- **No `FEEDBACK.md`, ever agent-created.** It is the user's scratchpad: read it if it
  exists, never write it, never scaffold it.
- **The binary does not track source.** `~/.local/bin/mdview` is a symlink to `target/x86_64-unknown-linux-musl/release/mdview` (see "Rust host prerequisites and install" above); rebuild with `bun run build:rust` after any edit. The ~102 MB `bun build --compile` binary at `dist/mdview` is gone with the TypeScript renderer (`TS_BASELINE` = `c097c66`).
- `crates/mdview/src/main.rs` is a thin entrypoint over `mdview::run`; tests call the library directly, and the instruments call the binary's `__parity` servers.

### Dependencies (WP-5, re-measured at WP-6/WP-7)

**Runtime npm dependencies are zero since WP-9 of `plans/mdview-rust-port.md`.** `package.json` has no `dependencies` at all; every npm package left is a **devDependency** of the scripts and instruments — `marked` and `string-width` for the detectors and the width `Measure` (`scripts/measure/`), and `node-emoji`, `highlight.js` and `get-east-asian-width` as the pinned inputs of the three generators (`gen-emoji-table`, `gen-hljs-map`, `gen-width-tables`), so each generated Rust table keeps a durable, versioned source. What ships is the Cargo closure plus the vendored notices in `crates/mdview/notices/`, and `THIRD-PARTY-LICENSES.txt` carries exactly that. **Everything below is the record as of `TS_BASELINE` (`c097c66`)**: the npm counts, pins and caveats describe the TypeScript renderer's runtime closure, and the classification and declaration rules still apply to Cargo.

The premise this WP started from — "trim dependency fat to shrink the binary" —
inverted once it was measured. Record that inversion here so nobody re-derives it and
re-opens a removal pass that costs review time for zero benefit.

**Scope.** The npm measurements below (closure counts, `package.json` pins) are mdview's. The classification rule, the declaration rule (both directions) and the tested-version pin rule apply to Cargo too: Cargo runtime deps are pinned `=x.y.z` in `crates/*/Cargo.toml`, and a bump is a deliberate change with its own verification. `THIRD-PARTY-LICENSES.txt` carries both closures (Cargo: normal deps for the musl target).

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
  package reading the process rather than by a value handed in. `TS_BASELINE` `src/colour.ts` is what
  replaced all of them — the one place that decision is made, from inputs threaded in
  explicitly.
- **Emission dependencies — anything writing terminal escape bytes — are owned here,
  not imported.** `ansi-escapes` (removed WP-3) was the last one: this repo's own
  `TS_BASELINE` `src/style.ts` (SGR) and `src/ansi.ts` (OSC-8, DCS) are the only places an escape byte
  is spelled now.

Applying that rule to this plan's own closure took runtime dependencies to **five, all
domain-data, zero load-time globals, zero third-party escape emission** — `marked`,
`highlight.js`, `string-width`, `yaml`, `node-emoji`, exactly the list above. **One
caveat, recorded rather than resolved:** `marked`'s lexer is the one keeper whose
interface is a real constraint rather than a preference — it has no source-offset API,
which is the interface gap `docs/adr/0001-editor-path.md`'s `{text, style, sourceStart,
sourceEnd}` return type is blocked behind, exactly as `TS_BASELINE` `src/walk.ts`'s header records for
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
because `TS_BASELINE` `src/inline.ts` imports it by name, `highlight.js` because `src/highlight.ts` does.
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
`TS_BASELINE` `src/wrap.ts` are derivations of `src/ansi.ts`'s scanner now; and the `highlight.js` pin
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
"`highlight.js` — the one keeper with a pin history". **`string-width` has had one deliberate bump, 7.2.0 → 8.2.2 (`plans/pictograph-width.md`)**, and it is the worked example of what a pin bump owes: a measured render-time budget in both colour modes, a per-cluster cache in `TS_BASELINE` `src/width.ts` to meet it, and a cross-bump corpus pass with every class-B diff attributed — `docs/agents/dependency-history.md`, "`string-width` — the one bump, and what it cost".

Plans: the founding pair is `plans/mdview.md` (the original build) and
`plans/vault-readiness.md` (glyph tier, fence languages, divider, embeds, and the
multi-corpus sweep). The two sat at different levels before extraction — the first
predated the tool's own folder — and were flattened into one `plans/` when this repo was
split out. Every plan since has followed; every file in `plans/` carries a Status line
(provisional → audited → approved → implemented) directly under its title, so the
directory itself is the index — read it, don't enumerate it here.
