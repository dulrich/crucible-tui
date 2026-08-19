import hljs from "highlight.js";
import { applyStyle, createStyler, type ColourGate, type Styler } from "./style";

/**
 * The owned syntax colorizer — `cli-highlight`, transcribed, over `highlight.js` direct.
 * WP-2 of `plans/colour-policy.md`.
 *
 * `cli-highlight@2.1.11` did three things: it called highlight.js, it parsed the HTML that
 * came back with `parse5`, and it mapped each `hljs-…` class through a `chalk@4` theme.
 * Only the first is domain work, and highlight.js was already installed — as
 * `cli-highlight`'s own transitive pin, which is exactly why the root `AGENTS.md` recorded
 * the `10.7.3` staleness as *blocked*. The other two are emission, and emission is this
 * repo's under the dependency-ownership rule. So the package is gone (with `chalk@4`,
 * `parse5`, the htmlparser2 tree adapter, `mz` and the `yargs` freight its CLI carried),
 * `highlight.js@10.7.3` is a direct pinned dependency, and what follows is the retired
 * code's behaviour, sites cited.
 *
 * **The transcription is deliberate and defect-preserving**; every clause below is
 * something that would change established forced-colour bytes if "improved":
 *
 * - **Both call branches** (`index.js:83-89`): `options.language` is tested for
 *   *truthiness*, so an unlabelled fence — where `ctx.resolveFenceLanguage` returns
 *   `undefined` by design, and an empty info-string returns `""` — takes
 *   `hljs.highlightAuto(code)`, and anything else takes `hljs.highlight(code, {language})`.
 *   The two are not interchangeable: hljs `10.7.3` throws `Unknown language: "undefined"`
 *   on `{language: undefined}`, so collapsing the branches would turn every unlabelled
 *   fence in the corpus into the `catch` path's flat yellow.
 * - **The span grammar** (`index.js:33-57`): a class attribute is matched with
 *   `/hljs-(\w+)/` and the capture is the token class. `\w` does not match `-`, so
 *   `hljs-meta-keyword` truncates to `meta` and is styled as `meta` — the full theme's
 *   `meta-keyword`/`meta-string`/`selector-*`/`template-*` entries are therefore
 *   **unreachable**, and they are kept in the map anyway (see `THEME`) because the map is
 *   specified as total over the retired vocabulary, not as the set of reachable keys.
 *   Matching them properly would change the bytes of every C++ preprocessor line the corpus
 *   contains, which is a rendering decision no dependency removal is entitled to make.
 * - **A class with no `hljs-` prefix passes through unstyled**, children included
 *   (`index.js:52-55`). That is the sublanguage case: highlight.js emits
 *   `<span class="xml">` for an embedded grammar (`highlight.js/lib/core.js:134-140` —
 *   the class prefix is applied only when `node.sublanguage` is false), and the retired
 *   parser deliberately dropped those.
 * - **The entity set is highlight.js's own five** (`highlight.js/lib/core.js:53-59`):
 *   `&amp;`, `&lt;`, `&gt;`, `&quot;` and **`&#x27;`** — the hex spelling, not the `&#39;`
 *   the marked seam produces and `src/blocks.ts`' `transform` decodes. Nothing else can
 *   appear, because every `&` in the source text is escaped before any other replacement
 *   runs, so a single non-overlapping pass is exactly `parse5`'s result on this input.
 * - **Nesting is applied innermost-first**: children are colorized, then the parent's theme
 *   entry wraps the already-styled string (`index.js:46-50`). That is what puts a
 *   nested class's close code inside a parent span, and it is why the theme is applied
 *   through `applyStyle` (`src/style.ts`) — `chalk`'s re-open-after-close and line-break
 *   encasing are live on this path, not theoretical.
 *
 * **The colour gate is the caller's**, exactly as it was: `cli-highlight` never asked
 * whether to colour — its `chalk@4` did, at module load, from the environment, and that is
 * the authority this package retires. `src/blocks.ts`' `highlightCode` short-circuits
 * before calling in, and the `ctx` handed here is what the theme's `applyStyle` reads, so a
 * caller that reaches this with colour off gets highlight.js's plain text rather than
 * styled output.
 *
 * **That short-circuit is `ctx.sgr !== "full"`, not `!ctx.color`** — WP-2 of
 * `plans/colour-modes.md`, Decision 3, and the sentence above is the reason it had to be
 * stated here rather than only at the call site. Syntax highlighting is an explicit,
 * ratified **producer** exception to the property rule: this whole path is reached under
 * `full` and under nothing else, so `formats` renders a fence exactly as `none` does. The
 * theme below is *why* — it carries `dim`, `italic`, `bold` and `underline`, all
 * format-class, so a property filter would have kept a partly-highlighted fence rather than
 * dropping colour from it — and `src/blocks.ts`' `highlightCode` carries the full
 * justification including the `fixHardReturn` half.
 *
 * The consequence for this module is that it never sees `"formats"` from production, and
 * the theme's own `applyStyle` calls are therefore always identity-filtered. Nothing here
 * asserts that, deliberately: a direct caller (`tests/highlight.test.ts`) may pass any mode,
 * and what it gets is the ordinary property filter — hue spans drop, format spans stay.
 */

/**
 * The theme, total over `cli-highlight@2.1.11`'s `DEFAULT_THEME` key vocabulary
 * (`node_modules/cli-highlight/dist/theme.js:17-187`, read before the package was
 * removed), including the identity entries and `default`.
 *
 * `null` is the retired `plain` — `theme.js:12`, the identity function. It is spelled as a
 * distinct value rather than as an absent key so the map's totality is checkable:
 * `tests/highlight.test.ts` asserts every one of the retired keys is present, which is the
 * assertion that would fail if a future edit dropped one and let it fall through the
 * `|| plain` default by accident instead of by decision.
 *
 * The chains are `chalk@4.1.2`'s, measured pair-for-pair against `src/style.ts`'s committed
 * table while both packages were still installed.
 */
const THEME: Readonly<Record<string, Styler | null>> = {
  keyword: createStyler("blue"),
  built_in: createStyler("cyan"),
  type: createStyler("dim", createStyler("cyan")), // chalk.cyan.dim
  literal: createStyler("blue"),
  number: createStyler("green"),
  regexp: createStyler("red"),
  string: createStyler("red"),
  subst: null,
  symbol: null,
  class: createStyler("blue"),
  function: createStyler("yellow"),
  title: null,
  params: null,
  comment: createStyler("green"),
  doctag: createStyler("green"),
  meta: createStyler("gray"), // chalk.grey
  "meta-keyword": null, // unreachable through the `\w+` truncation; kept for totality
  "meta-string": null, // unreachable, as above
  section: null,
  tag: createStyler("gray"), // chalk.grey
  name: createStyler("blue"),
  "builtin-name": null, // unreachable, as above
  attr: createStyler("cyan"),
  attribute: null,
  variable: null,
  bullet: null,
  code: null,
  emphasis: createStyler("italic"),
  strong: createStyler("bold"),
  formula: null,
  link: createStyler("underline"),
  quote: null,
  "selector-tag": null, // unreachable, as above
  "selector-id": null, // unreachable, as above
  "selector-class": null, // unreachable, as above
  "selector-attr": null, // unreachable, as above
  "selector-pseudo": null, // unreachable, as above
  "template-tag": null, // unreachable, as above
  "template-variable": null, // unreachable, as above
  addition: createStyler("green"),
  deletion: createStyler("red"),
  default: null,
};

/** The retired vocabulary, exported so the totality assertion has something to compare to. */
export const THEME_KEYS: readonly string[] = Object.keys(THEME);

/**
 * highlight.js's own five escapes, undone in one non-overlapping pass.
 *
 * `&#x27;` is the hex spelling highlight.js emits (`highlight.js/lib/core.js:59`). The decimal `&#39;`
 * is deliberately **not** here: that is the spelling `marked`'s inline lexer produces, and
 * decoding it in this path would mean decoding an entity highlight.js never wrote — i.e.
 * changing a fence's verbatim content, which is parity class C.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27);/g;

/**
 * The HTML input preprocessor's newline normalization — `\r\n` and a lone `\r` both become
 * `\n` (WHATWG HTML §13.2.3.5, which `parse5` implements at its character-input stage).
 *
 * **This is not a tidy-up; it is a transcription, and the parity table catches its
 * absence.** `src/inline.ts`'s `fixHardReturn` defect leaves a literal carriage return in a
 * fence's text (`marked-terminal index.js:76-78`, reproduced deliberately), so a code block
 * really can reach the highlighter carrying one. Sent through `parse5`, that `\r` came back
 * as `\n`, and `indentify` then indented the line after it; without this replacement the
 * owned colorizer returns the `\r` intact and that line loses its four columns — the
 * `code/two hard returns` case in `tests/helpers/block-parity.ts`, which is inside a
 * `codeRange` and therefore parity class C.
 */
const CR_PATTERN = /\r\n?/g;

/**
 * The other thing the HTML parser did to text and this has to keep doing: **a NUL is
 * dropped**. `parse5`'s tree construction ignores a U+0000 character token in body content
 * (WHATWG HTML §13.2.6.4.7), so a fence carrying one came back one character shorter.
 *
 * Measured rather than assumed, against the retired package while it was still installed:
 * `a\u0000b` in, `ab` out — and `\u0001` through `\u001f`, form feed and vertical tab all
 * survive untouched, so NUL is the only control character with a rule of its own. It is
 * unreachable through the renderer today (`preprocessBody` strips both sentinel control
 * characters from the source before `marked` ever lexes it, exactly so a document cannot
 * forge a code range), which makes this a guard rather than a path — kept because the
 * alternative is a silent one-character divergence inside a `codeRange` if that ever stops
 * being true.
 */
// eslint-disable-next-line no-control-regex
const NUL_PATTERN = /\u0000/g;

function decodeEntities(text: string): string {
  return text
    .replace(CR_PATTERN, "\n")
    .replace(NUL_PATTERN, "")
    .replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * The one span shape highlight.js's HTML renderer emits (`highlight.js/lib/core.js:160-168`):
 * `<span class="…">` and `</span>`, and nothing else — no attributes beyond `class`, no
 * self-closing tags, no comments, no doctype. Anything a document's own text could have
 * contributed is already escaped, so a `<` inside the tokenized code cannot reach this
 * pattern.
 */
const SPAN_PATTERN = /<span class="([^"]*)">|<\/span>/g;

/** The retired `/hljs-(\w+)/`, hyphen truncation and all (`cli-highlight/dist/index.js:43`). */
const HLJS_CLASS = /hljs-(\w+)/;

interface Frame {
  /** The token class this span styles, or `null` for a non-`hljs-` class (sublanguage). */
  readonly token: string | null;
  /** Children rendered so far. */
  text: string;
}

/**
 * Walk highlight.js's HTML and apply the theme — `colorize`/`colorizeNode`
 * (`cli-highlight/dist/index.js:33-65`) without `parse5`.
 *
 * The retired code built a real DOM fragment and recursed over it; a stack over the two
 * possible tags is the same walk, because the input grammar has exactly one element type.
 * Two `parse5` behaviours on malformed input are reproduced on purpose rather than
 * inherited: an unclosed span is closed at end of input (fragment parsing auto-closes open
 * elements, and its content is still styled), and a stray `</span>` with nothing open is
 * ignored. highlight.js emits neither, so both are guards rather than paths.
 */
function colorize(ctx: ColourGate, html: string): string {
  const root: Frame = { token: null, text: "" };
  const stack: Frame[] = [root];
  const top = (): Frame => stack[stack.length - 1] ?? root;

  const closeFrame = (): void => {
    if (stack.length === 1) return; // stray `</span>`: parse5 drops it
    const frame = stack.pop() as Frame;
    const chain = frame.token === null ? null : (THEME[frame.token] ?? null);
    top().text += chain === null ? frame.text : applyStyle(ctx, chain, frame.text);
  };

  let cursor = 0;
  SPAN_PATTERN.lastIndex = 0;
  for (let match = SPAN_PATTERN.exec(html); match !== null; match = SPAN_PATTERN.exec(html)) {
    if (match.index > cursor) top().text += decodeEntities(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const className = match[1];
    if (className === undefined) {
      closeFrame();
      continue;
    }
    // `theme[token] || DEFAULT_THEME[token] || plain`: a class the theme has no entry for
    // is plain, and so is a class with no `hljs-` prefix at all.
    const token = HLJS_CLASS.exec(className)?.[1] ?? null;
    stack.push({ token, text: "" });
  }
  if (cursor < html.length) top().text += decodeEntities(html.slice(cursor));

  while (stack.length > 1) closeFrame();
  return root.text;
}

/**
 * Highlight `code` and return it with SGR codes applied, per the resolved policy on `ctx`.
 *
 * The signature is the retired `highlight(code, {language})` call `src/blocks.ts` made
 * (`index.js:80-91`), with the colour decision added as an explicit input rather than
 * resolved from a module-load global. It throws what highlight.js throws — an unknown
 * language is an `Error` *and* a `console.error` line from highlight.js itself — which is
 * the behaviour `src/blocks.ts`' `try`/`catch` and `src/lang.ts`'s normalisation are both
 * written against.
 */
export function highlightToAnsi(ctx: ColourGate, code: string, language: string | undefined): string {
  const html = language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
  return colorize(ctx, html);
}

/**
 * Whether highlight.js recognizes `name` — the retired `supportsLanguage`
 * (`cli-highlight/dist/index.js:106-108`), which was this one line.
 *
 * It lives here rather than in `src/lang.ts` so that `highlight.js` has exactly one
 * importer in `src/`, the same rule `src/width.ts` follows for `string-width`.
 */
export function supportsLanguage(name: string): boolean {
  return !!hljs.getLanguage(name);
}
