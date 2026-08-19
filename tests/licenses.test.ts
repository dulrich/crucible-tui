import { resolve } from "node:path";
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

/**
 * The dependency removal WP-6 exists to perform, asserted on the tree rather than on a
 * green `bun install`.
 *
 * `cli-table3` is the checkable consequence and the reason this is a test rather than a
 * note: it left `dependencies` in WP-3 of `plans/tn-review-remediation.md` but stayed
 * *physically installed* because `marked-terminal` required `^0.6.5`, so it stayed in the
 * runtime closure `scripts/gen-licenses.ts` walks and stayed in `THIRD-PARTY-LICENSES.txt`.
 * Removing `marked-terminal` is what finally removes it, and the licence file is where
 * that is observable. A future `bun install` that quietly re-hoisted either package would
 * fail here instead of shipping an inaccurate notice file.
 */
describe("WP-6 — the dependency is gone, and so is what only it kept alive", () => {
  test("the detection packages are no longer declared, and neither is marked-terminal", async () => {
    const pkg = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["marked-terminal"]).toBeUndefined();
    // **Both were direct dependencies until WP-1 of `plans/colour-policy.md`**, promoted
    // there in WP-6 under the "a package this repo's source imports is declared" rule. That
    // rule did not change; what changed is that nothing here imports either any more —
    // `src/colour.ts` owns the decisions both were consulted for.
    expect(pkg.dependencies["supports-color"]).toBeUndefined();
    expect(pkg.dependencies["supports-hyperlinks"]).toBeUndefined();
    // Still declared, still imported directly, and still wrongly flagged as transitive by
    // dependency-graph tooling — see the dependency record in the root AGENTS.md.
    expect(pkg.dependencies["@colors/colors"]).toBeDefined();
    expect(pkg.dependencies["cli-highlight"]).toBeDefined();
  });

  test("the runtime closure lost supports-hyperlinks — and kept supports-color, on purpose", async () => {
    const notices = await Bun.file(resolve(import.meta.dir, "../THIRD-PARTY-LICENSES.txt")).text();
    expect(notices).not.toContain("marked-terminal@");
    expect(notices).not.toContain("cli-table3@");
    expect(notices).not.toContain("supports-hyperlinks@");
    // **Undeclaring a package and removing it from the closure are two different events,
    // and at WP-1 they happen to two different packages.** `supports-hyperlinks` had no
    // other requirer, so it left with the declaration. `supports-color` is still reachable
    // as `cli-highlight → chalk@4 → supports-color`, so it stays in the closure and in this
    // file until WP-2 removes `cli-highlight`; it never leaves `bun.lock` at all, because
    // the devDependency `eslint` also pulls `chalk@4`. Asserting its absence here would be
    // asserting WP-2's boundary a package early, and would fail on a correct tree.
    expect(notices).toContain("supports-color@7.2.0");
    // Non-vacuity: the file is the generated closure, not an empty or truncated read.
    expect(notices).toContain("marked@14.1.4");
  });

  test("nothing under src/ imports the removed library", async () => {
    const glob = new Bun.Glob("**/*.ts");
    const root = resolve(import.meta.dir, "../src");
    const offenders: string[] = [];
    for await (const relative of glob.scan(root)) {
      const text = await Bun.file(resolve(root, relative)).text();
      // The name appears in prose throughout `src/` as the record of what was replaced;
      // only an actual import is a defect, so this matches the module specifier alone.
      if (/from\s+["']marked-terminal["']/.test(text)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the scan really did read the renderer, which is the file that used to
    // carry the import.
    expect(await Bun.file(resolve(root, "render.ts")).text()).toContain("renderDocumentDetailed");
  });
});
