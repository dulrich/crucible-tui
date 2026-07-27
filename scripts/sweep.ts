#!/usr/bin/env bun
/**
 * In-process corpus sweep — replaces the old shell loop (see mdview/AGENTS.md's
 * "Corpus sweep" section) which spawned the 102 MB compiled binary once per file
 * (~83ms each). Rendering in-process against `renderDocumentDetailed` directly
 * measured ~13x faster (600 vault files x 3 widths in 23.8s).
 *
 * Corpus roots are no longer hardcoded here (WP-1) — they are loaded from a
 * versioned JSON manifest, resolved with this precedence, highest first:
 *   1. `--manifest <path>` (this CLI flag)
 *   2. `MDVIEW_CORPUS_MANIFEST` environment variable
 *   3. config key `corpusManifest` (see `src/config.ts`)
 *   4. the bundled public-safe default (`corpus/default-manifest.json`)
 *
 * The private validation manifest (covering the full example-tracker corpus,
 * ~45k files) lives in the separate `example-harness/example-corpus/` repo —
 * see that repo's README for provenance and `measurements/` for recorded runs.
 *
 * Usage: bun run --cwd mdview sweep [--corpus <name|all>] [--all]
 *                                    [--widths 80,100,160] [--limit N]
 *                                    [--glyphs unicode|ascii] [--manifest <path>]
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import stringWidth from "string-width";
import { renderDocumentDetailed } from "../src/render";
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "../src/glyphs";
import { loadConfig, resolveCorpusManifestPath, type ManifestSource } from "../src/config";

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

export interface CorpusResult {
  name: string;
  skipped: boolean;
  skipReason?: string;
  filesScanned: number;
  combos: number;
  overflow: OverflowEntry[];
  errors: ErrorEntry[];
  elapsedSeconds: number;
}

const DEFAULT_WIDTHS = [80, 100, 160];

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

async function walkMarkdown(root: string, exclude: string[]): Promise<string[]> {
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
 * Resolve the file list for one corpus. Returns `null` (with a notice already
 * logged by the caller via `skipped`) if the corpus root does not exist.
 */
export async function resolveCorpusFiles(spec: CorpusSpec): Promise<string[] | null> {
  try {
    const info = await stat(spec.root);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }

  if (spec.walkAll) {
    return walkMarkdown(spec.root, spec.exclude ?? []);
  }

  const all = new Set<string>();
  for (const glob of spec.globs ?? []) {
    const matches = await expandGlob(spec.root, glob);
    for (const match of matches) all.add(match);
  }
  return [...all];
}

/**
 * Flag the first line (not exempt via `codeRanges`) whose display width exceeds
 * `targetWidth`. Mirrors `src/cli.ts`'s `checkOverflow`, but returns every overflow
 * instead of stopping at the first — the sweep wants all offending paths, not just
 * the first one found.
 */
export function findOverflow(
  output: string,
  targetWidth: number,
  codeRanges: Array<[number, number]>,
): { line: number; width: number } | null {
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const exempt = codeRanges.some(([start, end]) => lineNumber >= start && lineNumber <= end);
    if (exempt) continue;
    const width = stringWidth(lines[index] ?? "");
    if (width > targetWidth) {
      return { line: lineNumber, width };
    }
  }
  return null;
}

export function parseArgs(argv: string[]): { corpus: string; options: SweepOptions } {
  let corpus = "all";
  let widths = DEFAULT_WIDTHS;
  let limit: number | undefined;
  let all = false;
  let glyphs: GlyphSet = UNICODE_GLYPHS;
  let manifestFlag: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--corpus") {
      const value = argv[index + 1];
      if (!value) throw new Error("missing value for --corpus");
      corpus = value;
      index += 1;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--widths") {
      const value = argv[index + 1];
      if (!value) throw new Error("missing value for --widths");
      widths = value.split(",").map((part) => {
        const parsed = Number(part.trim());
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--widths must be positive numbers, got: ${part}`);
        }
        return parsed;
      });
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) throw new Error("missing value for --limit");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--limit must be a positive number, got: ${value}`);
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--glyphs") {
      const value = argv[index + 1];
      if (value !== "unicode" && value !== "ascii") {
        throw new Error(`--glyphs must be "unicode" or "ascii", got: ${value}`);
      }
      glyphs = value === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
      index += 1;
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[index + 1];
      if (!value) throw new Error("missing value for --manifest");
      manifestFlag = value;
      index += 1;
      continue;
    }
  }

  return { corpus, options: { widths, limit, all, glyphs, manifestFlag } };
}

export async function sweepCorpus(spec: CorpusSpec, options: SweepOptions): Promise<CorpusResult> {
  const started = performance.now();
  const files = await resolveCorpusFiles(spec);

  if (files === null) {
    return {
      name: spec.name,
      skipped: true,
      skipReason: `corpus root not found: ${spec.root}`,
      filesScanned: 0,
      combos: 0,
      overflow: [],
      errors: [],
      elapsedSeconds: 0,
    };
  }

  // An existing-but-empty corpus is an error, not a skip — the plan calls this out
  // explicitly (a corpus silently returning zero files could otherwise mask a broken
  // glob or a moved directory).
  if (files.length === 0) {
    return {
      name: spec.name,
      skipped: false,
      filesScanned: 0,
      combos: 0,
      overflow: [],
      errors: [{ path: spec.root, message: "corpus exists but matched 0 files" }],
      elapsedSeconds: (performance.now() - started) / 1000,
    };
  }

  // `sample` (manifest-driven) replaces the old `spec.name === "vault"` hardcode:
  // a corpus is only ever sampled if its spec sets `sample`. `--all` always
  // disables sampling; `--limit` overrides the manifest's `sample` value, but
  // (matching the old vault-only behavior exactly, just generalized past one
  // hardcoded name) only has an effect on a corpus that declares one.
  const samplingApplies = spec.sample !== undefined && !options.all;
  const effectiveSampleSize = samplingApplies ? (options.limit ?? spec.sample) : undefined;
  const selected = effectiveSampleSize !== undefined ? strideSample(files, effectiveSampleSize) : files;

  const overflow: OverflowEntry[] = [];
  const errors: ErrorEntry[] = [];
  let combos = 0;

  for (const path of selected) {
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      errors.push({ path, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const width of options.widths) {
      combos += 1;
      try {
        const { text, codeRanges } = renderDocumentDetailed(source, width, options.glyphs);
        const found = findOverflow(text, width, codeRanges);
        if (found) {
          overflow.push({ path, width: found.width, targetWidth: width, line: found.line });
        }
      } catch (error) {
        errors.push({
          path,
          message: `width ${width}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return {
    name: spec.name,
    skipped: false,
    filesScanned: selected.length,
    combos,
    overflow,
    errors,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
}

function printResult(result: CorpusResult): void {
  if (result.skipped) {
    console.log(`[${result.name}] SKIPPED — ${result.skipReason}`);
    return;
  }
  console.log(
    `[${result.name}] files=${result.filesScanned} combos=${result.combos} ` +
      `overflow=${result.overflow.length} errors=${result.errors.length} ` +
      `elapsed=${result.elapsedSeconds.toFixed(1)}s`,
  );
  // Absolute paths: corpus roots can live anywhere on the filesystem (a private
  // manifest routinely points outside this repo entirely), so a single
  // "relative to one repo root" display no longer means anything consistent.
  const offending = [
    ...result.overflow.map(
      (entry) => `overflow width=${entry.width}>${entry.targetWidth} line=${entry.line} ${entry.path}`,
    ),
    ...result.errors.map((entry) => `error ${entry.path}: ${entry.message}`),
  ].slice(0, 10);
  for (const line of offending) console.log(`  ${line}`);
}

async function runCli(): Promise<void> {
  const { corpus, options } = parseArgs(process.argv.slice(2));

  const { path: manifestPath, source: manifestSource } = await resolveManifestSource(options.manifestFlag);
  console.log(`corpus manifest: ${manifestPath} (${manifestSource})`);
  if (manifestSource === "bundled") {
    console.log("NOTE: bundled sample manifest — this is NOT the validation corpus");
  }

  let manifest: CorpusManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  console.log(`glyphs=${options.glyphs.tier}`);

  const targets = corpus === "all" ? manifest.corpora : manifest.corpora.filter((spec) => spec.name === corpus);
  if (targets.length === 0) {
    console.error(
      `unknown corpus: ${corpus} (expected one of: ${manifest.corpora.map((c) => c.name).join(", ")}, all)`,
    );
    process.exit(1);
  }

  let anyFailure = false;
  for (const spec of targets) {
    const result = await sweepCorpus(spec, options);
    printResult(result);
    if (!result.skipped && (result.overflow.length > 0 || result.errors.length > 0)) {
      anyFailure = true;
    }
  }

  process.exit(anyFailure ? 1 : 0);
}

if (import.meta.main) {
  await runCli();
}
