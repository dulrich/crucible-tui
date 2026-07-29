import { describe, expect, test } from "bun:test";
import { main, parseArgs } from "../src/cli";

describe("parseArgs", () => {
  test("recognizes --licenses without requiring a file", () => {
    expect(parseArgs(["--licenses"]).licenses).toBe(true);
  });
});

describe("main --licenses", () => {
  test("prints aggregated third-party notices and exits zero (resolves without throwing)", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main(["--licenses"]);
    } finally {
      process.stdout.write = original;
    }

    const output = chunks.join("");
    expect(output).toContain("Third-party licenses for mdview");
    // marked's dual grant must survive verbatim, not be summarized away.
    expect(output).toContain("marked@14.1.4");
    expect(output).toContain("NOASSERTION");
    expect(output).toContain("John Gruber's original Markdown");
    // highlight.js's BSD-3 notice and disclaimer must survive verbatim.
    expect(output).toContain("highlight.js@10.7.3");
    expect(output).toContain("BSD-3-Clause");
    expect(output).toContain("Redistributions in binary form must reproduce");
  });

  test("--licenses takes no file argument (falls through before the view path demands one)", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await expect(main(["--licenses"])).resolves.toBeUndefined();
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).not.toContain("missing required argument");
  });

  test("mdview FILE.md still renders — --licenses does not disturb the default view path", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main([`${import.meta.dir}/fixtures/simple.md`, "--no-pager"]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("Simple fixture");
  });
});
