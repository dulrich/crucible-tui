import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { printResult } from "../scripts/sweep";
import {
  loadManifest,
  parseManifest,
  resolveCorpusFiles,
  resolveManifestSource,
  selectCorpusFiles,
  strideSample,
  sweepCorpus,
  type CorpusSpec,
  type SweepOptions,
} from "../scripts/corpus";
import { BUNDLED_DEFAULT_MANIFEST, resolveCorpusManifestPath, type MeasureConfig as MdviewConfig } from "../scripts/measure/config";
import { findFirstOverflow } from "../scripts/measure/overflow";

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

// The gate the sweep runs. Its implementation moved to `TS_BASELINE` `src/overflow.ts` in WP-2 (it was
// a copy of `TS_BASELINE` `src/cli.ts`'s, argument for argument); these cases stay here because they are
// about what the sweep reports. `tests/overflow.test.ts` pins the canonical function
// itself, including that both entry points reach it.
describe("findFirstOverflow (the width gate the sweep runs)", () => {
  const wideLine = "x".repeat(200);

  test("flags an over-width line outside any code range", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findFirstOverflow(output, 80, []);
    expect(found).toEqual({ line: 2, width: 200 });
  });

  test("does not flag the same over-width line when it falls inside a codeRanges entry", () => {
    const output = `short\n${wideLine}\nshort`;
    const found = findFirstOverflow(output, 80, [[2, 2]]);
    expect(found).toBeNull();
  });

  test("returns null when every line fits", () => {
    const output = "short\nalso short";
    expect(findFirstOverflow(output, 80, [])).toBeNull();
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

// WP-1: the symlinked-subtree skip (walkMarkdown, unchanged) is made *audible* rather
// than fixed. Fixtures live entirely in a mkdtemp'd directory — no symlink is ever
// added to the repo itself.
describe("symlinked subtree disclosure (WP-1)", () => {
  async function makeRootWithSymlinkedSubtree(): Promise<{ root: string; target: string }> {
    const root = await mkdtemp(join(tmpdir(), "mdview-symlink-root-"));
    const target = await mkdtemp(join(tmpdir(), "mdview-symlink-target-"));
    await writeFile(join(root, "real.md"), "# real\n");
    await writeFile(join(target, "inner.md"), "# inner\n");
    await symlink(target, join(root, "linked"), "dir");
    return { root, target };
  }

  async function makeRootWithoutSymlinks(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mdview-no-symlink-root-"));
    await writeFile(join(root, "real.md"), "# real\n");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "nested.md"), "# nested\n");
    return root;
  }

  test("resolveCorpusFiles counts a symlinked directory via the out-param, and still does not sweep its files", async () => {
    const { root, target } = await makeRootWithSymlinkedSubtree();
    try {
      const stats = { symlinkedDirs: 0 };
      const files = await resolveCorpusFiles({ name: "with-link", root, walkAll: true }, {}, stats);
      expect(stats.symlinkedDirs).toBe(1);
      expect(files).not.toBeNull();
      expect(files?.some((f) => f.endsWith("real.md"))).toBe(true);
      expect(files?.some((f) => f.endsWith("inner.md"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("resolveCorpusFiles's count stays at 0 for a root with no symlinked directories", async () => {
    const root = await makeRootWithoutSymlinks();
    try {
      const stats = { symlinkedDirs: 0 };
      await resolveCorpusFiles({ name: "no-link", root, walkAll: true }, {}, stats);
      expect(stats.symlinkedDirs).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked directory matching the corpus's own exclude rule is not counted (same substring rule as the walk)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdview-symlink-excluded-"));
    const target = await mkdtemp(join(tmpdir(), "mdview-symlink-excluded-target-"));
    try {
      await mkdir(join(root, "node_modules"));
      await symlink(target, join(root, "node_modules", "linked-pkg"), "dir");
      const stats = { symlinkedDirs: 0 };
      await resolveCorpusFiles({ name: "excluded-link", root, walkAll: true, exclude: ["/node_modules/"] }, {}, stats);
      expect(stats.symlinkedDirs).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("sweepCorpus threads the count through to CorpusResult.symlinkedDirsSkipped", async () => {
    const { root, target } = await makeRootWithSymlinkedSubtree();
    try {
      const spec: CorpusSpec = { name: "with-link", root, walkAll: true };
      const options: SweepOptions = { widths: [80], all: false, glyphs: "unicode", detect: false };
      const result = await sweepCorpus(spec, options);
      expect(result.symlinkedDirsSkipped).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("sweepCorpus reports 0 for a root with no symlinked directories", async () => {
    const root = await makeRootWithoutSymlinks();
    try {
      const spec: CorpusSpec = { name: "no-link", root, walkAll: true };
      const options: SweepOptions = { widths: [80], all: false, glyphs: "unicode", detect: false };
      const result = await sweepCorpus(spec, options);
      expect(result.symlinkedDirsSkipped).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("printResult logs a NOTE line naming the count when a corpus has skipped symlinked directories", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printResult(
        {
          name: "with-link",
          skipped: false,
          filesScanned: 1,
          combos: 1,
          overflow: [],
          errors: [],
          elapsedSeconds: 0.1,
          orphans: [],
          shears: [],
          shearsUnmapped: 0,
          overIndent: [],
          tableOverflow: 0,
          symlinkedDirsSkipped: 3,
        },
        false,
      );
    } finally {
      console.log = originalLog;
    }
    const noteLine = captured.find((line) => line.startsWith("NOTE:"));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain("3 symlinked directories");
    expect(noteLine).toContain("with-link");
  });

  test("printResult stays silent about symlinks when the count is 0", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printResult(
        {
          name: "no-link",
          skipped: false,
          filesScanned: 1,
          combos: 1,
          overflow: [],
          errors: [],
          elapsedSeconds: 0.1,
          orphans: [],
          shears: [],
          shearsUnmapped: 0,
          overIndent: [],
          tableOverflow: 0,
          symlinkedDirsSkipped: 0,
        },
        false,
      );
    } finally {
      console.log = originalLog;
    }
    expect(captured.some((line) => line.startsWith("NOTE:"))).toBe(false);
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
  const baseOptions: SweepOptions = { widths: [80], all: false, glyphs: "unicode", detect: false };

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

// Invariant 1, at the seam both consumers now share (WP-4). The four sweepCorpus cases
// above pin the policy end to end; these pin the predicate itself, because
// `scripts/emoji-audit.ts` applies it too and its own copy had drifted — it ignored
// `--limit` entirely. One implementation is the fix; this is what it has to keep doing.
describe("selectCorpusFiles — the one sampling policy (WP-4 invariant 1)", () => {
  const files = Array.from({ length: 20 }, (_, i) => `f${String(i).padStart(2, "0")}.md`);
  const sampled: CorpusSpec = { name: "s", root: "/example/root", walkAll: true, sample: 5 };
  const unsampled: CorpusSpec = { name: "u", root: "/example/root", walkAll: true };

  test("a corpus with `sample` is stride-sampled to it by default", () => {
    expect(selectCorpusFiles(files, sampled, { all: false })).toEqual(strideSample(files, 5));
  });

  test("--limit overrides a corpus's `sample`", () => {
    expect(selectCorpusFiles(files, sampled, { all: false, limit: 8 })).toEqual(strideSample(files, 8));
  });

  test("--limit does nothing on a corpus that sets no `sample` — the documented contract", () => {
    expect(selectCorpusFiles(files, unsampled, { all: false, limit: 3 })).toEqual(files);
  });

  test("--all disables sampling and outranks --limit", () => {
    expect(selectCorpusFiles(files, sampled, { all: true })).toEqual(files);
    expect(selectCorpusFiles(files, sampled, { all: true, limit: 3 })).toEqual(files);
  });

  test("an unsampled corpus is returned as-is, unsorted — selection is not resolution", () => {
    const scrambled = ["z.md", "a.md", "m.md"];
    expect(selectCorpusFiles(scrambled, unsampled, { all: false })).toEqual(scrambled);
  });
});

// WP-12c: a `walkAll` root that exists but contains no markdown (two of the reference
// clones, `memtest_vulkan` and `urxvt-perls`, are exactly this) is a fact about the root,
// not a misconfiguration. It used to land in `errors`, which trained the reader to expect
// noise in the one channel meant to mean "something went wrong," and — because `errors`
// feeds `anyFailure` regardless of `skipped` — silently flipped the sweep's exit code for
// a root that never had a defect in the first place. A glob-based corpus matching nothing
// is a different case (a user-supplied pattern can be typo'd) and keeps the original
// error behaviour untouched.
describe("a markdown-free root is a skip, not an error", () => {
  const baseOptions: SweepOptions = { widths: [80], all: false, glyphs: "unicode", detect: false };

  test("`walkAll` against a root with no markdown files skips, with a distinguishing reason, and does not affect the exit-code contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-empty-walkall-"));
    try {
      await writeFile(join(dir, "not-markdown.txt"), "no .md files in this tree\n");
      const spec: CorpusSpec = { name: "no-markdown", root: dir, walkAll: true };
      const result = await sweepCorpus(spec, baseOptions);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toMatch(/no markdown/i);
      expect(result.errors).toEqual([]);
      // The exit-code contract: only `!skipped && (overflow.length > 0 || errors.length > 0)`
      // may fail a sweep (see `runCli`'s `anyFailure`). A skip must never satisfy that.
      expect(!result.skipped && (result.overflow.length > 0 || result.errors.length > 0)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a glob-based corpus matching nothing is still an error — the original protection is untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-empty-glob-"));
    try {
      await writeFile(join(dir, "note.md"), "# note\n");
      const spec: CorpusSpec = { name: "broken-glob", root: dir, globs: ["*.does-not-exist"], walkAll: false };
      const result = await sweepCorpus(spec, baseOptions);
      expect(result.skipped).toBe(false);
      expect(result.errors).toEqual([{ path: dir, message: "corpus exists but matched 0 files" }]);
      expect(!result.skipped && (result.overflow.length > 0 || result.errors.length > 0)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
