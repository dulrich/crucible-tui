import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { findFirstOverflow } from "../src/overflow";
import { stripAnsi } from "../src/list-lines";
import { formatMetaBlockDetailed, splitFrontmatter } from "../src/frontmatter";
import { renderDocumentDetailed } from "../src/render";

// ---------------------------------------------------------------------------
// WP-10 (plans/representative-corpus.md, "# Revision" section): a witness harness
// for the four frontmatter defects WP-5 (commit 6ba370b) fixed.
//
// tests/frontmatter.test.ts already carries WP-5's own pinning tests, built from
// inline synthetic strings. This file is the *witness* layer on top of them: each
// describe block below is anchored to a real fixture file under
// tests/fixtures/witnesses/, and tests/fixtures/witnesses/witness-index.json records
// which fixture proves which fix and how the fix was reverted to prove it. See that
// file's header comment and README.md for the shape.
//
// A witness is a fixture *plus* a test that fails if its fix is reverted. Passing
// both before and after the fix is the failure mode this file exists to avoid —
// see witness-index.json's "defect-2-success-path-boundary" and
// "cjk-excerpt-synthetic" entries for the two witnesses here that do NOT
// differentiate the pre-fix commit, and why that is stated rather than glossed over.
// ---------------------------------------------------------------------------

const fixture = (name: string): string => readFileSync(`${import.meta.dir}/fixtures/witnesses/${name}`, "utf8");

describe("witness: defect 0 -- CRLF frontmatter (tests/fixtures/witnesses/defect-0-crlf-frontmatter.md)", () => {
  const source = fixture("defect-0-crlf-frontmatter.md");

  test("the fixture is genuinely CRLF on disk -- the point of the witness depends on this", () => {
    expect(source).toContain("\r\n");
  });

  test("splitFrontmatter normalizes the meta candidate's line endings and leaves the body untouched", () => {
    const { meta, body } = splitFrontmatter(source);
    expect(meta).not.toBeNull();
    expect(meta).not.toContain("\r");
    // Body is handed on byte-for-byte -- CRLF and all -- per the fix's own contract.
    expect(body).toContain("\r\n");
    expect(body.includes("\r") && !body.includes("\r\n")).toBe(false);
  });

  test("renders a meta block, not a raw echo, and every line fits the target width", () => {
    const { meta } = splitFrontmatter(source);
    const result = formatMetaBlockDetailed(meta as string, 100);
    const plain = stripAnsi(result.text);
    expect(plain).not.toContain("could not parse");
    expect(result.verbatimRanges).toEqual([]);
    expect(plain).toMatch(/^name\s*: witness-skill$/m);
    expect(plain).toMatch(/^ {2}version\s*: 1\.2\.1$/m);
    for (const line of plain.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });
});

describe("witness: defect 1 -- diagnostic wraps, excerpt/caret do not (tests/fixtures/witnesses/defect-1-2-unparseable-frontmatter.md)", () => {
  const source = fixture("defect-1-2-unparseable-frontmatter.md");
  const { meta } = splitFrontmatter(source);

  test("the fixture is a real, deterministic yaml parse error", () => {
    const result = formatMetaBlockDetailed(meta as string, 80);
    const flat = stripAnsi(result.text).replace(/\n/g, " ");
    expect(flat).toContain("could not parse frontmatter");
    expect(flat).toContain("Nested mappings are not allowed in compact mappings");
  });

  test("our leading message wraps to the target at every width; the excerpt/caret block does not", () => {
    for (const width of [40, 80]) {
      const lines = stripAnsi(formatMetaBlockDetailed(meta as string, width).text).split("\n");
      const blank = lines.indexOf("");
      expect(blank).toBeGreaterThan(0);
      for (const line of lines.slice(0, blank)) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      expect(lines.slice(0, blank).join(" ")).toContain("at line 2, column");
    }
  });

  test("the caret keeps its column at every target -- proof the excerpt is not re-folded", () => {
    const caretColumn = (width: number): number => {
      const lines = stripAnsi(formatMetaBlockDetailed(meta as string, width).text).split("\n");
      const caret = lines.find((line) => line.trim() === "^");
      expect(caret).toBeDefined();
      return (caret as string).indexOf("^");
    };
    expect(caretColumn(40)).toBe(caretColumn(80));
    expect(caretColumn(160)).toBe(caretColumn(80));
  });
});

describe("witness: defect 2 -- only the verbatim echo is exempt (tests/fixtures/witnesses/defect-1-2-unparseable-frontmatter.md)", () => {
  const source = fixture("defect-1-2-unparseable-frontmatter.md");
  const { meta } = splitFrontmatter(source);

  test("the exempt range is exactly the echoed block, and it is the file's own bytes", () => {
    const result = formatMetaBlockDetailed(meta as string, 80);
    const lines = stripAnsi(result.text).split("\n");
    expect(result.verbatimRanges).toHaveLength(1);
    const [start, end] = result.verbatimRanges[0] as [number, number];
    expect(end).toBe(lines.length);
    expect(lines.slice(start - 1, end).join("\n")).toBe((meta as string).trimEnd());
    // Nothing above the echo is exempt, and nothing above it overflows either -- this
    // fixture's diagnostic is plain ASCII, so it fits 80 even before any exemption.
    for (const line of lines.slice(0, start - 1)) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("renderDocumentDetailed hands the echo's line range to the width check as an exempt code range", () => {
    const { text, codeRanges } = renderDocumentDetailed(source, 80);
    const overWide = text
      .split("\n")
      .map((line, index): [number, number] => [index + 1, stringWidth(line)])
      .filter(([, width]) => width > 80);
    // The echoed line (the raw source, ~350 columns) does overflow -- that is expected,
    // it is the file's own bytes -- but it must be covered by an exempt range.
    expect(overWide.length).toBeGreaterThan(0);
    for (const [lineNumber] of overWide) {
      expect(codeRanges.some(([rangeStart, rangeEnd]) => lineNumber >= rangeStart && lineNumber <= rangeEnd)).toBe(
        true,
      );
    }
    // The same check `--check` and the sweep actually run — literally, since WP-2: both
    // call `src/overflow.ts`'s `findFirstOverflow`, which is now the only implementation
    // of it. With the exempt ranges honoured, this document reports no overflow at all.
    expect(findFirstOverflow(text, 80, codeRanges)).toBeNull();
  });
});

describe("witness: defect 2 -- a successfully parsed, over-width block is still caught (tests/fixtures/witnesses/defect-2-success-path-overwide.md)", () => {
  // This is the load-bearing scope check, per the brief: exempting the whole
  // formatMetaBlock output (rather than just the echoed block) would blind the gate to
  // the one path that actually works. See witness-index.json's
  // "defect-2-success-path-boundary" record: it is NOT revert-differentiating against
  // the pre-fix commit (before WP-5, nothing was ever exempted, so this block was
  // already caught) -- it guards the fix from being *widened* incorrectly later, and is
  // included here as a real fixture rather than only WP-5's inline pinning test.
  const source = fixture("defect-2-success-path-overwide.md");
  const { meta } = splitFrontmatter(source);

  test("the block parses cleanly and is over width purely because of a long key", () => {
    const result = formatMetaBlockDetailed(meta as string, 80);
    expect(result.verbatimRanges).toEqual([]);
    expect(Math.max(...stripAnsi(result.text).split("\n").map((line) => stringWidth(line)))).toBeGreaterThan(80);
  });

  test("renderDocumentDetailed still flags it as overflow -- no exempt range covers it", () => {
    const { text, codeRanges } = renderDocumentDetailed(source, 80);
    const overWide = text
      .split("\n")
      .map((line, index): [number, number] => [index + 1, stringWidth(line)])
      .filter(([, width]) => width > 80);
    expect(overWide.length).toBeGreaterThan(0);
    for (const [lineNumber] of overWide) {
      expect(codeRanges.some(([rangeStart, rangeEnd]) => lineNumber >= rangeStart && lineNumber <= rangeEnd)).toBe(
        false,
      );
    }
    expect(findFirstOverflow(text, 80, codeRanges)).not.toBeNull();
  });
});

describe("witness: defect 3 -- nested mapping respects targetWidth (tests/fixtures/witnesses/defect-3-nested-mapping.md)", () => {
  const source = fixture("defect-3-nested-mapping.md");
  const { meta } = splitFrontmatter(source);

  for (const width of [40, 80]) {
    test(`the JSON.stringify'd subtree wraps at ${width}`, () => {
      const result = formatMetaBlockDetailed(meta as string, width);
      expect(result.verbatimRanges).toEqual([]);
      const plain = stripAnsi(result.text);
      // Still stringified, not recursed further -- the fix is that it wraps, not that
      // the depth rule changed.
      expect(plain).toContain('{"phrases":');
      for (const line of plain.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    });
  }

  test("renderDocumentDetailed of the whole fixture has no overflow at 80", () => {
    const { text, codeRanges } = renderDocumentDetailed(source, 80);
    expect(findFirstOverflow(text, 80, codeRanges)).toBeNull();
  });
});

describe("witness: synthetic CJK excerpt -- un-exempt by design (tests/fixtures/witnesses/defect-cjk-excerpt.md)", () => {
  // Synthetic: WP-10 built this fixture (no real corpus file drives it, per the plan's
  // revision text). There is no fix to revert here -- see witness-index.json's
  // "cjk-excerpt-synthetic" record -- this pins the documented, intentional gap: yaml
  // folds its own parse-error excerpt to 80 *characters*, not columns, and a CJK title
  // exceeds the target in columns while staying inside that character budget.
  const source = fixture("defect-cjk-excerpt.md");
  const { meta } = splitFrontmatter(source);

  test("the excerpt reaches 152 columns at target 80 -- the measured shape from the plan", () => {
    const result = formatMetaBlockDetailed(meta as string, 80);
    const lines = stripAnsi(result.text).split("\n");
    const [start] = result.verbatimRanges[0] as [number, number];
    const diagnostic = lines.slice(0, start - 1);
    const widths = diagnostic.map((line) => stringWidth(line));
    expect(Math.max(...widths)).toBe(152);
    // Not swept under the exemption: the exempt range starts at the echo, not earlier.
    expect(start).toBe(diagnostic.length + 1);
  });

  test("the gate still catches it: the over-width excerpt line is not covered by any exempt range", () => {
    const { text, codeRanges } = renderDocumentDetailed(source, 80);
    const overflow = findFirstOverflow(text, 80, codeRanges);
    expect(overflow).not.toBeNull();
    // The echo itself is exempt (defect 2) and would not be reported here at all --
    // the line that overflows is the diagnostic excerpt above it.
    expect((overflow as { width: number }).width).toBeGreaterThan(80);
  });
});
