#!/usr/bin/env bun
/**
 * In-process corpus sweep — replaces the old shell loop (see mdview/CLAUDE.md's
 * "Corpus sweep" section) which spawned the 102 MB compiled binary once per file
 * (~83ms each). Rendering in-process against `renderDocumentDetailed` directly
 * measured ~13x faster (600 vault files x 3 widths in 23.8s).
 *
 * Usage: bun run --cwd mdview sweep [--corpus <repo|reports|vault|all>] [--all]
 *                                    [--widths 80,100,160] [--limit N]
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import stringWidth from "string-width";
import { renderDocumentDetailed } from "../src/render";

export interface CorpusSpec {
  name: string;
  /** Root directory to resolve globs/walk against. */
  root: string;
  /** Glob-ish relative patterns (only `*` as a single-segment wildcard is supported). */
  globs?: string[];
  /** If true, walk the tree recursively for `**\/*.md`, excluding `exclude` substrings. */
  walkAll?: boolean;
  exclude?: string[];
}

export interface SweepOptions {
  widths: number[];
  limit?: number;
  all: boolean;
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
const DEFAULT_SAMPLE_SIZE = 300;

// Repo root is two levels up from this script (mdview/scripts/sweep.ts -> repo root).
const REPO_ROOT = join(import.meta.dir, "..", "..");

export const CORPORA: CorpusSpec[] = [
  {
    name: "repo",
    root: REPO_ROOT,
    globs: ["plans/*.md", "*/plans/*.md", "INITIATIVE.md", "*/INITIATIVE.md", "runs/dispatch/*.md", "AGENTS.md", "*/AGENTS.md"],
  },
  {
    name: "reports",
    root: join(homedir(), "code", "example-ingest", "example_reports", "reports"),
    walkAll: true,
  },
  {
    name: "vault",
    root: "/home/analyst/code/example-vault/vault",
    walkAll: true,
    exclude: ["/.obsidian/", "/.git/", "node_modules"],
  },
];

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
  }

  return { corpus, options: { widths, limit, all } };
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

  const selected =
    spec.name === "vault" && !options.all
      ? strideSample(files, options.limit ?? DEFAULT_SAMPLE_SIZE)
      : files;

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
        const { text, codeRanges } = renderDocumentDetailed(source, width);
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
  const offending = [...result.overflow.map((entry) => `overflow width=${entry.width}>${entry.targetWidth} line=${entry.line} ${relative(REPO_ROOT, entry.path)}`),
    ...result.errors.map((entry) => `error ${relative(REPO_ROOT, entry.path)}: ${entry.message}`)]
    .slice(0, 10);
  for (const line of offending) console.log(`  ${line}`);
}

async function runCli(): Promise<void> {
  const { corpus, options } = parseArgs(process.argv.slice(2));
  const targets = corpus === "all" ? CORPORA : CORPORA.filter((spec) => spec.name === corpus);
  if (targets.length === 0) {
    console.error(`unknown corpus: ${corpus} (expected one of: ${CORPORA.map((c) => c.name).join(", ")}, all)`);
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
