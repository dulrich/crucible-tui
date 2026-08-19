import { type GlyphSet } from "./glyphs";
import { type Measure } from "./width";

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
   * Whether `:shortcode:` substitution runs. Computed once per render as
   * `emojiOverride ?? (glyphs.tier === "unicode")` — see `renderDocumentDetailed`'s
   * comment for why it is computed once and shared rather than re-derived per renderer.
   */
  readonly emoji: boolean;
  /**
   * Whether inline styling emits SGR codes at all.
   *
   * This is a *decision*, carried as a value. Since WP-1 of `plans/colour-policy.md` it is
   * **the tool's one colour decision**, resolved by `resolveColourPolicy` (`src/colour.ts`)
   * from inputs handed in explicitly and threaded here through `renderDocumentDetailed`'s
   * policy parameter. It used to be `detectInlineColor()`'s answer, re-derived inside every
   * render from a `supports-color` module global that had already resolved — argv sniff and
   * all — before the first document was ever read.
   *
   * **Two authorities still disagree with this one, and both are WP-2's to retire, not
   * this field's to paper over.** `src/table.ts` styles through `@colors/colors`' own
   * environment-only `enabled` flag, chosen there so the emitter reproduces what
   * `cli-table3` used to decide; `cli-highlight` gates syntax colour on its bundled
   * `chalk`'s module-load level. Until the owned emitter and colorizer land, a forced
   * colour decision cannot reach either of them.
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
  emoji: boolean;
  color: boolean;
  /**
   * Defaulted to `false` rather than required, deliberately: OSC-8 is off on every
   * non-terminal destination, which is every gate, every sweep and every test, so the
   * default is the answer the overwhelming majority of construction sites want and the
   * one a forgotten argument should produce.
   */
  hyperlinks?: boolean;
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
    emoji: init.emoji,
    color: init.color,
    hyperlinks: init.hyperlinks ?? false,
  });
}
