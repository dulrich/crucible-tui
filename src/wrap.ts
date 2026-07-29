import { graphemes, splitToken } from "./table";
import { NARROW_MEASURE, type Measure } from "./width";

/**
 * ANSI-safe text wrapping for content that `marked-terminal` never reflows: list items
 * and HTML paragraphs. `marked-terminal` only reflows `paragraph`, `heading`, and
 * `blockquote` (its `reflowText` option is read in exactly those three renderers); list
 * items are returned unwrapped, and that is 90% of this corpus's overflow.
 *
 * Table cells (`src/table.ts`) are flattened to plain text before wrapping, which is
 * correct there but wrong here: list items and HTML blocks carry *live* ANSI —
 * `marked-terminal` styles code spans and `src/render.ts` styles wiki-links as
 * `\x1b[36m\x1b[4m…\x1b[24m\x1b[39m`. Feeding a styled long token straight to
 * `splitToken`/`graphemes` would walk it one character at a time and see `\x1b`, `[`,
 * `3`, `6`, `m` as separate "graphemes" — cutting a line in the middle of an escape
 * sequence emits terminal garbage. So this module always segments escape sequences out
 * as atomic, zero-width units *before* any width accounting or hard-splitting, and only
 * ever hands `splitToken`/`graphemes` the escape-free visible text in between.
 */

// Deliberately matching the ESC control character to segment SGR sequences out
// atomically — see the module doc comment above.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /(\x1b\[[0-9;]*m)/;
// eslint-disable-next-line no-control-regex
const IS_ESCAPE_SEQUENCE = /^\x1b\[[0-9;]*m$/;
const WHITESPACE_RUN = /(\s+)/;
const IS_WHITESPACE = /^\s+$/;

type Entry = { kind: "word"; text: string } | { kind: "space" };

/**
 * Split `text` into word/space entries. A "word" is a maximal run with no *visible*
 * whitespace in it, but it may have complete escape sequences embedded (an escape can
 * never straddle a word/space boundary because escape sequences carry no visible
 * whitespace of their own — they are matched as whole tokens by `ESCAPE_SEQUENCE`
 * before we ever look for whitespace).
 */
function tokenize(text: string): Entry[] {
  const entries: Entry[] = [];
  let current = "";

  for (const part of text.split(ESCAPE_SEQUENCE)) {
    if (part === "") continue;
    if (IS_ESCAPE_SEQUENCE.test(part)) {
      current += part;
      continue;
    }
    for (const piece of part.split(WHITESPACE_RUN)) {
      if (piece === "") continue;
      if (IS_WHITESPACE.test(piece)) {
        if (current !== "") {
          entries.push({ kind: "word", text: current });
          current = "";
        }
        entries.push({ kind: "space" });
      } else {
        current += piece;
      }
    }
  }
  if (current !== "") entries.push({ kind: "word", text: current });
  return entries;
}

/**
 * Hard-split one over-budget word that may carry embedded (complete) escape
 * sequences. Escapes are appended verbatim wherever they fall — they're zero-width
 * and can never trip the width check — and every escape-free visible run in between
 * is split with `splitToken` (grapheme-correct, so CJK/emoji are never cut), so the
 * only new logic here is stitching those runs back together around the escapes.
 */
function splitStyledWord(word: string, limit: number, measure: Measure): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;

  const pushChunk = () => {
    if (current !== "") chunks.push(current);
    current = "";
    currentWidth = 0;
  };

  for (const part of word.split(ESCAPE_SEQUENCE)) {
    if (part === "") continue;
    if (IS_ESCAPE_SEQUENCE.test(part)) {
      current += part;
      continue;
    }
    const pieces = splitToken(part, limit, measure);
    pieces.forEach((piece, index) => {
      const pieceWidth = measure(piece);
      if (index === 0 && currentWidth > 0 && currentWidth + pieceWidth <= limit) {
        current += piece;
        currentWidth += pieceWidth;
        return;
      }
      pushChunk();
      current = piece;
      currentWidth = pieceWidth;
    });
  }
  pushChunk();
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Wrap ANSI-styled text to `width` display columns without splitting escape
 * sequences. Greedy word-fill on whitespace boundaries; any single word wider than
 * `width` is hard-split (grapheme-correct, escape-safe) rather than overflowing.
 * Never ellipsizes: `wrapAnsi(t, w).join(" ")` with ANSI stripped reproduces every
 * visible character of `t`, in order.
 */
export function wrapAnsi(text: string, width: number, measure: Measure = NARROW_MEASURE): string[] {
  const limit = Math.max(1, width);
  const entries = tokenize(text);
  if (entries.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let pendingSpace = false;

  const flushLine = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
    pendingSpace = false;
  };

  const place = (piece: string, pieceWidth: number) => {
    const needed = pieceWidth + (pendingSpace && currentWidth > 0 ? 1 : 0);
    if (currentWidth > 0 && currentWidth + needed > limit) {
      flushLine();
      current = piece;
      currentWidth = pieceWidth;
    } else {
      if (pendingSpace && currentWidth > 0) {
        current += " ";
        currentWidth += 1;
      }
      current += piece;
      currentWidth += pieceWidth;
    }
    pendingSpace = false;
  };

  for (const entry of entries) {
    if (entry.kind === "space") {
      if (currentWidth > 0) pendingSpace = true;
      continue;
    }
    const wordWidth = measure(entry.text);
    if (wordWidth <= limit) {
      place(entry.text, wordWidth);
      continue;
    }
    for (const piece of splitStyledWord(entry.text, limit, measure)) {
      place(piece, measure(piece));
    }
  }
  lines.push(current);
  return lines;
}

// Re-exported so callers that need raw grapheme counts (tests, mainly) don't have to
// reach into `./table` for it separately.
export { graphemes };
