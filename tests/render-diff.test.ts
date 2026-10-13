import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// WP-R1 (`plans/post-refactor-code-quality-remediation.md`) split the harness into four
// modules without changing a line of its behaviour: the CLI kept its flags, its baseline
// I/O, its pairing and its printing; revision materialization/loading, the pure diff
// classification, and the shared hash primitive each got their own home. These four import
// lines are the same surface this file always exercised.
import {
  assertOutsideRepo,
  loadBaseline,
  pairRecords,
  parseArgs,
  selectCorpora,
  writeBaseline,
  type BaselineArtifact,
} from "../scripts/render-diff";
import {
  classifyDiffs,
  computeComboRecord,
  diffCombo,
  extractCodeContent,
  type PairedCombo,
} from "../scripts/diff-classify";
import {
  loadRevision,
  type ComboRecord,
  type Measurer,
  type RevisionHandle,
} from "../scripts/revision";
import { sha256Hex } from "../scripts/hash";
import { findContinuationOverIndent, findListOrphans } from "../scripts/measure/detectors";
import { findFirstOverflow } from "../scripts/measure/overflow";
import { NARROW_MEASURE, WIDE_MEASURE } from "../scripts/measure/width";
import { renderSync } from "./helpers/render";

const REPO_ROOT = process.cwd();

function makeRecord(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    file: "example/doc.md",
    width: 80,
    tier: "unicode",
    ambiguous: "narrow",
    textSha: "same-text",
    codeContentSha: "same-code",
    codeRanges: [[3, 5]],
    detectors: { orphans: 0, overIndent: 0, columnZero: 0 },
    overflowed: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Channel primitives: sha256Hex, extractCodeContent, diffCombo.
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  test("is deterministic and content-sensitive", () => {
    expect(sha256Hex("alpha")).toBe(sha256Hex("alpha"));
    expect(sha256Hex("alpha")).not.toBe(sha256Hex("beta"));
  });
});

describe("extractCodeContent", () => {
  test("returns empty string when there are no ranges", () => {
    expect(extractCodeContent("a\nb\nc", [])).toBe("");
  });

  test("extracts one inclusive 1-based range", () => {
    expect(extractCodeContent("a\nb\nc\nd", [[2, 3]])).toBe("b\nc");
  });

  test("concatenates multiple ranges in document order", () => {
    expect(
      extractCodeContent("a\nb\nc\nd\ne", [
        [1, 1],
        [4, 5],
      ]),
    ).toBe("a\nd\ne");
  });
});

describe("diffCombo", () => {
  test("reports no channels for identical records", () => {
    const record = makeRecord();
    expect(diffCombo(record, { ...record })).toEqual([]);
  });

  test("isolates a textSha-only change", () => {
    const before = makeRecord({ textSha: "x" });
    const after = makeRecord({ textSha: "y" });
    expect(diffCombo(before, after)).toEqual(["textSha"]);
  });

  test("isolates a codeContentSha-only change", () => {
    const before = makeRecord({ codeContentSha: "x" });
    const after = makeRecord({ codeContentSha: "y" });
    expect(diffCombo(before, after)).toEqual(["codeContentSha"]);
  });

  test("isolates a codeRanges shift even when everything else is identical", () => {
    const before = makeRecord({ codeRanges: [[3, 5]] });
    const after = makeRecord({ codeRanges: [[4, 6]] });
    expect(diffCombo(before, after)).toEqual(["codeRanges"]);
  });

  test("isolates a detectors-only change", () => {
    const before = makeRecord({ detectors: { orphans: 0, overIndent: 0, columnZero: 0 } });
    const after = makeRecord({ detectors: { orphans: 1, overIndent: 0, columnZero: 0 } });
    expect(diffCombo(before, after)).toEqual(["detectors"]);
  });

  test("reports every channel that moved, not just the first", () => {
    const before = makeRecord();
    const after = makeRecord({
      textSha: "different",
      codeRanges: [[9, 9]],
      detectors: { orphans: 3, overIndent: 0, columnZero: 0 },
    });
    expect(diffCombo(before, after).sort()).toEqual(["codeRanges", "detectors", "textSha"]);
  });
});

// ---------------------------------------------------------------------------
// Classification: the class A/B/C taxonomy and the overflow ratchet.
// ---------------------------------------------------------------------------

describe("classifyDiffs", () => {
  test("expect a: identical records pass", () => {
    const record = makeRecord();
    const summary = classifyDiffs([{ before: record, after: { ...record } }], "a");
    expect(summary.ok).toBe(true);
    expect(summary.diffedCombos).toBe(0);
  });

  test("expect a: any non-C diff is disallowed and fails the run", () => {
    const before = makeRecord({ textSha: "x" });
    const after = makeRecord({ textSha: "y" });
    const summary = classifyDiffs([{ before, after }], "a");
    expect(summary.disallowed).toHaveLength(1);
    expect(summary.classC).toHaveLength(0);
    expect(summary.ok).toBe(false);
  });

  test("a codeContentSha diff is class C and forbidden under both expect=a and expect=b", () => {
    const before = makeRecord({ codeContentSha: "x" });
    const after = makeRecord({ codeContentSha: "y" });
    for (const expectClass of ["a", "b"] as const) {
      const summary = classifyDiffs([{ before, after }], expectClass);
      expect(summary.classC).toHaveLength(1);
      // Filed under classC, never double-counted as disallowed/allowedB.
      expect(summary.disallowed).toHaveLength(0);
      expect(summary.allowedB).toHaveLength(0);
      expect(summary.ok).toBe(false);
    }
  });

  test("expect b: a non-C diff is enumerated as allowed and the run passes when overflow does not rise", () => {
    const before = makeRecord({ textSha: "x", overflowed: false });
    const after = makeRecord({ textSha: "y", overflowed: false });
    const summary = classifyDiffs([{ before, after }], "b");
    expect(summary.allowedB).toHaveLength(1);
    expect(summary.disallowed).toHaveLength(0);
    expect(summary.ok).toBe(true);
  });

  test("expect b: fails when the overflow count rises for a (width, tier, ambiguous) group", () => {
    const before = makeRecord({ width: 80, tier: "unicode", ambiguous: "narrow", overflowed: false });
    const after = makeRecord({
      width: 80,
      tier: "unicode",
      ambiguous: "narrow",
      overflowed: true,
      textSha: "moved-too",
    });
    const summary = classifyDiffs([{ before, after }], "b");
    expect(summary.overflowRegressions).toEqual([
      { width: 80, tier: "unicode", ambiguous: "narrow", before: 0, after: 1 },
    ]);
    expect(summary.ok).toBe(false);
  });

  test("expect b: a mix of overflowing and clean combos is non-increasing when the count holds or falls", () => {
    const groupA: PairedCombo = {
      before: makeRecord({ file: "a.md", overflowed: true, textSha: "a-before" }),
      after: makeRecord({ file: "a.md", overflowed: false, textSha: "a-after" }),
    };
    const groupB: PairedCombo = {
      before: makeRecord({ file: "b.md", overflowed: true, textSha: "b-before" }),
      after: makeRecord({ file: "b.md", overflowed: true, textSha: "b-after" }),
    };
    const summary = classifyDiffs([groupA, groupB], "b");
    expect(summary.overflowRegressions).toEqual([]);
    expect(summary.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The detector ratchet (WP-3). Until this package a `detectors` diff under
  // `--expect b` landed in `allowedB` and its *direction* was never checked, so a
  // run that tripled the orphan count reported `ok: true`. The plan requires all
  // three counts to be non-increasing at every package; this is the check that
  // makes the harness able to see it.
  // -------------------------------------------------------------------------

  test("expect b: fails when a detector count rises for a (width, tier, ambiguous) group", () => {
    const before = makeRecord({ detectors: { orphans: 2, overIndent: 1, columnZero: 0 } });
    const after = makeRecord({
      textSha: "moved",
      detectors: { orphans: 5, overIndent: 1, columnZero: 0 },
    });
    const summary = classifyDiffs([{ before, after }], "b");
    // The diff itself is still enumerated as allowed under b — it is the *direction*
    // that fails the run, which is exactly the distinction that was missing.
    expect(summary.allowedB).toHaveLength(1);
    expect(summary.detectorRegressions).toEqual([
      { width: 80, tier: "unicode", ambiguous: "narrow", detector: "orphans", before: 2, after: 5 },
    ]);
    expect(summary.ok).toBe(false);
  });

  test("expect b: each of the three detectors is ratcheted independently", () => {
    const before = makeRecord({ detectors: { orphans: 4, overIndent: 4, columnZero: 4 } });
    const after = makeRecord({
      textSha: "moved",
      detectors: { orphans: 1, overIndent: 9, columnZero: 7 },
    });
    const summary = classifyDiffs([{ before, after }], "b");
    expect(summary.detectorRegressions.map((r) => r.detector).sort()).toEqual(["columnZero", "overIndent"]);
    expect(summary.ok).toBe(false);
  });

  test("expect b: the ratchet is over the group's summed hits, not per file", () => {
    // One file gets worse, another improves by more. The group is non-increasing, so the
    // run passes — the same shape the overflow ratchet already has, one granularity finer
    // (that one counts *combos that overflowed*, a per-file boolean, not overflowing lines).
    const worse: PairedCombo = {
      before: makeRecord({ file: "a.md", textSha: "a1", detectors: { orphans: 1, overIndent: 0, columnZero: 0 } }),
      after: makeRecord({ file: "a.md", textSha: "a2", detectors: { orphans: 4, overIndent: 0, columnZero: 0 } }),
    };
    const better: PairedCombo = {
      before: makeRecord({ file: "b.md", textSha: "b1", detectors: { orphans: 9, overIndent: 0, columnZero: 0 } }),
      after: makeRecord({ file: "b.md", textSha: "b2", detectors: { orphans: 2, overIndent: 0, columnZero: 0 } }),
    };
    const summary = classifyDiffs([worse, better], "b");
    expect(summary.detectorRegressions).toEqual([]);
    expect(summary.ok).toBe(true);
  });

  test("the detector ratchet is grouped by (width, tier, ambiguous), not summed across them", () => {
    const narrow: PairedCombo = {
      before: makeRecord({ file: "a.md", ambiguous: "narrow", textSha: "n1", detectors: { orphans: 9, overIndent: 0, columnZero: 0 } }),
      after: makeRecord({ file: "a.md", ambiguous: "narrow", textSha: "n2", detectors: { orphans: 0, overIndent: 0, columnZero: 0 } }),
    };
    const wide: PairedCombo = {
      before: makeRecord({ file: "a.md", ambiguous: "wide", textSha: "w1", detectors: { orphans: 0, overIndent: 0, columnZero: 0 } }),
      after: makeRecord({ file: "a.md", ambiguous: "wide", textSha: "w2", detectors: { orphans: 1, overIndent: 0, columnZero: 0 } }),
    };
    const summary = classifyDiffs([narrow, wide], "b");
    expect(summary.detectorRegressions).toEqual([
      { width: 80, tier: "unicode", ambiguous: "wide", detector: "orphans", before: 0, after: 1 },
    ]);
    expect(summary.ok).toBe(false);
  });

  test("expect a: the detector ratchet still fires, and agrees with the disallowed verdict", () => {
    // Redundant under a — the diff is already disallowed — so this pins that the two
    // cannot disagree rather than adding a second reason to fail.
    const before = makeRecord({ detectors: { orphans: 0, overIndent: 0, columnZero: 0 } });
    const after = makeRecord({ detectors: { orphans: 1, overIndent: 0, columnZero: 0 } });
    const summary = classifyDiffs([{ before, after }], "a");
    expect(summary.disallowed).toHaveLength(1);
    expect(summary.detectorRegressions).toHaveLength(1);
    expect(summary.ok).toBe(false);
  });

  test("expect a: the overflow ratchet is not evaluated (it only governs class B)", () => {
    const before = makeRecord({ overflowed: false });
    const after = makeRecord({ overflowed: true, textSha: "irrelevant-here" });
    const summary = classifyDiffs([{ before, after }], "a");
    expect(summary.overflowRegressions).toEqual([]);
    // Still fails, but for the textSha diff being disallowed under a, not overflow.
    expect(summary.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The blocker this addendum exists for: "a differ that reports 'no
  // differences' because it is comparing nothing is the classic failure of
  // this exact tool, and a green run looks identical either way." Pin the
  // exact repro the orchestrator reproduced directly against classifyDiffs.
  // -------------------------------------------------------------------------

  test("an empty comparison is NOT ok by default — classifyDiffs([]) must not report a pass", () => {
    const summary = classifyDiffs([], "a");
    expect(summary.emptyComparison).toBe(true);
    expect(summary.ok).toBe(false);
    expect(summary.totalCombos).toBe(0);
  });

  test("an empty comparison stays a failure under expect=b too", () => {
    const summary = classifyDiffs([], "b");
    expect(summary.emptyComparison).toBe(true);
    expect(summary.ok).toBe(false);
  });

  test("an empty comparison passes only with the explicit --allow-empty opt-in", () => {
    const summary = classifyDiffs([], "a", { allowEmpty: true });
    expect(summary.emptyComparison).toBe(true);
    expect(summary.ok).toBe(true);
    expect(summary.totalCombos).toBe(0);
  });

  test("emptyComparison is false, and normal classification applies, once there is at least one pair", () => {
    const record = makeRecord();
    const summary = classifyDiffs([{ before: record, after: { ...record } }], "a");
    expect(summary.emptyComparison).toBe(false);
    expect(summary.ok).toBe(true);
  });
});

describe("pairRecords", () => {
  test("pairs matching (file, width, tier, ambiguous) keys", () => {
    const before = [makeRecord({ file: "a.md" }), makeRecord({ file: "b.md" })];
    const after = [makeRecord({ file: "a.md" }), makeRecord({ file: "b.md" })];
    const result = pairRecords(before, after);
    expect(result.pairs).toHaveLength(2);
    expect(result.unpairedBefore).toBe(0);
    expect(result.unpairedAfter).toBe(0);
  });

  test("reports — rather than silently drops — a before record with no after counterpart", () => {
    const before = [makeRecord({ file: "a.md" }), makeRecord({ file: "only-before.md" })];
    const after = [makeRecord({ file: "a.md" })];
    const result = pairRecords(before, after);
    expect(result.pairs).toHaveLength(1);
    expect(result.unpairedBefore).toBe(1);
    expect(result.unpairedAfter).toBe(0);
  });

  test("reports an after record with no before counterpart", () => {
    const before = [makeRecord({ file: "a.md" })];
    const after = [makeRecord({ file: "a.md" }), makeRecord({ file: "only-after.md" })];
    const result = pairRecords(before, after);
    expect(result.pairs).toHaveLength(1);
    expect(result.unpairedBefore).toBe(0);
    expect(result.unpairedAfter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Baseline artifact: the outside-the-repo write guard (constraint 5) and the
// round-trip through JSON.
// ---------------------------------------------------------------------------

describe("assertOutsideRepo", () => {
  test("throws for a path inside the repo", () => {
    expect(() => assertOutsideRepo(join(REPO_ROOT, "x.json"), REPO_ROOT)).toThrow(/inside the repo tree/);
  });

  test("throws for the repo root itself", () => {
    expect(() => assertOutsideRepo(REPO_ROOT, REPO_ROOT)).toThrow(/inside the repo tree/);
  });

  test("does not throw for a path outside the repo", () => {
    expect(() => assertOutsideRepo(join(tmpdir(), "render-diff-test.json"), REPO_ROOT)).not.toThrow();
  });
});

describe("baseline artifact", () => {
  test("writeBaseline refuses an in-tree path and writes nothing", async () => {
    const target = join(REPO_ROOT, "render-diff-baseline-guard-test.json");
    const artifact: BaselineArtifact = {
      version: 1,
      generatedAt: new Date().toISOString(),
      revisionLabel: "test",
      manifestPath: "example/manifest.json",
      combos: [],
      errors: [],
    };
    await expect(writeBaseline(target, REPO_ROOT, artifact)).rejects.toThrow(/inside the repo tree/);
    const exists = await stat(target)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("round-trips combos through a path outside the repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-baseline-"));
    try {
      const target = join(dir, "baseline.json");
      const combos = [makeRecord({ file: "a.md" }), makeRecord({ file: "b.md", width: 100 })];
      const artifact: BaselineArtifact = {
        version: 1,
        generatedAt: new Date().toISOString(),
        revisionLabel: "test-revision",
        manifestPath: "example/manifest.json",
        combos,
        errors: [],
      };
      await writeBaseline(target, REPO_ROOT, artifact);
      const loaded = await loadBaseline(target);
      expect(loaded.combos).toEqual(combos);
      expect(loaded.revisionLabel).toBe("test-revision");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadBaseline rejects an unsupported version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-baseline-"));
    try {
      const target = join(dir, "bad.json");
      await Bun.write(target, JSON.stringify({ version: 2, combos: [] }));
      await expect(loadBaseline(target)).rejects.toThrow(/unsupported version/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loadBaseline rejects a missing combos array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-baseline-"));
    try {
      const target = join(dir, "bad.json");
      await Bun.write(target, JSON.stringify({ version: 1 }));
      await expect(loadBaseline(target)).rejects.toThrow(/missing a "combos" array/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI arg parsing.
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("defaults: expect a, all five widths, both tiers, both ambiguous modes", () => {
    const options = parseArgs([]);
    expect(options.expect).toBe("a");
    expect(options.widths).toEqual([80, 100, 116, 160, 346]);
    expect(options.tiers).toEqual(["unicode", "ascii"]);
    expect(options.ambiguous).toEqual(["narrow", "wide"]);
    expect(options.corpus).toBe("all");
    expect(options.all).toBe(false);
  });

  test("parses every flag this WP's CLI surface documents", () => {
    const options = parseArgs([
      "--rev-a",
      "HEAD",
      "--rev-b",
      ".",
      "--expect",
      "b",
      "--widths",
      "80,100",
      "--tiers",
      "ascii",
      "--ambiguous",
      "wide",
      "--corpus",
      "regressions",
      "--all",
      "--limit",
      "10",
      "--manifest",
      "example/manifest.json",
    ]);
    expect(options.revA).toBe("HEAD");
    expect(options.revB).toBe(".");
    expect(options.expect).toBe("b");
    expect(options.widths).toEqual([80, 100]);
    expect(options.tiers).toEqual(["ascii"]);
    expect(options.ambiguous).toEqual(["wide"]);
    expect(options.corpus).toBe("regressions");
    expect(options.all).toBe(true);
    expect(options.limit).toBe(10);
    expect(options.manifestFlag).toBe("example/manifest.json");
  });

  test("parses --baseline and --against", () => {
    expect(parseArgs(["--baseline", "/tmp/x.json"]).baselineOut).toBe("/tmp/x.json");
    expect(parseArgs(["--against", "/tmp/x.json"]).against).toBe("/tmp/x.json");
  });

  test("rejects an --expect value other than a or b (class C is never an expectation)", () => {
    expect(() => parseArgs(["--expect", "c"])).toThrow();
  });

  test("rejects an unrecognized argument rather than silently ignoring it", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unrecognized/);
  });
});

// ---------------------------------------------------------------------------
// loadRevision: the two-revision mechanism itself.
// ---------------------------------------------------------------------------

describe("loadRevision", () => {
  // Since WP-9 of `plans/mdview-rust-port.md` the only kind is `rust:<dir|ref>`; the TypeScript
  // `<dir|ref>`/`ts-server:` kinds and their materialization tests are at `TS_BASELINE` (`c097c66`).
  test("a spec without the rust: prefix is refused, naming the removal", async () => {
    await expect(loadRevision(REPO_ROOT, REPO_ROOT)).rejects.toThrow(/not a rust:<dir\|ref> revision/);
  });

  test("rejects a rust: spec that is neither an existing directory nor a resolvable git ref", async () => {
    await expect(loadRevision("rust:definitely-not-a-ref-or-directory", REPO_ROOT)).rejects.toThrow(
      /neither an existing directory nor a resolvable git ref/,
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation proof: each of the four channels moves independently, and the
// class-C scenario — a mutation strictly inside a fence — is caught by
// codeContentSha while the width gate (`findFirstOverflow`) cannot see it at
// all. These fixtures are constructed markdown, never a `src/` edit.
// ---------------------------------------------------------------------------

// Since WP-1 of `plans/mdview-rust-port.md` rendering (the handle, async) and measurement
// (the measurer) are separate seams; this pair keeps the original direct wiring of both.
function directHandle(): RevisionHandle {
  return {
    label: "direct",
    kind: "rust",
    render: async (req) => renderSync(req.source, req.width, { tier: req.tier, ambiguous: req.ambiguous, policy: "P0" }),
    close: async () => {},
  };
}

function directMeasurer(): Measurer {
  const measure = { narrow: NARROW_MEASURE, wide: WIDE_MEASURE };
  return {
    detect: (text, width, codeRanges, ambiguous) => ({
      orphans: findListOrphans(text, width, { codeRanges, measure: measure[ambiguous] }).length,
      overIndent: findContinuationOverIndent(text, { codeRanges, measure: measure[ambiguous] }).length,
      columnZero: 0,
    }),
    overflowed: (text, width, codeRanges, ambiguous) => findFirstOverflow(text, width, codeRanges, measure[ambiguous]) !== null,
    scan: () => [],
    styleCodes: new Set(),
    echoRangeCount: () => 0,
    lexBody: () => [],
  };
}

/** The pre-WP-1 positional call shape, kept so the mutation proofs below read unchanged. */
async function comboRecord(
  handle: RevisionHandle,
  file: string,
  source: string,
  width: number,
  tier: "unicode" | "ascii",
  ambiguous: "narrow" | "wide",
) {
  return computeComboRecord(handle, directMeasurer(), { source, path: file, width, tier, ambiguous, policy: "P0", emoji: "default" });
}

describe("mutation proof — each channel is independently observable", () => {
  const handle = directHandle();
  const withFence = [
    "# Title",
    "",
    "Some prose before the fence.",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "More prose after the fence.",
  ].join("\n");

  test("channel 1 (textSha) — a prose-only edit moves textSha and leaves codeContentSha/codeRanges alone", async () => {
    const mutated = withFence.replace(
      "Some prose before the fence.",
      "Some DIFFERENT prose before the fence, still short.",
    );
    const before = (await comboRecord(handle, "f.md", withFence, 80, "unicode", "narrow")).record;
    const after = (await comboRecord(handle, "f.md", mutated, 80, "unicode", "narrow")).record;
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(before!.textSha).not.toBe(after!.textSha);
    expect(before!.codeContentSha).toBe(after!.codeContentSha);
    expect(before!.codeRanges).toEqual(after!.codeRanges);
  });

  test("channel 2 (codeContentSha, the class-C scenario) — a mutation strictly inside the fence moves codeContentSha while the width gate is blind to it", async () => {
    const mutated = withFence.replace("const answer = 42;", "const answer = 43;");
    const before = (await comboRecord(handle, "f.md", withFence, 80, "unicode", "narrow")).record!;
    const after = (await comboRecord(handle, "f.md", mutated, 80, "unicode", "narrow")).record!;

    expect(before.codeContentSha).not.toBe(after.codeContentSha);
    // The fence did not move, only its content did.
    expect(before.codeRanges).toEqual(after.codeRanges);
    // The width gate — the thing every bundled sweep and --check runs — cannot see
    // this at all: both renders fit comfortably inside 80 columns either way. This
    // is `scripts/AGENTS.md`'s "the sweep proves width, and only width" reproduced
    // as a unit test.
    expect(before.overflowed).toBe(false);
    expect(after.overflowed).toBe(false);
    expect(before.overflowed).toBe(after.overflowed);
    // The rendered bytes obviously differ too (this is not claiming textSha is
    // blind) — codeContentSha is the channel that would catch this even if a
    // reviewer only ever compared documents outside their fenced ranges.
    expect(before.textSha).not.toBe(after.textSha);
  });

  test("channel 3 (codeRanges) — pushing the fence down the document moves codeRanges even though the fence's own content is byte-identical", async () => {
    const shifted = withFence.replace(
      "Some prose before the fence.",
      "Some prose before the fence.\n\nAn extra paragraph that pushes the fence down.",
    );
    const before = (await comboRecord(handle, "f.md", withFence, 80, "unicode", "narrow")).record!;
    const after = (await comboRecord(handle, "f.md", shifted, 80, "unicode", "narrow")).record!;

    expect(before.codeRanges).not.toEqual(after.codeRanges);
    // The content the ranges bound is unchanged — only its position moved — so the
    // class-C channel must NOT fire on a pure reposition.
    expect(before.codeContentSha).toBe(after.codeContentSha);
  });

  test("channel 4 (detectors) — a known orphaned line moves the detectors channel; a fixed rendering clears it", () => {
    // Same fixtures as tests/detectors.test.ts's findListOrphans cases, exercised
    // through this harness's own `detect()` seam rather than the detector
    // directly, so the harness's wiring (not just the detector) is under test.
    const badRendered = [
      "    • alpha beta gamma delta epsilon zeta eta theta iota kappa",
      "      lambda",
      "      mu nu xi",
    ].join("\n");
    const goodRendered = ["    • alpha beta gamma delta epsilon zeta eta theta iota kappa", "      lambda mu nu xi"].join(
      "\n",
    );
    const width = 64;
    const badCounts = directMeasurer().detect(badRendered, width, [], "narrow");
    const goodCounts = directMeasurer().detect(goodRendered, width, [], "narrow");
    expect(badCounts.orphans).toBe(1);
    expect(goodCounts.orphans).toBe(0);
    expect(badCounts).not.toEqual(goodCounts);
  });
});

// ---------------------------------------------------------------------------
// Null run: the same revision rendered twice must produce zero diffs across
// every channel — the check that a "no differences" report is not simply a
// differ comparing nothing.
// ---------------------------------------------------------------------------

describe("null run — the same revision against itself", () => {
  test("zero channels differ across a small multi-file, multi-combo run", async () => {
    const handle = directHandle();
    const docs: Record<string, string> = {
      "one.md": "# One\n\nSome prose here.\n\n```js\nconst a = 1;\n```\n",
      "two.md": "# Two\n\n- an item\n- another item\n\n> a quote\n",
    };
    const widths = [80, 100];
    const tiers = ["unicode", "ascii"] as const;
    const ambiguous = ["narrow", "wide"] as const;
    const pairs: PairedCombo[] = [];
    for (const [file, source] of Object.entries(docs)) {
      for (const width of widths) {
        for (const tier of tiers) {
          for (const mode of ambiguous) {
            const before = (await comboRecord(handle, file, source, width, tier, mode)).record!;
            const after = (await comboRecord(handle, file, source, width, tier, mode)).record!;
            pairs.push({ before, after });
          }
        }
      }
    }
    expect(pairs).toHaveLength(2 * 2 * 2 * 2);
    const summary = classifyDiffs(pairs, "a");
    expect(summary.diffedCombos).toBe(0);
    expect(summary.classC).toHaveLength(0);
    expect(summary.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectCorpora: the other half of the "compared nothing, reported green"
// hole — refuse before rendering even starts, with the cause named, rather
// than silently handing back zero corpora for classifyDiffs to catch later.
// ---------------------------------------------------------------------------

describe("selectCorpora — refuses to hand back an empty selection silently", () => {
  test("every corpus root missing is a loud failure, naming every skip reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-manifest-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          generated: "",
          generator: "test",
          corpora: [{ name: "ghost", root: join(dir, "does-not-exist"), globs: ["**/*.md"] }],
        }),
      );
      const options = parseArgs(["--manifest", manifestPath, "--rev-a", ".", "--rev-b", "HEAD"]);
      await expect(selectCorpora(options)).rejects.toThrow(/every corpus .* was skipped/);
      await expect(selectCorpora(options)).rejects.toThrow(/ghost/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--allow-empty permits an all-skipped selection through, with an empty corpora list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-manifest-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          generated: "",
          generator: "test",
          corpora: [{ name: "ghost", root: join(dir, "does-not-exist"), globs: ["**/*.md"] }],
        }),
      );
      const options = parseArgs(["--manifest", manifestPath, "--allow-empty"]);
      const { corpora } = await selectCorpora(options);
      expect(corpora).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a glob-based corpus matching 0 files is always an error, never suppressible by --allow-empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-manifest-"));
    try {
      const root = join(dir, "root");
      await mkdir(root, { recursive: true });
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          generated: "",
          generator: "test",
          corpora: [{ name: "empty-glob", root, globs: ["*.md"] }],
        }),
      );
      const withoutAllowEmpty = parseArgs(["--manifest", manifestPath]);
      await expect(selectCorpora(withoutAllowEmpty)).rejects.toThrow(/matched 0 files/);
      const withAllowEmpty = parseArgs(["--manifest", manifestPath, "--allow-empty"]);
      await expect(selectCorpora(withAllowEmpty)).rejects.toThrow(/matched 0 files/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI-level regression pin for the exact repro the orchestrator reproduced
// directly against a real subprocess invocation of the script.
// ---------------------------------------------------------------------------

describe("CLI — the ghost-manifest repro exits non-zero", () => {
  test("a manifest whose only corpus root does not exist fails the whole run, not just a log line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "render-diff-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          version: 1,
          generated: "",
          generator: "test",
          corpora: [{ name: "ghost", root: "/nonexistent/path/does/not/exist", globs: ["**/*.md"] }],
        }),
      );
      const proc = Bun.spawnSync(
        [
          "bun",
          "run",
          "scripts/render-diff.ts",
          "--manifest",
          manifestPath,
          "--rev-a",
          "rust:.",
          "--rev-b",
          "rust:HEAD",
          "--widths",
          "80",
          "--tiers",
          "unicode",
          "--ambiguous",
          "narrow",
        ],
        { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
      );
      expect(proc.exitCode).not.toBe(0);
      const combined = `${proc.stdout.toString()}${proc.stderr.toString()}`;
      expect(combined).toMatch(/skipped|nothing to compare/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// WP-1 of `plans/retire-ts-parity-residue.md` retired the divergence registry and its
// attribution: under `--expect a` there is no exemption left, so every differing pair fails.
describe("expect=a disallows every differing pair", () => {
  test("a P0 textSha diff and a P2 D-C-shaped textSha/codeContentSha diff are each disallowed", () => {
    for (const pair of [
      { before: makeRecord({ textSha: "x" }), after: makeRecord({ textSha: "y" }) },
      { before: makeRecord({ policy: "P2", textSha: "x" }), after: makeRecord({ policy: "P2", textSha: "y", codeContentSha: "c2" }) },
    ] satisfies PairedCombo[]) {
      const summary = classifyDiffs([pair], "a");
      expect({ ok: summary.ok, disallowed: summary.disallowed.length, diffed: summary.diffedCombos }).toEqual({
        ok: false,
        disallowed: 1,
        diffed: 1,
      });
    }
  });
});

describe("dedupeCorpora", () => {
  test("a file a later corpus lists again is compared once, under the first", async () => {
    const { dedupeCorpora } = await import("../scripts/render-diff");
    const spec = (name: string) => ({ name }) as never;
    const result = dedupeCorpora(
      [
        { spec: spec("a"), files: ["/x/one.md", "/x/two.md"] },
        { spec: spec("b"), files: ["/y/link-to-one.md", "/x/three.md"] },
      ],
      (path) => (path === "/y/link-to-one.md" ? "/x/one.md" : path),
    );
    expect(result.dropped).toBe(1);
    expect(result.corpora.map((c) => c.files)).toEqual([["/x/one.md", "/x/two.md"], ["/x/three.md"]]);
  });
});
