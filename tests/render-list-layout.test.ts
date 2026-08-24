import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { stripAnsi } from "../src/list-lines";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocument } from "../src/render";


describe("renderDocument — list reflow (WP-4a)", () => {
  test("a 300-character bullet emits no line over the target width", () => {
    const bullet = `- ${"word ".repeat(60)}`.trim();
    const output = renderDocument(bullet, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("a nested list (depth 2) emits no line over the target width", () => {
    const source = [
      `- top item with ${"word ".repeat(30)}`.trim(),
      `  - nested item with ${"word ".repeat(30)}`.trim(),
      `    - doubly nested item with ${"word ".repeat(30)}`.trim(),
      "- second top item",
    ].join("\n");
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("an ordered list (wider markers than '* ') wraps correctly", () => {
    const items = Array.from(
      { length: 12 },
      (_, i) => `${i + 1}. item ${i} with ${"word ".repeat(20)}`.trim(),
    );
    const output = renderDocument(items.join("\n"), 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
    const plain = stripAnsi(output);
    expect(plain).toContain("item 0");
    expect(plain).toContain("item 11");
  });

  test("a bullet with a long inline code span has no overflow and intact escapes", () => {
    const longPath = "mdview/tests/fixtures/a/very/long/path/that/needs/to/be/split/somewhere";
    const source = `- see \`${longPath}\` for the fixture`;
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/\[[0-9;]*$/);
    }
    const plain = stripAnsi(output);
    expect(plain.replace(/\s+/g, "")).toContain(longPath.replace(/\s+/g, ""));
  });
});

// ---------------------------------------------------------------------------
// WP-14 witness — inline markup is parsed inside a list item.
//
// Follows the witness pattern WP-10 established: the fixture and its record in
// `tests/fixtures/witnesses/witness-index.json` (id `wp14-list-item-inline-markup`)
// carry the evidence, and this describe block is the test half. It lives here rather
// than in `tests/witnesses.test.ts` because the plan assigns WP-14
// `tests/render.test.ts`, and the index's `test_file` field points at this file
// accordingly.
//
// What it witnesses: before the fix, `marked-terminal`'s `Renderer.prototype.text`
// (`index.js:84-89`) returned a list item's raw markdown source, so `**bold**`,
// `[label](url)`, `` `code` `` and `~~struck~~` reached the terminal as literal syntax
// in tight, loose, nested, ordered and task items — and only there. The `revert_method`
// recorded in the index turns every "parsed" assertion below red.
// ---------------------------------------------------------------------------

describe("witness: WP-14 -- inline markup inside a list item (tests/fixtures/witnesses/defect-wp14-list-item-inline-markup.md)", () => {
  const WITNESS_PATH = `${import.meta.dir}/fixtures/witnesses/defect-wp14-list-item-inline-markup.md`;
  const witnessSource = (): Promise<string> => readFile(WITNESS_PATH, "utf8");

  /** The item lines of the rendered fixture, minus the fence's own verbatim content. */
  function itemLines(rendered: string): string[] {
    return stripAnsi(rendered)
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.includes("echo "));
  }

  test("every list-item kind renders its inline markup parsed, exactly as the paragraph control does", async () => {
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    // The control: a paragraph has always parsed these. Each item kind must now agree
    // with it, which is the whole claim — not "some markup disappeared".
    expect(rendered).toContain("A paragraph is the control: bold, em, code, label (https://example.com/p) and struck");
    for (const marker of [
      "• tight: bold, em, code, label (https://example.com/p) and struck",
      "• loose: bold, em, code, label (https://example.com/p) and struck",
      "1. ordered: bold, em, code, label (https://example.com/p) and struck",
      "◦ nested: bold, em, code, label (https://example.com/p) and struck",
    ]) {
      expect(rendered).toContain(marker);
    }
    // ...and no item still carries the source spelling.
    for (const line of itemLines(rendered)) {
      expect(line).not.toContain("**");
      expect(line).not.toContain("~~");
      expect(line).not.toContain("](");
      expect(line).not.toContain("`");
    }
  });

  test("a task item's checkbox is rendered once, not doubled or lost, now that the item's tokens are what render", async () => {
    // `marked-terminal`'s `listitem` (`index.js:155-184`) prepends the checkbox two
    // different ways: a *tight* task item gets it concatenated onto the composed string,
    // a *loose* one gets a `text` token unshifted onto `item.tokens`. Only the second
    // touches anything the `text` override sees, and that unshifted token carries no
    // `tokens` of its own, so it takes the untouched library path.
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    const open = rendered.split("\n").filter((line) => line.includes("task open"));
    const done = rendered.split("\n").filter((line) => line.includes("task done"));
    expect(open).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect(open[0]).toContain("○ task open: bold and label (https://example.com/p)");
    expect(done[0]).toContain("✓ task done: bold and label (https://example.com/p)");
    // One state glyph, not two — the doubling failure mode this asserts against.
    expect((open[0]?.match(/○/g) ?? []).length).toBe(1);
    expect((done[0]?.match(/✓/g) ?? []).length).toBe(1);
  });

  test("an authored hard break still ends its line, and no bare carriage return survives", async () => {
    // Dispatching inline tokens makes `br` fire, and with `reflowText` on it emits
    // `HARD_RETURN` (`\r`) rather than a newline — a marker only the three reflowing
    // block renderers know how to consume. A list item is not one of them, so the `text`
    // override converts it itself. A `\r` reaching a terminal walks the cursor back to
    // column 0 and overwrites the line, which is why its absence is asserted directly.
    for (const width of [80, 100, 160]) {
      const rendered = stripAnsi(renderDocument(await witnessSource(), width));
      expect(rendered).toContain("this line ends in two spaces\n");
      expect(rendered).toMatch(/this line ends in two spaces\n\s+so this one must stay on a line of its own/);
      expect(rendered).not.toContain("\r");
    }
  });

  test("an authored soft break is still coalesced and re-wrapped at the item's budget (WP-2c is intact)", async () => {
    // The other half of the same seam: a soft break must be joined, a hard one must not.
    // At 160 the whole item fits on one line, which only happens if the join happened.
    const wide = stripAnsi(renderDocument(await witnessSource(), 160));
    expect(wide).toContain(
      "tight, authored soft break: this line was wrapped by its author and continues here, so the two must coalesce into one logical line",
    );
  });

  test("a fence nested in a list item is still verbatim -- the sentinel guard is not weakened", async () => {
    // `**not bold**` inside the fence proves the exemption is doing real work: it is the
    // exact markup the rest of this fixture asserts *is* parsed everywhere else.
    const rendered = stripAnsi(renderDocument(await witnessSource(), 100));
    expect(rendered).toContain('echo "**not bold**" > /home/example/out.md');
  });

  test("no rendered line exceeds the target width at any swept width", async () => {
    // Parsing changes rendered content, so the width gates are the real test of it: a
    // regression here would mean ANSI or resolved markup being measured wrongly.
    const source = await witnessSource();
    for (const width of [80, 100, 116, 160, 346]) {
      for (const line of stripAnsi(renderDocument(source, width)).split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("under real ANSI the item is styled like the paragraph, and the styling is not counted as width", async () => {
    // Under `bun test` chalk is level 0, so every assertion above is about resolved
    // *text*. This one renders in a subprocess with FORCE_COLOR=3 so `chalk.bold` and
    // `chalk.blue.underline` actually emit SGR codes, and checks the two things that
    // could only break with colour on: the item gets the same styling the paragraph
    // gets, and `measure` still reads the line's visible width.
    const source = [
      "Control **bold** and [label](https://example.com/p).",
      "",
      "- item **bold** and [label](https://example.com/p).",
      "",
    ].join("\n");
    const { text } = await renderWithForcedColor(source, 80);
    const lines = text.split("\n");
    const control = lines.find((line) => line.includes("Control")) ?? "";
    const item = lines.find((line) => line.includes("item")) ?? "";
    expect(stripAnsi(control)).toContain("Control bold and label (https://example.com/p).");
    expect(stripAnsi(item)).toContain("item bold and label (https://example.com/p).");
    // Bold open/close, present in the paragraph before this WP and in the item only after.
    for (const styled of [control, item]) {
      expect(styled).not.toBe(stripAnsi(styled));
      expect(styled).toContain("\u001b[1mbold\u001b[22m");
    }
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(80);
  });
});
