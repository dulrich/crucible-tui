import { type SgrMode } from "./colour";
import { type GlyphSet } from "./glyphs";
import { type Measure } from "./width";

/**
 * Wiki-link slug → destination URI, or `undefined` for "this slug names nothing here".
 *
 * Declared here rather than in `src/wikilink.ts` because this is the module that owns the
 * **seam** — the field below is what the renderer sees, `src/render.ts`'s trailing parameter
 * is how a caller fills it, and `src/wikiresolve.ts` is one implementation of it rather than
 * its definition. `fragment` is the `#…` text with the `#` removed, present only when the
 * link authored one (`WikiLinkToken.fragment`).
 */
export type WikiLinkResolver = (slug: string, fragment?: string) => string | undefined;

/**
 * The one value every owned renderer visitor is handed.
 *
 * `plans/marked-terminal-replacement.md`'s decision 5 carries this over from the code
 * review unchanged: *thread one immutable `LayoutContext` (width, prefix columns, glyph
 * set, `Measure`, fence-language resolver)*. It exists because the library being
 * replaced takes its width **only at construction** — which is why `src/render.ts`
 * builds three `marked-terminal` instances per render and caches two of them by budget.
 * A visitor that receives the context takes the budget as a parameter instead, and both
 * caches lose their reason to exist (WP-3).
 *
 * **Immutable, and never a process global.** It is constructed once per
 * `renderDocumentDetailed` call and passed explicitly. Two of its fields are values the
 * repo has already decided must be threaded rather than detected at the point of use:
 * `glyphs` (`src/glyphs.ts` is the only module that reads the environment) and `measure`
 * (`src/width.ts` is the only module that imports `string-width`, and is the single
 * ruler). Re-detecting either inside a visitor would put an environment read behind the
 * renderer's back, which is exactly what the sweep's "take tier and ambiguous mode as
 * explicit parameters" rule exists to prevent.
 *
 * The one deliberately-mutable member is `prefix`, and pretending otherwise would be
 * dishonest rather than safe — see `PrefixColumns`.
 */
export interface LayoutContext {
  /** The target width the document is being rendered at. */
  readonly width: number;
  /** The glyph capability tier, threaded from `src/glyphs.ts`. */
  readonly glyphs: GlyphSet;
  /** The single display-width ruler, threaded from `src/width.ts`. */
  readonly measure: Measure;
  /** Columns the enclosing block renderers still owe the text being produced now. */
  readonly prefix: PrefixColumns;
  /**
   * Fence-language normalisation, as a resolver-shaped field rather than a direct
   * import.
   *
   * This is the **seam** F4 needs and not F4 itself: `src/lang.ts` still keeps its
   * `effectiveAliases` module global and its `setHighlightAliases` setter, because the
   * consumer that has to change is the fence renderer WP-3 rewrites. What lands here is
   * only the shape — a resolver reached through the context, so that when WP-3 makes the
   * alias map an immutable field there is already a place to put it.
   */
  readonly resolveFenceLanguage: (rawLang: string | undefined) => string | undefined;
  /**
   * How a wiki-link's slug becomes a destination — **absent means no navigation**, which is
   * the behaviour every render had before `plans/follow-wiki-links.md` and the behaviour
   * every caller that does not opt in still has (the sweep, the colour axis, every test that
   * does not ask for it). `src/wikilink.ts`'s `styleWikiLabel` calls it, and only when
   * `hyperlinks` is on and the label carries no OSC-8 of its own.
   *
   * **It is a resolver-shaped field for the reason `resolveFenceLanguage` above is** (D6):
   * answering "which file is `[[note]]`?" means reading directories, and the renderer reads
   * no filesystem and no process state. `src/cli.ts` is the one place the answer is built —
   * `createWikiLinkResolver` (`src/wikiresolve.ts`) — and it arrives here as a value, so a
   * test varies it by handing in a different function rather than by building a tree.
   *
   * The return is a complete URI (a percent-encoded `file://` one today), never a path:
   * this field's consumer hands it straight to `src/ansi.ts`'s `link` and does not
   * interpret it. `undefined` means the slug resolved to nothing, and the label renders
   * exactly as it would with no resolver at all (D3).
   */
  readonly resolveWikiLink?: WikiLinkResolver;
  /**
   * Whether `:shortcode:` substitution runs. Computed once per render as
   * `emojiOverride ?? (glyphs.tier === "unicode")` — see `renderDocumentDetailed`'s
   * comment for why it is computed once and shared rather than re-derived per renderer.
   */
  readonly emoji: boolean;
  /**
   * **How much SGR this render emits — the one canonical colour value** (WP-2 of
   * `plans/colour-modes.md`).
   *
   * `resolveColourPolicy`'s (`src/colour.ts`), threaded through
   * `renderDocumentDetailed`'s policy parameter and carried here unchanged. Every producer
   * that styles reads *this* — `src/style.ts`'s `ColourGate` is satisfied structurally by
   * a `LayoutContext`, so `applyStyle(ctx, …)` is unchanged at all sixteen call sites —
   * and the hue/format filter is applied there, once, by name.
   *
   * **`sgr` is accepted; `color` below is derived from it.** Accepting both would make
   * `color: false, sgr: "full"` constructible, and a context is the one value in this
   * renderer that every visitor trusts without re-checking.
   */
  readonly sgr: SgrMode;
  /**
   * Whether inline styling emits SGR codes at all — **derived, never accepted**.
   *
   * The invariant, stated so it can be tested rather than assumed (and it is, for all
   * three modes, in `tests/layout-context.test.ts`):
   *
   * ```text
   * ctx.color === (ctx.sgr !== "none")
   * ```
   *
   * `LayoutContextInit` has no `color` field at all — `createLayoutContext` computes it —
   * so there is no construction site that can disagree with `sgr`, which is what
   * "constructor-derived" means here and why the field is safe to keep.
   *
   * **It has no production reader left**, and that is a real consequence of this package
   * rather than an oversight: the last two (`highlightCode` in `src/blocks.ts`, and the
   * `renderTable` feed in `src/render.ts`) both needed to distinguish `formats` from
   * `full`, which a boolean cannot do, so both moved to `sgr`. It is retained because the
   * `sgr !== "none"` threshold is the one every *other* reader would want if it needed one
   * — the plan's reader inventory assigns it by default — and because deleting a field to
   * re-add it one work package later is churn. If a future package finds it still has no
   * reader, deleting it is that package's call to make, with this note as the record.
   *
   * This is a *decision*, carried as a value. Since WP-1 of `plans/colour-policy.md` it is
   * **the tool's one colour decision**, resolved by `resolveColourPolicy` (`src/colour.ts`)
   * from inputs handed in explicitly and threaded here through `renderDocumentDetailed`'s
   * policy parameter. It used to be `detectInlineColor()`'s answer, re-derived inside every
   * render from a `supports-color` module global that had already resolved — argv sniff and
   * all — before the first document was ever read.
   *
   * **It is now the only authority, which it was not when this comment was first written.**
   * Two others disagreed with it for one package: `src/table.ts` styled through
   * `@colors/colors`' own environment-only `enabled` flag (chosen there so the emitter
   * reproduced what `cli-table3` used to decide), and `cli-highlight` gated syntax colour
   * on its bundled `chalk`'s module-load level — so a forced colour decision could reach
   * neither of them, and `MDVIEW_COLOR=always` on a pipe produced a document with no
   * highlighting and no table styling in it. WP-2 of `plans/colour-policy.md` retired both:
   * the styles come from `src/style.ts`'s committed table, the colorizer is
   * `src/highlight.ts`, and every producer reads *this field*. Measured at that package's
   * close: `MDVIEW_COLOR=always` and `FORCE_COLOR=3` render every gate-corpus file
   * byte-identically, at every width and both glyph tiers.
   */
  readonly color: boolean;
  /**
   * Whether the renderer emits OSC-8 hyperlinks.
   *
   * **A separate axis from `color`, ratified as one** (Decision 4 of
   * `plans/colour-policy.md`): `NO_COLOR` does not turn hyperlinks off, `--color=always`
   * does not turn them on, and a non-TTY destination turns them off whatever else is set.
   * `src/inline.ts`'s `renderLink` reads this where it used to read
   * `supportsHyperlinks.stdout` — a second module global, resolved at that library's own
   * load, that no caller could influence and no test could vary without a subprocess.
   */
  readonly hyperlinks: boolean;
  /**
   * Whether the destination is inside tmux — the DCS envelope every OSC sequence needs
   * there (`src/ansi.ts`'s `link`, transcribed from `ansi-escapes@7.3.0`).
   *
   * It rides here rather than being read where it is used for the same reason `color` and
   * `hyperlinks` do: WP-3 of `plans/colour-policy.md` took OSC-8 emission off
   * `ansi-escapes`, whose own `isTmux` was a `process.env` read at module load — the exact
   * shape the dependency-ownership rule removes. `resolveTmux` (`src/colour.ts`) answers
   * it once per render from an environment handed in, so an injected-tmux test needs no
   * subprocess.
   */
  readonly tmux: boolean;
}

/** One block renderer's contribution to the pending prefix. */
export interface PrefixEntry {
  /** How many columns this level glues on after its content has rendered. */
  readonly columns: number;
  /** True for a list level, false for anything else (today: a blockquote). */
  readonly list: boolean;
}

/**
 * The pending-prefix column stack.
 *
 * Columns that block renderers still owe every line of whatever is being rendered
 * *right now*, because they are glued on only after that inner render returns: a list
 * level's own marker plus its blanket indent, a blockquote's indent. Each block renderer
 * pushes its own contribution for the duration of its call, so at any point inside, the
 * sum is exactly how much narrower than `LayoutContext.width` the text being produced
 * has to be.
 *
 * **This is mutable on purpose and the context does not hide it.** A render walks a tree;
 * the stack is the path from the root to the node being rendered, and it changes as the
 * walk moves. What the review's "immutable" requirement is actually about is *module-level
 * state* — a value some other render could observe or corrupt. This stack is created per
 * `LayoutContext`, therefore per `renderDocumentDetailed` call, and every push is scoped
 * by the `try`/`finally` of the block renderer that made it. Freezing it and rebuilding a
 * context per level was the alternative; it would have made every existing call site churn
 * to buy a guarantee the per-call lifetime already provides.
 */
export interface PrefixColumns {
  /** Push one level's owed columns for the duration of that level's render. */
  push(entry: PrefixEntry): void;
  /** Pop the innermost level. Always paired with `push` in a `finally`. */
  pop(): void;
  /** Total owed columns — how much narrower than the target this text must be. */
  width(): number;
  /**
   * How many *list* levels are on the stack.
   *
   * `outerColumns()` — the non-list columns, for a budget that counted list levels
   * itself — sat beside this until WP-6 of `plans/marked-terminal-replacement.md`. WP-5
   * took its last production reader away (`src/lists.ts`'s note at `renderList`: the
   * stack's non-list entries became a mix of blockquote indents and per-item marker
   * widths, so `rewrapListBody`'s budget had to stop reading it and track quote columns
   * directly), leaving one accessor and two tests that only each other used. It is
   * deleted rather than kept: a passing test asserting an accessor nothing calls reads
   * as coverage and is not.
   */
  listDepth(): number;
}

/** A fresh, empty prefix stack. One per render. */
export function createPrefixColumns(): PrefixColumns {
  const entries: PrefixEntry[] = [];
  return {
    push(entry) {
      entries.push(entry);
    },
    pop() {
      entries.pop();
    },
    width() {
      return entries.reduce((sum, entry) => sum + entry.columns, 0);
    },
    listDepth() {
      return entries.reduce((count, entry) => count + (entry.list ? 1 : 0), 0);
    },
  };
}

/** Everything a `LayoutContext` needs that is not derived. */
export interface LayoutContextInit {
  width: number;
  glyphs: GlyphSet;
  measure: Measure;
  resolveFenceLanguage: (rawLang: string | undefined) => string | undefined;
  /** Optional for the same reason the field is: absent means "no navigation". */
  resolveWikiLink?: WikiLinkResolver;
  emoji: boolean;
  /**
   * The resolved colour mode. **`color` is deliberately absent from this interface** —
   * `createLayoutContext` derives it, so the invariant on `LayoutContext.color` cannot be
   * violated by a construction site.
   */
  sgr: SgrMode;
  /**
   * Defaulted to `false` rather than required, deliberately: OSC-8 is off on every
   * non-terminal destination, which is every gate, every sweep and every test, so the
   * default is the answer the overwhelming majority of construction sites want and the
   * one a forgotten argument should produce.
   */
  hyperlinks?: boolean;
  /** Defaulted to `false` for the same reason `hyperlinks` is: no destination, no tmux. */
  tmux?: boolean;
}

/**
 * Build the context for one render.
 *
 * Frozen, so a visitor cannot reach back and re-point `width` or `measure` at something
 * else partway through a document — the failure mode that a threaded value exists to
 * make impossible in the first place. `prefix` is a fresh stack per call.
 */
export function createLayoutContext(init: LayoutContextInit): LayoutContext {
  return Object.freeze({
    width: init.width,
    glyphs: init.glyphs,
    measure: init.measure,
    prefix: createPrefixColumns(),
    resolveFenceLanguage: init.resolveFenceLanguage,
    resolveWikiLink: init.resolveWikiLink,
    emoji: init.emoji,
    sgr: init.sgr,
    // The derived field, and the only place it is ever computed.
    color: init.sgr !== "none",
    hyperlinks: init.hyperlinks ?? false,
    tmux: init.tmux ?? false,
  });
}
