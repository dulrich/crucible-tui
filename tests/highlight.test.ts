import { describe, expect, test } from "bun:test";
import { THEME_KEYS, highlightToAnsi, supportsLanguage } from "../src/highlight";

const ESC = "\u001b";
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (text: string): string => text.replace(ANSI, "");
const on = { color: true };
const off = { color: false };

/**
 * The owned syntax colorizer — WP-2 of `plans/colour-policy.md`.
 *
 * **What the retired package's own bytes proved, and where that evidence lives.** The
 * binding comparison for this module is differential: the owned colorizer against
 * `cli-highlight@2.1.11` on the same inputs, byte for byte, run while both were installed.
 * That harness cannot live here — the package is gone, which is the point of the work — so
 * what it measured is recorded in this WP's report (45 probes: one per reachable token
 * class in a language that actually produces it, both call branches, the entity set, the
 * hyphenated `meta-keyword`/`meta-string` case in C++, two sublanguage cases, and the
 * control characters this renderer really puts inside fences; plus every fenced block in
 * the gate corpus). The tests below pin the *contract* those bytes established, so a later
 * edit that breaks one is caught without the package.
 *
 * The end-to-end evidence that the bytes did not move is separate and stronger:
 * `FORCE_COLOR=3` renders of all fourteen gate-corpus files at three widths in both glyph
 * tiers are byte-identical across this package (84/84 combos), and `tests/blocks.test.ts`'s
 * colour-on parity table compares `renderCode`'s output against goldens captured before the
 * dependency was ever removed.
 */

describe("the theme is total over the retired vocabulary", () => {
  // `node_modules/cli-highlight/dist/theme.js:17-187`, transcribed key by key while the
  // package was still installed. A key missing from the map falls through to `plain` by
  // accident rather than by decision, which is exactly the failure this pins.
  const RETIRED_KEYS = [
    "keyword", "built_in", "type", "literal", "number", "regexp", "string", "subst",
    "symbol", "class", "function", "title", "params", "comment", "doctag", "meta",
    "meta-keyword", "meta-string", "section", "tag", "name", "builtin-name", "attr",
    "attribute", "variable", "bullet", "code", "emphasis", "strong", "formula", "link",
    "quote", "selector-tag", "selector-id", "selector-class", "selector-attr",
    "selector-pseudo", "template-tag", "template-variable", "addition", "deletion",
    "default",
  ];

  test("every retired key is present, including the identity ones and `default`", () => {
    expect([...THEME_KEYS].sort()).toEqual([...RETIRED_KEYS].sort());
  });
});

describe("the span grammar, transcribed", () => {
  test("a token class is styled with its theme chain", () => {
    // `keyword` is chalk.blue.
    expect(highlightToAnsi(on, "const x = 1;", "javascript")).toContain(`${ESC}[34mconst${ESC}[39m`);
  });

  test("the hyphen truncation is preserved: `hljs-meta-keyword` styles as `meta`", () => {
    // C++'s `#include <stdio.h>` emits `<span class="hljs-meta">` wrapping
    // `<span class="hljs-meta-keyword">#include</span>` and
    // `<span class="hljs-meta-string">&lt;stdio.h&gt;</span>`. `/hljs-(\w+)/` stops at the
    // hyphen, so both inner spans resolve to the `meta` entry (grey) rather than to their
    // own identity entries — deliberately, because matching the full keys would change
    // established forced-colour bytes on every preprocessor line in the corpus.
    const out = highlightToAnsi(on, "#include <stdio.h>\n", "cpp");
    expect(out).toContain(`${ESC}[90m`); // meta, chalk.grey
    // The inner spans are styled as `meta` too, so grey opens more than once on that line.
    expect(out.split(`${ESC}[90m`).length - 1).toBeGreaterThan(1);
    // The text survives, split by the styling: `#` sits in the outer `meta` span and
    // `include` in the truncated inner one.
    expect(strip(out)).toBe("#include <stdio.h>\n");
  });

  test("a class with no `hljs-` prefix passes through unstyled, children included", () => {
    // The sublanguage case: highlight.js emits `<span class="javascript">` — no `hljs-`
    // prefix — around an embedded grammar, and the retired parser dropped those wrappers
    // while still colorizing what was inside them. Exact bytes, because "contains an
    // escape" would pass even if the wrapper were being styled as some truncated class.
    expect(highlightToAnsi(on, "<script>var a = 1;</script>", "xml")).toBe(
      `${ESC}[90m<${ESC}[34mscript${ESC}[39m${ESC}[90m>${ESC}[39m` +
        `${ESC}[34mvar${ESC}[39m a = ${ESC}[32m1${ESC}[39m;` +
        `${ESC}[90m</${ESC}[34mscript${ESC}[39m${ESC}[90m>${ESC}[39m`,
    );
  });

  test("a token class the theme maps to plain really is identity", () => {
    // Every class highlight.js emits for this markdown — `section`, `code`, `bullet`,
    // `quote` — is one of the retired theme's identity entries, so the whole block comes
    // back byte-identical. If an identity entry were dropped from the map it would fall
    // through to `plain` anyway and this would still pass; what it pins is the other
    // direction — that none of them acquired a style.
    const markdown = "# Title\n\n> quoted\n";
    expect(highlightToAnsi(on, markdown, "markdown")).toBe(markdown);
  });

  test("nesting applies innermost-first, so a nested close re-opens its parent", () => {
    // C++'s `#include <stdio.h>`: `hljs-meta` wraps `hljs-meta-keyword` and
    // `hljs-meta-string`, all three of which resolve to `meta` (grey) after the hyphen
    // truncation. Grey closes with `39m`, so the inner close is followed by a grey re-open
    // — `chalk`'s `applyStyle` rule, reproduced in `src/style.ts`, on a real corpus shape.
    expect(highlightToAnsi(on, "#include <stdio.h>\n", "cpp")).toBe(
      `${ESC}[90m#${ESC}[90minclude${ESC}[39m${ESC}[90m ` +
        `${ESC}[90m<stdio.h>${ESC}[39m${ESC}[90m${ESC}[39m\n`,
    );
  });

  test("the entity set is highlight.js's own five, and `&#x27;` is the apostrophe spelling", () => {
    const source = "a & b < c > d \" e ' f";
    const out = highlightToAnsi(on, source, "plaintext");
    expect(out).toBe(source);
    // `&#39;` — the marked-seam spelling — is not decoded here, because highlight.js never
    // writes it: it survives as literal text.
    expect(highlightToAnsi(on, "&#39;", "plaintext")).toBe("&#39;");
  });

  test("a carriage return is normalized to a newline, as the HTML parser did", () => {
    expect(highlightToAnsi(on, "a\rb", "plaintext")).toBe("a\nb");
    expect(highlightToAnsi(on, "a\r\nb", "plaintext")).toBe("a\nb");
  });

  test("a NUL is dropped, as the HTML parser did", () => {
    expect(highlightToAnsi(on, "a\u0000b", "plaintext")).toBe("ab");
    // And every other control character survives — NUL is the only one with a rule.
    expect(highlightToAnsi(on, "a\u0001b\u001fc", "plaintext")).toBe("a\u0001b\u001fc");
  });
});

describe("both call branches, which are not interchangeable", () => {
  test("a truthy language takes hljs.highlight", () => {
    expect(highlightToAnsi(on, "SELECT 1;", "sql")).toContain(ESC);
  });

  test("undefined takes highlightAuto rather than throwing", () => {
    // `resolveFenceLanguage(undefined)` returns `undefined` for an unlabelled fence by
    // design, and hljs 10.7.3 throws `Unknown language: "undefined"` on `{language:
    // undefined}` — so collapsing the branches would send every unlabelled fence in the
    // corpus through `renderCode`'s `catch`.
    const out = highlightToAnsi(on, "function f(){return 1}", undefined);
    expect(out).toContain(ESC);
    expect(out).toContain("function");
  });

  test("an empty-string language takes highlightAuto too — the retired falsy check", () => {
    // `resolveWith` returns the raw language unchanged when it trims to empty, so `""`
    // really can arrive here. `if (options.language)` is what the retired call tested.
    expect(() => highlightToAnsi(on, "SELECT 1;", "")).not.toThrow();
  });

  test("an unknown language throws, after highlight.js logs it", () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      expect(() => highlightToAnsi(on, "x", "not-a-real-language-xyz")).toThrow();
    } finally {
      console.error = original;
    }
    expect(captured.some((message) => message.includes("not-a-real-language-xyz"))).toBe(true);
  });
});

describe("the colour gate is the policy's, and nothing else's", () => {
  test("with the policy off, the same call returns the code with no escapes at all", () => {
    const out = highlightToAnsi(off, "const x = 1;", "javascript");
    expect(out).not.toContain(ESC);
    expect(out).toBe("const x = 1;");
  });

  test("no module-load global decides anything here — the two answers differ in one process", () => {
    // This is the property WP-2 exists to establish: `cli-highlight` resolved its own
    // `chalk` level at import time, so both of these would have returned the same thing in
    // a single process whatever was asked for.
    expect(highlightToAnsi(on, "const x = 1;", "javascript")).not.toBe(
      highlightToAnsi(off, "const x = 1;", "javascript"),
    );
  });
});

describe("supportsLanguage — the retired one-liner, same answers", () => {
  test("known languages, aliases and unknown ones", () => {
    expect(supportsLanguage("javascript")).toBe(true);
    expect(supportsLanguage("js")).toBe(true);
    expect(supportsLanguage("plaintext")).toBe(true);
    expect(supportsLanguage("not-a-real-language-xyz")).toBe(false);
  });
});
