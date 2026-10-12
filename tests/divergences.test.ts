import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { attribute, REGISTRY, type Divergence, type Node, type Site } from "../scripts/divergences";
import { buildDefaultMdview, diffTokens, runLexerDiff, tsTokens } from "../scripts/lexer-diff";

// The divergence registry and the L-gate — WP-1 of `plans/mdview-rust-port.md`.
//
// The witness rule: every `live` entry's witness file exists and yields at least one site
// that **only** its own entry matches. There is no Rust lexer yet (`mdview __parity lex` is a
// stub that errors), so for lexer entries the Rust side is **constructed synthetically** from
// the spec-correct parse — `spec` below — and diffed against the real TS tokens with the
// L-gate's own `diffTokens`, so the sites are exactly the shape the gate will hand the
// registry. `pending-witness` entries (render-level, no site until the Rust side renders) are
// skipped visibly, by id.

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Deep-map every node in a normalized tree. */
function mapTree(nodes: Node[], f: (node: Node) => Node | Node[]): Node[] {
  return nodes.flatMap((node) => {
    const mapped = f(node);
    const list = Array.isArray(mapped) ? mapped : [mapped];
    return list.map((n) => (Array.isArray(n.tokens) ? { ...n, tokens: mapTree(n.tokens as Node[], f) } : n));
  });
}

/**
 * The spec-correct Rust side for a live lexer witness, synthesized from the TS tokens.
 * single-tilde-del: GFM's flanking rules leave both tildes literal, so each single-tilde
 * `del` becomes one `text` carrying its own `raw` (a node-level site — the array-level shape
 * is covered by the collision test's fixture below). task-state-prepass: CommonMark keeps
 * fenced content literal, so the code token's text is the witness's own source fence body.
 */
function spec(entry: Divergence, ts: Node[], source: string): Node[] {
  if (entry.id === "single-tilde-del") {
    return mapTree(ts, (n) =>
      n.type === "del" && String(n.raw).startsWith("~") && !String(n.raw).startsWith("~~")
        ? { type: "text", raw: n.raw, text: n.raw }
        : n,
    );
  }
  if (entry.id === "task-state-prepass") {
    const fenceBody = source.slice(source.indexOf("```text\n") + "```text\n".length).replace(/\n$/, "");
    return ts.map((n) => (n.type === "code" ? { ...n, text: fenceBody } : n));
  }
  throw new Error(`no synthetic Rust side for ${entry.id}`);
}

const live = REGISTRY.filter((e) => e.status === "live");
const pending = REGISTRY.filter((e) => e.status === "pending-witness");
console.log(`divergences: pending-witness (skipped): ${pending.map((e) => e.id).join(", ") || "none"}`);

describe("divergence registry — witnesses", () => {
  test("every live entry's witness yields a site only its own entry matches, at both tiers", () => {
    expect(live.length).toBeGreaterThan(0);
    for (const entry of live) {
      expect(entry.ratified).not.toBeNull();
      const path = resolve(REPO_ROOT, entry.witness);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");
      for (const tier of ["unicode", "ascii"] as const) {
        const ts = tsTokens(source, tier) as Node[];
        const sites = diffTokens(ts, spec(entry, ts, source), tier);
        const own = sites.filter((site) => REGISTRY.filter((e) => e.predicate(site)).map((e) => e.id).join() === entry.id);
        expect({ id: entry.id, tier, own: own.length }).toEqual({ id: entry.id, tier, own: expect.any(Number) });
        expect(own.length).toBeGreaterThan(0);
        for (const site of own) expect(attribute(site)).toEqual({ id: entry.id });
      }
    }
  });

  for (const entry of pending) {
    test.todo(`pending-witness: ${entry.id} (witness ${entry.witness} needs a Rust render)`, () => {});
  }

  test("every entry's witness file exists, pending ones included", () => {
    for (const entry of REGISTRY) expect({ id: entry.id, exists: existsSync(resolve(REPO_ROOT, entry.witness)) }).toEqual({ id: entry.id, exists: true });
  });
});

describe("divergence registry — attribution", () => {
  const text = (raw: string): Node => ({ type: "text", raw, text: raw });
  const del: Node = { type: "del", raw: "~a b (~", text: "a b (", tokens: [text("a b (")] };
  const arraySite: Site = {
    path: "$[0].tokens",
    tier: "unicode",
    ts: [text("x ("), del, text("c)")],
    rust: [text("x (~a b (~c)")],
  };

  test("single-tilde-del matches the array-level shape and nothing else does; a double tilde is disallowed", () => {
    expect(attribute(arraySite)).toEqual({ id: "single-tilde-del" });
    const double: Site = { ...arraySite, ts: [text("x ("), { ...del, raw: "~~a b (~~" }, text("c)")], rust: [text("x (~~a b (~~c)")] };
    expect("disallowed" in attribute(double)).toBe(true);
  });

  test("an unmatched site and an unratified match are both disallowed", () => {
    const stray: Site = { path: "$[0]", tier: "ascii", ts: text("a"), rust: text("b") };
    expect("disallowed" in attribute(stray)).toBe(true);
    const unratified = REGISTRY.map((e) => (e.id === "single-tilde-del" ? { ...e, ratified: null } : e));
    const verdict = attribute(arraySite, unratified);
    expect(verdict).toEqual({ disallowed: "single-tilde-del matches but is not ratified" });
  });

  test("a predicate collision throws, naming both ids", () => {
    const twin: Divergence = { ...REGISTRY[0]!, id: "twin-of-single-tilde-del" };
    expect(() => attribute(arraySite, [...REGISTRY, twin])).toThrow(/single-tilde-del and twin-of-single-tilde-del/);
  });
});

describe("lexer-diff against the stub", () => {
  test("the stub `mdview __parity lex` reports errors and never passes", async () => {
    const mdview = buildDefaultMdview();
    const summary = await runLexerDiff({
      files: [resolve(REPO_ROOT, "tests/fixtures/simple.md")],
      tiers: ["unicode", "ascii"],
      mdview,
    });
    expect(summary.errors).toBe(2);
    expect(summary.pairs).toBe(0);
    expect(summary.ok).toBe(false);
  }, 300_000);
});
