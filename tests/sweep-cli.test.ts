import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseArgs } from "../scripts/sweep";
// `parseWidths` moved out of the sweep CLI into the leaf both CLIs share at WP-R1
// (`plans/post-refactor-code-quality-remediation.md`); the parser itself is unchanged.
import { parseWidths } from "../scripts/sweep-options";
import { sweepCorpus, type CorpusSpec, type SweepOptions } from "../scripts/corpus";

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
    expect(options.glyphs).toBe("unicode");
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
    expect(parseArgs(["--glyphs", "ascii"]).options.glyphs).toBe("ascii");
    expect(parseArgs(["--glyphs", "unicode"]).options.glyphs).toBe("unicode");
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
    expect(parseArgs(["--glyphs", "ascii", "--glyphs", "unicode"]).options.glyphs).toBe("unicode");
    expect(parseArgs(["--widths", "80", "--widths", "116"]).options.widths).toEqual([116]);
    expect(parseArgs(["--corpus", "a", "--corpus", "b"]).corpus).toBe("b");
  });

  test("the two bundled gate invocations parse to what those gates measure", () => {
    // `package.json`'s `sweep` script, called bare and with `-- --glyphs ascii`.
    expect(parseArgs([]).options.glyphs).toBe("unicode");
    const ascii = parseArgs(["--glyphs", "ascii"]).options;
    expect(ascii.glyphs).toBe("ascii");
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
      // nowhere left to shrink and it overflows **by design** (crates/mdview/AGENTS.md's
      // "many-column tables exceed the target width"), so every width swept below
      // overflows and the recorded order is the only variable. A long unbreakable
      // token would not do — those are hard-split losslessly and never overflow.
      const columns = 19;
      const header = `| ${Array.from({ length: columns }, (_, i) => `col${i}`).join(" | ")} |`;
      const rule = `|${" --- |".repeat(columns)}`;
      const row = `| ${Array.from({ length: columns }, (_, i) => `value${i}`).join(" | ")} |`;
      await writeFile(join(dir, "table.md"), `# t\n\n${header}\n${rule}\n${row}\n`);
      const spec: CorpusSpec = { name: "order", root: dir, walkAll: true };
      const base: SweepOptions = { widths: [], all: false, glyphs: "unicode", detect: false };

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
        { widths: [80], all: false, glyphs: "unicode", detect: false },
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
        { widths: [Infinity], all: false, glyphs: "unicode", detect: false },
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
        { widths: [52], all: false, glyphs: "unicode", detect: true },
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
      { widths: [80], all: false, glyphs: "unicode", detect: true },
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
      const options: SweepOptions = { widths: [80], all: false, glyphs: "unicode", detect: false };
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
