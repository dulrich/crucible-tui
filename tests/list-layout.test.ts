import { describe, expect, test } from "bun:test";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { createLayoutContext } from "../src/layout-context";
import { createListTextLayout } from "../src/list-layout";
import { renderDocument } from "../src/render";
import { NARROW_MEASURE } from "../src/width";

// WP-R2 of `plans/post-refactor-code-quality-remediation.md` moved the list/text layout
// state machine out of `renderDocumentDetailed` into `src/list-layout.ts`. These tests
// grade the one property that move could plausibly break and that no existing test asks
// directly: the state is **per render**, exactly as it was when `inlineDepth` and
// `quoteColumns` were `let` bindings inside the render function.
//
// The rendered bytes themselves are graded where they always were — the render-lists-*
// and render-* split files (since split; see tests/AGENTS.md's WP-R3 record),
// `tests/witnesses.test.ts` and the differential harness — because the work package's
// whole gate is that they did not move.

const context = (): ReturnType<typeof createLayoutContext> =>
  createLayoutContext({
    width: 80,
    glyphs: UNICODE_GLYPHS,
    measure: NARROW_MEASURE,
    resolveFenceLanguage: (raw: string | undefined): string | undefined => raw,
    emoji: false,
    sgr: "none",
  });

const SENTINEL = String.fromCharCode(0);

describe("createListTextLayout", () => {
  test("supplies exactly the five visitors that share the per-render layout state", () => {
    const seam = createListTextLayout(context(), SENTINEL);
    expect(Object.keys(seam).sort()).toEqual(["blockquote", "heading", "list", "paragraph", "text"]);
    for (const method of Object.values(seam)) expect(typeof method).toBe("function");
  });

  test("is a fresh state machine per call — nothing is shared between two renders", () => {
    const first = createListTextLayout(context(), SENTINEL);
    const second = createListTextLayout(context(), SENTINEL);
    expect(first).not.toBe(second);
    expect(first.list).not.toBe(second.list);
  });
});

describe("the layout state is per render, not per module", () => {
  // `quoteColumns` is the counter a blockquote raises and lowers around its children's
  // render, and `rewrapListBody`'s budget reads it. If it ever became module state, a
  // document rendered after a blockquote-carrying one would be wrapped at a budget four
  // columns too narrow — silently, and only sometimes, depending on file ordering.
  const quoted = "> outer quote\n>\n> - a quoted list item whose text is long enough that the budget matters here\n";
  const plain = "- a plain list item whose text is long enough that the budget matters here too\n";

  test("a blockquote render does not narrow the next document's list budget", () => {
    const plainFirst = renderDocument(plain, 60);
    renderDocument(quoted, 60);
    expect(renderDocument(plain, 60)).toBe(plainFirst);
  });

  test("an unbalanced-looking render leaves no residue for the next one", () => {
    const quotedAlone = renderDocument(quoted, 60);
    renderDocument(plain, 60);
    renderDocument(quoted, 40);
    expect(renderDocument(quoted, 60)).toBe(quotedAlone);
  });

  // `inlineDepth` is condition 2 of the tight-list-item test in the `text` seam: non-zero
  // means "we are inside something that dispatches inline tokens", so a leaked non-zero
  // value would stop a tight item's own markup from ever being parsed.
  test("a paragraph-heavy render does not stop the next document's tight items parsing", () => {
    const item = "- tight item with **bold** in it\n";
    const itemFirst = renderDocument(item, 60);
    renderDocument("A paragraph with **bold** in it.\n\n# A heading with *emphasis*\n", 60);
    expect(renderDocument(item, 60)).toBe(itemFirst);
    expect(itemFirst).not.toContain("**bold**");
  });
});
