import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { formatMetaBlock, splitFrontmatter } from "../src/frontmatter";

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
