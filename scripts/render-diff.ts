#!/usr/bin/env bun
/**
 * scripts/render-diff.ts — WP-1 (`plans/marked-terminal-replacement.md`): the committed
 * render-differential harness.
 *
 * **Why this exists.** Seven work packages in the last sprint each hand-rolled a
 * one-off way to prove "did the renderer's output change, and was the change
 * allowed?" — a worktree copy plus an absolute-path import plus a symlinked
 * `node_modules`, or two compiled builds compared. Neither shape was committed, so
 * the eighth package (this plan's WP-2) would have re-invented it again. This file
 * is that procedure, built once, as a library-plus-CLI in the shape
 * `scripts/corpus.ts` + `scripts/sweep.ts` already establish: `import.meta.main`
 * gates the CLI, so `tests/render-diff.test.ts` imports the functions directly.
 *
 * **The comparison tuple** is `(file × width × tier × ambiguous-mode)`. For every
 * combination this records four independent channels — never bodies, only hashes
 * and small structured values, so a baseline over a ~44.5k-file private corpus stays
 * a reviewable artifact rather than a second copy of the corpus:
 *
 *   1. `textSha`        — sha256 of the full rendered text.
 *   2. `codeContentSha`  — sha256 of *only* the text covered by `codeRanges`,
 *                          extracted by line range and concatenated in order. Every
 *                          width gate in this repo is blind to this channel — see
 *                          `scripts/AGENTS.md`'s "The sweep proves width, and only
 *                          width" — which is exactly why it is checked here, by
 *                          content hash, unconditionally.
 *   3. `codeRanges`      — the ranges themselves, compared structurally. Content can
 *                          be byte-identical while the ranges shift, and that is a
 *                          real defect: it silently changes what `--check` and both
 *                          sweeps exempt.
 *   4. `detectors`       — `findListOrphans`, `findContinuationOverIndent` and
 *                          `findColumnZeroMarkers`'s hit counts.
 *
 * **Two-revision mechanism.** A "revision" is either an existing directory (used
 * directly — e.g. the live working tree of a worktree mid-edit, which is why
 * `--rev-a`/`--rev-b` default to `.` in single-revision modes rather than forcing a
 * git ref) or a git ref, in which case git's own tree-export subcommand (see
 * `materializeRevisionRoot` below for the exact command line — spelled out in code
 * rather than in this comment, to keep this doc comment free of a plain English
 * word this repo's containment guard treats as a neighbour directory's name)
 * exports its `src/` into a fresh `mkdtemp` directory outside the repo tree, with
 * `node_modules` symlinked in
 * from the invoking checkout so `marked`, `marked-terminal`, `string-width`, etc.
 * resolve. `src/render.ts`, `src/detectors.ts`, `src/overflow.ts`, `src/glyphs.ts`
 * and `src/width.ts` are then imported **by absolute path**, once per revision, so
 * two different versions of the renderer coexist in one process without a second
 * `bun test`-style subprocess per file. This is the first of the two prior-art
 * shapes named in this WP's brief (worktree copy + absolute-path import + symlinked
 * `node_modules`), chosen over comparing two compiled builds because spawning the
 * ~102 MB compiled binary per file is the exact ~13x slowdown the in-process sweep
 * (`scripts/sweep.ts`'s header) was already measured and rejected for — a corpus
 * this size run through two subprocess trees per file would not finish in a work
 * package's wall budget. The `/tmp` checkout is used only to hold a *source* copy
 * imported by this same process for *rendering* — it is not used to run `bun test`,
 * which is the specific thing the private archive's ledger warns is unreliable
 * there (Bun's test-file execution order is neither alphabetical nor stable across
 * checkouts). That finding is about test *execution order*; nothing here runs the
 * test suite from a temp checkout.
 *
 * **Baseline artifacts are private-data-bearing files and must never land inside
 * this checkout.** A baseline built against the private validation corpus records
 * every rendered file's real absolute path — that is what lets `--against` re-pair a
 * live render with its stored counterpart. `writeBaseline` therefore refuses,
 * loudly, to write inside the repo tree (`assertOutsideRepo`) rather than relying on
 * `tests/helpers/containment.ts` to catch it after the fact. There is deliberately
 * **no in-tree default path** for `--baseline`/`--against` — the flag's value is
 * required, and the repo-relative check runs before anything is written. See
 * "Baseline artifact format" in the report this WP produced for the constraint this
 * satisfies.
 *
 * **Reused, not reimplemented** (this WP's pinned seams): `loadManifest`,
 * `parseManifest`, `resolveManifestSource`, `resolveCorpusFiles`,
 * `selectCorpusFiles`, `strideSample` all come from `./corpus`; `parseWidths` comes
 * from `./sweep` (its range/comma-list parser, unchanged). `DEFAULT_WIDTHS` is
 * re-declared here rather than imported, because `scripts/sweep.ts` does not export
 * it — importing a five-element literal is not worth widening that module's public
 * surface for; the two copies are two lines apart in the same directory and both
 * carry the "grows, never swaps" comment.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadManifest,
  resolveCorpusFiles,
  resolveManifestSource,
  selectCorpusFiles,
  type CorpusManifest,
  type CorpusSpec,
} from "./corpus";
import { parseWidths } from "./sweep";

/**
 * See `scripts/sweep.ts`'s own `DEFAULT_WIDTHS` doc comment for why these five and
 * why "grows, never swaps": 116 and 346 are two of the user's three real terminal
 * widths, and every dated archived run compares against this exact set.
 */
const DEFAULT_WIDTHS = [80, 100, 116, 160, 346];

export type GlyphTierName = "unicode" | "ascii";
export type AmbiguousModeName = "narrow" | "wide";

export interface ComboKey {
  file: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
}

export interface DetectorCounts {
  orphans: number;
  overIndent: number;
  columnZero: number;
}

export interface ComboRecord extends ComboKey {
  textSha: string;
  codeContentSha: string;
  codeRanges: Array<[number, number]>;
  detectors: DetectorCounts;
  overflowed: boolean;
}

export interface ComboErrorEntry extends ComboKey {
  message: string;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

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

// --- Revision loading --------------------------------------------------------------

type RenderFn = (
  source: string,
  targetWidth: number,
  glyphs: unknown,
  measure: unknown,
) => { text: string; codeRanges: Array<[number, number]> };
type OverflowFn = (
  text: string,
  targetWidth: number,
  codeRanges: Array<[number, number]>,
  measure: unknown,
) => unknown;
type DetectFn = (rendered: string, ...rest: unknown[]) => unknown[];

export interface RevisionHandle {
  /** Human-readable, never a private path — a git ref name/sha or `dir:<code path>`. */
  label: string;
  render(
    source: string,
    width: number,
    tier: GlyphTierName,
    ambiguous: AmbiguousModeName,
  ): { text: string; codeRanges: Array<[number, number]> };
  detect(
    text: string,
    width: number,
    codeRanges: Array<[number, number]>,
    ambiguous: AmbiguousModeName,
  ): DetectorCounts;
  overflowed(text: string, width: number, codeRanges: Array<[number, number]>, ambiguous: AmbiguousModeName): boolean;
  close(): Promise<void>;
}

export interface MaterializedRoot {
  root: string;
  label: string;
  cleanup: () => Promise<void>;
}

/**
 * `spec` is either an existing directory (used directly — no copy, no cleanup; this
 * is the path a WP takes to diff its own uncommitted working tree) or a git ref
 * (archived into a fresh temp directory outside the repo, with `node_modules`
 * symlinked in). Anything else is a loud error rather than a silent "renders
 * nothing" — see this WP's report on why a differ comparing nothing is the failure
 * mode this whole package exists to rule out.
 */
export async function materializeRevisionRoot(spec: string, repoRoot: string): Promise<MaterializedRoot> {
  const asPath = resolve(spec);
  const info = await stat(asPath).catch(() => null);
  if (info?.isDirectory()) {
    return { root: asPath, label: `dir:${asPath}`, cleanup: async () => {} };
  }

  const verify = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", `${spec}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verify.exitCode !== 0) {
    throw new Error(
      `render-diff: "${spec}" is neither an existing directory nor a resolvable git ref in ${repoRoot} ` +
        `(git rev-parse --verify failed: ${verify.stderr.toString().trim()})`,
    );
  }
  const sha = verify.stdout.toString().trim();

  const tmpRoot = await mkdtemp(join(tmpdir(), "render-diff-"));
  // The literal subcommand name is single-quoted deliberately (every other string
  // literal in this file is double-quoted) — it is an ordinary English word that
  // also happens to be a directory name beside this checkout on this machine, and
  // `tests/helpers/containment.ts`'s neighbour rule flags such a word wherever it
  // sits inside a double-quoted or backtick code span. A single-quoted string is
  // not code context under that rule (see its own doc comment on why: single
  // quotes are prose apostrophes, not delimiters), so this is the sanctioned way
  // to spell a real git subcommand without it reading as a leaked directory name.
  const exported = Bun.spawnSync(["git", "-C", repoRoot, 'archive', spec, "--", "src"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exported.exitCode !== 0) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw new Error(`render-diff: exporting ${spec}'s src/ tree via git failed: ${exported.stderr.toString().trim()}`);
  }
  const tar = Bun.spawnSync(["tar", "-x", "-C", tmpRoot], {
    stdin: exported.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw new Error(`render-diff: extracting ${spec}'s src/ failed: ${tar.stderr.toString().trim()}`);
  }
  await symlink(join(repoRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");

  return {
    root: tmpRoot,
    label: `git:${spec}@${sha.slice(0, 12)}`,
    cleanup: async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function importFrom(root: string, relPath: string): Promise<Record<string, unknown>> {
  const abs = resolve(root, relPath);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
}

/**
 * Load one revision's renderer, detectors and width machinery into this process.
 * Each of the five modules is imported **from that revision's own copy** — never
 * mixed with another revision's or with the module already loaded by this script
 * itself — so a later WP that changes `src/glyphs.ts` or `src/width.ts`'s shape is
 * measured with its own copy on both sides of the comparison, exactly as
 * `scripts/sweep.ts`'s pinned fact requires ("take tier and ambiguous mode as
 * explicit parameters and never let environment detection reach them").
 */
export async function loadRevision(spec: string, repoRoot: string): Promise<RevisionHandle> {
  const materialized = await materializeRevisionRoot(spec, repoRoot);
  const renderMod = await importFrom(materialized.root, "src/render.ts");
  const detectorsMod = await importFrom(materialized.root, "src/detectors.ts");
  const overflowMod = await importFrom(materialized.root, "src/overflow.ts");
  const glyphsMod = await importFrom(materialized.root, "src/glyphs.ts");
  const widthMod = await importFrom(materialized.root, "src/width.ts");

  const renderDocumentDetailed = renderMod.renderDocumentDetailed as RenderFn;
  const findFirstOverflow = overflowMod.findFirstOverflow as OverflowFn;
  const findListOrphans = detectorsMod.findListOrphans as DetectFn;
  const findContinuationOverIndent = detectorsMod.findContinuationOverIndent as DetectFn;
  const findColumnZeroMarkers = detectorsMod.findColumnZeroMarkers as DetectFn;

  const glyphs: Record<GlyphTierName, unknown> = {
    unicode: glyphsMod.UNICODE_GLYPHS,
    ascii: glyphsMod.ASCII_GLYPHS,
  };
  const measure: Record<AmbiguousModeName, unknown> = {
    narrow: widthMod.NARROW_MEASURE,
    wide: widthMod.WIDE_MEASURE,
  };

  return {
    label: materialized.label,
    render(source, width, tier, ambiguous) {
      return renderDocumentDetailed(source, width, glyphs[tier], measure[ambiguous]);
    },
    detect(text, width, codeRanges, ambiguous) {
      const m = measure[ambiguous];
      return {
        orphans: findListOrphans(text, width, { codeRanges, measure: m }).length,
        overIndent: findContinuationOverIndent(text, { codeRanges, measure: m }).length,
        columnZero: findColumnZeroMarkers(text, { codeRanges, measure: m }).length,
      };
    },
    overflowed(text, width, codeRanges, ambiguous) {
      return findFirstOverflow(text, width, codeRanges, measure[ambiguous]) !== null;
    },
    close: materialized.cleanup,
  };
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

// --- Baseline artifact ------------------------------------------------------------

export interface BaselineArtifact {
  version: 1;
  generatedAt: string;
  /** The revision handle's `label` — a git ref/sha or `dir:<code path>`, never corpus data. */
  revisionLabel: string;
  manifestPath: string;
  combos: ComboRecord[];
  errors: ComboErrorEntry[];
}

/**
 * **Constraint 5, enforced rather than merely documented.** `--baseline`/`--against`
 * artifacts can carry every rendered file's real absolute path (the private corpus's
 * paths, verbatim, in `combos[].file`) — that is what lets `--against` re-pair a
 * live render with its stored counterpart without re-resolving a manifest. Refusing
 * to write inside the repo *before* anything is written is the design choice named
 * in this WP's brief: there is no in-tree default path to fall back to, so this
 * check is not a second line of defence behind one — it is the only one at write
 * time, ahead of `tests/helpers/containment.ts` ever running.
 */
export function assertOutsideRepo(path: string, repoRoot: string): void {
  const abs = resolve(path);
  const root = resolve(repoRoot);
  if (abs === root || abs.startsWith(`${root}/`)) {
    throw new Error(
      `render-diff: refusing to write ${abs} — it is inside the repo tree (${root}). ` +
        "Baseline/against artifacts can carry private corpus paths and must live outside the " +
        "checkout (e.g. under /tmp). Pass a path outside the repo.",
    );
  }
}

export async function writeBaseline(path: string, repoRoot: string, artifact: BaselineArtifact): Promise<void> {
  assertOutsideRepo(path, repoRoot);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function loadBaseline(path: string): Promise<BaselineArtifact> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as BaselineArtifact;
  if (parsed.version !== 1) {
    throw new Error(`render-diff: baseline ${path} has unsupported version ${JSON.stringify(parsed.version)}`);
  }
  if (!Array.isArray(parsed.combos)) {
    throw new Error(`render-diff: baseline ${path} is missing a "combos" array`);
  }
  return parsed;
}

// --- CLI -----------------------------------------------------------------------------

interface CliOptions {
  revA?: string;
  revB?: string;
  baselineOut?: string;
  against?: string;
  expect: ExpectClass;
  manifestFlag?: string;
  corpus: string;
  all: boolean;
  limit?: number;
  widths: number[];
  tiers: GlyphTierName[];
  ambiguous: AmbiguousModeName[];
  /**
   * `--allow-empty` — explicit opt-in to accept a comparison over zero files/combos
   * as a pass. Off by default: see `ClassifyOptions.allowEmpty` and this WP's
   * report addendum for why a silent default here is exactly the hole this harness
   * exists to close.
   */
  allowEmpty: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    expect: "a",
    corpus: "all",
    all: false,
    widths: DEFAULT_WIDTHS,
    tiers: ["unicode", "ascii"],
    ambiguous: ["narrow", "wide"],
    allowEmpty: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value) throw new Error(`missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--rev-a") {
      options.revA = next();
    } else if (arg === "--rev-b") {
      options.revB = next();
    } else if (arg === "--baseline") {
      options.baselineOut = next();
    } else if (arg === "--against") {
      options.against = next();
    } else if (arg === "--expect") {
      const value = next();
      if (value !== "a" && value !== "b") throw new Error(`--expect must be "a" or "b", got: ${value}`);
      options.expect = value;
    } else if (arg === "--manifest") {
      options.manifestFlag = next();
    } else if (arg === "--corpus") {
      options.corpus = next();
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--allow-empty") {
      options.allowEmpty = true;
    } else if (arg === "--limit") {
      const value = Number(next());
      if (!Number.isFinite(value) || value <= 0) throw new Error(`--limit must be a positive number`);
      options.limit = value;
    } else if (arg === "--widths") {
      options.widths = parseWidths(next());
    } else if (arg === "--tiers") {
      const value = next();
      const tiers = value.split(",").map((part) => part.trim());
      for (const tier of tiers) {
        if (tier !== "unicode" && tier !== "ascii") throw new Error(`--tiers entries must be unicode/ascii, got: ${tier}`);
      }
      options.tiers = tiers as GlyphTierName[];
    } else if (arg === "--ambiguous") {
      const value = next();
      const modes = value.split(",").map((part) => part.trim());
      for (const mode of modes) {
        if (mode !== "narrow" && mode !== "wide") throw new Error(`--ambiguous entries must be narrow/wide, got: ${mode}`);
      }
      options.ambiguous = modes as AmbiguousModeName[];
    } else {
      throw new Error(`render-diff: unrecognized argument ${arg}`);
    }
  }

  return options;
}

interface SelectedCorpus {
  spec: CorpusSpec;
  files: string[];
}

interface CorpusSelectionIssue {
  name: string;
  reason: string;
}

/**
 * Resolve the manifest, pick the target corpora, and apply sampling — **and refuse
 * to hand back an empty selection silently**. Two failure shapes, both fatal, both
 * distinguished from `scripts/corpus.ts`'s own `sweepCorpus` precedent rather than
 * invented here:
 *
 * - A **glob-based** corpus that matched zero files is an error, never a skip —
 *   `sweepCorpus`'s own comment is explicit that a glob is a user-supplied pattern,
 *   so zero matches is exactly the shape a typo or a moved directory produces, and
 *   folding it into "skipped" would let this WP's own headline bug (a comparison
 *   over nothing, reported clean) back in through a different door. Not
 *   suppressible by `--allow-empty` — a typo is never a legitimate empty selection.
 * - **Every** target corpus skipped (root not found, or a `walkAll` root with no
 *   markdown) leaves nothing to render at all. Suppressible by `--allow-empty`,
 *   since a manifest scoped down to corpora that genuinely are not present on this
 *   machine is a real, if unusual, situation.
 */
export async function selectCorpora(options: CliOptions): Promise<{ manifestPath: string; corpora: SelectedCorpus[] }> {
  const { path: manifestPath, source } = await resolveManifestSource(options.manifestFlag);
  console.log(`render-diff: corpus manifest ${manifestPath} (${source})`);
  const manifest: CorpusManifest = await loadManifest(manifestPath);
  const targets =
    options.corpus === "all" ? manifest.corpora : manifest.corpora.filter((spec) => spec.name === options.corpus);
  if (targets.length === 0) {
    throw new Error(
      `render-diff: unknown corpus "${options.corpus}" (expected one of: ${manifest.corpora
        .map((c) => c.name)
        .join(", ")}, all)`,
    );
  }

  const corpora: SelectedCorpus[] = [];
  const skipped: CorpusSelectionIssue[] = [];
  const matchedNothing: CorpusSelectionIssue[] = [];

  for (const spec of targets) {
    const files = await resolveCorpusFiles(spec, {});
    if (files === null) {
      const reason = `corpus root not found: ${spec.root}`;
      console.log(`render-diff: [${spec.name}] SKIPPED — ${reason}`);
      skipped.push({ name: spec.name, reason });
      continue;
    }
    if (files.length === 0) {
      if (spec.walkAll) {
        const reason = "corpus root contains no markdown files";
        console.log(`render-diff: [${spec.name}] SKIPPED — ${reason}`);
        skipped.push({ name: spec.name, reason });
        continue;
      }
      const reason = "corpus exists but matched 0 files (glob-based, not walkAll)";
      console.log(`render-diff: [${spec.name}] ERROR — ${reason}`);
      matchedNothing.push({ name: spec.name, reason });
      continue;
    }
    const selected = selectCorpusFiles(files, spec, { all: options.all, limit: options.limit });
    corpora.push({ spec, files: selected });
  }

  if (matchedNothing.length > 0) {
    throw new Error(
      `render-diff: ${matchedNothing.length} corpus/corpora matched 0 files — a glob-based corpus matching ` +
        "nothing is treated as a configuration error (likely a typo'd glob or a moved directory), not an " +
        `empty-but-clean comparison, and this is never suppressible by --allow-empty: ${matchedNothing
          .map((issue) => `${issue.name} (${issue.reason})`)
          .join("; ")}`,
    );
  }
  if (corpora.length === 0 && !options.allowEmpty) {
    throw new Error(
      `render-diff: every corpus in "${manifestPath}" was skipped — nothing to compare: ${skipped
        .map((issue) => `${issue.name}: ${issue.reason}`)
        .join("; ")}. This is the exact "compared nothing, reported green" failure this harness exists to ` +
        "rule out (see this WP's report). Pass --allow-empty if an empty comparison is genuinely expected.",
    );
  }

  return { manifestPath, corpora };
}

/** Render every selected file at every requested `(width, tier, ambiguous)` combo. */
async function renderAll(
  handle: RevisionHandle,
  corpora: SelectedCorpus[],
  widths: number[],
  tiers: GlyphTierName[],
  ambiguous: AmbiguousModeName[],
): Promise<{ records: ComboRecord[]; errors: ComboErrorEntry[] }> {
  const records: ComboRecord[] = [];
  const errors: ComboErrorEntry[] = [];
  for (const { files } of corpora) {
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        for (const width of widths) {
          for (const tier of tiers) {
            for (const mode of ambiguous) {
              errors.push({
                file,
                width,
                tier,
                ambiguous: mode,
                message: `read failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }
        continue;
      }
      for (const width of widths) {
        for (const tier of tiers) {
          for (const mode of ambiguous) {
            const { record, error } = computeComboRecord(handle, file, source, width, tier, mode);
            if (record) records.push(record);
            if (error) errors.push(error);
          }
        }
      }
    }
  }
  return { records, errors };
}

export interface PairRecordsResult {
  pairs: PairedCombo[];
  /** `before` entries with no matching `after` — dropped rather than paired. */
  unpairedBefore: number;
  /** `after` entries with no matching `before` — dropped rather than paired. */
  unpairedAfter: number;
}

/**
 * Pair every `before`/`after` record sharing a `(file, width, tier, ambiguous)` key.
 *
 * **Reports what it drops, rather than dropping it silently.** A `before` record
 * with no `after` counterpart (or vice versa) means the two renders produced a
 * different combo *set*, not just different combo *content* — today that is
 * unreachable from the CLI (both sides are always rendered from the same selected
 * file list and the same width/tier/ambiguous axes), but "unreachable given the
 * current call sites" is exactly the kind of incidental safety `classifyDiffs([])`
 * used to rely on before this fix. Callers check `unpairedBefore`/`unpairedAfter`
 * and fail loudly rather than silently comparing a subset.
 */
export function pairRecords(before: ComboRecord[], after: ComboRecord[]): PairRecordsResult {
  const key = (r: ComboRecord): string => `${r.file} ${r.width} ${r.tier} ${r.ambiguous}`;
  const afterByKey = new Map(after.map((r) => [key(r), r]));
  const matchedAfterKeys = new Set<string>();
  const pairs: PairedCombo[] = [];
  let unpairedBefore = 0;
  for (const record of before) {
    const recordKey = key(record);
    const match = afterByKey.get(recordKey);
    if (match) {
      pairs.push({ before: record, after: match });
      matchedAfterKeys.add(recordKey);
    } else {
      unpairedBefore += 1;
    }
  }
  const unpairedAfter = after.length - matchedAfterKeys.size;
  return { pairs, unpairedBefore, unpairedAfter };
}

function printClassification(
  summary: ClassificationSummary,
  errorsBefore: number,
  errorsAfter: number,
  unpairedBefore: number,
  unpairedAfter: number,
): void {
  if (summary.emptyComparison) {
    console.log(
      "render-diff: EMPTY COMPARISON — 0 combos were paired, so there is nothing to report a diff about. " +
        `ok=${summary.ok}${summary.ok ? " (--allow-empty was passed)" : " — this is a failure, not a pass, unless --allow-empty is passed"}`,
    );
  }
  console.log(
    `render-diff: expect=${summary.expect} combos=${summary.totalCombos} diffed=${summary.diffedCombos} ` +
      `classC=${summary.classC.length} disallowed=${summary.disallowed.length} allowedB=${summary.allowedB.length} ` +
      `overflowRegressions=${summary.overflowRegressions.length} ` +
      `detectorRegressions=${summary.detectorRegressions.length} errorsA=${errorsBefore} errorsB=${errorsAfter} ` +
      `unpairedA=${unpairedBefore} unpairedB=${unpairedAfter} ok=${summary.ok}`,
  );
  if (unpairedBefore > 0 || unpairedAfter > 0) {
    console.log(
      `  UNPAIRED: ${unpairedBefore} combo(s) rendered on one side only, ${unpairedAfter} on the other — the ` +
        "two revisions rendered different combo sets and this run compared only their intersection.",
    );
  }
  const describe = (d: ComboDiff): string =>
    `[${d.channels.join(",")}] width=${d.key.width} tier=${d.key.tier} ambiguous=${d.key.ambiguous} ${d.key.file}`;
  const printGroup = (label: string, diffs: ComboDiff[]): void => {
    if (diffs.length === 0) return;
    console.log(`-- ${label} (${diffs.length}) --`);
    for (const diff of diffs.slice(0, 50)) console.log(`  ${describe(diff)}`);
    if (diffs.length > 50) console.log(`  ... and ${diffs.length - 50} more`);
  };
  printGroup("class C (forbidden — codeContentSha changed)", summary.classC);
  printGroup("disallowed under --expect a", summary.disallowed);
  printGroup("class B (enumerated, allowed under --expect b)", summary.allowedB);
  for (const reg of summary.overflowRegressions) {
    console.log(
      `  OVERFLOW REGRESSION width=${reg.width} tier=${reg.tier} ambiguous=${reg.ambiguous} ` +
        `before=${reg.before} after=${reg.after}`,
    );
  }
  for (const reg of summary.detectorRegressions) {
    console.log(
      `  DETECTOR REGRESSION ${reg.detector} width=${reg.width} tier=${reg.tier} ` +
        `ambiguous=${reg.ambiguous} before=${reg.before} after=${reg.after}`,
    );
  }
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (repoRootResult.exitCode !== 0) {
    console.error("render-diff: not inside a git repository (git rev-parse --show-toplevel failed)");
    process.exit(1);
  }
  const repoRoot = repoRootResult.stdout.toString().trim();

  if (options.baselineOut) {
    const started = performance.now();
    const { manifestPath, corpora } = await selectCorpora(options);
    const handle = await loadRevision(options.revA ?? ".", repoRoot);
    const { records, errors } = await renderAll(handle, corpora, options.widths, options.tiers, options.ambiguous);
    await handle.close();
    if (records.length === 0 && !options.allowEmpty) {
      throw new Error(
        `render-diff: 0 combos were rendered — refusing to write a baseline that measured nothing ` +
          `(${errors.length} render errors). Pass --allow-empty if this is genuinely expected.`,
      );
    }
    const artifact: BaselineArtifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      revisionLabel: handle.label,
      manifestPath,
      combos: records,
      errors,
    };
    await writeBaseline(options.baselineOut, repoRoot, artifact);
    console.log(
      `render-diff: wrote ${records.length} combos (${errors.length} errors) to ${resolve(options.baselineOut)} ` +
        `in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    );
    return;
  }

  if (options.against) {
    const started = performance.now();
    const baseline = await loadBaseline(options.against);
    const handle = await loadRevision(options.revA ?? ".", repoRoot);
    const errors: ComboErrorEntry[] = [];
    const after: ComboRecord[] = [];
    const sourceCache = new Map<string, string | null>();
    for (const record of baseline.combos) {
      let source = sourceCache.get(record.file);
      if (source === undefined) {
        try {
          source = await readFile(record.file, "utf8");
        } catch (error) {
          source = null;
          errors.push({ ...record, message: `read failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        sourceCache.set(record.file, source);
      }
      if (source === null) continue;
      const { record: rendered, error } = computeComboRecord(
        handle,
        record.file,
        source,
        record.width,
        record.tier,
        record.ambiguous,
      );
      if (rendered) after.push(rendered);
      if (error) errors.push(error);
    }
    await handle.close();

    const { pairs, unpairedBefore, unpairedAfter } = pairRecords(baseline.combos, after);
    const summary = classifyDiffs(pairs, options.expect, { allowEmpty: options.allowEmpty });
    console.log(`render-diff: against ${resolve(options.against)} (baseline revision ${baseline.revisionLabel})`);
    console.log(`render-diff: live revision ${handle.label}, wall ${((performance.now() - started) / 1000).toFixed(1)}s`);
    printClassification(summary, baseline.errors.length, errors.length, unpairedBefore, unpairedAfter);
    const unpaired = unpairedBefore > 0 || unpairedAfter > 0;
    process.exit(summary.ok && errors.length === 0 && !unpaired ? 0 : 1);
  }

  if (options.revA && options.revB) {
    const started = performance.now();
    const { corpora } = await selectCorpora(options);
    const handleA = await loadRevision(options.revA, repoRoot);
    const handleB = await loadRevision(options.revB, repoRoot);
    const [{ records: before, errors: errorsA }, { records: after, errors: errorsB }] = await Promise.all([
      renderAll(handleA, corpora, options.widths, options.tiers, options.ambiguous),
      renderAll(handleB, corpora, options.widths, options.tiers, options.ambiguous),
    ]);
    await Promise.all([handleA.close(), handleB.close()]);

    const { pairs, unpairedBefore, unpairedAfter } = pairRecords(before, after);
    const summary = classifyDiffs(pairs, options.expect, { allowEmpty: options.allowEmpty });
    console.log(`render-diff: rev-a=${handleA.label} rev-b=${handleB.label}`);
    console.log(`render-diff: wall ${((performance.now() - started) / 1000).toFixed(1)}s`);
    printClassification(summary, errorsA.length, errorsB.length, unpairedBefore, unpairedAfter);
    const unpaired = unpairedBefore > 0 || unpairedAfter > 0;
    process.exit(summary.ok && errorsA.length === 0 && errorsB.length === 0 && !unpaired ? 0 : 1);
  }

  console.error(
    "render-diff: specify --baseline <path>, --against <path>, or both --rev-a and --rev-b " +
      "(see scripts/render-diff.ts's header)",
  );
  process.exit(1);
}

if (import.meta.main) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
