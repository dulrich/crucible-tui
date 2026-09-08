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
 * `tests/style.test.ts`, `tests/highlight.test.ts` and `tests/table-emission.test.ts` are
 * what proves it did not.
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
 *
 * ## The mode filter (WP-2 of `plans/colour-modes.md`)
 *
 * This module is also where the hue/format split lives, and it lives here because it is a
 * property of a *style*, not of a producer (Decision 8, user 2026-08-18: decide by style
 * property, never by producer provenance). `STYLE_CLASSES` classifies every committed name
 * as hue, format or control; `emitsUnder` is the whole rule; `filterChain` rebuilds a chain
 * with the suppressed links removed, and **both emitters run their existing bodies over the
 * filtered chain** so the re-open surgery and the newline encasing cannot reintroduce a
 * byte the filter dropped.
 *
 * The predecessor plan needed eight work packages for this and this one needs a filter,
 * for one reason: since `plans/colour-policy.md` every producer holds a *named* chain
 * rather than an opaque byte string, so the name survives to the point of emission. WP-2's
 * only structural change is keeping that name on the `Styler` node (`createStyler` used to
 * accumulate the bytes and discard it).
 *
 * **The one exception is named rather than hidden**: fenced-code syntax highlighting is
 * `full`-only, decided at `src/blocks.ts`'s `highlightCode` and not here, because the
 * highlight branch carries a visible-content transform (`fixHardReturn`) and its theme
 * carries format styles — see Decision 3 and `src/AGENTS.md`.
 */

import { type SgrMode } from "./colour";

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
 * What kind of thing a committed style *is* — the axis `SgrMode` filters on.
 *
 * Three classes, not two, because `reset` is neither (Decision 8 of
 * `plans/colour-modes.md`, from cycle-1 f9). It opens and closes with the same `0m` both
 * directions, it carries no colour and no weight, and it is what frames every paragraph,
 * rule and list item (`src/blocks.ts`, `src/lists.ts`) — filing it under "format" would be
 * an accident that happened to work and filing it under "hue" would strip the framing out
 * of `formats` mode for no reason anyone could state.
 */
export type StyleClass = "hue" | "format" | "control";

/**
 * **The committed classification** (WP-2 of `plans/colour-modes.md`).
 *
 * `satisfies Record<StyleName, StyleClass>` is the load-bearing part: it is a compile-time
 * error to add an entry to `STYLE_TABLE` without classifying it, which is exactly the
 * failure a "decide by style property" rule (Decision 8, user 2026-08-18) has to be
 * protected from — an unclassified style would otherwise silently pick up whatever the
 * lookup's default was.
 *
 * - **hue** — the seven foreground colours. These are what an explicit `never` directive
 *   drops, and nothing else is.
 * - **format** — weight, emphasis and decoration. Decision 1: *`--no-color` means no hue,
 *   all other formatting preserved*; **`dim` is a format, not a hue**, which is the one
 *   membership the user named directly and the one that keeps `src/frontmatter.ts`'s
 *   metadata block legible under `formats`.
 * - **control** — `reset`, per Decision 8: emitted whenever `sgr !== "none"`.
 *
 * **This is a classification of names, never of producers.** Which producer asked is not
 * an input here; the one place provenance decides anything is `highlightCode`
 * (`src/blocks.ts`), which is keyed to `full` as an explicit, named, ratified *producer
 * exception* (Decision 3) precisely because it could not be expressed as a property.
 */
export const STYLE_CLASSES = {
  reset: "control",
  bold: "format",
  dim: "format",
  italic: "format",
  underline: "format",
  strikethrough: "format",
  red: "hue",
  green: "hue",
  yellow: "hue",
  blue: "hue",
  magenta: "hue",
  cyan: "hue",
  gray: "hue",
} as const satisfies Record<StyleName, StyleClass>;

/**
 * Whether one committed style emits at all under one mode.
 *
 * The whole of the mode semantics, in three lines: `none` emits nothing of the tool's own,
 * `full` emits everything the table authorizes, and `formats` emits everything that is not
 * a hue. Exported so `tests/style.test.ts` can assert the rule directly, per name and per
 * mode, rather than only through the bytes some producer happens to emit.
 */
export function emitsUnder(name: StyleName, sgr: SgrMode): boolean {
  if (sgr === "none") return false;
  if (sgr === "full") return true;
  return STYLE_CLASSES[name] !== "hue";
}

/**
 * The colour half of the resolved policy, as the emitter needs it.
 *
 * A `LayoutContext` satisfies this structurally, so every visitor keeps calling
 * `applyStyle(ctx, …)`; `src/table.ts` and `src/frontmatter.ts`, which are handed the mode
 * rather than a context, construct the one-field value at the call. What matters is that
 * the decision arrives as a value — this module reads no environment, no argv and no
 * module-load global, which is the whole reason the three former authorities are gone.
 *
 * **The field is `sgr: SgrMode`, not `color: boolean`** (WP-2 of `plans/colour-modes.md`).
 * The boolean could not express `formats`, and widening it to a second flag beside itself
 * would have made `color=false, hue=true` representable — one canonical value with three
 * inhabitants is what cycle-1 f7 asked for and what this is.
 */
export interface ColourGate {
  readonly sgr: SgrMode;
}

export interface Styler {
  /**
   * **The style's own name, kept on the node** — WP-2 of `plans/colour-modes.md`.
   *
   * Until that package a `Styler` accumulated byte strings and *discarded* the name, so by
   * the time the emitter saw a chain there was nothing left to classify: the bytes
   * `\x1b[90m` and `\x1b[1m` are indistinguishable as far as "is this a hue" goes without
   * re-parsing them, and re-parsing emitted bytes to recover a decision the builder
   * already knew is the shape of defect this repo owns `src/style.ts` to avoid. Keeping
   * the name is the one structural change the hue/format split needed; everything else in
   * this module is a filter over it.
   */
  readonly name: StyleName;
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
    name,
    open: code.open,
    close: code.close,
    openAll: parent === undefined ? code.open : parent.openAll + code.open,
    closeAll: parent === undefined ? code.close : code.close + parent.closeAll,
    parent,
  };
}

/**
 * Memo for `filterChain`, keyed on the *unfiltered* chain object.
 *
 * Every chain in this repo is a module-scope constant built once at import
 * (`src/inline.ts:112-117`, `src/blocks.ts:108-116`, `src/lists.ts:105`,
 * `src/table.ts:509-510`, `src/frontmatter.ts:10`, `src/wikilink.ts:86`, and
 * `src/highlight.ts`'s whole theme), so this table saturates at a couple of dozen entries
 * on the first coloured render and never grows again. A `WeakMap` rather than a `Map`
 * because a caller *may* build a chain per call and nothing should keep it alive.
 */
const FORMATS_CHAINS = new WeakMap<Styler, Styler | null>();

/**
 * The chain a mode actually emits: the input chain with every style the mode suppresses
 * removed, rebuilt so `openAll`/`closeAll` are the bytes that will really be written.
 *
 * `null` means *this chain emits nothing under this mode* — every link was filtered out —
 * and the callers below turn that into "return the input untouched" rather than into a
 * pair of empty strings, so a hue-only chain under `formats` leaves no residue at all.
 *
 * **Rebuilding through `createStyler` rather than string-editing `openAll` is the point.**
 * The accumulation order is a parity-class-A obligation (`chalk`'s: outermost-first open,
 * innermost-first close), and the surviving links have to nest with each other exactly as
 * they would have if the dropped ones had never been asked for. Running the original
 * builder over the surviving names is the only spelling that cannot get that wrong; it is
 * also what makes `full` the identity by construction — no rebuild happens at all.
 */
function filterChain(chain: Styler, sgr: SgrMode): Styler | null {
  if (sgr === "none") return null;
  if (sgr === "full") return chain;

  const cached = FORMATS_CHAINS.get(chain);
  if (cached !== undefined) return cached;

  // Outermost-first: `parent` walks *outward*, so the collected order is reversed to match
  // the order `createStyler` was originally called in.
  const names: StyleName[] = [];
  for (let link: Styler | undefined = chain; link !== undefined; link = link.parent) names.push(link.name);
  names.reverse();

  let built: Styler | undefined;
  for (const name of names) {
    if (emitsUnder(name, sgr)) built = createStyler(name, built);
  }

  const result = built ?? null;
  FORMATS_CHAINS.set(chain, result);
  return result;
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
 *
 * **The mode filter runs first, and everything below it runs over the filtered chain**
 * (WP-2 of `plans/colour-modes.md`). That ordering is not a preference: the re-open
 * surgery re-emits *this chain's own* close codes, and the encasing re-opens *this chain's
 * own* `openAll` after every line break — so running either over the unfiltered chain
 * under `formats` would put back exactly the hue bytes the filter just removed. Neither
 * helper changed; what changed is which chain they are handed. Under `full` the filter is
 * the identity and these are the same bytes as before, by construction.
 */
export function applyStyle(ctx: ColourGate, chain: Styler, input: string): string {
  // `chalk`'s own guard: level 0, or an empty string, and the input comes back untouched.
  if (ctx.sgr === "none" || !input) return input;

  // Nothing in this chain survives the mode — the wiki-link's bare cyan under `formats`,
  // or a hue-only theme entry. Emit nothing at all rather than an empty open/close pair.
  const filtered = filterChain(chain, ctx.sgr);
  if (filtered === null) return input;

  let string = input;
  const { openAll, closeAll } = filtered;

  if (string.includes("\u001b")) {
    let styler: Styler | undefined = filtered;
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
 * Turn one ordered style chain into bytes — the **one** place a chain of `StyleName`s
 * becomes SGR for the two producers that carry names rather than a prebuilt `Styler`.
 *
 * The fold is `createStyler`'s own accumulation order, outermost name first, so
 * `["cyan", "underline"]` produces exactly the `openAll`/`closeAll` that
 * `createStyler("underline", createStyler("cyan"))` produces — nothing hand-spells a pair,
 * and the gate is the resolved mode, so `formats` drops the hue and `none` emits nothing at
 * all.
 *
 * **Both consumers call this one body** (the span-cell contract's "one shared applicator",
 * `plans/wiki-link-tokenizer.md`): `styleWikiLabel` (`src/wikilink.ts`, prose) hands it
 * `WIKI_LINK_STYLES`, and `src/table.ts`'s fragment emitter hands it each `CellSpan`'s own
 * chain. It landed private to `src/table.ts` at WP-1 of that plan — with a comment naming
 * this lift — because `src/style.ts` and `src/wikilink.ts` were outside that package's file
 * scope; WP-2 moved the body here unchanged and left no copy behind. A second copy that the
 * second consumer never calls is not a shared applicator.
 */
export function applyStyleChain(gate: ColourGate, styles: readonly StyleName[], input: string): string {
  if (styles.length === 0) return input;
  let chain: Styler | undefined;
  for (const name of styles) chain = createStyler(name, chain);
  return applyStyle(gate, chain as Styler, input);
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
 * **That pin survives `formats` intact, and it is stated here so nobody "fixes" it there
 * either** (WP-2 of `plans/colour-modes.md`). `dim` is format-class, so the filter below
 * keeps it: `formatMetaBlock("")` under `formats` emits the same bare `2m`/`22m` pair
 * around nothing that it emits under `full`. A future reader who meets that pair in
 * `formats` output and reads it as filter residue should read this paragraph instead —
 * it is the same deliberate no-guard emission, pinned in both modes.
 *
 * The gate is a `ColourGate` rather than the plain boolean it took until that package,
 * because a plain boolean cannot express the middle level and this function has to filter
 * exactly as `applyStyle` does. Its callers (`src/frontmatter.ts`) thread the mode down
 * from the resolved policy and construct the one-field value at the call.
 */
export function styleSpan(gate: ColourGate, chain: Styler, input: string): string {
  if (gate.sgr === "none") return input;
  const filtered = filterChain(chain, gate.sgr);
  if (filtered === null) return input;
  return filtered.openAll + input + filtered.closeAll;
}
