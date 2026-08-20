# Ambiguous width, the probe, and the table emitter

*Reference record for `src/`, moved out of `src/AGENTS.md` at WP-4 of
`plans/docs-and-memory-curation.md`. **`src/AGENTS.md` is the parent contract — read it
first**, and read its "How to read this file" for the two conventions everything below is
written under: every requirement is stated with the measurement that established it, and a
citation like `index.js:NNN` is historical evidence from `marked-terminal@7.3.0` rather
than a live dependency. There is deliberately **no `CLAUDE.md` symlink** beside this file:
it is an on-demand reference read, not a per-directory auto-loaded contract.*

**What this file settles:** the East Asian Ambiguous question and the threaded `Measure`,
the resolution order, the probe and its cache identity (including the terminal-survey
validation table the man page cites), why `wide` forces the ASCII glyph tier, the
`cli-table3` padding residual and the owned emitter that closed it, and the sweep's
independent axes.

**The glyph tier itself stays in `src/AGENTS.md`** — this file's "`wide` forces the ASCII
glyph tier" is the arithmetic behind that section's precedence rule. The *dependency*
half of the `cli-table3` story — when it left `dependencies`, when it left the tree, and
what took its declaration slot — is `docs/agents/dependency-history.md`; the *measurement*
record of what it padded wrongly and what the owned emitter fixed is below.

## Ambiguous width (WP-3)

`src/width.ts` owns one question: **how many columns is an East Asian *Ambiguous* character?**
Unicode's answer is "one or two, depending on the terminal, and you cannot tell from the
character" — and almost every non-ASCII character in this corpus is in that class
(`— – → ← … ≥ × • ○` and the whole box-drawing set; 90 em dashes in one real document).
`string-width@7` defaults to narrow, which is also TR11's own recommendation when the context
cannot be established, and that default was hardcoded at **26 call sites across 7 modules**
because the library takes the setting as a *per-call option* and offers no global switch.

**`src/width.ts` is now the only file in `src/` or `scripts/` that imports `string-width`**, and
`tests/width.test.ts` asserts it. That is not tidiness: a module that imports it directly
silently opts out of whatever mode was resolved, and **no width gate can see that**, because a
check measured with the wrong ruler passes. It is the same class of defect as the `cli-table3`
v4/v7 disagreement below (closed in WP-3 of `plans/tn-review-remediation.md`, by owning the
emitter), and it is exactly the kind this repo has shipped green four times.

### The mode is threaded, exactly like `GlyphSet`, and for the same stated reason

`src/glyphs.ts`'s header is the precedent: *"this module is the only place that reads the
environment; `render.ts` and `table.ts` stay pure and take a `GlyphSet` argument so every test is
deterministic regardless of the machine's `TERM` or locale."* A process-global
`ambiguousIsNarrow` in `width.ts` would be smaller and is precisely what that sentence was
written to prevent — it makes every test's result depend on what ran before it, and the sweep's
numbers depend on the machine that ran them.

So a `Measure` is a value: a callable `(text) => columns` carrying an `ambiguous` tag, passed
alongside the glyph set on the channel that already exists (`cli.ts` → `renderDocumentDetailed`
→ `LayoutContext` → `renderTable`), and **defaulting to `NARROW_MEASURE` at every public entry
point**. The default is not a convenience — it *is* rule 4 of the resolution order — and the
narrow branch calls `stringWidth(text)` with **no options object at all**, byte-for-byte the
call all 26 sites used to make. That makes narrow-mode output identical to the parent commit *by
construction* rather than by measurement. Measured anyway: **4,368 renders (21 files × 104
widths × both tiers) byte-identical, 0 differing bytes, 0 `codeRanges` disagreements.**

Since WP-2 the `Measure`, the `GlyphSet`, the prefix stack, the fence-language resolver, the
`emoji` decision and the colour decision are one immutable `LayoutContext`
(`src/layout-context.ts`), constructed once per render and threaded explicitly. That is what
makes the layout state reachable from a visitor that is no longer a closure inside
`renderDocumentDetailed` — the whole point of the seam.

### Resolution order (highest first)

1. `MDVIEW_AMBIGUOUS=narrow|wide`. Any other value — unset, empty, a typo — is **ignored** and
   falls through. Never throws on a bad env var; that is the `MDVIEW_GLYPHS` contract and this
   matches it exactly.
2. A cached probe result for **this terminal identity**.
3. A live DSR probe, iff stdin *and* stdout are TTYs **and the caller opted in**. `allowProbe`
   defaults to *off*, which is the load-bearing direction: `--check`, the sweep and the whole
   test suite get "no terminal I/O, no cache writes" for free rather than each having to
   remember.
4. **Narrow.**

**The cache key is deliberately over-specified**: `TERM`, `TERM_PROGRAM`, `COLORTERM`,
`VTE_VERSION`, the multiplexer, and the locale. The locale is in the key because it is
conventionally *the* thing that changes a terminal's ambiguous-width behaviour.

*This paragraph has been rewritten twice against field data, and the history is the point.* It
first justified the key by claiming `TERM` alone cannot separate the validated terminals
"because a multiplexer rewrites it". **The validation disproved that**: zellij did **not**
rewrite `TERM` — ghostty under zellij reported `xterm-ghostty` — so that specific mechanism
never fired. The five-terminal survey of 2026-07-28 then supplied the mechanism that is actually
real:

| host | `TERM` | distinguishing field |
|---|---|---|
| ghostty + zellij | `xterm-ghostty` | `TERM` |
| urxvt | `rxvt-unicode-256color` | `TERM` |
| kitty | `xterm-kitty` | `TERM` |
| gnome-terminal | **`xterm-256color`** | **`VTE_VERSION=7600`** |
| anything + tmux | `tmux-256color` | *(the host that started the server — see below)* |
| mlterm | `mlterm` | `TERM` — **and the only measured `wide`** |

**`TERM` is a terminfo name, not an identity, and this machine already proves it**:
gnome-terminal reports the *generic* `xterm-256color`, the value plain xterm, alacritty and
terminator also claim. `VTE_VERSION` is what separates it. That is the real justification; the
multiplexer-rewrite story was speculation that happened to be wrong.

**Under tmux the key is dominated by tmux's own fields, and that is correct rather than a
collision.** The reason it is correct is **not** that the host fields vanish — it is that **tmux
answers DSR from its own grid model rather than relaying to the host**, measured by running the
probe in a fully detached session with nothing attached to render anything, which still replied
`\e[1;2R` in 5 ms. mdview's output is laid into tmux's grid and *tmux* decides the wrapping, so
tmux's opinion is the one that governs and sharing an answer across hosts is the desired
behaviour. A host that disagrees with its own multiplexer is already rendering corrupt output
for every program, and is not mdview's to reconcile.

**What tmux actually does to the environment** (measured 2026-07-28 by injecting known values at
server start and reading them back inside a pane): it overrides exactly the two variables it
owns — `TERM` → `tmux-256color`, `TERM_PROGRAM` → `tmux` — and **passes everything else through
unchanged, frozen at server-start time**. `COLORTERM` and `VTE_VERSION` both survive; the
default `update-environment` list carries neither, so an *attaching* client contributes nothing.
The consequence is that a pane's identity records **whichever host started the server**, not
whoever is looking at it:

| tmux server started from | identity under tmux | how |
|---|---|---|
| kitty / ghostty | `…\|colorterm=truecolor\|vte=\|mux=tmux` | field |
| urxvt | `…\|colorterm=rxvt-xpm\|vte=\|mux=tmux` | field |
| gnome-terminal | `…\|colorterm=truecolor\|vte=7600\|mux=tmux` | lab, **then field** |

The last row is worth its own note: it was **predicted from the injection experiment and then
confirmed live**, byte-for-byte, in a real gnome-terminal + tmux session. That is the difference
between this version of the paragraph and the three wrong ones — the rule was stated first and
the observation arrived afterwards to match it.

So tmux keys split **per server origin**, not per host and not into one bucket, and the split
persists for every client that ever attaches. The cost is bounded at one spurious re-probe per
origin, all of them agreeing, because tmux gives the same answer regardless. Over-specifying
costs a re-probe; under-specifying hands ghostty urxvt's answer.

**The one place the key is genuinely under-specified, found 2026-07-28 by installing a terminal
that can be configured either way.** mlterm's `col_size_of_width_a` is a config-file setting:
`=2` probed **wide** (`\e[2;3R`, cursor 1→3), `=1` probed **narrow** (`\e[2;2R`), same binary,
same session shape, and **byte-identical identity strings**
(`term=mlterm|program=|colorterm=truecolor|vte=|mux=none|locale=en_US.UTF-8`). Two correct
opposite answers under one key. The cache therefore serves the stale verdict across such a flip
until `--refresh`, and no field available to the identity can fix it, because the setting never
reaches the environment. Documented in the README as user-facing advice rather than papered
over. **Do not "fix" this by widening the key** — there is nothing to widen it with; the honest
options are a TTL or always re-probing on a TTY, and neither is worth 5 ms per run against a
setting most users change never.

This pair is also **the proof that the probe measures rendering rather than correlating with
`TERM`.** Six narrow terminals could not establish it; one terminal that answers both ways under
an unchanged identity does, and it is the only evidence in the repo that distinguishes the
design from a lookup table. Every `wide` claim before this was `MDVIEW_AMBIGUOUS` or a test
double.

**zellij is the opposite and overrides nothing.** Measured on two different hosts: ghostty under
zellij keeps `TERM=xterm-ghostty`, kitty under zellij keeps `TERM=xterm-kitty`, and neither
gains a `TERM_PROGRAM` it did not already have — kitty sets none, so the field stays empty where
tmux would have stamped `tmux`. Under zellij the key therefore still identifies the **host**,
correctly. This is also the cleanest argument for keeping `mux` in the key at all: kitty bare and
kitty-under-zellij differ in **exactly one field**, and it is that one. **Do not generalise from
one multiplexer to another** — the two behave oppositely on environment, and `screen` differs
from both again (it does not strip `ZELLIJ`, which is why `detectMultiplexer` needs `TERM` as a
tiebreaker).

**Keep the claim sized to the evidence.** This paragraph has now been wrong three times while
the code was right throughout: first "a multiplexer rewrites `TERM`" (zellij does not), then
"every host collapses to one key" and "tmux strips `VTE_VERSION`" (it strips nothing — it
overrides two variables and freezes the rest). Each wrong version was an observation generalised
into a mechanism. The rule above is stated as a rule because it was measured as one.

Writes are atomic (temp file + `rename`, `src/config.ts`'s pattern); every corrupt, truncated,
wrong-version or unreadable shape reads as a **miss** and re-probes, and an unwritable cache is
a `false` return, never a throw — a viewer that refuses to render because a file it generated is
corrupt has mistaken its plumbing for the user's request.

**The probe never moves the cursor to a cell it did not already own.** It asks where the cursor
is, writes one character *there*, asks again, and the difference is the answer; then it returns
to the recorded column and clears to end of line, which is exact because nothing to the right of
the cursor existed before. The obvious alternative — CR to column 1, write, restore — overwrites
whatever the shell prompt left there and cannot put it back. Within two columns of the right
margin it **refuses and says so** rather than guessing, because the glyph would wrap and the
erase would clear a line the probe never wrote.

Cooked mode is restored in **three** layers, and the third is not belt-and-braces: a `finally`
covers a throw or a return, `process.on("exit")` covers `process.exit`, and handlers for
`SIGINT`/`SIGTERM`/`SIGHUP` cover an external `kill` — whose *default* disposition terminates
without emitting `exit` at all, which is the one path that would strand the user's shell in raw
mode. Verified against a scripted pty: killed mid-probe, the tty comes back `icanon`. Ctrl-C is
handled as a **byte** (`\x03`), not a signal, because raw mode is exactly what turns `ISIG` off.

### `wide` forces the ASCII glyph tier — arithmetic, not taste

The glyph-tier section (`src/AGENTS.md`) says *"every Unicode substitute is exactly 1 column, so
the tier has no
width impact and `chromeWidth` stays `3N+1`"*. **That is a narrow-measurement statement, and
under `wide` it is false for most of the set**: `•` (U+2022), `─` (U+2500) and the entire
box-drawing charset are themselves Ambiguous and measure 2. Only `◦`, `‣` and `✓` survive.

Two consequences, neither cosmetic and neither repairable in the allocator:

- **A table's border row cannot be made to fit.** A horizontal rule is one `─` per column of
  cell width, so the border row is exactly *twice* the content rows — and no allocation can
  shrink by its entire budget, so `allocateWidths` reports `fits: false` and the table is
  emitted at its minimum feasible width rather than as a wreck. Measured on
  `tests/fixtures/wide-table.md`: **160 columns at a target of 80, 200 at 100 — exactly 2×**,
  pinned in `tests/width.test.ts`. **WP-3 of `plans/tn-review-remediation.md` did not move these
  numbers and was not supposed to** — it closed the *padding* defect below, which is a
  measurement problem; this is a glyph-choice problem, and refusing the tier is the choice.
- **A substituted bullet widens its own item.** `substituteBullets` swaps `"* "` for `"• "`
  *after* the budget arithmetic ran on the source marker, so every unordered item is one column
  over budget per level.

Measured over the bundled corpus at all five sweep widths: **wide + Unicode = 35 overflows of 60
combos; wide + ASCII = 0.** So `resolveGlyphs` takes the ambiguous setting as a third argument
and returns ASCII whenever it is `wide` (`src/glyphs.ts:113`), **ahead of `--unicode` and
`MDVIEW_GLYPHS`** — because `--unicode` asserts a *capability* ("this terminal can draw these"),
which remains true and is simply not the constraint that binds. **`unicode × wide` is therefore
unreachable from the CLI.** An explicit `--unicode` overridden this way is named once on stderr
(`wideForcesAscii`, deliberately the *flag* only and not the env var: a flag going unmet is news
about this invocation; an exported variable would print on every render for the rest of that
shell's life). `MDVIEW_AMBIGUOUS=narrow` is the escape hatch.

`renderRule` divides the target by the rule glyph's *measured* width for the same reason —
`"─".repeat(targetWidth - 1)` is twice the document width in wide mode, which would put the
tool's own frontmatter divider over budget on every file that has one.

### The residual, named rather than papered over — and then closed by owning the emitter

**The finding.** `cli-table3` bundled its own `string-width@4.2.3`, which has no
`ambiguousIsNarrow` option at all, so its cell padding could never honour wide mode. A cell
containing *k* ambiguous characters was padded *k* columns too wide, and since *k* varies cell by
cell within a column, **a table's right edge could be ragged by up to *k* columns**. This
paragraph used to end "not fixable from outside the library", and that was exactly right: it
padded to `colWidths` in its own units, so no amount of pre-padding, pre-wrapping or budget
adjustment on our side could make its count agree with ours per-cell. The capped
render/measure/reallocate loop that used to sit in `renderTable` absorbed only the **aggregate**
overage — which is why a table stayed inside the target while its edge stayed crooked, and why a
green width gate was never evidence about this.

**The fix, in WP-3 of `plans/tn-review-remediation.md`: stop being outside the library.**
`src/table.ts` emits its own borders, junctions, padding and alignment from the allocation
`allocateWidths` already produced, padding with the `Measure` it was handed — the same ruler the
allocation used and the same one `--check` grades the result with. The disagreement is not
repaired, it is **impossible by construction**; the retry loop, `MAX_FIT_PASSES` and
`maxRenderedWidth` are gone with it, and the rendered geometry now *equals* the allocated
geometry (`tests/table.test.ts` asserts that equality directly).

Measured over this repo's own 41 markdown files at six widths, both tiers, both ambiguous modes
— 984 renders:

| Combination | Rendered tables | Ragged before | Ragged after |
|---|---|---|---|
| narrow, either tier | 180 each | 0 | 0 |
| **wide + ASCII** (what the CLI produces) | 180 | **66** | **0** |
| wide + Unicode (unreachable; `wideForcesAscii`) | 180 | 180 | 180 |

Narrow-mode output is **byte-identical** across those 492 renders — 0 differing bytes — because
narrow measurement is where the two `string-width` majors happened to agree on this corpus, and
because the emitter reproduces the library's escape-sequence layout — one style wrap per *cell*,
not per line — and, at the time, `@colors/colors`' styling decision exactly rather than
approximately. (The *layout* is still reproduced; the *decision* is the resolved policy since
WP-2 of `plans/colour-policy.md`, and the two style pairs are committed literals in
`src/style.ts`.) It is *not* byte-identical in general: a
narrow-mode table carrying U+26A0 changes, and improves — that glyph is 1 column to
`string-width@4` and 2 to `@7`, which is the original reconciliation bug, and its edge went from
a spread of 3 to 0.

**`cli-table3` is gone from the tree entirely as of WP-6**, which removed the last thing
requiring it. The finding above is why `src/table.ts` stopped importing it; the dependency
removal is a separate fact and is recorded in `docs/agents/dependency-history.md`, under the
live dependency rules the root `AGENTS.md` keeps.

**Do not read this as "wide mode + Unicode tables now work."** They do not, and the row above
says so: `─` and the whole box-drawing set are themselves Ambiguous, a border row is still
exactly 2× the content rows, and that is still handled by refusing the tier.

### The sweep keeps the two axes independent, on purpose

`scripts/sweep.ts` takes `--ambiguous narrow|wide` and **never** reads `MDVIEW_AMBIGUOUS`, never
consults the cache, and never probes. It is a corpus *measurement* instrument whose numbers are
compared against dated runs in the private archive; a baseline that changed ruler because of the
machine's `TERM`, or because someone once ran `mdview probe`, could not be compared to anything.
It also does **not** apply the wide-forces-ASCII rule, so `--ambiguous wide --glyphs unicode`
stays reachable — that combination is how the finding above was measured, and an instrument that
cannot reproduce a finding is not an instrument. It prints a NOTE saying the CLI never produces
that combination.

`--check` is the other way round and for the opposite reason: it honours the env var and the
cache (it just never probes), because its whole claim is "the renderer hit the budget it was
given". A check measured with a different ruler than the allocation used is asserting something
else entirely.

### What the orchestrator cannot verify

The probe's *arithmetic*, cleanup, timeout, interrupt and cache behaviour are covered by
`tests/width.test.ts` against a scripted terminal double, and end-to-end against a scripted pty.
**What no test here can establish is what a real terminal answers.** The user runs urxvt and
ghostty-inside-zellij; run `mdview probe` in each and read the `ambiguous width` line. Nothing in
this repo may claim those pass.
