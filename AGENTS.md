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
| `list` | It applies `reflowText` only in `paragraph`/`heading`/`blockquote` — **list items are never reflowed**, which was 90% of corpus overflow. Also where bullet-glyph substitution happens |
| `hr` | The library hardcodes its rule character; the glyph tier has to reach it, and the rule must match the frontmatter divider exactly |
| `code` | Brackets fenced output so `--check` can exempt it, and normalizes `token.lang` through `src/lang.ts` before highlighting |
| `html`, and a safety net on `paragraph`/`heading`/`blockquote` | A block-level tag (e.g. a line starting `<script>`) swallows a paragraph and is returned unreflowed; the library's own reflow also measures with `.length` rather than `string-width`, undercounting a few Unicode marks |

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
a list item.

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

`scripts/sweep.ts` renders whole corpora in one process at 80/100/160 columns, honoring
`codeRanges`. It replaced a shell loop that spawned the 102 MB binary per file, and is
~13× faster. Three corpora:

| Corpus | Root | Note |
|---|---|---|
| `repo` | this repository | plans, briefs, `AGENTS.md`, `INITIATIVE.md` |
| `reports` | `~/code/example-ingest/example_reports/reports` | table-dense |
| `vault` | `/home/analyst/code/example-vault/vault` | 42.8k files — **stride-sampled to 300** unless `--all` |

```bash
bun run --cwd mdview sweep                                   # unicode tier
bun run --cwd mdview sweep -- --glyphs ascii                 # ascii tier
bun run --cwd mdview sweep -- --corpus vault --all           # full vault, slow
```

Expected: `overflow=0 errors=0` on every corpus, **both tiers**. The sweep is what caught
the list-item reflow defect the fixture gate missed — `wide-table.md` has no long
bullets, so it stayed green while 250 of 256 real files overflowed.

**The corpora are the user's real data. Open them read-only; never write to them.**

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
  ln -sfn /home/analyst/code/example-monorepo/mdview/dist/mdview ~/.local/bin/mdview
  ```

  The symlink points at the build output, so a rebuild takes effect immediately — but
  editing source without rebuilding leaves `mdview` silently running the old code.

### Rendering policy

- **Fenced code is never rewritten.** Blocks pass through verbatim at whatever width
  they are, and `--check` skips lines inside them. This is deliberate: the corpus's
  fences are gate commands meant to be pasted, and a wrapped command is a wrong
  command. The trade is that `--check` guarantees "no non-code line exceeds the
  width", not "no line at all".
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
- `.gitignore` is assembled from the chunk files in
  `skills/project-setup/references/gitignore/`; repo-local entries go under the
  `# --- project-specific ---` marker. `bun.lock` is **ignored**, matching every other
  tool in the fleet (the root `.gitignore` ignores it globally and no tool tracks one).

Plans: `plans/mdview.md` (repo root — the original build; written before `mdview/`
existed, so it stayed at root per the repo-wide plans routing rule) and
`mdview/plans/vault-readiness.md` (glyph tier, fence languages, divider, embeds, and the
multi-corpus sweep).
