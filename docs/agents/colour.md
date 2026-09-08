# Colour — the owned decision, the three levels, and the reader inventory

*Reference record for `src/`, moved out of `src/AGENTS.md` at WP-4 of
`plans/docs-and-memory-curation.md`. **`src/AGENTS.md` is the parent contract — read it
first**, and read its "How to read this file" for the two conventions everything below is
written under: every requirement is stated with the measurement that established it, and a
citation like `index.js:591` is historical evidence from `marked-terminal@7.3.0` rather
than a live dependency. There is deliberately **no `CLAUDE.md` symlink** beside this file:
it is an on-demand reference read, not a per-directory auto-loaded contract.*

**What this file settles:** the one owned colour/hyperlink policy and where it is resolved,
the three-level `SgrMode` and the hue/format split, the reader inventory with each reader's
threshold, and the policy-resolution history including the styled-runs predecessor.

**Two neighbours this record leans on, both still in `src/AGENTS.md`:** "Colourless gates
cannot see colour-only defects" (the measurement rule this record's own figures are subject
to, and its WP-3 closure) and the rendering policy's highlighting-path entry. The removal
of the packages that used to make this decision — `supports-color`, `supports-hyperlinks`,
`@colors/colors`, `cli-highlight`, `ansi-escapes` — is `docs/agents/dependency-history.md`.

## Colour: one owned decision, resolved from inputs handed in

**How much SGR this render emits is `LayoutContext.sgr`, a three-level `SgrMode`**; whether the
renderer emits OSC-8 hyperlinks is `LayoutContext.hyperlinks`. Both are resolved **once per
render**, by `resolveColourPolicy` (`src/colour.ts`), and threaded as
`renderDocumentDetailed`'s last parameter — WP-1 of `plans/colour-policy.md`, with the colour
half widened from a boolean at WP-2 of `plans/colour-modes.md`.

**Nothing in `src/colour.ts` reads `process`.** The environment, the destination's TTY-ness, the
platform, the parsed `--color` flag and the config file's `color` key are all arguments. That is
the same rule `glyphs` and `measure` already follow, extended to the last decision that was still
being made behind the renderer's back, and it is what makes every environment case testable in
one process — `tests/colour.test.ts` runs the whole matrix, including the Windows branches, with
no subprocess anywhere.

The ratified precedence, highest first, is `--color` → `MDVIEW_COLOR` → `NO_COLOR` (presence
counts, even empty) → `FORCE_COLOR` → config `color` → `isTTY`. Two edges are worth naming here
because they are policy rather than transcription: **`NO_COLOR` outranks `FORCE_COLOR`** (a user
who exported the first said something about this machine; a `FORCE_COLOR` inherited from some
parent process did not), and **a malformed `FORCE_COLOR` decides nothing and falls through** —
`"0"`/`"false"` are no, `""`/`"true"`/`"1"`-`"3"` are yes, and anything else is not a directive.
Hyperlinks are an independent axis with an absolute non-TTY ceiling; `NO_COLOR` does not touch
them. **The hyperlink axis's own precedence**, highest first, since WP-3 of
`plans/colour-modes.md` (Decision 6): the non-TTY ceiling (checked first inside
`resolveHyperlinks`, and still absolute — nothing below it can turn a hyperlink on off a
terminal) → `--hyperlinks` flag → `MDVIEW_HYPERLINKS` → config `hyperlinks` → terminal
detection. `HyperlinkInput` — the interface `resolveHyperlinks` is typed to — carries the new
`flag`/`config` fields; `resolveColourPolicy`'s own signature is unchanged, and it maps its
`ColourPolicyInput`'s new `hyperlinkFlag`/`hyperlinkConfig` fields into them (cycle-3 f5's exact
type relationship, so `resolveHyperlinks` never has to know the shape of the larger input).

**`--plain` sits above both axes and is not a fifth precedence slot — it is a short-circuit at
the CLI boundary, and where that happens matters.** Decision 2: the policy under `--plain` is
built by hand in `src/cli.ts`'s `runView` — `{ sgr: "none", hyperlinks: false, tmux:
resolveTmux(env) }` — **without calling either `resolveColor` or `resolveHyperlinks` at all**.
The alternative — giving `--plain` the top slot in each ladder and letting the existing
functions return early — was rejected (cycle-3 f4): even an early return still *evaluates* the
call, and both functions read `MDVIEW_COLOR`/`MDVIEW_HYPERLINKS` and call `warn` on a malformed
one before deciding anything else, so a `--plain` render would have printed a warning about an
environment variable it was about to ignore. Short-circuiting one level up — never calling the
resolver — is the only shape where a malformed value under `--plain` produces silence, which is
what `tests/cli.test.ts`'s no-warning-under-`--plain` cases assert. `tmux` is still resolved
under `--plain`: it is a fact about the destination an OSC-8 emitter would need, not a colour
decision, and resolving it costs nothing even though `--plain`'s `hyperlinks: false` means it
never gets used.

*History, because the conclusion inverted.* Until WP-6 this asked `marked-terminal` directly: a
throwaway extension was built, its `strong` was handed a probe string, and the answer was
whether anything came back around it. WP-6 replaced that with **`supports-color`, promoted from
transitive to direct**, on the argument that `chalk`'s rule — ~150 lines of stream, flag and
environment inspection — was the rule that had always governed this tool's output, and that a
tool reproducing only the TTY half would answer differently the first time it met `--color`,
`FORCE_COLOR=false`, `TERM=dumb` or a CI runner. The equality was measured rather than assumed:
both spellings ran against a **36-cell environment matrix** and **agreed on all 36**.

**That measurement still stands and is no longer the argument, because the goal changed.** The
question WP-6 answered was *what does `chalk` decide here*; the question the ratified policy asks
is *what should this tool decide*, and the two have different answers. `supports-color@7.2.0`
scans the whole of `process.argv` for `--color` through `has-flag`, so a flag aimed at the `bun`
wrapper — or at nothing at all — turned styling on inside the renderer; and it has **no reference
to `NO_COLOR` at all**, so the one environment variable with an actual cross-tool convention
behind it was ignored for the tool's entire life. Neither is a bug in that library. Both are
disqualifying for a policy this tool is supposed to own, which is why the dependency went.

**`chalk` itself is not a dependency of this repo and is not read anywhere.** A copy survives in
the tree at `4.1.2` only as **eslint's** transitive — a devDependency of a devDependency, in
nothing this ships; the nested `5.6.2` left with `marked-terminal` and the `4.1.2` that
`cli-highlight` pulled in left with it at WP-2.

**Two authorities disagreed with the policy above for exactly one work package, and closing
them is what WP-2 of `plans/colour-policy.md` did.** `src/table.ts` styled through
`@colors/colors`' own environment-only `enabled` flag, and `cli-highlight` gated syntax colour
on that `chalk@4`'s module-load level. So `MDVIEW_COLOR=always` on a pipe coloured everything
the renderer emitted and **nothing** either of those two emitted — measured on `tight-list.md`
at width 80, where the forced-colour render carried the highlighter's `31m`/`36m` token colours
and the `MDVIEW_COLOR=always` render did not, with identical visible text. `--color=always`
happened to agree with `FORCE_COLOR=3` only because `@colors` sniffed argv for `--color` too,
which was the same accident in a second package.

**Both packages are gone and every producer reads the resolved mode.** The styles come from
`src/style.ts` — a narrow committed table of exactly the `[open, close]` pairs this renderer is
authorized to emit, with `38`/`48` introducers rejected by an assertion independent of the
emitter — and the syntax colours from `src/highlight.ts`, this repo's transcription of
`cli-highlight`'s span walk over `highlight.js` direct. What that bought, measured at WP-2's
close over all fourteen gate-corpus files at three widths in both glyph tiers:
**`MDVIEW_COLOR=always` on a pipe is byte-identical to `FORCE_COLOR=3` in 84 of 84 combos**
(36 of the 84 differed before), and the forced-colour render itself did not move a byte.

**"Every producer" was one short until WP-4, and the exception was the oldest of them.**
`styleWikiLink` (`src/render.ts`) read no policy at all — it wrote a cyan/underline SGR pair
into the markdown *source* before the lexer, so it styled at every colour level including
colourless and its bytes were not in the committed table. `src/wikilink.ts` replaced it with a
carrier pair through the lexer and a post-walk pass over `applyStyle` (see "The sentinels",
`src/AGENTS.md`),
and the sentence above is now unqualified. Measured: the forced-colour render is byte-identical
across the change in all 84 colour-on combos, the colour-off render lost exactly those four
escape codes on the one gate-corpus file that carries a wiki-link and moved no visible
character on any of the 168 combos measured, and the colour axis's `sgrAny` went **5 → 0**.
**That carrier pair is itself gone now**, retired without replacement at WP-2 of
`plans/wiki-link-tokenizer.md` (`ab3518e`): recognition moved into the lexer as an inline
tokenizer extension, and a label styles at emission through `styleWikiLabel`/
`applyStyleChain` — see "The wiki-link carrier defect" (`docs/agents/wiki-link-record.md`)
for the closure. The claim this
paragraph makes — every producer reads the resolved policy, and the renderer emits no escape
byte this repo does not spell — is unaffected and, if anything, stronger: there is no carrier
left to account for either.

**One colour-off consequence, and it is Decision 1 rather than a regression.** Because
`@colors` answered from the environment without consulting `isTTY`, a plain
`mdview file.md | cat` used to emit that package's table styling into the pipe — 205 grey pairs
and 12 bold pairs on `wide-table.md` alone, with no colour requested anywhere. Those escapes are
gone: the piped default now emits exactly what a `FORCE_COLOR=0` render always emitted, which is
what the ratified spec's first decision asks for. The visible text is identical, and the
sanitized colour-off renders every gate and sweep actually measures were byte-identical across
the package (84 of 84).

### Three levels, not two: `SgrMode` and the hue/format split (WP-2 of `plans/colour-modes.md`)

`ColourPolicy.color: boolean` became **`sgr: "full" | "formats" | "none"`**, and that one type
is the whole of the colour-mode work. The predecessor plan
(`plans/styled-runs-and-colour-policy.md`, closed won't-implement and deleted at
`795ef9b`) needed eight work packages
for the same semantics because hue and weight were fused into opaque byte strings at six
independent producers, and *"thread a policy to the producers"* cannot express *"drop hue,
keep bold"*. `plans/colour-policy.md` retired that premise without setting out to: since it
landed, every producer holds a **named** chain (`createStyler("gray")`, not `"\x1b[90m"`) and
exactly two emitters turn a chain into bytes. The name survives to the point of emission, so
the mode semantics are a **filter inside `src/style.ts`** rather than a renderer migration.

**What each level means.**

| Level | Emits | Reached by |
|---|---|---|
| `full` | every committed style | `always` at any slot; `FORCE_COLOR` truthy; the `isTTY` floor |
| `formats` | format and control classes; **no hue** | the three explicit `never` **directives** only — `--color=never`, `MDVIEW_COLOR=never`, config `never` |
| `none` | nothing of the tool's own | `NO_COLOR` presence; `FORCE_COLOR=0`; a non-TTY with nothing requested |

**The kill-switch/directive split is the load-bearing distinction and it is not cosmetic**
(Decision 5). A `never` *directive* is a user saying *this tool, this render, no colour*, and
Decision 1 reads that as "no hue, keep the formatting" — dim, bold, italic, underline and
strikethrough are not colour. `NO_COLOR` and `FORCE_COLOR=0` are kill-switches with an
established cross-tool meaning and an installed base, and they keep today's bytes exactly.
**Those three directive routes are the exhaustive list of inputs whose rendered bytes WP-2
moved**; `full` and `none` renders are byte-identical to the WP-1 commit across the gate
corpus at every width and both tiers, verified by scripted byte diff (336 combos, 0 differing)
as well as by `render-diff --expect a`. Any other moved byte is a defect, not a re-baseline.

**The classification is of style *names*, and it lives beside the table it classifies.**
`STYLE_CLASSES` (`src/style.ts`) is total over `STYLE_TABLE` by a `satisfies` constraint, so a
new committed style cannot be added without being classified:

- **hue** — `red green yellow blue magenta cyan gray`. The only class `formats` drops.
- **format** — `bold dim italic underline strikethrough`. **`dim` is a format, not a hue** —
  the user's own words at Decision 1, and the membership most at risk of being "corrected" by
  someone reading `2m` as a brightness. It is what keeps the frontmatter metadata block
  legible under `--color=never`.
- **control** — `reset` (Decision 8, cycle-1 f9). `0m` both directions, framing every
  paragraph, rule and list item. Emitted whenever `sgr !== "none"`.

**The filter runs before `chalk`'s two surgeries, and the ordering is the part to get right.**
`applyStyle`'s re-open surgery re-emits *this chain's own* close codes and appends the matching
open; its newline encasing reinserts *this chain's own* `openAll` after every line break. Run
either over the unfiltered chain and a `formats` render gets its hue back — on the second line
of every wrapped span, where no single-line assertion would see it. `filterChain` rebuilds the
chain through `createStyler` over the surviving names rather than string-editing `openAll`,
because the accumulation order (outermost-first open, innermost-first close) is a parity-class-A
obligation and re-running the original builder is the only spelling that cannot get it wrong.
A chain that filters to nothing emits **nothing** — not an empty open/close pair.

#### The reader inventory, with each reader's threshold

Every consumer of the colour decision, and which of the three levels it keys on. The table
exists because "derive a boolean and carry on" is exactly the change cycle-2 f4 rejected: it
would have run the highlighter — and `fixHardReturn`'s visible-content change — under
`formats`.

| Reader | Threshold | Why |
|---|---|---|
| `applyStyle` / `styleSpan` (`src/style.ts`) | all three | the filter itself; `none` returns the input, `formats` drops hue-class links, `full` is the identity |
| every inline visitor (`src/inline.ts`), every block leaf (`src/blocks.ts`), the list-item chain (`src/lists.ts`), `styleWikiLabel` (`src/wikilink.ts`, via `applyStyleChain`) | `sgr !== "none"`, **via `applyStyle`** | they pass `ctx` through and implement no filter of their own — Decision 8's property rule in structural form |
| `renderTable` (`src/table.ts`) | all three | the producer the split divides: `bold` heads survive `formats`, `gray` borders do not |
| `formatMetaBlockDetailed` (`src/frontmatter.ts`) | `sgr !== "none"` in effect | it emits only `dim`, which is format-class, so `full` and `formats` are byte-identical here |
| **`highlightCode` (`src/blocks.ts`)** | **`sgr !== "full"` returns raw code** | Decision 3's named producer exception — see below |
| `LayoutContext.color` | derived, `sgr !== "none"` | **no production reader left.** Retained as the default threshold and tested for all three modes; deleting it is a future package's call |

**Decision 3 is a producer exception, named rather than hidden.** Fenced-code syntax
highlighting runs under `full` and nothing else, so a `formats` fence is byte-identical to a
`none` fence. Two reasons, both measured: the highlight branch carries `fixHardReturn`, a
**visible-content** transform inside a `codeRange` (it rewrites the first `\r` as the five
literal characters `/\n/g`), so reaching it under `formats` would break
`visible(formats) === visible(off)` — the property WP-4's G2 gate is about, which this keeps
true *by construction*; and the theme is not hue-only — it carries `dim`, `italic`, `bold` and
`underline` (`src/highlight.ts`), all format-class, so a property filter would have produced a
half-highlighted fence, decoration with its colours removed and its emphases kept. What
`formats` loses is enumerated: the theme's bold/italic/underline/dim spans inside fenced code,
and nothing else. The property-pure alternative — highlighting under `formats` through a
`fixHardReturn`-free path — is recorded in the plan as the fallback if the exception is ever
withdrawn. **A future package adding a second producer exception owes the same two-part
justification**; everywhere else the rule is Decision 8's.

**Two things this package deliberately did not touch, and both are user-withheld ground —
one of them since fixed by a later plan.** The task-state pre-pass
(`src/render.ts:193-213`, `rewriteTaskState`; "The task-state pre-pass", `src/AGENTS.md`) keeps
its class-C exception
withheld and its 84 corrupted lines exactly as they are — any task-state byte movement
anywhere is a defect. The wiki-link verbatim defect ("The wiki-link carrier defect",
`docs/agents/wiki-link-record.md`)
was still recorded-not-fixed at the time this package landed — its pinned witnesses in
`tests/render.test.ts` and `tests/wikilink.test.ts` had only their policy literals migrated
(since split; now `tests/render-wikilinks.test.ts` and `tests/wikilink-tokenizer.test.ts`)
here (`color: true` → `sgr: "full"`, `color: false` → `sgr: "none"`) with **not one expected
byte moved**, because they were the instrument a future fix would have to trip, and a
migration that also tidied an expectation would have destroyed it. **It has since been
fixed**, at WP-2 of `plans/wiki-link-tokenizer.md` (`ab3518e`) — see "The wiki-link carrier
defect" (`docs/agents/wiki-link-record.md`) for the closure — and those same witnesses are
what the fix re-pinned rather
than what it had to trip.
