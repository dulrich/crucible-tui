import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { stripAnsi } from "../src/list-lines";
import { formatMetaBlock, formatMetaBlockDetailed, splitFrontmatter } from "../src/frontmatter";
import { renderDocumentDetailed } from "../src/render";

describe("splitFrontmatter", () => {
  test("frontmatter at byte 0 parses; meta populated, body excludes the block", () => {
    const source = "---\ntitle: Example\nmodified: 2026-07-06\n---\n\n# Body\n\ntext\n";
    const { meta, body } = splitFrontmatter(source);
    expect(meta).toBe("title: Example\nmodified: 2026-07-06");
    expect(body).toBe("\n# Body\n\ntext\n");
  });

  test("a document opening with a `---` thematic break is NOT treated as frontmatter", () => {
    // First line is a thematic break, not YAML: no key/value line follows it before
    // the next `---`. A naive byte-0-open/first-close splitter (glow's bug) would
    // slice this document's head off.
    const source = "---\n\n# Heading\n\nSome prose here.\n\n---\n\nMore prose after the second break.\n";
    const { meta, body } = splitFrontmatter(source);
    expect(meta).toBeNull();
    expect(body).toBe(source);
  });

  test("no frontmatter at all -> meta: null, body identical to source", () => {
    const source = "# Just a heading\n\nSome text.\n";
    const { meta, body } = splitFrontmatter(source);
    expect(meta).toBeNull();
    expect(body).toBe(source);
  });

  test("an unclosed frontmatter-looking block falls back to meta: null with body intact", () => {
    const source = "---\ntitle: Example\n\n# Heading\n\ntext\n";
    const { meta, body } = splitFrontmatter(source);
    expect(meta).toBeNull();
    expect(body).toBe(source);
  });
});

describe("formatMetaBlock", () => {
  test("pending-plans: [] renders as em dash", () => {
    const meta = "title: Example\npending-plans: []\n";
    const out = formatMetaBlock(meta, 80);
    expect(out).toContain("—");
    expect(out).not.toMatch(/pending-plans:\s*$/m);
  });

  // The root INITIATIVE.md writes `tags: ""` rather than `tags: []`; rendering that as
  // blank made the metadata block look broken. Found by inspecting real output in WP-4.
  test('an empty string value (tags: "") renders as em dash, not blank', () => {
    const out = formatMetaBlock('title: Example\ntags: ""\n', 80);
    expect(out).toContain("—");
    expect(out).not.toMatch(/tags\s*:\s*$/m);
  });

  test("a created: 2026-07-06 date renders as 2026-07-06, not a full Date string", () => {
    const meta = "created: 2026-07-06\n";
    const out = formatMetaBlock(meta, 80);
    expect(out).toContain("2026-07-06");
    expect(out).not.toContain("GMT");
    expect(out).not.toContain("00:00:00");
  });

  test("a datetime value trims to the date-only component", () => {
    const meta = "modified: 2026-07-26T14:30:00Z\n";
    const out = formatMetaBlock(meta, 80);
    expect(out).toContain("2026-07-26");
    expect(out).not.toContain("14:30");
  });

  test("malformed YAML degrades gracefully instead of throwing", () => {
    const meta = "title: [unterminated\n";
    expect(() => formatMetaBlock(meta, 80)).not.toThrow();
    const out = formatMetaBlock(meta, 80);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("title: [unterminated");
  });

  test("a non-mapping YAML block (scalar) renders raw instead of throwing", () => {
    const meta = "just a plain scalar string\n";
    expect(() => formatMetaBlock(meta, 80)).not.toThrow();
  });

  for (const width of [80, 40]) {
    test(`output respects targetWidth at ${width}`, () => {
      const meta = [
        "title: A moderately long initiative title used to exercise wrapping",
        "tags:",
        "  - fixture",
        "  - mdview",
        "  - a-somewhat-long-tag-value-to-force-wrap-behavior",
        "pending-plans: []",
        "initiative-status: active",
      ].join("\n");
      const out = formatMetaBlock(meta, width);
      for (const line of out.split("\n")) {
        expect(stringWidth(line)).toBeLessThanOrEqual(width);
      }
    });
  }

  // Regression guard. An earlier revision parsed with `{ schema: "yaml-1.1" }` to get
  // `Date` objects for the date-trimming requirement. That schema also revives YAML 1.1's
  // scalar coercions: `no`/`yes`/`off` become booleans (the "Norway problem") and `12:30`
  // becomes the sexagesimal number 750. A viewer must render what the file says, so the
  // default YAML 1.2 schema is required and dates are trimmed as strings instead.
  test("does not coerce YAML 1.1 scalars — shows what the file says", () => {
    const meta = ["tags: no", "active: yes", "toggle: off", "ratio: 12:30"].join("\n");
    const out = formatMetaBlock(meta, 80);
    expect(out).toContain("no");
    expect(out).toContain("yes");
    expect(out).toContain("off");
    expect(out).toContain("12:30");
    expect(out).not.toContain("false");
    expect(out).not.toContain("true");
    expect(out).not.toContain("750");
  });

  test("trims a full timestamp to YYYY-MM-DD and leaves a date-only value alone", () => {
    const out = formatMetaBlock(["created: 2026-07-06", "modified: 2026-07-06T12:30:00Z"].join("\n"), 80);
    expect(out).toContain("2026-07-06");
    expect(out).not.toContain("12:30:00");
  });

  // `yaml` reports recoverable oddities via `process.emitWarning`, not a return value, so
  // Node's default handler prints a stack trace to stderr that no try/catch can intercept.
  // Obsidian templates (`created: {{today}}`) hit this: the placeholder parses as a flow
  // mapping used as a key. Found only by the FULL vault sweep — the 300-file sample missed
  // all four template files. Asserting on the hook rather than on stderr because
  // `emitWarning` is async and would otherwise land after the test ends.
  test("parses without emitting a process warning on Obsidian template placeholders", () => {
    const warnings: string[] = [];
    const original = process.emitWarning;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).emitWarning = (w: unknown) => void warnings.push(String(w));
    try {
      const out = formatMetaBlock(['title: "{{date}}"', "created: {{today}}", "tags:", "  - daily"].join("\n"), 80);
      expect(out).toContain("today");
    } finally {
      process.emitWarning = original;
    }
    expect(warnings).toEqual([]);
  });

});

// ---------------------------------------------------------------------------
// The four frontmatter width defects, each with the test that would have caught it.
// Before this block there was no test that failed if any of this behaviour changed,
// which is the reason all four survived a full corpus sweep.
// ---------------------------------------------------------------------------

// Authored the way a Windows editor writes it. Inline rather than a `tests/fixtures`
// file on purpose: a checked-in CRLF fixture is one `core.autocrlf` setting or one
// editor "fix line endings" away from silently becoming an LF file, at which point the
// regression guard would pass while guarding nothing.
const CRLF_SOURCE = [
  "---",
  "name: example-skill",
  'description: "Validation for deployment readiness. Runs deep checks."',
  "license: MIT",
  "metadata:",
  "  author: Example",
  '  version: "1.2.1"',
  "---",
  "",
  "# Body",
  "",
].join("\r\n");

describe("defect 0 — CRLF frontmatter reaches the parser as bytes that parse", () => {
  test("splitFrontmatter normalizes the meta block's line endings and leaves the body alone", () => {
    const { meta, body } = splitFrontmatter(CRLF_SOURCE);
    expect(meta).not.toBeNull();
    expect(meta).not.toContain("\r");
    expect(meta).toBe(
      [
        "name: example-skill",
        'description: "Validation for deployment readiness. Runs deep checks."',
        "license: MIT",
        "metadata:",
        "  author: Example",
        '  version: "1.2.1"',
      ].join("\n"),
    );
    // The body is handed on byte-for-byte; `marked` normalizes line endings itself.
    expect(body).toBe("\r\n# Body\r\n");
  });

  test("valid CRLF frontmatter renders a meta block, not a raw echo", () => {
    const { meta } = splitFrontmatter(CRLF_SOURCE);
    const result = formatMetaBlockDetailed(meta as string, 100);
    const plain = stripAnsi(result.text);

    // The whole failure this fixes: valid YAML reported as unparseable and dumped raw.
    expect(plain).not.toContain("could not parse");
    // The raw echo would carry the source's own quoting; the meta block does not.
    expect(plain).not.toContain('description: "Validation');
    expect(plain).toMatch(/^name\s+: example-skill$/m);
    expect(plain).toMatch(/^ {2}version\s*: 1\.2\.1$/m);
    // A parsed block is our layout, so it is *not* exempt and must fit.
    expect(result.verbatimRanges).toEqual([]);
    for (const line of plain.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(100);
  });
});

// `{a: b} c` is a compact mapping followed by a scalar — a real, deterministic `yaml`
// error ("Nested mappings are not allowed in compact mappings") that carries the
// summary/excerpt/caret shape the diagnostic has to handle.
const BROKEN_META = [
  "name: example-skill",
  `description: ${"a long description that has to be folded somewhere ".repeat(6)}{a: b} c`,
  "author: Example",
].join("\n");

describe("defect 1 — the parse diagnostic wraps, the excerpt and caret do not", () => {
  test("our leading message is wrapped to the target; the excerpt/caret block is left verbatim", () => {
    for (const width of [80, 40]) {
      const lines = stripAnsi(formatMetaBlockDetailed(BROKEN_META, width).text).split("\n");
      const blank = lines.indexOf("");
      expect(blank).toBeGreaterThan(0);
      // Everything above the blank line is the message we prefixed, and all of it fits.
      for (const line of lines.slice(0, blank)) expect(stringWidth(line)).toBeLessThanOrEqual(width);
      // The location is never dropped — the whole reason a parse diagnostic exists.
      expect(lines.slice(0, blank).join(" ")).toContain("at line 2, column");
    }
  });

  test("the caret keeps its column at every target — proof the excerpt is not re-folded", () => {
    const caretColumn = (width: number): number => {
      const lines = stripAnsi(formatMetaBlockDetailed(BROKEN_META, width).text).split("\n");
      const caret = lines.find((line) => line.trim() === "^");
      expect(caret).toBeDefined();
      return (caret as string).indexOf("^");
    };
    // `yaml` folds its own excerpt to 80 characters and ellipsizes it, so the caret is
    // positioned against *that* excerpt, not against our target width. Re-folding it
    // here would slide the caret off the column it points at.
    expect(caretColumn(40)).toBe(caretColumn(80));
    expect(caretColumn(160)).toBe(caretColumn(80));
  });

  // A documented limitation, pinned so it is a measurement rather than an assumption.
  // `yaml` folds its excerpt to 80 *characters*; with CJK content that is up to 160
  // columns. Measured: zero of the 24 unparseable frontmatter blocks on disk hit this
  // at any swept target, so it is left alone rather than folded — the excerpt is not
  // exempt, so a file that does hit it turns the gate red instead of shipping an
  // over-width line silently. If this test fails, that case has arrived.
  test("a CJK excerpt can exceed the target — the excerpt is left un-exempt so the gate says so", () => {
    const cjkMeta = `title: ${"漢".repeat(120)} {a: b} c\nother: 1`;
    const result = formatMetaBlockDetailed(cjkMeta, 80);
    const lines = stripAnsi(result.text).split("\n");
    const [start] = result.verbatimRanges[0] as [number, number];
    const diagnostic = lines.slice(0, start - 1);
    expect(diagnostic.some((line) => stringWidth(line) > 80)).toBe(true);
    // Not swept under the exemption: the exempt range starts at the echo, not earlier.
    expect(start).toBe(diagnostic.length + 1);
  });
});

describe("defect 2 — only the verbatim echo is exempt from the width check", () => {
  test("the exempt range is exactly the echoed block, and it is the file's own bytes", () => {
    const result = formatMetaBlockDetailed(BROKEN_META, 80);
    const lines = stripAnsi(result.text).split("\n");
    expect(result.verbatimRanges).toHaveLength(1);
    const [start, end] = result.verbatimRanges[0] as [number, number];
    expect(end).toBe(lines.length);
    expect(lines.slice(start - 1, end).join("\n")).toBe(BROKEN_META.trimEnd());
    // Nothing above the echo is exempt, and nothing above it overflows either.
    for (const line of lines.slice(0, start - 1)) expect(stringWidth(line)).toBeLessThanOrEqual(80);
  });

  test("renderDocumentDetailed hands the echo's line range to the width check as a code range", () => {
    const source = `---\n${BROKEN_META}\n---\n\n# Body\n`;
    const { text, codeRanges } = renderDocumentDetailed(source, 80);
    const overWide = text
      .split("\n")
      .map((line, index): [number, number] => [index + 1, stringWidth(line)])
      .filter(([, width]) => width > 80);
    expect(overWide.length).toBeGreaterThan(0);
    for (const [lineNumber] of overWide) {
      expect(codeRanges.some(([rangeStart, rangeEnd]) => lineNumber >= rangeStart && lineNumber <= rangeEnd)).toBe(true);
    }
  });

  // The scoping test. Exempting all of `formatMetaBlock`'s output would blind the gate
  // to the path that currently works and is likeliest to regress, so this asserts the
  // success path is still measured. A key longer than the key budget is emitted
  // untruncated — pre-existing behaviour, used here purely as a reproducible way to
  // make a *parsed* block exceed the target.
  test("a successfully parsed, over-width meta block is still caught", () => {
    const meta = `${"k".repeat(200)}: value`;
    const result = formatMetaBlockDetailed(meta, 80);
    expect(result.verbatimRanges).toEqual([]);
    expect(Math.max(...stripAnsi(result.text).split("\n").map((line) => stringWidth(line)))).toBeGreaterThan(80);

    const { text, codeRanges } = renderDocumentDetailed(`---\n${meta}\n---\n\n# Body\n`, 80);
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
  });
});

describe("defect 3 — a nested mapping at depth >= 1 respects targetWidth", () => {
  const NESTED_META = [
    "name: example-skill",
    "metadata:",
    "  priority: 6",
    "  promptSignals:",
    "    phrases:",
    ...["agentic harness", "agent harness", "harness architecture", "agent architecture", "tool registry"].map(
      (phrase) => `      - ${phrase}`,
    ),
    "    weights:",
    "      high: 3",
    "      low: 1",
  ].join("\n");

  for (const width of [80, 40]) {
    test(`the JSON.stringify'd subtree wraps at ${width}`, () => {
      const result = formatMetaBlockDetailed(NESTED_META, width);
      expect(result.verbatimRanges).toEqual([]);
      const plain = stripAnsi(result.text);
      // Still stringified rather than recursed — the fix is that it wraps, not that
      // the depth rule changed.
      expect(plain).toContain('{"phrases":');
      for (const line of plain.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    });
  }
});

/**
 * The metadata block's dim, under the one colour decision (WP-1 of
 * `plans/colour-policy.md`).
 *
 * **This module dimmed unconditionally for its whole life, and that is the behaviour these
 * cases replace.** Every key, every parse diagnostic and every raw echo went out wrapped in
 * `2m`/`22m` at every colour level, including `mdview file.md > out.txt` — which is why the
 * colour axis's colourless side carried SGR on every frontmatter-bearing fixture, and why
 * the ratified "default non-TTY stdout emits zero tool-generated escape bytes" could not
 * hold on any document that has frontmatter at all. The bytes are unchanged; whether they
 * are emitted is now something this module is told rather than something it decides.
 */
describe("the metadata block emits its dim only when the colour decision says so", () => {
  const ESC = "\u001b";
  const META = "title: Example\ncreated: 2026-07-06\n";

  test("colour on emits the same dim pair it always did", () => {
    const out = formatMetaBlock(META, 80, undefined, true);
    expect(out).toContain(`${ESC}[2mtitle  ${ESC}[22m: Example`);
  });

  test("colour off emits no escape at all, and the same visible text", () => {
    const off = formatMetaBlock(META, 80, undefined, false);
    expect(off).not.toContain(ESC);
    expect(stripAnsi(formatMetaBlock(META, 80, undefined, true))).toBe(off);
  });

  test("the default is off — an unstated destination gets no escapes", () => {
    // The direction is deliberate and is the opposite of the historical behaviour: a caller
    // that has not thought about colour has not established that its destination can take
    // escape sequences.
    expect(formatMetaBlock(META, 80)).not.toContain(ESC);
  });

  test("the em dash for an empty mapping is dimmed on the same decision", () => {
    expect(formatMetaBlock("", 80, undefined, true)).toContain(`${ESC}[2m`);
    expect(formatMetaBlock("", 80, undefined, false)).not.toContain(ESC);
  });

  test("the degraded paths obey it too — diagnostic and raw echo alike", () => {
    // A block that parses to a non-mapping takes the echo path; an unparseable one takes the
    // diagnostic-plus-echo path. Both used to dim unconditionally.
    const notAMapping = "just: a\n- list\n";
    const unparseable = "title: [unterminated\n";
    for (const meta of [notAMapping, unparseable]) {
      expect(formatMetaBlockDetailed(meta, 80, undefined, false).text).not.toContain(ESC);
      expect(formatMetaBlockDetailed(meta, 80, undefined, true).text).toContain(`${ESC}[2m`);
    }
  });

  test("the verbatim ranges do not move with the colour decision", () => {
    // The ranges are line spans over the same text; a decision about escapes must not change
    // which lines `--check` exempts.
    const unparseable = "title: [unterminated\n";
    expect(formatMetaBlockDetailed(unparseable, 80, undefined, true).verbatimRanges).toEqual(
      formatMetaBlockDetailed(unparseable, 80, undefined, false).verbatimRanges,
    );
  });
});
