/**
 * The differential harness's pure half: compute one combo's record, diff two records across
 * the four channels, and classify a whole paired population into pass/fail.
 *
 * Split out of `scripts/render-diff.ts` at WP-R1
 * (`plans/post-refactor-code-quality-remediation.md`) with no behaviour change — the same
 * four channels, the same class-C rule, the same `ok` expression.
 *
 * **WP-1 of `plans/mdview-rust-port.md`** added the policy and emoji axes, D-C's channels for
 * P2–P4 (`proseSha`, `echoSha`, `fenceStrippedSha`, the pairwise `fencePrefixOk`,
 * `sgrVocabOk`; a `textSha`/`codeContentSha`-only diff there is `allowedDC`, never a failure),
 * and the non-vacuity counters with their `requireNonzero` gate. `computeComboRecord` is async
 * now and measures through a `Measurer` it is handed — the current checkout's measurement
 * code — rather than through the revision handle.
 *
 * **Nothing here reads a process, a file, an argument or a clock.** `computeComboRecord`
 * renders through a `RevisionHandle` and measures through a `Measurer` it is handed; everything below it is a function of its
 * arguments. The CLI that parses flags, resolves corpora, writes baselines and prints the
 * summary is `scripts/render-diff.ts`, which imports downward into this module and into
 * `./revision`; neither imports it back.
 */
import { sha256Hex } from "./hash";
import {
  POLICIES,
  emojiOf,
  policyOf,
  type AmbiguousModeName,
  type ComboErrorEntry,
  type ComboKey,
  type ComboRecord,
  type DetectorCounts,
  type GlyphTierName,
  type Measurer,
  type PolicyName,
  type RenderOutput,
  type RenderRequest,
  type RevisionHandle,
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
  /**
   * The rendered output, handed back transiently so a caller holding both sides can run the
   * pairwise fence check (`fencePrefixOk`). Never stored in a record or a baseline.
   */
  output?: RenderOutput;
}

/** True when the policy turns the highlighter on, so D-C's channels judge the combo. */
export function isDcPolicy(policy: PolicyName): boolean {
  return policy === "P2" || policy === "P3" || policy === "P4";
}

/** Lines `[start, end]` (1-based, inclusive) of every range, as a set of 1-based numbers. */
function linesIn(ranges: Array<[number, number]>): Set<number> {
  const lines = new Set<number>();
  for (const [start, end] of ranges) for (let n = start; n <= end; n += 1) lines.add(n);
  return lines;
}

/** Split `codeRanges` into the frontmatter-echo ranges (the first `echoCount`) and fence ranges. */
export function splitRanges(
  codeRanges: Array<[number, number]>,
  echoCount: number,
): { echo: Array<[number, number]>; fence: Array<[number, number]> } {
  return { echo: codeRanges.slice(0, echoCount), fence: codeRanges.slice(echoCount) };
}

/** A line with its SGR spans removed and every other span (text, OSC-8, DCS, malformed) kept. */
function stripSgr(line: string, measurer: Measurer): string {
  return measurer
    .scan(line)
    .filter((span) => span.kind !== "sgr")
    .map((span) => span.raw)
    .join("");
}

/**
 * The SGR vocabulary check, over **generated** sequences only: every SGR span in `text` that
 * does not occur verbatim in `source` must be a committed `STYLE_TABLE` open or close. An
 * authored escape keeps its reference bytes and is checked by the exact channels instead.
 */
export function sgrVocabularyOk(text: string, source: string, measurer: Measurer): boolean {
  for (const span of measurer.scan(text)) {
    if (span.kind !== "sgr") continue;
    if (measurer.styleCodes.has(span.raw)) continue;
    if (source.includes(span.raw)) continue;
    return false;
  }
  return true;
}

/**
 * Render, measure and hash one `(file × width × tier × ambiguous × policy × emoji)` combination.
 * `handle` renders; `measurer` (the current checkout's measurement code) measures — so both
 * sides of a comparison are measured identically, whatever renders them.
 */
export async function computeComboRecord(
  handle: RevisionHandle,
  measurer: Measurer,
  request: RenderRequest & { path: string },
): Promise<ComboResult> {
  const { path: file, width, tier, ambiguous, policy, emoji } = request;
  const key: ComboKey = { file, width, tier, ambiguous, policy, emoji };
  try {
    const output = await handle.render(request);
    const { text, codeRanges } = output;
    const detectors = measurer.detect(text, width, codeRanges, ambiguous);
    const overflowed = measurer.overflowed(text, width, codeRanges, ambiguous);
    const spans = measurer.scan(text);
    const echoCount = Math.min(
      codeRanges.length,
      measurer.echoRangeCount(request.source, width, ambiguous, POLICIES[policy].sgr),
    );
    const { echo, fence } = splitRanges(codeRanges, echoCount);
    const lines = text.split("\n");
    let highlightedFences = 0;
    for (const [start, end] of fence) {
      for (let n = start; n <= end; n += 1) {
        if (measurer.scan(lines[n - 1] ?? "").some((span) => span.kind === "sgr")) {
          highlightedFences += 1;
          break;
        }
      }
    }
    const record: ComboRecord = {
      ...key,
      textSha: sha256Hex(text),
      codeContentSha: sha256Hex(extractCodeContent(text, codeRanges)),
      codeRanges,
      detectors,
      overflowed,
      hasSgr: spans.some((span) => span.kind === "sgr"),
      hasOsc8: spans.some((span) => span.kind === "osc8"),
      hasDcs: spans.some((span) => span.kind === "dcs"),
      highlightedFences,
    };
    if (isDcPolicy(policy)) {
      const inCode = linesIn(codeRanges);
      record.proseSha = sha256Hex(lines.filter((_, index) => !inCode.has(index + 1)).join("\n"));
      record.echoSha = sha256Hex(extractCodeContent(text, echo));
      record.fenceStrippedSha = sha256Hex(
        extractCodeContent(text, fence)
          .split("\n")
          .map((line) => stripSgr(line, measurer))
          .join("\n"),
      );
      record.sgrVocabOk = sgrVocabularyOk(text, request.source, measurer);
    }
    return { record, error: null, output };
  } catch (error) {
    return { record: null, error: { ...key, message: error instanceof Error ? error.message : String(error) } };
  }
}

/**
 * The pairwise half of D-C's fence rule: every fence line that differs between the two sides
 * must first diverge **inside an SGR sequence on at least one side** — so the bytes before the
 * first divergence (indent, list/quote prefix, any prose sharing the line) are byte-identical,
 * and the divergence itself is highlighter markup, never a visible byte, an OSC-8 or a DCS.
 *
 * Fence ranges are compared positionally; mismatched range lists return `false` (the exact
 * `codeRanges` channel reports the shift on its own). What this cannot do — and says so — is
 * tell a highlighter SGR from a prose SGR sharing the same physical line: both are SGR, and the
 * D-C allowance is SGR-granular (`hl-fence-claim` is the named entry for the one known case).
 * Nor does it stand alone: a visible byte inserted exactly where the other side starts an SGR
 * passes here and is caught by `fenceStrippedSha`, which is why both are recorded.
 */
export function fencePrefixesOk(
  before: RenderOutput,
  after: RenderOutput,
  echoCount: number,
  measurer: Measurer,
): boolean {
  const fenceA = before.codeRanges.slice(echoCount);
  const fenceB = after.codeRanges.slice(echoCount);
  if (fenceA.length !== fenceB.length) return false;
  const linesA = before.text.split("\n");
  const linesB = after.text.split("\n");
  for (let r = 0; r < fenceA.length; r += 1) {
    const [startA, endA] = fenceA[r]!;
    const [startB, endB] = fenceB[r]!;
    if (endA - startA !== endB - startB) return false;
    for (let offset = 0; offset <= endA - startA; offset += 1) {
      const a = linesA[startA - 1 + offset] ?? "";
      const b = linesB[startB - 1 + offset] ?? "";
      if (a === b) continue;
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      if (!insideSgr(a, i, measurer) && !insideSgr(b, i, measurer)) return false;
    }
  }
  return true;
}

/** Whether byte offset `index` of `line` falls inside (or at the start of) an SGR span. */
function insideSgr(line: string, index: number, measurer: Measurer): boolean {
  let offset = 0;
  for (const span of measurer.scan(line)) {
    const end = offset + span.raw.length;
    if (index >= offset && index < end) return span.kind === "sgr";
    offset = end;
  }
  return false;
}

// --- Diffing and classification -------------------------------------------------------

export type DiffChannel =
  | "textSha"
  | "codeContentSha"
  | "codeRanges"
  | "detectors"
  | "proseSha"
  | "echoSha"
  | "fenceStrippedSha"
  | "fencePrefix"
  | "sgrVocab";

/** The D-C channels whose diff is a code-content (class-C-like) failure under P2–P4. */
const DC_CODE_CHANNELS: readonly DiffChannel[] = ["echoSha", "fenceStrippedSha", "fencePrefix", "sgrVocab"];

function codeRangesEqual(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  if (a.length !== b.length) return false;
  return a.every(([start, end], index) => b[index]?.[0] === start && b[index]?.[1] === end);
}

function detectorsEqual(a: DetectorCounts, b: DetectorCounts): boolean {
  return a.orphans === b.orphans && a.overIndent === b.overIndent && a.columnZero === b.columnZero;
}

/**
 * Which channels differ between two records for the same combo key. The four historical
 * channels always; under P2–P4 also D-C's — `proseSha`, `echoSha`, `fenceStrippedSha` (a
 * difference, or absence on one side), `fencePrefix` (the pairwise check failed) and
 * `sgrVocab` (either side generated an uncommitted SGR).
 */
export function diffCombo(before: ComboRecord, after: ComboRecord): DiffChannel[] {
  const channels: DiffChannel[] = [];
  if (before.textSha !== after.textSha) channels.push("textSha");
  if (before.codeContentSha !== after.codeContentSha) channels.push("codeContentSha");
  if (!codeRangesEqual(before.codeRanges, after.codeRanges)) channels.push("codeRanges");
  if (!detectorsEqual(before.detectors, after.detectors)) channels.push("detectors");
  if (isDcPolicy(policyOf(before))) {
    if (before.proseSha !== after.proseSha) channels.push("proseSha");
    if (before.echoSha !== after.echoSha) channels.push("echoSha");
    if (before.fenceStrippedSha !== after.fenceStrippedSha) channels.push("fenceStrippedSha");
    if (after.fencePrefixOk === false || before.fencePrefixOk === false) channels.push("fencePrefix");
    if (before.sgrVocabOk === false || after.sgrVocabOk === false) channels.push("sgrVocab");
  }
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
  /**
   * P2–P4 only: diffs confined to `textSha`/`codeContentSha` while every D-C channel agrees —
   * highlighter SGR inside fences and nothing else (D-C, `plans/mdview-rust-port.md`). Never a
   * failure, always counted and printed.
   */
  allowedDC: ComboDiff[];
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
  /** The non-vacuity counters, summed per side over every paired combo. */
  nonvacuity: { before: NonvacuityCounters; after: NonvacuityCounters };
  /** One named reason per required counter found at zero on either side. */
  nonvacuityFailures: string[];
  ok: boolean;
}

export type NonvacuityCounter = "sgr" | "osc8" | "dcs" | "fences";
export const NONVACUITY_COUNTERS: readonly NonvacuityCounter[] = ["sgr", "osc8", "dcs", "fences"];

/** Combos carrying SGR / OSC-8 / DCS, and the number of highlighted fence ranges. */
export type NonvacuityCounters = Record<NonvacuityCounter, number>;

/** Sum one side's non-vacuity counters; a record without them (an old baseline) counts zero. */
export function sumNonvacuity(records: ComboRecord[]): NonvacuityCounters {
  const sums: NonvacuityCounters = { sgr: 0, osc8: 0, dcs: 0, fences: 0 };
  for (const record of records) {
    if (record.hasSgr === true) sums.sgr += 1;
    if (record.hasOsc8 === true) sums.osc8 += 1;
    if (record.hasDcs === true) sums.dcs += 1;
    sums.fences += record.highlightedFences ?? 0;
  }
  return sums;
}

/**
 * The non-vacuity requirement: a required counter at zero on **either** side is a named
 * failure. A capability gate whose evidence never occurred proves nothing about it.
 */
export function nonvacuityFailuresFor(
  counters: { before: NonvacuityCounters; after: NonvacuityCounters },
  required: readonly NonvacuityCounter[],
): string[] {
  const failures: string[] = [];
  for (const counter of required) {
    for (const side of ["before", "after"] as const) {
      if (counters[side][counter] === 0) {
        failures.push(`required non-vacuity counter "${counter}" is zero on the ${side === "before" ? "rev-a" : "rev-b"} side`);
      }
    }
  }
  return failures;
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
  /** Counters that must be non-zero on both sides (`--require-nonzero`). */
  requireNonzero?: readonly NonvacuityCounter[];
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
      allowedDC: [],
      overflowRegressions: [],
      detectorRegressions: [],
      emptyComparison: true,
      nonvacuity: { before: sumNonvacuity([]), after: sumNonvacuity([]) },
      nonvacuityFailures: nonvacuityFailuresFor(
        { before: sumNonvacuity([]), after: sumNonvacuity([]) },
        options.requireNonzero ?? [],
      ),
      ok: false,
    };
  }

  const classC: ComboDiff[] = [];
  const disallowed: ComboDiff[] = [];
  const allowedB: ComboDiff[] = [];
  const allowedDC: ComboDiff[] = [];
  let diffedCombos = 0;

  for (const { before, after } of pairs) {
    const channels = diffCombo(before, after);
    if (channels.length === 0) continue;
    diffedCombos += 1;
    const key: ComboKey = {
      file: before.file,
      width: before.width,
      tier: before.tier,
      ambiguous: before.ambiguous,
      policy: policyOf(before),
      emoji: emojiOf(before),
    };
    const diff: ComboDiff = { key, channels, before, after };
    if (isDcPolicy(policyOf(before))) {
      // D-C: the code-content analogue is the echo/fence-stripped/prefix/vocabulary channels;
      // a diff in textSha/codeContentSha alone is highlighter SGR and is allowed.
      if (channels.some((channel) => DC_CODE_CHANNELS.includes(channel))) {
        classC.push(diff);
        continue;
      }
      if (channels.every((channel) => channel === "textSha" || channel === "codeContentSha")) {
        allowedDC.push(diff);
        continue;
      }
    } else if (channels.includes("codeContentSha")) {
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

  const nonvacuity = {
    before: sumNonvacuity(pairs.map((pair) => pair.before)),
    after: sumNonvacuity(pairs.map((pair) => pair.after)),
  };
  const nonvacuityFailures = nonvacuityFailuresFor(nonvacuity, options.requireNonzero ?? []);

  const ok =
    nonvacuityFailures.length === 0 &&
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
    allowedDC,
    overflowRegressions,
    detectorRegressions,
    emptyComparison,
    nonvacuity,
    nonvacuityFailures,
    ok,
  };
}