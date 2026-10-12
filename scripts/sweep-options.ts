/**
 * The width grammar both instrument CLIs parse, as one shared leaf (WP-R1,
 * `plans/post-refactor-code-quality-remediation.md`).
 *
 * `DEFAULT_WIDTHS` was declared **twice**, verbatim, in `scripts/sweep.ts` and
 * `scripts/render-diff.ts`, and the second copy carried a comment defending the duplication
 * on the grounds that the sweep CLI did not export it. That defence is retired along with
 * the duplication. `parseWidths` sits beside it because `scripts/render-diff.ts` was
 * importing it *from the sweep CLI* — one of the three edges of the
 * `corpus -> render-diff -> sweep -> corpus` cycle WP-R1 broke.
 *
 * This module imports nothing, from this repo or anywhere else, which is the property that
 * makes it safe for every CLI and library here to import downward into it.
 */

/**
 * **116 and 346 are two of the user's three real terminal widths** (the three tiled
 * layouts are 116 / 172 / 346), added in WP-2c. Until then this swept 80/100/160 —
 * none of which anyone reads at — and the tight-list orphan defect was consequently
 * measured only at widths that do not exist on this machine. A defect measured at an
 * unused width is measured wrong, in either direction.
 *
 * 80, 100 and 160 are kept rather than swapped out: they are the recorded baseline for
 * every dated full-corpus run in the private archive's `measurements/`, and 80 is the
 * narrowest case the table allocator has to survive (it is where the accepted-by-design
 * many-column overflows in `crates/mdview/AGENTS.md` live). Adding widths only ever adds combos.
 */
export const DEFAULT_WIDTHS = [80, 100, 116, 160, 346];

/**
 * Parse a `--widths` value: a comma list (`80,100,160`), an inclusive range
 * (`40-360`), or any mix of the two (`40-80,116,346`).
 *
 * The range form exists because **orphan defects are sharply width-sensitive** — an
 * orphan only exists when an authored line's length plus the item's marker and indent
 * straddles the target, so a note fails at some widths and is clean at others. The
 * measured swing was 9x across 16 columns, which means a three-width gate samples this
 * defect class essentially at random: the old 80/100/160 set was telling us about
 * 80/100/160 and nothing else. Sweeping a dense range only became affordable by
 * inverting the axes — few files x every width, instead of every file x few widths.
 */
export function parseWidths(value: string): number[] {
  const widths: number[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from <= 0 || to <= 0) throw new Error(`--widths must be positive numbers, got: ${part}`);
      if (to < from) throw new Error(`--widths range must be ascending, got: ${part}`);
      for (let width = from; width <= to; width += 1) widths.push(width);
      continue;
    }
    const parsed = Number(part);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--widths must be positive numbers, got: ${part}`);
    }
    widths.push(parsed);
  }
  if (widths.length === 0) throw new Error("--widths resolved to no widths");
  return [...new Set(widths)];
}
