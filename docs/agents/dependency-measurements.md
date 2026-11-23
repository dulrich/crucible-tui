# Dependency measurements (record as of TS_BASELINE `c097c66`)

Moved out of the root `AGENTS.md` "Dependencies (WP-5)" section; read on demand. The npm counts describe the TypeScript renderer's runtime closure, which is gone; the classification, declaration and pin rules still live in the root file and apply to Cargo. Removal forensics are `docs/agents/dependency-history.md`.

## Binary size is not a dependency problem

The premise of WP-5 — "trim dependency fat to shrink the binary" — inverted once measured. The compiled `bun build --compile` binary was ~102 MB, almost entirely Bun's own embedded runtime. The runtime closure (`marked`, `highlight.js`, `node-emoji`, `string-width`, `yaml` and their transitives) was **13 packages**: 14 at WP-3 of `plans/colour-policy.md` (removed `ansi-escapes` and `environment`), 16 after its WP-2 (removed `@colors/colors` and `cli-highlight`), 45 after its WP-1, 46 (~8.6 MB) at WP-7 before that, 60 when first written. WP-3 of `plans/pictograph-width.md` (`string-width` 7.2.0 → 8.2.2) dropped `emoji-regex`. Removing `cli-highlight` took 29 packages out in one work package and the notice file from 974 to 368 lines; that was the dependency-ownership rule applied to policy and emission, not a size play. The ~63 MB of `node_modules` was devDependency tooling (`oxlint`, `typescript`, `@types/bun`) that never shipped. Dependency weight was a couple of percent of the artifact; "remove a dependency to shrink the binary" is the wrong frame, and none should be removed on that basis without re-measuring.

## Classification rule history (`plans/colour-policy.md`, "Decisions locked")

- Policy dependencies (env/argv/TTY at module load) removed and replaced by `TS_BASELINE` `src/colour.ts`: `supports-color`, `supports-hyperlinks` (WP-1), `@colors/colors` and `cli-highlight`'s `chalk` theme (WP-2).
- Emission dependency removed: `ansi-escapes` (WP-3); escape bytes are spelled only in `TS_BASELINE` `src/style.ts` and `src/ansi.ts`.
- The npm runtime closure was then five domain-data packages: `marked`, `highlight.js`, `string-width`, `yaml`, `node-emoji`.
- Caveat recorded, not resolved: `marked`'s lexer has no source-offset API, the gap `docs/adr/0001-editor-path.md`'s `{text, style, sourceStart, sourceEnd}` return type is blocked behind (as `TS_BASELINE` `src/walk.ts`'s header records).

## Declaration rule evidence

`node-emoji` was declared because `TS_BASELINE` `src/inline.ts` imports it, `highlight.js` because `src/highlight.ts` does. `supports-color` stayed in `bun.lock` as a transitive of a devDependency and was correctly undeclared: undeclaring a package and removing it from the closure are different events.

## Pin history

The npm runtime deps were pinned to the installed, tested versions (`marked@14.1.4`, `highlight.js@10.7.3`, `node-emoji@2.2.0`, `string-width@8.2.2`, `yaml@2.9.0`). Four were promoted from transitive to direct in WP-6 of `plans/marked-terminal-replacement.md` at their installed versions (no byte moved) and left again: `supports-color`, `supports-hyperlinks` (colour-policy WP-1), `cli-highlight`, `@colors/colors` (WP-2), `ansi-escapes@7.3.0` (WP-3). None of those removals moved a forced-colour byte.

`highlight.js` is held at `10.7.3`, two majors behind: a major changes which spans it emits, so every fenced block can change its forced-colour bytes (parity class C). What a bump owes is in `docs/agents/dependency-history.md`, "`highlight.js` — the one keeper with a pin history". `string-width` had one deliberate bump, 7.2.0 → 8.2.2 (`plans/pictograph-width.md`): a measured render-time budget in both colour modes, a per-cluster cache in `TS_BASELINE` `src/width.ts`, and a cross-bump corpus pass with every class-B diff attributed (`docs/agents/dependency-history.md`, "`string-width` — the one bump, and what it cost").
