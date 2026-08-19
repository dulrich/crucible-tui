/**
 * The one styling authority: the narrow committed style table and the policy-driven
 * emitter. WP-2 of `plans/colour-policy.md`.
 *
 * Before this package three things decided independently whether a byte of SGR was
 * emitted and which bytes it was: `src/inline.ts`'s chain machinery over
 * `@colors/colors`' *styles record* (gated on `LayoutContext.color`), `src/table.ts`'s
 * `colors.grey`/`colors.bold` (gated on `@colors`' own environment-only `enabled`, which
 * is **on in a plain pipe** — measured at this package's base: a piped
 * `mdview wide-table.md` carried 205 `90m`/`39m` pairs and 12 `1m`/`22m` pairs with no
 * colour requested at all), and `src/frontmatter.ts`'s two hand-written constants. This
 * module is all three, and the gate is always the resolved policy
 * (`resolveColourPolicy`, `src/colour.ts`) threaded in as a value.
 *
 * ## The table is narrow on purpose (Decision 3)
 *
 * `STYLE_TABLE` holds **exactly the `[open, close]` pairs this renderer is authorized to
 * emit** — not `@colors`' full styles record, which also carries inverse, hidden,
 * background and bright-colour entries this tool has never emitted and has not ratified.
 * Every hue is a base terminal-palette SGR (`30`-`37`/`90`-`97` foreground introducers
 * only); `38`/`48` — the extended-colour introducers — are banned outright, so a
 * 256-colour or truecolor sequence cannot enter the output through this table.
 * `tests/style.test.ts` asserts both halves *independently of the emitter*: every
 * parameter of every entry against the ratified inventory, so the table and its consumer
 * cannot be widened together in one edit and still pass.
 *
 * The bytes are committed literals rather than a library read. They were previously
 * `@colors/colors`' and `chalk@4`'s (the latter reached through `cli-highlight`'s theme),
 * and both agreed pair-for-pair — measured at this package's base with both packages still
 * installed:
 *
 * ```text
 * chalk@4.1.2 : blue 34m/39m · cyan 36m/39m · green 32m/39m · red 31m/39m · yellow 33m/39m
 *               grey 90m/39m · italic 3m/23m · bold 1m/22m · underline 4m/24m
 * @colors@1.5 : grey 90m/39m · bold 1m/22m (the two `src/table.ts` used)
 * ```
 *
 * Committing them is what lets both packages leave the runtime closure without the
 * forced-colour render moving a byte; the per-producer byte comparisons in
 * `tests/style.test.ts`, `tests/highlight.test.ts` and `tests/table.test.ts` are what
 * proves it did not.
 *
 * ## Two application modes, because the producers really do differ
 *
 * - `applyStyle` reproduces **`chalk`'s `applyStyle`** — nested close/reopen and
 *   line-break encasing — and is what the inline visitors, the block leaves, list items
 *   and the syntax colorizer's theme need, because that is what their bytes are today
 *   (`chalk` via `marked-terminal`'s defaults, and `chalk@4` via `cli-highlight`'s theme).
 * - `styleSpan` is a **plain wrap**: open, text, close, whatever the text contains. It
 *   exists because `src/frontmatter.ts` emits exactly that today and its dimmed spans are
 *   routinely multi-line — the unparseable-frontmatter witness renders two multi-line dim
 *   segments carrying a single `2m`/`22m` pair each, where the encasing form would emit one
 *   pair per line. Using the chalk form there would move forced-colour bytes, which this
 *   package's contract forbids.
 *
 * Both read the same table and the same colour gate; what differs is only how a style is
 * applied to text, and each producer keeps the rule its bytes already record.
 */

/** One style's escape pair, exactly as it is emitted. */
export interface StyleCode {
  readonly open: string;
  readonly close: string;
}

/**
 * The committed style table — every style this renderer may emit, and nothing else.
 *
 * Names are the ones the producers already used (`@colors`'/`chalk`'s spelling), so the
 * chains below read the same as the `chalk.…` expressions they were transcribed from.
 * `gray` is the single spelling: `@colors` carried `grey` as an alias and `src/table.ts`
 * called it, but an alias is a second name for one authorized style and the table is the
 * place that must stay countable.
 */
export const STYLE_TABLE = {
  reset: { open: "\u001b[0m", close: "\u001b[0m" },
  bold: { open: "\u001b[1m", close: "\u001b[22m" },
  dim: { open: "\u001b[2m", close: "\u001b[22m" },
  italic: { open: "\u001b[3m", close: "\u001b[23m" },
  underline: { open: "\u001b[4m", close: "\u001b[24m" },
  strikethrough: { open: "\u001b[9m", close: "\u001b[29m" },
  red: { open: "\u001b[31m", close: "\u001b[39m" },
  green: { open: "\u001b[32m", close: "\u001b[39m" },
  yellow: { open: "\u001b[33m", close: "\u001b[39m" },
  blue: { open: "\u001b[34m", close: "\u001b[39m" },
  magenta: { open: "\u001b[35m", close: "\u001b[39m" },
  cyan: { open: "\u001b[36m", close: "\u001b[39m" },
  gray: { open: "\u001b[90m", close: "\u001b[39m" },
} as const satisfies Record<string, StyleCode>;

/** The name of a style in the committed table. */
export type StyleName = keyof typeof STYLE_TABLE;

/**
 * The colour half of the resolved policy, as the emitter needs it.
 *
 * A `LayoutContext` satisfies this structurally, so every visitor keeps calling
 * `applyStyle(ctx, …)`; `src/table.ts` and `src/frontmatter.ts`, which are handed a plain
 * boolean rather than a context, use `styleSpan` or construct the one-field value. What
 * matters is that the decision arrives as a value — this module reads no environment, no
 * argv and no module-load global, which is the whole reason the three former authorities
 * are gone.
 */
export interface ColourGate {
  readonly color: boolean;
}

export interface Styler {
  readonly open: string;
  readonly close: string;
  readonly openAll: string;
  readonly closeAll: string;
  readonly parent?: Styler;
}

/**
 * One link in a style chain, built exactly as `chalk`'s `createStyler` builds it
 * (`chalk@5.6.2`, `chalk/source/index.js`; `chalk@4.1.2` is the same construction):
 * `openAll` accumulates outermost-first, `closeAll` innermost-first.
 * `chalk.dim.gray.strikethrough` is therefore `\x1b[2m\x1b[90m\x1b[9m` …
 * `\x1b[29m\x1b[39m\x1b[22m`, and the nesting order is not cosmetic — it is the byte order
 * parity class A is measured against.
 *
 * Moved here from `src/inline.ts` unchanged except for its source of bytes: it read
 * `@colors/colors`' `styles` record through a cast, and now reads `STYLE_TABLE`. The cast
 * is gone with the package, and an unknown name is a compile-time error rather than the
 * runtime throw it used to be — the throw is kept anyway for a name reaching this from a
 * non-typed caller.
 */
export function createStyler(name: StyleName, parent?: Styler): Styler {
  const code: StyleCode | undefined = STYLE_TABLE[name];
  if (!code) throw new Error(`mdview: no style named ${name} in the committed style table`);
  return {
    open: code.open,
    close: code.close,
    openAll: parent === undefined ? code.open : parent.openAll + code.open,
    closeAll: parent === undefined ? code.close : code.close + parent.closeAll,
    parent,
  };
}

// `chalk`'s own `stringReplaceAll` (`chalk/source/utilities.js`), transcribed. It differs from
// `String.prototype.replaceAll` in that it re-emits the *substring as well as* the
// replacer — the point is to re-open a style after a nested style closed it, not to
// remove the close.
function stringReplaceAll(string: string, substring: string, replacer: string): string {
  let index = string.indexOf(substring);
  if (index === -1) return string;

  const substringLength = substring.length;
  let endIndex = 0;
  let returnValue = "";
  do {
    returnValue += string.slice(endIndex, index) + substring + replacer;
    endIndex = index + substringLength;
    index = string.indexOf(substring, endIndex);
  } while (index !== -1);

  returnValue += string.slice(endIndex);
  return returnValue;
}

// `chalk`'s `stringEncaseCRLFWithFirstIndex`, transcribed. Closes the styling before every
// line break and reopens it after, which is a workaround for a styling bleed on one
// terminal (chalk PR #92) and, here, simply part of the bytes being reproduced.
function stringEncaseCRLFWithFirstIndex(string: string, prefix: string, postfix: string, first: number): string {
  let index = first;
  let endIndex = 0;
  let returnValue = "";
  do {
    const gotCR = string[index - 1] === "\r";
    returnValue += string.slice(endIndex, gotCR ? index - 1 : index) + prefix + (gotCR ? "\r\n" : "\n") + postfix;
    endIndex = index + 1;
    index = string.indexOf("\n", endIndex);
  } while (index !== -1);

  returnValue += string.slice(endIndex);
  return returnValue;
}

/**
 * Apply a style chain, reproducing `chalk`'s `applyStyle` exactly.
 *
 * **Wrapping in `open` … `close` is not sufficient and the difference is reachable from
 * ordinary markdown.** Two behaviours beyond the wrap:
 *
 * 1. If the input already contains an escape, every occurrence of *this chain's* close
 *    code gets the matching open appended after it, innermost link outward — the close is
 *    re-emitted and *then* the style resumes, which is `stringReplaceAll`'s whole point and
 *    is easy to get backwards. This fires on the very first `link` in a document: `link` is
 *    a blue wrap around an already-blue-and-underlined href, both closing with `39m`, so
 *    the href's close is followed by a blue re-open. It fires on `del` too, whenever a
 *    strikethrough span contains a code span — grey's close is `39m` as well. And it fires
 *    on every nested token class in `src/highlight.ts`, which is why the colorizer applies
 *    its theme through this function rather than around it.
 * 2. If the input contains a newline, the styling is closed before it and reopened after.
 *
 * Both are in the output this repo shipped before the two packages left, so both are
 * class-A obligations, not polish.
 */
export function applyStyle(ctx: ColourGate, chain: Styler, input: string): string {
  // `chalk`'s own guard: level 0, or an empty string, and the input comes back untouched.
  if (!ctx.color || !input) return input;

  let string = input;
  const { openAll, closeAll } = chain;

  if (string.includes("\u001b")) {
    let styler: Styler | undefined = chain;
    while (styler !== undefined) {
      string = stringReplaceAll(string, styler.close, styler.open);
      styler = styler.parent;
    }
  }

  const lfIndex = string.indexOf("\n");
  if (lfIndex !== -1) {
    string = stringEncaseCRLFWithFirstIndex(string, closeAll, openAll, lfIndex);
  }

  return openAll + string + closeAll;
}

/**
 * Apply a style chain as a **plain wrap** — open, text, close — with no nested re-open and
 * no line-break encasing.
 *
 * This is `src/frontmatter.ts`'s rule, and it is that module's rule because those are the
 * bytes it emits today: `DIM_START + text + DIM_END`, hand-written, around text that is
 * frequently multi-line (the raw echo of an unparseable frontmatter block, the wrapped
 * parse diagnostic). Routing it through `applyStyle` would emit one dim pair per line
 * instead of one per span and move forced-colour bytes on three of the fourteen gate-corpus
 * files, so the difference is kept and named rather than unified away.
 *
 * **There is no empty-string guard, and that is not an oversight.** `chalk`'s `applyStyle`
 * returns `''` untouched, so `applyStyle` above does too; the hand-written form this
 * replaces had no such branch, and `formatMetaBlock("")` really does emit a bare
 * `2m`/`22m` pair around nothing when the raw echo of an empty frontmatter block is dimmed
 * (`tests/frontmatter.test.ts` pins it). Adding the guard here was tried and it moved that
 * byte pair.
 *
 * The colour gate is a plain boolean because its callers hold one, not a `LayoutContext`.
 */
export function styleSpan(color: boolean, chain: Styler, input: string): string {
  if (!color) return input;
  return chain.openAll + input + chain.closeAll;
}
