/**
 * The shared vocabulary of a *rendered* line: strip its ANSI, recognise a list marker,
 * and say which open item a continuation line belongs to.
 *
 * These primitives were `TS_BASELINE` `src/detectors.ts`' own until WP-5 of
 * `plans/tn-review-remediation.md`. They moved because they are **production** code that
 * the detectors merely also use: `TS_BASELINE` `src/render.ts`'s re-alignment pass needs `stripAnsi`,
 * `trackListLine` and `OpenListItem`, and importing them from the detector module put that
 * whole module — a second `Marked` instantiation, the block-end probe, the shear
 * classifier, none of which has a production caller — into the import graph
 * `package.json` compiles the shipped binary from.
 *
 * **The measured bundle saving is 151 bytes, and saying so is the point.** WP-5's brief
 * expected witness symbols unique to the detectors (`classifyListOrphans`,
 * `probeBlockEnds`, `PROBE_TRAILER`) to be present in the parent's bundle and absent from
 * this one. Measured with `bun build --target=bun`: **they were already absent** — the
 * bundler tree-shakes every detector function `render.ts` cannot reach, including the
 * second `Marked` instantiation. What the parent's bundle really carried from
 * `detectors.ts` was these primitives plus three probe constants (`PROBE_PARAGRAPH`,
 * `PROBE_BLOCK`, `PROSE_BLOCKS`) whose initialisers are call expressions tree-shaking will
 * not drop — 1,005 bytes, against 853 for this module, on a 2.68 MB bundle. **The case for
 * this module is cohesion; the byte count is a rounding error and must not be quoted as
 * anything else.**
 *
 * ## Moved, never copied — that constraint is the whole point of this module
 *
 * `trackListLine` is the one implementation of "which item does this rendered line belong
 * to". `findContinuationOverIndent` **grades** the re-alignment pass in `render.ts` that
 * rewrites using it, so a detector and the fix it measures must not be able to disagree
 * about where an item's text column is. One implementation is the property; one *file* is
 * not — which is why relocating it preserves that property and duplicating it would kill
 * it the day somebody tunes one side, with **no gate in this repo able to see it happen**.
 *
 * `stripAnsi` travels with it for the same reason rather than as a convenience: both call
 * sites strip ANSI *before* tracking (`TS_BASELINE` `src/render.ts`, `src/detectors.ts`), and a lost
 * escape byte in an ANSI strip has already produced one fully confident false measurement
 * here — the "three-column table overflow" that did not exist (`scripts/AGENTS.md`,
 * "The table allocator is not broken"). `LIST_BULLET` and `LIST_MARKER_PREFIX` are the
 * same regex family, one capturing and one not; splitting a family whose halves must
 * agree about what a marker looks like is the same failure mode one level down.
 *
 * ## Keep it dependency-light
 *
 * The imports here are `./width`, for the `Measure` a caller passes in, and `./ansi`, for
 * the sequence grammar `stripAnsi` is now a derivation of (WP-3 of
 * `plans/colour-policy.md`) — which imports nothing but `./width` itself, so the property
 * this section is about is unchanged: `render.ts` reaches these symbols without reaching
 * anything else. Nothing in this module may import `./detectors`; the dependency runs the
 * other way.
 */
import { stripSequences } from "./ansi";
import { NARROW_MEASURE, type Measure } from "./width";

/**
 * The visible columns of a rendered line — every terminal sequence removed, so a detector
 * or a layout pass measures the text a reader sees rather than the escape bytes.
 *
 * **This is a derivation of `TS_BASELINE` `src/ansi.ts`'s scanner since WP-3 of
 * `plans/colour-policy.md`, and it used to be `/\x1b\[[0-9;]*m/g` — SGR only.** That
 * regex was correct about the only sequence the renderer emitted at the time and silently
 * wrong about the two it can emit now: an OSC-8 hyperlink and its tmux DCS wrapper both
 * survived it intact, so every consumer of this function counted a hyperlink's
 * destination URL as visible text. One vocabulary, in one module, in both directions —
 * see `TS_BASELINE` `src/ansi.ts`'s header.
 *
 * The name stays `stripAnsi`: it is what six modules and three test files call it, and
 * WP-3 renaming it would have buried a behaviour change under a mechanical diff.
 */
export const stripAnsi = (value: string): string => stripSequences(value);

/**
 * A rendered list marker line: at least two columns of indent, a bullet or an
 * ordered marker, then the item's text. The bullet class covers both glyph tiers
 * (`•◦‣` unicode, `-` ascii) plus the `*`/`+` the library can still emit.
 */
export const LIST_BULLET = /^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/;

/** Same, but capturing the full marker prefix so the item's text column is derivable. */
const LIST_MARKER_PREFIX = /^(\s{2,}(?:[•*\-◦‣+]|\d+\.)\s+)/;

/**
 * A rendered line `marked-terminal`'s composition model will mistake for a list marker of
 * its own — `isPointedLine`'s shape (`index.js:532-534`) with the indent group stripped
 * off, i.e. what a line *at column 0* looks like to it.
 *
 * When a list body is composed, an item's continuation lines are still at column 0 and no
 * space is required after the marker, so a wrapped line that merely *begins* `**bold**` or
 * `1.5x` is taken for a marker line — and in an ordered list the number is consumed and
 * the first `"* "` anywhere in the line is rewritten. `TS_BASELINE` `src/render.ts`'s two wrapping seams
 * defuse it by giving such a continuation line one leading guard space, which the
 * exact-multiple-of-four indent group cannot match.
 *
 * **Moved here in WP-4 of `plans/marked-terminal-replacement.md`** from `TS_BASELINE` `src/render.ts`,
 * beside `COLUMN_ZERO_MARKER` and the rest of the rendered-line vocabulary, because
 * `findContinuationOverIndent` now has to recognise the very guard space the render seams
 * add — a detector and the fix it grades must not be able to disagree about what a marker
 * shape is, which is this module's whole reason to exist.
 */
export const MARKER_SHAPED_LINE = /^(?:\*|\d+\.)/;

/**
 * A rendered list marker sitting at **column 0** — the same marker shapes `LIST_BULLET`
 * recognizes, both glyph tiers, but with no indent in front of them at all.
 *
 * **A second marker shape, and the two are answering different questions.**
 * `MARKER_SHAPED_LINE` above is `isPointedLine`'s shape: what the composer will mistake
 * for a marker of its own and renumber. This one is broader in its bullet set and requires
 * a space after the marker, and it asks the human question instead: does this line look, to
 * a reader, like a bullet that escaped its list? A wrapped prose line beginning `+ sources`
 * immediately above an indented list is not a renumbering hazard (`isPointedLine` does not
 * recognise `+` at all) and is still a line nobody meant to write.
 *
 * **It used to be two hand-synchronised copies** — `TS_BASELINE` `src/detectors.ts`' `COLUMN_ZERO_MARKER`
 * and `TS_BASELINE` `src/render.ts`' `COLUMN_ZERO_SHAPED_LINE`, spelled with literal glyphs in one file
 * and `\u` escapes in the other, with no gate in this repo able to see them drift. The
 * duplication existed only because `TS_BASELINE` `src/render.ts` must not import `src/detectors.ts`
 * (that would put a second `Marked` instantiation and the whole detector module into the
 * shipped binary's import graph); this module is the seam that makes one copy possible, and
 * `TS_BASELINE` `src/render.ts`'s own note said the move belonged to whichever of WP-4 or WP-7 next had
 * both files open. WP-4 did.
 */
export const COLUMN_ZERO_MARKER = /^(?:[\u2022*\-\u25e6\u2023+]|\d+\.)\s/;

/**
 * True when a rendered line reads as a marker to *either* audience — the composer that
 * would renumber it, or the reader who would see a stray bullet.
 *
 * This is the predicate `TS_BASELINE` `src/render.ts`'s `paragraph` seam guards with and the one
 * `findContinuationOverIndent` must forgive a one-column drift on, and having it in one
 * place is the point: the guard adds exactly one column, and a detector that graded that
 * column as a defect was marking the fix down as the bug.
 */
export const isGuardShapedLine = (text: string): boolean =>
  MARKER_SHAPED_LINE.test(text) || COLUMN_ZERO_MARKER.test(text);

/** A rendered line that is inside some list item — indented, and carrying text. */
export const isIndentedLine = (line: string): boolean => /^\s{2,}\S/.test(line);

/** One open list item on an innermost-last stack: where its marker sits, where its text starts. */
export interface OpenListItem {
  /** Display column the marker glyph itself sits at. */
  markerColumn: number;
  /** Display column the item's text starts at — where its continuations belong. */
  textColumn: number;
}

/**
 * Advance an innermost-last stack of open list items by one rendered line, and report
 * which item that line is a **continuation** of (`null` when it is not a continuation:
 * a blank line, a marker line, or a line that closed every open list).
 *
 * This is the one implementation of "which item does this rendered line belong to".
 * `findContinuationOverIndent` measures with it and `render.ts`'s re-alignment pass
 * (WP-2e) rewrites with it, deliberately: a detector and the fix it grades must not be
 * able to disagree about what an item's text column is.
 *
 * Callers pass ANSI-stripped lines and own the stack array, which is mutated in place.
 */
export function trackListLine(
  line: string,
  open: OpenListItem[],
  measure: Measure = NARROW_MEASURE,
): OpenListItem | null {
  if (line.trim() === "") return null; // a loose item's blank line does not close it

  const marker = LIST_MARKER_PREFIX.exec(line);
  if (marker) {
    const prefix = marker[1] as string;
    const markerColumn = measure(prefix.slice(0, prefix.length - prefix.trimStart().length));
    const textColumn = measure(prefix);
    // a marker at or left of the top of the stack closes every level it is not inside
    while (open.length > 0 && (open[open.length - 1] as OpenListItem).markerColumn >= markerColumn) {
      open.pop();
    }
    open.push({ markerColumn, textColumn });
    return null;
  }

  if (!isIndentedLine(line)) {
    open.length = 0; // back at column 0 with real text — every list is closed
    return null;
  }

  return open[open.length - 1] ?? null;
}
