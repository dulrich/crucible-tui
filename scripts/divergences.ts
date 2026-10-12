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
 * single-tilde `del` (at the site or nested under it), (2) the Rust side contains none, and
 * (3) dissolving every such `del` on the TS side into literal `~` text (and merging adjacent
 * text on both sides) makes the two sides deep-equal. So a node-level site (TS `del`, Rust
 * `text` whose `raw` is the del's `raw`) and an array-level site (TS `[text, del, text]`,
 * Rust one merged `[text]`) both match; a site where anything *else* also differs does not.
 */
function singleTildeDel(site: Site): boolean {
  if (isRender(site)) return false;
  const ts = asArray(site.ts);
  const rust = asArray(site.rust);
  if (!containsSingleTildeDel(ts) || containsSingleTildeDel(rust)) return false;
  return JSON.stringify(dissolveSingleTildeDel(ts)) === JSON.stringify(dissolveSingleTildeDel(rust));
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
 * Scope, stated rather than implied: the plan's other D-B consequence — task items inside
 * blockquotes and ordered lists becoming recognised — has no corpus instance today and is a
 * render-level question; it is not matched here and would surface as `disallowed`.
 */
function taskStatePrepass(site: Site): boolean {
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
  if (aLines.slice(aEnd).join("\n") !== bLines.slice(bEnd).join("\n")) return false;
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
  if (site.policy === "none" || site.policy === "formats") return false;
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
// The registry
// ---------------------------------------------------------------------------

export const REGISTRY: readonly Divergence[] = [
  {
    id: "single-tilde-del",
    kind: "lexer",
    spec:
      'GFM spec 0.29-gfm, "Strikethrough (extension)": a tilde run opens/closes only when ' +
      "left-/right-flanking per the emphasis delimiter-run rules; marked's `del` regex pairs " +
      "single tildes the flanking rules would not (e.g. `(~line 79) … (~line 90)`).",
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
    id: "task-state-prepass",
    kind: "lexer",
    spec:
      "plans/mdview-rust-port.md D-B: the task-state pre-pass is retired; its fence toggle " +
      'rewrites task lines marked treats as fenced code (src/AGENTS.md "P1"), CommonMark ' +
      "0.31 §4.5 says fenced-code content is literal.",
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
    status: "pending-witness",
    predicate: hlFenceClaim,
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
