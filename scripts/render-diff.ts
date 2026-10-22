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
 * resolve. `TS_BASELINE` `src/render.ts`, `src/detectors.ts`, `src/overflow.ts`, `src/glyphs.ts`
 * and `TS_BASELINE` `src/width.ts` are then imported **by absolute path**, once per revision, so
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
 * `selectCorpusFiles`, `strideSample` all come from `./corpus`; `DEFAULT_WIDTHS` and
 * `parseWidths` (its range/comma-list parser, unchanged) come from `./sweep-options`.
 *
 * **This file is the CLI only, since WP-R1** (`plans/post-refactor-code-quality-remediation.md`).
 * It kept its flags, its corpus selection, its baseline I/O, its pairing, its printed
 * summary and its exit codes; three things left, each to a module this one imports
 * downward and none of which imports it back:
 *
 *   - `./revision` — `materializeRevisionRoot`, `loadRevision`, and the comparison tuple's
 *     own vocabulary (`GlyphTierName`, `AmbiguousModeName`, `ComboKey`, `DetectorCounts`,
 *     `ComboRecord`, `ComboErrorEntry`).
 *   - `./diff-classify` — `computeComboRecord`, `diffCombo`, `classifyDiffs` and the
 *     summary shapes: the pure half, which reads no process, file, argument or clock.
 *   - `./hash` — `sha256Hex`.
 *
 * That last move is the one with a reason beyond file size. `sha256Hex` lived here, and
 * `scripts/corpus.ts` imported it *from this CLI*, while this CLI imported `parseWidths`
 * from `scripts/sweep.ts`, which imported `scripts/corpus.ts`: a three-node cycle. Two
 * neutral leaves (`./hash`, `./sweep-options`) hold those two symbols now.
 * `tests/scripts-acyclic.test.ts` is the gate that keeps the graph a DAG.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  loadManifest,
  resolveCorpusFiles,
  resolveManifestSource,
  selectCorpusFiles,
  type CorpusManifest,
  type CorpusSpec,
} from "./corpus";
import {
  NONVACUITY_COUNTERS,
  classifyDiffs,
  computeComboRecord,
  fencePrefixesOk,
  sumNonvacuity,
  type ClassificationSummary,
  type ComboDiff,
  type ComboResult,
  type ExpectClass,
  type NonvacuityCounter,
  type NonvacuityCounters,
  type PairedCombo,
} from "./diff-classify";
import {
  EMOJI_AXES,
  POLICY_NAMES,
  emojiOf,
  loadMeasurer,
  loadRevision,
  policyOf,
  type AmbiguousModeName,
  type ComboErrorEntry,
  type ComboRecord,
  type EmojiAxis,
  type GlyphTierName,
  type Measurer,
  type PolicyName,
  type RevisionHandle,
} from "./revision";
import { DEFAULT_WIDTHS, parseWidths } from "./sweep-options";

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
  /** `--policy P0,P1,...` (default `P0`) — WP-1 of `plans/mdview-rust-port.md`. */
  policies: PolicyName[];
  /** `--emoji default,on,off` (default `default`). */
  emojis: EmojiAxis[];
  /** `--shard i/n` (1-based): keep selected file index `k` iff `k % n === i - 1`. */
  shard?: { index: number; count: number };
  /** `--require-free list,table`: skip files whose `lexBody` tokens contain these types. */
  requireFree: string[];
  /** `--require-nonzero sgr,osc8,dcs,fences`. */
  requireNonzero: NonvacuityCounter[];
}

function parseList<T extends string>(flag: string, value: string, allowed: readonly T[]): T[] {
  const parts = value.split(",").map((part) => part.trim());
  for (const part of parts) {
    if (!allowed.includes(part as T)) throw new Error(`${flag} entries must be ${allowed.join("/")}, got: ${part}`);
  }
  return parts as T[];
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
    policies: ["P0"],
    emojis: ["default"],
    requireFree: [],
    requireNonzero: [],
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
    } else if (arg === "--policy") {
      options.policies = parseList("--policy", next(), POLICY_NAMES);
    } else if (arg === "--emoji") {
      options.emojis = parseList("--emoji", next(), EMOJI_AXES);
    } else if (arg === "--shard") {
      const value = next();
      const match = /^(\d+)\/(\d+)$/.exec(value);
      const shardIndex = match ? Number(match[1]) : NaN;
      const shardCount = match ? Number(match[2]) : NaN;
      if (!match || shardCount < 1 || shardIndex < 1 || shardIndex > shardCount) {
        throw new Error(`--shard must be i/n with 1 <= i <= n, got: ${value}`);
      }
      options.shard = { index: shardIndex, count: shardCount };
    } else if (arg === "--require-free") {
      options.requireFree = next()
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");
    } else if (arg === "--require-nonzero") {
      options.requireNonzero = parseList("--require-nonzero", next(), NONVACUITY_COUNTERS);
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

  const deduped = dedupeCorpora(corpora);
  if (deduped.dropped > 0) {
    console.log(`render-diff: ${deduped.dropped} file(s) listed by more than one corpus — compared once, under the first`);
  }
  return { manifestPath, corpora: deduped.corpora };
}

/**
 * Drop a file a later corpus lists again (by real path), keeping its first appearance. A manifest
 * that names one file under two corpora would otherwise render it twice under one key, and
 * `pairRecords`' map would report the duplicates as unpaired (2026-10-12: 8 T1 files sit in both
 * `durable` and `spike-sample`).
 */
export function dedupeCorpora(
  corpora: SelectedCorpus[],
  real: (path: string) => string = (path) => realpathSync(path),
): { corpora: SelectedCorpus[]; dropped: number } {
  const seen = new Set<string>();
  let dropped = 0;
  const out = corpora.map(({ spec, files }) => ({
    spec,
    files: files.filter((file) => {
      const key = real(file);
      if (seen.has(key)) {
        dropped += 1;
        return false;
      }
      seen.add(key);
      return true;
    }),
  }));
  return { corpora: out, dropped };
}

/** Keep the selected files whose global index `k` (across corpora, in order) has `k % n === i - 1`. */
export function applyShard(corpora: SelectedCorpus[], shard: { index: number; count: number } | undefined): SelectedCorpus[] {
  if (shard === undefined) return corpora;
  let k = 0;
  return corpora.map(({ spec, files }) => ({
    spec,
    files: files.filter(() => {
      const keep = k % shard.count === shard.index - 1;
      k += 1;
      return keep;
    }),
  }));
}

/** Whether a (raw or census) token tree contains a token of one of `types`, at any depth. */
export function tokensContainType(tokens: unknown, types: ReadonlySet<string>): boolean {
  if (types.size === 0 || tokens === null || typeof tokens !== "object") return false;
  if (Array.isArray(tokens)) return tokens.some((token) => tokensContainType(token, types));
  const record = tokens as Record<string, unknown>;
  if (typeof record.type === "string" && types.has(record.type)) return true;
  for (const [key, value] of Object.entries(record)) {
    if (key === "raw" || key === "text") continue;
    if (value !== null && typeof value === "object" && tokensContainType(value, types)) return true;
  }
  return false;
}

/** The combo axes one run renders, every file at every combination. */
export interface RenderAxes {
  widths: number[];
  tiers: GlyphTierName[];
  ambiguous: AmbiguousModeName[];
  policies: PolicyName[];
  emojis: EmojiAxis[];
}

interface ComboSpec {
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  policy: PolicyName;
  emoji: EmojiAxis;
}

function combosOf(axes: RenderAxes): ComboSpec[] {
  const combos: ComboSpec[] = [];
  for (const width of axes.widths) {
    for (const tier of axes.tiers) {
      for (const ambiguous of axes.ambiguous) {
        for (const policy of axes.policies) {
          for (const emoji of axes.emojis) combos.push({ width, tier, ambiguous, policy, emoji });
        }
      }
    }
  }
  return combos;
}

interface FileVisit {
  file: string;
  source: string;
}

/**
 * Walk every selected file once: read it (a read failure becomes one error per combo, on every
 * side named in `sides`), apply `--require-free`, and hand the visit to `onFile`.
 */
async function visitFiles(
  corpora: SelectedCorpus[],
  axes: RenderAxes,
  measurer: Measurer,
  options: { requireFree: string[] },
  readErrors: ComboErrorEntry[][],
  onFile: (visit: FileVisit) => Promise<void>,
): Promise<{ skippedRequireFree: number }> {
  const freeTypes = new Set(options.requireFree);
  let skippedRequireFree = 0;
  for (const { files } of corpora) {
    for (const file of files) {
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        const message = `read failed: ${error instanceof Error ? error.message : String(error)}`;
        for (const combo of combosOf(axes)) {
          for (const errors of readErrors) errors.push({ file, ...combo, message });
        }
        continue;
      }
      if (freeTypes.size > 0 && axes.tiers.some((tier) => tokensContainType(measurer.lexBody(source, tier), freeTypes))) {
        skippedRequireFree += 1;
        continue;
      }
      await onFile({ file, source });
    }
  }
  return { skippedRequireFree };
}

function requestFor(visit: FileVisit, combo: ComboSpec) {
  return { source: visit.source, path: visit.file, ...combo };
}

/** Render every selected file at every requested combo on one revision (`--baseline`). */
async function renderAll(
  handle: RevisionHandle,
  measurer: Measurer,
  corpora: SelectedCorpus[],
  axes: RenderAxes,
  options: { requireFree: string[] },
): Promise<{ records: ComboRecord[]; errors: ComboErrorEntry[]; skippedRequireFree: number }> {
  const records: ComboRecord[] = [];
  const errors: ComboErrorEntry[] = [];
  const combos = combosOf(axes);
  const { skippedRequireFree } = await visitFiles(
    corpora,
    axes,
    measurer,
    { requireFree: options.requireFree },
    [errors],
    async (visit) => {
      const results = await Promise.all(
        combos.map((combo) => computeComboRecord(handle, measurer, requestFor(visit, combo))),
      );
      for (const { record, error } of results) {
        if (record) records.push(record);
        if (error) errors.push(error);
      }
    },
  );
  return { records, errors, skippedRequireFree };
}

/**
 * Render every selected file at every requested combo on **both** revisions, side by side, so
 * the pairwise D-C fence check (`fencePrefixesOk`) runs while both texts are in hand; the
 * texts are dropped as soon as the pair is recorded. Each file's combos are issued together, so a server side pipelines.
 */
async function renderPaired(
  handleA: RevisionHandle,
  handleB: RevisionHandle,
  measurer: Measurer,
  corpora: SelectedCorpus[],
  axes: RenderAxes,
  options: { requireFree: string[] },
): Promise<{
  before: ComboRecord[];
  after: ComboRecord[];
  errorsA: ComboErrorEntry[];
  errorsB: ComboErrorEntry[];
  skippedRequireFree: number;
}> {
  const before: ComboRecord[] = [];
  const after: ComboRecord[] = [];
  const errorsA: ComboErrorEntry[] = [];
  const errorsB: ComboErrorEntry[] = [];
  const combos = combosOf(axes);
  const collect = (result: ComboResult, records: ComboRecord[], errors: ComboErrorEntry[]): void => {
    if (result.record) records.push(result.record);
    if (result.error) errors.push(result.error);
  };
  const { skippedRequireFree } = await visitFiles(corpora, axes, measurer, options, [errorsA, errorsB], async (visit) => {
    const results = await Promise.all(
      combos.map(async (combo) => {
        const [a, b] = await Promise.all([
          computeComboRecord(handleA, measurer, requestFor(visit, combo)),
          computeComboRecord(handleB, measurer, requestFor(visit, combo)),
        ]);
        if (a.record && b.record && a.output && b.output && b.record.fenceStrippedSha !== undefined) {
          const echoCount = Math.min(
            a.output.codeRanges.length,
            measurer.echoRangeCount(a.output),
          );
          b.record.fencePrefixOk = fencePrefixesOk(a.output, b.output, echoCount, measurer);
        }
        return [a, b] as const;
      }),
    );
    for (const [a, b] of results) {
      collect(a, before, errorsA);
      collect(b, after, errorsB);
    }
  });
  return { before, after, errorsA, errorsB, skippedRequireFree };
}

export interface PairRecordsResult {
  pairs: PairedCombo[];
  /** `before` entries with no matching `after` — dropped rather than paired. */
  unpairedBefore: number;
  /** `after` entries with no matching `before` — dropped rather than paired. */
  unpairedAfter: number;
}

/**
 * Pair every `before`/`after` record sharing a `(file, width, tier, ambiguous, policy, emoji)`
 * key (an absent policy/emoji reads as `P0`/`default`, so old baselines still pair).
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
  const key = (r: ComboRecord): string =>
    `${r.file} ${r.width} ${r.tier} ${r.ambiguous} ${policyOf(r)} ${emojiOf(r)}`;
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

/** `render-diff: nonvacuity sgr=A/B osc8=A/B dcs=A/B fences=A/B` — printed on every run. */
export function formatNonvacuity(before: NonvacuityCounters, after: NonvacuityCounters | null): string {
  return `render-diff: nonvacuity ${NONVACUITY_COUNTERS.map(
    (counter) => `${counter}=${before[counter]}/${after === null ? "-" : after[counter]}`,
  ).join(" ")}`;
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
      `allowedDC=${summary.allowedDC.length} ` +
      `overflowRegressions=${summary.overflowRegressions.length} ` +
      `detectorRegressions=${summary.detectorRegressions.length} errorsA=${errorsBefore} errorsB=${errorsAfter} ` +
      `unpairedA=${unpairedBefore} unpairedB=${unpairedAfter} ok=${summary.ok}`,
  );
  for (const failure of summary.nonvacuityFailures) console.log(`  NON-VACUITY FAILURE: ${failure}`);
  if (unpairedBefore > 0 || unpairedAfter > 0) {
    console.log(
      `  UNPAIRED: ${unpairedBefore} combo(s) rendered on one side only, ${unpairedAfter} on the other — the ` +
        "two revisions rendered different combo sets and this run compared only their intersection.",
    );
  }
  const describe = (d: ComboDiff): string =>
    `[${d.channels.join(",")}] width=${d.key.width} tier=${d.key.tier} ambiguous=${d.key.ambiguous} ` +
    `policy=${policyOf(d.key)} emoji=${emojiOf(d.key)} ${d.key.file}`;
  const printGroup = (label: string, diffs: ComboDiff[]): void => {
    if (diffs.length === 0) return;
    console.log(`-- ${label} (${diffs.length}) --`);
    for (const diff of diffs.slice(0, 50)) console.log(`  ${describe(diff)}`);
    if (diffs.length > 50) console.log(`  ... and ${diffs.length - 50} more`);
  };
  printGroup("class C (forbidden — code content changed: codeContentSha, or under P2–P4 a D-C code channel)", summary.classC);
  printGroup("disallowed under --expect a", summary.disallowed);
  printGroup("class B (enumerated, allowed under --expect b)", summary.allowedB);
  printGroup("D-C (highlighter SGR inside fences only, allowed)", summary.allowedDC);
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

function axesOf(options: CliOptions): RenderAxes {
  return {
    widths: options.widths,
    tiers: options.tiers,
    ambiguous: options.ambiguous,
    policies: options.policies,
    emojis: options.emojis,
  };
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const repoRootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (repoRootResult.exitCode !== 0) {
    console.error("render-diff: not inside a git repository (git rev-parse --show-toplevel failed)");
    process.exit(1);
  }
  const repoRoot = repoRootResult.stdout.toString().trim();
  const measurer = await loadMeasurer(repoRoot);
  const classifyOptions = { allowEmpty: options.allowEmpty, requireNonzero: options.requireNonzero };
  const printSkipped = (skipped: number): void => {
    if (options.requireFree.length > 0) {
      console.log(`render-diff: --require-free ${options.requireFree.join(",")} skipped ${skipped} file(s)`);
    }
  };

  if (options.baselineOut) {
    const started = performance.now();
    const { manifestPath, corpora: selected } = await selectCorpora(options);
    const corpora = applyShard(selected, options.shard);
    const handle = await loadRevision(options.revA ?? ".", repoRoot);
    const { records, errors, skippedRequireFree } = await renderAll(handle, measurer, corpora, axesOf(options), {
      requireFree: options.requireFree,
    }).finally(() => handle.close());
    printSkipped(skippedRequireFree);
    console.log(formatNonvacuity(sumNonvacuity(records), null));
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
    try {
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
        const { record: rendered, error } = await computeComboRecord(handle, measurer, {
          source,
          path: record.file,
          width: record.width,
          tier: record.tier,
          ambiguous: record.ambiguous,
          policy: policyOf(record),
          emoji: emojiOf(record),
        });
        if (rendered) after.push(rendered);
        if (error) errors.push(error);
      }
    } finally {
      await handle.close();
    }

    const { pairs, unpairedBefore, unpairedAfter } = pairRecords(baseline.combos, after);
    const summary = classifyDiffs(pairs, options.expect, classifyOptions);
    console.log(`render-diff: against ${resolve(options.against)} (baseline revision ${baseline.revisionLabel})`);
    console.log(`render-diff: live revision ${handle.label}, wall ${((performance.now() - started) / 1000).toFixed(1)}s`);
    console.log(formatNonvacuity(sumNonvacuity(baseline.combos), sumNonvacuity(after)));
    printClassification(summary, baseline.errors.length, errors.length, unpairedBefore, unpairedAfter);
    const unpaired = unpairedBefore > 0 || unpairedAfter > 0;
    process.exit(summary.ok && errors.length === 0 && !unpaired ? 0 : 1);
  }

  if (options.revA && options.revB) {
    const started = performance.now();
    const { corpora: selected } = await selectCorpora(options);
    const corpora = applyShard(selected, options.shard);
    const handleA = await loadRevision(options.revA, repoRoot);
    let handleB: RevisionHandle;
    try {
      handleB = await loadRevision(options.revB, repoRoot);
    } catch (error) {
      await handleA.close();
      throw error;
    }
    const { before, after, errorsA, errorsB, skippedRequireFree } = await renderPaired(
      handleA,
      handleB,
      measurer,
      corpora,
      axesOf(options),
      { requireFree: options.requireFree },
    ).finally(() => Promise.all([handleA.close(), handleB.close()]));

    const { pairs, unpairedBefore, unpairedAfter } = pairRecords(before, after);
    const summary = classifyDiffs(pairs, options.expect, classifyOptions);
    console.log(`render-diff: rev-a=${handleA.label} rev-b=${handleB.label}`);
    console.log(
      `render-diff: policy=${options.policies.join(",")} emoji=${options.emojis.join(",")}` +
        `${options.shard ? ` shard=${options.shard.index}/${options.shard.count}` : ""}`,
    );
    console.log(`render-diff: wall ${((performance.now() - started) / 1000).toFixed(1)}s`);
    printSkipped(skippedRequireFree);
    console.log(formatNonvacuity(sumNonvacuity(before), sumNonvacuity(after)));
    printClassification(summary, errorsA.length, errorsB.length, unpairedBefore, unpairedAfter);
    for (const [label, errors] of [
      ["A", errorsA],
      ["B", errorsB],
    ] as const) {
      for (const error of errors.slice(0, 5)) {
        console.log(`  ERROR ${label}: ${error.message.split("\n")[0]} (${error.file} width=${error.width})`);
      }
      if (errors.length > 5) console.log(`  ... and ${errors.length - 5} more errors on side ${label}`);
    }
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
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log("usage: bun run scripts/render-diff.ts [options]\n\nRender-differential harness (WP-1 of plans/marked-terminal-replacement.md); see the header comment of scripts/render-diff.ts for every flag.");
    process.exit(0);
  }
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
