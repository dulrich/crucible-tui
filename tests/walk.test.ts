import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import { TokenWalker, type InlineRenderer, type WalkRendererMethods } from "../src/walk";
import { renderDocument } from "../src/render";

/**
 * **The all-token matrix for the owned walk** (WP-2 of `plans/own-the-token-walk.md`).
 *
 * The corpus sweep and the differential harness prove that `src/walk.ts` reproduces
 * `marked`'s `Parser` **on the documents this repo happens to render**. They cannot prove a
 * branch the corpus never takes, and a walk rewrite hides its bug in exactly those branches —
 * so every row of the plan's `Parser` contract table gets a direct test here, and the types
 * the committed corpus does not exercise (`image`, and `space` wherever a renderer overrides
 * it) get one whether or not a corpus file would reach them.
 *
 * Two kinds of test, deliberately:
 *
 * - **Probe tests** dispatch a renderer that emits tagged markers rather than layout, so the
 *   assertion is about *which method was called with what*, not about bytes that some other
 *   module decides.
 * - **Differential tests** run the same tokens through `marked`'s `Parser` and through
 *   `TokenWalker` with the *same* probe renderer and require identical output. That is the
 *   test of the contract table's **completeness**, which the plan names as its one residual
 *   assumption: a behaviour nobody enumerated still shows up as a diff here.
 */

/** What a probe method reaches through `this`. Both walkers satisfy it structurally. */
interface ParserLike {
  parse(tokens: Token[], top?: boolean): string;
  parseInline(tokens: Token[]): string;
}
interface ProbeHost {
  readonly parser: ParserLike;
}

/**
 * The probe's own method shape. It is declared here rather than reused from
 * `WalkRendererMethods` for one reason: the probe has to be assignable to **both** walkers —
 * `TokenWalker`, whose methods declare `this: RendererHost`, and `marked.use()`, whose
 * `RendererObject` declares `this: Renderer`. Typing the receiver as the narrow `ProbeHost`
 * (just `parser`, and only the two methods a probe calls on it) is what both satisfy, and it
 * is also the honest statement of what a renderer method actually reaches through `this`.
 * Every member is optional so the completeness tests can `delete` one.
 */
interface ProbeMethods {
  space?(this: ProbeHost, token: Tokens.Space): string;
  hr?(this: ProbeHost, token: Tokens.Hr): string;
  heading?(this: ProbeHost, token: Tokens.Heading): string;
  code?(this: ProbeHost, token: Tokens.Code): string;
  table?(this: ProbeHost, token: Tokens.Table): string;
  blockquote?(this: ProbeHost, token: Tokens.Blockquote): string;
  list?(this: ProbeHost, token: Tokens.List): string;
  html?(this: ProbeHost, token: Tokens.HTML | Tokens.Tag): string;
  paragraph?(this: ProbeHost, token: Tokens.Paragraph): string;
  text?(this: ProbeHost, token: Tokens.Text | Tokens.Escape | Tokens.Tag): string;
  link?(this: ProbeHost, token: Tokens.Link): string;
  image?(this: ProbeHost, token: Tokens.Image): string;
  strong?(this: ProbeHost, token: Tokens.Strong): string;
  em?(this: ProbeHost, token: Tokens.Em): string;
  codespan?(this: ProbeHost, token: Tokens.Codespan): string;
  br?(this: ProbeHost, token: Tokens.Br): string;
  del?(this: ProbeHost, token: Tokens.Del): string;
}

/**
 * A renderer that emits its own dispatch trace. Every method is present, so it also stands as
 * the completeness fixture for the constructor check below.
 *
 * **`extra` is the owned walker's half of the differential, and it exists because the two
 * sides cannot be given the same object once this repo dispatches a token type marked does
 * not have.** `marked.use()` validates every renderer key against its own `Renderer`
 * prototype and **throws** on one it does not recognise (`marked.cjs:2251`; measured — see
 * the test below), so a probe carrying, say, a `wikilink` method could never be handed to
 * the marked side at all. Keeping the *built-ins* shared and letting only the owned side
 * take an addition is what preserves the differential's meaning: both walkers still run the
 * identical renderer over every token type they both dispatch, which is the whole claim.
 *
 * Nothing passes `extra` yet — WP-2 of `plans/wiki-link-tokenizer.md` is what adds a token
 * type — and **no walker source changes belong to this package**: the seam is here so that
 * package's differential does not have to fork `bothWalkers` in the same commit that
 * changes the walk.
 */
function probeRenderer(extra: ProbeMethods = {}): ProbeMethods {
  return {
    ...builtinProbeMethods(),
    ...extra,
  };
}

/** The eighteen built-in methods both walkers dispatch — shared by construction. */
function builtinProbeMethods(): ProbeMethods {
  return {
    hr: () => "[hr]",
    heading: function (this: ProbeHost, token: Tokens.Heading) {
      return `[h${token.depth}:${this.parser.parseInline(token.tokens)}]`;
    },
    code: (token: Tokens.Code) => `[code:${token.lang ?? ""}:${token.text}]`,
    table: (token: Tokens.Table) => `[table:${token.rows.length}]`,
    blockquote: function (this: ProbeHost, token: Tokens.Blockquote) {
      return `[quote:${this.parser.parse(token.tokens)}]`;
    },
    list: function (this: ProbeHost, token: Tokens.List) {
      return `[list:${token.items.map((item) => this.parser.parse(item.tokens, !!item.loose)).join("|")}]`;
    },
    html: (token: Tokens.HTML | Tokens.Tag) => `[html:${token.text}]`,
    paragraph: function (this: ProbeHost, token: Tokens.Paragraph) {
      return `[p:${this.parser.parseInline(token.tokens)}]`;
    },
    text: (token: Tokens.Text | Tokens.Escape | Tokens.Tag) => `[t:${token.text}]`,
    link: function (this: ProbeHost, token: Tokens.Link) {
      return `[link:${token.href}:${this.parser.parseInline(token.tokens)}]`;
    },
    image: (token: Tokens.Image) => `[img:${token.href}:${token.text}]`,
    strong: function (this: ProbeHost, token: Tokens.Strong) {
      return `[b:${this.parser.parseInline(token.tokens)}]`;
    },
    em: function (this: ProbeHost, token: Tokens.Em) {
      return `[i:${this.parser.parseInline(token.tokens)}]`;
    },
    codespan: (token: Tokens.Codespan) => `[cs:${token.text}]`,
    br: () => "[br]",
    del: function (this: ProbeHost, token: Tokens.Del) {
      return `[del:${this.parser.parseInline(token.tokens)}]`;
    },
  };
}

/** Lex with the same options `renderDocumentDetailed` lexes with. */
function lex(source: string): Token[] {
  return new Marked().lexer(source);
}

/**
 * The same tokens through `marked`'s `Parser` and through `TokenWalker`, same renderer.
 *
 * `marked` reaches its `Parser` only through `Marked.parse`, which lexes first — so the
 * comparison is made on a source string, and both sides lex identically because the walk did
 * not touch the lexer.
 *
 * **The marked side is given the built-ins and only the built-ins**, deliberately: `use()`
 * throws on a renderer key it does not know, so `ownedExtra` is the one asymmetry, and it is
 * an asymmetry the differential can afford because it only ever *adds* a method for a token
 * type the marked side's lexer cannot produce. Everything both walkers can reach stays
 * shared, which is what makes a diff here mean "the walkers disagree" rather than "the
 * probes did".
 */
function bothWalkers(
  source: string,
  ownedExtra: ProbeMethods = {},
): { marked: string; owned: string } {
  const viaMarked = new Marked();
  viaMarked.use({ renderer: probeRenderer() });
  return {
    marked: viaMarked.parse(source, { async: false }),
    owned: new TokenWalker(probeRenderer(ownedExtra)).parse(lex(source)),
  };
}

describe("TokenWalker — differential against marked's Parser", () => {
  const cases: Array<[string, string]> = [
    ["a bare paragraph", "hello world\n"],
    ["two paragraphs", "one\n\ntwo\n"],
    ["a heading with inline markup", "# a **bold** heading\n"],
    ["setext heading", "a heading\n=========\n\nbody\n"],
    ["a thematic break", "before\n\n---\n\nafter\n"],
    ["a fenced code block", "```ts\nconst a = 1;\n```\n"],
    ["an indented code block", "    indented code\n"],
    ["a gfm table", "| a | b |\n|---|---|\n| 1 | 2 |\n"],
    ["a blockquote", "> quoted **text**\n"],
    ["a nested blockquote", "> outer\n>\n> > inner\n"],
    ["a tight unordered list", "- one\n- two\n"],
    ["a loose unordered list", "- one\n\n- two\n"],
    ["an ordered list", "1. one\n2. two\n"],
    ["a nested list", "- one\n  - deep\n- two\n"],
    ["a task list", "- [x] done\n- [ ] todo\n"],
    ["block html", "<div>\nraw\n</div>\n"],
    ["inline html", "a <span>tag</span> here\n"],
    ["a link", "see [label](https://example.test)\n"],
    ["an image", "![alt text](https://example.test/a.png)\n"],
    ["an image inside a link", "[![alt](a.png)](https://example.test)\n"],
    ["a reference definition", "[ref]: https://example.test\n\nsee [ref]\n"],
    ["emphasis, strong and strikethrough", "*a* **b** ~~c~~\n"],
    ["a codespan", "a `span` here\n"],
    ["a hard break", "line one  \nline two\n"],
    ["an escape", "a \\* literal star\n"],
    ["escapes only", "\\_\\*\\#\n"],
    ["autolink", "<https://example.test>\n"],
    ["a list holding every block", "- para\n\n  > quote\n\n  ```\n  code\n  ```\n\n  | a |\n  |---|\n  | 1 |\n"],
    ["blank lines between blocks", "one\n\n\n\ntwo\n"],
    ["a footnote-shaped line", "text[^1]\n\n[^1]: note\n"],
    ["html comment", "<!-- comment -->\n\nbody\n"],
    ["mixed document", "# h\n\npara with [a](b) and `c`\n\n- l1\n- l2\n\n> q\n\n---\n\n```\nx\n```\n"],
  ];

  for (const [name, source] of cases) {
    test(`${name} walks identically`, () => {
      const { marked, owned } = bothWalkers(source);
      expect(owned).toBe(marked);
    });
  }

  /**
   * **Why the two sides take their probes through a factory rather than sharing one
   * object** — WP-1(d) of `plans/wiki-link-tokenizer.md`, from that plan's probe P4.
   *
   * `marked.use()` walks the renderer object and rejects any key that is not on its own
   * `Renderer` prototype. So the moment this repo dispatches a token type marked does not
   * have, a single shared probe stops being possible: handing it to `use()` throws before a
   * single token is parsed. The seam above keeps the built-ins shared and lets only the
   * owned side take an addition, which preserves what the differential is actually for.
   *
   * Measured here rather than asserted, because the whole restructure rests on it.
   */
  test("marked.use() throws on a renderer key it does not know — the reason the sides differ", () => {
    expect(() => new Marked().use({ renderer: { wikilink: () => "x" } as never })).toThrow(
      "renderer 'wikilink' does not exist",
    );
  });

  test("the owned side takes an extra probe method the marked side never sees", () => {
    // The seam, exercised without needing a token type that does not exist yet: an extra
    // method that overrides nothing changes nothing, and the two sides still agree. What
    // this proves is the *plumbing* — `probeRenderer(extra)` reaches the owned walker and
    // `bothWalkers` still hands `use()` a marked-legal object.
    const { marked, owned } = bothWalkers("a **bold** paragraph\n", {});
    expect(owned).toBe(marked);

    // And an addition really is carried: overriding a built-in only on the owned side
    // makes the two disagree, so the parameter cannot be silently dropped.
    const forked = bothWalkers("a **bold** paragraph\n", { strong: () => "[OWNED-ONLY]" });
    expect(forked.owned).not.toBe(forked.marked);
    expect(forked.owned).toContain("[OWNED-ONLY]");
    expect(forked.marked).toContain("[b:");
  });
});

describe("TokenWalker — block text coalescing and the synthetic paragraph", () => {
  /**
   * `marked.cjs:1974-1991`. Consecutive block `text` tokens are rendered one at a time and
   * joined with `\n`, the loop index is consumed by the run, and at `top` the joined body is
   * handed to `paragraph` inside a token the lexer never emitted.
   */
  const textRun: Token[] = [
    { type: "text", raw: "alpha", text: "alpha" } as Tokens.Text,
    { type: "text", raw: "beta", text: "beta" } as Tokens.Text,
    { type: "text", raw: "gamma", text: "gamma" } as Tokens.Text,
  ];

  test("a run of block text tokens is joined with \\n and visited once", () => {
    const seen: string[] = [];
    const walker = new TokenWalker({
      ...probeRenderer(),
      text: (token) => {
        seen.push(token.text);
        return token.text;
      },
      paragraph: (token) => `[p:${token.text}]`,
    });
    expect(walker.parse(textRun)).toBe("[p:alpha\nbeta\ngamma]");
    // Visited once each — the index was consumed by the inner loop, not re-entered by the
    // outer one. Three calls, not six.
    expect(seen).toEqual(["alpha", "beta", "gamma"]);
  });

  test("at top, the paragraph token handed to the renderer is fabricated, not lexed", () => {
    let captured: Tokens.Paragraph | undefined;
    const walker = new TokenWalker({
      ...probeRenderer(),
      text: (token) => token.text,
      paragraph: (token) => {
        captured = token;
        return "";
      },
    });
    walker.parse(textRun);
    expect(captured).toEqual({
      type: "paragraph",
      raw: "alpha\nbeta\ngamma",
      text: "alpha\nbeta\ngamma",
      tokens: [{ type: "text", raw: "alpha\nbeta\ngamma", text: "alpha\nbeta\ngamma" }],
    });
  });

  test("the fabricated inner text token carries no `tokens` key", () => {
    // Load-bearing rather than incidental: condition 3 of the tight-list-item test in
    // `src/render.ts`'s `text` override reads exactly this key to tell a block text token
    // from an inline one, so a walk that helpfully added an empty array would change list
    // rendering across the corpus.
    let inner: Token | undefined;
    const walker = new TokenWalker({
      ...probeRenderer(),
      text: (token) => token.text,
      paragraph: (token) => {
        inner = token.tokens[0];
        return "";
      },
    });
    walker.parse([{ type: "text", raw: "solo", text: "solo" } as Tokens.Text]);
    expect(inner).toBeDefined();
    expect(Object.keys(inner as object).sort()).toEqual(["raw", "text", "type"]);
    expect("tokens" in (inner as object)).toBe(false);
  });

  test("below top, no paragraph is synthesized and the joined body is emitted raw", () => {
    // This is the tight-list-item path: `renderList` routes an item through
    // `parse(item.tokens, !!item.loose)` (`marked.cjs:557-561` stamps `loose`), so a tight
    // item's text never sees a paragraph.
    let paragraphs = 0;
    const walker = new TokenWalker({
      ...probeRenderer(),
      text: (token) => token.text,
      paragraph: () => {
        paragraphs += 1;
        return "";
      },
    });
    expect(walker.parse(textRun, false)).toBe("alpha\nbeta\ngamma");
    expect(paragraphs).toBe(0);
  });

  test("a text run bounded by another block type stops at the boundary", () => {
    const walker = new TokenWalker({ ...probeRenderer(), text: (token) => token.text });
    const tokens: Token[] = [
      { type: "text", raw: "a", text: "a" } as Tokens.Text,
      { type: "hr", raw: "---" } as Tokens.Hr,
      { type: "text", raw: "b", text: "b" } as Tokens.Text,
    ];
    expect(walker.parse(tokens, false)).toBe("a[hr]b");
  });
});

describe("TokenWalker — escape routes to text", () => {
  test("an escape token dispatches to renderer.text", () => {
    // `marked.cjs:2028-2031`. There is no `escape` method and there never was; the routing is
    // the contract, which is why `src/render.ts:1053` types its `text` for `Tokens.Escape`.
    const seen: string[] = [];
    const walker = new TokenWalker({
      ...probeRenderer(),
      text: (token) => {
        seen.push(`${token.type}:${token.text}`);
        return token.text;
      },
    });
    const escape: Tokens.Escape = { type: "escape", raw: "\\*", text: "*" };
    expect(walker.parseInline([escape])).toBe("*");
    expect(seen).toEqual(["escape:*"]);
  });

  test("a renderer with no escape method still renders an escaped document", () => {
    // The end-to-end shape of the same fact: `renderDocument` assigns no `escape` key.
    expect(renderDocument("a \\* literal star\n", 80)).toContain("*");
  });
});

describe("TokenWalker — space", () => {
  test("an unassigned space renders as the empty string", () => {
    // `marked.cjs:1940-1943` dispatches it; `_Renderer.prototype.space` (`:1694-1696`)
    // returns `''`. `src/render.ts` assigns no `space` key, so this is the live behaviour.
    const methods = probeRenderer();
    expect(methods.space).toBeUndefined();
    const walker = new TokenWalker(methods);
    const space: Tokens.Space = { type: "space", raw: "\n\n" };
    expect(walker.parse([space])).toBe("");
    expect(walker.parse([space, { type: "hr", raw: "---" } as Tokens.Hr, space])).toBe("[hr]");
  });

  test("an assigned space is dispatched to", () => {
    // The corpus cannot reach this branch at all — nothing in this repo assigns `space` — so
    // it is tested directly rather than inferred. It is what a successor that wants to see
    // blank-line structure will use.
    const walker = new TokenWalker({ ...probeRenderer(), space: (token) => `[sp:${token.raw.length}]` });
    expect(walker.parse([{ type: "space", raw: "\n\n" } as Tokens.Space])).toBe("[sp:2]");
  });

  test("space tokens survive a real lex and render to nothing", () => {
    const tokens = lex("one\n\n\n\ntwo\n");
    expect(tokens.some((token) => token.type === "space")).toBe(true);
    expect(new TokenWalker(probeRenderer()).parse(tokens)).toBe("[p:[t:one]][p:[t:two]]");
  });
});

describe("TokenWalker — image", () => {
  test("an image token dispatches to renderer.image", () => {
    // The committed corpus contains no image, so corpus parity cannot cover this case.
    const walker = new TokenWalker(probeRenderer());
    const image: Tokens.Image = { type: "image", raw: "![a](b)", href: "b", title: null, text: "a" };
    expect(walker.parseInline([image])).toBe("[img:b:a]");
  });

  test("an image inside a paragraph reaches the same method through the block walk", () => {
    expect(new TokenWalker(probeRenderer()).parse(lex("![alt](u.png)\n"))).toBe("[p:[img:u.png:alt]]");
  });
});

describe("TokenWalker — parseInline's renderer override", () => {
  test("the second argument replaces the renderer for the whole inline run", () => {
    // `marked.cjs:2013`. marked builds a `_TextRenderer` for this and — measured at 14.1.4 —
    // never passes it, and `src/render.ts` never passes one either, so this branch is
    // reachable only from a direct test.
    const walker = new TokenWalker(probeRenderer());
    const plain: InlineRenderer = {
      parser: walker,
      text: (token) => token.text,
      html: (token) => token.text,
      link: (token) => walker.parseInline(token.tokens, plain),
      image: (token) => token.text,
      strong: (token) => walker.parseInline(token.tokens, plain),
      em: (token) => walker.parseInline(token.tokens, plain),
      codespan: (token) => token.text,
      br: () => "",
      del: (token) => walker.parseInline(token.tokens, plain),
    };
    const tokens = lex("a **b** and [c](d)\n");
    const paragraph = tokens[0] as Tokens.Paragraph;
    expect(walker.parseInline(paragraph.tokens, plain)).toBe("a b and c");
    // Without the override the walk's own renderer is used — the default is `this.renderer`.
    expect(walker.parseInline(paragraph.tokens)).toBe("[t:a ][b:[t:b]][t: and ][link:d:[t:c]]");
  });

  test("an override must re-pass itself; `this.parser.parseInline(tokens)` returns to the walk's renderer", () => {
    // marked has exactly this property, which is why `_TextRenderer` implements every inline
    // method itself rather than delegating: the override is a parameter, not a mode, so a
    // method that recurses without re-passing it drops back to `this.renderer` mid-run.
    const walker = new TokenWalker(probeRenderer());
    const leaky: InlineRenderer = {
      parser: walker,
      text: (token) => token.text,
      html: (token) => token.text,
      link: (token) => token.text,
      image: (token) => token.text,
      strong: function (this: ProbeHost, token) {
        return this.parser.parseInline(token.tokens);
      },
      em: (token) => token.text,
      codespan: (token) => token.text,
      br: () => "",
      del: (token) => token.text,
    };
    const paragraph = lex("a **b** c\n")[0] as Tokens.Paragraph;
    expect(walker.parseInline(paragraph.tokens, leaky)).toBe("a [t:b] c");
  });

  test("an override's own recursion dispatches through the override, not the walk's renderer", () => {
    // Mirrors marked exactly: the switch reads the parameter, so nested tokens inside a
    // `strong` handled by the override are still the override's — but only because the
    // override re-enters through its own method. `this.parser.parseInline` with no second
    // argument goes back to the walk's renderer, which is the behaviour marked has and which
    // is why `_TextRenderer` implements every inline method itself.
    const walker = new TokenWalker(probeRenderer());
    const shouty: InlineRenderer = {
      parser: walker,
      text: (token) => token.text.toUpperCase(),
      html: (token) => token.text,
      link: (token) => token.text,
      image: (token) => token.text,
      strong: function (this: ProbeHost, token) {
        return `!${walker.parseInline(token.tokens, shouty)}!`;
      },
      em: (token) => token.text,
      codespan: (token) => token.text,
      br: () => "",
      del: (token) => token.text,
    };
    const paragraph = lex("a **b c** d\n")[0] as Tokens.Paragraph;
    expect(walker.parseInline(paragraph.tokens, shouty)).toBe("A !B C! D");
  });
});

describe("TokenWalker — unknown token types throw", () => {
  const walker = new TokenWalker(probeRenderer());

  test("parse throws on an unknown block type, with marked's own message", () => {
    // `marked.cjs:1995-2003`. `options.silent` — which would log and return `''` from the
    // whole parse — is not wired: `_getDefaults()` sets `silent: false` and the render seam
    // never set it, so that branch was unreachable before this package and is not carried.
    expect(() => walker.parse([{ type: "nope", raw: "x" } as unknown as Token])).toThrow(
      'Token with "nope" type was not found.',
    );
  });

  test("parseInline throws on an unknown inline type", () => {
    expect(() => walker.parseInline([{ type: "nope", raw: "x" } as unknown as Token])).toThrow(
      'Token with "nope" type was not found.',
    );
  });

  test("a block-only type thrown at the inline walk throws", () => {
    expect(() => walker.parseInline([{ type: "hr", raw: "---" } as Tokens.Hr])).toThrow(
      'Token with "hr" type was not found.',
    );
  });

  test("list_item and def are never dispatched", () => {
    // Both would land on the throwing default. `list_item` is consumed inside `list`
    // (`src/lists.ts`) and `def` is folded into `tokens.links` and never pushed onto the
    // stream at all (`marked.cjs:1425-1440`) — so neither reaches the walk from a real lex.
    const tokens = lex("[ref]: https://example.test\n\n- one\n- two\n\nsee [ref]\n");
    expect(tokens.some((token) => token.type === "def" || token.type === "list_item")).toBe(false);
    expect(() => walker.parse(tokens)).not.toThrow();
  });
});

describe("TokenWalker — the receiver, and what dropping marked.use() moved here", () => {
  test("`this.parser` inside a method is the walker itself", () => {
    // `marked.use()` wrapped every method as `fn.apply(renderer, args)` where `_Parser` had
    // set `renderer.parser = this` (`marked.cjs:1905`, `:2262`). That is where the
    // `this.parser` the nine re-entry sites in `src/render.ts` close over came from, and it
    // is now the walker's own dispatch object.
    let seen: unknown;
    const walker = new TokenWalker({
      ...probeRenderer(),
      paragraph: function (this: ProbeHost, token) {
        seen = this.parser;
        return this.parser.parseInline(token.tokens);
      },
    });
    walker.parse(lex("hello\n"));
    expect(seen).toBe(walker);
  });

  test("the supplied methods object is not mutated with a parser field", () => {
    const methods = probeRenderer();
    new TokenWalker(methods);
    expect("parser" in methods).toBe(false);
  });

  test("a missing required method throws at construction, not mid-render", () => {
    // The replacement for `use()`'s key-existence throw (`marked.cjs:2251`). Under `use()` a
    // key that was never assigned left marked's own HTML-emitting default in place; here it
    // is a construction-time error, before a byte is rendered.
    const incomplete = probeRenderer();
    delete incomplete.paragraph;
    expect(() => new TokenWalker(incomplete)).toThrow("renderer method 'paragraph' is required by the token walk");
  });

  test("every one of the sixteen assigned methods is required", () => {
    const names = Object.keys(probeRenderer()) as Array<keyof WalkRendererMethods>;
    expect(names).toHaveLength(16);
    for (const name of names) {
      const incomplete = probeRenderer();
      delete incomplete[name];
      expect(() => new TokenWalker(incomplete)).toThrow(`renderer method '${name}' is required by the token walk`);
    }
  });

  test("a method returning the empty string contributes nothing, as use()'s coercion did", () => {
    // `use()` ended `return ret || ''`. On the string returns the renderer contract permits,
    // that is the identity — non-empty strings map to themselves and `''` to `''` — so the
    // coercion is reproduced by construction rather than by a wrapper.
    const walker = new TokenWalker({ ...probeRenderer(), hr: () => "" });
    expect(walker.parse([{ type: "hr", raw: "---" } as Tokens.Hr])).toBe("");
  });
});

describe("TokenWalker — the tight/loose trap, and what a loose item's children actually are", () => {
  test("BOTH a tight and a loose item's children are block `text` tokens", () => {
    // **This corrects the record, and it is the reason the synthetic paragraph is
    // load-bearing rather than an edge case.** `src/render.ts:1085-1090` states that
    // `marked`'s block tokenizer "gives a **tight** item `text` children and a **loose** item
    // `paragraph` children"; the plan's contract table inherits the same framing. Measured at
    // `marked@14.1.4`, the second half is false: `Tokenizer.prototype.list`
    // (`marked.cjs:550-561`) lexes every item's body with `state.top = false` and then only
    // *stamps* `loose` — it never re-lexes, so a loose item's children are `text` tokens too.
    //
    // What actually routes a loose item to `renderer.paragraph` is `parse(item.tokens,
    // !!item.loose)` with `top === true`, i.e. **the synthesized paragraph in the block
    // `text` case**. So that fabricated token is not a rare top-level curiosity — it is on
    // the path of every loose list item in the corpus, which is why reproducing its exact
    // shape (and the absent `tokens` key on its inner text token) had to be exact.
    const tight = lex("- one\n- two\n")[0] as Tokens.List;
    expect(tight.loose).toBe(false);
    expect(tight.items.map((item) => item.tokens.map((token) => token.type))).toEqual([["text"], ["text"]]);

    const loose = lex("- one\n\n- two\n")[0] as Tokens.List;
    expect(loose.loose).toBe(true);
    expect(loose.items.every((item) => item.loose)).toBe(true);
    expect(loose.items.map((item) => item.tokens.map((token) => token.type))).toEqual([["text"], ["text"]]);
  });

  test("a `space` token inside a loose item breaks the coalescing run into two paragraphs", () => {
    // The corollary, and the one place the `space` case is not merely "returns `''`": it
    // terminates a block `text` run, so a multi-paragraph loose item produces two synthesized
    // paragraphs rather than one paragraph containing a `\n`.
    const item = (lex("- one\n\n  para\n\n- two\n")[0] as Tokens.List).items[0];
    expect(item?.tokens.map((token) => token.type)).toEqual(["text", "space", "text"]);
    const walker = new TokenWalker(probeRenderer());
    expect(walker.parse(item?.tokens ?? [], true)).toBe("[p:[t:[t:one]]][p:[t:[t:para]]]");
  });

  test("the same item tokens render differently at each `top`", () => {
    // `top === false` is the tight path: the item's own text arrives raw. `top === true` is
    // the loose path: it is re-wrapped in a paragraph whose text is *the already rendered
    // body*, which is why the probe's marker appears twice.
    const item = (lex("- one\n- two\n")[0] as Tokens.List).items[0];
    expect(item).toBeDefined();
    const walker = new TokenWalker(probeRenderer());
    expect(walker.parse(item?.tokens ?? [], false)).toBe("[t:one]");
    expect(walker.parse(item?.tokens ?? [], true)).toBe("[p:[t:[t:one]]]");
  });
});

describe("TokenWalker — the render seam still holds", () => {
  test("renderDocument renders a document exercising every dispatched type", () => {
    const source = [
      "---",
      "title: probe",
      "---",
      "",
      "# Heading with **bold**",
      "",
      "A paragraph with [a link](https://example.test), `code`, *em*, ~~del~~ and an",
      "![image](https://example.test/i.png).",
      "",
      "> A blockquote with a nested list:",
      ">",
      "> - one",
      "> - two",
      "",
      "1. ordered",
      "2. items",
      "",
      "- [x] done",
      "- [ ] todo",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "    indented code",
      "",
      "---",
      "",
      "<div>raw html</div>",
      "",
      "a \\* escape and a hard break  ",
      "on the next line",
      "",
    ].join("\n");
    const output = renderDocument(source, 80);
    expect(output).toContain("Heading with");
    expect(output).toContain("ordered");
    expect(output).toContain("const a = 1;");
    expect(output.length).toBeGreaterThan(200);
  });
});
