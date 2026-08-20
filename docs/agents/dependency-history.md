# Dependency history — the forensic record of every removal

*Moved out of the root `AGENTS.md` at WP-4 of `plans/docs-and-memory-curation.md`.*

**The rule lives in the root `AGENTS.md`; this file is the evidence.** The root carries the
live dependency core — the three-class classification rule (domain data stays, policy is
owned, emission is owned), the current five-dependency list with its closure count and
licence-file line count, the declaration rule in both directions, and Pins. What follows is
the removal record each of those sentences was derived from, ordered by plan and work
package, kept because a number here is a claim someone can re-run. There is deliberately
**no `CLAUDE.md` symlink** beside this file: it is an on-demand reference read, not a
per-directory auto-loaded contract.

**Reading order.** The declaration rule's own evidence paragraph first, because the sections
after it refer back to it; then, by plan and work package: `cli-table3` (WP-3 of
`plans/tn-review-remediation.md`, then WP-6 of `plans/marked-terminal-replacement.md`) →
`supports-color` / `supports-hyperlinks` (WP-1 of `plans/colour-policy.md`) →
`@colors/colors` and `cli-highlight` (WP-2, whose removal is recorded in the declaration-rule
paragraph, with the `chalk@4` residue in its own section) → `ansi-escapes` (WP-3) → the
wiki-link carrier (WP-4, retired at WP-2 of `plans/wiki-link-tokenizer.md`) → the
`highlight.js` pin, which is the one keeper with a history worth writing down.

## The declaration rule, and the two packages it removed

*The rule itself is in the root `AGENTS.md`. This is the paragraph that carried its
evidence, and the sentence every later section here refers back to.*

**The declaration rule is unchanged and it is what removed both styling packages.** A
package this repo's source imports is declared here, whatever a reachability tool says —
`node-emoji` is declared because `src/inline.ts` imports it by
name, `highlight.js` because `src/highlight.ts` does. (`ansi-escapes` was declared under
the same rule for the same file's `ansiEscapes.link` call, and left at WP-3 of
`plans/colour-policy.md` the moment that import did — see the OSC-8 paragraph below.) `cli-highlight` and
`@colors/colors` were declared under exactly that rule while `src/lang.ts` imported
`supportsLanguage` and `src/table.ts` imported `@colors/colors/safe`; **WP-2 of
`plans/colour-policy.md` deleted both imports, so both declarations went with them.**
What replaced them is this repo's own code: `src/style.ts` holds a narrow committed style
table (the `[open, close]` pairs this renderer is authorized to emit, `38`/`48`
introducers banned by an independent assertion) and the emitter over it, and
`src/highlight.ts` is the colorizer `cli-highlight` used to be, over `highlight.js`
direct. The bytes did not move: the forced-colour render of every gate-corpus file is
byte-identical across that package at every width and both glyph tiers.

## `cli-table3` — WP-3 of `plans/tn-review-remediation.md`, gone from the tree at WP-6 of `plans/marked-terminal-replacement.md`

*The measurement half of this story — what its bundled `string-width@4.2.3` padded wrongly,
how ragged the right edge got, and what the owned emitter fixed — is
`docs/agents/ambiguous-width.md`, "The residual, named rather than papered over — and then
closed by owning the emitter". What follows is the dependency half.*

**`cli-table3` is gone from `node_modules` entirely, and that closes a two-part note
this section used to carry.** It left `dependencies` in WP-3 of
`plans/tn-review-remediation.md`, when `src/table.ts` stopped importing it and started
emitting its own borders, but stayed physically installed because `marked-terminal`
required `^0.6.5` — so it stayed in the closure `scripts/gen-licenses.ts` walks and in
`THIRD-PARTY-LICENSES.txt`. WP-6 of `plans/marked-terminal-replacement.md` removed the
only thing requiring it, and it left with a nested `chalk@5.6.2`; the licence file went
1,059 → 990 lines, 49 → 46 packages. `@colors/colors` took the declaration slot it
vacated, deliberately: the emitter had to reproduce the old `style: { head: ["bold"],
border: ["grey"] }` bytes, that package decided whether to colour at all, and
reproducing its decision by hand looked like fidelity risk spent to change nothing on
purpose. **That last clause turned out to be the defect.** Its decision consulted the
environment and *not* `isTTY` — `cli-table3` called `colors.supportsColor()` with no
stream argument — so a plain `mdview wide-table.md | cat` emitted 205 grey pairs and 12
bold pairs into a pipe with no colour requested at all, which is what Decision 1 of
`plans/colour-policy.md` forbids. WP-2 of that plan took the declaration back out: the
two pairs are committed literals in `src/style.ts` and the gate is the resolved policy.

## `supports-color` and `supports-hyperlinks` — WP-1 of `plans/colour-policy.md`

**And the rule runs in both directions, which WP-1 of `plans/colour-policy.md` is the
first package to exercise.** `supports-color` and `supports-hyperlinks` were promoted to
direct dependencies in WP-6 under exactly the sentence above, and they were undeclared
again the moment `src/colour.ts` took over the two decisions they were consulted for and
no file here imported either. Nothing about the rule changed; the imports did. **A
package this repo's source stopped importing is undeclared here, even if it is still
installed** — which `supports-color` still is, and legitimately: `cli-highlight → chalk@4
→ supports-color` kept it in the runtime closure until WP-2 removed `cli-highlight`, and
the devDependency `eslint` keeps it in `bun.lock` now. Undeclaring a package and removing
it from the closure are two different events, and at WP-1 they happened to two different
packages: the licence file lost `supports-hyperlinks` alone, 46 → 45. **Both halves
completed at WP-2**, one package apart from each other: `supports-color` left the runtime
closure with the `cli-highlight → chalk@4` path that was its only remaining requirer, and
it is still in `bun.lock` — dev-only — exactly as recorded.

## The `chalk@4` residue — WP-2 of `plans/colour-policy.md`

**A `chalk@4.1.2` still sits in the tree** — as **eslint's** transitive now, `cli-highlight`
having left at WP-2 — so it is a devDependency of a devDependency and ships in nothing.
This repo neither imports it nor reads its level. It used to say the colour answer came
from `supports-color` — the same implementation `chalk` wraps, measured to agree with it
on a 36-cell environment matrix — and since WP-1 of `plans/colour-policy.md` the answer is
`src/colour.ts`'s own, resolved from inputs handed in rather than asked of any library
(`docs/agents/colour.md`, "Colour: one owned decision, resolved from inputs handed in").
What `chalk@4` still decided after that was `cli-highlight`'s
syntax colours, and **that disagreement is closed**: `src/highlight.ts` applies the same
byte pairs through `src/style.ts` under the resolved policy, and `chalk`'s own
`applyStyle` rules — the nested re-open and the line-break encasing — are transcribed
there rather than imported.

## `ansi-escapes` — WP-3 of `plans/colour-policy.md`

**`ansi-escapes` was the last third-party escape *emitter*, and WP-3 of
`plans/colour-policy.md` closed that half of the rule.** It was one function —
`ansiEscapes.link` — called once, in `src/inline.ts`, and it carried two things this repo
had to own: the OSC-8 byte grammar itself, and an `isTmux` constant computed from
`process.env` **at module load** (`base.js:12`), which is exactly the shape the
policy-dependency half of the rule removes. `src/ansi.ts` is the transcription (`link` and
`wrapOsc`, cited line by line there); the tmux answer is `resolveTmux`'s
(`src/colour.ts`), resolved once per render from an environment handed in and carried on
the policy; and the destination is sanitized at emission, which the library did not do and
could not have, since it never saw document content. The package left with its own
transitive `environment` — 16 → **14** packages, `THIRD-PARTY-LICENSES.txt` 368 → **338**
lines. **The renderer now emits no escape byte that this repo does not spell**: SGR through
`src/style.ts`'s committed table, syntax colours through `src/highlight.ts`, OSC-8 and its
tmux envelope through `src/ansi.ts`. **There is no exception left**: this sentence carried
one — `styleWikiLink`'s pre-lexer pair (`src/render.ts`) — and WP-4 of the same plan retired
it. That function spelled `\x1b[36m\x1b[4m…\x1b[24m\x1b[39m` by hand and put it into the
*markdown source*, before the lexer, at every colour level including colourless, so it
violated all three halves of the rule at once: it decided (nothing gated it), it emitted
(bytes no committed table authorized), and it put tool-generated escapes into the one input
every downstream claim is about. `src/wikilink.ts` replaced it with a **carrier pair** —
control code points 2 and 3, the same idiom the two existing sentinels use — marking the
label through the lexer and the walk; a pass over the finished document styled each balanced
pair through `src/style.ts` under the resolved policy and removed every carrier, balanced or
not. The colour axis over the fixed gate corpus read `sgrAny` **5 → 0** with `charDiff=0`
held, at that WP-4-of-`plans/colour-policy.md` cutover, and the forced-colour render did not
move a byte in any of the 84 colour-on combos measured then.

**And the same module is what layout reads.** The dependency-ownership rule is about who
*decides* and who *emits*; WP-3 added the third question — what layout can *see* — because
`stripAnsi` removed SGR only and `src/wrap.ts` kept a second private copy of that same
SGR-only vocabulary. Both are derivations of `src/ansi.ts`'s scanner now, which is why an
OSC-8 hyperlink is no longer measured as its own destination URL.

## The wiki-link carrier — WP-4 of `plans/colour-policy.md`, retired at WP-2 of `plans/wiki-link-tokenizer.md`

The paragraph that used to sit here — "That carrier pair is itself gone now, and the
invariant it served got stronger rather than merely surviving the change" — is
`docs/agents/wiki-link-record.md`, which is the one owning home for the carrier's whole
life: the pre-lexer SGR it replaced, the carrier pair itself, and the tokenizer extension
that retired it. The `ansi-escapes` section above is where that story starts, because
`styleWikiLink`'s pre-lexer pair was the last exception to "the renderer emits no escape
byte that this repo does not spell".

## `highlight.js` — the one keeper with a pin history

*The live fact is one line in the root `AGENTS.md`'s Pins paragraph: pinned at `10.7.3`,
and not a version a session bumps unilaterally. This is why.*

**`highlight.js` is pinned at `10.7.3`**, two majors behind upstream — and since WP-2 of
`plans/colour-policy.md` that is **this repo's own direct pin**, not a transitive one. It
still cannot be subset to shrink it: the package's entry point is the full bundled
language set, and `src/highlight.ts` calls `hljs.highlightAuto` for an unlabelled fence,
which needs every grammar loaded by construction. What changed is only who owns the pin.

**It is a domain-data dependency and stays.** The dependency-ownership rule
(`plans/colour-policy.md`) removes *policy* dependencies (anything reading env/argv/TTY at
module load to decide) and *emission* dependencies (anything writing escape bytes);
grammars are neither. `cli-highlight` was one package doing both jobs at once — grammar
lookup plus a `chalk`-gated theme — which is why the split fell where it did.

**This used to be blocked rather than deferred, and WP-2 of `plans/colour-policy.md`
unblocked it without bumping anything.** The record below is kept because the distinction
it draws is the useful part; what has changed is that the blocker is gone. "Deferred"
describes a choice — do it later, on purpose, when it is someone's priority — and until
WP-2 there was no such choice available: the pin was transitive, owned by
`cli-highlight@2.1.11`'s own dependency declaration, and this repo had no `highlight.js`
import of its own to bump, because `src/lang.ts` reached `cli-highlight`'s
`supportsLanguage` and never `highlight.js` directly. **Both facts are now false**:
`src/highlight.ts` imports `highlight.js` by name and `package.json` pins it, so a bump is
this repo's decision to make. It is a *deferred* one, and the cost it was always going to
carry is unchanged — see below. Moving past
`10.7.3` is now a straight version bump in `package.json` — and it is still **not** a
change a future session should make unilaterally, for the reason that always sat under
the blocker: highlight.js's major versions change *which spans it emits*, so every fenced
block in the corpus can change its forced-colour bytes, which is parity class C. It needs
its own compatibility check against `src/lang.ts`'s fence-language handling, its own
per-token-class byte comparison against `src/highlight.ts`'s theme (the `10.x` class
vocabulary is what that theme is total over — `11.x` renamed several scopes), and its own
corpus pass. Recorded here so a future pass does not "fix" the staleness by bumping a
major version with nothing else in place.
