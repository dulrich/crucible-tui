/**
 * The width gate — one implementation, imported by everything that runs it.
 *
 * "No rendered line exceeds the target width" is the claim this whole tool exists
 * to be able to make, and until WP-2 of the review-remediation sprint it was
 * implemented **three** times: `checkOverflow` in `TS_BASELINE` `src/cli.ts` (behind `--check`),
 * `findOverflow` in `scripts/sweep.ts`, and a third copy of the code-range
 * exemption predicate in `TS_BASELINE` `src/detectors.ts`. The three agreed argument for
 * argument, which is precisely the state that drifts silently: nothing in the repo
 * compares them, and a check that disagreed with the sweep would make every width
 * figure here unreliable with no gate turning red. This module is the same
 * argument `TS_BASELINE` `src/detectors.ts` makes for living in `src/` rather than in a test
 * file — one implementation, not two that drift — applied to the gate itself.
 *
 * Dependency-light on purpose: the `Measure` type and nothing else. In particular
 * it does **not** import `string-width` — `TS_BASELINE` `src/width.ts` is the only file in
 * `src/` or `scripts/` allowed to, and `tests/width.test.ts` asserts it, because a
 * module that imports it directly silently opts out of whatever ambiguous-width
 * mode was resolved and **no width gate can see that**.
 */
import { NARROW_MEASURE, type Measure } from "./width";

/** Inclusive 1-based `[startLine, endLine]` pairs, as `renderDocumentDetailed` returns. */
export type CodeRanges = Array<[number, number]>;

/** The first offending line: 1-based line number, and the width it measured. */
export interface OverflowHit {
  line: number;
  width: number;
}

/**
 * Is this line inside a recorded fenced-code range, and therefore not the width
 * gate's to judge?
 *
 * `codeRanges` are the 1-based, inclusive line ranges `render.ts` recorded for
 * fenced code blocks — exempt by the user's explicit "never rewrite code" decision
 * (see `TS_BASELINE` `src/render.ts`'s `wrapCode`). Everything else must fit `targetWidth`.
 *
 * **The array is required, deliberately.** A widened exemption is the dangerous
 * direction — it makes gates pass *more*, never less, and is invisible to every
 * gate in this repo — so the predicate itself has no notion of "ranges I was not
 * given". A caller whose ranges are genuinely optional (`TS_BASELINE` `src/detectors.ts`, whose
 * `DetectorOptions.codeRanges` is opt-in and defaults to off so that
 * `findListOrphans`' historical counts cannot move) decides what absence means at
 * its own boundary and calls this with an array either way.
 */
export function isLineExempt(lineNumber: number, codeRanges: CodeRanges): boolean {
  return codeRanges.some(([start, end]) => lineNumber >= start && lineNumber <= end);
}

/**
 * The **first** non-exempt line whose display width exceeds `targetWidth`, or `null`.
 *
 * First, not all of them: that is the contract both former call sites had, and the
 * sweep records one entry per file-width combo from it. (`scripts/sweep.ts`'s copy
 * carried a doc comment claiming it "returns every overflow instead of stopping at
 * the first" — it never did; the comment described an intention, the code returned
 * on the first hit exactly as the CLI's did.)
 *
 * `measure` is the same `Measure` the render was allocated with, never a fresh
 * default (WP-3). `--check` is this tool's self-smoke: its whole claim is "the
 * renderer hit the budget it was given", and a check that measured with a
 * different ruler than the allocation used would be asserting something else
 * entirely — and would pass or fail for reasons the renderer cannot act on. The
 * sweep threads its ruler for the same reason: a sweep that allocated one way and
 * measured another would report an overflow count about nothing. The
 * `NARROW_MEASURE` default is the resolution order's rule 4, not a convenience.
 */
export function findFirstOverflow(
  output: string,
  targetWidth: number,
  codeRanges: CodeRanges,
  measure: Measure = NARROW_MEASURE,
): OverflowHit | null {
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (isLineExempt(lineNumber, codeRanges)) continue;
    const width = measure(lines[index] ?? "");
    if (width > targetWidth) {
      return { line: lineNumber, width };
    }
  }
  return null;
}
