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
src/cli.ts          arg parsing, width resolution, pager, --check (WP-1)
src/render.ts       marked/marked-terminal wiring + renderer overrides (WP-2, WP-4a)
src/frontmatter.ts  YAML split and metadata block formatting (WP-2)
src/table.ts        the wide-table allocator — the reason the tool exists (WP-3)
src/wrap.ts         ANSI-safe prose wrapping for what marked-terminal won't (WP-4a)
tests/              unit tests + markdown fixtures
dist/mdview         compiled binary (gitignored; see PATH install below)
```

### What we override in `marked-terminal`, and why

The library is used for prose, lists, and code highlighting, but four of its renderers
are replaced or wrapped. Each override exists for a measured reason — do not remove one
without re-running the corpus sweep:

| Override | Reason |
|---|---|
| `table` | `marked-terminal` never passes the terminal width to tables and drops `token.align` entirely (WP-3) |
| `list` | It applies `reflowText` only in `paragraph`/`heading`/`blockquote` — **list items are never reflowed**, which was 90% of corpus overflow (WP-4a) |
| `code` | Brackets fenced output so `--check` can exempt it (WP-4a) |
| `html`, and a safety net on `paragraph`/`heading`/`blockquote` | A block-level tag (e.g. a line starting `<script>`) swallows a paragraph and is returned unreflowed; the library's own reflow also measures with `.length` rather than `string-width`, undercounting a few Unicode marks (WP-4a) |

`marked-terminal` calls `renderer.list()` but **never** `renderer.listitem()` — it
iterates items against its own internal renderer instance, so `listitem` is not a usable
seam. Depth tracking and wrapping both live in the `list` override.

## Run

From the repository root, run gates sequentially, stopping at the first failure:

```bash
bun install --cwd mdview
bun run --cwd mdview typecheck
bun run --cwd mdview lint
bun test mdview/tests
bun run mdview/src/cli.ts --check --width 80 mdview/tests/fixtures/wide-table.md
```

**Flag order matters.** `bun run --cwd <dir> <script>` works; `bun --cwd <dir> run
<script>` does **not** — on Bun 1.3.11 it prints `bun run`'s help text and **exits 0**,
i.e. it silently passes without executing the script. Verified reproducible against
`example_radar` too, so it is a Bun CLI behavior, not a quirk of this package. Never
write the second form into a gate: it is a gate that can never fail.

The last gate is the CLI's own self-smoke: `--check` renders with no pager and exits
non-zero if any output line exceeds the target width. It is **binding** — all five gates
must exit 0.

### Corpus sweep

The self-smoke gate covers one fixture. Before releasing a rendering change, also sweep
the real corpus, which is what this tool is actually pointed at:

```bash
for w in 80 100 160; do
  for f in plans/*.md */plans/*.md INITIATIVE.md */INITIATIVE.md runs/dispatch/*.md AGENTS.md */AGENTS.md; do
    [ -f "$f" ] || continue
    mdview --check --width "$w" "$f" >/dev/null 2>&1 || echo "OVERFLOW w=$w $f"
  done
done
```

Expected: **no output** (774 file/width combos, 0 overflow as of WP-4). This sweep is
what caught the list-item reflow defect that the fixture gate missed — `wide-table.md`
has no long bullets, so it stayed green while 250 of 256 real files overflowed. When a
gate passes, check that it passes for the right reason.

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
- **Known limitation:** a markdown table nested *inside* a list item is re-wrapped as
  prose and its box drawing is mangled. The table renderer sizes to the full target
  width with no knowledge of the enclosing list indent. There are zero instances in the
  corpus (verified), so this is unfixed by choice rather than oversight.
- `.gitignore` is assembled from the chunk files in
  `skills/project-setup/references/gitignore/`; repo-local entries go under the
  `# --- project-specific ---` marker. `bun.lock` is **ignored**, matching every other
  tool in the fleet (the root `.gitignore` ignores it globally and no tool tracks one).

Plans: `plans/mdview.md` (repo root — this work spans a single tool but was written
before `mdview/` existed, so it stayed at root per the repo-wide plans routing rule).
