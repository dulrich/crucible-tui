/**
 * The divergence registry — WP-1 of `plans/mdview-rust-port.md` (Decisions locked 3, D-A..D-D).
 *
 * The port's parity rule is byte-identical to the TS output, with exactly one kind of allowed
 * exception: a **registered** divergence, each with a spec citation, a ratification and a
 * witness fixture. Every differing site any gate finds is attributed here, mechanically:
 *
 * - zero entries match → `disallowed` (the site is a defect, never a pass);
 * - one entry matches but it is unratified → `disallowed`;
 * - one ratified entry matches → attributed to that entry's `id`;
 * - two or more entries match → **throw**. A predicate collision is a registry bug, and an
 *   ambiguous attribution is exactly what this module exists to rule out.
 *
 * **Sites come in two shapes.**
 *
 * - `TokenSite` (the L-gate, `scripts/lexer-diff.ts`): `path` is a JSON path into the
 *   census-normalized token tree (`scripts/token-schema.ts`); `ts` and `rust` are the minimal
 *   differing subtree on each side. Either side is a census node, an **array** of nodes (when
 *   the two children arrays differ in length the parent array is the site — see
 *   `lexer-diff.ts`'s `diffTokens`), or `undefined` (absent on that side).
 * - `RenderSite` (`kind: "render"`, the E2E gate, consumed from WP-3 on): the two rendered
 *   outputs for one file × combo, plus what the frontmatter formatter knows about its own
 *   diagnostic. D-A and D-C operate on rendered output, never on tokens, so their predicates
 *   only ever match a `RenderSite`; the lexer entries only ever match a `TokenSite`.
 *
 * Predicates are pure functions over plain JSON. **This module imports nothing** — within
 * `scripts/` or anywhere else — so it is a leaf of the scripts DAG and any instrument may
 * import it.
 */

export type Tier = "unicode" | "ascii";

/** A census node (`scripts/token-schema.ts`'s `CensusToken`, restated so this stays a leaf). */
export type Node = { type: string } & Record<string, unknown>;

export interface TokenSite {
  kind?: "token";
  /** JSON path into the normalized token tree, e.g. `$[1].tokens[2]`. */
  path: string;
  ts: Node | Node[] | undefined;
  rust: Node | Node[] | undefined;
  tier: Tier;
}

/** One side of a rendered comparison. */
export interface RenderSide {
  text: string;
  /** 1-based inclusive `[start, end]` line ranges, as `renderDocumentDetailed` returns them. */
  codeRanges: Array<[number, number]>;
  /**
   * What the frontmatter formatter reports, when the document has frontmatter: whether it
   * parsed, and — only when it did not — the 0-based half-open line span `[start, end)` of
   * the diagnostic within `text`.
   */
  frontmatter?: { parsed: boolean; diagnostic?: [number, number] };
}

export interface RenderSite {
  kind: "render";
  /** The file (and combo label) the outputs came from — informational only. */
  path: string;
  tier: Tier;
  /** The colour policy the combo rendered under: `none`/`formats` are colour-off. */
  policy: string;
  ts: RenderSide;
  rust: RenderSide;
}

export type Site = TokenSite | RenderSite;

export interface Divergence {
  id: string;
  kind: "lexer" | "frontmatter" | "highlight" | "cli";
  spec: string;
  ratified: { by: string; date: string } | null;
  /** Repo-relative path of the witness fixture. */
  witness: string;
  /**
   * `live`: the witness yields a site today (for lexer entries, against a synthesized
   * spec-correct Rust side). `pending-witness`: the site only exists once the Rust side
   * renders; the witness test skips it visibly, by id.
   */
  status: "live" | "pending-witness";
  predicate: (site: Site) => boolean;
}

export type Attribution = { id: string } | { disallowed: string };

const isRender = (site: Site): site is RenderSite => site.kind === "render";

const asArray = (side: Node | Node[] | undefined): Node[] =>
  side === undefined ? [] : Array.isArray(side) ? side : [side];

const s = (value: unknown): string => (typeof value === "string" ? value : "");

// ---------------------------------------------------------------------------
// single-tilde-del
// ---------------------------------------------------------------------------

/** A `del` marked built from exactly one tilde on each side (`~a~`, not `~~a~~`). */
export function isSingleTildeDel(node: Node): boolean {
  const raw = s(node.raw);
  return node.type === "del" && raw.startsWith("~") && !raw.startsWith("~~");
}

/**
 * Rewrite a node list the way GFM reads it: every single-tilde `del` dissolves into literal
 * text — a `~` text, its own inline children, a `~` text — and then adjacent childless
 * `text` nodes merge (`raw` and `text` concatenated). Applied recursively, so a dissolved
 * `del` nested in an `em`/`strong`/`link` is handled too. Merging is applied to both sides
 * so the comparison does not depend on where either lexer happens to split a text run.
 */
function dissolveSingleTildeDel(nodes: Node[]): Node[] {
  const out: Node[] = [];
  const push = (node: Node): void => {
    const last = out[out.length - 1];
    if (node.type === "text" && !("tokens" in node) && last && last.type === "text" && !("tokens" in last)) {
      out[out.length - 1] = { type: "text", raw: s(last.raw) + s(node.raw), text: s(last.text) + s(node.text) };
    } else {
      out.push(node);
    }
  };
  for (const node of nodes) {
    if (isSingleTildeDel(node)) {
      push({ type: "text", raw: "~", text: "~" });
      for (const child of dissolveSingleTildeDel(asArray(node.tokens as Node[] | undefined))) push(child);
      push({ type: "text", raw: "~", text: "~" });
    } else if (Array.isArray(node.tokens)) {
      push({ ...node, tokens: dissolveSingleTildeDel(node.tokens as Node[]) });
    } else {
      push(node);
    }
  }
  return out;
}

function containsSingleTildeDel(nodes: Node[]): boolean {
  return nodes.some((n) => isSingleTildeDel(n) || (Array.isArray(n.tokens) && containsSingleTildeDel(n.tokens as Node[])));
}

/**
 * `single-tilde-del` matches a token site when (1) the TS side contains at least one
 * single-tilde `del` (at the site or nested under it), and (2) dissolving every single-tilde
 * `del` on **both** sides into literal `~` text (and merging adjacent text) makes the two
 * sides deep-equal. The Rust side may hold single-tilde `del`s of its own (WP-7 attempt 2):
 * GFM pairs a closer with the *nearest* preceding opener, so `a ~:1, b ~:2 (~:3` is `a ~:1, b
 * <del>:2 (</del>:3` under the delimiter algorithm and `a <del>:1, b ~:2 (</del>:3` under marked's
 * regex — the same phenomenon, a single-tilde pairing the GFM rules would not make. So a node-level site (TS `del`, Rust
 * `text` whose `raw` is the del's `raw`) and an array-level site (TS `[text, del, text]`,
 * Rust one merged `[text]`) both match; a site where anything *else* also differs does not.
 */
function singleTildeDel(site: Site): boolean {
  if (isRender(site)) return false;
  const ts = asArray(site.ts);
  const rust = asArray(site.rust);
  if (!containsSingleTildeDel(ts)) return false;
  if (JSON.stringify(dissolveSingleTildeDel(ts)) === JSON.stringify(dissolveSingleTildeDel(rust))) return true;
  return crossMarkupTildeDel(ts, rust);
}

function countSingleTildeDel(nodes: Node[]): number {
  return nodes.reduce(
    (n, x) => n + (isSingleTildeDel(x) ? 1 : 0) + (Array.isArray(x.tokens) ? countSingleTildeDel(x.tokens as Node[]) : 0),
    0,
  );
}

/** The characters a node list spells, delimiter runs (`*_~` and backticks) and whitespace removed. */
function leafLetters(nodes: Node[]): string {
  return nodes
    .map((n) => (Array.isArray(n.tokens) ? leafLetters(n.tokens as Node[]) : s(n.text)))
    .join("")
    .replace(/[*_~`\s]/g, "");
}

/**
 * The cross-markup form (WP-7 attempt 3): marked's single-tilde `del` spans an emphasis or
 * code-span delimiter (`~5.5k … (**−84%**) … **~`), and because marked lexes the `del`'s
 * interior on its own, the delimiters it swallowed pair differently on the two sides — so
 * dissolving the `del` cannot make the trees equal. The site still matches when the Rust side
 * holds fewer single-tilde `del`s than the TS side and both sides spell the same characters
 * once delimiter runs are removed: the only difference is which delimiters paired.
 */
function crossMarkupTildeDel(ts: Node[], rust: Node[]): boolean {
  if (countSingleTildeDel(rust) >= countSingleTildeDel(ts)) return false;
  return leafLetters(ts) === leafLetters(rust);
}

// ---------------------------------------------------------------------------
// D-B task-state-prepass
// ---------------------------------------------------------------------------

/** `src/render.ts`'s `TASK_STATE_LINE`, restated (this module imports nothing). */
const TASK_STATE_LINE = /^(\s*[-*+]\s+)\[(.)\](\s)/;
/** `src/render.ts`'s `TASK_STATE_SENTINEL` (code point 1), the ASCII tier's rewrite. */
const TASK_STATE_SENTINEL = String.fromCharCode(1);

/**
 * One `code` line pair that differs only by the pre-pass's rewrite: the Rust (verbatim) line
 * is a task-state line, and the TS line is that line with `[c]` replaced by either one
 * non-ASCII glyph (the Unicode tier's `TASK_GLYPHS`) or `[<U+0001>c]` (the ASCII tier's
 * defeated-regex sentinel).
 */
function isTaskRewrite(tsLine: string, rustLine: string): boolean {
  const match = TASK_STATE_LINE.exec(rustLine);
  if (!match) return false;
  const [full, prefix, char, gap] = match;
  if (full === undefined || prefix === undefined || char === undefined || gap === undefined) return false;
  const rest = rustLine.slice(full.length);
  if (!tsLine.startsWith(prefix) || !tsLine.endsWith(gap + rest)) return false;
  const middle = tsLine.slice(prefix.length, tsLine.length - gap.length - rest.length);
  if (middle === `[${TASK_STATE_SENTINEL}${char}]`) return true;
  const points = [...middle];
  return points.length === 1 && (points[0]?.codePointAt(0) ?? 0) > 0x7f;
}

/**
 * D-B matches a token site where both sides are `code` with the same `lang`, the same line
 * count, at least one differing line, and **every** differing line pair is a task-state
 * rewrite (`isTaskRewrite`). That is the pre-pass's fence-phase corruption (`src/AGENTS.md`
 * "P1"): its line toggle disagrees with marked about where a fenced block ends and rewrites a
 * task line marked treats as verbatim code; comrak's relaxed tasklist has no pre-pass, so the
 * Rust side keeps the source bytes.
 *
 * The plan's other D-B consequence — task items inside blockquotes and ordered lists becoming
 * recognised — is `taskNowRecognised` below (WP-7); the entry's predicate is the union.
 */
function taskStatePrepass(site: Site): boolean {
  return taskFenceRewrite(site) || taskNowRecognised(site);
}

/** `src/lists.ts`'s `RAW_TASK_STATE`, restated. */
const RAW_TASK_STATE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]( *)/;

/** Strip a leading `[c] +` from an item's first text token (and its first inline text). */
function stripCheckbox(tokens: Node[], char: string): Node[] | null {
  const prefix = new RegExp(`^\\[${char.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&")}\\] +`);
  const [head, ...rest] = tokens;
  if (head === undefined || (head.type !== "text" && head.type !== "paragraph")) return null;
  const strip = (n: Node): Node | null => {
    if (n.type !== "text") return null;
    const m = prefix.exec(s(n.text));
    if (!m || !s(n.raw).startsWith(m[0])) return null;
    return { ...n, raw: s(n.raw).slice(m[0].length), text: s(n.text).slice(m[0].length) };
  };
  const inline = Array.isArray(head.tokens) ? (head.tokens as Node[]) : [];
  const [first, ...more] = inline;
  const strippedFirst = first === undefined ? null : strip(first);
  if (strippedFirst === null) return null;
  const strippedHead = head.type === "text" ? strip(head) : head;
  if (strippedHead === null) return null;
  return [{ ...strippedHead, tokens: [strippedFirst, ...more] }, ...rest];
}

/**
 * D-B's second consequence (WP-7): a task item the pre-pass's line-anchored regex never
 * reached — inside a blockquote, or in an ordered list — with an Obsidian custom state that
 * marked's GFM-only `istask` does not recognise. comrak's relaxed tasklist recognises it, so
 * the Rust item is `task: true, checked: true` with the checkbox stripped from its first text,
 * where marked kept `[c] ` as literal text. The site is the list item record; everything but
 * the checkbox must be equal.
 */
function taskNowRecognised(site: Site): boolean {
  if (isRender(site)) return false;
  if (site.ts === undefined || site.rust === undefined || Array.isArray(site.ts) || Array.isArray(site.rust)) return false;
  // A list item record carries no `type` (the census's `items` entries are not nodes).
  const ts = site.ts as Record<string, unknown>;
  const rust = site.rust as Record<string, unknown>;
  if ("type" in ts || "type" in rust || !("task" in ts) || !("task" in rust)) return false;
  if (ts.task !== false || rust.task !== true || rust.checked !== true || ts.raw !== rust.raw) return false;
  if (ts.loose !== rust.loose) return false;
  const match = RAW_TASK_STATE.exec(s(ts.raw));
  const char = match?.[1];
  if (char === undefined || char === " " || char === "x" || char === "X") return false;
  const stripped = stripCheckbox(asArray(ts.tokens as Node[] | undefined), char);
  return stripped !== null && JSON.stringify(stripped) === JSON.stringify(rust.tokens);
}

function taskFenceRewrite(site: Site): boolean {
  if (isRender(site)) return false;
  const ts = site.ts;
  const rust = site.rust;
  if (ts === undefined || rust === undefined || Array.isArray(ts) || Array.isArray(rust)) return false;
  if (ts.type !== "code" || rust.type !== "code" || ts.lang !== rust.lang) return false;
  const tsLines = s(ts.text).split("\n");
  const rustLines = s(rust.text).split("\n");
  if (tsLines.length !== rustLines.length) return false;
  let differing = 0;
  for (let i = 0; i < tsLines.length; i++) {
    const a = tsLines[i] ?? "";
    const b = rustLines[i] ?? "";
    if (a === b) continue;
    if (!isTaskRewrite(a, b)) return false;
    differing++;
  }
  return differing > 0;
}

// ---------------------------------------------------------------------------
// Render-site helpers (D-A, D-C)
// ---------------------------------------------------------------------------

// SGR only (`ESC [ … m`), which is all D-C relaxes; OSC-8/DCS stay byte-exact.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, "g");
const stripSgr = (line: string): string => line.replace(SGR, "");

const inRanges = (line1: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([start, end]) => line1 >= start && line1 <= end);

/**
 * Whether a render site's policy has colour on — the only case D-C relaxes. Callers spell the
 * policy two ways: the SgrMode names (`none`/`formats`/`full`, the witness tests) and the
 * instrument's policy names (`P0`–`P4`, `render-diff`); colour is off for `none`, `formats`,
 * `P0` and `P1`, and on for everything else.
 */
const colourOn = (policy: string): boolean => !["none", "formats", "P0", "P1"].includes(policy);

// ---------------------------------------------------------------------------
// D-A yaml-diagnostic
// ---------------------------------------------------------------------------

/**
 * D-A matches a render site where (1) both sides report frontmatter and agree it did **not**
 * parse (a diagnostic exists only on failure), (2) every line before the diagnostic is
 * identical and every line after it is identical — which includes the echoed block, so the
 * echo is byte-identical — (3) the diagnostic lines themselves differ, and (4) every
 * `codeRange` starting at or after the diagnostic is shifted by exactly the diagnostic's
 * line-count delta, every earlier one unchanged, and the range counts equal.
 *
 * **D-A composes with D-C** (2026-10-12, user-ruled): under a colour-on policy, a line after
 * the diagnostic that lies inside a TS `codeRange` is compared with SGR stripped — the
 * highlighter's bytes are D-C's to relax, not D-A's to forbid. Every other line stays exact.
 */
function yamlDiagnostic(site: Site): boolean {
  if (!isRender(site)) return false;
  const a = site.ts;
  const b = site.rust;
  const fa = a.frontmatter;
  const fb = b.frontmatter;
  if (!fa || !fb || fa.parsed || fb.parsed || !fa.diagnostic || !fb.diagnostic) return false;
  const [aStart, aEnd] = fa.diagnostic;
  const [bStart, bEnd] = fb.diagnostic;
  if (aStart !== bStart) return false;
  const aLines = a.text.split("\n");
  const bLines = b.text.split("\n");
  const before = (lines: string[]) => lines.slice(0, aStart).join("\n");
  if (before(aLines) !== before(bLines)) return false;
  const aRest = aLines.slice(aEnd);
  const bRest = bLines.slice(bEnd);
  if (aRest.length !== bRest.length) return false;
  const relax = colourOn(site.policy);
  const restEqual = aRest.every((line, i) => {
    const other = bRest[i] as string;
    if (line === other) return true;
    // 1-based TS line number of this trailing line.
    return relax && inRanges(aEnd + i + 1, a.codeRanges) && stripSgr(line) === stripSgr(other);
  });
  if (!restEqual) return false;
  if (aLines.slice(aStart, aEnd).join("\n") === bLines.slice(bStart, bEnd).join("\n")) return false;
  const delta = bEnd - bStart - (aEnd - aStart);
  if (a.codeRanges.length !== b.codeRanges.length) return false;
  return a.codeRanges.every(([start, end], i) => {
    const other = b.codeRanges[i];
    if (!other) return false;
    // 1-based ranges; the diagnostic starts at 1-based line aStart + 1.
    const shift = start >= aStart + 1 ? delta : 0;
    return other[0] === start + shift && other[1] === end + shift;
  });
}

// ---------------------------------------------------------------------------
// flow-key-mapping (user-ratified 2026-10-12)
// ---------------------------------------------------------------------------

/** The `yaml` package's invented empty-string key, as `formatMapping` lays it out: `   : c`. */
const EMPTY_KEY_LINE = /^ *: /;

/**
 * `k: [a, b]: c` (or `k: {a: 1}: c`): the `yaml` package parses it and invents a `""` key, so
 * the TS side **parsed** and its metadata block carries a line whose key is blank; yaml-rust2
 * rejects the same block ("mapping values are not allowed in this context"), so the Rust side
 * **failed** with a diagnostic.
 */
function flowKeyMapping(site: Site): boolean {
  if (!isRender(site)) return false;
  const fa = site.ts.frontmatter;
  const fb = site.rust.frontmatter;
  if (!fa || !fb || !fa.parsed || fb.parsed || !fb.diagnostic) return false;
  const [start, end] = fb.diagnostic;
  // The summary is wrapped to the target width, so the message is matched with its line
  // breaks folded back to single spaces.
  const diagnostic = site.rust.text.split("\n").slice(start, end).map(stripSgr).join(" ").replace(/\s+/g, " ");
  if (!diagnostic.includes("mapping values are not allowed in this context")) return false;
  return site.ts.text.split("\n").some((line) => EMPTY_KEY_LINE.test(stripSgr(line)));
}

// ---------------------------------------------------------------------------
// D-C hl-fence-claim
// ---------------------------------------------------------------------------

/** `src/lists.ts`'s `isPointedLine` vocabulary at a four-space indent unit, restated. */
const POINTED = /^(?: {4})*(?:\*|\d+\.)/;

/**
 * D-C (`hl-fence-claim`, `docs/agents/list-pipeline.md` "The claim decision"): a fence line
 * inside a list keeps or loses its two-column pad depending on whether the raw bytes begin
 * with an escape, and that depends on what the highlighter emitted. It matches a render site
 * under a colour-on policy (not `none`/`formats` — colour-off output is byte-exact, full
 * stop) where the two outputs have the same line count and identical `codeRanges`, and every
 * differing line (1) lies inside a `codeRange`, (2) is equal on both sides once SGR is
 * stripped *and* leading spaces removed, and (3) the shorter stripped line is a pointed line
 * (`POINTED`) with the longer one the same line behind extra leading spaces — the pad.
 *
 * Every other SGR-only fence difference is the render-diff D-C *channel*'s (SGR-stripped
 * fence comparison), not a site; this entry covers only the pad that survives stripping.
 */
function hlFenceClaim(site: Site): boolean {
  if (!isRender(site)) return false;
  if (!colourOn(site.policy)) return false;
  const a = site.ts;
  const b = site.rust;
  if (JSON.stringify(a.codeRanges) !== JSON.stringify(b.codeRanges)) return false;
  const aLines = a.text.split("\n");
  const bLines = b.text.split("\n");
  if (aLines.length !== bLines.length) return false;
  let differing = 0;
  for (let i = 0; i < aLines.length; i++) {
    if (aLines[i] === bLines[i]) continue;
    if (!inRanges(i + 1, a.codeRanges)) return false;
    const x = stripSgr(aLines[i] ?? "");
    const y = stripSgr(bLines[i] ?? "");
    if (x === y) return false; // an SGR-only difference is the channel's, not this entry's
    const [shorter, longer] = x.length < y.length ? [x, y] : [y, x];
    if (!POINTED.test(shorter) || !longer.endsWith(shorter) || longer.slice(0, longer.length - shorter.length).trim() !== "") {
      return false;
    }
    differing++;
  }
  return differing > 0;
}

// ---------------------------------------------------------------------------
// tilde-backtick-run
// ---------------------------------------------------------------------------

/** A run mixing `~` and backticks — what marked's GFM `inline.text` start `[`~]+` swallows. */
const MIXED_RUN = /~`|`~/;

/**
 * The inline source a node list spells, up to delimiter choice: text by `raw`, a code span
 * as `` `text` ``, an escape as `\c`, a `del` by `raw`, any other container as its type
 * around its flattened children, and anything else by its JSON.
 */
function flattenInline(nodes: Node[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return Array.isArray(n.tokens) ? flattenInline(n.tokens as Node[]) : s(n.raw);
        case "codespan":
          return `\`${s(n.text)}\``;
        case "escape":
          return `\\${s(n.text)}`;
        case "del":
          return s(n.raw);
        case "strong":
        case "em":
        case "link":
          return `<${n.type} ${s(n.href)}>${flattenInline(asArray(n.tokens as Node[] | undefined))}</${n.type}>`;
        default:
          return JSON.stringify(n);
      }
    })
    .join("");
}

function hasMixedRunText(nodes: Node[]): boolean {
  return nodes.some(
    (n) =>
      (n.type === "text" && !Array.isArray(n.tokens) && MIXED_RUN.test(s(n.raw))) ||
      (Array.isArray(n.tokens) && hasMixedRunText(n.tokens as Node[])),
  );
}

/**
 * `tilde-backtick-run` matches a token site when the TS side holds a `text` whose `raw`
 * contains a `~` adjacent to a backtick, the Rust side holds none, and both sides spell the
 * same inline source (`flattenInline`) — so the only difference is where code spans were
 * recognised (up to whitespace, see below). marked's GFM text rule starts `^([`~]+|...)`, which consumes a mixed
 * tilde/backtick run as literal text, so the backtick string in it never opens a code span.
 */
function tildeBacktickRun(site: Site): boolean {
  if (isRender(site)) return false;
  const ts = asArray(site.ts);
  const rust = asArray(site.rust);
  if (!hasMixedRunText(ts) || hasMixedRunText(rust)) return false;
  // A code span's content drops one space at each end (§6.3), so the side that sees a span
  // where the other sees text spells different spaces: compare with whitespace removed.
  // A codespan's `text` is entity-escaped where a `text` node's `raw` is not: decode both.
  const bare = (nodes: Node[]): string =>
    flattenInline(nodes)
      .replace(/\s+/g, "")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  if (bare(ts) === bare(rust)) return true;
  // The span boundary moved, so later delimiter runs (`*`, `_`, backticks) can pair
  // differently too: the sides still spell the same characters once those runs are removed.
  return leafLetters(ts) === leafLetters(rust);
}

// ---------------------------------------------------------------------------
// nested-bracket-label
// ---------------------------------------------------------------------------

/** Deepest balanced-bracket nesting inside a label (`a [b [c]]` -> 2); escaped brackets skip. */
function bracketDepth(label: string): number {
  let depth = 0;
  let max = 0;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === "\\") i++;
    else if (c === "[") max = Math.max(max, ++depth);
    else if (c === "]") depth = Math.max(0, depth - 1);
  }
  return max;
}

/**
 * `nested-bracket-label` matches an inline array where the Rust side holds a `link`/`image`
 * whose label nests brackets two deep (`label [[note]]`, `link [foo [bar]]`) and the TS side
 * holds no link/image with that label. marked 14's link `label` pattern admits one level of
 * nested brackets only, so a deeper label (a wiki-link in it included) stays literal text.
 */
function nestedBracketLabel(site: Site): boolean {
  if (isRender(site)) return false;
  const linkish = (n: Node): boolean => n.type === "link" || n.type === "image";
  const tsLabels = new Set(asArray(site.ts).filter(linkish).map((n) => s(n.text)));
  return asArray(site.rust).some((n) => linkish(n) && bracketDepth(s(n.text)) >= 2 && !tsLabels.has(s(n.text)));
}

// ---------------------------------------------------------------------------
// html-close-tag-interrupt
// ---------------------------------------------------------------------------

/**
 * `html-close-tag-interrupt` matches a block array holding, at the same index on both sides,
 * a `list` whose TS last item ends in an `html` token opening with `</`, where the Rust side's
 * next block is an `html` token with the same text (trailing newlines aside). marked 14's list
 * item loop stops a lazy line only at `htmlBeginRegex` (`<(?:[a-z].*>|!--)`), which a closing
 * tag (`</details>`) does not match, so the line joins the item; CommonMark's type-6 start
 * condition includes `</`, and that block may interrupt a paragraph, so it ends the list.
 */
function htmlCloseTagInterrupt(site: Site): boolean {
  if (isRender(site)) return false;
  const ts = asArray(site.ts);
  const rust = asArray(site.rust);
  return ts.some((list, k) => {
    if (list.type !== "list" || rust[k]?.type !== "list") return false;
    const items = asArray(list.items as Node[] | undefined);
    const tail = asArray(items[items.length - 1]?.tokens as Node[] | undefined).at(-1);
    const next = rust[k + 1];
    if (tail?.type !== "html" || !s(tail.text).startsWith("</") || next?.type !== "html") return false;
    return s(next.text).trimEnd() === s(tail.text).trimEnd();
  });
}

// ---------------------------------------------------------------------------
// hljs-prototype-key
// ---------------------------------------------------------------------------

const UNDEFINED = /undefined/g;

/**
 * `hljs-prototype-key` (2026-10-12, user-ratified): `src/highlight.ts:232` looks a span class
 * up as `THEME[frame.token] ?? null` on a plain object literal, so the class `constructor`
 * (emitted only by highlight.js 10.7.3's ReasonML grammar, `reasonml.js:186,213`, which
 * `highlightAuto` also picks for untagged fences) finds the inherited `Object` function;
 * `applyStyle` then concatenates its undefined open/close (`src/style.ts:388`) and the code
 * reads `getundefinedByRole()undefined`. The port's theme lookup has no prototype.
 *
 * Matches a colour-on render site with identical `codeRanges` and line count where every
 * differing line lies inside a `codeRange`, and the two lines are equal once SGR is stripped
 * and every literal `undefined` removed, with TS carrying strictly more of them. This is the
 * one entry allowed to claim a code-content (class C) diff — see `CODE_CONTENT_CLAIMS`.
 */
function hljsPrototypeKey(site: Site): boolean {
  if (!isRender(site) || !colourOn(site.policy)) return false;
  const a = site.ts;
  const b = site.rust;
  if (JSON.stringify(a.codeRanges) !== JSON.stringify(b.codeRanges)) return false;
  const aLines = a.text.split("\n");
  const bLines = b.text.split("\n");
  if (aLines.length !== bLines.length) return false;
  let differing = 0;
  for (let i = 0; i < aLines.length; i++) {
    const x = aLines[i] as string;
    const y = bLines[i] as string;
    if (x === y) continue;
    if (!inRanges(i + 1, a.codeRanges)) return false;
    const sx = stripSgr(x);
    const sy = stripSgr(y);
    if (sx === sy) continue; // an SGR-only fence difference: D-C's channel, not this entry's
    const extra = (sx.match(UNDEFINED)?.length ?? 0) - (sy.match(UNDEFINED)?.length ?? 0);
    if (extra <= 0 || sx.replace(UNDEFINED, "") !== sy.replace(UNDEFINED, "")) return false;
    differing += 1;
  }
  return differing > 0;
}

/**
 * Registry ids allowed to claim a pair whose **code content** differs (the class C
 * `diff-classify.ts` otherwise decides before any attribution). Only an entry whose spec is a
 * TS defect *inside* code output belongs here.
 */
export const CODE_CONTENT_CLAIMS: ReadonlySet<string> = new Set(["hljs-prototype-key"]);

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const REGISTRY: readonly Divergence[] = [
  {
    id: "single-tilde-del",
    kind: "lexer",
    spec:
      'GFM spec 0.29-gfm, "Strikethrough (extension)": a tilde run opens/closes only when ' +
      "left-/right-flanking per the emphasis delimiter-run rules; marked's `del` regex pairs " +
      "single tildes the flanking rules would not (e.g. `(~line 79) … (~line 90)`), including " +
      "pairing a closer with an opener other than the nearest one the delimiter algorithm " +
      "(\"process emphasis\") would choose (e.g. `a ~:1, b ~:2 (~:3`).",
    ratified: { by: "user", date: "2026-10-11" },
    witness: "tests/fixtures/divergences/single-tilde-del.md",
    status: "live",
    predicate: singleTildeDel,
  },
  {
    id: "yaml-diagnostic",
    kind: "frontmatter",
    spec:
      "plans/mdview-rust-port.md D-A: the `yaml` package's parse-error text (src/frontmatter.ts " +
      "catch branch) is not yaml-rust2's; allowed only within the diagnostic lines, same parse " +
      "verdict, identical echo, codeRanges shifted by exactly the diagnostic line delta.",
    ratified: { by: "user (plan approval)", date: "2026-10-11" },
    witness: "tests/fixtures/divergences/yaml-diagnostic.md",
    status: "pending-witness",
    predicate: yamlDiagnostic,
  },
  {
    id: "flow-key-mapping",
    kind: "frontmatter",
    spec:
      "YAML 1.2.2 §8.2.2 (\"Block Mappings\") and §7.4.2/§7.4.3 (a flow collection may be an " +
      "implicit key only where a key is allowed — in a block-mapping *value*, `[a, b]: c` is a " +
      "compact implicit mapping, which §8.2.2 does not permit on the value line): " +
      "`not: [a, b]: c` is ill-formed, and yaml-rust2 rejects it (\"mapping values are not allowed " +
      "in this context\"). The `yaml` package (2.9.0) accepts it: " +
      "node_modules/yaml/dist/parse/parser.js:833-839 pops the flow collection when a `:` follows " +
      "it at the parent block map's indent, :646-647 then opens a new block-map item with " +
      "`key: null`, and node_modules/yaml/dist/nodes/addPairToJSMap.js:40-41 (stringifyKey) " +
      "turns the null key into \"\" — `{\"not\":[\"a\",\"b\"],\"\":\"c\"}`, rendered as `not : a, b` / " +
      "`    : c`. Synthetic only (census); no corpus file reaches it. Ratified 2026-10-12: invalid " +
      "YAML gets a parse error, not an invented key.",
    ratified: { by: "user", date: "2026-10-12" },
    witness: "tests/fixtures/divergences/flow-key-mapping.md",
    status: "pending-witness",
    predicate: flowKeyMapping,
  },
  {
    id: "task-state-prepass",
    kind: "lexer",
    spec:
      "plans/mdview-rust-port.md D-B: the task-state pre-pass is retired; its fence toggle " +
      'rewrites task lines marked treats as fenced code (src/AGENTS.md "P1"), CommonMark ' +
      "0.31 §4.5 says fenced-code content is literal; and task items the pre-pass's " +
      "line-anchored regex never reached (blockquote, ordered list) become recognised under " +
      "comrak's relaxed tasklist, which D-B's text names.",
    ratified: { by: "user (plan approval)", date: "2026-10-11" },
    witness: "tests/fixtures/divergences/task-state-prepass.md",
    status: "live",
    predicate: taskStatePrepass,
  },
  {
    id: "hl-fence-claim",
    kind: "highlight",
    spec:
      "plans/mdview-rust-port.md D-C: highlight.js 10.7.3 → syntect; the list-embedded fence " +
      "line pad depends on a leading escape (docs/agents/list-pipeline.md, \"The claim decision\").",
    ratified: { by: "user (plan approval)", date: "2026-10-11" },
    witness: "tests/fixtures/divergences/hl-fence-claim.md",
    status: "live",
    predicate: hlFenceClaim,
  },
  {
    id: "tilde-backtick-run",
    kind: "lexer",
    spec:
      'GFM spec 0.29-gfm §6.3 "Code spans": "A backtick string is a string of one or more ' +
      'backtick characters (`) that is neither preceded nor followed by a backtick" and "A code ' +
      'span begins with a backtick string and ends with a backtick string of equal length"; a ' +
      "preceding `~` does not stop a backtick string. marked 14's GFM `inline.text` rule starts " +
      "`^([`~]+|[^`~])`, consuming a mixed tilde/backtick run as text (e.g. `(~`a`)`).",
    ratified: { by: "user", date: "2026-10-11" },
    witness: "tests/fixtures/divergences/tilde-backtick-run.md",
    status: "live",
    predicate: tildeBacktickRun,
  },
  {
    id: "nested-bracket-label",
    kind: "lexer",
    spec:
      'CommonMark 0.31.2 §6.3 "Links": "Brackets are allowed in the link text only if (a) they ' +
      'are backslash-escaped or (b) they appear as a matched pair of brackets", at any depth: ' +
      "example 512 `[link [foo [bar]]](/uri)` and example 528 (its full-reference form) are links; " +
      "§6.4: an image description follows the same rules. marked 14's link `label` pattern admits " +
      "one nesting level, so a deeper label stays literal (e.g. `[label [[note]]](url)`, a " +
      "wiki-link inside a link label or image alt).",
    ratified: { by: "user", date: "2026-10-12" },
    witness: "tests/fixtures/divergences/nested-bracket-label.md",
    status: "live",
    predicate: nestedBracketLabel,
  },
  {
    id: "html-close-tag-interrupt",
    kind: "lexer",
    spec:
      'CommonMark 0.31.2 §4.6 "HTML blocks": start condition 6 is a "line [that] begins with the ' +
      'string < or </ followed by one of the strings" (block tag names), and "All types of HTML ' +
      'blocks except type 7 may interrupt a paragraph"; §5.2 rule 5 allows a lazy line only for ' +
      "paragraph continuation text. So `- item` followed by `</details>` at column 0 ends the " +
      "list with an html block. marked 14's list loop breaks only on `<(?:[a-z].*>|!--)`, which " +
      "misses the closing tag, and keeps the line inside the item.",
    ratified: { by: "user", date: "2026-10-12" },
    witness: "tests/fixtures/divergences/html-close-tag-interrupt.md",
    status: "live",
    predicate: htmlCloseTagInterrupt,
  },
  {
    id: "hljs-prototype-key",
    kind: "highlight",
    spec:
      "TS defect, fixed by the port: src/highlight.ts:232 `THEME[frame.token] ?? null` reads the " +
      "inherited Object.prototype `constructor` for highlight.js 10.7.3's ReasonML `hljs-constructor` " +
      "class (node_modules/highlight.js/lib/languages/reasonml.js:186,213; also reached by " +
      "highlightAuto on untagged fences), so applyStyle (src/style.ts:388) writes literal `undefined` " +
      "around the span: `getundefinedByRole()undefined`. Colour-off output is unaffected.",
    ratified: { by: "user", date: "2026-10-12" },
    witness: "tests/fixtures/divergences/hljs-prototype-key.md",
    status: "live",
    predicate: hljsPrototypeKey,
  },
];

/**
 * Attribute one site. Zero matches or an unratified match → `disallowed`; two or more
 * matches → throws, naming every matching id.
 */
export function attribute(site: Site, registry: readonly Divergence[] = REGISTRY): Attribution {
  const matches = registry.filter((entry) => entry.predicate(site));
  if (matches.length > 1) {
    throw new Error(
      `divergences: predicate collision at ${site.path} — ${matches.map((m) => m.id).join(" and ")} all match one site`,
    );
  }
  const [match] = matches;
  if (match === undefined) return { disallowed: `no registered divergence matches the site at ${site.path}` };
  if (match.ratified === null) return { disallowed: `${match.id} matches but is not ratified` };
  return { id: match.id };
}
