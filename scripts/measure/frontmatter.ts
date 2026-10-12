/**
 * scripts/measure/frontmatter.ts — the frontmatter split, and nothing else.
 *
 * Moved from `TS_BASELINE` `src/frontmatter.ts` at WP-9 of `plans/mdview-rust-port.md`: the detectors'
 * block-end probe and `scripts/risk-sample.ts` need to know where a body starts, and that is
 * all. The metadata block itself — YAML parsing, formatting, the degraded paths — is the Rust
 * crate's `frontmatter.rs`; the TypeScript original is `TS_BASELINE` (`c097c66`)
 * `src/frontmatter.ts`.
 */
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
