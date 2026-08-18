import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseArgs, parseWidths, printColourAxis, printResult, stripColourModeArgs } from "../scripts/sweep";
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
import { BUNDLED_DEFAULT_MANIFEST, resolveCorpusManifestPath, type MdviewConfig } from "../src/config";
import { findFirstOverflow } from "../src/overflow";
import { renderWithForcedColor } from "./helpers/color";
import { renderDocumentDetailed } from "../src/render";
import { UNICODE_GLYPHS } from "../src/glyphs";

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

// The gate the sweep runs. Its implementation moved to `src/overflow.ts` in WP-2 (it was
// a copy of `src/cli.ts`'s, argument for argument); these cases stay here because they are
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

// --- the sweep's argument parser and the invariants a refactor breaks silently ----
//
// WP-4 (plans/tn-review-remediation.md). `parseArgs` had **zero** direct tests while
// controlling every measurement parameter this instrument takes, and the sweep is not a
// build script: its numbers are compared against dated full-corpus runs in a private
// archive. The gate it exits on is `overflow`/`errors` alone, so a changed sample, a
// changed width order, a changed error string or a changed detector accumulator is
// **fully green**. These tests were written before WP-4's extraction, deliberately: a
// test written afterwards pins whatever the refactor did.
//
// Several of the behaviours below look like defects and are pinned anyway, because they
// are the recorded behaviour: `--limit` doing nothing on a corpus without `sample`,
// unknown arguments being silently ignored, a flag consuming a flag-shaped value, the
// hardcoded `elapsedSeconds: 0` on the missing-root state, `shearsUnmapped` accumulating
// the *orphan* count, and the two deliberately different error-string shapes.

describe("parseArgs — defaults and every flag (WP-4)", () => {
  test("no arguments: every measurement parameter takes its recorded default", () => {
    const { corpus, options } = parseArgs([]);
    expect(corpus).toBe("all");
    // The recorded width set. 80/100/160 are the historical baseline; 116 and 346 are
    // two of the user's real terminal widths, added in WP-2c. Widths are only ever
    // added here, never swapped, so archived runs stay comparable.
    expect(options.widths).toEqual([80, 100, 116, 160, 346]);
    expect(options.limit).toBeUndefined();
    expect(options.all).toBe(false);
    expect(options.glyphs.tier).toBe("unicode");
    expect(options.measure?.ambiguous).toBe("narrow");
    expect(options.manifestFlag).toBeUndefined();
    expect(options.detect).toBe(false);
    expect(options.maxOrphans).toBeUndefined();
    expect(options.maxOverIndent).toBeUndefined();
  });

  test("--corpus takes the next argument as its value", () => {
    expect(parseArgs(["--corpus", "regressions"]).corpus).toBe("regressions");
  });

  test("--corpus with no value throws", () => {
    expect(() => parseArgs(["--corpus"])).toThrow("missing value for --corpus");
  });

  test("a flag's value is taken positionally, even when it is itself flag-shaped", () => {
    // Recorded behaviour, not an accident of writing the test this way: the parser reads
    // `argv[index + 1]` unconditionally, so `--corpus --all` names a corpus `--all` and
    // consumes the flag. Pinned because a "tidier" parser that refused flag-shaped values
    // would change what an archived command line meant.
    const { corpus, options } = parseArgs(["--corpus", "--all"]);
    expect(corpus).toBe("--all");
    expect(options.all).toBe(false);
  });

  test("--all is a bare flag", () => {
    expect(parseArgs(["--all"]).options.all).toBe(true);
  });

  test("--widths accepts a list, an inclusive range, and a mix of the two", () => {
    expect(parseArgs(["--widths", "80,100"]).options.widths).toEqual([80, 100]);
    expect(parseArgs(["--widths", "40-44"]).options.widths).toEqual([40, 41, 42, 43, 44]);
    expect(parseArgs(["--widths", "40-42,116,346"]).options.widths).toEqual([40, 41, 42, 116, 346]);
  });

  test("--widths with no value throws, and a malformed value carries parseWidths' message", () => {
    expect(() => parseArgs(["--widths"])).toThrow("missing value for --widths");
    expect(() => parseArgs(["--widths", "0"])).toThrow("--widths must be positive numbers, got: 0");
    expect(() => parseArgs(["--widths", "100-80"])).toThrow("--widths range must be ascending, got: 100-80");
  });

  test("--limit accepts a positive number and rejects everything else", () => {
    expect(parseArgs(["--limit", "8"]).options.limit).toBe(8);
    // A fractional limit is accepted — `Number.isFinite(2.5) && 2.5 > 0`. It reaches
    // `strideSample`, whose `i < limit` loop then emits `ceil(limit)` files. Recorded
    // behaviour, pinned rather than tightened: an archived command line has to keep
    // meaning what it meant.
    expect(parseArgs(["--limit", "2.5"]).options.limit).toBe(2.5);
    expect(() => parseArgs(["--limit"])).toThrow("missing value for --limit");
    expect(() => parseArgs(["--limit", "0"])).toThrow("--limit must be a positive number, got: 0");
    expect(() => parseArgs(["--limit", "-3"])).toThrow("--limit must be a positive number, got: -3");
    expect(() => parseArgs(["--limit", "abc"])).toThrow("--limit must be a positive number, got: abc");
  });

  test("--glyphs selects the tier and rejects any other value", () => {
    expect(parseArgs(["--glyphs", "ascii"]).options.glyphs.tier).toBe("ascii");
    expect(parseArgs(["--glyphs", "unicode"]).options.glyphs.tier).toBe("unicode");
    expect(() => parseArgs(["--glyphs", "utf8"])).toThrow('--glyphs must be "unicode" or "ascii", got: utf8');
    expect(() => parseArgs(["--glyphs"])).toThrow('--glyphs must be "unicode" or "ascii", got: undefined');
  });

  test("--ambiguous selects the ruler and rejects any other value", () => {
    expect(parseArgs(["--ambiguous", "wide"]).options.measure?.ambiguous).toBe("wide");
    expect(parseArgs(["--ambiguous", "narrow"]).options.measure?.ambiguous).toBe("narrow");
    expect(() => parseArgs(["--ambiguous", "auto"])).toThrow('--ambiguous must be "narrow" or "wide", got: auto');
  });

  test("--manifest carries the path through untouched", () => {
    expect(parseArgs(["--manifest", "/home/example/m.json"]).options.manifestFlag).toBe("/home/example/m.json");
    expect(() => parseArgs(["--manifest"])).toThrow("missing value for --manifest");
  });

  test("--detect is a bare flag", () => {
    expect(parseArgs(["--detect"]).options.detect).toBe(true);
  });

  test("the last occurrence of a flag wins", () => {
    expect(parseArgs(["--glyphs", "ascii", "--glyphs", "unicode"]).options.glyphs.tier).toBe("unicode");
    expect(parseArgs(["--widths", "80", "--widths", "116"]).options.widths).toEqual([116]);
    expect(parseArgs(["--corpus", "a", "--corpus", "b"]).corpus).toBe("b");
  });

  test("the two bundled gate invocations parse to what those gates measure", () => {
    // `package.json`'s `sweep` script, called bare and with `-- --glyphs ascii`.
    expect(parseArgs([]).options.glyphs.tier).toBe("unicode");
    const ascii = parseArgs(["--glyphs", "ascii"]).options;
    expect(ascii.glyphs.tier).toBe("ascii");
    expect(ascii.widths).toEqual([80, 100, 116, 160, 346]);
    expect(ascii.detect).toBe(false);
  });
});

// Invariant 2. Separating "parse" from "apply" here makes both ratchets silently no-op
// and therefore **permanently green** — the worst failure mode a ratchet has.
describe("parseArgs: --max-orphans / --max-over-indent turn detection on (WP-4 invariant 2)", () => {
  test("--max-orphans sets both the threshold and detect", () => {
    const { options } = parseArgs(["--max-orphans", "12"]);
    expect(options.maxOrphans).toBe(12);
    expect(options.detect).toBe(true);
  });

  test("--max-over-indent sets both the threshold and detect", () => {
    const { options } = parseArgs(["--max-over-indent", "40"]);
    expect(options.maxOverIndent).toBe(40);
    expect(options.detect).toBe(true);
  });

  test("a threshold of 0 is legal — it is a ratchet value, not a missing one", () => {
    const { options } = parseArgs(["--max-orphans", "0", "--max-over-indent", "0"]);
    expect(options.maxOrphans).toBe(0);
    expect(options.maxOverIndent).toBe(0);
    expect(options.detect).toBe(true);
  });

  test("a negative or missing threshold throws", () => {
    expect(() => parseArgs(["--max-orphans", "-1"])).toThrow("--max-orphans must be a non-negative number, got: -1");
    expect(() => parseArgs(["--max-orphans"])).toThrow("--max-orphans must be a non-negative number, got: undefined");
    expect(() => parseArgs(["--max-over-indent", "x"])).toThrow(
      "--max-over-indent must be a non-negative number, got: x",
    );
  });
});

// A CLI contract with archived-run consequences: an archived command line must keep
// meaning what it meant. Tightening this is a decision to take explicitly, not a side
// effect of a refactor — so it is pinned rather than left to be "cleaned up".
describe("parseArgs silently ignores unknown arguments (WP-4)", () => {
  test("an unrecognized flag changes nothing and does not consume the token after it", () => {
    const { corpus, options } = parseArgs(["--bogus", "--all", "-x", "positional"]);
    expect(corpus).toBe("all");
    expect(options.all).toBe(true);
    expect(options.widths).toEqual([80, 100, 116, 160, 346]);
  });

  test("a bare positional argument is ignored — it is not read as a corpus name", () => {
    expect(parseArgs(["regressions"]).corpus).toBe("all");
  });
});

// Invariant 4. `parseWidths` dedupes with `[...new Set(widths)]`, which preserves
// insertion order, and `sweepCorpus` iterates `options.widths` in exactly that order.
// The order decides **which file-width lands in `overflow[0]`** and the `line` recorded
// on each `DetectEntry`; sorting the widths "for tidiness" rewrites archived records.
describe("first-seen width order survives parse and sweep (WP-4 invariant 4)", () => {
  test("parseWidths dedupes without sorting", () => {
    expect(parseWidths("346,80,346,116,80")).toEqual([346, 80, 116]);
    expect(parseArgs(["--widths", "160,40,160"]).options.widths).toEqual([160, 40]);
  });

  test("the sweep reports overflow in the order the widths were given, not in numeric order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-width-order-"));
    try {
      // A nineteen-column table: below its minimum feasible width the allocator has
      // nowhere left to shrink and it overflows **by design** (src/AGENTS.md's
      // "many-column tables exceed the target width"), so every width swept below
      // overflows and the recorded order is the only variable. A long unbreakable
      // token would not do — those are hard-split losslessly and never overflow.
      const columns = 19;
      const header = `| ${Array.from({ length: columns }, (_, i) => `col${i}`).join(" | ")} |`;
      const rule = `|${" --- |".repeat(columns)}`;
      const row = `| ${Array.from({ length: columns }, (_, i) => `value${i}`).join(" | ")} |`;
      await writeFile(join(dir, "table.md"), `# t\n\n${header}\n${rule}\n${row}\n`);
      const spec: CorpusSpec = { name: "order", root: dir, walkAll: true };
      const base: SweepOptions = { widths: [], all: false, glyphs: UNICODE_GLYPHS, detect: false };

      const ascending = await sweepCorpus(spec, { ...base, widths: [40, 60, 80] });
      expect(ascending.overflow.map((entry) => entry.targetWidth)).toEqual([40, 60, 80]);

      const asGiven = await sweepCorpus(spec, { ...base, widths: [80, 40, 60] });
      expect(asGiven.overflow.map((entry) => entry.targetWidth)).toEqual([80, 40, 60]);
      expect(asGiven.overflow[0]?.targetWidth).toBe(80);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Invariant 5. The two shapes are different **on purpose**: a file that could not be read
// failed once, for the whole file, so no width belongs in its message; a render that threw
// failed at one width and the width is the diagnostic. Unifying them rewrites archived
// error text.
describe("the two error-string shapes are distinct (WP-4 invariant 5)", () => {
  test("a file-read failure is reported unprefixed", async () => {
    if (process.getuid?.() === 0) return; // root can read a 000-mode file; nothing to assert
    const dir = await mkdtemp(join(tmpdir(), "mdview-unreadable-"));
    try {
      const file = join(dir, "locked.md");
      await writeFile(file, "# locked\n");
      await chmod(file, 0o000);
      const result = await sweepCorpus(
        { name: "unreadable", root: dir, walkAll: true },
        { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false },
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).not.toMatch(/^width /);
      expect(result.errors[0]?.message).toMatch(/EACCES|permission denied/i);
      // The file never reached a render, so it contributed no combos.
      expect(result.combos).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a render failure is reported with a `width N: ` prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-render-throw-"));
    try {
      await writeFile(join(dir, "note.md"), "---\ntitle: t\n---\n\n# heading\n\nprose\n");
      const result = await sweepCorpus(
        { name: "throwing", root: dir, walkAll: true },
        // An infinite width makes the frontmatter/`hr` rule's `String.prototype.repeat`
        // throw — a real render failure, reached through the ordinary path.
        { widths: [Infinity], all: false, glyphs: UNICODE_GLYPHS, detect: false },
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message.startsWith("width Infinity: ")).toBe(true);
      // The combo was counted before the render threw.
      expect(result.combos).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Invariant 6. `shearsUnmapped += foundOrphans.length` adds the **orphan** count, not a
// shear count, when the block-end probe could not be aligned for that document. It reads
// like a bug; it is the recorded metric, and the figures in the private archive were taken
// with it. The fixture below is a document whose items end in an escaped `\*`, which
// swallows the probe character and defeats the alignment — at width 52 it carries three
// orphans and zero shears, so the three possible readings (orphans / shears / file-widths)
// are all distinguishable.
describe("shearsUnmapped accumulates the orphan count (WP-4 invariant 6)", () => {
  test("an unmapped document contributes its orphan count, not its shear count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-unmapped-"));
    try {
      const item = (n: number) =>
        `- item ${n} carries a reasonably long body of prose so that it wraps at a narrow width ` +
        `and ends escaped \\*\n\n  a second paragraph in item ${n}, also long enough that it wraps ` +
        `somewhere sensible here\n`;
      await writeFile(join(dir, "unmapped.md"), `${[1, 2, 3].map(item).join("\n")}\n`);
      const result = await sweepCorpus(
        { name: "unmapped", root: dir, walkAll: true },
        { widths: [52], all: false, glyphs: UNICODE_GLYPHS, detect: true },
      );
      expect(result.orphans).toHaveLength(1);
      expect(result.orphans[0]?.count).toBe(3);
      expect(result.shears).toEqual([]);
      expect(result.shearsUnmapped).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The four `CorpusResult` states are distinct, and one of the distinctions is a hardcoded
// `elapsedSeconds: 0` on the missing-root state where every other path measures wall time
// (WP-4 replaced the four duplicated constructions with a factory, which is exactly the
// change that could normalise that away).
describe("the missing-root state reports a hardcoded elapsedSeconds of 0 (WP-4)", () => {
  test("a corpus whose root does not exist skips with zero elapsed and zero symlink disclosure", async () => {
    const result = await sweepCorpus(
      { name: "absent", root: join(tmpdir(), "mdview-no-such-root-ever"), walkAll: true },
      { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: true },
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/^corpus root not found: /);
    expect(result.elapsedSeconds).toBe(0);
    expect(result.filesScanned).toBe(0);
    expect(result.combos).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.symlinkedDirsSkipped).toBe(0);
  });

  test("the other two zero-file states do measure elapsed time", async () => {
    const walkDir = await mkdtemp(join(tmpdir(), "mdview-empty-walk-"));
    const globDir = await mkdtemp(join(tmpdir(), "mdview-empty-glob-"));
    try {
      await writeFile(join(walkDir, "not-markdown.txt"), "x\n");
      await writeFile(join(globDir, "note.md"), "# n\n");
      const options: SweepOptions = { widths: [80], all: false, glyphs: UNICODE_GLYPHS, detect: false };
      const walked = await sweepCorpus({ name: "no-md", root: walkDir, walkAll: true }, options);
      const globbed = await sweepCorpus(
        { name: "no-match", root: globDir, globs: ["*.nope"], walkAll: false },
        options,
      );
      expect(walked.skipped).toBe(true);
      expect(walked.elapsedSeconds).toBeGreaterThan(0);
      expect(globbed.skipped).toBe(false);
      expect(globbed.elapsedSeconds).toBeGreaterThan(0);
    } finally {
      await rm(walkDir, { recursive: true, force: true });
      await rm(globDir, { recursive: true, force: true });
    }
  });
});

// The colour axis's CLI half (WP-1, `plans/own-the-token-walk.md`). The axis itself —
// the two children, the digests and the join — is `tests/colour-axis.test.ts`; what is
// pinned here is the flag surface, the passthrough that keeps both children looking at
// the same population, and the printed line's three buckets.
describe("parseArgs: the colour axis flags (WP-1)", () => {
  test("the default is off, and every existing invocation is therefore unchanged", () => {
    const { options } = parseArgs([]);
    expect(options.colourMode).toBe("off");
    expect(options.colourChild).toBeUndefined();
    expect(options.maxCharDiff).toBeUndefined();
    expect(options.maxSgr).toBeUndefined();
  });

  test("--colour-mode takes on, off or both and rejects anything else", () => {
    expect(parseArgs(["--colour-mode", "on"]).options.colourMode).toBe("on");
    expect(parseArgs(["--colour-mode", "off"]).options.colourMode).toBe("off");
    expect(parseArgs(["--colour-mode", "both"]).options.colourMode).toBe("both");
    expect(() => parseArgs(["--colour-mode", "auto"])).toThrow(
      '--colour-mode must be "on", "off" or "both", got: auto',
    );
    expect(() => parseArgs(["--colour-mode"])).toThrow(
      '--colour-mode must be "on", "off" or "both", got: undefined',
    );
  });

  test("the flag is not spelled --color, and neither spelling is recognised", () => {
    // `has-flag`, which `supports-color` and `@colors/colors` both consult, scans the
    // whole of `process.argv`. A harness flag spelled `--color` or `--no-color` would
    // therefore flip the ambient colour decision of the renderer under measurement — the
    // instrument would be changing the thing it is reading. Pinned as a contract, not a
    // style preference: this parser must never learn either spelling.
    expect(parseArgs(["--color"]).options.colourMode).toBe("off");
    expect(parseArgs(["--no-color"]).options.colourMode).toBe("off");
  });

  test("--max-char-diff and --max-sgr set a threshold and turn the axis on", () => {
    // The `--max-orphans` precedent: a threshold for a measurement that is not being
    // taken is a gate that cannot fail.
    const charDiff = parseArgs(["--max-char-diff", "62"]).options;
    expect(charDiff.maxCharDiff).toBe(62);
    expect(charDiff.colourMode).toBe("both");
    const sgr = parseArgs(["--max-sgr", "20"]).options;
    expect(sgr.maxSgr).toBe(20);
    expect(sgr.colourMode).toBe("both");
  });

  test("a ratchet of 0 is legal, and a negative or missing one throws", () => {
    expect(parseArgs(["--max-char-diff", "0"]).options.maxCharDiff).toBe(0);
    expect(parseArgs(["--max-sgr", "0"]).options.maxSgr).toBe(0);
    expect(() => parseArgs(["--max-char-diff", "-1"])).toThrow(
      "--max-char-diff must be a non-negative number, got: -1",
    );
    expect(() => parseArgs(["--max-sgr"])).toThrow("--max-sgr must be a non-negative number, got: undefined");
  });

  test("--colour-child is internal, validated, and never set by any other flag", () => {
    expect(parseArgs(["--colour-child", "on"]).options.colourChild).toBe("on");
    expect(parseArgs(["--colour-child", "off"]).options.colourChild).toBe("off");
    expect(() => parseArgs(["--colour-child", "both"])).toThrow(
      '--colour-child must be "on" or "off", got: both',
    );
    expect(parseArgs(["--colour-mode", "both"]).options.colourChild).toBeUndefined();
  });
});

describe("stripColourModeArgs: what each child is handed (WP-1)", () => {
  test("only --colour-mode and its value are removed; every measurement flag survives", () => {
    expect(
      stripColourModeArgs([
        "--manifest",
        "example/manifest.json",
        "--colour-mode",
        "both",
        "--widths",
        "80,100",
        "--glyphs",
        "ascii",
        "--corpus",
        "repo",
        "--all",
      ]),
    ).toEqual([
      "--manifest",
      "example/manifest.json",
      "--widths",
      "80,100",
      "--glyphs",
      "ascii",
      "--corpus",
      "repo",
      "--all",
    ]);
  });

  test("an argv without the flag is passed through unchanged", () => {
    expect(stripColourModeArgs(["--widths", "80"])).toEqual(["--widths", "80"]);
    expect(stripColourModeArgs([])).toEqual([]);
  });
});

describe("printColourAxis prints all three buckets and both totals (WP-1)", () => {
  const axis = {
    corpus: "repo",
    combos: 110,
    identical: 38,
    charDiffOnly: 52,
    sgrOnly: 10,
    both: 10,
    charDiff: 62,
    sgrAny: 20,
    errors: [],
    elapsedSeconds: 2.84,
  };

  test("the line carries the disjoint buckets and the overlapping totals side by side", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis(axis);
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toBe(
      "[repo] colour-axis combos=110 charDiff=62 (charDiffOnly=52 both=10) " +
        "sgrAny=20 (sgrOnly=10 both=10) identical=38 errors=0 elapsed=2.8s",
    );
    // The reason both are printed: `sgrOnly` is not the unwanted-SGR count and must not
    // be readable as one. `sgrAny` is, and it is on the same line.
    expect(captured[0]).toContain("sgrAny=20");
    expect(captured[0]).toContain("sgrOnly=10");
  });

  test("an instrument fault is printed under the line, not folded into a bucket", () => {
    const originalLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      printColourAxis({
        ...axis,
        errors: [
          {
            corpus: "repo",
            path: "/example/a.md",
            width: 80,
            message: "present in the colourless stream but missing from the colour stream",
          },
        ],
      });
    } finally {
      console.log = originalLog;
    }
    expect(captured[0]).toContain("errors=1");
    expect(captured[1]).toBe(
      "  colour-axis error width=80 /example/a.md: " +
        "present in the colourless stream but missing from the colour stream",
    );
  });
});
