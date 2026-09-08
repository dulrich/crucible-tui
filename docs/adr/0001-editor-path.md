# ADR 0001: The render-to-ANSI viewer architecture is a dead end for editing

Status: accepted. Recorded 2026-07-28 (WP-6b), from the field-position research in
`plans/crucible-tui-launch.md` (see its "Architecture finding that shapes the roadmap"
paragraph, `plans/crucible-tui-launch.md:26`), so the OpenTUI/document-model direction
below is not re-derived the next time this comes up.

Context historicized 2026-08-19: `marked-terminal` and `cli-table3`, both named in the
Context below, have since been removed from the tree — the prose/list/table rendering
they did, and the border/cell assembly `cli-table3` did, are this repo's own code now.
Item 1's token → styled-span renderer is still open work, but its *first* half —
replacing marked's own `Parser` as the tree walker, so the renderer's methods are no
longer callbacks a third-party walker invokes — landed at WP-2 of
`plans/own-the-token-walk.md`; the renderer methods themselves still return a bare
`string` (`marked.d.ts`'s callback type is unchanged), so the widened
`{ text, style, sourceStart, sourceEnd }` return type this ADR's Decision 1 describes
remains the open successor work. What "mdview's own renderer overrides" (Decision 4)
means has also changed shape: it is no longer `src/render.ts` alone but is spread across
`src/inline.ts`, `src/blocks.ts`, `src/lists.ts` and `src/table.ts`. The decision text
below — the OpenTUI recommendation, the Ink rejection, the source-mapping analysis —
stands untouched; this note records what has moved since it was written. One behaviour has moved *toward* this ADR's subject without being it: since `plans/follow-wiki-links.md` the viewer **navigates** a wiki-link, by emitting an OSC-8 `file://` link the terminal follows — which is a hyperlink in a rendered string, not the document model with source coordinates that Decision 1 describes, and it neither depends on nor advances the widened return type.

## Context

mdview's whole rendering pipeline is: parse Markdown with `marked`, render each node to
a fully-formed ANSI string with `marked-terminal` (plus mdview's own overrides for
wrapping, tables, and glyph tiers), and hand the finished string to a pager or stdout.
This is the category-winning architecture for a *viewer* — a survey of nineteen
terminal Markdown/TUI tools (read by source and commit history, not by README) found it
is what the best-regarded one in the field (`glow`) does, and stage one of this tool is
built the same way for the same reason: it is simple, fast, and gets tables and list
wrapping right, which most of the field does not.

It is also a hard dead end if this tool ever needs to become an editor rather than a
viewer — and "editor" is not a hypothetical; the project name `crucible-tui` (as
opposed to the command name `mdview` — see `AGENTS.md`'s "Two names, on purpose") exists
specifically to leave room for that.

The reason it's a dead end: by the time `renderDocumentDetailed` returns, its output is
a flat string of characters and ANSI escape codes. Every rendered cell — a word, a table
column, a list bullet — has lost the byte offset in the *source* document it came from.
Nothing downstream can answer "if the user's cursor is sitting on screen column 47, row
12, what source byte are they looking at?", because that mapping was never carried
through the pipeline; it was discarded the moment `marked-terminal` (or mdview's own
`paragraph`/`list`/table overrides) wrote styled text into a plain string. A viewer
never needs that mapping. An editor needs it for every keystroke: knowing where the
cursor is *in the source* is the entire problem an editor exists to solve.

## Decision

Accept the ANSI-string architecture for the viewer this tool is today, and record —
rather than build now — what the migration looks like if editing is ever taken on:

1. **Replace `marked-terminal` with a token → styled-span renderer that carries source
   ranges.** Instead of rendering a token straight to an ANSI string, render it to a
   sequence of `{ text, style, sourceStart, sourceEnd }` spans (or an equivalent
   structure). The styled-span layer becomes the thing that knows how to turn spans
   into ANSI for display *and* how to map a display position back to a source
   offset — both directions, because an editor needs to go from keystroke to source
   edit and from source edit back to what's on screen.

2. **Adopt [OpenTUI](https://github.com/sst/opentui)** as the terminal UI layer for
   anything beyond paging a finished string. It is Zig-core, MIT-licensed, Bun-native,
   and already ships the primitives an editor needs that a pager does not:
   `edit-buffer`, `editor-view`, `ScrollBox`, and `Textarea`. Building those primitives
   from scratch would be most of the work of becoming an editor; OpenTUI already having
   them is why it is the specific recommendation here rather than "some TUI framework."

3. **What survives the transition, unchanged:** the Markdown *parse* (`marked`'s
   lexer/tokenizer), the fence-language and theme mapping (`src/lang.ts`), any
   persistent index built for large vaults, and the CLI surface and its subcommands
   (`src/cli.ts`). None of that is ANSI-string-shaped; all of it operates on tokens,
   language identifiers, or file paths, and stays valid regardless of what renders the
   result to a terminal.

4. **What does not survive:** `marked-terminal` itself, and every one of mdview's own
   renderer overrides in `src/render.ts` that currently produce ANSI text directly
   (`paragraph`, `list`, `heading`, `blockquote`, the table renderer). All of that logic
   — wrapping rules, list-budget arithmetic, glyph-tier substitution — has to be
   re-expressed as span-production rather than string-production, because the display
   text and the source-mapping metadata have to come out of the same pass, not be
   bolted together after the fact.

**Ink is explicitly rejected for this role.** Ink is the obvious default choice for a
Bun/Node terminal UI and this project already imports its ecosystem's other libraries
(`string-width`, `cli-table3`), but Ink has had open requests for a scrollable viewport
for seven years with no resolution. A markdown viewer/editor that cannot scroll past one
screen of content is not a candidate at all, independent of the source-mapping question
above.

## Consequences

- **No work item currently depends on this.** This ADR exists so that if editing is
  proposed later, the answer to "what would that take" is a lookup, not a new research
  pass repeating the nineteen-tool field survey and rediscovering the same dead end.
- **The current architecture is not being changed pre-emptively.** `marked-terminal`
  and mdview's own ANSI-producing overrides stay exactly as they are for as long as this
  tool is view-only. Migrating early, with no editing feature to justify it, would cost
  real rendering-correctness risk (this is the same codebase the WP-2 family spent
  several work packages getting list-wrapping right in) for zero user-visible benefit.
- **A future editing proposal should budget for a rendering rewrite, not a rendering
  extension.** "Add editing to mdview" is not a small addition on top of the current
  renderer; it requires replacing the renderer's output shape everywhere source-mapping
  matters, which in practice means everywhere.
- **The command name does not need to change for this to happen.** `mdview` keeps
  meaning "the command that views markdown" until an editing feature actually ships;
  see `AGENTS.md`'s "Two names, on purpose" for why that split exists and how a future
  rename would be handled if this ADR's decision is ever acted on.
