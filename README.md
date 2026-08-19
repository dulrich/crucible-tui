# crucible-tui (`mdview`)

A terminal markdown viewer built for reading the documents a working repo actually
produces — long plans, execution briefs, `INITIATIVE.md` files — rather than for
rendering a blog post. Frontmatter becomes a labelled metadata block instead of being
stripped or dumped as raw YAML; wide tables are wrapped losslessly, columns shrinking
proportionally to a floor rather than overflowing the terminal or truncating a cell;
prose and lists reflow ANSI-safely at the target width, correctly at every nesting
depth, in both tight and loose Markdown list styles; fenced code always passes through
byte-for-byte, so a pasted command stays pasteable.

That combination — losslessly wrapped wide tables plus environment-detected
Unicode/ASCII glyph tiers — turned out to be rare. A field survey of nineteen terminal
markdown tools (read by source and commit history, not by README) found exactly one
other project doing glyph-tier detection at all, and it renders no tables whatsoever.
Most of the field is dead or effectively a single maintainer's side project; this one
is a full public project because of that, not in spite of it.

## Install

There's no npm package yet (see [Distribution](#distribution) below). For now, clone
and run on [Bun](https://bun.sh):

```bash
bun install
bun run build                                    # compiles dist/mdview (~102 MB;
                                                  # embeds the Bun runtime — this is
                                                  # normal, not a dependency problem)
ln -sfn "$PWD/dist/mdview" ~/.local/bin/mdview    # from the repo root
```

The symlink points at the build output, so a rebuild takes effect immediately — but
editing source without rebuilding leaves `mdview` silently running the old code. There
is no watch mode.

Alternatively, run straight from source with no build step:

```bash
bun run src/cli.ts <file.md>
```

A roff man page ships at `man/crucible-tui.1`; `bun run install:man` symlinks it in as
`mdview.1` so `man mdview` resolves.

## Usage

```bash
mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--color[=WHEN]] [--help] [--licenses]
mdview view <file.md> [options...]        # spelled-out form of the bare invocation above
mdview highlight-as <fence> <language>    # map a fence's declared language to a highlighter language
mdview probe [--refresh]                  # how does this terminal draw ambiguous-width characters?
mdview help [subcommand]
```

A bare `mdview file.md` is, and remains, a complete invocation — no subcommand is ever
required just to view a file. That is the daily-driver path and every flag falls
straight through to it.

- `--width N` — target render width (default: terminal columns, else 100).
- `--no-pager` — write plain output to stdout instead of piping to `less -R`.
- `--check` — render with no pager; exit non-zero if any non-code line exceeds the
  target width. This is the tool's own self-smoke gate.
- `--ascii` / `--unicode` — force the glyph tier (below), overriding auto-detection.
  Mutually exclusive.
- `--color[=auto|always|never]` — when to emit colour (below). Bare `--color` means
  `--color=always`; repeated, the last one wins; an unrecognized value is an error.
- `--probe` — run the ambiguous-width diagnostic (below) and exit; the flag spelling of
  `mdview probe`. Takes no file argument.
- `--help`, `-h` — print usage (top-level, or a subcommand's own) and exit.
- `--licenses` — print the aggregated third-party notices (below) and exit. Takes no
  file argument.

`mdview highlight-as <fence> <language>` maps a fence info-string (the word after the
opening ` ``` `) to a language the syntax highlighter recognizes, and saves it to the
config file — validated against the highlighter's own supported-language list before
anything is written, so a typo is rejected with an explanation rather than silently
producing an unhighlighted fence later. `dataviewjs` → `javascript` and `dataview` →
`sql` are built in and need no configuration; a user entry for either overrides it.

### Config

JSON at `$XDG_CONFIG_HOME/mdview/config.json` (or `~/.config/mdview/config.json` if
`XDG_CONFIG_HOME` is unset). Two keys of interest to normal use:

```json
{
  "highlightAs": {
    "dataviewjs": "javascript"
  },
  "color": "auto"
}
```

`color` is `"auto"`, `"always"` or `"never"` — a standing preference that loses to both
`--color` and `MDVIEW_COLOR` (see "Colour" below).

Reading is lenient — a missing file is normal, and a malformed one degrades to
defaults with a one-line notice on stderr rather than a stack trace, still rendering
the document. Writing (`highlight-as`) is stricter: it refuses to touch a config file
it cannot parse, since merging into one it can't understand risks silently clobbering
or dropping content it can't see. A write only ever touches the one `highlightAs` entry
named on the command line; every other key, and every other mapping already recorded,
is left exactly as it was.

### Colour

**Piped output is colourless by default.** `mdview file.md | less`, `> out.txt` or
`$(mdview file.md)` gets plain text unless you ask for colour explicitly — so redirected
output is something you can diff, grep and paste without stripping escape sequences first.
A terminal gets colour, as it always did.

Resolution order, highest precedence first:

1. `--color=auto|always|never` (bare `--color` = `always`).
2. `MDVIEW_COLOR=auto|always|never`. An unrecognized value is ignored with one line on
   stderr, never an error — the same contract as `MDVIEW_GLYPHS`.
3. `NO_COLOR` — **present at all, even empty, means never** ([no-color.org][no-color]).
4. `FORCE_COLOR` — `0` and `false` mean never; empty, `true` and `1`–`3` mean always;
   any other value decides nothing and the next rule applies.
5. The config file's `color` key.
6. Whether stdout is a terminal.

[no-color]: https://no-color.org

**OSC-8 hyperlinks are a separate axis.** They are never emitted off a terminal, whatever
the colour setting says — a pipe cannot render one. On a terminal,
`MDVIEW_HYPERLINKS=auto|always|never` decides, and `auto` (the default) asks what the
terminal advertises. `NO_COLOR` does not turn hyperlinks off.

### Glyph tier

Bullets, rules, table borders, and task-list glyphs move together as one capability
tier, detected from the locale and `TERM` (UTF-8 locale and a non-dumb terminal ⟶
Unicode; otherwise ASCII):

| | Unicode | ASCII |
|---|---|---|
| Bullets (cycling by depth) | `•` `◦` `‣` | `-` |
| Rules and the frontmatter divider | `─` | `-` |
| Table borders | box-drawing | `+` `-` `\|` |
| Task states | `○` / `✓` | `[ ]` / `[x]` |

Override with `--ascii` / `--unicode`, or `MDVIEW_GLYPHS=ascii|unicode` in the
environment (flags win). Every Unicode substitute occupies exactly one column *under
narrow ambiguous-width measurement*, so the tier choice never changes layout — see the
next section for the case where that stops being true.

### Ambiguous width, and `mdview probe`

Almost every non-ASCII character in ordinary prose — `—` `–` `→` `←` `…` `≥` `×` `•`
`○`, and the entire box-drawing set — is East Asian **Ambiguous**: Unicode says it
renders at *either* one or two columns depending on the terminal, and there is no way
to tell from the character. Guess wrong and every line carrying one wraps a column or
two off.

`mdview probe` asks. It writes one test character, queries the cursor position before
and after it (DSR, `ESC[6n`), and takes the difference. The reply is read in raw mode
with a short timeout; cooked mode is restored on every exit path, the test character is
erased, and the probe only runs when stdin and stdout are both TTYs — never under
`--check` and never when piped. The answer is cached at
`$XDG_CACHE_HOME/mdview/ambiguous-width.json` (else `~/.cache/...`), keyed by terminal
identity — `TERM`, `TERM_PROGRAM`, `COLORTERM`, `VTE_VERSION`, the multiplexer, and the
locale — so a second terminal never inherits the first one's answer. `--refresh`
re-probes; delete the file and the next probe recreates it.

**If you change your terminal's own ambiguous-width setting, run `mdview probe
--refresh`.** Some emulators make this a config-file option — mlterm's
`col_size_of_width_a`, xterm's `cjkWidth` — and such a setting is invisible in the
environment, so it cannot appear in the cache identity. Flipping it leaves the same
identity mapped to what is now the wrong answer, and mdview will keep using it until you
re-probe. This is the one direction the identity key is genuinely blind in; everywhere
else it errs toward re-probing too often, which costs 5 ms.

Resolution order, highest first:

1. `MDVIEW_AMBIGUOUS=narrow|wide` in the environment (any other value is ignored, never
   an error — same contract as `MDVIEW_GLYPHS`).
2. A cached probe result for this terminal.
3. A live probe, when stdin and stdout are both TTYs.
4. **Narrow** — every headless, redirected, piped, timed-out and unparseable case, and
   what [Unicode TR11](https://www.unicode.org/reports/tr11/) itself recommends when
   the context cannot be established.

**`wide` forces the ASCII glyph tier**, overriding `--unicode` and `MDVIEW_GLYPHS` (with
a notice on stderr if you asked for Unicode explicitly). That is arithmetic rather than
taste: the Unicode tier's bullet, rule and box-drawing characters are themselves
ambiguous, so under `wide` a table's horizontal border comes out at exactly twice the
width its columns were allocated for and no re-allocation can recover it. Every ASCII
substitute is unambiguously one column. `MDVIEW_AMBIGUOUS=narrow` gets the box drawing
back if you would rather have it and accept the overflow.

Out of scope by design: images, callouts, block LaTeX, raw HTML.

## Two names, on purpose

The project and repository are **`crucible-tui`**; the command, the package, the
`MDVIEW_*` environment variables, and the `~/.config/mdview/` directory are all
**`mdview`** — and that split is settled, not an unfinished rename. `mdview` describes
what the tool does today: it views markdown. `crucible-tui` is the name of the project
those functions would belong to if editing, a file tree, or other full-TUI-application
features arrive later — the event that would actually justify renaming the command.
Shipping that churn early would cost every user their config path and muscle memory to
buy nothing. This follows the same split as `ripgrep`/`rg` and
`the-silver-searcher`/`ag`: a repo name and a command name are allowed to differ.
`man crucible-tui` and `man mdview` both resolve, on purpose, to the same page.

See `AGENTS.md`'s "Two names, on purpose" for the full rationale, and
[`docs/adr/0001-editor-path.md`](docs/adr/0001-editor-path.md) for the architecture
decision this naming is deliberately keeping room for.

## Distribution

There is no npm package yet. The plan — not yet implemented — is a small npm package
containing the source, which runs on the user's own Bun (as `bun run src/cli.ts` above
already does), plus optional pre-compiled per-platform binaries attached as GitHub
release assets for people who would rather not install Bun at all. This follows
[opencode](https://github.com/sst/opencode)'s model, and deliberately avoids publishing
a ~422 MB matrix of platform-specific npm packages the way some CLI tools do. Nothing
about this is implemented yet, and `package.json` stays `"private": true` until the
maintainer decides otherwise.

## Third-party licenses

MIT (see [`LICENSE`](LICENSE)). Aggregated notices for the runtime dependency closure
— generated by `scripts/gen-licenses.ts`, never hand-edited — are in
[`THIRD-PARTY-LICENSES.txt`](THIRD-PARTY-LICENSES.txt) and printed by `mdview
--licenses`. Two notices in there are reproduced in full because a bare SPDX identifier
doesn't cover them: `marked` bundles a second, separate license for John Gruber's
original Markdown spec alongside its own MIT grant, and `highlight.js` is BSD-3-Clause,
which requires its copyright notice and disclaimer to travel with the software.

## Contributing

`AGENTS.md` is the contributor contract: stack, layout, the rendering model, the corpus
sweep and its gates, dependency decisions, and the containment rules that keep this
repo safe to publish next to private ones. Read it before sending a change.
