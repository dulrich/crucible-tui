import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// WP-1 of `plans/mdview-rust-port.md`: the differential's new axes and kinds — the policy/emoji
// axes, D-C's channels, the non-vacuity requirement, the `ts-server:` transport and the stub
// `rust:` side — plus the byte-neutral `lexBody` extraction the `--input tokens` mode reads.
import {
  classifyDiffs,
  computeComboRecord,
  fencePrefixesOk,
  type PairedCombo,
} from "../scripts/diff-classify";
import { applyShard, parseArgs, tokensContainType } from "../scripts/render-diff";
import {
  POLICY_NAMES,
  loadMeasurer,
  loadRevision,
  spawnJsonlServer,
  type ComboRecord,
  type RenderRequest,
} from "../scripts/revision";

const REPO_ROOT = process.cwd();
const FIXTURES = [
  "tests/fixtures/simple.md",
  "tests/fixtures/fenced-list.md",
  "tests/fixtures/witnesses/defect-1-2-unparseable-frontmatter.md",
];

function record(overrides: Partial<ComboRecord> = {}): ComboRecord {
  return {
    file: "doc.md",
    width: 80,
    tier: "unicode",
    ambiguous: "narrow",
    policy: "P2",
    emoji: "default",
    textSha: "t",
    codeContentSha: "c",
    codeRanges: [[3, 5]],
    detectors: { orphans: 0, overIndent: 0, columnZero: 0 },
    overflowed: false,
    proseSha: "p",
    echoSha: "e",
    fenceStrippedSha: "f",
    sgrVocabOk: true,
    hasSgr: true,
    hasOsc8: false,
    hasDcs: false,
    highlightedFences: 1,
    ...overrides,
  };
}

describe("non-vacuity requirement", () => {
  test("a required counter at zero on either side fails the run with a named reason", () => {
    const pairs: PairedCombo[] = [{ before: record(), after: record({ hasSgr: false }) }];
    const summary = classifyDiffs(pairs, "a", { requireNonzero: ["sgr", "osc8"] });
    expect(summary.diffedCombos).toBe(0);
    expect(summary.ok).toBe(false);
    expect(summary.nonvacuity.before.sgr).toBe(1);
    expect(summary.nonvacuity.after.sgr).toBe(0);
    expect(summary.nonvacuityFailures).toEqual([
      'required non-vacuity counter "sgr" is zero on the rev-b side',
      'required non-vacuity counter "osc8" is zero on the rev-a side',
      'required non-vacuity counter "osc8" is zero on the rev-b side',
    ]);
  });

  test("the same run passes once every required counter is non-zero on both sides", () => {
    const pairs: PairedCombo[] = [{ before: record(), after: record() }];
    const summary = classifyDiffs(pairs, "a", { requireNonzero: ["sgr", "fences"] });
    expect(summary.nonvacuityFailures).toEqual([]);
    expect(summary.ok).toBe(true);
  });
});

describe("D-C classification", () => {
  test("under P2–P4 a textSha/codeContentSha-only diff is allowedDC; P0 keeps codeContentSha class C", () => {
    const dc = classifyDiffs([{ before: record(), after: record({ textSha: "t2", codeContentSha: "c2" }) }], "a");
    expect(dc.allowedDC).toHaveLength(1);
    expect(dc.classC).toHaveLength(0);
    expect(dc.ok).toBe(true);
    const p0 = classifyDiffs([{ before: record({ policy: "P0" }), after: record({ policy: "P0", codeContentSha: "c2" }) }], "a");
    expect(p0.classC).toHaveLength(1);
    expect(p0.ok).toBe(false);
  });

  test("a fence-stripped, echo, prefix or vocabulary failure under P2–P4 is class C; a prose diff is disallowed", () => {
    for (const bad of [
      { fenceStrippedSha: "f2" },
      { echoSha: "e2" },
      { fencePrefixOk: false },
      { sgrVocabOk: false },
    ] as Array<Partial<ComboRecord>>) {
      const summary = classifyDiffs([{ before: record(), after: record({ textSha: "t2", ...bad }) }], "a");
      expect(summary.classC).toHaveLength(1);
      expect(summary.ok).toBe(false);
    }
    const prose = classifyDiffs([{ before: record(), after: record({ textSha: "t2", proseSha: "p2" }) }], "a");
    expect(prose.disallowed).toHaveLength(1);
    expect(prose.ok).toBe(false);
  });

  test("fencePrefixesOk: a divergence inside an SGR passes; one in a visible byte fails", async () => {
    const measurer = await loadMeasurer(REPO_ROOT);
    const base = { text: "prose\n  \u001b[33mconst\u001b[39m x\nend", codeRanges: [[2, 2]] as Array<[number, number]> };
    const recoloured = { ...base, text: "prose\n  \u001b[35mconst\u001b[39m x\nend" };
    const unstyled = { ...base, text: "prose\n  const x\nend" };
    // A visible byte changed before the first highlighter sequence: the prose half of the line.
    const prefixChanged = { ...base, text: "prose\n -\u001b[33mconst\u001b[39m x\nend" };
    expect(fencePrefixesOk(base, recoloured, 0, measurer)).toBe(true);
    expect(fencePrefixesOk(base, unstyled, 0, measurer)).toBe(true);
    expect(fencePrefixesOk(base, prefixChanged, 0, measurer)).toBe(false);
  });
});

describe("render-diff flags", () => {
  test("--policy/--emoji/--input/--shard/--require-free/--require-nonzero parse, and bad values throw", () => {
    const options = parseArgs([
      "--policy",
      "P0,P3",
      "--emoji",
      "on,off",
      "--input",
      "tokens",
      "--shard",
      "2/3",
      "--require-free",
      "list,table",
      "--require-nonzero",
      "sgr,dcs",
    ]);
    expect(options.policies).toEqual(["P0", "P3"]);
    expect(options.emojis).toEqual(["on", "off"]);
    expect(options.input).toBe("tokens");
    expect(options.shard).toEqual({ index: 2, count: 3 });
    expect(options.requireFree).toEqual(["list", "table"]);
    expect(options.requireNonzero).toEqual(["sgr", "dcs"]);
    expect(parseArgs([]).policies).toEqual(["P0"]);
    expect(() => parseArgs(["--policy", "P5"])).toThrow();
    expect(() => parseArgs(["--shard", "0/2"])).toThrow();
    expect(() => parseArgs(["--require-nonzero", "colour"])).toThrow();
    const corpora = [{ spec: { name: "x", root: "/", globs: [] }, files: ["a", "b", "c", "d", "e"] }];
    expect(applyShard(corpora, { index: 2, count: 2 })[0]!.files).toEqual(["b", "d"]);
    const tokens = [{ type: "paragraph", tokens: [{ type: "text" }] }, { type: "blockquote", tokens: [{ type: "list", items: [] }] }];
    expect(tokensContainType(tokens, new Set(["list"]))).toBe(true);
    expect(tokensContainType(tokens, new Set(["table"]))).toBe(false);
  });
});

describe("transports", () => {
  test("a server that dies or errors rejects its requests rather than hanging", async () => {
    const request = { source: "", width: 80, tier: "unicode", ambiguous: "narrow", policy: { sgr: "none", hyperlinks: false, tmux: false } } as const;
    const dead = spawnJsonlServer([process.execPath, "-e", "process.exit(3)"], { label: "dead" });
    await expect(dead.request(request)).rejects.toThrow(/dead/);
    await dead.close();
    const complaining = spawnJsonlServer([process.execPath, "-e", "console.error('boom'); setTimeout(() => {}, 2000)"], {
      label: "complaining",
    });
    await expect(complaining.request(request)).rejects.toThrow(/stderr: boom/);
    await complaining.close();
  }, 15_000);

  test("rust: the real server renders and pairs every combo, identically against itself", async () => {
    // The TypeScript side this paired with was deleted at WP-9 (`TS_BASELINE` = `c097c66`);
    // the same handle on both sides is the null run, so every policy must pair class-A.
    const measurer = await loadMeasurer(REPO_ROOT);
    const rust = await loadRevision(`rust:${REPO_ROOT}`, REPO_ROOT);
    const ts = rust;
    try {
      expect(rust.kind).toBe("rust");
      const path = join(REPO_ROOT, FIXTURES[0]!);
      const source = await readFile(path, "utf8");
      const pairs: PairedCombo[] = [];
      let errors = 0;
      for (const policy of POLICY_NAMES) {
        const request: RenderRequest & { path: string } = {
          source,
          path,
          width: 80,
          tier: "unicode",
          ambiguous: "narrow",
          policy,
          emoji: "default",
        };
        const [a, b] = await Promise.all([computeComboRecord(ts, measurer, request), computeComboRecord(rust, measurer, request)]);
        expect(b.error ?? null).toBeNull();
        expect(b.record).not.toBeNull();
        if (b.error) errors += 1;
        if (a.record && b.record) pairs.push({ before: a.record, after: b.record });
      }
      // Every policy pairs: the transport carries a real render on both sides. Whether the
      // pair agrees is the R-gate's question (and D-A/D-C attribution), not this test's.
      expect(errors).toBe(0);
      expect(pairs.length).toBe(POLICY_NAMES.length);
      expect(classifyDiffs(pairs, "a").diffedCombos).toBe(0);
    } finally {
      await rust.close();
    }
  }, 600_000);
});
