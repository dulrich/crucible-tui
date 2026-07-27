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
src/cli.ts          arg parsing, width resolution, pager (this WP)
src/render.ts       marked/marked-terminal wiring + table override registration (WP-2)
src/frontmatter.ts  YAML split and metadata block formatting (WP-2)
src/table.ts        the wide-table allocator — the reason the tool exists (WP-3)
tests/              unit tests + markdown fixtures
```

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
non-zero if any output line exceeds the target width. **It is expected to FAIL until
WP-3 lands `renderTable`** — `renderDocument` is currently a WP-1 placeholder returning
the source unchanged, so wide fixtures overflow by construction. Run the first four
gates until then; this one becomes binding at WP-4.

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
  bundle. The binary must be rebuilt (`bun run build`) after any source edit; PATH
  installation is WP-4's responsibility.
- `.gitignore` is assembled from the chunk files in
  `skills/project-setup/references/gitignore/`; repo-local entries go under the
  `# --- project-specific ---` marker. `bun.lock` is **ignored**, matching every other
  tool in the fleet (the root `.gitignore` ignores it globally and no tool tracks one).

Plans: `plans/mdview.md` (repo root — this work spans a single tool but was written
before `mdview/` existed, so it stayed at root per the repo-wide plans routing rule).
