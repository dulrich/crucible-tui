/**
 * The shared vocabulary of a *rendered* line: strip its ANSI, recognise a list marker,
 * and say which open item a continuation line belongs to.
 *
 * These primitives were `src/detectors.ts`' own until WP-5 of
 * `plans/tn-review-remediation.md`. They moved because they are **production** code that
 * the detectors merely also use: `src/render.ts`'s re-alignment pass needs `stripAnsi`,
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
 * sites strip ANSI *before* tracking (`src/render.ts`, `src/detectors.ts`), and a lost
 * escape byte in an ANSI strip has already produced one fully confident false measurement
 * here — the "three-column table overflow" that did not exist (`AGENTS.md`, "The table
 * allocator is not broken"). `LIST_BULLET` and `LIST_MARKER_PREFIX` are the same regex
 * family, one capturing and one not; splitting a family whose halves must agree about what
 * a marker looks like is the same failure mode one level down.
 *
 * ## Keep it dependency-light
 *
 * The only import here is `./width`, for the `Measure` a caller passes in — that is what
 * lets `render.ts` reach these symbols without reaching anything else. Nothing in this
 * module may import `./detectors`; the dependency runs the other way.
 */
import { NARROW_MEASURE, type Measure } from "./width";

// Deliberately matching the ESC control character to strip ANSI SGR codes, so a
// detector measures the text a reader sees rather than the escape bytes.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

/**
 * A rendered list marker line: at least two columns of indent, a bullet or an
 * ordered marker, then the item's text. The bullet class covers both glyph tiers
 * (`•◦‣` unicode, `-` ascii) plus the `*`/`+` the library can still emit.
 */
export const LIST_BULLET = /^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/;

/** Same, but capturing the full marker prefix so the item's text column is derivable. */
const LIST_MARKER_PREFIX = /^(\s{2,}(?:[•*\-◦‣+]|\d+\.)\s+)/;

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
