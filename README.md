# mdview

A terminal markdown viewer for this repo's own plans, execution briefs, and
`INITIATIVE.md` files: renders frontmatter as a labelled metadata block, and wraps
wide tables to the terminal width instead of overflowing or truncating them.

## Usage

```bash
bun run mdview/src/cli.ts <file.md> [--width N] [--no-pager] [--check]
                                    [--ascii | --unicode] [--help]
```

- `--width N` — target render width (default: terminal columns, else 100).
- `--no-pager` — write plain output to stdout instead of piping to `less -R`.
- `--check` — render with no pager; exit non-zero if any line exceeds the target
  width. This is the tool's self-smoke gate.
- `--ascii` / `--unicode` — force the glyph tier (below). Mutually exclusive.
- `--help` / `-h` — print usage and exit.

When stdout is a TTY and `--no-pager` is absent, output is piped to `less -R`. When
`less` is unavailable, or stdout is redirected, output goes to stdout directly.

Once installed on PATH (below), that is simply:

```bash
mdview plans/mdview.md
```

### Installing on PATH

```bash
bun run --cwd mdview build                                    # compile dist/mdview
ln -sfn "$PWD/mdview/dist/mdview" ~/.local/bin/mdview         # from the repo root
```

**The compiled binary is a new pattern for this repo** — every other `bun build` here
produces a bundle, not a standalone executable. It embeds the Bun runtime (~102 MB),
is gitignored, and **must be rebuilt after any source edit**; there is no watch mode.
Editing source without rebuilding leaves `mdview` running the old code.

## What it does

- **Frontmatter** renders as a dimmed, key-aligned metadata block rather than being
  stripped. Empty values (`[]`, `""`, null) show `—` so they read as empty, not broken.
- **Wide tables** are the reason the tool exists: columns shrink proportionally to a
  floor, and tokens too long for their column are hard-split, never ellipsized. 43% of
  this repo's 4,550 table rows exceed 120 columns.
- **Prose and lists** wrap to the target width, ANSI-safely — escape sequences are
  never cut, and CJK/emoji are measured by display width.
- **Fenced code is never rewritten**, so commands stay pasteable; `--check` exempts it.
  Unknown fence languages fall back to `plaintext` instead of writing highlight.js
  warnings to stderr; `dataviewjs` highlights as JavaScript and `dataview` as SQL.
- Wiki-links (`[[slug|alias]]`), embeds (`![[target]]`), and Obsidian task states render
  as styled text and glyphs.
- **A rule follows the frontmatter block**, drawn exactly like the document's own `---`.

## Glyph tier

Bullets, rules, table borders, and task glyphs move together as one capability tier:

| | Unicode | ASCII |
|---|---|---|
| Bullets (cycling by depth) | `•` `◦` `‣` | `-` |
| Rules and the frontmatter divider | `─` | `-` |
| Table borders | box-drawing | `+` `-` `\|` |
| Task states | `○` / `✓` | `[ ]` / `[x]` |

Detection prefers Unicode when the locale is UTF-8 and `TERM` isn't a known-dumb
terminal. Override it with `--ascii` / `--unicode`, or set `MDVIEW_GLYPHS=ascii|unicode`
(flags win). Every Unicode substitute is one column wide, so the tier never changes
layout.

Out of scope by design: images, callouts, block LaTeX, raw HTML.

See `mdview/AGENTS.md` for stack, layout, gates, and the corpus sweep.
