import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  findOverflow,
  loadManifest,
  parseManifest,
  resolveCorpusFiles,
  resolveManifestSource,
  strideSample,
  sweepCorpus,
  type CorpusSpec,
  type SweepOptions,
} from "../scripts/sweep";
import { BUNDLED_DEFAULT_MANIFEST, resolveCorpusManifestPath, type MdviewConfig } from "../src/config";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocumentDetailed } from "../src/render";
import { UNICODE_GLYPHS } from "../src/glyphs";

const MDVIEW_ROOT = join(import.meta.dir, "..");

describe("strideSample", () => {
  const items = Array.from({ length: 1000 }, (_, index) => `path-${String(index).padStart(4, "0")}.md`);

  test("returns exactly `limit` entries from a 1000-item list", () => {
    expect(strideSample(items, 300)).toHaveLength(300);
  });

  test("is deterministic across repeated calls", () => {
    expect(strideSample(items, 300)).toEqual(strideSample(items, 300));
  });

  test("spans the whole sorted list — first and last are represented", () => {
    const sorted = [...items].sort();
    const sample = strideSample(items, 300);
    expect(sample[0]).toBe(sorted[0]);
    expect(sample[sample.length - 1]).toBe(sorted[sorted.length - 1]);
  });

  test("does not simply take the first N (regression guard against scan-order bias)", () => {
    const sorted = [...items].sort();
    const firstN = sorted.slice(0, 300);
    const sample = strideSample(items, 300);
    expect(sample).not.toEqual(firstN);
  });

  test("returns the full list unchanged when it is already at or below the limit", () => {
    const small = items.slice(0, 50);
    expect(strideSample(small, 300)).toEqual([...small].sort());
  });
});

describe("findOverflow", () => {
  const wideLine = "x".repeat(200);

  test("flags an over-width line outside any code range", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findOverflow(output, 80, []);
    expect(found).toEqual({ line: 2, width: 200 });
  });

  test("does not flag the same over-width line when it falls inside a codeRanges entry", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findOverflow(output, 80, [[2, 2]]);
    expect(found).toBeNull();
  });

  test("returns null when every line fits", () => {
    const output = "short\nalso short";
    expect(findOverflow(output, 80, [])).toBeNull();
  });
});

describe("resolveCorpusFiles", () => {
  test("a missing corpus root resolves to null (skip, not fail)", async () => {
    const files = await resolveCorpusFiles({
      name: "missing",
      root: "/definitely/does/not/exist/on/this/machine",
      walkAll: true,
    });
    expect(files).toBeNull();
  });
});

describe("renderWithForcedColor", () => {
  const unsupportedLangFence = "```dataviewjs\nconsole.log(1)\n```\n";

  // DEVIATION, WP-3: this assertion is flipped from WP-1's original. `dataviewjs` used
  // to leak a highlight.js "language not found" diagnostic even under forced color —
  // that was the very bug this harness was built to make visible (see the module doc
  // comment in `tests/helpers/color.ts`). WP-3 fixes it: every fence language is now
  // normalized to one `cli-highlight` supports before it reaches the gated `highlight()`
  // path (`src/lang.ts`), so no fence language reaches stderr any more, not even this
  // one, not even under forced color. Leaving the old assertion in place would mean
  // this test only passes when the bug it exists to catch is still present — i.e. it
  // would now fail forever by design, not by defect. A positive control proving the
  // console.error capture mechanism itself still works when a message *is* genuinely
  // emitted (calling `cli-highlight` directly, bypassing the now-total normalization)
  // lives in `tests/render.test.ts`, so this flip cannot pass vacuously.
  test("a fence language that used to leak a highlight.js diagnostic under forced color now captures nothing (WP-3)", async () => {
    const { messages } = await renderWithForcedColor(unsupportedLangFence, 80);
    expect(messages).toEqual([]);
  });

  test("the normal (non-forced) render path captures nothing for the same input", () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      renderDocumentDetailed(unsupportedLangFence, 80);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
    expect(captured).toHaveLength(0);
  });
});

describe("parseManifest / loadManifest (WP-1)", () => {
  const manifestPath = "/some/dir/manifest.json";

  test("parses a valid manifest and resolves a relative root against the manifest's own directory", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        generated: "2026-07-27T00:00:00Z",
        generator: "test",
        corpora: [{ name: "repo", root: "sub/dir", globs: ["*.md"] }],
      }),
      manifestPath,
    );
    expect(manifest.corpora).toHaveLength(1);
    expect(manifest.corpora[0]?.root).toBe("/some/dir/sub/dir");
  });

  test("resolves an absolute root unchanged, regardless of the manifest's directory", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        generated: "",
        generator: "test",
        corpora: [{ name: "abs", root: "/absolute/root", walkAll: true }],
      }),
      manifestPath,
    );
    expect(manifest.corpora[0]?.root).toBe("/absolute/root");
  });

  test("relative-root resolution is against the manifest's directory, not process.cwd()", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpdir());
      const manifest = parseManifest(
        JSON.stringify({
          version: 1,
          generated: "",
          generator: "test",
          corpora: [{ name: "repo", root: "docs", walkAll: true }],
        }),
        "/elsewhere/entirely/manifest.json",
      );
      expect(manifest.corpora[0]?.root).toBe("/elsewhere/entirely/docs");
    } finally {
      process.chdir(originalCwd);
    }
  });

  test("carries a valid `sample` through unchanged", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        generated: "",
        generator: "test",
        corpora: [{ name: "vault", root: "/v", walkAll: true, sample: 300 }],
      }),
      manifestPath,
    );
    expect(manifest.corpora[0]?.sample).toBe(300);
  });

  test("rejects a non-object manifest", () => {
    expect(() => parseManifest("[]", manifestPath)).toThrow(/must be a JSON object/);
  });

  test("rejects invalid JSON with a clear message naming the manifest path", () => {
    expect(() => parseManifest("{not json", manifestPath)).toThrow(/not valid JSON/);
  });

  test("rejects an unsupported version", () => {
    expect(() =>
      parseManifest(JSON.stringify({ version: 2, corpora: [{ name: "x", root: "/x", walkAll: true }] }), manifestPath),
    ).toThrow(/unsupported "version"/);
  });

  test("rejects a missing or empty corpora array", () => {
    expect(() => parseManifest(JSON.stringify({ version: 1, corpora: [] }), manifestPath)).toThrow(
      /non-empty "corpora"/,
    );
    expect(() => parseManifest(JSON.stringify({ version: 1 }), manifestPath)).toThrow(/non-empty "corpora"/);
  });

  test("rejects an entry missing a name", () => {
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, corpora: [{ root: "/x", walkAll: true }] }), manifestPath),
    ).toThrow(/missing a non-empty string "name"/);
  });

  test("rejects an entry missing a root", () => {
    expect(() =>
      parseManifest(JSON.stringify({ version: 1, corpora: [{ name: "x", walkAll: true }] }), manifestPath),
    ).toThrow(/missing a non-empty string "root"/);
  });

  test("rejects an entry with neither globs nor walkAll", () => {
    expect(() => parseManifest(JSON.stringify({ version: 1, corpora: [{ name: "x", root: "/x" }] }), manifestPath)).toThrow(
      /must set either "globs".*walkAll/,
    );
  });

  test("rejects an entry with a non-positive-integer sample", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ version: 1, corpora: [{ name: "x", root: "/x", walkAll: true, sample: -1 }] }),
        manifestPath,
      ),
    ).toThrow(/"sample" must be a positive integer/);
    expect(() =>
      parseManifest(
        JSON.stringify({ version: 1, corpora: [{ name: "x", root: "/x", walkAll: true, sample: 1.5 }] }),
        manifestPath,
      ),
    ).toThrow(/"sample" must be a positive integer/);
  });

  test("rejects an entry with a non-string-array exclude", () => {
    expect(() =>
      parseManifest(
        JSON.stringify({ version: 1, corpora: [{ name: "x", root: "/x", walkAll: true, exclude: "nope" }] }),
        manifestPath,
      ),
    ).toThrow(/"exclude" must be an array of strings/);
  });

  test("loadManifest fails loudly (not silently) when the file does not exist", async () => {
    await expect(loadManifest("/definitely/does/not/exist/manifest.json")).rejects.toThrow(
      /cannot read corpus manifest/,
    );
  });

  test("loadManifest round-trips a manifest written to a real temp file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-manifest-"));
    try {
      const file = join(dir, "manifest.json");
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          generated: "2026-07-27T00:00:00Z",
          generator: "test",
          corpora: [{ name: "docs", root: ".", globs: ["*.md"] }],
        }),
      );
      const manifest = await loadManifest(file);
      expect(manifest.corpora).toEqual([{ name: "docs", root: dir, globs: ["*.md"], walkAll: false, exclude: undefined, sample: undefined }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("corpus manifest resolution precedence (WP-1: flag > env > config > bundled)", () => {
  test("resolveCorpusManifestPath: env wins over config", () => {
    const config: MdviewConfig = { corpusManifest: "/from/config.json" };
    const result = resolveCorpusManifestPath(config, { MDVIEW_CORPUS_MANIFEST: "/from/env.json" });
    expect(result).toEqual({ path: "/from/env.json", source: "env" });
  });

  test("resolveCorpusManifestPath: config wins over the bundled default when no env is set", () => {
    const config: MdviewConfig = { corpusManifest: "/from/config.json" };
    const result = resolveCorpusManifestPath(config, {});
    expect(result).toEqual({ path: "/from/config.json", source: "config" });
  });

  test("resolveCorpusManifestPath: bundled default when neither env nor config is set", () => {
    const result = resolveCorpusManifestPath({}, {});
    expect(result).toEqual({ path: BUNDLED_DEFAULT_MANIFEST, source: "bundled" });
  });

  test("resolveManifestSource: an explicit --manifest flag outranks a set MDVIEW_CORPUS_MANIFEST env var", async () => {
    const originalEnv = process.env.MDVIEW_CORPUS_MANIFEST;
    process.env.MDVIEW_CORPUS_MANIFEST = "/from/env-should-lose.json";
    try {
      const result = await resolveManifestSource("/from/flag.json");
      expect(result).toEqual({ path: "/from/flag.json", source: "flag" });
    } finally {
      if (originalEnv === undefined) delete process.env.MDVIEW_CORPUS_MANIFEST;
      else process.env.MDVIEW_CORPUS_MANIFEST = originalEnv;
    }
  });

  test("resolveManifestSource: falls through to the env var when no flag is given", async () => {
    const originalEnv = process.env.MDVIEW_CORPUS_MANIFEST;
    process.env.MDVIEW_CORPUS_MANIFEST = "/from/env-wins.json";
    try {
      const result = await resolveManifestSource(undefined);
      expect(result).toEqual({ path: "/from/env-wins.json", source: "env" });
    } finally {
      if (originalEnv === undefined) delete process.env.MDVIEW_CORPUS_MANIFEST;
      else process.env.MDVIEW_CORPUS_MANIFEST = originalEnv;
    }
  });
});

describe("sample honoured / overridden (WP-1: replaces the spec.name === \"vault\" hardcode)", () => {
  let dir = "";
  const baseOptions: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS };

  async function makeCorpusDir(fileCount: number): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "mdview-sample-"));
    for (let i = 0; i < fileCount; i += 1) {
      await writeFile(join(d, `f${String(i).padStart(3, "0")}.md`), `# f${i}\n`);
    }
    return d;
  }

  test("a corpus with `sample` set is stride-sampled to that size by default", async () => {
    dir = await makeCorpusDir(20);
    const spec: CorpusSpec = { name: "sampled", root: dir, walkAll: true, sample: 5 };
    const result = await sweepCorpus(spec, baseOptions);
    expect(result.filesScanned).toBe(5);
    await rm(dir, { recursive: true, force: true });
  });

  test("--all disables sampling even when `sample` is set", async () => {
    dir = await makeCorpusDir(20);
    const spec: CorpusSpec = { name: "sampled", root: dir, walkAll: true, sample: 5 };
    const result = await sweepCorpus(spec, { ...baseOptions, all: true });
    expect(result.filesScanned).toBe(20);
    await rm(dir, { recursive: true, force: true });
  });

  test("--limit overrides the manifest's `sample` value", async () => {
    dir = await makeCorpusDir(20);
    const spec: CorpusSpec = { name: "sampled", root: dir, walkAll: true, sample: 5 };
    const result = await sweepCorpus(spec, { ...baseOptions, limit: 8 });
    expect(result.filesScanned).toBe(8);
    await rm(dir, { recursive: true, force: true });
  });

  test("a corpus with no `sample` is never sampled, even if --limit is passed", async () => {
    dir = await makeCorpusDir(20);
    const spec: CorpusSpec = { name: "unsampled", root: dir, walkAll: true };
    const result = await sweepCorpus(spec, { ...baseOptions, limit: 3 });
    expect(result.filesScanned).toBe(20);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("unknown --corpus name (WP-1: sourced from the manifest, not a hardcoded constant)", () => {
  test("filtering a manifest's corpora by an unknown name yields no targets, and the available names are recoverable from the manifest", () => {
    const manifest = parseManifest(
      JSON.stringify({
        version: 1,
        generated: "",
        generator: "test",
        corpora: [
          { name: "alpha", root: "/a", walkAll: true },
          { name: "beta", root: "/b", walkAll: true },
        ],
      }),
      "/m/manifest.json",
    );
    const targets = manifest.corpora.filter((spec) => spec.name === "gamma");
    expect(targets).toHaveLength(0);
    expect(manifest.corpora.map((c) => c.name)).toEqual(["alpha", "beta"]);
  });
});

describe("no private path leaks into mdview/ (WP-1 constraint 4, automated half of the extraction scrub)", () => {
  // These four strings are the ones named explicitly in the WP-1 brief: the vault
  // directory name, the reports directory name, and any home-relative absolute path
  // this machine's corpora live under. This is a guard against regression, not a
  // one-time check — a future edit that reintroduces one of these strings anywhere
  // under mdview/ (source, tests, fixtures, docs, comments) should fail this test.
  const FORBIDDEN_STRINGS = ["example-vault", "example_reports", "/home/analyst/code", "/home/analyst"];
  const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);
  // This test file itself necessarily contains the forbidden strings above, as
  // literals, in order to check for them — it is the one deliberate exception,
  // not a corpus reference.
  const SELF_PATH = import.meta.path;

  async function collectTrackedFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    async function recurse(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await recurse(full);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    }
    await recurse(root);
    return out;
  }

  test("the bundled default manifest contains none of the forbidden strings", async () => {
    const text = await Bun.file(BUNDLED_DEFAULT_MANIFEST).text();
    for (const needle of FORBIDDEN_STRINGS) {
      expect(text).not.toContain(needle);
    }
  });

  test("no tracked file under mdview/ contains any forbidden private-path string", async () => {
    const files = (await collectTrackedFiles(MDVIEW_ROOT)).filter((file) => file !== SELF_PATH);
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await Bun.file(file).text();
      } catch {
        continue; // binary or unreadable — not a markdown/source/doc file we care about here
      }
      for (const needle of FORBIDDEN_STRINGS) {
        if (text.includes(needle)) offenders.push(`${file}: contains "${needle}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
