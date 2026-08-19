import { parse } from "yaml";
import { type SgrMode } from "./colour";
import { createStyler, styleSpan } from "./style";
import { NARROW_MEASURE, type Measure } from "./width";

/**
 * `chalk.dim`'s pair, `2m`/`22m` — the two constants this module used to spell out for
 * itself, now read from the one committed style table (`src/style.ts`, WP-2 of
 * `plans/colour-policy.md`). The bytes are the same bytes.
 */
const DIM = createStyler("dim");

/**
 * Dim a metadata key, or leave it alone — **now a decision this module is told rather than
 * one it makes** (WP-1 of `plans/colour-policy.md`).
 *
 * Until that package this function had no `color` argument and no caller could give it one:
 * every key, every diagnostic and every raw echo in this file went out wrapped in `2m`/`22m`
 * **at every colour level**, including a plain `mdview file.md > out.txt`. That made
 * frontmatter one of the five independent colour authorities the plan enumerates, and it is
 * the one that contradicted the ratified Decision 1 — *default non-TTY stdout emits zero
 * tool-generated escape bytes* — on any document that has frontmatter at all.
 *
 * The bytes are unchanged, and since WP-2 they come from the one committed style table
 * rather than from two constants declared here.
 *
 * **It emits through `styleSpan`, not `applyStyle`, and that is a measured choice.** Half
 * this module's dimmed spans are multi-line — the raw echo of an unparseable frontmatter
 * block, and the wrapped parse diagnostic above it — and today each carries exactly one
 * `2m`/`22m` pair around the whole span. `chalk`'s rule (which `applyStyle` reproduces for
 * the inline and block producers, because *their* bytes are chalk's) closes and reopens at
 * every newline, so routing this through it would emit one pair per line and move
 * forced-colour bytes on the two frontmatter witnesses in the gate corpus. Same table,
 * same gate, different application rule — see `src/style.ts`.
 */
const dim = (text: string, sgr: SgrMode): string => styleSpan({ sgr }, DIM, text);

// A line must look like a plausible top-level YAML key ("key:" or "key: value")
// before a `---`...`---` pair is trusted as frontmatter. Without this guard, a
// document that simply *opens* with a thematic-break `---` and later contains an
// unrelated `---` (another rule, or a second thematic break) would have its head
// sliced off — the exact bug in glow's `detectFrontmatter`. Requiring the first
// non-blank line inside the candidate block to look like `key:` keeps a genuine
// hr-then-prose-then-hr document intact.
const FIRST_KEY_LINE = /^[^\s:#][^:\n]*:(\s|$)/;

function looksLikeYamlBlock(candidate: string): boolean {
  const firstMeaningfulLine = candidate.split("\n").find((line) => line.trim() !== "");
  if (firstMeaningfulLine === undefined) return false;
  return FIRST_KEY_LINE.test(firstMeaningfulLine.trim());
}

/**
 * Normalize CRLF (and a lone trailing CR) to LF inside a frontmatter block.
 *
 * **The delimiter scan already tolerates CRLF; the payload handed to the parser did
 * not — and that was a silent correctness failure, not a cosmetic one.** `---\r\n` is
 * recognized as a fence because the loop above strips `\r$` before comparing, but the
 * *candidate* slice keeps every `\r`, so a fully CRLF-authored file reached `yaml`
 * with a carriage return riding the end of every key. The parser rejects that as
 * `Unexpected scalar at node end`, `formatMetaBlock` falls into its degraded path, and
 * a file whose YAML is perfectly valid gets its frontmatter dumped raw at source width
 * — measured at 650 columns on a real Windows-authored `SKILL.md` (738 bytes with the
 * carriage returns, does not parse; 732 without, parses and renders at 100 clean).
 *
 * Line terminators are not content. Stripping them here is the one place that keeps
 * "show what the file says" (this module's contract) and "hand the parser bytes that
 * parse" from contradicting each other: the raw echo the degraded path prints is also
 * better off without bare `\r` bytes, which a terminal would act on rather than show.
 *
 * The **body** is deliberately left alone. Measured on a fully CRLF README with a
 * 10-column table: rendering the raw source and rendering a CRLF-normalized copy
 * produce byte-identical output at width 80 and 100, because `marked` normalizes line
 * endings itself. Normalizing the body here would be an unverifiable change to every
 * CRLF document's rendering path in exchange for nothing.
 */
function normalizeLineEndings(block: string): string {
  return block.replace(/\r\n/g, "\n").replace(/\r$/, "");
}

/**
 * Split a leading `---`-delimited YAML block from the rest of the document.
 * Only recognizes the block when it starts at byte 0. Returns `meta: null` (body
 * unchanged) when the document doesn't open with `---`, when there is no closing
 * `---`, or when the candidate block doesn't look like YAML key/value lines (a
 * thematic break used as the first line, not frontmatter).
 *
 * `meta` comes back with LF line endings regardless of how the file was authored —
 * see `normalizeLineEndings`. `body` is returned exactly as it appeared in `source`.
 */
export function splitFrontmatter(source: string): { meta: string | null; body: string } {
  const firstNewline = source.indexOf("\n");
  if (firstNewline === -1 || source.slice(0, firstNewline).replace(/\r$/, "") !== "---") {
    return { meta: null, body: source };
  }

  const yamlStart = firstNewline + 1;
  let lineStart = yamlStart;
  while (lineStart <= source.length) {
    const nextNewline = source.indexOf("\n", lineStart);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (line === "---") {
      const yamlEnd = lineStart > yamlStart && source[lineStart - 1] === "\n" ? lineStart - 1 : lineStart;
      const candidate = source.slice(yamlStart, yamlEnd);
      if (!looksLikeYamlBlock(candidate)) break;
      return {
        meta: normalizeLineEndings(candidate),
        body: nextNewline === -1 ? "" : source.slice(nextNewline + 1),
      };
    }

    if (nextNewline === -1) break;
    lineStart = nextNewline + 1;
  }

  return { meta: null, body: source };
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD`, optionally followed by a time part. Under the default YAML 1.2 schema a
 * date-only value already arrives as "2026-07-06" (so this is a no-op for it); this trims
 * the full-timestamp form down to the date, which is the whole date requirement.
 */
const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function trimIsoDate(value: string): string {
  const match = ISO_TIMESTAMP.exec(value.trim());
  return match?.[1] ?? value;
}

function formatScalar(value: unknown): string {
  if (value instanceof Date) return formatDate(value);
  if (value === null || value === undefined) return "—";
  // An empty (or whitespace-only) string gets the same em-dash as `[]` and null. The
  // corpus writes `tags: ""` on files with no tags, and rendering that as blank makes
  // the metadata block look broken rather than empty — the exact failure the em-dash
  // rule exists to prevent.
  if (typeof value === "string") {
    return value.trim() === "" ? "—" : trimIsoDate(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? String(value);
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map((item) => formatScalar(item)).join(", ");
  }
  return formatScalar(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function wrapValue(text: string, width: number, measure: Measure): string[] {
  if (width <= 0) return [text];
  if (measure(text) <= width) return [text];

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && measure(candidate) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines.flatMap((line) => hardSplit(line, width, measure));
}

function hardSplit(line: string, width: number, measure: Measure): string[] {
  if (width <= 0 || measure(line) <= width) return [line];

  const out: string[] = [];
  let remaining = line;
  while (measure(remaining) > width) {
    let cut = width;
    while (cut > 1 && measure(remaining.slice(0, cut)) > width) cut -= 1;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) out.push(remaining);
  return out;
}

function formatMapping(
  record: Record<string, unknown>,
  targetWidth: number,
  depth: number,
  measure: Measure,
  sgr: SgrMode,
): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return dim("—", sgr);

  const indent = "  ".repeat(depth);
  const indentWidth = measure(indent);
  const rawMaxKeyWidth = Math.max(...keys.map((key) => measure(key)));
  const keyBudget = Math.max(4, Math.floor((targetWidth - indentWidth) / 2) - 2);
  const maxKeyWidth = Math.min(rawMaxKeyWidth, keyBudget);
  const keyColWidth = maxKeyWidth + 2; // ": "
  const valueWidth = Math.max(1, targetWidth - indentWidth - keyColWidth);

  const lines: string[] = [];
  for (const key of keys) {
    const value = record[key];
    const paddedKey = key.padEnd(maxKeyWidth, " ");

    if (isPlainRecord(value) && depth < 1) {
      lines.push(`${indent}${dim(paddedKey, sgr)}:`);
      lines.push(formatMapping(value, targetWidth, depth + 1, measure, sgr));
      continue;
    }

    // A nested mapping at depth >= 1 stops recursing and is stringified instead, so the
    // whole subtree stays on one logical value rather than growing another indent level.
    // **It still has to fit.** This was the single branch in this function that emitted a
    // line without ever consulting `targetWidth` — `JSON.stringify` of a deep mapping is
    // unbounded, and it went straight to `lines.push`. It now goes through `wrapValue`
    // exactly like every scalar sibling below; the discriminator that identified it was
    // that its rendered line number *moved* as the target narrowed, proving every other
    // value in the same block was already wrapping and only this one was not.
    const formatted = isPlainRecord(value) ? JSON.stringify(value) : formatValue(value);
    const wrapped = wrapValue(formatted, valueWidth, measure);
    wrapped.forEach((line, index) => {
      if (index === 0) {
        lines.push(`${indent}${dim(paddedKey, sgr)}: ${line}`);
      } else {
        lines.push(`${indent}${" ".repeat(maxKeyWidth)}  ${line}`);
      }
    });
  }

  return lines.join("\n");
}

export interface MetaBlockResult {
  text: string;
  /**
   * 1-based, inclusive line ranges **within `text`** that reproduce the file's own
   * bytes verbatim and must therefore be exempt from the width check, exactly as a
   * fenced code block's lines are (`render.ts` merges these into its `codeRanges`).
   *
   * Empty on the success path, and that is the whole point of the field existing
   * rather than the call site exempting `formatMetaBlock`'s output wholesale: a meta
   * block that parses is *our* layout, we chose every column of it, and a width bug
   * there must still turn the gate red. Only the degraded path — where the module's
   * contract is "show what the file says, never invent" — is exempt.
   */
  verbatimRanges: Array<[number, number]>;
}

const lineSpan = (block: string, offset: number): [number, number] => [
  offset + 1,
  offset + block.split("\n").length,
];

/**
 * Render parsed frontmatter as a readable, dimmed metadata block instead of
 * stripping it (the thing `glow` fails by design). Degrades gracefully — a
 * malformed YAML block is shown raw with a parse-error note rather than
 * throwing, since the corpus is hand-edited and will contain broken blocks.
 *
 * Returns the raw block's line span alongside the text so the caller can exempt it
 * from the width check; see `MetaBlockResult.verbatimRanges`. `formatMetaBlock` is the
 * text-only wrapper for callers (and tests) that do not need the spans.
 *
 * **`sgr` defaults to `"none"`, and the direction of that default is deliberate** (WP-1 of
 * `plans/colour-policy.md`; the parameter was `color = false` until WP-2 of
 * `plans/colour-modes.md` widened it to the mode). This module used to dim
 * unconditionally, so the historical behaviour is the styled branch — defaulting to it would have preserved more bytes and
 * would have been the wrong choice: a caller that has not thought about colour is a caller
 * that has not established the destination can take escape sequences, and the ratified
 * floor for an unestablished destination is no escapes at all. `src/render.ts` is the one
 * production caller and it always passes the resolved policy.
 */
export function formatMetaBlockDetailed(
  meta: string,
  targetWidth: number,
  measure: Measure = NARROW_MEASURE,
  sgr: SgrMode = "none",
): MetaBlockResult {
  let data: unknown;
  try {
    // Deliberately the default ("core", YAML 1.2) schema. The "yaml-1.1" schema does
    // convert unquoted timestamps to `Date`, but it also resurrects YAML 1.1's footguns:
    // `no`/`yes`/`off` become booleans (the "Norway problem") and `12:30` becomes the
    // sexagesimal number 750. A viewer must show what the file says, so we never let the
    // parser rewrite scalars. Date-like strings are trimmed in `formatScalar` instead —
    // which is all the requirement ever needed, since `created: 2026-07-06` already
    // arrives as the string "2026-07-06" under this schema.
    //
    // `logLevel: "error"` because `yaml` reports recoverable oddities through
    // `process.emitWarning` (yaml/dist/log.js), not a return value — so Node's default
    // handler prints a ~15-line stack trace to stderr and no try/catch here can stop it.
    // Obsidian templates trigger this: `created: {{today}}` parses as a flow mapping used
    // as a key, giving "Keys with collection values will be stringified". Those files are
    // placeholders that will never be valid YAML, and a *viewer* has no business narrating
    // parser internals to the terminal. Full-vault sweep: 12 warnings across 4 template
    // files before this, 0 after.
    //
    // NOT `"silent"` — that also suppresses *errors*, so `title: [unterminated` would come
    // back as a silently-guessed `["unterminated"]` instead of throwing to the catch below
    // and being shown raw. That would violate this module's whole contract (show what the
    // file says, never invent). `"error"` disables `warn()` while leaving throws intact;
    // the "degrades gracefully" test below pins the distinction.
    data = parse(meta, { logLevel: "error" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // `reason` is two things joined: a one-line summary ending in `at line N, column M`,
    // and — optionally — a blank line, an excerpt of the offending source line, and a
    // caret under the offending column.
    //
    // **The summary is ours to wrap; the excerpt is not.** The summary is prose we
    // prefixed and it was the only part measured over budget (105 columns at target 80
    // in the real case). The excerpt/caret pair is a two-line unit whose second line is
    // positional — re-folding it would slide the caret off the column it points at, and
    // there is little to gain: `yaml` already folds its own excerpt and ellipsizes the
    // remainder. Measured across every unparseable frontmatter block on disk (24 files,
    // targets 80/100/116/160/346): zero non-exempt over-width lines.
    //
    // **That fold is 80 *characters*, not 80 columns**, which is a known and deliberate
    // gap rather than a claim of safety: a frontmatter block whose offending line is CJK
    // renders the excerpt at up to 152 columns against a target of 80. No corpus file
    // does this today. It is left un-exempt on purpose — if such a file appears the gate
    // goes red and someone decides, instead of the tool silently emitting an over-width
    // line forever.
    //
    // Truncating the summary instead of wrapping it was considered and rejected: at
    // width 80 it drops `at line 2, column 14`, which is the only reason a parse
    // diagnostic exists at all.
    const breakAt = reason.indexOf("\n");
    const summary = breakAt === -1 ? reason : reason.slice(0, breakAt);
    const detail = breakAt === -1 ? "" : reason.slice(breakAt);
    const diagnostic = dim(
      wrapValue(`! could not parse frontmatter: ${summary}`, targetWidth, measure).join("\n") + detail,
      sgr,
    );
    const echo = dim(meta.trimEnd(), sgr);
    return {
      text: `${diagnostic}\n${echo}`,
      verbatimRanges: [lineSpan(echo, diagnostic.split("\n").length)],
    };
  }

  if (!isPlainRecord(data)) {
    const echo = dim(meta.trimEnd(), sgr);
    return { text: echo, verbatimRanges: [lineSpan(echo, 0)] };
  }

  return { text: formatMapping(data, targetWidth, 0, measure, sgr), verbatimRanges: [] };
}

export function formatMetaBlock(
  meta: string,
  targetWidth: number,
  measure: Measure = NARROW_MEASURE,
  sgr: SgrMode = "none",
): string {
  return formatMetaBlockDetailed(meta, targetWidth, measure, sgr).text;
}
