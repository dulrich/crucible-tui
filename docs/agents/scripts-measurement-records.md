# `scripts/` measurement records

Reference material moved out of `scripts/AGENTS.md`: what the corpus sweep and the defect detectors have measured, the colour axis's seed history, and the escape-site census. Read on demand; none of it is needed to run the instruments. `TS_BASELINE` (`c097c66`) is the last commit carrying the TypeScript renderer, and every `src/*.ts` citation below names its tree. Dated full-corpus figures live in the private validation archive, not here.

## Binding instruments of the Rust port

WP-9 of `plans/mdview-rust-port.md` (rev 5) was bound by the T2 lexer-diff plus a risk-targeted render sample (user ruling 2026-10-12), which passed before the TypeScript renderer was deleted: `disallowed=0 errors=0` over 39,730 files, 0 disallowed in the sample under every policy. Both instruments (`lexer-diff`, `risk-sample`) compared against the TS renderer and were deleted with it. Measured at WP-9, `--rev-a rust:c097c66 --rev-b rust:.` over T0 at P0-P4: 1,400 combos, `diffed=0`, every non-vacuity counter non-zero.

## The bundled gate corpus (WP-1, `plans/gate-corpus-reframe.md`)

`corpus/default-manifest.json` was a glob over live documents (`README.md`, `AGENTS.md`, `plans/*.md`, `tests/fixtures/*.md`), so its bytes moved whenever any of those was edited, ratcheting the colour axis with no renderer change behind most moves (five re-seeds: 62 → 65 → 66 → 70 → 73 → 75). User direction (2026-08-18) replaced it with a fixed, explicit, wildcard-free list, enforced by `tests/gate-corpus.test.ts`: every entry is a direct `tests/fixtures/*.md` path or a fixture named by a `witness-index.json` record whose `test_file` exists. A third test pins that a wildcard-free entry resolves to exact-path membership, never a prefix or substring match (`matchSegment`, `scripts/corpus.ts`).

Witness accounting: 6 unique fixtures named by the index's 7 records, at 5 widths × both glyph tiers (identical in both tiers). 4 join (`defect-0-crlf-frontmatter`, `defect-1-2-unparseable-frontmatter`, `defect-3-nested-mapping`, `defect-wp14-list-item-inline-markup`, all `overflow=0 errors=0`); 2 stay out because the width gate catching them is the pinned behaviour: `defect-2-success-path-overwide` (overflows at 80/100/116/160) and `defect-cjk-excerpt` (overflows at 80/100/116, deliberately un-exempt). 10 fixtures + 4 witnesses = 14 files.

## Corpus growth findings: 79 overflows, 77 of them one bug

Widening corpus membership put 79 width overflows on the board, 0 errors, every one classified. 2 are accepted by design (a table of 9 or more columns at its minimum feasible width, at target 80 only, the precedent in `plans/mdview.md`). 77 were the frontmatter meta block's degraded paths, which never consult `targetWidth` (all in `TS_BASELINE` `src/frontmatter.ts`): 46 (23 files) the parse-failure diagnostic (~104 columns fixed, dimmed, verbatim); 26 (16 files) the raw frontmatter echoed beneath it (118-568 columns); 5 (1 file) a depth-≥1 nested mapping `JSON.stringify`ed into the line (1,044 columns at every target). Source pathology: 0. A wide line is not evidence of an unwrappable source; the code path that produced it settles the class. It stayed a triage because the fix is a design call (hard-wrap with a continuation indent, truncate with a marker, or treat the block as fence-like and exempt it; each needs its own pinning test). `--max-orphans` and `--max-over-indent` have no committed constants; their thresholds live in the private archive.

## The table allocator is not broken, and the width gate is nearly blind (`plans/representative-corpus.md` WP-6)

- The "three-column table overflow" never existed: the reproduction had lost the escape byte from its ANSI strip and measured SGR codes as columns. A census of 4,963 tables over 29,778 renders found 26 overflowing renders, every one with `allocFits === false`, `rendered === minFeasible` and at least 9 columns.
- Overflow fires on 1 in 575 README combos and 0 in 1,000 prose combos, which is why `scripts/measure/detectors.ts` exists. Do not rank a corpus on overflow.
- Do not weight a corpus by file count: the largest vendor collection in the reference set is ~51% self-duplicated (1,571 markdown files, 771 unique, 766 groups mirrored under `.github/plugins/`).

## Why a green sweep is weak evidence

The sweep exempts fenced-code ranges, so WP-2 shipped a bullet-substitution pass that rewrote `* not a bullet` inside a fence nested in a list item with every gate green. Gates here have passed for a narrower reason four times: the fixture had no long bullets; the highlight path is dead under the colourless gates because `highlightCode` returns raw code whenever `LayoutContext.sgr !== "full"` (every non-TTY run); tier purity was unmeasured; code ranges are exempt. The third had a long ownership chain: `marked-terminal`'s `highlight()` short-circuited at `chalk.level === 0`, WP-3 of `plans/marked-terminal-replacement.md` transcribed it, WP-1 of `plans/colour-policy.md` made it `resolveColourPolicy`'s, and WP-2 made the whole highlighting path obey it (`docs/agents/colour.md`). Since WP-2 of `plans/colour-modes.md` the gate is `sgr !== "full"`, so the format-preserving `formats` mode takes the same dark branch as `none` (Decision 3, a ratified producer exception); `visible(formats) === visible(off)` holds by construction for code because `fixHardReturn` is downstream of the gate.

## Colour axis: seed history

Measured over the 14-file gate corpus × 5 widths = 70 combos, both glyph tiers agreeing exactly. The two-bucket predecessor (`--max-char-diff 31 --max-sgr 20`, `digestText`'s `hasSgr`/`strippedSha`, `classifyColourAxis`'s buckets, all deleted by WP-5 of `plans/colour-policy.md`) read: 70 combos, 19 identical, 31 charDiffOnly, 20 sgrOnly, 0 both. Today's `bun run sweep -- --colour-mode both` reads `combos=70 g1=0 g2=0 g3=0 errors=0` at both tiers, unmoved by the fourth child (`formats`, WP-4 of `plans/colour-modes.md`).

- `charDiff=31` was `blockquote-list` (5) + `coalesced-colon-guard-continuation` (1) + `fenced-list` (5) + `loose-list` (5) + `nested-list` (5) + `tight-list` (5) + `defect-wp14-list-item-inline-markup` (5): layout reasoning about bytes rather than columns, closed by WP-3 of `plans/colour-policy.md` (`TS_BASELINE` `src/lists.ts` `fixNestedLists` regex whose `\S` matched an SGR reset's `m`, the raw-byte empty-line filter, `src/wrap.ts`' escape-only zero-width word, plus `src/render.ts`' hard-break seam and marker-shape guards). The colourless render came out byte-identical in 140 of 140 combos.
- `sgrAny=20` was `simple.md`'s wiki-link (`styleWikiLink`, hardcoded `\x1b[36m\x1b[4m`, 5 combos, closed at WP-4; the carrier pair that replaced it was itself retired by WP-2 of `plans/wiki-link-tokenizer.md`, `docs/agents/wiki-link-record.md`) plus three frontmatter witnesses (`DIM_START`/`DIM_END`, 5 each, closed at WP-1). Both reached zero before WP-5, which changed the instrument, not the renderer.
- What the old axis was blind to: the colourless child sets `FORCE_COLOR=0`, which `supports-color` and `@colors/colors` both honoured, so `src/table.ts`'s border/head styling (gated on `@colors/colors`, which ignored `isTTY`) leaked 205 grey and 12 bold pairs on `wide-table.md` into piped output while the axis reported `identical`. WP-2 of `plans/colour-policy.md` removed the gate with the package; G1 on the `default` child (no variable set, nothing decided) is the check that catches that class directly.
- Non-vacuity of the gates (`tests/colour-axis.test.ts`): G1 against the `authored.md` fixture; G2 against a synthetic divergent `on`/`off` pair; G3's SGR arm against a committed and an uncommitted byte pair, its OSC-8 arm against a real hyperlink, its DCS arm against a real tmux-wrapped hyperlink and a hostile DCS frame. The `formats` arms: a positive seed (a table whose bold head survives and grey border does not, both first asserted present under `on`), a negative seed (a hue-only codespan styled under `on`, zero sequences under `formats`), and the authored fixture's `31m`/`39m` as a deliberate negative-control G3 failure.
- OSC-8 and the tmux DCS envelope: `stripAnsi` removed SGR only before WP-3 of `plans/colour-policy.md`; it is now a derivation of `TS_BASELINE` `src/ansi.ts`'s scanner and the v2 wire record lists every `osc8`/`dcs` span by kind. No corpus child ever emits one (hyperlinks are off on non-TTY), so the arms are covered by `tests/colour-axis.test.ts` directly.
- The width axis: `renderDocumentDetailed(source, targetWidth, …)` takes a positional number; passing an options object renders every width identically and has invalidated this quantity four times across three authors. `tests/colour-axis.test.ts` pins that one file digests differently at 40 and 100.

## The escape-site census (successor of the "40 removable escape sites" claim)

Re-censused over all of `src/` and `scripts/` at `TS_BASELINE`; the earlier count mixed terminal-protocol logic that must stay with styling that might move.

Producers (put escape bytes into rendered text). Every site obeys the three-level `ctx.sgr` (`full`/`formats`/`none`; `sgr !== "none"` except the highlighter, keyed to `full`); the hue/format split is applied once, by style name, in `src/style.ts` (`STYLE_CLASSES`).

- `src/style.ts` `applyStyle`: the one styling primitive; inline (7 call sites), block (6) and list (1) sites go through it.
- `src/inline.ts` `renderLink` via `src/ansi.ts` `link`: OSC-8 plus the tmux DCS envelope, gated on `ctx.hyperlinks`; the href is sanitized at emission.
- `src/wikilink.ts` `styleWikiLabel`: cyan + underline at emission through `applyStyleChain`; under `formats` the cyan drops and the underline stays.
- `src/frontmatter.ts` `dim`: `2m`/`22m`, format-class, so identical under `full` and `formats`.
- `src/table.ts` `styleBorder`/`styleHead`: bold heads survive `formats`, grey borders do not.
- `src/blocks.ts` `highlightCode`: `ctx.sgr !== "full"` returns raw code; the one site where provenance rather than style class decides, so a `formats` render's fences are byte-identical to `none`.
- `detectInlineColor` was deleted at WP-1 of `plans/colour-policy.md`; `resolveColourPolicy` (`src/colour.ts`) is the authority.

Layout-consumers (read or strip escapes to decide where characters go; the first six were the colour-only defects, repaired at WP-3 of `plans/colour-policy.md`): `stripAnsi` (`scripts/measure/list-lines.ts`, the one strip implementation), `src/wrap.ts`, `src/lists.ts` (`fixNestedLists`, empty-line filter, `substituteBullets`, `realignEmbeddedContinuations`), `src/render.ts` (`isHardBoundary`, marker-shape guards, `stripEmojiTrailingSpace`), `src/blocks.ts` `reflowSection`, plus measurement-only readers in `scripts/measure/detectors.ts`, `scripts/corpus.ts` and `scripts/colour-axis.ts`.

Final-output consumers: none. `src/cli.ts` writes the renderer's string through unchanged and the width gate measures with `string-width`, which strips SGR inside the dependency, so a future `--plain` has no existing seam; `stripAnsi` can serve as one since WP-3.

Unrelated protocol that must stay (all `src/width.ts` / `src/cli.ts`): the `\x1b[6n` DSR cursor-position request of the ambiguous-width probe, the regex reading its reply, the diagnostic escaping of that reply, and the `\x1b[<n>G\x1b[K` cleanup.

## Defect detectors: measurements

- `findListOrphans` is the metric every WP-2, WP-2b and WP-2c number was recorded with, moved unchanged from `tests/render.test.ts` and verified byte-identical against 58 aggregate metrics and every per-file corpus count.
- `findColumnZeroMarkers`' adjacency clause is not a free zero: the marker shape alone reports 30 hits over 599 blockquote-free corpus files; requiring an indented neighbour takes that to 2.
- The guard-shaped blind spot: WP-1 of `plans/renderer-deferred-work.md` found a coalesced one-digit ordered item whose guard space moved a continuation onto the four-column grid, so `substituteBullets` rewrote the author's literal `*` into `◦`; the resulting `"◦ "` line, one column past its item's text column, was exempted as guard-shaped, and both other detectors read 0. Witnesses: `tests/fixtures/coalesced-guard-collision.md` and the WP-1 group of the (TS-era) list-guard tests, now in `crates/mdview/tests`.
- The loose-list blind spot is small (WP-8): over 479 files, 2,395 file-widths and 3,223 hits, 2,837 `shear` / 144 `paragraph-boundary` / 242 `block-boundary`, so the blind spot is 4.5% of the metric (533 loose multi-paragraph item boundaries against 32,614 indented prose-block ends). The real driver is long unbreakable tokens (62% of shears sit beside a bare URL or reference-style image label that does not fit the item's budget).
- `unmapped` is no longer always zero since WP-14 made list items parse inline tokens: post-WP-14 the population is 2,817 orphans / 2,417 shear / 128 paragraph-boundary / 223 block-boundary / 49 unmapped, with 175 files firing at least one shear (was 215). `unmapped` is the probe declining to guess, not a failure.

## Fast tier and curated sets

Measured: 50 notes × 321 widths (`--widths 40-360`) = 16,050 renders in ~9 s, both glyph tiers, against ~8 min for the full sweep. 40 is the narrowest realistic tiled pane (user-confirmed); 360 clears the widest real layout, 346. The regression set is a ratchet because its notes are currently known-broken, so its expected count is not zero.

| | regression set (WP-2d) | durable set (WP-9, `plans/representative-corpus.md`) |
|---|---|---|
| content | ~50 minimal excerpts, delta-debugged | 91 whole publishable documents, referenced not copied |
| source | the private vault | vendored README / skills / clippings strata |
| keyed on | defect class × construct | shape, one named witness per member |
| manifest | `walkAll` over a directory | explicit per-file |
| answers | does this defect still reproduce? | does the renderer survive what a user opens? |

The durable set records `sha256` at ingestion plus a `requiresRecreate` flag for the clippings stratum (third-party prose that may not be vendored); hashes pin a vault snapshot, not the live web. Its full sweep exits non-zero by design (six renders overflow, all tables of 9, 10 and 19 columns), so read `errors=0` as the health signal. The pool has no non-table overflow witness; if such a defect is ever fixed, its witness must be synthesised.
