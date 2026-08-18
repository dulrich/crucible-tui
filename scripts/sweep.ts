#!/usr/bin/env bun
/**
 * In-process corpus sweep — replaces the old shell loop (see scripts/AGENTS.md's
 * "Corpus sweep" section) which spawned the 102 MB compiled binary once per file
 * (~83ms each). Rendering in-process against `renderDocumentDetailed` directly
 * measured ~13x faster (600 vault files x 3 widths in 23.8s).
 *
 * **This file is the CLI half only** (WP-4): argument parsing, the printed summary, the
 * ratchet thresholds and the exit-code contract. Corpus discovery and evaluation — the
 * manifest, the walk, the sampling policy, and `sweepCorpus` itself — live in
 * `scripts/corpus.ts`, which `scripts/emoji-audit.ts` imports too. That split exists
 * because the sampling policy had already been copied into the audit and had drifted;
 * see that module's header.
 *
 * Corpus roots are not hardcoded here (WP-1) — they are loaded from a versioned JSON
 * manifest, resolved with this precedence, highest first:
 *   1. `--manifest <path>` (this CLI flag)
 *   2. `MDVIEW_CORPUS_MANIFEST` environment variable
 *   3. config key `corpusManifest` (see `src/config.ts`)
 *   4. the bundled public-safe default (`corpus/default-manifest.json`)
 *
 * The private validation manifest (covering the full ~45k-file corpus) lives in a
 * separate private archive repo, which this file deliberately does not name or
 * locate — see that archive's README for provenance and its `measurements/` for
 * recorded runs. Point `MDVIEW_CORPUS_MANIFEST` at your own manifest to reproduce.
 *
 * **The parser below is deliberately written flag-by-flag rather than driven by a
 * declarative specification.** Its fourteen flags reduce to five validation shapes, three
 * of which need per-flag behaviour anyway (`--widths` delegates to `parseWidths`, the two
 * detector `--max-*` flags also turn detection on and the two colour ones also turn the
 * axis on), so a spec plus a dispatcher costs the same and makes the one thing this parser
 * has to support harder: reading it line by line against an archived command line to
 * establish what a recorded run measured.
 *
 * Usage: bun run sweep [--corpus <name|all>] [--all]
 *                                    [--widths 80,100,160] [--limit N]
 *                                    [--glyphs unicode|ascii] [--manifest <path>]
 *                                    [--ambiguous narrow|wide]
 *                                    [--colour-mode on|off|both]
 *                                    [--max-char-diff N] [--max-sgr N]
 *
 * **`--colour-mode` is not spelled `--color`, and never may be** (WP-1,
 * `plans/own-the-token-walk.md`). `has-flag` — which `supports-color` and
 * `@colors/colors` both consult — scans the whole of `process.argv`, so a harness flag
 * spelled `--color` or `--no-color` would silently flip the colour decision of the very
 * renderer this instrument is measuring. The axis itself lives in `scripts/corpus.ts`
 * with the rest of the render seam; this file owns its flags, its printed line and its
 * two ratchets.
 */
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "../src/glyphs";
import { NARROW_MEASURE, measureFor, type Measure } from "../src/width";
import {
  colourChildEnv,
  emitColourDigests,
  loadManifest,
  resolveManifestSource,
  runColourAxis,
  sweepCorpus,
  type ColourAxisMode,
  type ColourAxisResult,
  type ColourMode,
  type CorpusManifest,
  type CorpusResult,
  type SweepOptions,
} from "./corpus";


/**
 * **116 and 346 are two of the user's three real terminal widths** (the three tiled
 * layouts are 116 / 172 / 346), added in WP-2c. Until then this swept 80/100/160 —
 * none of which anyone reads at — and the tight-list orphan defect was consequently
 * measured only at widths that do not exist on this machine. A defect measured at an
 * unused width is measured wrong, in either direction.
 *
 * 80, 100 and 160 are kept rather than swapped out: they are the recorded baseline for
 * every dated full-corpus run in the private archive's `measurements/`, and 80 is the
 * narrowest case the table allocator has to survive (it is where the accepted-by-design
 * many-column overflows in `src/AGENTS.md` live). Adding widths only ever adds combos.
 */
const DEFAULT_WIDTHS = [80, 100, 116, 160, 346];

/**
 * Parse a `--widths` value: a comma list (`80,100,160`), an inclusive range
 * (`40-360`), or any mix of the two (`40-80,116,346`).
 *
 * The range form exists because **orphan defects are sharply width-sensitive** — an
 * orphan only exists when an authored line's length plus the item's marker and indent
 * straddles the target, so a note fails at some widths and is clean at others. The
 * measured swing was 9x across 16 columns, which means a three-width gate samples this
 * defect class essentially at random: the old 80/100/160 set was telling us about
 * 80/100/160 and nothing else. Sweeping a dense range only became affordable by
 * inverting the axes — few files x every width, instead of every file x few widths.
 */
export function parseWidths(value: string): number[] {
  const widths: number[] = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from <= 0 || to <= 0) throw new Error(`--widths must be positive numbers, got: ${part}`);
      if (to < from) throw new Error(`--widths range must be ascending, got: ${part}`);
      for (let width = from; width <= to; width += 1) widths.push(width);
      continue;
    }
    const parsed = Number(part);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--widths must be positive numbers, got: ${part}`);
    }
    widths.push(parsed);
  }
  if (widths.length === 0) throw new Error("--widths resolved to no widths");
  return [...new Set(widths)];
}

export function parseArgs(argv: string[]): { corpus: string; options: SweepOptions } {
  let corpus = "all";
  let widths = DEFAULT_WIDTHS;
  let limit: number | undefined;
  let all = false;
  let glyphs: GlyphSet = UNICODE_GLYPHS;
  let measure: Measure = NARROW_MEASURE;
  let manifestFlag: string | undefined;
  let detect = false;
  let maxOrphans: number | undefined;
  let maxOverIndent: number | undefined;
  let colourMode: ColourMode = "off";
  let colourChild: ColourAxisMode | undefined;
  let maxCharDiff: number | undefined;
  let maxSgr: number | undefined;

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
      widths = parseWidths(value);
      index += 1;
      continue;
    }
    if (arg === "--detect") {
      detect = true;
      continue;
    }
    if (arg === "--max-orphans") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--max-orphans must be a non-negative number, got: ${value}`);
      }
      maxOrphans = parsed;
      detect = true;
      index += 1;
      continue;
    }
    if (arg === "--max-over-indent") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--max-over-indent must be a non-negative number, got: ${value}`);
      }
      maxOverIndent = parsed;
      detect = true;
      index += 1;
      continue;
    }
    if (arg === "--colour-mode") {
      // Not `--color`. See this file's header: `has-flag` scans the whole argv, so that
      // spelling would flip the colour decision of the thing being measured.
      const value = argv[index + 1];
      if (value !== "on" && value !== "off" && value !== "both") {
        throw new Error(`--colour-mode must be "on", "off" or "both", got: ${value}`);
      }
      colourMode = value;
      index += 1;
      continue;
    }
    if (arg === "--colour-child") {
      // Internal: set by `collectColourDigests` on the command line it builds for each
      // child. A human never passes it, and it is not documented in the usage line.
      const value = argv[index + 1];
      if (value !== "on" && value !== "off") {
        throw new Error(`--colour-child must be "on" or "off", got: ${value}`);
      }
      colourChild = value;
      index += 1;
      continue;
    }
    if (arg === "--max-char-diff") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--max-char-diff must be a non-negative number, got: ${value}`);
      }
      maxCharDiff = parsed;
      // Same precedent as `--max-orphans` turning `--detect` on: a threshold for a
      // measurement that is not being taken is a gate that cannot fail.
      colourMode = "both";
      index += 1;
      continue;
    }
    if (arg === "--max-sgr") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--max-sgr must be a non-negative number, got: ${value}`);
      }
      maxSgr = parsed;
      colourMode = "both";
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
    if (arg === "--ambiguous") {
      const value = argv[index + 1];
      if (value !== "narrow" && value !== "wide") {
        throw new Error(`--ambiguous must be "narrow" or "wide", got: ${value}`);
      }
      measure = measureFor(value);
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

  return {
    corpus,
    options: {
      widths,
      limit,
      all,
      glyphs,
      measure,
      manifestFlag,
      detect,
      maxOrphans,
      maxOverIndent,
      colourMode,
      colourChild,
      maxCharDiff,
      maxSgr,
    },
  };
}

export function printResult(result: CorpusResult, detect: boolean): void {
  if (result.skipped) {
    console.log(`[${result.name}] SKIPPED — ${result.skipReason}`);
    return;
  }
  const orphanTotal = result.orphans.reduce((sum, entry) => sum + entry.count, 0);
  const shearTotal = result.shears.reduce((sum, entry) => sum + entry.count, 0);
  const driftTotal = result.overIndent.reduce((sum, entry) => sum + entry.count, 0);
  console.log(
    `[${result.name}] files=${result.filesScanned} combos=${result.combos} ` +
      `overflow=${result.overflow.length} errors=${result.errors.length} ` +
      (detect
        ? `orphans=${orphanTotal} (${result.orphans.length} file-widths) ` +
          `shears=${shearTotal} (${result.shears.length} file-widths, ` +
          `${result.shearsUnmapped} unmapped) ` +
          `overIndent=${driftTotal} (${result.overIndent.length} file-widths) ` +
          `tableOverflow=${result.tableOverflow} `
        : "") +
      `elapsed=${result.elapsedSeconds.toFixed(1)}s`,
  );
  if (result.symlinkedDirsSkipped > 0) {
    // Disclosure, not a warning: symlinked subtrees are excluded from the walk by
    // design (see `canonicalizeAndDedupe`'s comment on `walkMarkdown`), and this makes
    // that decision visible per corpus instead of leaving it a silent skip. Informational
    // only — never affects `anyFailure`/the exit code.
    const noun = result.symlinkedDirsSkipped === 1 ? "directory" : "directories";
    console.log(
      `NOTE: [${result.name}] ${result.symlinkedDirsSkipped} symlinked ${noun} excluded by design — ` +
        "symlinked subtrees are not swept",
    );
  }
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

/**
 * The colour axis's printed line: **all three buckets, plus both totals**, on one line
 * per corpus.
 *
 * The disjoint buckets are printed because they are what a reader assumes a two-way
 * comparison produced, and the totals are printed beside them because the totals are what
 * the ratchets read. `sgrOnly` alone misses every combo that carries unwanted SGR *and* a
 * character difference — measured at roughly half of them — so a reader who takes
 * `sgrOnly` for "the unwanted SGR count" is reading the wrong number. Both are here so
 * neither can be mistaken for the other.
 */
export function printColourAxis(axis: ColourAxisResult): void {
  console.log(
    `[${axis.corpus}] colour-axis combos=${axis.combos} ` +
      `charDiff=${axis.charDiff} (charDiffOnly=${axis.charDiffOnly} both=${axis.both}) ` +
      `sgrAny=${axis.sgrAny} (sgrOnly=${axis.sgrOnly} both=${axis.both}) ` +
      `identical=${axis.identical} errors=${axis.errors.length} ` +
      `elapsed=${axis.elapsedSeconds.toFixed(1)}s`,
  );
  for (const entry of axis.errors.slice(0, 10)) {
    console.log(`  colour-axis error width=${entry.width} ${entry.path}: ${entry.message}`);
  }
}

/**
 * The parent's own command line, with `--colour-mode <value>` removed.
 *
 * Every other flag is passed through untouched, so each child resolves the same manifest,
 * the same corpora, the same sampling and the same widths by running **this same parser**
 * over them. That is what pins the population in committed source: there is no second
 * file-selection mechanism for the axis, only the manifest corpus the sweep already had.
 */
export function stripColourModeArgs(argv: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--colour-mode") {
      index += 1;
      continue;
    }
    kept.push(argv[index] as string);
  }
  return kept;
}

/**
 * `--colour-child on|off`: emit a digest stream instead of sweeping.
 *
 * **Nothing but JSONL reaches stdout here** — the manifest banner, the tier line and the
 * per-corpus summary are all skipped, because the parent parses this stream. Diagnostics
 * go to stderr, which the parent surfaces when a child exits non-zero.
 */
async function runColourChild(corpus: string, options: SweepOptions): Promise<void> {
  const { path: manifestPath } = await resolveManifestSource(options.manifestFlag);
  let manifest: CorpusManifest;
  try {
    manifest = await loadManifest(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const targets = corpus === "all" ? manifest.corpora : manifest.corpora.filter((spec) => spec.name === corpus);
  if (targets.length === 0) {
    console.error(
      `unknown corpus: ${corpus} (expected one of: ${manifest.corpora.map((c) => c.name).join(", ")}, all)`,
    );
    process.exit(1);
  }
  // Flushed in chunks rather than per record: a full private-corpus run is ~220k lines,
  // and neither one write syscall per line nor one 40 MB string is the right shape.
  let buffer: string[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    process.stdout.write(`${buffer.join("\n")}\n`);
    buffer = [];
  };
  await emitColourDigests(targets, options, (line) => {
    buffer.push(line);
    if (buffer.length >= 512) flush();
  });
  flush();
}

/**
 * `--colour-mode on`: the sweep itself, one process deeper, rendered in colour.
 *
 * The colour decision has to be pinned before the child's module graph loads, which is
 * why this is a re-exec rather than a flag the renderer reads. `--colour-mode off` is
 * appended **last** because the parser is last-write-wins and `--max-char-diff` in the
 * inherited argv would otherwise turn the axis back on inside the child.
 */
async function reExecInColour(argv: string[]): Promise<number> {
  const childArgs = [...stripColourModeArgs(argv), "--colour-mode", "off"];
  const proc = Bun.spawn([process.execPath, "run", import.meta.path, ...childArgs], {
    env: colourChildEnv("on", process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function runCli(): Promise<void> {
  const argv = process.argv.slice(2);
  const { corpus, options } = parseArgs(argv);

  if (options.colourChild !== undefined) {
    await runColourChild(corpus, options);
    return;
  }
  if (options.colourMode === "on") {
    process.exit(await reExecInColour(argv));
  }

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

  const ambiguous = (options.measure ?? NARROW_MEASURE).ambiguous;
  console.log(`glyphs=${options.glyphs.tier} ambiguous=${ambiguous}`);
  // The sweep keeps these two axes independent *on purpose*, while `src/cli.ts` does
  // not: `resolveGlyphs` refuses to hand out the Unicode tier in wide mode, because
  // that tier's own glyphs are ambiguous and its tables cannot be laid out (see
  // `wideForcesAscii`). Forcing the same rule here would make the residual it was
  // discovered by unmeasurable, and an instrument that cannot reproduce the finding is
  // not an instrument. So the combination stays reachable and is labelled instead.
  if (ambiguous === "wide" && options.glyphs.tier === "unicode") {
    console.log(
      "NOTE: --ambiguous wide with the unicode tier is a diagnostic combination the CLI never " +
        "produces (wide forces the ascii tier); expect overflow from ambiguous box-drawing glyphs",
    );
  }

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
    printResult(result, options.detect);
    if (!result.skipped && (result.overflow.length > 0 || result.errors.length > 0)) {
      anyFailure = true;
    }
    // The detector thresholds are a **ratchet**: the regression corpus is a set of notes
    // that are currently known-broken, so its expected orphan count is not zero and
    // pinning it to zero would just mean never running it. What must not happen is the
    // number going *up*. The current values live beside the corpus, in the private
    // archive's README — not here, because a public clone has no regression corpus.
    const orphanTotal = result.orphans.reduce((sum, entry) => sum + entry.count, 0);
    const driftTotal = result.overIndent.reduce((sum, entry) => sum + entry.count, 0);
    if (options.maxOrphans !== undefined && orphanTotal > options.maxOrphans) {
      console.error(`[${result.name}] orphans=${orphanTotal} exceeds --max-orphans ${options.maxOrphans}`);
      anyFailure = true;
    }
    if (options.maxOverIndent !== undefined && driftTotal > options.maxOverIndent) {
      console.error(`[${result.name}] overIndent=${driftTotal} exceeds --max-over-indent ${options.maxOverIndent}`);
      anyFailure = true;
    }
  }

  if (options.colourMode === "both") {
    // Two fresh processes, one per mode — see `scripts/corpus.ts`'s colour-axis section
    // for why a second mode cannot be reached from inside this one.
    for (const axis of await runColourAxis(stripColourModeArgs(argv))) {
      printColourAxis(axis);
      // An unpaired combo or a child render failure is an instrument fault, and an
      // instrument that fails quietly is the failure mode this whole package exists to
      // avoid. It fails the run exactly like a sweep error does.
      if (axis.errors.length > 0) anyFailure = true;
      if (options.maxCharDiff !== undefined && axis.charDiff > options.maxCharDiff) {
        console.error(`[${axis.corpus}] charDiff=${axis.charDiff} exceeds --max-char-diff ${options.maxCharDiff}`);
        anyFailure = true;
      }
      if (options.maxSgr !== undefined && axis.sgrAny > options.maxSgr) {
        console.error(`[${axis.corpus}] sgrAny=${axis.sgrAny} exceeds --max-sgr ${options.maxSgr}`);
        anyFailure = true;
      }
    }
  }

  process.exit(anyFailure ? 1 : 0);
}

if (import.meta.main) {
  await runCli();
}
