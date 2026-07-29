import { describe, expect, test } from "bun:test";
import { main, parseArgs, resolveWidth } from "../src/cli";

const fixture = (name: string): string => `${import.meta.dir}/fixtures/${name}`;

describe("resolveWidth", () => {
  test("explicit width wins over columns and fallback", () => {
    expect(resolveWidth(72, 200)).toBe(72);
  });

  test("terminal columns win over the fallback when width is not explicit", () => {
    expect(resolveWidth(undefined, 132)).toBe(132);
  });

  test("falls back to 100 when neither explicit width nor columns are available", () => {
    expect(resolveWidth(undefined, undefined)).toBe(100);
  });

  test("ignores a non-positive column count and falls back", () => {
    expect(resolveWidth(undefined, 0)).toBe(100);
  });
});

describe("parseArgs", () => {
  test("parses the positional file and defaults", () => {
    const options = parseArgs(["doc.md"]);
    expect(options).toEqual({
      file: "doc.md",
      width: undefined,
      noPager: false,
      check: false,
      help: false,
      licenses: false,
    });
  });

  test("recognizes --width", () => {
    expect(parseArgs(["doc.md", "--width", "80"]).width).toBe(80);
  });

  test("recognizes --no-pager", () => {
    expect(parseArgs(["doc.md", "--no-pager"]).noPager).toBe(true);
  });

  test("recognizes --check", () => {
    expect(parseArgs(["doc.md", "--check"]).check).toBe(true);
  });

  test("recognizes --help and -h without requiring a file", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("rejects an unknown flag with a clear error", () => {
    expect(() => parseArgs(["doc.md", "--bogus"])).toThrow("unknown argument: --bogus");
  });

  test("rejects a missing positional file", () => {
    expect(() => parseArgs(["--width", "80"])).toThrow("missing required argument");
  });

  test("rejects --width with no value", () => {
    expect(() => parseArgs(["doc.md", "--width"])).toThrow("missing value for --width");
  });
});

describe("main", () => {
  test("--help prints usage and exits zero (resolves without throwing)", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main(["--help"]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("usage: mdview");
  });

  test("renders fixtures/simple.md with --no-pager without throwing", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main([fixture("simple.md"), "--no-pager"]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("Simple fixture");
  });

  test("a missing file path throws a readable error", async () => {
    await expect(main([fixture("does-not-exist.md"), "--no-pager"])).rejects.toThrow(
      "cannot read file",
    );
  });
});
