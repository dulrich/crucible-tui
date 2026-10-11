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
 * **Those two questions are now the whole of this file** (WP-R1,
 * `plans/post-refactor-code-quality-remediation.md`). The colour axis — four child
 * processes, three exact gates, the wire record and the join — lived below `sweepCorpus`
 * here and is `scripts/colour-axis.ts` now, unchanged. That module imports *this* one;
 * this one imports no instrument at all. The direction is the point: to digest a render
 * the axis needed `sha256Hex`, which lived in `scripts/render-diff.ts`, which needed
 * `parseWidths` from `scripts/sweep.ts`, which needed this library — so the sweep's library
 * imported two CLIs to reach one four-line function. The comment that used to sit on that
 * import argued the cycle was benign at run time, and it was right, which is exactly how it
 * survived three work packages. `tests/scripts-acyclic.test.ts` is the gate now.
 *
 * **This module is a measurement instrument, not a build script.** Its numbers are
 * compared against dated full-corpus runs in a separate private archive repo, which this
 * file deliberately does not name or locate. The gates that run it exit on
 * `overflow`/`errors` alone, so a changed sample, a changed width order, a changed error
 * string or a changed detector accumulator passes every gate in this repo while
 * invalidating every archived comparison. Anything here that looks like a defect —
 * `--limit` doing nothing without `sample`, the hardcoded `elapsedSeconds: 0` on the
 * missing-root state, `shearsUnmapped` accumulating the orphan count, the two different
 * error-string shapes — is recorded behaviour, pinned in `tests/sweep-manifest.test.ts`/
 * `tests/sweep-cli.test.ts` (since split), and is
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

/**
 * Which of the axis's four children a process is — the domain of `--colour-child`.
 *
 * This and `ColourMode` are the two flag domains `SweepOptions` below declares fields of, so
 * they stay here with the options record even though the axis that acts on them moved to
 * `scripts/colour-axis.ts` at WP-R1. That module imports them from here; nothing here
 * imports it.
 */
export type ColourAxisChildMode = "on" | "off" | "default" | "formats";

/** The `--colour-mode` flag's domain: run the ordinary sweep in one mode, or the axis. */
export type ColourMode = "on" | "off" | "both";

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
   * `--colour-child on|off|default|formats` — the internal re-exec marker. Set only by
   * `collectColourDigests` on the child command line it builds; a human never passes it.
   * When present, the sweep emits a digest stream (see `emitColourDigests`) instead of
   * running a sweep, and every other flag is honoured exactly as the parent honoured it.
   *
   * **`default` is the third child (WP-5, cycle-2 f9)**: no colour variable is set at all,
   * so the render resolves whatever a real piped invocation resolves. G1 reads this
   * child's stream alone — see `scripts/corpus.ts`'s colour-axis header. **`formats` is the
   * fourth (WP-4, `plans/colour-modes.md`)**: pinned via `MDVIEW_COLOR=never`, one of the
   * three explicit `never`-directive routes Decision 5 of that plan moved off the `none`
   * output onto the format-preserving one. G2 and G3 both read it.
   */
  colourChild?: ColourAxisChildMode;
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
    throw new Error(`corpus manifest ${manifestPath} is not valid JSON: ${message}`, { cause: error });
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
    throw new Error(`cannot read corpus manifest at ${manifestPath}: ${reason}`, { cause: error });
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
 * `tests/sweep-cli.test.ts`: the widths are iterated **in the order given** (which fixes
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
            // could not label, and that is a count of orphans. Pinned in tests/sweep-cli.test.ts.
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
