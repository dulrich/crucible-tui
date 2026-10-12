/**
 * The one terminal-sequence grammar: scan rendered text into an ordered span sequence,
 * and emit the only non-SGR sequence this renderer produces (OSC-8).
 *
 * WP-3 of `plans/colour-policy.md`. Two things live here and they are two halves of one
 * grammar — what the renderer may emit, and what layout must be able to see past:
 *
 * - **`scan`** turns a string into `{spans, visible, malformed}`, where the spans are an
 *   *ordered sequence* and not a flattened summary. Layout reads it instead of guessing
 *   with a regex, which is what makes measurement escape-blind rather than SGR-blind.
 * - **`link`** emits an OSC-8 hyperlink, with the tmux DCS wrapper, transcribed from
 *   `ansi-escapes@7.3.0` (see `link`'s own comment for the cited lines). That package left
 *   the dependency closure with this module.
 *
 * ## Why a scanner and not a regex
 *
 * `stripAnsi` was `/\x1b\[[0-9;]*m/g` — SGR only (`TS_BASELINE` `src/list-lines.ts`, pre-WP-3). Every
 * layout decision downstream of it therefore reasoned correctly about SGR and not at all
 * about OSC-8 or DCS, and `TS_BASELINE` `src/wrap.ts` carried a second, private copy of the same
 * SGR-only vocabulary — which is why a labelled hyperlink crossing the wrap budget was
 * chunked *mid-sequence* (a 26-character label at width 10 chunked as `ESC ]8;;https:`
 * then `//x BEL abcdefg`, measured at plan time). One grammar, one module, both
 * directions.
 *
 * ## Three rules that are not negotiable
 *
 * 1. **Spans concatenate back to the input, byte for byte.** `scan(t).spans.map(s =>
 *    s.raw).join("") === t` for every input, malformed included — which is what lets a
 *    consumer rebuild a line from a subsequence without inventing or losing bytes.
 *    `tests/ansi.test.ts` asserts it as a property over a generated corpus.
 * 2. **Width is structural, never measured off the raw bytes of a sequence.** Every
 *    non-`text` span is width 0 *by construction*, because measuring one is actively
 *    wrong: `string-width@7.2.0` reports a tmux-DCS-wrapped six-column link as **27
 *    columns** (measured at this plan's base). Only `text` spans are measured, and they
 *    carry no escape bytes to measure.
 * 3. **A malformed sequence carries its raw bytes explicitly** and never silently
 *    consumes visible text. An unrecognised introducer consumes the ESC alone, so the
 *    character after it is still text — authored ESC bytes pass through verbatim paths by
 *    fidelity design (Decision 1 of the plan), and a scanner that ate the byte after one
 *    would delete a character the author wrote.
 *
 * The renderer's own sentinels — `SENTINEL` (code point 0) and `TASK_STATE_SENTINEL`
 * (code point 1) — are **not** terminal sequences and are classified as `text`, passed
 * through untouched. They are stripped downstream by their own passes.
 *
 * **Every control byte in this module is built with `String.fromCharCode`, never pasted.**
 * A literal ESC in source is invisible in every editor and every diff, and this is the one
 * file where they would be dense enough to matter.
 */
// Moved from `TS_BASELINE` `src/ansi.ts` at WP-9 of `plans/mdview-rust-port.md`: the scanner half only.
// The emitter (`link`, `sanitizeHref`) is the Rust crate's `ansi.rs`; see `TS_BASELINE` (`c097c66`).
import { NARROW_MEASURE, type Measure } from "./width";

/** ESC, U+001B — the introducer every sequence below starts with. */
const ESC = String.fromCharCode(0x1b);
/** BEL, U+0007 — the xterm-compatible OSC terminator `ansi-escapes` emits. */
const BEL = String.fromCharCode(0x07);
/** The final byte of the two-byte String Terminator, `ESC \`. */
const ST_FINAL = "\\";
/** C1 String Terminator, U+009C — the single-byte spelling of `ESC \`. */
const ST_C1 = String.fromCharCode(0x9c);
/** The OSC-8 prefix, in full: ESC `]8;`. */
const OSC8_PREFIX = `${ESC}]8;`;

/** What a span is: the five kinds the plan fixes, in one closed vocabulary. */
export type SpanKind = "text" | "sgr" | "osc8" | "dcs" | "malformed";

export interface Span {
  readonly kind: SpanKind;
  /** The exact bytes this span covers. Spans concatenate back to the scanned input. */
  readonly raw: string;
  /** Display columns. **Zero for every non-`text` kind, by construction** — see rule 2. */
  readonly width: number;
}

export interface ScanResult {
  readonly spans: Span[];
  /** Every `text` span's bytes, in order — the columns a reader actually sees. */
  readonly visible: string;
  /** True when any span is `malformed`. */
  readonly malformed: boolean;
}

const CSI_PARAMETER = /[0-9;:<=>?]/;
const CSI_INTERMEDIATE = /[ !"#$%&'()*+,\-./]/;

/**
 * One sequence read at `start`, where `text[start]` is ESC.
 *
 * The grammar is deliberately narrow — SGR, OSC-8, DCS — because those are the only three
 * this renderer emits, and anything else reaching layout is a fact worth surfacing rather
 * than absorbing. A well-formed but unexpected CSI (say `ESC [ 2 J`) is therefore
 * `malformed` too: the kind vocabulary is the plan's, and "not a sequence this tool
 * emits" is exactly the signal `malformed` carries.
 */
function readSequence(text: string, start: number): { kind: SpanKind; raw: string } {
  const next = text[start + 1];

  // CSI: ESC `[` <params> <intermediates> <final>. SGR is the `m` final; every other
  // final is a sequence this renderer never emits.
  if (next === "[") {
    let index = start + 2;
    while (index < text.length && CSI_PARAMETER.test(text[index] as string)) index += 1;
    while (index < text.length && CSI_INTERMEDIATE.test(text[index] as string)) index += 1;
    const final = text[index];
    if (final === undefined) return { kind: "malformed", raw: text.slice(start) };
    const raw = text.slice(start, index + 1);
    return { kind: final === "m" ? "sgr" : "malformed", raw };
  }

  // OSC: ESC `]` <body> <BEL | ESC \ | ST>. Only the hyperlink (`8;`) is a sequence this
  // renderer emits; any other OSC body is reported rather than absorbed.
  if (next === "]") {
    for (let index = start + 2; index < text.length; index += 1) {
      const ch = text[index];
      if (ch === BEL || ch === ST_C1) {
        const raw = text.slice(start, index + 1);
        return { kind: raw.startsWith(OSC8_PREFIX) ? "osc8" : "malformed", raw };
      }
      if (ch === ESC) {
        if (text[index + 1] === ST_FINAL) {
          const raw = text.slice(start, index + 2);
          return { kind: raw.startsWith(OSC8_PREFIX) ? "osc8" : "malformed", raw };
        }
        // An ESC inside an OSC body that does not open `ESC \` terminates nothing. Stop
        // here rather than swallowing it, so the inner ESC is re-examined on its own.
        return { kind: "malformed", raw: text.slice(start, index) };
      }
    }
    return { kind: "malformed", raw: text.slice(start) };
  }

  // DCS: ESC `P` <payload> ESC `\`. tmux's wrapper doubles every ESC in the payload
  // (`ansi-escapes@7.3.0` `base.js:18-27`), so a doubled ESC is payload and a single one
  // must be the terminator.
  if (next === "P") {
    for (let index = start + 2; index < text.length; index += 1) {
      if (text[index] !== ESC) continue;
      if (text[index + 1] === ESC) {
        index += 1;
        continue;
      }
      if (text[index + 1] === ST_FINAL) return { kind: "dcs", raw: text.slice(start, index + 2) };
      return { kind: "malformed", raw: text.slice(start, index) };
    }
    return { kind: "malformed", raw: text.slice(start) };
  }

  // Anything else: the ESC alone (rule 3). The byte after it stays visible text.
  return { kind: "malformed", raw: ESC };
}

/**
 * The single walk both public readers are built on — one grammar, two consumers, so a
 * `stripAnsi` that skips measurement can never drift from the scanner's own idea of where
 * a sequence ends.
 */
function walk(
  text: string,
  onText: (chunk: string) => void,
  onSequence: (kind: SpanKind, raw: string) => void,
): void {
  let index = 0;
  while (index < text.length) {
    const escape = text.indexOf(ESC, index);
    if (escape === -1) {
      onText(text.slice(index));
      return;
    }
    if (escape > index) onText(text.slice(index, escape));
    const { kind, raw } = readSequence(text, escape);
    onSequence(kind, raw);
    index = escape + raw.length;
  }
}

/**
 * Scan `text` into its ordered span sequence.
 *
 * `measure` is only ever applied to `text` spans — see rule 2. It defaults to
 * `NARROW_MEASURE` for the same reason every other public entry point in this repo does
 * (`TS_BASELINE` `src/width.ts`: the default *is* rule 4 of the ambiguous-width resolution order), and
 * a caller that resolved a different ruler passes its own.
 */
export function scan(text: string, measure: Measure = NARROW_MEASURE): ScanResult {
  const spans: Span[] = [];
  let visible = "";
  let malformed = false;
  walk(
    text,
    (chunk) => {
      spans.push({ kind: "text", raw: chunk, width: measure(chunk) });
      visible += chunk;
    },
    (kind, raw) => {
      spans.push({ kind, raw, width: 0 });
      if (kind === "malformed") malformed = true;
    },
  );
  return { spans, visible, malformed };
}

/**
 * Whether `text` carries any terminal sequence at all.
 *
 * The cheap question a pass asks before deciding whether it needs the scanner: a pass
 * whose colourless path must stay byte-identical *by construction* takes its original
 * branch when this is false (`fixNestedLists`, `TS_BASELINE` `src/lists.ts`, is the case this exists
 * for). An ESC is the only byte that can start a sequence, so this is exact.
 */
export function hasSequences(text: string): boolean {
  return text.includes(ESC);
}

/**
 * Every visible column of `text`, with every terminal sequence removed.
 *
 * This is `scan(text).visible` without building the spans — the same grammar through the
 * same walk, because this is the hot path (`TS_BASELINE` `src/list-lines.ts`'s `stripAnsi` re-exports
 * it, and the detectors and the sweep call that per rendered line). The fast path is the
 * common one: text with no ESC in it is returned unchanged, allocating nothing.
 */
export function stripSequences(text: string): string {
  if (!text.includes(ESC)) return text;
  let visible = "";
  walk(
    text,
    (chunk) => {
      visible += chunk;
    },
    () => {},
  );
  return visible;
}
