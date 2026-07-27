# mdview

A terminal markdown viewer for this repo's own plans, execution briefs, and
`INITIATIVE.md` files: renders frontmatter as a labelled metadata block, and wraps
wide tables to the terminal width instead of overflowing or truncating them.

## Usage

```bash
bun run mdview/src/cli.ts <file.md> [--width N] [--no-pager] [--check] [--help]
```

- `--width N` — target render width (default: terminal columns, else 100).
- `--no-pager` — write plain output to stdout instead of piping to `less -R`.
- `--check` — render with no pager; exit non-zero if any line exceeds the target
  width. This is the tool's self-smoke gate.
- `--help` / `-h` — print usage and exit.

When stdout is a TTY and `--no-pager` is absent, output is piped to `less -R`. When
`less` is unavailable, or stdout is redirected, output goes to stdout directly.

### Installing on PATH

WP-4 owns compiling the tool with `bun run build` (`bun build --compile`) and
symlinking the resulting `dist/mdview` binary onto `~/.local/bin/mdview`. **The
compiled binary is a new pattern for this repo** — every other `bun build` here
produces a bundle, not a standalone executable — so it must be rebuilt after any
source edit; there is no watch/dev mode wired up yet.

## Status

WP-1 (this scaffold) ships the CLI shell only: argument parsing, width resolution,
and the pager. Rendering (`src/render.ts`, `src/frontmatter.ts`, `src/table.ts`) is
implemented in WP-2 and WP-3. Until then, `main()` writes the source file through
unchanged.

See `mdview/AGENTS.md` for stack, layout, and gates.
