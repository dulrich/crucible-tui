/**
 * The census schema — WP-1 of `plans/mdview-rust-port.md`, step 0(a).
 *
 * Historical as of `TS_BASELINE` (`c097c66`): the TS lexer this projected is deleted, and the
 * module stays only because `scripts/divergences.ts`' frozen predicates read its types. The
 * `src/*.ts` citations below name that sha's tree.
 *
 * For each of the 19 token types `TS_BASELINE` `src/walk.ts` dispatches (marked's 18 plus `wikilink`), the
 * fields some renderer module reads, and nothing else. `crates/mdview/src/token.rs` is the same
 * schema as a Rust enum; this module projects a marked token list onto it, so a dump is stable
 * (no `raw` noise the renderer never reads, no marked-internal fields) and the L-gate compares
 * the two sides field for field. `raw` is carried on `text` tokens (the walk's synthesized
 * paragraph and `renderTaskState` read and rewrite it), on list items (`RAW_TASK_STATE`) and on
 * `del` (the `single-tilde-del` divergence predicate reads it).
 *
 * `tokens` on a `text` token is emitted **only when present**: its presence is load-bearing
 * (`TS_BASELINE` `src/list-layout.ts`'s tight-item test tells a block text token from an inline one by it).
 *
 * **This module imports nothing**, within `scripts/` or `src/` — a leaf of the scripts DAG.
 */

export type CensusToken = { type: string } & Record<string, unknown>;

/** Every token type the walk dispatches. A type outside this set is a schema error. */
export const CENSUS_TYPES = [
  "space",
  "hr",
  "heading",
  "code",
  "table",
  "blockquote",
  "list",
  "html",
  "paragraph",
  "text",
  "escape",
  "link",
  "image",
  "strong",
  "em",
  "codespan",
  "br",
  "del",
  "wikilink",
] as const;

type Loose = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const optStr = (value: unknown): string | null => (typeof value === "string" ? value : null);

function cell(raw: unknown): { text: string; tokens: CensusToken[] } {
  const c = (raw ?? {}) as Loose;
  return { text: str(c.text), tokens: normalizeTokens(c.tokens) };
}

/** Project one marked token onto the census schema. Throws on a type the walk never dispatches. */
export function normalizeToken(raw: unknown): CensusToken {
  const t = (raw ?? {}) as Loose;
  const type = str(t.type);
  switch (type) {
    case "space":
    case "hr":
    case "br":
      return { type };
    case "heading":
      return { type, depth: Number(t.depth), tokens: normalizeTokens(t.tokens) };
    case "code":
      return { type, lang: optStr(t.lang), text: str(t.text) };
    case "table":
      return {
        type,
        header: (Array.isArray(t.header) ? t.header : []).map(cell),
        rows: (Array.isArray(t.rows) ? t.rows : []).map((row: unknown) => (Array.isArray(row) ? row : []).map(cell)),
        align: (Array.isArray(t.align) ? t.align : []).map(optStr),
      };
    case "blockquote":
    case "paragraph":
      return { type, tokens: normalizeTokens(t.tokens) };
    case "list":
      return {
        type,
        ordered: t.ordered === true,
        items: (Array.isArray(t.items) ? t.items : []).map((item: unknown) => {
          const i = (item ?? {}) as Loose;
          return {
            raw: str(i.raw),
            task: i.task === true,
            checked: typeof i.checked === "boolean" ? i.checked : null,
            loose: i.loose === true,
            tokens: normalizeTokens(i.tokens),
          };
        }),
      };
    case "html":
    case "escape":
    case "codespan":
      return { type, text: str(t.text) };
    case "text": {
      const out: CensusToken = { type, raw: str(t.raw), text: str(t.text) };
      if ("tokens" in t && t.tokens !== undefined) out.tokens = normalizeTokens(t.tokens);
      return out;
    }
    case "link":
      return { type, href: str(t.href), text: str(t.text), tokens: normalizeTokens(t.tokens) };
    case "image":
      return { type, href: str(t.href), title: optStr(t.title), text: str(t.text) };
    case "strong":
    case "em":
      return { type, text: str(t.text), tokens: normalizeTokens(t.tokens) };
    case "del":
      return { type, raw: str(t.raw), text: str(t.text), tokens: normalizeTokens(t.tokens) };
    case "wikilink":
      return {
        type,
        slug: str(t.slug),
        fragment: optStr(t.fragment),
        embed: t.embed === true,
        alias: optStr(t.alias),
        tokens: normalizeTokens(t.tokens),
      };
    default:
      throw new Error(`token-schema: token type ${JSON.stringify(type)} is not one the walk dispatches`);
  }
}

export function normalizeTokens(raw: unknown): CensusToken[] {
  return Array.isArray(raw) ? raw.map(normalizeToken) : [];
}
