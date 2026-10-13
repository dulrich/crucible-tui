# crucible-tui

Two terminal tools for the files an agent-assisted repo lives in, built from one Rust workspace (`crates/mdview/`, `crates/jsonedit/`):

| Command | What it does | Why you'd reach for it |
|---|---|---|
| **`mdview`** | Read markdown in the terminal: frontmatter as a metadata block, wide tables wrapped losslessly, lists reflowed, code passed through verbatim. | You're reading an Obsidian vault from a terminal, an agent-written plan or report, a cloned repo's `README.md`, or a `SKILL.md`. |
| **`jsonedit`** | Edit a JSON, JSONC or JSON5 file visudo-style: your editor on a private copy, written back atomically only if it parses. | Some config can only be changed by hand — `~/.claude/settings.json` permission rules, for instance — and a single syntax error there breaks the tooling that reads it. |

`mdview` is described first and at length below; [`jsonedit`](#jsonedit) has its own section.

## mdview

A terminal markdown viewer built for reading the documents a working repo actually
produces — long plans, execution briefs, `INITIATIVE.md` files — rather than for
rendering a blog post. Frontmatter becomes a labelled metadata block instead of being
stripped or dumped as raw YAML; wide tables are wrapped losslessly — no cell is ever
truncated, and columns shrink proportionally to a floor — though a table too wide even
at that floor emits at its minimum feasible width and can still exceed the terminal
width; prose and lists reflow ANSI-safely at the target width, correctly at every nesting
depth, in both tight and loose Markdown list styles; fenced code always passes through
byte-for-byte, so a pasted command stays pasteable.

That combination — losslessly wrapped wide tables plus environment-detected
Unicode/ASCII glyph tiers — turned out to be rare. A field survey of nineteen terminal
markdown tools (read by source and commit history, not by README) found exactly one
other project doing glyph-tier detection at all, and it renders no tables whatsoever.
Most of the field is dead or effectively a single maintainer's side project; this one
is a full public project because of that, not in spite of it.

## Install

There's no package yet (see [Distribution](#distribution) below). For now, clone and build both static binaries with Rust (toolchain setup is `AGENTS.md`'s "Rust host prerequisites and install"):

```bash
bun run build:rust                                # static musl binaries under target/
ln -sfn "$PWD/target/x86_64-unknown-linux-musl/release/mdview" ~/.local/bin/mdview       # from the repo root
ln -sfn "$PWD/target/x86_64-unknown-linux-musl/release/jsonedit" ~/.local/bin/jsonedit   # from the repo root
```

The symlinks point at the build output, so a rebuild takes effect immediately — but editing source without rebuilding leaves either command silently running the old code. There is no watch mode. Bun is needed only for the repo's scripts and gates (`bun install`, `bun run verify`), never to run either tool.

Roff man pages ship in `man/`; `bun run install:man` symlinks `man/crucible-tui.1` in as both `mdview.1` and `crucible-tui.1` (so `man mdview` and `man crucible-tui` both resolve) and `man/jsonedit.1` as `jsonedit.1`.

## mdview usage

```bash
mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--color[=WHEN]] [--no-color] [--plain] [--hyperlinks[=WHEN]] [--probe] [--help] [--licenses]
mdview view <file.md> [options...]        # spelled-out form of the bare invocation above
mdview highlight-as <fence> <language>    # map a fence's declared language to a highlighter language
mdview probe [--refresh] [--no-cache] [--timeout MS]  # how does this terminal draw ambiguous-width characters?
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
- `--no-color` — alias for `--color=never`.
- `--plain` — emit nothing of this tool's own: no SGR colour codes, no OSC-8
  hyperlinks. Absolute — it overrides every other colour and hyperlink input, including
  a malformed `MDVIEW_COLOR` or `MDVIEW_HYPERLINKS`, neither of which is even read under
  `--plain` (so no warning about either is printed).
- `--hyperlinks[=auto|always|never]` — when to emit OSC-8 hyperlinks (below). Same
  conventions as `--color`.
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
Which languages the highlighter covers, and which it does not, is [`docs/highlight-languages.md`](docs/highlight-languages.md).

### Config

JSON at `$XDG_CONFIG_HOME/mdview/config.json` (or `~/.config/mdview/config.json` if
`XDG_CONFIG_HOME` is unset). Five keys:

```json
{
  "highlightAs": {
    "dataviewjs": "javascript"
  },
  "emoji": true,
  "color": "auto",
  "hyperlinks": "auto"
}
```

- `highlightAs` — fence-language aliases, layered over the built-in `dataviewjs` →
  `javascript` and `dataview` → `sql` map; written by `mdview highlight-as` (above).
- `emoji` — `true` or `false`, overriding the glyph-tier default for `:shortcode:`
  substitution (Unicode substitutes a glyph, ASCII keeps the literal shortcode); unset
  follows the tier.
- `color` — `"auto"`, `"always"` or `"never"` — a standing preference that loses to both
  `--color` and `MDVIEW_COLOR` (see "Colour" below).
- `hyperlinks` — `"auto"`, `"always"` or `"never"` — its own axis, independent of
  `color`; loses to both `--hyperlinks` and `MDVIEW_HYPERLINKS`, and outranks terminal
  detection (see "Colour" below).
- `corpusManifest` — developer tooling: points the corpus sweep (`scripts/sweep.ts`) at
  a manifest file. Not consulted by normal rendering.

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

**"Colourless" means every part of the page, and that took two releases to be true.**
Table borders and table headers used to be styled by a library that answered the colour
question from the environment alone, without checking whether the destination was a
terminal, so a piped table arrived wrapped in escape sequences whatever you asked for.
Syntax highlighting had the mirror-image problem — it was decided at start-up by another
library, so `--color=always` into a pipe produced a document with no highlighting in it.
Both now follow the setting below, and `--color=always` on a pipe gives you exactly what a
terminal would have shown.

Resolution order, highest precedence first:

1. `--plain` — absolute. Nothing below is even consulted under it, so a malformed
   `MDVIEW_COLOR` produces no warning either; see "What `never` still emits" below for
   what it silences that a `never` directive does not.
2. `--color=auto|always|never` (bare `--color` = `always`).
3. `MDVIEW_COLOR=auto|always|never`. An unrecognized value is ignored with one line on
   stderr, never an error — the same contract as `MDVIEW_GLYPHS`.
4. `NO_COLOR` — **present at all, even empty, means never** ([no-color.org][no-color]).
5. `FORCE_COLOR` — `0` and `false` mean never; empty, `true` and `1`–`3` mean always;
   any other value decides nothing and the next rule applies.
6. The config file's `color` key.
7. Whether stdout is a terminal.

[no-color]: https://no-color.org

#### What `never` still emits

An explicit `never` directive — `--color=never`, `--no-color`, `MDVIEW_COLOR=never`, or
config `"color": "never"` — is not the same as byte-silence. It means *no hue*: bold,
dim, italic, underline and strikethrough are still emitted; only the seven colour codes
are dropped. True byte-silence — nothing of this tool's own emitted at all — comes only
from a kill-switch (`NO_COLOR` present, `FORCE_COLOR=0`), a non-terminal destination, or
`--plain`.

One consequence follows directly: fenced-code syntax highlighting runs under full colour
only, so under any `never` directive a code fence renders with no highlighting at all —
the same bytes a fence gets under true colourless output, even though the rest of the
page still carries its bold, dim, italic, underline and strikethrough formatting.

**OSC-8 hyperlinks are a separate axis.** What gets hyperlinked is markdown links
(`[text](url)`), wrapped as an OSC-8 escape sequence and DCS-wrapped when running inside
tmux or GNU screen (any `TERM` beginning `screen` or `tmux`) so the sequence survives the
multiplexer. They are never emitted off a terminal,
whatever the colour setting says — a pipe cannot render one — and `--plain` turns them
off absolutely. On a terminal, resolution order is `--hyperlinks=auto|always|never`
(bare `--hyperlinks` = `always`), then `MDVIEW_HYPERLINKS=auto|always|never`, then the
config file's `hyperlinks` key, then terminal detection: `auto` (the default) asks what
the terminal advertises. `NO_COLOR` does not turn hyperlinks off.

### Wiki-links

Obsidian-style `[[slug]]` syntax is recognized in the lexer's own pass, not bolted on
afterward. Four forms:

- `[[slug]]` — renders `slug` as the label.
- `[[slug|Alias]]` — renders `Alias` as the label; inline markup inside the label is
  itself rendered, because the label is lexed the same way any other inline content is.
- `[[slug#fragment|Alias]]` — the same, with the fragment discarded from the rendered
  label.
- `![[target]]` — an embed, rendered as `embed: target`.

The label renders cyan and underlined under the resolved colour policy (`formats` keeps
the underline and drops the cyan; `none` emits neither). A URL-shaped slug emits a
well-formed OSC-8 hyperlink under the same conditions a markdown link does.

On a hyperlink-capable terminal with hyperlinks on, a `[[slug]]` that names a file under
the note's vault or repository root also becomes a `file://` OSC-8 hyperlink the
terminal can open. The root is the nearest ancestor directory of the viewed file
containing `.obsidian` or `.git`, else the file's own directory. The slug is resolved
first as a path relative to that root (with or without `.md`), then as a unique basename
anywhere under it, ties broken by fewest path segments and then by the lexicographically
smaller path; matching tries the exact case first, then case-insensitively. A slug that
resolves to nothing renders exactly as before: styled, unlinked. Wiki-links inside table
cells are never linked. This link sits on the same `--hyperlinks` axis as a markdown
link, so `--plain`, `--hyperlinks=never` and piped output emit none of it.

Because recognition happens inside the lexer's own pass, verbatim contexts are literal
by construction: fenced and indented code, block HTML, a formed codespan (`` `[[note]]` ``
stays literal text), and a link or image destination or title never turn `[[…]]` into a
wiki-link. Inside a table cell, a wiki-link's label is styled and whitespace-normalized
like any other cell text; an unescaped `|` inside `[[…]]` splits the cell per GFM table
rules, so the authored-correct form when a label needs a literal pipe is `\|`.

Two scoped, deliberate losses: a `[[…]]` written inside a markdown link's label, or
inside an image's alt text, no longer forms the outer link or image — the wiki-link wins
and the outer construct does not form.

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

## jsonedit

The second command: a visudo-style safe editor for JSON, JSONC and JSON5 configuration files (Rust, `crates/jsonedit/`). It exists because some configuration is edited by hand on purpose — an agent harness's `~/.claude/settings.json`, for instance, carries permission rules the agent is not allowed to change itself — and a hand edit that leaves a stray comma or an unclosed brace silently breaks every tool that reads the file. `jsonedit` makes that edit the way `visudo` makes a sudoers edit: on a copy, validated before it replaces anything.

```bash
jsonedit settings.json                 # edit in $VISUAL / $EDITOR / vi; written only if valid
jsonedit --check config.jsonc          # validate only; FILE:LINE:COL: message, exit 1 on error
jsonedit --dialect jsonc --indent 2 tsconfig.json
```

- **Dialects:** `.jsonc` is JSONC, `.json5` is JSON5, anything else is strict JSON; `--dialect` overrides. Duplicate keys and empty input are errors in every dialect.
- **Safety:** the editor works on a private 0600 buffer that keeps the file's extension. The file is replaced atomically (same-directory temp, fsync, rename), with the editor's bytes verbatim — never re-serialised — and keeps its permissions. Symlinks are followed and left intact. A change made on disk during the edit is detected and never silently overwritten.
- **Invalid buffer:** the errors are printed and you choose `(e)dit again`, `e(x)it without saving` or `(a)bort keeping the buffer`. Without a terminal it never prompts: it keeps the buffer, prints its path and exits 1.
- **Indent style:** the file's indent unit is detected (or given with `--indent tab|N`); new or changed lines that do not match it produce a warning and a `(w)rite anyway` choice. Nothing is ever re-indented.

Exit codes: 0 written or unchanged, 1 invalid or aborted, 2 usage. `man jsonedit` has the full reference; building and installing it (`bun run build:rust`, the `~/.local/bin` symlink) is in `AGENTS.md`'s "Rust host prerequisites and install".

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

There is no published package yet. The renderer is a single static Rust binary (it was a ~102 MB Bun-compiled one until the Rust port; the TypeScript renderer's last commit is `c097c66`), so distribution is a matter of attaching per-platform binaries to releases. Nothing about this is implemented yet, and `package.json` stays `"private": true` until the maintainer decides otherwise.

## Third-party licenses

MIT (see [`LICENSE`](LICENSE)). Aggregated notices for everything compiled into the binaries — the Cargo crate closure, the vendored syntax grammars, and the vendored notices for ported code and data (string-width, get-east-asian-width, node-emoji/emojilib, highlight.js's alias names, the Unicode data licence, two-face's syntax licences) — are generated by `scripts/gen-licenses.ts`, never hand-edited, into [`THIRD-PARTY-LICENSES.txt`](THIRD-PARTY-LICENSES.txt), and printed by `mdview --licenses`.

## Contributing

`AGENTS.md` is the contributor contract: stack, layout, the rendering model, the corpus
sweep and its gates, dependency decisions, and the containment rules that keep this
repo safe to publish next to private ones. Read it before sending a change.
