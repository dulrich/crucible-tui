#!/usr/bin/env bun
/**
 * Corpus discovery and evaluation — the sweep's **library**, split out from its CLI in
 * WP-4 (`plans/tn-review-remediation.md`).
 *
 * Everything here answers one of two questions: *which files is this corpus?* and *what
 * does rendering them report?* `scripts/sweep.ts` keeps the other half — argument
 * parsing, the printed summary, and the exit-code contract — and is this module's only
 * CLI. `scripts/emoji-audit.ts` is the second consumer, and the reason the split exists:
 * it had already re-implemented the sampling predicate below and the copy had drifted
 * (it ignored `--limit` entirely), so a policy documented in exactly one place was in
 * fact being applied two different ways.
 *
 * **This module is a measurement instrument, not a build script.** Its numbers are
 * compared against dated full-corpus runs in a separate private archive repo, which this
 * file deliberately does not name or locate. The gates that run it exit on
 * `overflow`/`errors` alone, so a changed sample, a changed width order, a changed error
 * string or a changed detector accumulator passes every gate in this repo while
 * invalidating every archived comparison. Anything here that looks like a defect —
 * `--limit` doing nothing without `sample`, the hardcoded `elapsedSeconds: 0` on the
 * missing-root state, `shearsUnmapped` accumulating the orphan count, the two different
 * error-string shapes — is recorded behaviour, pinned in `tests/sweep.test.ts`, and is
 * changed only as a deliberate decision that re-baselines the archive.
 *
 * Corpus roots are never hardcoded: they load from a versioned JSON manifest, resolved
 * with this precedence, highest first:
 *   1. `--manifest <path>` (the sweep CLI's flag)
 *   2. `MDVIEW_CORPUS_MANIFEST` environment variable
 *   3. config key `corpusManifest` (see `src/config.ts`)
 *   4. the bundled public-safe default (`corpus/default-manifest.json`)
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { renderDocumentDetailed } from "../src/render";
import {
  findContinuationOverIndent,
  findListOrphans,
  findShearOrphans,
  isTableLine,
  probeBlockEnds,
  readBlockEnds,
} from "../src/detectors";
import { stripAnsi } from "../src/list-lines";
import { type GlyphSet } from "../src/glyphs";
import { loadConfig, resolveCorpusManifestPath, type ManifestSource } from "../src/config";
import { NARROW_MEASURE, type Measure } from "../src/width";
// The width gate, imported rather than re-implemented (WP-2): the sweep used to carry
// a second copy of `src/cli.ts`'s `checkOverflow`, identical argument for argument.
import { findFirstOverflow } from "../src/overflow";
// The one hash implementation this repo has (WP-1 of `plans/marked-terminal-replacement.md`),
// imported rather than re-derived so the colour axis below and the differential harness agree
// on what "the same text" means. **This closes an import cycle** — `scripts/render-diff.ts`
// imports `parseWidths` from `scripts/sweep.ts`, which imports this module — and the cycle is
// benign in both directions because neither module calls the other during module evaluation:
// `sha256Hex` is a hoisted function declaration, and every `import.meta.main` gate is false in
// a module that was imported rather than run. Verified from all three entry points.
import { sha256Hex } from "./render-diff";

export interface CorpusSpec {
  name: string;
  /** Root directory to resolve globs/walk against. Always resolved to absolute. */
  root: string;
  /** Glob-ish relative patterns (only `*` as a single-segment wildcard is supported). */
  globs?: string[];
  /** If true, walk the tree recursively for `**\/*.md`, excluding `exclude` substrings. */
  walkAll?: boolean;
  exclude?: string[];
  /**
   * Positive integer — if set, this corpus is stride-sampled to this many files
   * unless `--all` is passed. `--limit` overrides this value; it has no effect
   * on a corpus that does not set `sample`. Replaces the old `spec.name ===
   * "vault"` hardcode (WP-1).
   */
  sample?: number;
}

export interface CorpusManifest {
  version: number;
  generated: string;
  generator: string;
  corpora: CorpusSpec[];
}

export interface SweepOptions {
  widths: number[];
  limit?: number;
  all: boolean;
  glyphs: GlyphSet;
  /** `--manifest <path>` — outranks the env var, config key, and bundled default. */
  manifestFlag?: string;
  /**
   * `--detect` — also run `src/detectors.ts` over every render.
   *
   * **Off by default, and that is not timidity.** The width sweep's contract is
   * `overflow=0 errors=0` on a corpus of ~44.5k real notes; the detectors measure a
   * defect class that is still *open* (WP-2e, WP-2f), so switching them on by default
   * would turn the two bundled gates red for known, tracked reasons and destroy their
   * value as a signal. Detection is a separate tier with its own ratchet thresholds.
   */
  detect: boolean;
  /**
   * `--ambiguous narrow|wide` — the East Asian Ambiguous ruler (WP-3, `src/width.ts`).
   *
   * **The sweep never probes and never reads `MDVIEW_AMBIGUOUS`**, unlike the CLI. It
   * is a corpus *measurement* instrument, not a renderer aimed at a terminal: its
   * numbers are compared against dated runs in the private archive, and a baseline
   * that silently changed ruler because of the machine's `TERM` — or because someone
   * had once run `mdview probe` — would be a baseline that cannot be compared to
   * anything. Wide is therefore reachable only by asking for it, explicitly, on the
   * command line. Defaults to narrow, matching every recorded run.
   */
  measure?: Measure;
  /** `--max-orphans N` — with `--detect`, exit non-zero above N. A ratchet, not a target. */
  maxOrphans?: number;
  /** `--max-over-indent N` — same, for the continuation over-indent detector. */
  maxOverIndent?: number;
  /**
   * `--colour-mode on|off|both` — which colour modes this sweep's renders are made in
   * (WP-1, `plans/own-the-token-walk.md`). Defaults to `off`, which is byte-for-byte
   * today's behaviour: one in-process sweep, in whatever mode the ambient environment
   * resolved at module load.
   *
   * **It is not spelled `--color` and must never be.** `has-flag` — which
   * `supports-color` consulted, and `@colors/colors` too until WP-2 of
   * `plans/colour-policy.md` removed both from the runtime closure — scans the whole of
   * `process.argv`, so a harness flag by that name silently flipped the colour decision of
   * the very thing being measured. Neither package is installed now and the rule is
   * unchanged: `--color` is `mdview`'s own flag and the top slot of the ratified
   * precedence matrix (`src/cli.ts`), so a harness flag spelled that way would be read by
   * the renderer itself instead — the same failure with a different owner.
   */
  colourMode?: ColourMode;
  /**
   * `--colour-child on|off` — the internal re-exec marker. Set only by
   * `collectColourDigests` on the child command line it builds; a human never passes it.
   * When present, the sweep emits a digest stream (see `emitColourDigests`) instead of
   * running a sweep, and every other flag is honoured exactly as the parent honoured it.
   */
  colourChild?: ColourAxisMode;
  /**
   * `--max-char-diff N` — with the axis on, exit non-zero when the **character**
   * difference count exceeds N. A ratchet, not a target: the count is what it is today,
   * and what must not happen is it going up.
   *
   * It reads `charDiff` (`charDiffOnly + both`), the total, not the disjoint bucket.
   */
  maxCharDiff?: number;
  /**
   * `--max-sgr N` — same, for **any** SGR in a colourless render: `sgrAny`
   * (`sgrOnly + both`). The disjoint `sgrOnly` bucket is not the counter — it cannot see
   * unwanted SGR in a combo that also differs in characters, which is roughly half of
   * them.
   */
  maxSgr?: number;
}

export interface OverflowEntry {
  path: string;
  width: number;
  targetWidth: number;
  line: number;
}

export interface ErrorEntry {
  path: string;
  message: string;
}

export interface DetectEntry {
  path: string;
  targetWidth: number;
  count: number;
  line: number;
}

export interface CorpusResult {
  name: string;
  skipped: boolean;
  skipReason?: string;
  filesScanned: number;
  combos: number;
  overflow: OverflowEntry[];
  errors: ErrorEntry[];
  elapsedSeconds: number;
  /** Populated only under `--detect`. */
  orphans: DetectEntry[];
  /**
   * WP-8's reading of the same hits `orphans` counts: only those that are a short line
   * *inside* a block rather than the last line of one. **Reported beside `orphans`, never
   * instead of it** — `findListOrphans` is the series every dated figure in the private
   * archive's `measurements/` was taken with, and two numbers that can be compared are
   * the whole point of adding one.
   */
  shears: DetectEntry[];
  /** Of the same hits, how many landed in a document whose probe could not be aligned. */
  shearsUnmapped: number;
  overIndent: DetectEntry[];
  /**
   * Of `overflow`, how many are a table row or border. Many-column tables overflow below
   * a width floor **by design** (`plans/mdview.md:64`, decided before the tool was
   * built), and a dense low-width sweep lights up every table-heavy note in the corpus.
   * Reported separately so it cannot be mistaken for a regression, and so a difficulty
   * profile does not end up measuring table width instead of difficulty.
   */
  tableOverflow: number;
  /**
   * Symlinked directories inside the corpus root, skipped by design (see
   * `canonicalizeAndDedupe`'s comment on `walkMarkdown`'s symlink semantics, which this
   * does not change) and disclosed here so the skip is a recorded decision rather than a
   * silent one. Always `0` for a glob-based (non-`walkAll`) corpus.
   */
  symlinkedDirsSkipped: number;
}
/**
 * Validate one manifest entry and resolve its `root` to an absolute path.
 * A relative root resolves against the directory containing the manifest
 * file, never against the process CWD — this is what lets the bundled
 * default (relative roots) and a private manifest (absolute roots) share one
 * format.
 */
function validateEntry(entry: unknown, index: number, manifestPath: string): CorpusSpec {
  const where = `corpus manifest ${manifestPath}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${where}: corpora[${index}] is not an object`);
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.name !== "string" || e.name.length === 0) {
    throw new Error(`${where}: corpora[${index}] is missing a non-empty string "name"`);
  }
  const label = `${where}, corpus "${e.name}"`;

  if (typeof e.root !== "string" || e.root.length === 0) {
    throw new Error(`${label}: missing a non-empty string "root"`);
  }

  const hasGlobs = e.globs !== undefined;
  if (hasGlobs && !(Array.isArray(e.globs) && e.globs.every((g) => typeof g === "string"))) {
    throw new Error(`${label}: "globs" must be an array of strings`);
  }
  const hasWalkAll = e.walkAll === true;
  if (e.walkAll !== undefined && typeof e.walkAll !== "boolean") {
    throw new Error(`${label}: "walkAll" must be a boolean`);
  }
  if (!hasGlobs && !hasWalkAll) {
    throw new Error(`${label}: must set either "globs" (non-empty array) or "walkAll: true"`);
  }

  if (e.exclude !== undefined && !(Array.isArray(e.exclude) && e.exclude.every((x) => typeof x === "string"))) {
    throw new Error(`${label}: "exclude" must be an array of strings`);
  }

  if (e.sample !== undefined && (typeof e.sample !== "number" || !Number.isInteger(e.sample) || e.sample <= 0)) {
    throw new Error(`${label}: "sample" must be a positive integer`);
  }

  return {
    name: e.name,
    root: resolve(dirname(manifestPath), e.root),
    globs: hasGlobs ? (e.globs as string[]) : undefined,
    walkAll: hasWalkAll,
    exclude: e.exclude as string[] | undefined,
    sample: e.sample as number | undefined,
  };
}

/**
 * Parse and validate a manifest already read from disk. Exported for tests.
 * Throws on any malformed or wrong-version manifest — this is developer-facing
 * infrastructure, not user config, and a silently-empty corpus is exactly the
 * failure mode this repo has been bitten by before.
 */
export function parseManifest(raw: string, manifestPath: string): CorpusManifest {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`corpus manifest ${manifestPath} is not valid JSON: ${message}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`corpus manifest ${manifestPath} must be a JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(
      `corpus manifest ${manifestPath} has unsupported "version" ${JSON.stringify(obj.version)} (expected 1)`,
    );
  }
  if (!Array.isArray(obj.corpora) || obj.corpora.length === 0) {
    throw new Error(`corpus manifest ${manifestPath} must have a non-empty "corpora" array`);
  }

  const corpora = obj.corpora.map((entry, index) => validateEntry(entry, index, manifestPath));

  return {
    version: 1,
    generated: typeof obj.generated === "string" ? obj.generated : "",
    generator: typeof obj.generator === "string" ? obj.generator : "",
    corpora,
  };
}

/** Read and parse the manifest at `manifestPath`. Fails loudly — see `parseManifest`. */
export async function loadManifest(manifestPath: string): Promise<CorpusManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read corpus manifest at ${manifestPath}: ${reason}`);
  }
  return parseManifest(raw, manifestPath);
}

/** Resolve which manifest path to load and why, given the `--manifest` flag (if any). */
export async function resolveManifestSource(
  manifestFlag: string | undefined,
): Promise<{ path: string; source: "flag" | ManifestSource }> {
  if (manifestFlag) return { path: manifestFlag, source: "flag" };
  const config = await loadConfig();
  return resolveCorpusManifestPath(config);
}

/**
 * Deterministic, whole-list-spanning sample: sort paths, then pick exactly
 * `limit` indices evenly spaced across the full sorted range (index
 * `round(i * (n - 1) / (limit - 1))` for i in [0, limit)), so the first and last
 * paths are always included. Taking the first N from a glob/walk scan biases the
 * sample toward whichever directory sorts first (see plan's vault-readiness.md,
 * WP-1 requirements) — this spread sampling covers the full sorted list instead.
 */
export function strideSample<T>(items: T[], limit: number): T[] {
  const sorted = [...items].sort();
  if (limit <= 0) return [];
  if (sorted.length <= limit) return sorted;
  if (limit === 1) return [sorted[0] as T];

  const lastIndex = sorted.length - 1;
  const sampled: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round((i * lastIndex) / (limit - 1));
    sampled.push(sorted[index] as T);
  }
  return sampled;
}

/** Single-segment `*` glob match against one path component. */
function matchSegment(pattern: string, segment: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === segment;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(segment);
}

async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/");
  let current = [root];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (matchSegment(segment, entry)) next.push(join(dir, entry));
      }
    }
    current = next;
  }
  const results: string[] = [];
  for (const candidate of current) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) results.push(candidate);
    } catch {
      // vanished between glob expansion and stat — skip.
    }
  }
  return results;
}

/**
 * Mutable out-param for `walkMarkdown`'s symlinked-directory count — a plain counter
 * object rather than a return-shape change, so the walk's return contract
 * (`Promise<string[]>`) stays exactly what every existing caller already expects.
 */
export interface SymlinkStats {
  /** Symlinked directories encountered (and, by design, never recursed into). */
  symlinkedDirs: number;
}

async function walkMarkdown(root: string, exclude: string[], stats?: SymlinkStats): Promise<string[]> {
  const results: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (exclude.some((needle) => full.includes(needle))) continue;
      if (entry.isSymbolicLink()) {
        // `isDirectory()`/`isFile()` are both false for a symlink, so this entry was
        // already silently skipped either way — that skip is deliberate (see
        // `canonicalizeAndDedupe`'s comment above) and stays unchanged here. What's new
        // is disclosure: if it resolves to a directory, count it so the caller can make
        // the skip audible instead of silent.
        if (stats) {
          try {
            if ((await stat(full)).isDirectory()) stats.symlinkedDirs += 1;
          } catch {
            // Broken symlink — resolves to nothing, so it is not a skipped directory.
          }
        }
        continue;
      }
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
  }
  await recurse(root);
  return results;
}

/**
 * Canonicalize to realpaths and drop duplicates, first occurrence wins (WP-2d).
 *
 * **Read this before citing symlinks as an explanation for anything.** WP-2d was briefed
 * that the walk followed symlinked `.md` files and swept the same bytes twice. Measured
 * directly, by resolving every corpus with and without this pass and diffing the lists:
 * **it does not, and never did — 0 duplicates removed across all 17 corpora / 44,686
 * files.** `walkMarkdown` gates on `Dirent.isFile()`, which is *false* for a symlink
 * (`isSymbolicLink()` is the true one), so a symlinked `.md` was never in the walk to be
 * counted twice. Verified against the specific case the premise rested on — a repo whose
 * `CLAUDE.md` **is** a symlink to its `AGENTS.md`, which is the fleet-wide convention and
 * so the strongest form of the premise: the walk returns only the `AGENTS.md`. No recorded
 * file count in the private archive's `measurements/` is inflated by symlinks, and none
 * changed here. The corpus-side detail lives in that archive, not in this file.
 *
 * The pass is kept anyway, for the exposure that is real: the **glob** path resolves with
 * `stat()`, which *does* follow symlinks, so a glob-based manifest can genuinely list one
 * file under two names. It costs ~1.6s over 44.7k files and makes the walk's identity
 * model explicit instead of incidental.
 *
 * Not fixed here, and the opposite sign of defect: because `isDirectory()` is likewise
 * false for a symlinked directory, a symlinked *subtree* is silently **not** swept at
 * all. That is an under-count, it is out of WP-2d's scope, and it wants a decision (is a
 * corpus root's symlinked subtree in the corpus?) rather than a patch.
 *
 * A path whose `realpath` fails (a broken symlink) is kept as-is rather than dropped, so
 * it still surfaces as the `ENOENT` it is instead of vanishing from the count silently.
 */
async function canonicalizeAndDedupe(files: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    let canonical: string;
    try {
      canonical = await realpath(file);
    } catch {
      canonical = file;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export interface ResolveOptions {
  /**
   * Defaults to `true`. The `false` path exists so the dedupe's effect stays directly
   * measurable (call both, diff the lists) without re-running a 13-minute full sweep to
   * infer it — it is not a supported mode for an actual sweep.
   */
  dedupe?: boolean;
}

/**
 * Resolve the file list for one corpus. Returns `null` (with a notice already
 * logged by the caller via `skipped`) if the corpus root does not exist.
 *
 * Paths come back **realpath-canonicalized and deduplicated** — see
 * `canonicalizeAndDedupe` for why that is not optional.
 *
 * `symlinkStats`, if passed, is populated with the count of symlinked directories the
 * walk skipped (only meaningful for `spec.walkAll`; a glob-based corpus never had this
 * count in the first place). Optional and out-of-band on purpose, so this function's
 * own return contract (`Promise<string[] | null>`) is unchanged for every existing caller.
 */
export async function resolveCorpusFiles(
  spec: CorpusSpec,
  options: ResolveOptions = {},
  symlinkStats?: SymlinkStats,
): Promise<string[] | null> {
  try {
    const info = await stat(spec.root);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }

  let files: string[];
  if (spec.walkAll) {
    files = await walkMarkdown(spec.root, spec.exclude ?? [], symlinkStats);
  } else {
    const all = new Set<string>();
    for (const glob of spec.globs ?? []) {
      const matches = await expandGlob(spec.root, glob);
      for (const match of matches) all.add(match);
    }
    files = [...all];
  }

  return options.dedupe === false ? files : canonicalizeAndDedupe(files);
}

/**
 * The two options that decide *how much* of a corpus gets swept. Split out from
 * `SweepOptions` (which it is structurally a subset of) so a consumer that renders
 * nothing — `scripts/emoji-audit.ts` — can apply the identical policy without
 * inventing a width set and a glyph tier it has no use for.
 */
export interface SelectionOptions {
  /** `--all`: sweep every file a corpus resolves, ignoring its manifest `sample`. */
  all: boolean;
  /** `--limit N`: override a corpus's manifest `sample`. No effect without one. */
  limit?: number;
}

/**
 * Apply the sampling policy to one corpus's resolved file list.
 *
 * **One implementation, because there were two and they disagreed.** WP-4 found this
 * predicate re-implemented in `scripts/emoji-audit.ts`, where it ignored `--limit`
 * outright — so the same flag selected different files depending on which script read
 * it, with nothing in the repo able to notice.
 *
 * The policy itself is unchanged from the sweep's, including the part that reads like an
 * oversight and is not: **`--limit` deliberately does nothing on a corpus that sets no
 * `sample`.** `sample` (manifest-driven) replaced the old `spec.name === "vault"`
 * hardcode, and `--limit` overrides that value exactly where the old flag applied — on a
 * corpus that declares one — rather than becoming a general "sweep fewer files" knob.
 * `--all` always disables sampling and outranks `--limit`.
 */
export function selectCorpusFiles(files: string[], spec: CorpusSpec, options: SelectionOptions): string[] {
  const samplingApplies = spec.sample !== undefined && !options.all;
  const effectiveSampleSize = samplingApplies ? (options.limit ?? spec.sample) : undefined;
  return effectiveSampleSize !== undefined ? strideSample(files, effectiveSampleSize) : files;
}

/**
 * The one construction site for a `CorpusResult`, replacing four hand-written literals
 * that had drifted apart in exactly the way four copies of a fourteen-field record do.
 *
 * **A factory with per-state overrides, deliberately not a collapse.** The four states
 * are genuinely different — a root that is not there, a `walkAll` root with no markdown,
 * a glob that matched nothing, and a real sweep — and two of them carry rationale at
 * their call site that is the reason they are distinguishable at all. What is shared is
 * only the *empty* shape: zero counts and empty arrays.
 *
 * `name`, `skipped` and `elapsedSeconds` are **required**, so no state can inherit them
 * silently. `elapsedSeconds` in particular: the missing-root state reports a hardcoded
 * `0` where every other path measures wall time, and a factory that defaulted it would
 * normalise that away and change a reported timing with nothing to notice. Requiring it
 * makes the `0` a visible choice at the call site, which is what it is.
 */
function corpusResult(
  fields: Pick<CorpusResult, "name" | "skipped" | "elapsedSeconds"> & Partial<CorpusResult>,
): CorpusResult {
  return {
    filesScanned: 0,
    combos: 0,
    overflow: [],
    errors: [],
    orphans: [],
    shears: [],
    shearsUnmapped: 0,
    overIndent: [],
    tableOverflow: 0,
    symlinkedDirsSkipped: 0,
    ...fields,
  };
}

/**
 * Render one corpus at every requested width and report what it found.
 *
 * Two things about the shape of this loop are load-bearing and are pinned in
 * `tests/sweep.test.ts`: the widths are iterated **in the order given** (which fixes
 * which file-width lands in `overflow[0]` and the `line` recorded on each `DetectEntry`),
 * and the two error channels keep different shapes — a file that could not be read failed
 * once for the whole file and carries no width, a render that threw failed at one width
 * and says which.
 */
export async function sweepCorpus(spec: CorpusSpec, options: SweepOptions): Promise<CorpusResult> {
  const started = performance.now();
  const symlinkStats: SymlinkStats = { symlinkedDirs: 0 };
  const files = await resolveCorpusFiles(spec, {}, symlinkStats);

  if (files === null) {
    // `elapsedSeconds: 0`, not a measurement, and stated here rather than defaulted:
    // this is the one state that reports a constant where every other path reports wall
    // time. Recorded behaviour — see the factory's note.
    return corpusResult({
      name: spec.name,
      skipped: true,
      skipReason: `corpus root not found: ${spec.root}`,
      elapsedSeconds: 0,
    });
  }

  if (files.length === 0) {
    if (spec.walkAll) {
      // WP-12c: a `walkAll` root with zero matches is a **fact about the root**, not a
      // misconfiguration — unlike the glob case just below, `walkAll` has no user-supplied
      // pattern that could be typo'd; it only recurses looking for `.md` files under a
      // root whose existence was already confirmed above. Two of the reference clones
      // (`memtest_vulkan`, `urxvt-perls`) are exactly this: genuinely markdown-free
      // repositories. Reporting them into `errors` trained the reader to expect noise in
      // the one channel that is supposed to mean "something went wrong," so this follows
      // the existing `skipped`/`skipReason` seam instead of inventing a third state.
      return corpusResult({
        name: spec.name,
        skipped: true,
        skipReason: "corpus root contains no markdown files",
        elapsedSeconds: (performance.now() - started) / 1000,
        symlinkedDirsSkipped: symlinkStats.symlinkedDirs,
      });
    }
    // An existing-but-empty *glob-based* corpus stays an error — the plan calls this out
    // explicitly (a corpus silently returning zero files could otherwise mask a broken
    // glob or a moved directory). A glob is a user-supplied pattern, so zero matches is
    // exactly the shape that failure mode produces; nothing here narrows that protection.
    return corpusResult({
      name: spec.name,
      skipped: false,
      errors: [{ path: spec.root, message: "corpus exists but matched 0 files" }],
      elapsedSeconds: (performance.now() - started) / 1000,
      symlinkedDirsSkipped: symlinkStats.symlinkedDirs,
    });
  }

  const selected = selectCorpusFiles(files, spec, options);

  const overflow: OverflowEntry[] = [];
  const errors: ErrorEntry[] = [];
  const orphans: DetectEntry[] = [];
  const shears: DetectEntry[] = [];
  let shearsUnmapped = 0;
  const overIndent: DetectEntry[] = [];
  let tableOverflow = 0;
  let combos = 0;

  for (const path of selected) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      // Unprefixed on purpose: the read failed once, for the whole file, before any
      // width was involved. The per-width channel below is the one that names a width.
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const width of options.widths) {
      combos += 1;
      try {
        // One ruler for the render and the check, always: a sweep that allocated one
        // way and measured another would report an overflow count about nothing.
        const measure = options.measure ?? NARROW_MEASURE;
        const { text, codeRanges } = renderDocumentDetailed(source, width, options.glyphs, measure);
        const found = findFirstOverflow(text, width, codeRanges, measure);
        if (found) {
          overflow.push({ path, width: found.width, targetWidth: width, line: found.line });
          if (isTableLine(text.split("\n")[found.line - 1] ?? "")) tableOverflow += 1;
        }
        if (options.detect) {
          // Fenced ranges are exempt here for the same reason they are exempt from the
          // width check: fences are never rewritten, so their shape is not ours to
          // guarantee. Constraint carried over deliberately, not inherited by accident.
          const foundOrphans = findListOrphans(text, width, { codeRanges, measure });
          if (foundOrphans.length > 0) {
            const first = text.split("\n").findIndex((line) => stripAnsi(line).trim() === foundOrphans[0]);
            orphans.push({ path, targetWidth: width, count: foundOrphans.length, line: first + 1 });
            // WP-8's second reading of exactly those hits. Only worth the second render
            // when there is something to classify, so it is nested inside the guard
            // above rather than run over every combo.
            const probed = renderDocumentDetailed(probeBlockEnds(source), width, options.glyphs, measure);
            const blockEnds = readBlockEnds(text, probed.text);
            const foundShears = findShearOrphans(text, width, blockEnds, { codeRanges, measure });
            // Adds the **orphan** count, not a shear count. It reads like a bug and is the
            // recorded metric: an unmapped document's hits are the ones the classifier
            // could not label, and that is a count of orphans. Pinned in tests/sweep.test.ts.
            if (!blockEnds.mapped) shearsUnmapped += foundOrphans.length;
            if (foundShears.length > 0) {
              shears.push({
                path,
                targetWidth: width,
                count: foundShears.length,
                line: foundShears[0]?.line ?? 0,
              });
            }
          }
          const drift = findContinuationOverIndent(text, { codeRanges, measure });
          if (drift.length > 0) {
            overIndent.push({ path, targetWidth: width, count: drift.length, line: drift[0]?.line ?? 0 });
          }
        }
      } catch (error) {
        // Width-prefixed on purpose: this render failed at one width and the width is the
        // diagnostic. Do not unify with the read channel above.
        errors.push({
          path,
          message: `width ${width}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return corpusResult({
    name: spec.name,
    skipped: false,
    filesScanned: selected.length,
    combos,
    overflow,
    errors,
    elapsedSeconds: (performance.now() - started) / 1000,
    orphans,
    shears,
    shearsUnmapped,
    overIndent,
    tableOverflow,
    symlinkedDirsSkipped: symlinkStats.symlinkedDirs,
  });
}

// ---------------------------------------------------------------------------
// The colour axis (WP-1, `plans/own-the-token-walk.md`)
// ---------------------------------------------------------------------------
//
// The invariant this instrument exists to measure: **a colour decision may change which
// bytes a render emits; it must never change which characters it emits.** Everything
// below is measurement only — no renderer source is touched and no rendered byte moves.
//
// ## Why this is two processes — the reason it *had* to be, and the reason it stays
//
// This module statically imports `renderDocumentDetailed` (the import at the top of this
// file). **No colour decision in this renderer resolves at module load any more.** WP-1 of
// `plans/colour-policy.md` made the renderer's own decision a per-call resolution over
// inputs handed in explicitly (`src/colour.ts`), and WP-2 retired the last two module-load
// globals with the packages that owned them — `cli-highlight`'s bundled `chalk` theme and
// `@colors/colors`' `enabled`, both of which put styling into rendered output that no
// argument could reach, so a second render in one process genuinely could not be in a
// different colour mode overall and mutating `FORCE_COLOR` between renders did nothing for
// them (Bun's module cache hands back the module that already resolved;
// `tests/helpers/color.ts` records the same finding from the test side). One process could
// now render the same file both ways, correctly.
//
// **The two children stay, and the reason is what the instrument has to prove rather than
// what the renderer can do.** A colour-axis number is only evidence if the two populations
// really were rendered in opposite modes, and a child whose environment is fixed *before*
// its own module graph loads makes that observable from the child's own output —
// `tests/colour-axis.test.ts` asserts exactly that, against a hostile ambient
// `FORCE_COLOR`/`NO_COLOR`. Collapsing this into one process changes what the gate proves
// and owes its own evidence (WP-5 of `plans/colour-policy.md`); it is not a tidy-up that
// falls out of removing two dependencies.
//
// So the parent re-execs the sweep CLI twice, once per mode, with the colour decision
// pinned in the child's environment before any import happens. Each child renders the
// same population and emits a **digest** per `(file, width)` — never body text, so this
// stays affordable over a ~44.5k-file private corpus — and the parent joins the two
// streams by key.
//
// ## Why the child's environment is set explicitly, both variables, every time
//
// A child that merely inherited the parent's environment would measure the machine, not
// the renderer: a developer with `FORCE_COLOR` exported would silently run both children
// in the same mode, and a colour axis that runs twice in one mode is a gate that cannot
// fail — the shape root `AGENTS.md`'s "Flag order matters" paragraph forbids. Both
// variables are therefore set (or deleted) on both children unconditionally, and
// `tests/colour-axis.test.ts` asserts the two children resolve *opposite* modes from
// their observed output rather than from the environment we intended to set.
//
// **`NO_COLOR` and `MDVIEW_COLOR` are deleted, and `NO_COLOR`'s reason changed sign at
// WP-1 of `plans/colour-policy.md`.** It used to be deleted because it was honoured
// *nowhere* in this stack, so setting it would have invented a meaning this instrument does
// not own. It is now honoured — it sits above `FORCE_COLOR` in the ratified precedence
// table — which is exactly why an ambient one has to be cleared: inherited, it would
// override the `FORCE_COLOR` this function sets and run the forced-colour child colourless.
// `MDVIEW_COLOR` is deleted for the same reason and joined the list in the same package;
// it outranks `NO_COLOR` in turn, so an ambient `MDVIEW_COLOR=never` would silently
// flatten the whole axis.

/** One end of the axis. `on` is the forced-colour child; `off` is the colourless one. */
export type ColourAxisMode = "on" | "off";

/** The `--colour-mode` flag's domain: measure one mode, or compare the two. */
export type ColourMode = ColourAxisMode | "both";

/** The digest of one `(file, width)` render, in one colour mode. */
export interface ColourDigestRecord {
  corpus: string;
  path: string;
  width: number;
  /** sha256 of the SGR-stripped text — the *character* channel. */
  strippedSha: string;
  /**
   * Whether the raw text carried any SGR escape. `stripAnsi` removes SGR and nothing
   * else, which is exactly right here and is why OSC-8 hyperlinks are explicitly out of
   * this instrument's scope (`src/inline.ts` emits them independently of colour).
   */
  hasSgr: boolean;
}

/** A render that threw in a child, carried through rather than swallowed. */
export interface ColourErrorRecord {
  corpus: string;
  path: string;
  width: number;
  message: string;
}

/** One child's output for one corpus. */
export interface ColourDigestStream {
  corpus: string;
  digests: ColourDigestRecord[];
  errors: ColourErrorRecord[];
}

/**
 * The three buckets, plus the two totals the ratchets actually read.
 *
 * The buckets are disjoint; the totals are not, and that is the point. **The unwanted-SGR
 * ratchet reads `sgrAny` (`sgrOnly + both`), never `sgrOnly`** — unwanted SGR sitting in a
 * combo that *also* differs in characters is invisible to the disjoint bucket, and that is
 * roughly half of them (measured 64 disjoint against 125 total on a 36-file set). Same
 * shape for characters: `charDiff` is `charDiffOnly + both`.
 */
export interface ColourAxisResult {
  corpus: string;
  /** `(file, width)` keys present in both streams. */
  combos: number;
  /** Same characters, no SGR in the colourless render — the invariant holding. */
  identical: number;
  /** `strippedSha` differs, and the colourless render carried no SGR. */
  charDiffOnly: number;
  /** `strippedSha` matches, but the colourless render carried SGR. */
  sgrOnly: number;
  /** `strippedSha` differs **and** the colourless render carried SGR. */
  both: number;
  /** `charDiffOnly + both` — what `--max-char-diff` ratchets. */
  charDiff: number;
  /** `sgrOnly + both` — what `--max-sgr` ratchets. */
  sgrAny: number;
  /** Child render failures, plus any key that appeared in only one of the two streams. */
  errors: ColourErrorRecord[];
  elapsedSeconds: number;
}

/**
 * The digest of one rendered document.
 *
 * `hasSgr` compares lengths rather than strings because `stripAnsi` only ever removes:
 * a shorter result means at least one sequence was present.
 *
 * **What it removes widened at WP-3 of `plans/colour-policy.md`, and the field name did
 * not.** `stripAnsi` (`src/list-lines.ts`) is a derivation of `src/ansi.ts`'s scanner now,
 * so it takes out OSC-8 hyperlinks and tmux DCS envelopes as well as SGR — which means
 * this flag reads "carries any terminal sequence", and the character channel no longer
 * counts a hyperlink's destination URL as visible text. Both changes are in the direction
 * this instrument always claimed to measure; the old strip was simply blind to two of the
 * three sequence kinds the renderer can emit. Neither seed moved with it: the colourless
 * child emits no hyperlink (they are off on every non-TTY destination, whatever the colour
 * decision), so nothing this counter samples changed shape.
 *
 * The name stays `hasSgr` because WP-5 of the same plan **deletes** it, along with
 * `--max-sgr`, `classifyColourAxis`'s buckets and the printed bucket line, replacing all
 * of it with the three exact gates over a `sequences[]` wire record. Renaming a field on
 * its way out would cost a diff in every consumer to buy one package of accuracy.
 */
export function digestText(text: string): { strippedSha: string; hasSgr: boolean } {
  const stripped = stripAnsi(text);
  return { strippedSha: sha256Hex(stripped), hasSgr: stripped.length !== text.length };
}

/**
 * The join key for one `(file, width)`.
 *
 * The separator is written as the escape `\u0000`, not as a raw byte, so — unlike
 * `scripts/render-diff.ts`, whose three raw NULs make it binary to `grep` and `rg` (see
 * `scripts/AGENTS.md`'s note on that trap) — this file stays plain text to both tools. A
 * NUL cannot occur in a path, so the key is unambiguous.
 */
function comboKey(path: string, width: number): string {
  return `${width}\u0000${path}`;
}

/**
 * The child body: render every `(file, width)` of every requested corpus and write one
 * JSON record per line to `write`.
 *
 * The render call is **byte-identical to `sweepCorpus`'s** — same positional argument
 * order, same ruler default. `renderDocumentDetailed(source, targetWidth, glyphs,
 * measure)` takes its width as a **positional number** (`src/render.ts:776-782`); passing
 * an options object instead renders every width identically, which has invalidated four
 * separate measurements of this exact quantity across three authors. Do not "tidy" this
 * call into an object.
 */
export async function emitColourDigests(
  specs: CorpusSpec[],
  options: SweepOptions,
  write: (line: string) => void,
): Promise<void> {
  for (const spec of specs) {
    write(JSON.stringify({ corpus: spec.name, begin: true }));
    const files = await resolveCorpusFiles(spec, {});
    if (files === null || files.length === 0) continue;
    const selected = selectCorpusFiles(files, spec, options);
    for (const path of selected) {
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        // Recorded against every width, so the join stays symmetric rather than dropping
        // the file from one side of it. The message is unprefixed, matching `sweepCorpus`:
        // the read failed once, for the whole file, before any width was involved.
        const message = error instanceof Error ? error.message : String(error);
        for (const width of options.widths) {
          write(JSON.stringify({ corpus: spec.name, path, width, error: message }));
        }
        continue;
      }
      for (const width of options.widths) {
        try {
          const measure = options.measure ?? NARROW_MEASURE;
          const { text } = renderDocumentDetailed(source, width, options.glyphs, measure);
          const { strippedSha, hasSgr } = digestText(text);
          write(JSON.stringify({ corpus: spec.name, path, width, strippedSha, hasSgr }));
        } catch (error) {
          write(
            JSON.stringify({
              corpus: spec.name,
              path,
              width,
              error: `width ${width}: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        }
      }
    }
  }
}

/** Parse one child's JSONL stdout into per-corpus streams, in first-seen corpus order. */
export function parseColourDigestStreams(stdout: string): ColourDigestStream[] {
  const streams = new Map<string, ColourDigestStream>();
  const streamFor = (corpus: string): ColourDigestStream => {
    let stream = streams.get(corpus);
    if (!stream) {
      stream = { corpus, digests: [], errors: [] };
      streams.set(corpus, stream);
    }
    return stream;
  };
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    const corpus = String(record.corpus);
    const stream = streamFor(corpus);
    if (record.begin === true) continue;
    if (typeof record.error === "string") {
      stream.errors.push({
        corpus,
        path: String(record.path),
        width: Number(record.width),
        message: record.error,
      });
      continue;
    }
    stream.digests.push({
      corpus,
      path: String(record.path),
      width: Number(record.width),
      strippedSha: String(record.strippedSha),
      hasSgr: record.hasSgr === true,
    });
  }
  return [...streams.values()];
}

/** The sweep CLI, which is also the colour axis's child entry point. */
const SWEEP_CLI_PATH = join(import.meta.dir, "sweep.ts");

/**
 * The child environment, built explicitly rather than inherited.
 *
 * Every variable the colour resolver reads is decided here for both modes — never left to
 * whatever the developer or CI happens to export — because the whole axis is worthless if
 * the two children can resolve the same mode. `FORCE_COLOR=3` is the level
 * `tests/helpers/color.ts` already uses for the forced-colour side; `FORCE_COLOR=0` is an
 * explicit "no" under `src/colour.ts`'s ratified reading of the variable as much as it was
 * under `supports-color`'s. The child's stdout is a pipe, so it is not a TTY either way —
 * which is also why hyperlinks are off in both children and this axis says nothing about
 * them.
 */
export function colourChildEnv(
  mode: ColourAxisMode,
  base: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NO_COLOR;
  delete env.MDVIEW_COLOR;
  // `FORCE_COLOR` needs no `delete` of its own: the assignment below overwrites whatever
  // was inherited, unconditionally, on both children. All three variables the resolver
  // reads are therefore decided here and none is left to the machine.
  env.FORCE_COLOR = mode === "on" ? "3" : "0";
  return env;
}

/**
 * Spawn one child in one colour mode and collect its digest streams.
 *
 * `childArgs` is the parent's own command line with `--colour-mode` removed, so the child
 * resolves the same manifest, the same corpora, the same sampling and the same widths by
 * running the same parser over the same flags — there is no second file-selection
 * mechanism to drift. The population is the manifest corpus, and nothing else.
 */
export async function collectColourDigests(
  mode: ColourAxisMode,
  childArgs: string[],
): Promise<ColourDigestStream[]> {
  const proc = Bun.spawn([process.execPath, "run", SWEEP_CLI_PATH, "--colour-child", mode, ...childArgs], {
    env: colourChildEnv(mode, process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`colour-axis child (--colour-child ${mode}) exited ${exitCode}: ${stderr.trim()}`);
  }
  try {
    return parseColourDigestStreams(stdout);
  } catch (error) {
    throw new Error(
      `colour-axis child (--colour-child ${mode}) produced unparseable output: ` +
        `${error instanceof Error ? error.message : String(error)}\nstderr: ${stderr.trim()}`,
    );
  }
}

/**
 * Join two digest streams for one corpus and sort every `(file, width)` into exactly one
 * of the three buckets.
 *
 * A key present in one stream and not the other is an **error**, not a silent drop: the
 * two children resolve their populations independently, so a divergence there is a fact
 * about the instrument that must be visible rather than a combo quietly missing from the
 * denominator.
 */
export function classifyColourAxis(
  corpus: string,
  colour: ColourDigestStream | undefined,
  colourless: ColourDigestStream | undefined,
  elapsedSeconds: number,
): ColourAxisResult {
  const on = new Map((colour?.digests ?? []).map((digest) => [comboKey(digest.path, digest.width), digest]));
  const off = new Map((colourless?.digests ?? []).map((digest) => [comboKey(digest.path, digest.width), digest]));
  const errors: ColourErrorRecord[] = [
    ...(colour?.errors ?? []).map((entry) => ({ ...entry, message: `colour-on ${entry.message}` })),
    ...(colourless?.errors ?? []).map((entry) => ({ ...entry, message: `colour-off ${entry.message}` })),
  ];

  let identical = 0;
  let charDiffOnly = 0;
  let sgrOnly = 0;
  let both = 0;
  let combos = 0;

  for (const [key, offDigest] of off) {
    const onDigest = on.get(key);
    if (!onDigest) {
      errors.push({
        corpus,
        path: offDigest.path,
        width: offDigest.width,
        message: "present in the colourless stream but missing from the colour stream",
      });
      continue;
    }
    combos += 1;
    const differs = onDigest.strippedSha !== offDigest.strippedSha;
    // The colourless side is the one whose SGR is unwanted: colour in a colour render is
    // the point, colour in a render that asked for none is the defect.
    if (differs && offDigest.hasSgr) both += 1;
    else if (differs) charDiffOnly += 1;
    else if (offDigest.hasSgr) sgrOnly += 1;
    else identical += 1;
  }
  for (const [key, onDigest] of on) {
    if (off.has(key)) continue;
    errors.push({
      corpus,
      path: onDigest.path,
      width: onDigest.width,
      message: "present in the colour stream but missing from the colourless stream",
    });
  }

  return {
    corpus,
    combos,
    identical,
    charDiffOnly,
    sgrOnly,
    both,
    charDiff: charDiffOnly + both,
    sgrAny: sgrOnly + both,
    errors,
    elapsedSeconds,
  };
}

/**
 * Run the whole axis: both children, in parallel, then the join.
 *
 * The corpus order follows the colourless child's, which is the manifest's, which is the
 * order the sweep itself printed a moment earlier.
 */
export async function runColourAxis(childArgs: string[]): Promise<ColourAxisResult[]> {
  const started = performance.now();
  const [colour, colourless] = await Promise.all([
    collectColourDigests("on", childArgs),
    collectColourDigests("off", childArgs),
  ]);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const byCorpus = new Map(colour.map((stream) => [stream.corpus, stream]));
  return colourless.map((stream) =>
    classifyColourAxis(stream.corpus, byCorpus.get(stream.corpus), stream, elapsedSeconds),
  );
}
