import { scan, type Span } from "./ansi";
import { graphemes, splitToken } from "./text";
import { NARROW_MEASURE, type Measure } from "./width";

/**
 * ANSI-safe text wrapping for content that `marked-terminal` never reflowed: list items
 * and HTML paragraphs. `marked-terminal` only reflowed `paragraph`, `heading`, and
 * `blockquote` (its `reflowText` option was read in exactly those three renderers); list
 * items were returned unwrapped, and that is 90% of this corpus's overflow.
 *
 * Table cells (`src/table.ts`) are flattened to plain text before wrapping, which is
 * correct there but wrong here: list items and HTML blocks carry *live* terminal
 * sequences — code spans are styled, wiki-links are styled, and a link can carry an OSC-8
 * hyperlink around its label. Feeding a styled long token straight to
 * `splitToken`/`graphemes` would walk it one character at a time and see the ESC, `[`,
 * `3`, `6`, `m` as separate "graphemes" — cutting a line in the middle of an escape
 * sequence emits terminal garbage. So this module always segments sequences out as
 * atomic, zero-width units *before* any width accounting or hard-splitting, and only ever
 * hands `splitToken`/`graphemes` the escape-free visible text in between.
 *
 * ## Since WP-3 of `plans/colour-policy.md` the segmentation is `src/ansi.ts`'s, at both
 * split paths
 *
 * This module used to carry its own `/(\x1b\[[0-9;]*m)/` — a private, second copy of the
 * SGR vocabulary `stripAnsi` also spelled out. It was correct about SGR and blind to
 * everything else, which is exactly how a labelled hyperlink crossing the wrap budget got
 * chunked mid-sequence: a 26-character label at width 10 came apart as `ESC ]8;;https:` /
 * `//x BEL abcdefg`, shipping the two halves to the terminal as text.
 *
 * Both of this module's split paths — the initial word tokenization *and*
 * `splitStyledWord`'s hard split of an over-budget token — now consume the **span
 * sequence** `scan` produces, and there is deliberately **no flatten-and-rescan between
 * the two stages**: a word is carried as its spans, and only a `text` span's own bytes
 * ever reach `splitToken`. Re-flattening a word to a string between the stages would
 * reopen the grapheme-splitting hazard `src/text.ts:21-52` exists to prevent, because the
 * second stage would have to re-derive where the sequences were.
 *
 * **Width is measured on visible text, never on raw bytes.** A word's width is
 * `measure(visible)` over the concatenation of its `text` spans — which for SGR-only
 * content is byte-for-byte the number the old `measure(entry.text)` produced (that
 * measurement strips SGR internally), and which for a hyperlink is the only correct
 * answer: `string-width@7.2.0` reports a tmux-DCS-wrapped six-column link as 27 columns.
 */

const WHITESPACE_RUN = /(\s+)/;
const IS_WHITESPACE = /^\s+$/;

/**
 * A word is its spans, in order — never a flattened string (see the module header).
 * `visible` is the escape-free text those spans cover, so width accounting and the hard
 * split both work from the columns a reader sees.
 */
type Word = { spans: Span[]; visible: string };
type Entry = { kind: "word"; word: Word } | { kind: "space" };
/** One emitted piece of a hard-split word: its bytes, and the columns inside them. */
type Chunk = { raw: string; visible: string };

function emptyWord(): Word {
  return { spans: [], visible: "" };
}

function raw(word: Word): string {
  let out = "";
  for (const span of word.spans) out += span.raw;
  return out;
}

/**
 * Split a scanned span sequence into word/space entries. A "word" is a maximal run with
 * no *visible* whitespace in it, but it may have complete terminal sequences embedded (a
 * sequence can never straddle a word/space boundary, because the scanner has already
 * segmented it out as one atomic span before whitespace is looked for at all).
 */
function tokenize(spans: Span[]): Entry[] {
  const entries: Entry[] = [];
  let current = emptyWord();

  const flush = () => {
    if (current.spans.length > 0) {
      entries.push({ kind: "word", word: current });
      current = emptyWord();
    }
  };

  for (const span of spans) {
    if (span.kind !== "text") {
      current.spans.push(span);
      continue;
    }
    for (const piece of span.raw.split(WHITESPACE_RUN)) {
      if (piece === "") continue;
      if (IS_WHITESPACE.test(piece)) {
        flush();
        entries.push({ kind: "space" });
      } else {
        current.spans.push({ kind: "text", raw: piece, width: 0 });
        current.visible += piece;
      }
    }
  }
  flush();
  return entries;
}

/**
 * Hard-split one over-budget word, spans and all.
 *
 * Sequences are appended verbatim wherever they fall — they are zero-width and can never
 * trip the width check — and every escape-free visible run in between is split with
 * `splitToken` (grapheme-correct, so CJK/emoji are never cut), so the only logic here is
 * stitching those runs back together around the sequences. The input is the word's
 * **spans**, not its bytes: this is the second of the two split paths and it never
 * re-scans (module header).
 */
function splitStyledWord(word: Word, limit: number, measure: Measure): Chunk[] {
  const chunks: Chunk[] = [];
  let current = "";
  let currentVisible = "";
  let currentWidth = 0;

  const pushChunk = () => {
    if (current !== "") chunks.push({ raw: current, visible: currentVisible });
    current = "";
    currentVisible = "";
    currentWidth = 0;
  };

  for (const span of word.spans) {
    if (span.kind !== "text") {
      current += span.raw;
      continue;
    }
    const pieces = splitToken(span.raw, limit, measure);
    pieces.forEach((piece, index) => {
      const pieceWidth = measure(piece);
      if (index === 0 && currentWidth > 0 && currentWidth + pieceWidth <= limit) {
        current += piece;
        currentVisible += piece;
        currentWidth += pieceWidth;
        return;
      }
      pushChunk();
      current = piece;
      currentVisible = piece;
      currentWidth = pieceWidth;
    });
  }
  pushChunk();
  return chunks.length > 0 ? chunks : [{ raw: "", visible: "" }];
}

/**
 * Wrap terminal-styled text to `width` display columns without splitting a sequence.
 * Greedy word-fill on whitespace boundaries; any single word wider than `width` is
 * hard-split (grapheme-correct, sequence-safe) rather than overflowing. Never ellipsizes:
 * `wrapAnsi(t, w).join(" ")` with sequences stripped reproduces every visible character
 * of `t`, in order.
 */
export function wrapAnsi(text: string, width: number, measure: Measure = NARROW_MEASURE): string[] {
  const limit = Math.max(1, width);
  const entries = tokenize(scan(text).spans);
  if (entries.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let pendingSpace = false;
  // Sequences that arrived with no visible text of their own and have nowhere to sit yet
  // — see `place`'s comment. They are emitted with the next visible piece, or at the end.
  let carried = "";

  const flushLine = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
    pendingSpace = false;
  };

  /**
   * **The escape-only word is not a word** — repair 3 of WP-3 of `plans/colour-policy.md`.
   *
   * A run of sequences with no visible text between two spaces used to be placed like any
   * other word: it consumed the pending space, contributed zero columns, and left the
   * line holding a trailing space the colourless render never had. Measured on
   * `tests/fixtures/tight-list.md` at width 80, where a link's own style codes sit alone
   * at the end of a line: colour-on rendered `"…is recorded at "` and colour-off
   * `"…is recorded at"`. It is the same class of defect as the two in `src/lists.ts` —
   * a layout decision made on bytes rather than on columns.
   *
   * The repair is to *carry* such a run rather than place it: the bytes stay in order,
   * ahead of whatever visible piece comes next, and the pending space is left for that
   * piece to consume. Nothing is dropped — the carried bytes are flushed with the next
   * placement or appended to the last line — so the output is byte-preserving on every
   * input that has visible text, and the colourless render is untouched by construction
   * (it has no sequences to carry).
   */
  const place = (piece: string, pieceWidth: number, visible: boolean) => {
    if (!visible) {
      carried += piece;
      return;
    }
    const needed = pieceWidth + (pendingSpace && currentWidth > 0 ? 1 : 0);
    if (currentWidth > 0 && currentWidth + needed > limit) {
      flushLine();
      current = carried + piece;
      currentWidth = pieceWidth;
    } else {
      if (pendingSpace && currentWidth > 0) {
        current += " ";
        currentWidth += 1;
      }
      current += carried + piece;
      currentWidth += pieceWidth;
    }
    carried = "";
    pendingSpace = false;
  };

  for (const entry of entries) {
    if (entry.kind === "space") {
      if (currentWidth > 0) pendingSpace = true;
      continue;
    }
    const word = entry.word;
    const wordWidth = measure(word.visible);
    if (wordWidth <= limit) {
      place(raw(word), wordWidth, word.visible !== "");
      continue;
    }
    for (const chunk of splitStyledWord(word, limit, measure)) {
      place(chunk.raw, measure(chunk.visible), chunk.visible !== "");
    }
  }
  if (carried !== "") current += carried;
  lines.push(current);
  return lines;
}

// Re-exported so callers that need raw grapheme counts (tests, mainly) don't have to
// reach into `./text` for it separately.
export { graphemes };
