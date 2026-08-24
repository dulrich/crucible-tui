/**
 * The one hash primitive this repo's instrumentation shares — a neutral leaf that imports
 * nothing of this repo's own, so nothing can gain a cycle through it (WP-R1,
 * `plans/post-refactor-code-quality-remediation.md`).
 *
 * It lived in `scripts/render-diff.ts` until WP-R1, and that placement is what closed the
 * `corpus -> render-diff -> sweep -> corpus` import cycle: the colour axis inside
 * `scripts/corpus.ts` needed the same digest the differential harness uses, so the sweep's
 * *library* imported a *CLI* to get it. Both consumers — `scripts/colour-axis.ts`'s
 * `digestSequences` and `scripts/diff-classify.ts`'s `computeComboRecord` — import it from
 * here now, and that edge no longer exists.
 *
 * There is deliberately one implementation rather than one per instrument: the colour axis
 * and the differential harness compare their own numbers against dated runs in a private
 * archive, and the two have to agree on what "the same text" means.
 */
import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
