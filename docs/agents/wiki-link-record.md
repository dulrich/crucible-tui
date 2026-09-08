# The wiki-link carrier defect — the full record

*Reference record for `src/`, moved out of `src/AGENTS.md` at WP-4 of
`plans/docs-and-memory-curation.md`. **`src/AGENTS.md` is the parent contract — read it
first**, and read its "How to read this file" for the two conventions everything below is
written under: every requirement is stated with the measurement that established it, and a
citation like `index.js:NNN` is historical evidence from `marked-terminal@7.3.0` rather
than a live dependency. There is deliberately **no `CLAUDE.md` symlink** beside this file:
it is an on-demand reference read, not a per-directory auto-loaded contract.*

**What this file settles:** the defect and the fix that closed it, the context table, the
precedence matrix, the three further defects the same mechanism caused, the three failed
fix designs, the C4 pass-through and the D4 GFM pipe rule, and witness ownership. The root
`AGENTS.md`'s Dependencies paragraph told the retirement half of this story a second time;
it is merged in at the end of this file, so this is the one owning home.

**The live carrier census — three carriers, not five — stays in `src/AGENTS.md`**, "The
sentinels": code points 2 and 3 mean nothing to this renderer now and pass through as
content, while 0 and 1 keep their strips.

### The wiki-link carrier defect — fixed, WP-2 of `plans/wiki-link-tokenizer.md` (`ab3518e`)

**Fixed by moving recognition into the lexer, not by patching the pre-pass.**
`plans/colour-modes.md`'s WP-1 (rev 4 at `c381d1c`) recorded this defect without fixing it,
after three fix designs failed across three audit cycles (below); `plans/wiki-link-tokenizer.md`
designed the successor across three further audit cycles and landed it at WP-2 (`ab3518e`).
`markWikiLinks` (deleted from `src/wikilink.ts` at that landing, called from
`preprocessBody`) used to run on every source line that `FENCE_LINE` (`src/render.ts:51`,
``` ``` ``` and `~~~` only) did not toggle off. There was no indented-code, block-HTML, or
container guard, so the pass fired on a line that later tokenized as verbatim content
exactly as it fired on ordinary prose.

**The substitution was irreversible by construction, which is why no downstream patch — at
a leaf or anywhere else — could have fixed it.** `markWikiLinks` replaced the whole
`[[…]]` (or `![[…]]`) match with carrier-wrapped `alias ?? slug` — the fragment, the `|`
separator, the `!`, and the slug itself (whenever an alias was given) were all discarded
before the lexer ever ran. A leaf that later discovered it was rendering verbatim content
had nothing left in the rendered text to restore the authored brackets from. **The fix that
landed does not restore anything — it never destroys the brackets to begin with**:
recognition is now an inline **tokenizer extension** inside marked's own lexing pass
(`wikiLinkExtension`, `src/wikilink.ts`), so the extension is simply never offered a
position inside a `code` token, a block `html` token, a container-nested code block, a
formed codespan, a link/image destination or title, or an HTML tag or comment. There is no
source-coordinate bookkeeping left to get wrong.

**Context table**, re-verified 2026-08-19 against `ab3518e` at width 80, `UNICODE_GLYPHS`,
both colour policies (`{sgr:"none",hyperlinks:false,tmux:false}` /
`{sgr:"full",hyperlinks:false,tmux:false}`):

| Context | Behaviour | Status | Witness |
|---|---|---|---|
| Indented code | `[[slug]]`, `[[slug\|Alias]]`, `[[slug#head\|Alias]]` and `![[embed]]` all keep every authored byte — the label survives inside the recorded `codeRange`, brackets and all; `codeRanges` are unchanged from the pre-fix pins | **fixed** | `tests/render.test.ts`, "C1: indented code keeps every authored byte — plain, alias, fragment, embed" |
| Fenced code | Left untouched — `FENCE_LINE`'s toggle skips every line between a pair of ` ``` `/`~~~` fences (unchanged; the tokenizer protects it too, redundantly, by construction) | guarded-by-FENCE_LINE | `tests/wikilink.test.ts`, "a fenced [[slug]] example is verbatim in both modes — now by construction" |
| Block HTML | `[[slug]]` keeps its authored brackets — no `codeRange` was ever needed for this fix, because the tokenizer never fires inside a block `html` token in the first place | **fixed** | `tests/render.test.ts`, "C1: block HTML keeps its authored brackets — the corruption with no codeRange to hide in" |
| Blockquote-nested code | Same repair, at the code's own nested position, inside a recorded `codeRange` | **fixed** | `tests/render.test.ts`, "C1: indented code nested inside a blockquote keeps its authored brackets" |
| List-nested code | Same repair, inside a recorded `codeRange` | **fixed** | `tests/render.test.ts`, "C1: indented code nested inside a list item keeps its authored brackets" |
| Codespan interior | `` `[[note]]` `` is now **literal** — the tokenizer can never be offered a position inside a codespan that syntactically forms, retiring colour-modes Decision 7's "kept-recognizing" row (locked D1). **Scope note — the landed outcome, not the plan's prediction:** when a `[[` opens *before* a backtick and the match's `]]` lands inside the would-be codespan, the wikilink still wins the position — that ownership decision is parity — but the label is now lexed in its own scope (D5), so its unmatched backtick has nothing left to pair with outside the match: **both backticks render literal** now, not the single-codespan-forms-inside-the-label shape the old pass produced. See the precedence-matrix row below for the falsified byte prediction | **literal (D1)** | `tests/wikilink.test.ts`, "a codespan's interior is literal now — locked D1"; the cross-boundary case is "D1 scope note: a match opening before a backtick still wins positionally" |
| Inline-HTML interior | `<span>[[note]]</span>` still recognizes and styles the label — unchanged, deliberately (probe f): the tokenizer fires inside the inline `text` run between the two `html` tag tokens, exactly as it does in ordinary prose | kept-recognizing, unchanged | `tests/wikilink.test.ts`, "an inline-HTML interior is still recognized — unchanged, and asserted as unchanged" |
| Link labels (a wiki-link's own alias containing a Markdown link) | Still does not match `WIKI_LINK_TOKENIZER` at all — the alias group excludes `]`, and a nested `[label](url)` contains one — passes through as literal text, unaffected by any of this | recorded-unchanged | `tests/wikilink.test.ts`, "an alias containing a Markdown link does not match, and continues not to" |

#### The surface was wider than verbatim contexts: the precedence matrix — fixed, WP-2

**The context table above enumerated only the verbatim-context corruptions. The pre-lexer
substitution reached further**, and `plans/wiki-link-tokenizer.md`'s three audit cycles
established the rest ("The precedence matrix"; every row below carries both the old
mechanism's bytes, pinned at that plan's WP-1, and the tokenizer's bytes, pinned at WP-2).
The old mechanism was one sentence: **a pre-lexer regex substitution over source lines
cannot know what a construct the lexer has not yet built will turn out to own**, so it used
to fire inside every one of these exactly as it fired in prose. The tokenizer extension
fires inside marked's own lexing pass instead, so none of them is reachable by it now.

| Context | Before (`markWikiLinks`) | After (the tokenizer, `ab3518e`) | Class |
|---|---|---|---|
| Backslash escape — `\[[note]]`, `\![[note]]` | recognition fired anyway: the `\` survived as literal text and the label styled beside it; `\![[…]]` still rendered `embed: ` | the escape is honored — the wiki-link does not form; `\![[…]]` is a literal `!` beside a forming embed | **C3 fix** |
| Inline-link destination — `[x](https://e/[[note]])` | destination rewritten, and under colour **SGR was injected into the href** | destination intact, no SGR | **C3 fix** |
| Inline-link title — `[x](url "[[t]]")` | rewritten (invisible — this renderer drops link titles) | intact | **C3 fix** |
| Image destination and title — `![alt](/[[note]])`, `![alt](/u "[[t]]")` | both rewritten; the title was visible, as `alt – title` | both intact | **C3 fix** |
| HTML attribute value — `<span title="[[note]]">` | rewritten, with SGR injected inside the tag | intact | **C3 fix** |
| Inline HTML comment — `<!-- [[note]] -->` | comment interior rewritten and styled | intact | **C3 fix** |
| Autolink — `<https://e/[[note]]>` | **broken**: the authored `>` was swallowed into the rendered href | intact — the authored `>` closes it | **C3 fix** |
| Bare URL — `https://e/[[note]]` | split into `https://e/` plus a styled label; with hyperlinks on, SGR landed in the OSC-8 destination | one intact token, clean OSC-8 destination | **C3 fix** |
| Reference-definition destination and title — `[x]: /[[note]]`, `[x]: /u "[[t]]"` | both rewritten, the definition consumed whole so nothing downstream could see it happened | both intact | **C3 fix** |
| Link label — inline, full-reference, collapsed and shortcut forms | the outer link survived (OSC-8 to the definition, styled label inside) | the outer link no longer forms — `text + wikilink + text` plus the literal remainder. **Granted loss, landed as such**, not a repair | **C3 loss (landed)** |
| Image alt text — all four forms | one image token, alt rewritten | image does not form; `text + wikilink` plus a literal suffix. Same loss shape | **C3 loss (landed)** |
| Cross-boundary greedy match — `` [[a `code [[y]] z` end]] `` | the wikilink won positionally; a codespan formed *inside* the label, across the match boundary | the wikilink still wins the position (the ownership decision is parity), but **both backticks are now literal** — the label is lexed in its own scope (D5), so its unmatched backtick has nothing to pair with outside the match. The plan's byte prediction ("identical") was falsified and user-accepted at landing (WP-2's finding 1); the *decision* is parity, the *bytes* are not | **D1 scope note (landed)** |

**Witnesses:** `tests/wikilink.test.ts`, "the precedence matrix — the candidate's bytes for
every changing row (WP-2, C3)", plus **"the ownership-class probe sweep — every built-in
inline shape, the candidate's bytes"** — the completeness instrument: eighteen shapes
covering every built-in inline ownership class in marked's tokenizer order, each
containing `[[note]]`, byte-exact in both colour modes. A class whose bytes move for a
reason the matrix does not name shows up there rather than nowhere.

#### Three further defects the same mechanism caused — all three repaired, WP-2

Each was invisible to every gate `bun run verify` runs, for the reason "Colourless gates cannot
see colour-only defects" (`src/AGENTS.md`) gives: they were colour-only, or inside a
`codeRange`, or both — which is why none of
the three ever showed up in a green run before this plan.

- **A URL-shaped slug used to emit a malformed OSC-8 sequence; it does not now (C5).**
  `[[https://example.test/path]]` has no alias, so the label *is* the URL. Under the old
  mechanism the finished document re-entered the lexer as text, came out a `url` token, and
  `renderLink` emitted OSC-8 for it — but the carrier-styling pass ran over the **finished
  document**, long after that emission, so the wiki chain's close codes landed **inside the
  destination, before the BEL**: `ESC]8;;https://example.test/path` + `ESC[24m` `ESC[39m` +
  BEL, which no terminal resolves. Under the tokenizer the label is lexed into children at
  tokenize time, so the `url` child reaches `renderLink` with a clean destination and the
  OSC-8 sequence is well-formed. Witness: `tests/wikilink.test.ts`, "C5 — a URL-shaped label
  emits a well-formed OSC-8 (WP-2, repaired)", pinned with hyperlinks off/on and the tmux DCS
  envelope, plus "the destination is sanitized at emission — an authored control byte cannot
  escape it".
- **A wrapped wiki label in a table cell no longer bleeds its colour into the neighbouring
  cell (C6a).** `src/table.ts` builds plain measured strings and never dispatches a cell
  token (`renderTable`), so under the old mechanism a label in a cell was styled by the same
  document-wide pass that styled prose — which saw a label already split across rows and
  opened its chain on one row, closing it on another, with the cell's padding, the border
  glyph and **the next column's text** all inside the open style. Measured at width 16 on
  `| [[abcdefghijklmnopqrstuvwxyz]] | y |`: the `y` column used to render between a cyan
  open and its close on a row whose own cell held no wiki-link. The span-cell contract
  styles each fragment independently now, so no sequence crosses a cell's padding or a
  border. Witness: `tests/wikilink.test.ts`, "C6a: a wrapped label is styled per fragment —
  nothing crosses padding or a border", plus the bleed-inversion assertions in "C6a: a body
  cell and a header cell…" and the alignment/prose-adjacency cases beside it.
- **A label's boundary whitespace no longer survives cell normalization as an accident
  (C6b).** `cellText` collapses `\s+` and trims; the old carriers were control characters,
  not whitespace, so they stood between a label's own leading and trailing spaces and that
  collapse — a barrier nothing designed, and `| [[ b ]] |` used to render a three-column
  label ` b `, which no other cell text in this renderer did. With the carriers gone there is
  nothing left to fence the collapse, so a wiki label now normalizes exactly like every other
  cell's text: `| [[ b ]] |` renders a **one**-column label. This is a **deliberate behaviour
  change, not a restoration** — the old three-column form was itself the defect (an artifact
  of the carriers, not an authored intent), and the fix is that wiki labels stopped being a
  special case. Witness: `tests/wikilink.test.ts`, "C6b: a label's boundary whitespace
  normalizes like every other cell text", plus "C6b: the normalization edge grid — edges,
  adjacency, internal runs, entities, embeds".

The contract that makes all three possible — `{ text, spans }` carried through the cell
pipeline so styling applies **per wrapped fragment at emission**, where a sequence cannot
cross padding or a border, over text normalized like every other cell's — landed
byte-identically at WP-1 with a synthetic-span battery (`tests/table.test.ts`) driving every
clipping, wrapping, padding, measurement and nesting path before any producer existed; the
`wikilink` span producer that puts real spans into it is WP-2's (`src/table.ts`).

**Three failed fix designs, and why each died** — one plan, three audit cycles, no fourth
mechanism proposed after the third failed:

1. **Restore at the leaves** (rev 1). A leaf renderer (`code`, `html`, …) that detects it
   is rendering verbatim content tries to undo the carrier substitution and reconstruct
   the authored `[[…]]`. Dead on arrival: the substitution already discarded the
   fragment, the `|` separator, the `!`, and the slug itself whenever an alias is present
   (`markWikiLinks`, removed at `ab3518e`; see git history — the lines this citation once
   pointed to now hold `WIKI_LINK_STYLES`) — there is nothing left in the rendered text for
   a leaf to restore *from*. `runs/dispatch/colour-modes-plan-audit-report-cycle1.md`,
   finding 2.
2. **A byte-offset line map** (rev 2). Accumulate marked's block-token `raw` lengths
   before substitution runs, to know per source line which lines are block-verbatim, and
   skip those in `preprocessBody`. Failed on three independent grounds: marked
   normalizes CRLF to LF, so concatenated token `raw` lengths cannot reconstruct a CRLF
   source's line coordinates — the committed gate-corpus witness
   `tests/fixtures/witnesses/defect-0-crlf-frontmatter.md` breaks the map's own stop
   condition on the binding corpus; top-level accumulation cannot see code nested under
   `blockquote` or `list` tokens, which only ever appear in container children; and
   computing the map before `stripSentinelChar`/`stripTaskStateSentinel`/
   `stripWikiLinkCarriers` run is not classification-preserving — stripping code point 2
   alone changes a paragraph into indented code. `runs/dispatch/colour-modes-plan-audit-report-cycle2.md`,
   finding 1.
3. **A line-count map** (rev 3). Count physical lines per top-level token instead of
   bytes, to sidestep CRLF. Failed differently: token raw line counts are not additive
   across blank-line boundaries (a five-physical-line source splits into three tokens
   whose raw line counts sum to seven, with no rule for which token owns a shared blank
   line), and — more decisively — **marked elides reference definitions from the token
   array entirely**, keeping them only in `tokens.links` with no `raw` and no position, so
   a line-count walk has nothing to place a following code block against.
   `runs/dispatch/colour-modes-plan-audit-report-cycle3.md`, finding 1.

**A fix needs pre-lexer knowledge of which source lines are block-verbatim — source
anchoring marked's own lexer does not provide** (no source-offset API; the same interface
gap `src/walk.ts`'s header and `docs/adr/0001-editor-path.md` both cite for the styled-run
work this repo has already deferred once). That is a successor plan's job — plausibly by
owning the lexer — and the three failures above, together with the context table and the
witnesses it cites, are its starting record rather than a foundation to build on: a future
fix that changes any pinned byte will trip a named witness, which is the point. This
record sits beside, and does not amend, "The task-state pre-pass" (`src/AGENTS.md`): that pass's own
class-C exception was requested and **the user withheld it** (`src/render.ts:193-213`,
`rewriteTaskState` — `src/AGENTS.md`'s task-state section). The two defects share a
mechanism — an unguarded
pre-lexer substitution reaching fenced or indented code — but they are independently
dispositioned, and repairing one does not authorize repairing the other.

**The successor exists and it does not need pre-lexer knowledge at all, which is why the
paragraph above is kept rather than corrected.** `plans/wiki-link-tokenizer.md` (approved
2026-08-19, three audit cycles) moves recognition **into** marked's lexing pass as an
inline **tokenizer extension**, so a verbatim context is protected *by construction*: the
inline tokenizer is simply never offered a position inside a `code` token, a block `html`
token, a container-nested code block, a formed codespan, a link or image destination or
title, or an HTML tag or comment. There is no source-coordinate bookkeeping left to get
wrong, which is what all three failed designs above were trying and failing to do. The
sentence "a fix needs pre-lexer knowledge" was the correct conclusion from three failures
at *patching the pre-pass*, and it is exactly the assumption the successor discards.

**Fixed by, and the grant's limits held.** WP-2 of `plans/wiki-link-tokenizer.md` landed at
`ab3518e`: recognition is the inline tokenizer extension described above, a `WikiLinkToken`'s
children style at emission through `styleWikiLabel`/`applyStyleChain` (`src/style.ts`), and
the carrier machinery — `markWikiLinks`, `markWikiLink`, `stripWikiLinkCarriers`,
`styleWikiLinkCarriers`, the carrier constants, and the post-walk styling pass — is gone
entirely. Rendered bytes changed **inside recorded `codeRanges`**, exactly as the grant
authorized (C1) and not one byte further: **the task-state surface stayed untouched and
user-withheld** — `src/render.ts:193-213` (`rewriteTaskState`) is hash-identical across the
cutover, enforced directly by `tests/render.test.ts`'s "task-state adjacency — held
unmodified through the tokenizer cutover". Two of WP-1's 42 whole-document task-state pins
could not hold unedited on their *wiki-link* half — one is C1's own granted repair, landing
inside a recorded `codeRange`; the other gained one `ESC[90m` blockquote-gray re-open that
`link`/`del`/`codespan` already trigger there today, which is C2's "wiki-links behave like
every other styled span" reaching one more path — both orchestrator-accepted findings, and
neither moved a task-state byte, held directly by "every task-state glyph and its column are
exactly WP-1's, in both tiers", which carries no wiki-link byte at all. The gate corpus did
not move: three env-pinned render-diff runs against the pre-cutover commit (`9c19997`) read
`combos=280 diffed=0 ok=true` under `FORCE_COLOR=0`, `FORCE_COLOR=3`, and
`MDVIEW_COLOR=never`. The link- and image-label rows of the precedence matrix are **granted
losses**, landed as such, not repairs.

**C4 — authored control bytes 2 and 3 now pass through as content.**
`stripWikiLinkCarriers` used to sanitize *authored* STX/ETX before the lexer and after
render, because those bytes had internal meaning to the carrier mechanism. With the
mechanism gone the bytes mean nothing to this renderer, so the fidelity rule (colour-policy
Decision 1) applies: an authored code point 2 or 3 now passes through untouched, in both
directions, fences included. Code points 0 and 1 (`SENTINEL`, `TASK_STATE_SENTINEL`) still
strip — they still have internal meaning. The invariant that survives is rephrased, not
retired: **the tool generates no carrier byte and no escape byte that enters the lexer** —
asserted by comparing authored-ESC positions and counts across `preprocessBody`, now
*absolutely* rather than merely relatively identical, plus a dedicated pass-through witness.
Witnesses: `tests/wikilink.test.ts`, "C4 — authored code points 2 and 3 pass through, and
0/1 still do not" (survives preprocessing and reaches the output; forges nothing; passes
through inside a fence too; 0/1 still stripped); `tests/render.test.ts`, "with no policy, a
wiki-link emits no escape — and no tool-generated 2/3 for carrier-free input".

**D4 — an unescaped `|` inside a cell's `[[…]]` splits the cell, and that is GFM, not a
defect.** `marked` unescapes `\|` when it splits a table row, before a cell's inline source
is built, so the authored-correct spelling in a cell is the escaped `[[s\|Alias]]`. An
unescaped `[[s|Alias]]` is read as two cells by GFM's own row-splitting rule, exactly as any
other cell content containing a bare `|` would be — the tokenizer is never handed a
contiguous string to recognize. Recorded here **so a future "defect" report can be answered
from the record**: author `\|`. Witness: `tests/wikilink.test.ts`, "D4: an escaped pipe
keeps the alias in one cell; an unescaped one splits it, per GFM".

#### Witness ownership — which tests fence what

Kept beside the defect record rather than in `tests/AGENTS.md`, which stays scoped to
containment and the fixture trap.

| Surface | Lives in | Fenced by |
|---|---|---|
| The extension itself (shape, `start`, the two regexes, D5's lexing) | `src/wikilink.ts` | `tests/wikilink.test.ts`, "the tokenizer extension — shape, registration, and the token it produces"; "the two regexes — the provenance record and the lexer form" |
| The walker's `wikilink` dispatch, the override contract, the block-walk throw | `src/walk.ts` | `tests/walk.test.ts`, "TokenWalker — the wikilink case and the parseInline override contract" (7 tests) |
| Verbatim-context protection (C1) | `src/wikilink.ts`'s tokenizer, by construction | `tests/render.test.ts`, "renderDocument — verbatim contexts keep their authored brackets (wiki-link-tokenizer WP-2, C1)" |
| The precedence matrix — fixes and losses (C3), the D1 scope note, the ownership-class sweep | `src/wikilink.ts` + `src/walk.ts`'s dispatch | `tests/wikilink.test.ts`, "the precedence matrix — the candidate's bytes for every changing row (WP-2, C3)"; "the ownership-class probe sweep — every built-in inline shape, the candidate's bytes" |
| C4 (authored 2/3 pass through), the lexer-input witness | `src/render.ts`'s `preprocessBody` (no wiki-link strip left in it) | `tests/wikilink.test.ts`, "C4 — authored code points 2 and 3 pass through, and 0/1 still do not"; "the lexer-input witness: preprocessing introduces no NEW ESC byte and no carrier" |
| C5 (OSC-8 repair) | `styleWikiLabel` → `renderLink` (`src/wikilink.ts`, `src/inline.ts`) | `tests/wikilink.test.ts`, "C5 — a URL-shaped label emits a well-formed OSC-8 (WP-2, repaired)" |
| C2 (wrapped prose labels carry one pair, not one per line) | `styleWikiLabel`/`applyStyleChain` (`src/wikilink.ts`, `src/style.ts`) | `tests/wikilink.test.ts`, "C2 — a wrapped prose label carries one pair, not one per line (WP-2, repaired)" |
| C6a/C6b (cells), D3 (no OSC-8/nested SGR in cells), D4 (the GFM pipe) | the `wikilink` span producer (`src/table.ts`) | `tests/wikilink.test.ts`, "C6 — table cells: fragment-scoped styling and ordinary normalization (WP-2, repaired)"; `tests/table.test.ts`'s production span-producer block |
| Task-state adjacency, held unmodified (C1's own limit) | `src/render.ts`'s `rewriteTaskState` (untouched, hash-identical) | `tests/render.test.ts`, "task-state adjacency — held unmodified through the tokenizer cutover"; "every task-state glyph and its column are exactly WP-1's, in both tiers" |
| The applicator lift (`applyStyleChain`: one definition, two call sites) | `src/style.ts` | `tests/style.test.ts`, the carrier-absence assertion rephrased per C4 |

#### The same closure told from the dependency-ownership rule — merged from the root `AGENTS.md`

*This paragraph lived in the root `AGENTS.md`'s Dependencies section, which told the
retirement half of the story a second time from the escape-emission angle. It is relocated
here verbatim (only its closing pointer is repointed, since it now sits inside the record
it used to point at), so this file is the one owning home for the carrier's retirement.
The removal of `ansi-escapes` — the paragraph this one used to follow, and the reason
`styleWikiLink`'s pre-lexer pair was the rule's last exception — is
`docs/agents/dependency-history.md`.*

**That carrier pair is itself gone now, and the invariant it served got stronger rather than
merely surviving the change.** WP-2 of `plans/wiki-link-tokenizer.md` (`ab3518e`) moved
recognition into marked's own lexing pass, as an inline **tokenizer extension**
(`wikiLinkExtension`, `src/wikilink.ts`), so a `WikiLinkToken`'s label is lexed into child
tokens at tokenize time and styled at emission — `styleWikiLabel` over the shared
`applyStyleChain` (`src/style.ts`), the same authority every other styled span already
uses — with nothing left to carry between the source and the walk. **No ESC byte this tool
generates enters the lexer** (asserted directly, by comparing authored-ESC positions and
counts across `preprocessBody` rather than by demanding ESC absence, which Decision 1's
fidelity rule for authored escapes forbids), and that claim no longer rests on carrier
accounting at all: **no tool-generated carrier byte exists any more**, because the tokenizer
is simply never offered a position inside a `code` token, a block `html` token, a formed
codespan, or a link/image destination or title — there is nothing to strip because nothing
is ever written. The gate corpus did not move a byte across that cutover either, verified by
three env-pinned render-diff runs against the pre-cutover commit (`9c19997`):
`combos=280 diffed=0 ok=true`, under `FORCE_COLOR=0`, `FORCE_COLOR=3`, and
`MDVIEW_COLOR=never`. The context table, the precedence matrix and the witness-ownership
table above are the full record this sentence used to point at.


**And the successor this record kept naming has arrived for the viewer.** `WikiLinkToken` kept `slug` and `alias` "because a successor that navigates a wiki-link needs the *target*, not the label"; WP-2 of `plans/follow-wiki-links.md` is that successor, and it added `fragment` beside them for the same reason. A label whose slug names a file under the note's vault root is now wrapped in an OSC-8 `file://` link, on the existing `--hyperlinks` axis, with the resolution itself owned by `src/wikiresolve.ts` and reached through one optional `LayoutContext` field. **The live record of that seam is `src/AGENTS.md`, "Following wiki-links"** — D1–D7, the measured vault, the cells deferral and the byte-stability argument. What stays here is what this file has always been: why the *carrier* mechanism existed and how it was retired, which is the history the new behaviour is built on top of rather than part of.
