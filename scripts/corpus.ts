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
// The colour axis's own grammar reader (WP-5, `plans/colour-policy.md`): `scan` is what
// classifies each render's terminal sequences into the wire record, and `STYLE_TABLE` is
// what G3's SGR arm checks membership against. Neither is a second implementation — both
// are the same objects `src/inline.ts`/`src/table.ts`/etc. read to decide what to emit.
import { scan } from "../src/ansi";
import { STYLE_TABLE } from "../src/style";
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
   * `--colour-child on|off|default` — the internal re-exec marker. Set only by
   * `collectColourDigests` on the child command line it builds; a human never passes it.
   * When present, the sweep emits a digest stream (see `emitColourDigests`) instead of
   * running a sweep, and every other flag is honoured exactly as the parent honoured it.
   *
   * **`default` is the third child (WP-5, cycle-2 f9)**: no colour variable is set at all,
   * so the render resolves whatever a real piped invocation resolves. G1 reads this
   * child's stream alone — see `scripts/corpus.ts`'s colour-axis header.
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
// The colour axis - three exact gates over three children (WP-5,
// `plans/colour-policy.md`; two children and two ratchets before it, WP-1 of
// `plans/own-the-token-walk.md`)
// ---------------------------------------------------------------------------
//
// The invariant this instrument exists to measure: a colour decision may change which
// bytes a render emits; it must never change which characters it emits - and an
// undirected, piped render must emit no terminal sequence at all. Everything below is
// measurement only - no renderer source is touched and no rendered byte moves.
//
// WP-5 replaced two ratchet counters (`charDiff`/`sgrAny`, `--max-char-diff`/
// `--max-sgr`) with three exact, per-combo gates. A ratchet only fails when its number
// goes up; both were already measured at 0 (WP-3/WP-4 closed the producers behind them),
// which made them counters that could only ever pass - re-verified every run, but never
// re-specified. G1/G2/G3 below are pass/fail per `(file, width)` combo against a fixed
// definition, not a threshold compared to a seed.
//
// ## Why this is three processes
//
// This module statically imports `renderDocumentDetailed`. No colour decision in this
// renderer resolves at module load any more (WP-1/WP-2 of `plans/colour-policy.md`), so
// one process genuinely could render the same file in every mode correctly. The
// multi-child design stays anyway, and the reason is what the instrument has to prove
// rather than what the renderer can do. A colour-axis number is only evidence if the
// populations really were rendered under the modes it claims, and a child whose
// environment is fixed before its own module graph loads makes that observable from the
// child's own output - `tests/colour-axis.test.ts` asserts exactly that, against a
// hostile ambient `FORCE_COLOR`/`NO_COLOR`/`MDVIEW_COLOR`.
//
// The third child is `default` (WP-5, cycle-2 f9): the colour decision an ordinary user
// gets from `mdview file.md | somewhere`, with nothing forced either way. `on` and `off`
// each decide something (`FORCE_COLOR=3`/`FORCE_COLOR=0`); `default` decides nothing -
// every colour-related variable is absent, so `src/colour.ts`'s resolver falls all the way
// to its `isTTY` floor, which is `false` on a pipe. G1 reads this child alone: the
// default child must emit zero terminal sequences of any kind, because that piped
// default is what every consumer of this tool's stdout - a file redirect, `less`, another
// program's argument - actually receives.
//
// So the parent re-execs the sweep CLI three times, once per child, with the colour
// decision pinned (or, for `default`, deliberately left undecided) before any import
// happens. Each child renders the same population and emits a v2 digest per
// `(file, width)` - never body text, so this stays affordable over a ~44.5k-file private
// corpus - and the parent joins the three streams by key.
//
// ## Why each child's environment is built explicitly, never inherited
//
// A child that merely inherited the parent's environment would measure the machine, not
// the renderer: a developer with `FORCE_COLOR` exported would silently run every child in
// the same mode, and an axis that cannot diverge is a gate that cannot fail - the shape
// root `AGENTS.md`'s "Flag order matters" paragraph forbids. `colourChildEnv` therefore
// decides `NO_COLOR`, `MDVIEW_COLOR` and `FORCE_COLOR` for every child unconditionally
// (deleting all three for `default`, so nothing decides), and also sanitizes `TMUX` and
// `TERM` - the two inputs `resolveTmux` reads - so a harness invoked from inside a real
// tmux session, or under an unusual `TERM`, cannot leak into what G1/G3 measure.
// `tests/colour-axis.test.ts` asserts the children resolve from their observed output
// rather than from the environment the parent intended to set.

/** Which of the axis's three children a process is - the domain of `--colour-child`. */
export type ColourAxisChildMode = "on" | "off" | "default";

/** The `--colour-mode` flag's domain: run the ordinary sweep in one mode, or the axis. */
export type ColourMode = "on" | "off" | "both";

/** One recognised terminal sequence, exactly as `src/ansi.ts`'s scanner classifies it. */
export interface WireSequence {
  readonly kind: "sgr" | "osc8" | "dcs";
  readonly raw: string;
}

/**
 * The v2 digest of one `(file, width)` render, in one colour-axis child. Wire schema
 * (`plans/colour-policy.md`, WP-5): `{corpus, file, width, visibleSha, sequences,
 * malformed}` - `corpus` is this stream's own grouping key (the JSONL stream is already
 * split into per-corpus sections by the `{corpus, begin: true}` marker below; it is
 * repeated on every record so a consumer never has to carry the marker's state).
 *
 * `sequences` lists every span `scan()` classified as `sgr`, `osc8` or `dcs` - the three
 * kinds this renderer may legitimately emit - with its raw bytes, which is what lets a G1
 * or G3 failure name the offending sequence rather than only its count. A `malformed` span
 * (rule 3 of `src/ansi.ts`'s scanner: an introducer this renderer never emits, or one that
 * never terminated) is not one of the three kinds and is therefore not enumerated in
 * `sequences`; its presence is carried by the `malformed` flag instead, which every gate
 * that reads `sequences` also reads.
 */
export interface ColourDigestRecord {
  corpus: string;
  file: string;
  width: number;
  /** sha256 of `scan(text).visible` - the character channel G2 compares. */
  visibleSha: string;
  sequences: WireSequence[];
  malformed: boolean;
}

/** A render that threw in a child, carried through rather than swallowed. */
export interface ColourChildErrorRecord {
  corpus: string;
  file: string;
  width: number;
  message: string;
}

/** One child's output for one corpus. */
export interface ColourDigestStream {
  corpus: string;
  digests: ColourDigestRecord[];
  errors: ColourChildErrorRecord[];
}

/** G1: the `default` child emitted at least one sequence it should not have. */
export interface G1Failure {
  corpus: string;
  file: string;
  width: number;
  sequences: WireSequence[];
  malformed: boolean;
}

/** G2: the `on` and `off` children's visible text diverged for this combo. */
export interface G2Failure {
  corpus: string;
  file: string;
  width: number;
  onVisibleSha: string;
  offVisibleSha: string;
}

/**
 * G3: one sequence in the `on` child's render did not parse as committed-table SGR, a
 * well-formed OSC-8 hyperlink, or a strictly-parsed tmux DCS wrapper around one.
 * `sequence` is omitted when the failure is the record's bare `malformed` flag, which
 * carries no raw bytes in the v2 schema (see `ColourDigestRecord`'s doc comment).
 */
export interface G3Failure {
  corpus: string;
  file: string;
  width: number;
  sequence?: WireSequence;
  reason: string;
}

/**
 * One `(file, width)` key present in one child's stream and missing or errored in
 * another. The join iterates the union of keys across all three children (WP-5,
 * cycle-3 f8) - the two-child join this replaced mapped over one stream only, so a combo
 * present in one mode and absent from another was silently excluded from the denominator
 * rather than surfaced. `reason: "missing"` is a key absent from that child's stream
 * entirely; `"child-error"` is a key present but recorded as a per-render failure
 * (`message` carries the child's own error text).
 */
export interface ColourAxisErrorEntry {
  mode: ColourAxisChildMode;
  corpus: string;
  file: string;
  width: number;
  reason: "missing" | "child-error";
  message?: string;
}

/**
 * One corpus's result: three exact gates, each with its own failure list and count, plus
 * every join-level error. `combos` counts only `(file, width)` keys present as a
 * successful digest in all three children - a key incomplete in any of them contributes
 * to `errors` instead and is excluded from every gate's denominator, since none of
 * G1/G2/G3 can be evaluated without all three renders.
 */
export interface ColourAxisResult {
  corpus: string;
  combos: number;
  g1: number;
  g2: number;
  g3: number;
  g1Failures: G1Failure[];
  g2Failures: G2Failure[];
  g3Failures: G3Failure[];
  errors: ColourAxisErrorEntry[];
  elapsedSeconds: number;
}

/**
 * The v2 digest of one rendered document: the visible-text hash G2 compares, and the
 * ordered sequence list G1 and G3 read. Replaces `digestText` (WP-5, deleted along with
 * the `strippedSha`/`hasSgr` fields it fed and the two ratchets that read them) - `scan()`
 * already returns exactly the vocabulary the wire record needs, so it is consumed
 * directly rather than re-derived through a second pass.
 */
export function digestSequences(text: string): {
  visibleSha: string;
  sequences: WireSequence[];
  malformed: boolean;
} {
  const { visible, spans, malformed } = scan(text);
  const sequences: WireSequence[] = [];
  for (const span of spans) {
    if (span.kind === "sgr" || span.kind === "osc8" || span.kind === "dcs") {
      sequences.push({ kind: span.kind, raw: span.raw });
    }
  }
  return { visibleSha: sha256Hex(visible), sequences, malformed };
}

/**
 * The join key for one `(file, width)`.
 *
 * The separator is a literal space, not a raw byte, so - unlike `scripts/render-diff.ts`,
 * whose three raw NULs make it binary to `grep` and `rg` (see `scripts/AGENTS.md`'s note
 * on that trap) - this file stays plain text to both tools. A width is always numeric, so
 * the first space unambiguously ends it.
 */
function comboKey(path: string, width: number): string {
  return `${width} ${path}`;
}

/** The inverse of `comboKey`, for reporting a failure that was found by key alone. */
function splitComboKey(key: string): { width: number; file: string } {
  const sep = key.indexOf(" ");
  return { width: Number(key.slice(0, sep)), file: key.slice(sep + 1) };
}

/**
 * The child body: render every `(file, width)` of every requested corpus and write one
 * JSON record per line to `write`.
 *
 * The render call is byte-identical to `sweepCorpus`'s - same positional argument order,
 * same ruler default. `renderDocumentDetailed(source, targetWidth, glyphs, measure)`
 * takes its width as a positional number; passing an options object instead renders every
 * width identically, which has invalidated four separate measurements of this exact
 * quantity across three authors. Do not "tidy" this call into an object.
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
          write(JSON.stringify({ corpus: spec.name, file: path, width, error: message }));
        }
        continue;
      }
      for (const width of options.widths) {
        try {
          const measure = options.measure ?? NARROW_MEASURE;
          const { text } = renderDocumentDetailed(source, width, options.glyphs, measure);
          const { visibleSha, sequences, malformed } = digestSequences(text);
          write(JSON.stringify({ corpus: spec.name, file: path, width, visibleSha, sequences, malformed }));
        } catch (error) {
          write(
            JSON.stringify({
              corpus: spec.name,
              file: path,
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
        file: String(record.file),
        width: Number(record.width),
        message: record.error,
      });
      continue;
    }
    stream.digests.push({
      corpus,
      file: String(record.file),
      width: Number(record.width),
      visibleSha: String(record.visibleSha),
      sequences: Array.isArray(record.sequences) ? (record.sequences as WireSequence[]) : [],
      malformed: record.malformed === true,
    });
  }
  return [...streams.values()];
}

/** The sweep CLI, which is also the colour axis's child entry point. */
const SWEEP_CLI_PATH = join(import.meta.dir, "sweep.ts");

/**
 * The child environment, built explicitly rather than inherited.
 *
 * Every variable the colour resolver reads is decided here for every child - never left to
 * whatever the developer or CI happens to export - because the whole axis is worthless if
 * two children can resolve the same mode, or if `default` resolves anything at all.
 * `FORCE_COLOR=3` is the level `tests/helpers/color.ts` already uses for the forced-colour
 * side; `FORCE_COLOR=0` is an explicit "no" under `src/colour.ts`'s ratified reading of the
 * variable; `default` deletes `FORCE_COLOR` too, so nothing overrides the `isTTY` floor.
 * `TMUX` and `TERM` are sanitized on every child for the same reason - both feed
 * `resolveTmux` (`src/colour.ts`), so a harness invoked from inside a real tmux session, or
 * under an unusual `TERM`, must not leak into what G1/G3 measure. The child's stdout is a
 * pipe regardless of mode, so it is never a TTY - which is also why hyperlinks are off in
 * every child and G3's OSC-8/DCS arms are exercised by direct unit test rather than by this
 * corpus (see `tests/colour-axis.test.ts`'s injected-TTY-policy cases).
 */
export function colourChildEnv(
  mode: ColourAxisChildMode,
  base: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.NO_COLOR;
  delete env.MDVIEW_COLOR;
  delete env.TMUX;
  delete env.TERM;
  if (mode === "on") env.FORCE_COLOR = "3";
  else if (mode === "off") env.FORCE_COLOR = "0";
  else delete env.FORCE_COLOR;
  return env;
}

/**
 * Spawn one child in one colour-axis mode and collect its digest streams.
 *
 * `childArgs` is the parent's own command line with `--colour-mode` removed, so the child
 * resolves the same manifest, the same corpora, the same sampling and the same widths by
 * running the same parser over the same flags - there is no second file-selection
 * mechanism to drift. The population is the manifest corpus, and nothing else.
 */
export async function collectColourDigests(
  mode: ColourAxisChildMode,
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

// --- G3: is one `on`-child sequence one this renderer is authorized to emit? ----------

/**
 * Every SGR byte pair this renderer's committed style table (`src/style.ts`) is
 * authorized to emit, `open` and `close` both - G3's SGR arm is exact membership in this
 * set, never a pattern. `STYLE_TABLE` itself already bans `38`/`48` introducers by an
 * independent assertion (`tests/style.test.ts`), so nothing here re-derives that ban.
 */
const COMMITTED_SGR: ReadonlySet<string> = new Set(
  Object.values(STYLE_TABLE).flatMap((code) => [code.open, code.close]),
);

const DCS_ESC = String.fromCharCode(0x1b);
const DCS_TMUX_PREFIX = `${DCS_ESC}Ptmux;`;
const DCS_TERMINATOR = `${DCS_ESC}\\`;

/**
 * Undouble a tmux DCS payload's ESC bytes, strictly. `wrapOsc` (`src/ansi.ts`) doubles
 * every ESC in the sequence it wraps before framing it, so a lone, undoubled ESC inside
 * the payload is not a byte this renderer's own `link()` can produce. Returns `null` for
 * that case rather than a best-effort decode, so a hostile or corrupted payload fails
 * strictly instead of silently losing a byte.
 */
function undoubleEsc(payload: string): string | null {
  let out = "";
  let index = 0;
  while (index < payload.length) {
    if (payload[index] === DCS_ESC) {
      if (payload[index + 1] === DCS_ESC) {
        out += DCS_ESC;
        index += 2;
        continue;
      }
      return null;
    }
    out += payload[index];
    index += 1;
  }
  return out;
}

/**
 * G3's DCS arm (cycle-3 f7): a tmux wrapper is valid only when its payload, once
 * undoubled, is exactly one OSC-8 open or close and nothing else - re-scanned rather than
 * pattern-matched, so it is held to the same grammar `src/ansi.ts` uses everywhere else.
 * `scan`'s own `dcs` classification only checks the outer frame (`ESC P` ... `ESC \`);
 * this is the payload check that classification deliberately leaves to the caller,
 * because a generic scanner cannot know a payload is supposed to be an OSC-8 sequence
 * without being told what emitted it.
 */
function isValidTmuxDcs(raw: string): boolean {
  if (!raw.startsWith(DCS_TMUX_PREFIX) || !raw.endsWith(DCS_TERMINATOR)) return false;
  const payload = raw.slice(DCS_TMUX_PREFIX.length, raw.length - DCS_TERMINATOR.length);
  const decoded = undoubleEsc(payload);
  if (decoded === null) return false;
  const inner = scan(decoded);
  return inner.spans.length === 1 && inner.spans[0]?.kind === "osc8" && inner.spans[0]?.raw === decoded;
}

/**
 * G3's per-sequence classifier. SGR against `COMMITTED_SGR`; OSC-8 accepted on `scan`'s
 * own grammar alone - its `osc8` kind is only ever assigned to a well-formed hyperlink
 * (`src/ansi.ts`'s `readSequence`), so there is nothing further to check; DCS against
 * `isValidTmuxDcs`. Returns `undefined` for a valid sequence, a failure reason otherwise.
 */
function classifySequence(sequence: WireSequence): string | undefined {
  if (sequence.kind === "sgr") {
    return COMMITTED_SGR.has(sequence.raw) ? undefined : "sgr not in the committed style table";
  }
  if (sequence.kind === "osc8") return undefined;
  return isValidTmuxDcs(sequence.raw) ? undefined : "dcs payload is not a valid doubled-ESC OSC-8 open or close";
}

/** One key's status in one child's stream: a successful digest, a render error, or absent. */
type ComboStatus =
  | { status: "ok"; record: ColourDigestRecord }
  | { status: "error"; message: string }
  | { status: "missing" };

function comboLookup(stream: ColourDigestStream | undefined): Map<string, ComboStatus> {
  const map = new Map<string, ComboStatus>();
  for (const record of stream?.digests ?? []) {
    map.set(comboKey(record.file, record.width), { status: "ok", record });
  }
  for (const entry of stream?.errors ?? []) {
    map.set(comboKey(entry.file, entry.width), { status: "error", message: entry.message });
  }
  return map;
}

/**
 * Join the three children's streams for one corpus and run G1/G2/G3 over every
 * `(file, width)` combo present as a successful digest in all three.
 *
 * The union of keys is taken across all three maps (WP-5, cycle-3 f8) - the previous
 * two-child join mapped over one stream only, so a key present in one mode and absent (or
 * errored) in another was silently excluded from the denominator. Here every such key
 * becomes one `ColourAxisErrorEntry` per incomplete mode, tagged with which mode and why,
 * and the combo is excluded from every gate rather than partially evaluated.
 */
export function classifyColourAxis(
  corpus: string,
  on: ColourDigestStream | undefined,
  off: ColourDigestStream | undefined,
  defaultStream: ColourDigestStream | undefined,
  elapsedSeconds: number,
): ColourAxisResult {
  const onMap = comboLookup(on);
  const offMap = comboLookup(off);
  const defaultMap = comboLookup(defaultStream);

  const keys = new Set<string>([...onMap.keys(), ...offMap.keys(), ...defaultMap.keys()]);

  const g1Failures: G1Failure[] = [];
  const g2Failures: G2Failure[] = [];
  const g3Failures: G3Failure[] = [];
  const errors: ColourAxisErrorEntry[] = [];
  let combos = 0;

  for (const key of keys) {
    const { width, file } = splitComboKey(key);
    const perMode: [ColourAxisChildMode, ComboStatus][] = [
      ["on", onMap.get(key) ?? { status: "missing" }],
      ["off", offMap.get(key) ?? { status: "missing" }],
      ["default", defaultMap.get(key) ?? { status: "missing" }],
    ];

    let incomplete = false;
    for (const [mode, entry] of perMode) {
      if (entry.status === "missing") {
        errors.push({ mode, corpus, file, width, reason: "missing" });
        incomplete = true;
      } else if (entry.status === "error") {
        errors.push({ mode, corpus, file, width, reason: "child-error", message: entry.message });
        incomplete = true;
      }
    }
    if (incomplete) continue;

    const onRecord = (onMap.get(key) as { status: "ok"; record: ColourDigestRecord }).record;
    const offRecord = (offMap.get(key) as { status: "ok"; record: ColourDigestRecord }).record;
    const defaultRecord = (defaultMap.get(key) as { status: "ok"; record: ColourDigestRecord }).record;
    combos += 1;

    // G1: the `default` child is env-sanitized and piped, so nothing should have decided
    // to emit anything. Any sequence at all is a failure - even one this renderer is
    // otherwise authorized to emit under G3, and even a malformed one - because G1's claim
    // is about the piped default a real user gets, not about which producer is at fault.
    // An authored escape in the source passes through verbatim here too (Decision 1), so a
    // G1 failure on such a file is correct output, incorrectly shaped for this gate's
    // "zero bytes" claim - which is exactly why the failure record carries the sequence's
    // raw bytes rather than only a count (`tests/colour-axis.test.ts` pins the authored
    // case as a deliberate, legible G1 failure, not a defect).
    if (defaultRecord.sequences.length > 0 || defaultRecord.malformed) {
      g1Failures.push({
        corpus,
        file,
        width,
        sequences: defaultRecord.sequences,
        malformed: defaultRecord.malformed,
      });
    }

    // G2: the character channel. Colour may change bytes; it must never change which
    // characters a reader sees.
    if (onRecord.visibleSha !== offRecord.visibleSha) {
      g2Failures.push({
        corpus,
        file,
        width,
        onVisibleSha: onRecord.visibleSha,
        offVisibleSha: offRecord.visibleSha,
      });
    }

    // G3: every sequence the coloured render actually emitted must parse as this
    // renderer's own committed SGR, a well-formed OSC-8 hyperlink, or a strictly-parsed
    // tmux DCS wrapper around one. A malformed span fails outright: nothing this renderer
    // emits is ever malformed by construction, so one in the `on` child's render is
    // either an authored escape (legitimate, per Decision 1, but still not one G3 can
    // vouch for) or a real defect - either way, worth a name in the failure list.
    for (const sequence of onRecord.sequences) {
      const reason = classifySequence(sequence);
      if (reason !== undefined) g3Failures.push({ corpus, file, width, sequence, reason });
    }
    if (onRecord.malformed) {
      g3Failures.push({ corpus, file, width, reason: "malformed sequence in the colour-on render" });
    }
  }

  return {
    corpus,
    combos,
    g1: g1Failures.length,
    g2: g2Failures.length,
    g3: g3Failures.length,
    g1Failures,
    g2Failures,
    g3Failures,
    errors,
    elapsedSeconds,
  };
}

/**
 * Run the whole axis: all three children, in parallel, then the join, one corpus at a
 * time over the union of corpus names any child reported (WP-5, cycle-3 f8) - a corpus
 * resolved by one child and not another is exactly the failure mode a single-stream
 * iteration order would hide.
 */
export async function runColourAxis(childArgs: string[]): Promise<ColourAxisResult[]> {
  const started = performance.now();
  const [on, off, defaultStreams] = await Promise.all([
    collectColourDigests("on", childArgs),
    collectColourDigests("off", childArgs),
    collectColourDigests("default", childArgs),
  ]);
  const elapsedSeconds = (performance.now() - started) / 1000;

  const byCorpus = (streams: ColourDigestStream[]) => new Map(streams.map((stream) => [stream.corpus, stream]));
  const onByCorpus = byCorpus(on);
  const offByCorpus = byCorpus(off);
  const defaultByCorpus = byCorpus(defaultStreams);

  return unionCorpusNames(on, off, defaultStreams).map((corpus) =>
    classifyColourAxis(
      corpus,
      onByCorpus.get(corpus),
      offByCorpus.get(corpus),
      defaultByCorpus.get(corpus),
      elapsedSeconds,
    ),
  );
}

/**
 * The union of corpus names across the axis's three children, in first-seen order over
 * `[on, off, default]`. Exported so the corpus-only-in-one-mode case — a corpus resolved
 * by one child's stream and absent from another's — can be pinned directly against
 * synthetic streams, rather than depending on a real three-process race to reproduce it.
 */
export function unionCorpusNames(
  on: ColourDigestStream[],
  off: ColourDigestStream[],
  defaultStreams: ColourDigestStream[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const stream of [...on, ...off, ...defaultStreams]) {
    if (seen.has(stream.corpus)) continue;
    seen.add(stream.corpus);
    names.push(stream.corpus);
  }
  return names;
}
