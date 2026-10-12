import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { attribute, REGISTRY, type Divergence, type Node, type Site } from "../scripts/divergences";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { renderDocumentDetailed } from "../src/render";
import { NARROW_MEASURE } from "../src/width";
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
    // The quoted custom-state item: comrak's relaxed tasklist recognises it (WP-7).
    const recognise = (n: Node): Node => {
      if (n.type !== "list") return n;
      const items = (n.items as Node[]).map((item) => {
        const [head, ...rest] = item.tokens as Node[];
        if (item.task || head?.type !== "text" || !String(head.text).startsWith("[/] ")) return item;
        const cut = (t: Node): Node => ({ ...t, raw: String(t.raw).slice(4), text: String(t.text).slice(4) });
        const inner = head.tokens as Node[];
        return { ...item, task: true, checked: true, tokens: [{ ...cut(head), tokens: [cut(inner[0]!), ...inner.slice(1)] }, ...rest] };
      });
      return { ...n, items };
    };
    return ts.map((n) =>
      n.type === "code" ? { ...n, text: fenceBody } : n.type === "blockquote" ? { ...n, tokens: (n.tokens as Node[]).map(recognise) } : n,
    );
  }
  if (entry.id === "tilde-backtick-run") {
    // GFM §6.3: the backtick after `~` opens a code span (the witness is one paragraph).
    const t = (raw: string): Node => ({ type: "text", raw, text: raw });
    const c = (text: string): Node => ({ type: "codespan", text });
    const inline = [t("Remove the old block (~"), c(":10-20"), t("), keep "), c("other"), t(" ("), c(":5"), t(").")];
    return ts.map((n) => (n.type === "paragraph" ? { ...n, tokens: inline } : n));
  }
  if (entry.id === "nested-bracket-label") {
    // CommonMark §6.3 ex. 512: balanced brackets nest at any depth, so both are a link/image.
    const t = (raw: string): Node => ({ type: "text", raw, text: raw });
    const link: Node = { type: "link", href: "https://example.com", text: "label [[note]]", tokens: [t("label [[note]]")] };
    const image: Node = { type: "image", href: "logo.png", title: null, text: "alt [[note]]" };
    return ts.map((n) => (n.type === "paragraph" ? { ...n, tokens: [t("See "), link, t(" and "), image, t(".")] } : n));
  }
  if (entry.id === "html-close-tag-interrupt") {
    // CommonMark §4.6 type 6: `</details>` interrupts, so the list ends and an html block follows.
    return ts.flatMap((n, k): Node[] => {
      if (n.type === "space" && ts[k - 1]?.type === "list") return [];
      if (n.type !== "list") return [n];
      const items = [...(n.items as Node[])];
      const last = items[items.length - 1]!;
      const tokens = [...(last.tokens as Node[])];
      const html = tokens.pop()!;
      items[items.length - 1] = { ...last, tokens };
      return [{ ...n, items }, { type: "html", text: `${String(html.text)}\n\n` }];
    });
  }
  const t = (raw: string): Node => ({ type: "text", raw, text: raw });
  const inPara = (tokens: Node[]): Node[] => ts.map((n) => (n.type === "paragraph" ? { ...n, tokens } : n));
  if (entry.id === "list-blockquote-interrupt") {
    // CommonMark §5.1: the `>` line interrupts, so the list ends and a block quote follows.
    return ts.flatMap((n): Node[] => {
      if (n.type !== "list") return [n];
      const items = [...(n.items as Node[])];
      const last = items[items.length - 1]!;
      const tokens = [...(last.tokens as Node[])];
      const quote = tokens.pop()!;
      items[items.length - 1] = { ...last, tokens };
      return [{ ...n, items }, quote];
    });
  }
  if (entry.id === "codespan-mask-skew") {
    // CommonMark §6.1: `` ` ``` ` `` is one span, so the `**` after it pairs (§6.2).
    const c = (text: string): Node => ({ type: "codespan", text });
    const strong: Node = { type: "strong", text: "bold", tokens: [t("bold")] };
    return inPara([t("Use "), c("```"), t(" here and "), strong, t(" then "), c("x"), t(" end.")]);
  }
  if (entry.id === "image-alt-backtick") {
    // CommonMark §6.1/§6.4: the unmatched backtick is literal, so the image stands.
    const alt = "run &#39;`\\w+`&#39; | tr -d &#39;`&#39; | wc";
    return inPara([{ type: "image", href: "pic.png", title: null, text: alt }]);
  }
  if (entry.id === "autolink-backslash-paren") {
    // GFM autolink extension: the URL runs to the end of the line.
    const url = "https://example.com/wiki/Thing_\\(kind\\";
    return inPara([t("Link: "), { type: "link", href: url, text: url, tokens: [t(url)] }]);
  }
  if (entry.id === "link-label-hard-break") {
    // CommonMark §6.7: the two spaces before the label's newline are a hard break.
    const url = "https://example.com/";
    const link: Node = { type: "link", href: url, text: `${url}  \n`, tokens: [t(url), { type: "br" }] };
    return ts.map((n) =>
      n.type === "paragraph" ? { ...n, tokens: (n.tokens as Node[]).map((x) => (x.type === "link" ? { ...x, tokens: link.tokens } : x)) } : n,
    );
  }
  if (entry.id === "item-html-line") {
    // CommonMark §4.6: type 7 cannot interrupt, so the tag line continues the item's text.
    return ts.map((n) => {
      if (n.type !== "list") return n;
      const items = (n.items as Node[]).map((item) => {
        const tokens = item.tokens as Node[];
        const html = tokens.at(-1);
        const text = tokens.at(-2);
        if (html?.type !== "html" || text?.type !== "text") return item;
        const merged: Node = {
          type: "text",
          raw: `${String(text.text)}\n\n${String(html.text)}`,
          text: `${String(text.text)}\n${String(html.text)}`,
          tokens: [t(`${String(text.text)}\n`), html],
        };
        return { ...item, tokens: [...tokens.slice(0, -2), merged] };
      });
      return { ...n, items };
    });
  }
  const strong = (inner: Node[], text: string): Node => ({ type: "strong", text, tokens: inner });
  if (entry.id === "emphasis-rule-of-three-scope") {
    // CommonMark §6.2: `**` closes the nearer `**`, then the outer `*` pair is em.
    const em: Node = {
      type: "em",
      text: "see **(this)**: here.",
      tokens: [t("see "), strong([t("(this)")], "(this)"), t(": here.")],
    };
    return inPara([t("Note "), em]);
  }
  if (entry.id === "link-destination-unbalanced-paren") {
    // CommonMark §6.3: the unbalanced `(` fails the outer destination; the inner link stands.
    const link: Node = { type: "link", href: "https://example.com/x", text: "#", tokens: [t("#")] };
    return inPara([t("[D]("), link, t(")")]);
  }
  if (entry.id === "emphasis-opener-remainder") {
    // CommonMark §6.2: two of the four `*` open the strong; two stay literal.
    const link: Node = { type: "link", href: "https://example.com/", text: "c", tokens: [t("c")] };
    return inPara([t("A **"), strong([link, t(" d")], "[c](https://example.com/) d"), t(" e.")]);
  }
  if (entry.id === "emphasis-run-split") {
    // CommonMark §6.2: the rest of the run after `b` is literal, and so is everything after.
    return inPara([strong([t("(a")], "(a"), t(" "), strong([t("b")], "b"), t("**)****:**")]);
  }
  const em = (inner: Node[], text: string): Node => ({ type: "em", text, tokens: inner });
  const url = (href: string): Node => ({ type: "link", href, text: href, tokens: [t(href)] });
  if (entry.id === "emphasis-closer-remainder") {
    // CommonMark §6.2: the rest of the right-flanking `**` is literal, and so is the last `*`.
    return inPara([t("Then "), em([t("she")], "she"), t("*.* went.")]);
  }
  if (entry.id === "emphasis-rule-of-three-inner-em") {
    // CommonMark §6.2: the inner `*` pair closes first, then the `**` pair.
    return inPara([strong([t("Big "), em([t("(here)")], "(here)"), t(".")], "Big *(here)*."), t(" after")]);
  }
  if (entry.id === "codespan-mask-escaped-backtick") {
    // CommonMark §6.1/§6.3: the escaped backtick is literal, so `*this*` is em.
    const c = (text: string): Node => ({ type: "codespan", text });
    return inPara([t("Type "), { type: "escape", text: "`" }, t(" then "), c("c"), t(" and "), em([t("this")], "this"), t(" or "), c("f"), t(".")]);
  }
  if (entry.id === "autolink-paren-count") {
    // GFM §6.9: two `)` against one `(`, so the trailing `)` is not part of the link.
    return inPara([t("Shown as ("), url("https://a.io/c)d(e"), t(") here.")]);
  }
  if (entry.id === "autolink-nbsp") {
    // GFM §6.9/§2.1: U+00A0 is not whitespace, so the link runs on through it.
    return inPara([t("See ("), url("https://a.io/x) "), t(" next.")]);
  }
  if (entry.id === "link-in-link") {
    // CommonMark §6.3: the inner-most link is used; the outer brackets stay text.
    const inner: Node = { type: "link", href: "https://a.io", text: "a.io", tokens: [t("a.io")] };
    return inPara([t("Read ["), inner, t("](notes.md) now.")]);
  }
  if (entry.id === "html-tag-underscore") {
    // CommonMark §6.6: `foo_bar` is not a tag name, so the angle brackets are text.
    return inPara([{ type: "text", raw: "Find the <foo_bar> tag.", text: "Find the &lt;foo_bar&gt; tag." }]);
  }
  if (entry.id === "list-close-tag-lazy-line") {
    // Neither-correct (Rust kept): comrak ends the list, then a space, then the html block.
    return ts.flatMap((n, k): Node[] => {
      if (n.type === "space" && ts[k - 1]?.type === "list") return [];
      if (n.type !== "list") return [n];
      const items = [...(n.items as Node[])];
      const last = items[items.length - 1]!;
      const tokens = [...(last.tokens as Node[])];
      const html = tokens.pop()!;
      const text = tokens[tokens.length - 1]!;
      const trimmed = String(text.text).trimEnd();
      tokens[tokens.length - 1] = { ...text, raw: trimmed, text: trimmed, tokens: [t(trimmed)] };
      items[items.length - 1] = { ...last, raw: `2. ${trimmed}`, tokens };
      return [{ ...n, items }, { type: "space" }, { type: "html", text: `${String(html.text)}\n\n` }];
    });
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
      const path = resolve(REPO_ROOT, entry.witness);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");
      for (const tier of ["unicode", "ascii"] as const) {
        if (entry.id === "hl-fence-claim") {
          // D-C, a render site: the TS side is the real colour-on render; the Rust side is
          // synthesized as the claim decision would lay it out once syntect opens the fence's
          // pointed content line with an escape — the same line, two columns of pad further in.
          const glyphs = tier === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS;
          const ts = renderDocumentDetailed(source, 80, glyphs, NARROW_MEASURE, undefined, undefined, {
            sgr: "full",
            hyperlinks: false,
            tmux: false,
          });
          const lines = ts.text.split("\n");
          const pointed = lines.findIndex((line, i) => ts.codeRanges.some(([a, b]) => i + 1 >= a && i + 1 <= b) && /^ +\* /.test(line));
          expect(pointed).toBeGreaterThan(-1);
          const rustLines = lines.map((line, i) => (i === pointed ? `  ${line}` : line));
          const site: Site = {
            kind: "render",
            path: entry.witness,
            tier,
            policy: "full",
            ts: { text: ts.text, codeRanges: ts.codeRanges },
            rust: { text: rustLines.join("\n"), codeRanges: ts.codeRanges },
          };
          expect(attribute(site)).toEqual({ id: entry.id });
          continue;
        }
        if (entry.id === "hljs-prototype-key") {
          // A render site: the TS side is the real colour-on render, which writes literal
          // `undefined` around ReasonML's `constructor` span; the Rust side is the same render
          // without the defect (the port's theme lookup has no prototype).
          const glyphs = tier === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS;
          const ts = renderDocumentDetailed(source, 80, glyphs, NARROW_MEASURE, undefined, undefined, {
            sgr: "full",
            hyperlinks: false,
            tmux: false,
          });
          expect(ts.text).toContain("undefined");
          const site: Site = {
            kind: "render",
            path: entry.witness,
            tier,
            policy: "P2",
            ts: { text: ts.text, codeRanges: ts.codeRanges },
            rust: { text: ts.text.replaceAll("undefined", ""), codeRanges: ts.codeRanges },
          };
          expect(attribute(site)).toEqual({ id: entry.id });
          // A real code difference beside it is not claimed.
          const worse: Site = { ...site, rust: { ...site.rust, text: site.rust.text.replace("getByRole", "getByRoles") } };
          expect(attribute(worse)).not.toEqual({ id: entry.id });
          continue;
        }
        const ts = tsTokens(source, tier) as Node[];
        const sites = diffTokens(ts, spec(entry, ts, source), tier);
        const own = sites.filter((site) => REGISTRY.filter((e) => e.predicate(site)).map((e) => e.id).join() === entry.id);
        expect({ id: entry.id, tier, own: own.length }).toEqual({ id: entry.id, tier, own: expect.any(Number) });
        expect(own.length).toBeGreaterThan(0);
        // An unratified entry (awaiting the user's ruling) still matches, and stays disallowed.
        const verdict = entry.ratified === null ? { disallowed: `${entry.id} matches but is not ratified` } : { id: entry.id };
        for (const site of own) expect(attribute(site)).toEqual(verdict);
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

describe("lexer-diff against the comrak adapter (WP-7)", () => {
  test("`mdview __parity lex` matches the TS tokens on a fixture at both tiers", async () => {
    const mdview = buildDefaultMdview();
    const summary = await runLexerDiff({
      files: [resolve(REPO_ROOT, "tests/fixtures/simple.md")],
      tiers: ["unicode", "ascii"],
      mdview,
    });
    expect(summary.errors).toBe(0);
    expect(summary.pairs).toBe(2);
    expect(summary.disallowed).toBe(0);
    expect(summary.ok).toBe(true);
  }, 300_000);

  test("the task-state-prepass witness is attributed, never disallowed, against the real adapter", async () => {
    const mdview = buildDefaultMdview();
    const summary = await runLexerDiff({
      files: [resolve(REPO_ROOT, "tests/fixtures/divergences/task-state-prepass.md")],
      tiers: ["unicode", "ascii"],
      mdview,
    });
    expect(summary.disallowed).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.attributed["task-state-prepass"]).toBeGreaterThanOrEqual(4);
  }, 300_000);

  test("an inline container whose extent differs makes its array one site", () => {
    const t = (raw: string): Node => ({ type: "text", raw, text: raw });
    const del = (raw: string): Node => ({ type: "del", raw, text: raw.slice(1, -1), tokens: [t(raw.slice(1, -1))] });
    const sites = diffTokens([t("a "), del("~x ~"), t("y ~z")], [t("a ~x "), del("~y ~"), t("z")], "unicode");
    expect(sites.map((x) => x.path)).toEqual(["$"]);
    expect(attribute(sites[0]!)).toEqual({ id: "single-tilde-del" });
  });

  test("an equal-length array whose node types differ is one site, not positional pairs", () => {
    const t = (raw: string): Node => ({ type: "text", raw, text: raw });
    const sites = diffTokens([t("a"), { type: "codespan", text: "b" }], [t("a"), t("b")], "unicode");
    expect(sites.map((x) => x.path)).toEqual(["$"]);
  });
});

describe("render-site composition (2026-10-12)", () => {
  const E = String.fromCharCode(27);
  // A failed-frontmatter render: line 1 is the diagnostic, then a fenced block at lines 3-4.
  const site = (policy: string, rustFence: string, rustDiag = "! rust says no"): Site => ({
    kind: "render",
    path: "synthetic",
    tier: "unicode",
    policy,
    ts: {
      text: ["! ts says no", "", `${E}[33mecho${E}[39m hi`, "done"].join("\n"),
      codeRanges: [[3, 3]],
      frontmatter: { parsed: false, diagnostic: [0, 1] },
    },
    rust: {
      text: [rustDiag, "", rustFence, "done"].join("\n"),
      codeRanges: [[3, 3]],
      frontmatter: { parsed: false, diagnostic: [0, 1] },
    },
  });

  test("D-A composes with D-C: a colour-on fence after the diagnostic may differ in SGR only", () => {
    expect(attribute(site("P2", "echo hi"))).toEqual({ id: "yaml-diagnostic" });
  });

  test("…but not with colour off, and not when the fence's visible text differs", () => {
    expect(attribute(site("P0", "echo hi"))).not.toEqual({ id: "yaml-diagnostic" });
    expect(attribute(site("P2", "echo HI"))).not.toEqual({ id: "yaml-diagnostic" });
  });

  test("hljs-prototype-key never claims an `undefined` outside a code range", () => {
    const outside: Site = {
      kind: "render",
      path: "synthetic",
      tier: "unicode",
      policy: "P2",
      ts: { text: "a undefined b\ncode", codeRanges: [[2, 2]] },
      rust: { text: "a  b\ncode", codeRanges: [[2, 2]] },
    };
    expect(attribute(outside)).not.toEqual({ id: "hljs-prototype-key" });
  });
});
