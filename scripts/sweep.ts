#!/usr/bin/env bun
/**
 * In-process corpus sweep — replaces the old shell loop (see scripts/AGENTS.md's
 * "Corpus sweep" section) which spawned the 102 MB compiled binary once per file
 * (~83ms each). Rendering in-process against `renderDocumentDetailed` directly
 * measured ~13x faster (600 vault files x 3 widths in 23.8s).
 *
 * **This file is the CLI half only** (WP-4): argument parsing, the printed summary, and
 * the exit-code contract. Corpus discovery and evaluation — the manifest, the walk, the
 * sampling policy, and `sweepCorpus` itself — live in `scripts/corpus.ts`, which
 * `scripts/emoji-audit.ts` imports too. That split exists because the sampling policy had
 * already been copied into the audit and had drifted; see that module's header.
 *
 * Corpus roots are not hardcoded here (WP-1) — they are loaded from a versioned JSON
 * manifest, resolved with this precedence, highest first:
 *   1. `--manifest <path>` (this CLI flag)
 *   2. `MDVIEW_CORPUS_MANIFEST` environment variable
 *   3. config key `corpusManifest` (see `TS_BASELINE` `src/config.ts`)
 *   4. the bundled public-safe default (`corpus/default-manifest.json`)
 *
 * The private validation manifest (covering the full ~45k-file corpus) lives in a
 * separate private archive repo, which this file deliberately does not name or
 * locate — see that archive's README for provenance and its `measurements/` for
 * recorded runs. Point `MDVIEW_CORPUS_MANIFEST` at your own manifest to reproduce.
 *
 * **The parser below is deliberately written flag-by-flag rather than driven by a
 * declarative specification.** Its flags reduce to a handful of validation shapes, and
 * some need per-flag behaviour anyway (`--widths` delegates to `parseWidths`, the two
 * detector `--max-*` flags also turn detection on), so a spec plus a dispatcher costs the
 * same and makes the one thing this parser has to support harder: reading it line by line
 * against an archived command line to establish what a recorded run measured.
 *
 * Usage: bun run sweep [--corpus <name|all>] [--all]
 *                                    [--widths 80,100,160] [--limit N]
 *                                    [--glyphs unicode|ascii] [--manifest <path>]
 *                                    [--ambiguous narrow|wide]
 *                                    [--colour-mode on|off|both]
 *
 * **`--colour-mode` is not spelled `--color`, and never may be** (WP-1,
 * `plans/own-the-token-walk.md`). `has-flag` — which `supports-color` consulted, and
 * `@colors/colors` too until WP-2 of `plans/colour-policy.md` removed both from the
 * runtime closure — scans the whole of `process.argv`, so a harness flag spelled
 * `--color` or `--no-color` silently flipped the colour decision of the very renderer this
 * instrument measures. The rule outlived both packages: `--color` is now `mdview`'s own
 * flag and the highest slot of the ratified precedence matrix, so that spelling would be
 * read by the renderer directly. The axis itself — three exact gates over four children
 * since WP-4 of `plans/colour-modes.md` added `formats` (three children at WP-5,
 * `plans/colour-policy.md`, replacing the two ratchet ceilings this file used to carry as
 * `--max-char-diff`/`--max-sgr`) — lives in `scripts/colour-axis.ts`; it lived in
 * `scripts/corpus.ts` with the rest of the render seam until WP-R1 of
 * `plans/post-refactor-code-quality-remediation.md` gave it its own module. Either way this
 * file owns its flags, its printed line and its exit code.
 */
import { NARROW_MEASURE, measureFor, type Measure } from "./measure/width";
import { type GlyphTierName } from "./revision";
import {
  colourChildEnv,
  emitColourDigests,
  runColourAxis,
  type ColourAxisResult,
} from "./colour-axis";
import {
  loadManifest,
  resolveManifestSource,
  sweepCorpus,
  type ColourAxisChildMode,
  type ColourMode,
  type CorpusManifest,
  type CorpusResult,
  type SweepOptions,
} from "./corpus";
// `DEFAULT_WIDTHS` and `parseWidths` were declared here and imported *from here* by
// `scripts/render-diff.ts` — the edge that closed the `corpus -> render-diff -> sweep ->
// corpus` cycle. Both live in a leaf both CLIs import downward since WP-R1
// (`plans/post-refactor-code-quality-remediation.md`); see `scripts/sweep-options.ts`.
import { DEFAULT_WIDTHS, parseWidths } from "./sweep-options";
// @ts-expect-error -- untyped fleet build-id helper
import { handleBuildFlags } from "./build-id.mjs";


export function parseArgs(argv: string[]): { corpus: string; options: SweepOptions } {
  let corpus = "all";
  let widths = DEFAULT_WIDTHS;
  let limit: number | undefined;
  let all = false;
  let glyphs: GlyphTierName = "unicode";
  let measure: Measure = NARROW_MEASURE;
  let manifestFlag: string | undefined;
  let detect = false;
  let maxOrphans: number | undefined;
  let maxOverIndent: number | undefined;
  let colourMode: ColourMode = "off";
  let colourChild: ColourAxisChildMode | undefined;

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
      // `default` is the third child WP-5 added — the piped, env-sanitized render with no
      // colour variable set at all, which is what G1 reads. `formats` is the fourth (WP-4,
      // `plans/colour-modes.md`) — pinned via `MDVIEW_COLOR=never`, which G2 and G3 read.
      const value = argv[index + 1];
      if (value !== "on" && value !== "off" && value !== "default" && value !== "formats") {
        throw new Error(`--colour-child must be "on", "off", "default" or "formats", got: ${value}`);
      }
      colourChild = value;
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
      glyphs = value === "ascii" ? "ascii" : "unicode";
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
 * The colour axis's printed line: **the three exact gates and the join-error count**, on
 * one line per corpus (WP-5, `plans/colour-policy.md`; the fourth `formats` child folded
 * into G2/G3 at WP-4 of `plans/colour-modes.md` — the gate count is unchanged, only the
 * child count is). Replaces the old three-bucket, two-ratchet line — `combos=N g1=N g2=N
 * g3=N errors=N` is the plan's own wire spec, and `bun run verify`'s colour-axis step
 * fails iff any of the four is non-zero, no thresholds anywhere.
 *
 * Up to ten failures of each kind are printed beneath the summary line, each naming the
 * file and width so a failure is legible without re-running the axis by hand. A G2/G3
 * failure also names **which pair or child it came from** (`pair=on-off`/`pair=formats-off`;
 * `child=on`/`child=formats`) since WP-4, because the two arms of each gate now check
 * different comparisons and it would otherwise be ambiguous which one fired.
 */
export function printColourAxis(axis: ColourAxisResult): void {
  console.log(
    `[${axis.corpus}] colour-axis combos=${axis.combos} g1=${axis.g1} g2=${axis.g2} g3=${axis.g3} ` +
      `errors=${axis.errors.length} elapsed=${axis.elapsedSeconds.toFixed(1)}s`,
  );
  for (const entry of axis.g1Failures.slice(0, 10)) {
    const sequences = entry.sequences.map((sequence) => `${sequence.kind}:${JSON.stringify(sequence.raw)}`);
    console.log(
      `  colour-axis g1 width=${entry.width} ${entry.file}: sequences=[${sequences.join(", ")}]` +
        (entry.malformed ? " malformed=true" : ""),
    );
  }
  for (const entry of axis.g2Failures.slice(0, 10)) {
    console.log(
      `  colour-axis g2 width=${entry.width} ${entry.file}: ` +
        `pair=${entry.pair} left=${entry.leftVisibleSha} right=${entry.rightVisibleSha}`,
    );
  }
  for (const entry of axis.g3Failures.slice(0, 10)) {
    const sequence = entry.sequence ? `${entry.sequence.kind}:${JSON.stringify(entry.sequence.raw)}` : "(none)";
    console.log(
      `  colour-axis g3 width=${entry.width} ${entry.file}: child=${entry.child} ${sequence} — ${entry.reason}`,
    );
  }
  for (const entry of axis.errors.slice(0, 10)) {
    console.log(
      `  colour-axis error mode=${entry.mode} width=${entry.width} ${entry.file}: ` +
        `${entry.reason}${entry.message ? ` (${entry.message})` : ""}`,
    );
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
  console.log(`glyphs=${options.glyphs} ambiguous=${ambiguous}`);
  // The sweep keeps these two axes independent *on purpose*, while `TS_BASELINE` `src/cli.ts` does
  // not: `resolveGlyphs` refuses to hand out the Unicode tier in wide mode, because
  // that tier's own glyphs are ambiguous and its tables cannot be laid out (see
  // `wideForcesAscii`). Forcing the same rule here would make the residual it was
  // discovered by unmeasurable, and an instrument that cannot reproduce the finding is
  // not an instrument. So the combination stays reachable and is labelled instead.
  if (ambiguous === "wide" && options.glyphs === "unicode") {
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
    // Four fresh processes, one per child (on/off/default/formats, WP-4 of
    // `plans/colour-modes.md`) — see `scripts/corpus.ts`'s colour-axis section for why a
    // mode cannot be reached from inside another one.
    for (const axis of await runColourAxis(stripColourModeArgs(argv))) {
      printColourAxis(axis);
      // Exact gates, no thresholds (WP-5, `plans/colour-policy.md`): the step fails iff
      // any of the four counters is non-zero — unchanged by WP-4, since the fourth child's
      // failures fold into the existing g2/g3 counts rather than adding a fifth. A
      // join-level error — an unpaired combo or a
      // child render failure — is an instrument fault and fails the run exactly like a
      // gate failure does, because an instrument that fails quietly is the failure mode
      // this whole package exists to avoid.
      if (axis.g1 > 0 || axis.g2 > 0 || axis.g3 > 0 || axis.errors.length > 0) anyFailure = true;
    }
  }

  process.exit(anyFailure ? 1 : 0);
}

if (import.meta.main) {
  if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    console.log("usage: bun run sweep [--corpus <name|all>] [--all] [--limit N] [--widths a,b,...] [--glyphs tier] [--detect] [--max-orphans N] [--max-over-indent N]\n\nRender whole corpora at several widths and report width defects; see the header comment of scripts/sweep.ts for every flag.");
    process.exit(0);
  }
  const buildRc = handleBuildFlags(process.argv.slice(2), { path: import.meta.filename, name: "sweep.ts" });
  if (buildRc !== null) process.exit(buildRc);
  await runCli();
}
