import { parse } from "yaml";
import stringWidth from "string-width";

const DIM_START = "\x1b[2m";
const DIM_END = "\x1b[22m";

const dim = (text: string): string => `${DIM_START}${text}${DIM_END}`;

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
 * Split a leading `---`-delimited YAML block from the rest of the document.
 * Only recognizes the block when it starts at byte 0. Returns `meta: null` (body
 * unchanged) when the document doesn't open with `---`, when there is no closing
 * `---`, or when the candidate block doesn't look like YAML key/value lines (a
 * thematic break used as the first line, not frontmatter).
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
        meta: candidate,
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

function wrapValue(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (stringWidth(text) <= width) return [text];

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && stringWidth(candidate) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines.flatMap((line) => hardSplit(line, width));
}

function hardSplit(line: string, width: number): string[] {
  if (width <= 0 || stringWidth(line) <= width) return [line];

  const out: string[] = [];
  let remaining = line;
  while (stringWidth(remaining) > width) {
    let cut = width;
    while (cut > 1 && stringWidth(remaining.slice(0, cut)) > width) cut -= 1;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) out.push(remaining);
  return out;
}

function formatMapping(record: Record<string, unknown>, targetWidth: number, depth: number): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return dim("—");

  const indent = "  ".repeat(depth);
  const indentWidth = stringWidth(indent);
  const rawMaxKeyWidth = Math.max(...keys.map((key) => stringWidth(key)));
  const keyBudget = Math.max(4, Math.floor((targetWidth - indentWidth) / 2) - 2);
  const maxKeyWidth = Math.min(rawMaxKeyWidth, keyBudget);
  const keyColWidth = maxKeyWidth + 2; // ": "
  const valueWidth = Math.max(1, targetWidth - indentWidth - keyColWidth);

  const lines: string[] = [];
  for (const key of keys) {
    const value = record[key];
    const paddedKey = key.padEnd(maxKeyWidth, " ");

    if (isPlainRecord(value)) {
      if (depth >= 1) {
        lines.push(`${indent}${dim(paddedKey)}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${indent}${dim(paddedKey)}:`);
        lines.push(formatMapping(value, targetWidth, depth + 1));
      }
      continue;
    }

    const formatted = formatValue(value);
    const wrapped = wrapValue(formatted, valueWidth);
    wrapped.forEach((line, index) => {
      if (index === 0) {
        lines.push(`${indent}${dim(paddedKey)}: ${line}`);
      } else {
        lines.push(`${indent}${" ".repeat(maxKeyWidth)}  ${line}`);
      }
    });
  }

  return lines.join("\n");
}

/**
 * Render parsed frontmatter as a readable, dimmed metadata block instead of
 * stripping it (the thing `glow` fails by design). Degrades gracefully — a
 * malformed YAML block is shown raw with a parse-error note rather than
 * throwing, since the corpus is hand-edited and will contain broken blocks.
 */
export function formatMetaBlock(meta: string, targetWidth: number): string {
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
    return [dim(`! could not parse frontmatter: ${reason}`), dim(meta.trimEnd())].join("\n");
  }

  if (!isPlainRecord(data)) {
    return dim(meta.trimEnd());
  }

  return formatMapping(data, targetWidth, 0);
}
