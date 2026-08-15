/**
 * The frozen `marked-terminal` block-leaf byte table — WP-6 of
 * `plans/marked-terminal-replacement.md`.
 *
 * `code`, `hr` and `html` as `marked-terminal@7.3.0` returned them for the cases in
 * `./block-parity.ts`, captured from the installed library on the commit before the
 * dependency was removed: `colorOff` from a non-TTY process, `colorOn` from a subprocess
 * under `FORCE_COLOR=3`. The colour split is not cosmetic here — `highlight()`
 * (`index.js:590-602`) *branches* on it and never calls `cli-highlight` at level 0, so the
 * `colorOn` half is the only one that records the highlighting path at all.
 *
 * See `./inline-parity-golden.ts`'s header for why this is a frozen table rather than a
 * live call, and for the one rule that keeps it honest: never regenerate it from the owned
 * renderers.
 */
export const BLOCK_PARITY_GOLDEN: Record<"colorOff" | "colorOn", Record<string, string>> = {
  "colorOff": {
    "code/plain, no language": "    const x = 1;\n\n",
    "code/javascript": "    const x = 1;\n    console.log(x);\n\n",
    "code/bash": "    bun run verify\n\n",
    "code/blank line inside": "    a\n    \n    b\n\n",
    "code/hard return": "    before\rafter\n\n",
    "code/two hard returns": "    a\rb\rc\n\n",
    "code/unresolvable language": "    whatever\n\n",
    "code/empty": "\n\n",
    "code/trailing newline": "    line\n    \n\n",
    "hr": "-------------------------------------------------------------------------------\n\n",
    "html/single line": "<div>hello</div>",
    "html/multi line": "<div>\n  <span>a</span>\n</div>",
    "html/trailing newline": "<br>\n",
    "html/entities left alone": "<p>a &amp; b &lt;c&gt;</p>",
    "html/empty": ""
  },
  "colorOn": {
    "code/plain, no language": "    const x = 1;\n\n",
    "code/javascript": "    \u001b[34mconst\u001b[39m x = \u001b[32m1\u001b[39m;\n    \u001b[36mconsole\u001b[39m.log(x);\n\n",
    "code/bash": "    bun run verify\n\n",
    "code/blank line inside": "    a\n    \n    b\n\n",
    "code/hard return": "    before/\\n/gafter\n\n",
    "code/two hard returns": "    a/\\n/gb\n    c\n\n",
    "code/unresolvable language": "    \u001b[33mwhatever\u001b[39m\n\n",
    "code/empty": "\n\n",
    "code/trailing newline": "    line\n    \n\n",
    "hr": "\u001b[0m-------------------------------------------------------------------------------\u001b[0m\n\n",
    "html/single line": "\u001b[90m<div>hello</div>\u001b[39m",
    "html/multi line": "\u001b[90m<div>\u001b[39m\n\u001b[90m  <span>a</span>\u001b[39m\n\u001b[90m</div>\u001b[39m",
    "html/trailing newline": "\u001b[90m<br>\u001b[39m\n\u001b[90m\u001b[39m",
    "html/entities left alone": "\u001b[90m<p>a &amp; b &lt;c&gt;</p>\u001b[39m",
    "html/empty": ""
  }
};
