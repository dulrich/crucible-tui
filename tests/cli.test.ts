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
      probe: false,
      color: undefined,
    });
  });

  /**
   * `--color`, the highest slot in the colour precedence table (`src/colour.ts`).
   *
   * **mdview's own flag is the only argv authority now, and that is the user-visible half
   * of WP-1 of `plans/colour-policy.md`.** Until this package `supports-color` scanned the
   * whole of `process.argv` through `has-flag`, so `--color`, `--no-color` and
   * `--color=256` all changed rendered output without this parser ever seeing them — and a
   * `--color` aimed at the `bun` wrapper worked just as well as one aimed at mdview.
   */
  describe("--color", () => {
    test("bare --color means always: a user who typed it is asking for colour", () => {
      expect(parseArgs(["doc.md", "--color"]).color).toBe("always");
    });

    test("each explicit value parses as itself", () => {
      expect(parseArgs(["doc.md", "--color=auto"]).color).toBe("auto");
      expect(parseArgs(["doc.md", "--color=always"]).color).toBe("always");
      expect(parseArgs(["doc.md", "--color=never"]).color).toBe("never");
    });

    test("repeated, the last one wins — in both directions", () => {
      expect(parseArgs(["doc.md", "--color=never", "--color"]).color).toBe("always");
      expect(parseArgs(["doc.md", "--color=always", "--color=never"]).color).toBe("never");
    });

    test("an unrecognised value is a CLI error naming the three it accepts", () => {
      // Deliberately unlike `MDVIEW_COLOR=sometimes`, which is noted and ignored: a typo on
      // the command line is being made right now and can be corrected right now, where a
      // typo in an exported variable would otherwise refuse every document for the rest of
      // that shell's life.
      expect(() => parseArgs(["doc.md", "--color=sometimes"])).toThrow(/--color must be auto, always or never/);
      expect(() => parseArgs(["doc.md", "--color="])).toThrow(/--color must be/);
    });

    test("the value is never taken from the next argument, so the file is still the file", () => {
      // `--color never doc.md` cannot mean what it looks like: the flag has to work with no
      // value at all, so a following word is a positional argument, not this flag's value.
      expect(() => parseArgs(["doc.md", "--color", "never"])).toThrow(/unexpected extra argument: never/);
      const options = parseArgs(["--color", "doc.md"]);
      expect(options.color).toBe("always");
      expect(options.file).toBe("doc.md");
    });

    test("--no-color is not a spelling this tool accepts", () => {
      // It was one of the four argv spellings the retired library sniffed for. The ratified
      // surface is `--color=never`, and an unknown flag is an error rather than a silent
      // no-op that leaves the user believing colour is off.
      expect(() => parseArgs(["doc.md", "--no-color"])).toThrow(/unknown argument: --no-color/);
    });

    test("absent means absent — not 'auto' typed by the user", () => {
      expect(parseArgs(["doc.md"]).color).toBeUndefined();
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
