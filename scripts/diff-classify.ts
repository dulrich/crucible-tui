/**
 * The differential harness's pure half: compute one combo's record, diff two records across
 * the four channels, and classify a whole paired population into pass/fail.
 *
 * Split out of `scripts/render-diff.ts` at WP-R1
 * (`plans/post-refactor-code-quality-remediation.md`) with no behaviour change — the same
 * four channels, the same class-C rule, the same `ok` expression.
 *
 * **Nothing here reads a process, a file, an argument or a clock.** `computeComboRecord`
 * renders through a `RevisionHandle` it is handed; everything below it is a function of its
 * arguments. The CLI that parses flags, resolves corpora, writes baselines and prints the
 * summary is `scripts/render-diff.ts`, which imports downward into this module and into
 * `./revision`; neither imports it back.
 */
import { sha256Hex } from "./hash";
import type {
  AmbiguousModeName,
  ComboErrorEntry,
  ComboKey,
  ComboRecord,
  DetectorCounts,
  GlyphTierName,
  RevisionHandle,
} from "./revision";

/**
 * The text covered by `codeRanges`, extracted by 1-based inclusive line range and
 * concatenated in document order, newline-joined. Two sources feed `codeRanges` in
 * `src/render.ts` — fenced code blocks, and a frontmatter block that failed to parse
 * and is echoed raw — and both are "reproduced verbatim, may not reflow", which is
 * exactly what this channel exists to pin. An empty `codeRanges` yields `""`.
 */
export function extractCodeContent(text: string, codeRanges: Array<[number, number]>): string {
  if (codeRanges.length === 0) return "";
  const lines = text.split("\n");
  const parts: string[] = [];
  for (const [start, end] of codeRanges) {
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      parts.push(lines[lineNumber - 1] ?? "");
    }
  }
  return parts.join("\n");
}

// --- Combo computation ---------------------------------------------------------------

export interface ComboResult {
  record: ComboRecord | null;
  error: ComboErrorEntry | null;
}

/** Render, detect and hash one `(file × width × tier × ambiguous)` combination. */
export function computeComboRecord(
  handle: RevisionHandle,
  file: string,
  source: string,
  width: number,
  tier: GlyphTierName,
  ambiguous: AmbiguousModeName,
): ComboResult {
  try {
    const { text, codeRanges } = handle.render(source, width, tier, ambiguous);
    const detectors = handle.detect(text, width, codeRanges, ambiguous);
    const overflowed = handle.overflowed(text, width, codeRanges, ambiguous);
    return {
      record: {
        file,
        width,
        tier,
        ambiguous,
        textSha: sha256Hex(text),
        codeContentSha: sha256Hex(extractCodeContent(text, codeRanges)),
        codeRanges,
        detectors,
        overflowed,
      },
      error: null,
    };
  } catch (error) {
    return {
      record: null,
      error: { file, width, tier, ambiguous, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

// --- Diffing and classification -------------------------------------------------------

export type DiffChannel = "textSha" | "codeContentSha" | "codeRanges" | "detectors";

function codeRangesEqual(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  return a.every(([start, end], index) => b[index]?.[0] === start && b[index]?.[1] === end);
}

function detectorsEqual(a: DetectorCounts, b: DetectorCounts): boolean {
  return a.orphans === b.orphans && a.overIndent === b.overIndent && a.columnZero === b.columnZero;
}

/** Which of the four channels differ between two records for the same combo key. */
export function diffCombo(before: ComboRecord, after: ComboRecord): DiffChannel[] {
  const channels: DiffChannel[] = [];
  if (before.textSha !== after.textSha) channels.push("textSha");
  if (before.codeContentSha !== after.codeContentSha) channels.push("codeContentSha");
  if (!codeRangesEqual(before.codeRanges, after.codeRanges)) channels.push("codeRanges");
  if (!detectorsEqual(before.detectors, after.detectors)) channels.push("detectors");
  return channels;
}

export interface ComboDiff {
  key: ComboKey;
  channels: DiffChannel[];
  before: ComboRecord;
  after: ComboRecord;
}

export interface PairedCombo {
  before: ComboRecord;
  after: ComboRecord;
}

export type ExpectClass = "a" | "b";

export interface OverflowRegression {
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  before: number;
  after: number;
}

/**
 * A `(width, tier, ambiguous)` group where at least one of the three detector counts rose.
 *
 * **The hole this closes.** Until WP-3 a `detectors` diff under `--expect b` was swept into
 * `allowedB` and its *direction* was never checked: `classifyDiffs` computed a
 * `before > after` comparison for `overflowed` alone, so a package that tripled the orphan
 * count reported `ok: true`. Under `--expect a` it was invisible, because *any*
 * non-class-C diff failed there — which is why WP-2 never hit it. The plan requires all
 * three counts (`findListOrphans`, `findContinuationOverIndent`, `findColumnZeroMarkers`)
 * to be **non-increasing at every package**, so this mirrors `OverflowRegression` and is
 * folded into `ok` the same way.
 *
 * **It sums hits, where the overflow ratchet counts combos.** `ComboRecord.overflowed` is a
 * per-file boolean, so `overflowRegressions` measures how many *files* overflow, not how
 * many lines: a file going from ten overflowing lines to one shows no improvement there.
 * That is conservative in the right direction but coarser than the plan's wording implies —
 * recorded rather than changed, because tightening it would move a number every archived
 * run compares against. The detector counts are already integers per combo, so summing them
 * costs nothing and gives the finer measure for free.
 */
export interface DetectorRegression {
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  detector: keyof DetectorCounts;
  before: number;
  after: number;
}

export interface ClassificationSummary {
  expect: ExpectClass;
  totalCombos: number;
  diffedCombos: number;
  /** Any `codeContentSha` diff — forbidden always, regardless of `expect`. */
  classC: ComboDiff[];
  /** Non-`codeContentSha` diffs not permitted under the declared `expect`. */
  disallowed: ComboDiff[];
  /** Non-`codeContentSha` diffs permitted because `expect === "b"`. */
  allowedB: ComboDiff[];
  /** `expect === "b"` only: `(width, tier, ambiguous)` groups where overflow rose. */
  overflowRegressions: OverflowRegression[];
  /**
   * `(width, tier, ambiguous, detector)` combinations whose summed hit count rose.
   *
   * Computed and enforced regardless of `expect`, unlike `overflowRegressions`. Under
   * `--expect a` that is strictly redundant — a `detectors` diff already lands in
   * `disallowed` there — so it can only ever agree; under `--expect b` it is the only thing
   * standing between a detector regression and a green run.
   */
  detectorRegressions: DetectorRegression[];
  /**
   * `pairs` was empty. **A differ that reports "no differences" because it is
   * comparing nothing is the classic failure of this exact tool** (this WP's own
   * brief), and a green run looks identical either way unless this is surfaced
   * separately from `ok`. Set whenever `pairs.length === 0`, regardless of
   * `allowEmpty` — `ok` is what `allowEmpty` controls; this field is what makes the
   * cause legible either way.
   */
  emptyComparison: boolean;
  ok: boolean;
}

/**
 * Classify every paired combo into exactly one outcome and decide pass/fail.
 *
 * **Class C is checked unconditionally.** There is no `--expect c`: the plan's
 * Verification section calls class C "forbidden, always", never something a caller
 * opts into, so a `codeContentSha` diff fails the run regardless of `expect` — see
 * this WP's report for why `"a" | "b"` (not `"a" | "b" | "c"`) is the exported type.
 *
 * `pairs` must include **every** compared combo, not only the differing ones: the
 * class-B overflow ratchet is a property of the whole `(width, tier, ambiguous)`
 * population (does the *count* of overflowing combos rise), not of the diff list.
 */
export interface ClassifyOptions {
  /**
   * Explicit opt-in to accept an empty comparison as a pass. **Off by default on
   * purpose**: an empty `pairs` array producing `ok: true` is the exact "compared
   * nothing, reported green" failure this harness exists to rule out (reproduced
   * directly: `classifyDiffs([], "a")` used to return `{ ok: true }`). A caller that
   * genuinely expects zero combos — a corpus scoped down to nothing on purpose —
   * must say so explicitly rather than getting it as the silent default.
   */
  allowEmpty?: boolean;
}

/** The three detector channels, in the order the plan names them. */
const DETECTOR_NAMES: Array<keyof DetectorCounts> = ["orphans", "overIndent", "columnZero"];

// A composite group key's field separator, joining width/tier/ambiguous-mode below.
// `String.fromCharCode(0)` rather than a raw NUL byte typed into the source, for the
// same reason `src/render.ts`'s `SENTINEL` is spelled this way: a literal NUL embedded
// in this file makes it binary to `grep`/`rg` — both skip it silently without `-a`/
// `--text`, so a search for a symbol that is right here returns nothing. A space would
// not do instead: `tier` and `ambiguous` are themselves plain words with no embedded
// whitespace, so a single NUL keeps the three-field split unambiguous without needing
// to be a character no field could ever contain.
const GROUP_KEY_SEPARATOR = String.fromCharCode(0);

export function classifyDiffs(
  pairs: PairedCombo[],
  expect: ExpectClass,
  options: ClassifyOptions = {},
): ClassificationSummary {
  const emptyComparison = pairs.length === 0;
  if (emptyComparison && !options.allowEmpty) {
    return {
      expect,
      totalCombos: 0,
      diffedCombos: 0,
      classC: [],
      disallowed: [],
      allowedB: [],
      overflowRegressions: [],
      detectorRegressions: [],
      emptyComparison: true,
      ok: false,
    };
  }

  const classC: ComboDiff[] = [];
  const disallowed: ComboDiff[] = [];
  const allowedB: ComboDiff[] = [];
  let diffedCombos = 0;

  for (const { before, after } of pairs) {
    const channels = diffCombo(before, after);
    if (channels.length === 0) continue;
    diffedCombos += 1;
    const key: ComboKey = { file: before.file, width: before.width, tier: before.tier, ambiguous: before.ambiguous };
    const diff: ComboDiff = { key, channels, before, after };
    if (channels.includes("codeContentSha")) {
      classC.push(diff);
      continue;
    }
    if (expect === "a") {
      disallowed.push(diff);
    } else {
      allowedB.push(diff);
    }
  }

  const overflowBefore = new Map<string, number>();
  const overflowAfter = new Map<string, number>();
  const groupKey = (r: ComboRecord): string => `${r.width}${GROUP_KEY_SEPARATOR}${r.tier}${GROUP_KEY_SEPARATOR}${r.ambiguous}`;
  for (const { before, after } of pairs) {
    const key = groupKey(before);
    if (before.overflowed) overflowBefore.set(key, (overflowBefore.get(key) ?? 0) + 1);
    if (after.overflowed) overflowAfter.set(key, (overflowAfter.get(key) ?? 0) + 1);
  }
  const overflowRegressions: OverflowRegression[] = [];
  if (expect === "b") {
    const allKeys = new Set([...overflowBefore.keys(), ...overflowAfter.keys()]);
    for (const key of allKeys) {
      const [widthStr, tier, ambiguous] = key.split(GROUP_KEY_SEPARATOR) as [string, GlyphTierName, AmbiguousModeName];
      const beforeCount = overflowBefore.get(key) ?? 0;
      const afterCount = overflowAfter.get(key) ?? 0;
      if (afterCount > beforeCount) {
        overflowRegressions.push({ width: Number(widthStr), tier, ambiguous, before: beforeCount, after: afterCount });
      }
    }
  }

  // The three detector counts, summed per `(width, tier, ambiguous)` group and compared in
  // the same direction the plan requires them to move: down, or not at all.
  const detectorSums = new Map<string, { before: DetectorCounts; after: DetectorCounts }>();
  for (const { before, after } of pairs) {
    const key = groupKey(before);
    let entry = detectorSums.get(key);
    if (entry === undefined) {
      entry = { before: { orphans: 0, overIndent: 0, columnZero: 0 }, after: { orphans: 0, overIndent: 0, columnZero: 0 } };
      detectorSums.set(key, entry);
    }
    for (const detector of DETECTOR_NAMES) {
      entry.before[detector] += before.detectors[detector];
      entry.after[detector] += after.detectors[detector];
    }
  }
  const detectorRegressions: DetectorRegression[] = [];
  for (const [key, entry] of detectorSums) {
    const [widthStr, tier, ambiguous] = key.split("\u0000") as [string, GlyphTierName, AmbiguousModeName];
    for (const detector of DETECTOR_NAMES) {
      if (entry.after[detector] > entry.before[detector]) {
        detectorRegressions.push({
          width: Number(widthStr),
          tier,
          ambiguous,
          detector,
          before: entry.before[detector],
          after: entry.after[detector],
        });
      }
    }
  }

  const ok =
    classC.length === 0 &&
    disallowed.length === 0 &&
    detectorRegressions.length === 0 &&
    (expect === "a" || overflowRegressions.length === 0);

  return {
    expect,
    totalCombos: pairs.length,
    diffedCombos,
    classC,
    disallowed,
    allowedB,
    overflowRegressions,
    detectorRegressions,
    emptyComparison,
    ok,
  };
}