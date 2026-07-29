import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  findOverflow,
  loadManifest,
  parseManifest,
  printResult,
  resolveCorpusFiles,
  resolveManifestSource,
  strideSample,
  sweepCorpus,
  type CorpusSpec,
  type SweepOptions,
} from "../scripts/sweep";
import { BUNDLED_DEFAULT_MANIFEST, resolveCorpusManifestPath, type MdviewConfig } from "../src/config";
import { renderWithForcedColor } from "./helpers/color";
import {
  buildContext,
  collectFiles,
  EXEMPT_ROOT_DIRS,
  loadSupplementalNames,
  scanLine,
  scanTree,
  type ContainmentContext,
} from "./helpers/containment";
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
      const options: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false };
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
      const options: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false };
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
  const baseOptions: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false };

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

// WP-12c: a `walkAll` root that exists but contains no markdown (two of the reference
// clones, `memtest_vulkan` and `urxvt-perls`, are exactly this) is a fact about the root,
// not a misconfiguration. It used to land in `errors`, which trained the reader to expect
// noise in the one channel meant to mean "something went wrong," and — because `errors`
// feeds `anyFailure` regardless of `skipped` — silently flipped the sweep's exit code for
// a root that never had a defect in the first place. A glob-based corpus matching nothing
// is a different case (a user-supplied pattern can be typo'd) and keeps the original
// error behaviour untouched.
describe("a markdown-free root is a skip, not an error", () => {
  const baseOptions: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false };

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

// --- containment (WP-1 constraint 4, reshaped in WP-2h) ---------------------
//
// This replaced a denylist of five literal private strings. A denylist can only
// contain the leaks somebody already found; it was extended twice by hand and was a
// name behind both times. It also could not survive the publication it existed to
// protect — the literals *were* the disclosure, and a history scrub would have
// rewritten the guard's own constants into placeholders.
//
// The rules live in `tests/helpers/containment.ts` and name nothing private: they
// describe what this repo's own content looks like and flag everything else, so a
// sibling nobody has enumerated is caught by construction. See that file's header.
//
// **This block deliberately has no self-exception.** The old guard excluded its own
// file, which is where a denylist hides. The fixtures below are assembled from parts
// at run time precisely so that this file does not itself contain the shapes it
// tests for, and the whole tree — this file included — goes through the same scan.

describe("containment rules", () => {
  const context: ContainmentContext = {
    own: new Set(["src", "tests", "scripts"]),
    packages: new Set(["marked", "@types/bun"]),
    // Invented. These name nothing on any machine; the point of the exercise is that
    // the rules do not need to know what a neighbour is called in order to flag it.
    neighbours: new Set(["widget_factory", "ledger"]),
    listed: new Set(),
  };
  // Assembled, never written out: a literal here would be a finding in this file.
  const foreignPath = ["widget_factory", "internal", "web", "markdown.ts"].join("/");
  const homePath = ["", "home", "someone", "notes.md"].join("/");
  const fakeHomePath = ["", "home", "example", "notes.md"].join("/");
  const rules = (line: string): string[] => scanLine(line, context).map((finding) => finding.rule);

  test("flags a path citation into a directory this repo does not have", () => {
    expect(rules(`// adapted from ${foreignPath}:7`)).toContain("foreign-path");
  });

  test("flags such a citation even when the first segment is on no list anywhere", () => {
    // The whole point: `quarterly_reports` is not a neighbour here, not in any private
    // list, and was invented for this assertion. The rule flags it for its *shape*.
    const unknown = ["quarterly_reports", "packages", "core", "index.ts"].join("/");
    expect(rules(`see ${unknown}`)).toEqual(["foreign-path"]);
  });

  test("allows a path into this repo's own directories", () => {
    expect(rules(`see ${["src", "render.ts"].join("/")} and ${["tests", "fixtures"].join("/")}/`)).toEqual([]);
  });

  test("allows a path into an installed package", () => {
    expect(rules(`${["marked", "lib", "marked.cjs"].join("/")} and @types/bun/index.d.ts`)).toEqual([]);
  });

  test("allows the sanctioned fake root, relative and absolute", () => {
    expect(rules(`render ${["example", "plan.md"].join("/")} at ${fakeHomePath}`)).toEqual([]);
  });

  test("flags an absolute path naming any other account", () => {
    expect(rules(`corpus at ${homePath}`)).toEqual(["home-path"]);
  });

  test("flags a distinctive neighbour name in bare prose, where no path rule can see it", () => {
    expect(rules("the same trick widget_factory uses")).toEqual(["neighbour-name"]);
  });

  test("flags a plain-word neighbour name used as an identifier", () => {
    expect(rules("see the `ledger` tool")).toEqual(["neighbour-name"]);
  });

  test("leaves a plain-word neighbour name alone in ordinary prose", () => {
    // Otherwise every directory on this machine whose name is an English word — and
    // there are several — makes the guard unusable, which is how guards get disabled.
    expect(rules("the ledger of what changed")).toEqual([]);
  });

  test("does not read an English slash-list, a ratio, or a regex as a path", () => {
    expect(rules("either/or, 50/50, and /\\s/.exec(text)")).toEqual([]);
  });

  test("does not read a shell variable or a placeholder as a path", () => {
    expect(rules("$XDG_CONFIG_HOME/mdview/config.json and <path>/manifest.json")).toEqual([]);
  });

  test("a supplied private name is flagged wherever it appears, prose included", () => {
    const listed = { ...context, listed: new Set(["quietly"]) };
    expect(scanLine("it fails quietly", listed).map((f) => f.rule)).toEqual(["listed-name"]);
  });

  test("the neighbour rule is the only backstop for the path rule's package exemption", () => {
    // Pins *why* `neighbourNames` refuses to drop the whole neighbours-and-packages
    // intersection. The path rule treats an installed package name as a safe first
    // segment — it has to, so `marked/lib/marked.cjs` can be cited — which means a
    // private sibling sharing a package's name slips past it. This rule catches it.
    // Subtract `packages` from `neighbours` wholesale and both rules go blind at once.
    const collision: ContainmentContext = {
      ...context,
      packages: new Set(["ledger_core"]),
      neighbours: new Set(["ledger_core"]),
    };
    const cited = `see ${["ledger_core", "private", "layout.ts"].join("/")}`;
    expect(scanLine(cited, collision).map((f) => f.rule)).toEqual(["neighbour-name"]);
  });
});

// WP-12d (user decision 2026-07-29): execution briefs and plans are checked into a repo's
// `runs/` directory carrying real absolute paths, so the containment guard must not scan
// there — but every rule must keep running everywhere else, `plans/` included, since plans
// are inside the shared corpus. These tests plant an identical violation in four
// locations and prove the guard's verdict differs *only* for the one that is exempt, then
// clean the fixtures up. The literal is assembled at run time for the same reason the
// synthetic fixtures above are: this file has no self-exception and is scanned like any
// other.
describe("the runs/ exemption is exactly that narrow (WP-12d)", () => {
  const plantedCitation = ["quietly_planted_zz", "internal", "layout.ts"].join("/");
  const plantedLine = `see ${plantedCitation} for the real layout\n`;

  test("a planted violation is still caught under src/, tests/fixtures/, and a root *.md — but not under runs/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-runs-exemption-"));
    try {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "tests", "fixtures"), { recursive: true });
      await mkdir(join(dir, "runs", "dispatch"), { recursive: true });
      await writeFile(join(dir, "src", "module.ts"), `// ${plantedLine}`);
      await writeFile(join(dir, "tests", "fixtures", "note.md"), plantedLine);
      await writeFile(join(dir, "README.md"), plantedLine);
      await writeFile(join(dir, "runs", "dispatch", "brief.md"), plantedLine);

      const context = buildContext(dir);
      const findings = scanTree(dir, context);
      const findingsUnder = (relPath: string) =>
        findings.filter((f) => relative(dir, f.file) === relPath);

      expect(findingsUnder(join("src", "module.ts")).length).toBeGreaterThan(0);
      expect(findingsUnder(join("tests", "fixtures", "note.md")).length).toBeGreaterThan(0);
      expect(findingsUnder("README.md").length).toBeGreaterThan(0);
      // The exemption: the identical planted string, in a file under `runs/`, is invisible.
      expect(findingsUnder(join("runs", "dispatch", "brief.md")).length).toBe(0);
      expect(findings).toHaveLength(3); // src/, tests/fixtures/, README.md — runs/ contributes nothing
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("collectFiles never descends into a top-level runs/ at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-runs-collect-"));
    try {
      await mkdir(join(dir, "runs", "dispatch"), { recursive: true });
      await writeFile(join(dir, "runs", "dispatch", "brief.md"), "anything\n");
      await writeFile(join(dir, "keep.md"), "# keep\n");
      const files = collectFiles(dir);
      expect(files.some((f) => f.endsWith("keep.md"))).toBe(true);
      expect(files.some((f) => f.includes(`${join("runs", "dispatch")}`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a nested directory literally named runs/ (not at the repo root) is not exempt", async () => {
    // The exemption is root-relative and top-level only — `<root>/runs/**`, never a
    // directory that merely happens to be named `runs` somewhere deeper in the tree.
    const dir = await mkdtemp(join(tmpdir(), "mdview-nested-runs-"));
    try {
      await mkdir(join(dir, "src", "runs"), { recursive: true });
      await writeFile(join(dir, "src", "runs", "scheduler.ts"), "export const runs = 1;\n");
      const files = collectFiles(dir);
      expect(files.some((f) => f.endsWith(join("src", "runs", "scheduler.ts")))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no default-manifest glob can ever match anything under runs/ — the assertion that makes the exemption enforceable", async () => {
    const manifestPath = BUNDLED_DEFAULT_MANIFEST;
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      corpora: Array<{ root: string; globs?: string[] }>;
    };
    expect(manifest.corpora.length).toBeGreaterThan(0);
    for (const spec of manifest.corpora) {
      const resolvedRoot = resolve(dirname(manifestPath), spec.root);
      // The corpus root itself must never be, or resolve into, the exempted directory.
      expect(basename(resolvedRoot)).not.toBe("runs");
      for (const glob of spec.globs ?? []) {
        const firstSegment = glob.split("/")[0] ?? "";
        // A bare wildcard as the first segment could expand to match `runs` itself; a
        // literal `runs` segment obviously would. If either ever appears, the corpus and
        // the exemption are no longer disjoint and this must fail.
        const overlapsRuns = EXEMPT_ROOT_DIRS.has(firstSegment) || firstSegment === "**" || firstSegment === "*";
        expect(overlapsRuns).toBe(false);
      }
    }
    // And the exemption itself must still be exactly what this test assumes — nothing
    // broader could quietly widen it without this failing too.
    expect([...EXEMPT_ROOT_DIRS]).toEqual(["runs"]);
  });
});

describe("a dependency checked out beside the repo is not a private neighbour", () => {
  // A contributor reading a dependency's source next to their checkout — which this
  // repo's own docs describe doing — must not turn every mention of that dependency
  // into a finding. A guard that fails for reasons unrelated to your change is a guard
  // that gets switched off.
  const DEP = "zz-fixture-dep";

  async function scaffold(withManifest: boolean): Promise<{ dir: string; repo: string }> {
    const dir = await mkdtemp(join(tmpdir(), "mdview-neighbours-"));
    const repo = join(dir, "repo");
    await mkdir(join(repo, "node_modules", DEP), { recursive: true });
    await mkdir(join(dir, DEP), { recursive: true });
    if (withManifest) {
      await writeFile(join(dir, DEP, "package.json"), JSON.stringify({ name: DEP }));
    }
    return { dir, repo };
  }

  test("exempt when the directory proves it is that package", async () => {
    const { dir, repo } = await scaffold(true);
    try {
      expect(buildContext(repo).neighbours.has(DEP)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still a neighbour when it only shares the name — this is the hole left open, on purpose", async () => {
    // The exemption is evidence-based, not name-based. A private sibling that happens
    // to be called the same thing as an installed package keeps being flagged.
    const { dir, repo } = await scaffold(false);
    try {
      expect(buildContext(repo).neighbours.has(DEP)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still a neighbour when its manifest names something else", async () => {
    const { dir, repo } = await scaffold(false);
    try {
      await writeFile(join(dir, DEP, "package.json"), JSON.stringify({ name: "@private/something" }));
      expect(buildContext(repo).neighbours.has(DEP)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("supplemental private-name list", () => {
  // The list itself is private and lives outside this repo. This repo is *told* a
  // path and knows nothing about the other end — the same shape as the corpus
  // manifest above, for the same reason.

  test("absent when unset: the always-on rules are the whole guard", async () => {
    const result = await loadSupplementalNames({});
    expect(result.source).toBe("absent");
    expect(result.names.size).toBe(0);
  });

  test("a pointer to a file that cannot be read is a hard error, never a silent skip", async () => {
    // This is the inert-gate failure mode: an opt-in check whose input has moved, and
    // which therefore passes forever while checking nothing.
    await expect(
      loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: join(MDVIEW_ROOT, "no", "such", "list.json") }),
    ).rejects.toThrow(/cannot be read/);
  });

  test("a malformed or empty list is a hard error too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-containment-"));
    try {
      const bad = join(dir, "bad.json");
      await writeFile(bad, "not json");
      await expect(loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: bad })).rejects.toThrow(/not valid JSON/);

      const empty = join(dir, "empty.json");
      await writeFile(empty, JSON.stringify({ names: [] }));
      await expect(loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: empty })).rejects.toThrow(/non-empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed list loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-containment-"));
    try {
      const good = join(dir, "names.json");
      await writeFile(good, JSON.stringify({ names: ["alpha", "beta"] }));
      const result = await loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: good });
      expect(result.source).toBe("env");
      expect([...result.names].sort()).toEqual(["alpha", "beta"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// A git worktree stores `.git` as a *file* whose contents are an absolute path written by
// git. `collectFiles` used to test `SKIP_DIRS` only inside its `isDirectory()` branch, so
// it scanned that file and failed containment on git's own plumbing — which made worktrees
// unusable and pushed dispatched work into full clones parked inside the code root.
describe("skip rules match by name, not by entry type", () => {
  test("a worktree's `.git` file is skipped rather than scanned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-worktree-"));
    try {
      // Exactly the shape git writes. The account is the sanctioned fake one: the guard has
      // no self-exception, so a test *about* the home-path rule must not trip it — writing a
      // realistic account name here failed the suite on its own fixture, which is the design
      // working rather than an inconvenience.
      await writeFile(join(dir, ".git"), "gitdir: /home/example/main-repo/.git/worktrees/wp-1\n");
      await writeFile(join(dir, "real.ts"), "export const x = 1;\n");
      const files = collectFiles(dir);
      expect(files.some((file) => file.endsWith("/real.ts"))).toBe(true);
      expect(files.some((file) => file.endsWith("/.git"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file sharing a skipped directory's name is skipped too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-skipname-"));
    try {
      await writeFile(join(dir, "dist"), "not a directory\n");
      await writeFile(join(dir, "keep.md"), "# keep\n");
      const files = collectFiles(dir);
      expect(files.some((file) => file.endsWith("/keep.md"))).toBe(true);
      expect(files.some((file) => file.endsWith("/dist"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// WP-12a: `ownNames` used to seed itself from nothing but `basename(root)`, and
// `neighbourNames` walked ancestors from `root` itself. Both are true of a plain checkout
// only by coincidence — a worktree's `root` is a branch-ish scratch directory
// (`.worktrees/<branch>`), so its basename is not the repo's name and its ancestor chain
// passes through a directory (`.worktrees`) that is not a real sibling. Measured on the
// real checkout this repo runs from: 0 findings from the main checkout, dozens from a
// worktree of the exact same commit, every one a self-reference. This test describes the
// *shape* of the bug — a real git worktree parked under a dot-prefixed scratch directory,
// with its leaf named for the branch rather than the repo — without hardcoding any path
// on this machine.
describe("a worktree resolves its own identity the same way the main checkout does", () => {
  test("own name, neighbour set, and self-exemption all match between a repo and its worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-worktree-identity-"));
    try {
      const mainRepo = join(dir, "sample-repo");
      await mkdir(join(mainRepo, "node_modules"), { recursive: true });
      execFileSync("git", ["init", "-q", mainRepo]);
      execFileSync("git", ["-C", mainRepo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", mainRepo, "config", "user.name", "test"]);
      await writeFile(join(mainRepo, "README.md"), "placeholder\n");
      execFileSync("git", ["-C", mainRepo, "add", "README.md"]);
      execFileSync("git", ["-C", mainRepo, "commit", "-q", "-m", "init"]);

      // The exact shape from the brief: a worktree under a dot-prefixed sibling directory,
      // its leaf named for the branch, not for the repo.
      const scratchDir = join(dir, ".worktrees", "some-branch");
      execFileSync("git", ["-C", mainRepo, "worktree", "add", "-q", scratchDir, "-b", "some-branch"]);
      await mkdir(join(scratchDir, "node_modules"), { recursive: true });

      const mainContext = buildContext(mainRepo);
      const worktreeContext = buildContext(scratchDir);

      // The repo's real name is recognized as "own" from the worktree, not just from the
      // main checkout — this is the fix, resolving through git's common dir rather than
      // trusting the checkout's leaf directory name.
      expect(worktreeContext.own.has(basename(mainRepo))).toBe(true);
      // The ancestor-derived neighbour set is identical from both locations: the walk keys
      // off the resolved repo root, not off wherever this particular checkout happens to
      // live, so `.worktrees` and the branch label never enter it.
      expect([...worktreeContext.neighbours].sort()).toEqual([...mainContext.neighbours].sort());
      // And the repo never appears as its own neighbour — the failure mode this fixes.
      expect(worktreeContext.neighbours.has(basename(mainRepo))).toBe(false);
      expect(mainContext.neighbours.has(basename(mainRepo))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("no private reference reaches a public clone of this repo", () => {
  test("the bundled default manifest is clean", async () => {
    const text = await Bun.file(BUNDLED_DEFAULT_MANIFEST).text();
    const context = buildContext(MDVIEW_ROOT);
    const findings = text
      .split("\n")
      .flatMap((line, index) => scanLine(line, context).map((f) => `${index + 1}: ${f.rule} "${f.token}"`));
    expect(findings).toEqual([]);
  });

  test("no file under this repo carries a foreign path, a home path, or a neighbour's name", async () => {
    const supplemental = await loadSupplementalNames();
    if (supplemental.source === "absent") {
      // Loud on purpose. The three always-on rules below are the binding guard and are
      // sufficient without this; the supplement only adds private strings that are
      // neither path-shaped nor directory names. Saying so beats a silent skip.
      console.error(
        "containment: MDVIEW_PRIVATE_NAMES is unset — supplemental name list not applied; " +
          "the always-on path, home-path and neighbour rules still ran.",
      );
    }
    const context = buildContext(MDVIEW_ROOT, supplemental.names);
    expect(context.neighbours.size).toBeGreaterThan(0);
    const findings = scanTree(MDVIEW_ROOT, context).map(
      (finding) => `${relative(MDVIEW_ROOT, finding.file)}:${finding.line} ${finding.rule} "${finding.token}"`,
    );
    expect(findings).toEqual([]);
  });
});
