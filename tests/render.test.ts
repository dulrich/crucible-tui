import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, mock, test } from "bun:test";
import stringWidth from "string-width";
import type { Tokens } from "marked";

const TABLE_MODULE_PATH = `${import.meta.dir}/../src/table.ts`;

if (!existsSync(TABLE_MODULE_PATH)) {
  // WP-3 (`src/table.ts`) has not landed in this worktree yet. Stub it here, in this
  // test file only, per the WP-2 brief: never in `src/`. This stub only needs to let
  // renderDocument's own plumbing (frontmatter, wiki-links, task states, prose) run
  // end to end; the allocator's own correctness is WP-3's test file's job, not this
  // one's.
  mock.module("../src/table", () => ({
    renderTable: (token: Tokens.Table, targetWidth: number): string => {
      const cellText = (cell: Tokens.TableCell): string => cell.text;
      const rows = [token.header, ...token.rows];
      const width = Math.max(0, targetWidth);
      return rows.map((row) => row.map(cellText).join(" | ").slice(0, width)).join("\n");
    },
  }));
}

const { renderDocument } = await import("../src/render");

// Deliberately matching the ESC control character to strip ANSI SGR codes so
// assertions can check plain rendered text.
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderDocument — wiki-links", () => {
  test("[[slug]] renders the slug, styled", () => {
    const output = renderDocument("See [[mdview]] for details.\n", 80);
    expect(stripAnsi(output)).toContain("mdview");
    expect(output).not.toContain("[[mdview]]");
  });

  test("[[slug|alias]] renders the alias, not the slug", () => {
    const output = renderDocument("See [[mdview|the viewer]] for details.\n", 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("the viewer");
    expect(plain).not.toContain("mdview");
  });

  test("[[slug#heading]] renders the slug (no alias given)", () => {
    const output = renderDocument("See [[mdview#Run]] for details.\n", 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("mdview");
    expect(plain).not.toContain("#Run");
  });

  test("a wiki-link inside a fenced code block is left alone", () => {
    const source = "```\nSee [[mdview]] for details.\n```\n";
    const output = renderDocument(source, 80);
    expect(output).toContain("[[mdview]]");
  });
});

describe("renderDocument — Obsidian task states", () => {
  test("task states render as glyphs, not literal bracket markers", () => {
    const source = "- [x] done thing\n- [ ] todo thing\n- [/] in progress thing\n";
    const output = renderDocument(source, 80);
    const plain = stripAnsi(output);
    expect(plain).not.toContain("[x]");
    expect(plain).not.toContain("[ ]");
    expect(plain).not.toContain("[/]");
    expect(plain).toContain("✓");
    expect(plain).toContain("○");
    expect(plain).toContain("◐");
  });

  test("a task-state-looking line inside a fence is untouched", () => {
    const source = "```\n- [x] literal, not a real task\n```\n";
    const output = renderDocument(source, 80);
    expect(output).toContain("[x]");
  });
});

describe("renderDocument — width and prose coverage", () => {
  test("no line exceeds the target width for tests/fixtures/simple.md", async () => {
    const source = await readFile(`${import.meta.dir}/fixtures/simple.md`, "utf8");
    const output = renderDocument(source, 80);
    for (const line of output.split("\n")) {
      expect(stringWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  test("headings, bold/italic, lists, blockquotes, and a fenced code block all render non-empty", () => {
    const source = [
      "# Heading one",
      "",
      "Some **bold** and some *italic* text.",
      "",
      "- item one",
      "- item two",
      "",
      "> a quoted blockquote",
      "",
      "```bash",
      "echo hello",
      "```",
      "",
    ].join("\n");

    const output = renderDocument(source, 80);
    expect(output.length).toBeGreaterThan(0);

    const plain = stripAnsi(output);
    expect(plain).toContain("Heading one");
    expect(plain).toContain("bold");
    expect(plain).toContain("italic");
    expect(plain).toContain("item one");
    expect(plain).toContain("item two");
    expect(plain).toContain("quoted blockquote");
    expect(plain).toContain("echo hello");
  });
});

describe("renderDocument — frontmatter integration", () => {
  test("renders the metadata block ahead of the body when frontmatter is present", () => {
    const source = "---\ntitle: Example\npending-plans: []\n---\n\n# Body\n";
    const output = renderDocument(source, 80);
    const plain = stripAnsi(output);
    expect(plain).toContain("title");
    expect(plain).toContain("Example");
    expect(plain).toContain("—");
    expect(plain.indexOf("Example")).toBeLessThan(plain.indexOf("Body"));
  });

  test("a document with no frontmatter renders only the body", () => {
    const output = renderDocument("# Just a body\n", 80);
    expect(stripAnsi(output)).toContain("Just a body");
  });
});
