/**
 * The colour axis — the sweep's colour-mode instrument: four child processes, three exact
 * gates, and the join that reads them.
 *
 * Split out of `scripts/corpus.ts` at WP-R1 (`plans/post-refactor-code-quality-remediation.md`)
 * with no behaviour change — the same symbols, the same wire schema, the same printed
 * numbers. It sits **above** corpus discovery: it imports the manifest resolution and file
 * selection it needs from `./corpus`, and `./corpus` imports nothing from here. That
 * direction is the point. While this code lived in the library, the library needed
 * `sha256Hex` from `scripts/render-diff.ts`, which needed `parseWidths` from
 * `scripts/sweep.ts`, which needed the library — a three-node cycle whose own justifying
 * comment argued it was benign at run time. It is now two downward imports
 * (`./hash`, `./corpus`) and no cycle to reason about.
 *
 * `scripts/AGENTS.md`'s "The colour axis — three exact gates over four children" is the
 * measured record: the gate definitions, the seed history, and why a zero here is not
 * vacuous. The narrative below is this module's own contract.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// The colour axis's own grammar reader (WP-5, `plans/colour-policy.md`): `scan` is what
// classifies each render's terminal sequences into the wire record, and `STYLE_TABLE` is
// what G3's SGR arm checks membership against. Neither is a second implementation — both
// are the same objects `src/inline.ts`/`src/table.ts`/etc. read to decide what to emit.
import { scan } from "../src/ansi";
import { emitsUnder, STYLE_TABLE, type StyleName } from "../src/style";
import { renderDocumentDetailed } from "../src/render";
import { NARROW_MEASURE } from "../src/width";
// The one hash implementation this repo has (WP-1 of `plans/marked-terminal-replacement.md`),
// imported rather than re-derived so this axis and the differential harness agree on what
// "the same text" means. It was imported from `scripts/render-diff.ts` until WP-R1 moved it
// to a neutral leaf; see `scripts/hash.ts`'s own header for the cycle that closed.
import { sha256Hex } from "./hash";
import {
  resolveCorpusFiles,
  selectCorpusFiles,
  type ColourAxisChildMode,
  type CorpusSpec,
  type SweepOptions,
} from "./corpus";

// ---------------------------------------------------------------------------
// The colour axis - three exact gates over four children (WP-4,
// `plans/colour-modes.md`; three children since WP-5 of `plans/colour-policy.md`; two
// children and two ratchets before that, WP-1 of `plans/own-the-token-walk.md`)
// ---------------------------------------------------------------------------
//
// The invariant this instrument exists to measure: a colour decision may change which
// bytes a render emits; it must never change which characters it emits - and an
// undirected, piped render must emit no terminal sequence at all. Everything below is
// measurement only - no renderer source is touched and no rendered byte moves.
//
// WP-5 of `plans/colour-policy.md` replaced two ratchet counters (`charDiff`/`sgrAny`,
// `--max-char-diff`/`--max-sgr`) with three exact, per-combo gates. A ratchet only fails
// when its number goes up; both were already measured at 0 (WP-3/WP-4 of that plan closed
// the producers behind them), which made them counters that could only ever pass -
// re-verified every run, but never re-specified. G1/G2/G3 below are pass/fail per
// `(file, width)` combo against a fixed definition, not a threshold compared to a seed.
// WP-4 of `plans/colour-modes.md` did not add a fourth gate - it added a fourth child and
// extended G2 and G3 to read it, per the sections below.
//
// ## Why this is four processes
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
// The third child is `default` (WP-5 of `plans/colour-policy.md`, cycle-2 f9): the colour
// decision an ordinary user gets from `mdview file.md | somewhere`, with nothing forced
// either way. `on` and `off` each decide something (`FORCE_COLOR=3`/`FORCE_COLOR=0`);
// `default` decides nothing - every colour-related variable is absent, so
// `src/colour.ts`'s resolver falls all the way to its `isTTY` floor, which is `false` on a
// pipe. G1 reads this child alone: the default child must emit zero terminal sequences of
// any kind, because that piped default is what every consumer of this tool's stdout - a
// file redirect, `less`, another program's argument - actually receives.
//
// The fourth child is `formats` (WP-4, `plans/colour-modes.md`), pinned via
// `MDVIEW_COLOR=never` - one of the three explicit `never`-directive routes Decision 5 of
// that plan moved onto the format-preserving `SgrMode`, rather than the kill-switch `none`
// output `off`/`default` still pin. G2 extends to it: `visible(formats)` must equal
// `visible(off)`, the same character-channel claim the `on`/`off` pair already makes,
// because Decision 3 keeps the syntax highlighter off this branch entirely (it is
// `full`-only) so nothing on the formats path may change *which* characters render, only
// which of them are styled. G3 extends to it too, against a narrower vocabulary than the
// `on` child's: every `formats`-child sequence must be a committed **format-class or
// control** pair (`src/style.ts`'s own `emitsUnder("formats")` rule, asked here as a
// membership test) or a well-formed OSC-8/tmux-DCS, exactly as the `on`-child arm already
// allows for those two kinds. Scoped exactly as the landed G1/G3 are - a vocabulary check
// over the fixed, ESC-free gate corpus, never a provenance audit (cycle-3 f3: an
// audit-shaped check would reject the authored hue escape Decision 1 obliges to survive,
// which is rev 2's contradiction reborn).
//
// So the parent re-execs the sweep CLI four times, once per child, with the colour
// decision pinned (or, for `default`, deliberately left undecided) before any import
// happens. Each child renders the same population and emits a v2 digest per
// `(file, width)` - never body text, so this stays affordable over a ~44.5k-file private
// corpus - and the parent joins the four streams by key.
//
// ## Why each child's environment is built explicitly, never inherited
//
// A child that merely inherited the parent's environment would measure the machine, not
// the renderer: a developer with `FORCE_COLOR` exported would silently run every child in
// the same mode, and an axis that cannot diverge is a gate that cannot fail - the shape
// root `AGENTS.md`'s "Flag order matters" paragraph forbids. `colourChildEnv` therefore
// decides `NO_COLOR`, `MDVIEW_COLOR` and `FORCE_COLOR` for every child unconditionally
// (deleting all three for `default`; pinning `MDVIEW_COLOR=never` and deleting
// `FORCE_COLOR` for `formats`), and also sanitizes `TMUX` and `TERM` - the two inputs
// `resolveTmux` reads - so a harness invoked from inside a real tmux session, or under an
// unusual `TERM`, cannot leak into what G1/G3 measure.
// `tests/colour-axis.test.ts` asserts the children resolve from their observed output
// rather than from the environment the parent intended to set.

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

/**
 * G2: two children's visible text diverged for this combo — either the `on`/`off` pair
 * (WP-5 of `plans/colour-policy.md`) or the `formats`/`off` pair (WP-4 of
 * `plans/colour-modes.md`, Decision 3: the highlighter is `full`-only, so nothing on the
 * `formats` path may change which characters render). One combo can produce up to two
 * `G2Failure` records, one per pair — `pair` names which comparison failed, and `left`/
 * `right` are that pair's own two children in that order (`on`,`off` or `formats`,`off`).
 */
export interface G2Failure {
  corpus: string;
  file: string;
  width: number;
  pair: "on-off" | "formats-off";
  leftVisibleSha: string;
  rightVisibleSha: string;
}

/**
 * G3: one sequence in a colour-on child's render did not parse as this renderer's own
 * committed vocabulary for that child, a well-formed OSC-8 hyperlink, or a
 * strictly-parsed tmux DCS wrapper around one. Two children carry this check since WP-4
 * of `plans/colour-modes.md`: `on`, against the full committed SGR table, and `formats`,
 * against the narrower format/control subset only — `child` names which. `sequence` is
 * omitted when the failure is the record's bare `malformed` flag, which carries no raw
 * bytes in the v2 schema (see `ColourDigestRecord`'s doc comment).
 */
export interface G3Failure {
  corpus: string;
  file: string;
  width: number;
  child: "on" | "formats";
  sequence?: WireSequence;
  reason: string;
}

/**
 * One `(file, width)` key present in one child's stream and missing or errored in
 * another. The join iterates the union of keys across all four children (WP-4 of
 * `plans/colour-modes.md`; three children and cycle-3 f8's union fix at WP-5 of
 * `plans/colour-policy.md`) - the two-child join this replaced mapped over one stream
 * only, so a combo present in one mode and absent from another was silently excluded
 * from the denominator rather than surfaced. `reason: "missing"` is a key absent from
 * that child's stream entirely; `"child-error"` is a key present but recorded as a
 * per-render failure (`message` carries the child's own error text).
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
 * successful digest in all four children (WP-4 of `plans/colour-modes.md` added the
 * fourth, `formats`) - a key incomplete in any of them contributes to `errors` instead
 * and is excluded from every gate's denominator, since none of G1/G2/G3 can be evaluated
 * without every child's render.
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
 * **`formats` (WP-4, `plans/colour-modes.md`) pins `MDVIEW_COLOR=never` and deletes
 * `FORCE_COLOR`** — the same sanitization every child gets, with one explicit directive
 * added rather than a `FORCE_COLOR` level, because `never` is the route Decision 5 moved
 * onto the format-preserving `SgrMode` and `FORCE_COLOR` has no `formats`-shaped value to
 * set (the ratified precedence table has no `FORCE_COLOR` reading that resolves there).
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
  else if (mode === "formats") {
    delete env.FORCE_COLOR;
    env.MDVIEW_COLOR = "never";
  } else delete env.FORCE_COLOR;
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
      { cause: error },
    );
  }
}

// --- G3: is one colour-on child's sequence one this renderer is authorized to emit? ---

/**
 * Every SGR byte pair this renderer's committed style table (`src/style.ts`) is
 * authorized to emit, `open` and `close` both - the `on` child's G3 arm is exact
 * membership in this set, never a pattern. `STYLE_TABLE` itself already bans `38`/`48`
 * introducers by an independent assertion (`tests/style.test.ts`), so nothing here
 * re-derives that ban.
 */
const COMMITTED_SGR: ReadonlySet<string> = new Set(
  Object.values(STYLE_TABLE).flatMap((code) => [code.open, code.close]),
);

/**
 * Every SGR byte pair the `formats` child may legitimately emit (WP-4,
 * `plans/colour-modes.md`): the format and control classes only, never hue - `src/style.ts`'s
 * own `emitsUnder(name, "formats")` rule, asked here as a membership test rather than
 * re-derived as a second copy of `STYLE_CLASSES`. This is the vocabulary the authored
 * fixture's `31m`/`39m` fails by construction: `red` is hue-class, and an authored red
 * escape survives `formats` verbatim (Decision 1), so it is not membership this set can
 * vouch for - precisely as it is not membership `COMMITTED_SGR` can vouch for on the
 * `default` child (G1). Not a pattern either: `emitsUnder` is a per-name lookup, and this
 * set is the closure of every name it returns `true` for under `"formats"`.
 */
const COMMITTED_FORMATS_SGR: ReadonlySet<string> = new Set(
  (Object.keys(STYLE_TABLE) as StyleName[])
    .filter((name) => emitsUnder(name, "formats"))
    .flatMap((name) => [STYLE_TABLE[name].open, STYLE_TABLE[name].close]),
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
 * G3's per-sequence classifier, parameterised over which SGR vocabulary to check against.
 * OSC-8 is accepted on `scan`'s own grammar alone regardless of vocabulary - its `osc8`
 * kind is only ever assigned to a well-formed hyperlink (`src/ansi.ts`'s `readSequence`),
 * so there is nothing further to check; DCS against `isValidTmuxDcs`, likewise shared by
 * both children (WP-4, `plans/colour-modes.md`: hyperlinks are off on every child, so the
 * vocabulary split is an SGR-only distinction). Returns `undefined` for a valid sequence,
 * a failure reason otherwise.
 */
function classifySequenceAgainst(
  sequence: WireSequence,
  vocabulary: ReadonlySet<string>,
  sgrFailureReason: string,
): string | undefined {
  if (sequence.kind === "sgr") {
    return vocabulary.has(sequence.raw) ? undefined : sgrFailureReason;
  }
  if (sequence.kind === "osc8") return undefined;
  return isValidTmuxDcs(sequence.raw) ? undefined : "dcs payload is not a valid doubled-ESC OSC-8 open or close";
}

/** G3's `on`-child arm: exact membership in `src/style.ts`'s full committed SGR table. */
function classifySequence(sequence: WireSequence): string | undefined {
  return classifySequenceAgainst(sequence, COMMITTED_SGR, "sgr not in the committed style table");
}

/**
 * G3's `formats`-child arm (WP-4, `plans/colour-modes.md`): exact membership in
 * `COMMITTED_FORMATS_SGR`, the format/control subset only. A hue-class SGR here is never
 * a producer leak by construction - Decision 3 keeps the syntax highlighter off this
 * branch entirely and every other producer is filtered at emission (`src/style.ts`'s
 * `applyStyle`/`styleSpan`) - so a failure here can only be an authored escape that
 * survived verbatim (Decision 1), exactly the shape the authored fixture pins.
 */
function classifyFormatsSequence(sequence: WireSequence): string | undefined {
  return classifySequenceAgainst(
    sequence,
    COMMITTED_FORMATS_SGR,
    "sgr not in the committed format/control vocabulary",
  );
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
 * Join the four children's streams for one corpus and run G1/G2/G3 over every
 * `(file, width)` combo present as a successful digest in all four (WP-4 of
 * `plans/colour-modes.md` added `formats`; three children and the union join at WP-5,
 * cycle-3 f8, of `plans/colour-policy.md`).
 *
 * The union of keys is taken across all four maps - the previous two-child join mapped
 * over one stream only, so a key present in one mode and absent (or errored) in another
 * was silently excluded from the denominator. Here every such key becomes one
 * `ColourAxisErrorEntry` per incomplete mode, tagged with which mode and why, and the
 * combo is excluded from every gate rather than partially evaluated.
 */
export function classifyColourAxis(
  corpus: string,
  on: ColourDigestStream | undefined,
  off: ColourDigestStream | undefined,
  defaultStream: ColourDigestStream | undefined,
  formats: ColourDigestStream | undefined,
  elapsedSeconds: number,
): ColourAxisResult {
  const onMap = comboLookup(on);
  const offMap = comboLookup(off);
  const defaultMap = comboLookup(defaultStream);
  const formatsMap = comboLookup(formats);

  const keys = new Set<string>([
    ...onMap.keys(),
    ...offMap.keys(),
    ...defaultMap.keys(),
    ...formatsMap.keys(),
  ]);

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
      ["formats", formatsMap.get(key) ?? { status: "missing" }],
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
    const formatsRecord = (formatsMap.get(key) as { status: "ok"; record: ColourDigestRecord }).record;
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
    // characters a reader sees. `on`/`off` is the original pair (WP-5 of
    // `plans/colour-policy.md`); `formats`/`off` is WP-4 of `plans/colour-modes.md`'s
    // addition, holding the same claim for the format-preserving mode - Decision 3 keeps
    // the highlighter off that branch, so this holds by construction for code and by
    // every other producer's own filter everywhere else.
    if (onRecord.visibleSha !== offRecord.visibleSha) {
      g2Failures.push({
        corpus,
        file,
        width,
        pair: "on-off",
        leftVisibleSha: onRecord.visibleSha,
        rightVisibleSha: offRecord.visibleSha,
      });
    }
    if (formatsRecord.visibleSha !== offRecord.visibleSha) {
      g2Failures.push({
        corpus,
        file,
        width,
        pair: "formats-off",
        leftVisibleSha: formatsRecord.visibleSha,
        rightVisibleSha: offRecord.visibleSha,
      });
    }

    // G3: every sequence a colour-on child actually emitted must parse as this renderer's
    // own committed vocabulary for that child, a well-formed OSC-8 hyperlink, or a
    // strictly-parsed tmux DCS wrapper around one. A malformed span fails outright:
    // nothing this renderer emits is ever malformed by construction, so one in a
    // colour-on child's render is either an authored escape (legitimate, per Decision 1,
    // but still not one G3 can vouch for) or a real defect - either way, worth a name in
    // the failure list. The `on` arm checks the full committed table (WP-5 of
    // `plans/colour-policy.md`); the `formats` arm (WP-4 of `plans/colour-modes.md`)
    // checks the narrower format/control subset only, which is what pins the authored
    // fixture's hue escape as a legible expected failure here too.
    for (const sequence of onRecord.sequences) {
      const reason = classifySequence(sequence);
      if (reason !== undefined) g3Failures.push({ corpus, file, width, child: "on", sequence, reason });
    }
    if (onRecord.malformed) {
      g3Failures.push({ corpus, file, width, child: "on", reason: "malformed sequence in the colour-on render" });
    }
    for (const sequence of formatsRecord.sequences) {
      const reason = classifyFormatsSequence(sequence);
      if (reason !== undefined) g3Failures.push({ corpus, file, width, child: "formats", sequence, reason });
    }
    if (formatsRecord.malformed) {
      g3Failures.push({
        corpus,
        file,
        width,
        child: "formats",
        reason: "malformed sequence in the formats-child render",
      });
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
 * Run the whole axis: all four children, in parallel, then the join, one corpus at a time
 * over the union of corpus names any child reported (WP-4 of `plans/colour-modes.md`
 * added `formats`; three children and cycle-3 f8's union fix at WP-5 of
 * `plans/colour-policy.md`) - a corpus resolved by one child and not another is exactly
 * the failure mode a single-stream iteration order would hide.
 */
export async function runColourAxis(childArgs: string[]): Promise<ColourAxisResult[]> {
  const started = performance.now();
  const [on, off, defaultStreams, formats] = await Promise.all([
    collectColourDigests("on", childArgs),
    collectColourDigests("off", childArgs),
    collectColourDigests("default", childArgs),
    collectColourDigests("formats", childArgs),
  ]);
  const elapsedSeconds = (performance.now() - started) / 1000;

  const byCorpus = (streams: ColourDigestStream[]) => new Map(streams.map((stream) => [stream.corpus, stream]));
  const onByCorpus = byCorpus(on);
  const offByCorpus = byCorpus(off);
  const defaultByCorpus = byCorpus(defaultStreams);
  const formatsByCorpus = byCorpus(formats);

  return unionCorpusNames(on, off, defaultStreams, formats).map((corpus) =>
    classifyColourAxis(
      corpus,
      onByCorpus.get(corpus),
      offByCorpus.get(corpus),
      defaultByCorpus.get(corpus),
      formatsByCorpus.get(corpus),
      elapsedSeconds,
    ),
  );
}

/**
 * The union of corpus names across the axis's four children, in first-seen order over
 * `[on, off, default, formats]`. Exported so the corpus-only-in-one-mode case — a corpus
 * resolved by one child's stream and absent from another's — can be pinned directly
 * against synthetic streams, rather than depending on a real four-process race to
 * reproduce it.
 */
export function unionCorpusNames(
  on: ColourDigestStream[],
  off: ColourDigestStream[],
  defaultStreams: ColourDigestStream[],
  formats: ColourDigestStream[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const stream of [...on, ...off, ...defaultStreams, ...formats]) {
    if (seen.has(stream.corpus)) continue;
    seen.add(stream.corpus);
    names.push(stream.corpus);
  }
  return names;
}
