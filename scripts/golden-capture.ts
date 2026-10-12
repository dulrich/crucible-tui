/**
 * Golden capture — WP-1 of `plans/mdview-rust-port.md`.
 *
 * Runs `bun test tests` with `MDVIEW_GOLDEN_CAPTURE` pointed at a fresh temp directory, so
 * `src/render.ts`'s env-gated hook appends one record per `renderDocumentDetailed` call, then
 * converts those records into `crates/mdview/tests/golden/render.jsonl` for the Rust port to
 * replay. Also converts the frozen visitor-level byte tables
 * (`tests/helpers/{block,inline}-parity-golden.ts`) into
 * `crates/mdview/tests/golden/parity-tables.jsonl` as `{suite, name, color, emoji, expected}`
 * pairs; their *inputs* are the case tables in `tests/helpers/{block,inline}-parity.ts`, which
 * the visitor-porting work packages port beside the visitors.
 *
 * **What is kept, and why.** Only records a pure `(source, width, tier, ambiguous, emoji,
 * policy)` replay can reproduce: canonical glyph sets, the canonical narrow/wide `Measure`,
 * the default fence-language resolver, and no wiki-link resolver. Records are deduplicated by
 * the sha256 of their inputs (the suite renders many sources repeatedly), so the file is
 * commit-sized; the header line records the counts, what was dropped and why, and the TS sha
 * (`git rev-parse HEAD`, plus whether the tree was dirty) the outputs were captured from.
 *
 * The test run's own exit code is reported, not required: a capture records what the renderer
 * did, and a failing unrelated test does not change a render. Run it on a green tree.
 *
 * **Imports nothing within `scripts/`** — a leaf of the scripts DAG.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BLOCK_PARITY_GOLDEN } from "../tests/helpers/block-parity-golden";
import { buildContext, scanLine } from "../tests/helpers/containment";
import { INLINE_PARITY_GOLDEN } from "../tests/helpers/inline-parity-golden";

const ROOT = resolve(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "crates", "mdview", "tests", "golden");
const PER_SOURCE_CAP = 24;

interface CaptureRecord {
  source: string;
  targetWidth: number;
  tier: string;
  canonicalGlyphs: boolean;
  ambiguous: string;
  emojiOverride: boolean | null;
  fenceResolver: string;
  policy: { sgr: string; hyperlinks: boolean; tmux: boolean };
  wikiResolver: string;
  text: string;
  codeRanges: Array<[number, number]>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", ROOT, ...args], { stdout: "pipe", stderr: "pipe" });
  return proc.stdout.toString().trim();
}

async function main(): Promise<void> {
  const captureDir = await mkdtemp(join(tmpdir(), "mdview-golden-"));
  try {
    const run = Bun.spawnSync(["bun", "test", "tests"], {
      cwd: ROOT,
      env: { ...process.env, MDVIEW_GOLDEN_CAPTURE: captureDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    console.log(`golden-capture: bun test tests exited ${run.exitCode}`);

    const records: CaptureRecord[] = [];
    for (const name of (await readdir(captureDir)).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of (await readFile(join(captureDir, name), "utf8")).split("\n")) {
        if (line !== "") records.push(JSON.parse(line) as CaptureRecord);
      }
    }

    const dropped: Record<string, number> = {};
    const kept = new Map<string, Record<string, unknown>>();
    let conflicts = 0;
    for (const r of records) {
      const reason = !r.canonicalGlyphs
        ? "custom-glyphs"
        : r.ambiguous === "custom"
          ? "custom-measure"
          : r.fenceResolver !== "default"
            ? "custom-fence-resolver"
            : r.wikiResolver !== "none"
              ? "wiki-resolver"
              : null;
      if (reason !== null) {
        dropped[reason] = (dropped[reason] ?? 0) + 1;
        continue;
      }
      const input = {
        source: r.source,
        width: r.targetWidth,
        tier: r.tier,
        ambiguous: r.ambiguous,
        emoji: r.emojiOverride,
        policy: r.policy,
      };
      const key = sha256(JSON.stringify(input));
      const existing = kept.get(key);
      if (existing !== undefined) {
        // A pure renderer cannot answer one input two ways; count it loudly if it ever does.
        if (existing.text !== r.text || JSON.stringify(existing.codeRanges) !== JSON.stringify(r.codeRanges)) {
          conflicts += 1;
        }
        continue;
      }
      kept.set(key, { ...input, text: r.text, codeRanges: r.codeRanges });
    }

    // **The width sweeps are thinned, deterministically.** A handful of fixture tests render
    // one source at every width 40-360 (one source alone was 644 records, 5.8 MB); those
    // fixtures are T0 corpus members the differential renders at every axis anyway, so a
    // source with more than `PER_SOURCE_CAP` records keeps that many, evenly spaced over its
    // records sorted by (width, tier, ambiguous, policy, emoji). The header records how many
    // were thinned.
    const bySource = new Map<string, Array<[string, Record<string, unknown>]>>();
    for (const entry of kept.entries()) {
      const source = entry[1].source as string;
      const group = bySource.get(source) ?? [];
      group.push(entry);
      bySource.set(source, group);
    }
    let thinned = 0;
    for (const group of bySource.values()) {
      if (group.length <= PER_SOURCE_CAP) continue;
      const order = (r: Record<string, unknown>): string =>
        JSON.stringify([String(r.width).padStart(5, "0"), r.tier, r.ambiguous, r.policy, r.emoji]);
      group.sort(([, a], [, b]) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
      const keep = new Set<number>();
      for (let i = 0; i < PER_SOURCE_CAP; i += 1) {
        keep.add(Math.floor((i * (group.length - 1)) / (PER_SOURCE_CAP - 1)));
      }
      group.forEach(([key], index) => {
        if (!keep.has(index)) {
          kept.delete(key);
          thinned += 1;
        }
      });
    }

    // **The publication guard still applies to captured data.** A test can render a
    // sanctioned fake path that a hard-split leaves as a fragment the guard reads as a foreign
    // citation; such a record is dropped here (and counted) rather than weakening the guard.
    const containment = buildContext(ROOT);
    let containmentDropped = 0;
    for (const [key, value] of kept.entries()) {
      if (scanLine(JSON.stringify(value), containment).length > 0) {
        kept.delete(key);
        containmentDropped += 1;
      }
    }

    const tsSha = git(["rev-parse", "HEAD"]);
    const dirty = git(["status", "--porcelain", "--", "src"]) !== "";
    const header = {
      header: {
        kind: "render",
        tsSha,
        srcDirty: dirty,
        captured: records.length,
        kept: kept.size,
        dropped,
        thinned,
        containmentDropped,
        perSourceCap: PER_SOURCE_CAP,
        conflicts,
        protocol: "one record per line: {source, width, tier, ambiguous, emoji, policy, text, codeRanges}",
      },
    };
    await mkdir(OUT_DIR, { recursive: true });
    const sorted = [...kept.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
    await writeFile(
      join(OUT_DIR, "render.jsonl"),
      `${[header, ...sorted].map((v) => JSON.stringify(v)).join("\n")}\n`,
      "utf8",
    );

    const pairs: Array<Record<string, unknown>> = [];
    for (const color of ["colorOff", "colorOn"] as const) {
      for (const [name, expected] of Object.entries(BLOCK_PARITY_GOLDEN[color])) {
        pairs.push({ suite: "block", name, color: color === "colorOn", emoji: null, expected });
      }
      for (const emoji of ["emojiOn", "emojiOff"] as const) {
        for (const [name, expected] of Object.entries(INLINE_PARITY_GOLDEN[color][emoji])) {
          pairs.push({ suite: "inline", name, color: color === "colorOn", emoji: emoji === "emojiOn", expected });
        }
      }
    }
    const tableHeader = {
      header: {
        kind: "parity-tables",
        tsSha,
        source: "tests/helpers/block-parity-golden.ts, tests/helpers/inline-parity-golden.ts (frozen marked-terminal bytes)",
        pairs: pairs.length,
        protocol: "one pair per line: {suite, name, color, emoji, expected}; inputs are the case tables in tests/helpers/{block,inline}-parity.ts",
      },
    };
    await writeFile(
      join(OUT_DIR, "parity-tables.jsonl"),
      `${[tableHeader, ...pairs].map((v) => JSON.stringify(v)).join("\n")}\n`,
      "utf8",
    );

    console.log(
      `golden-capture: ${records.length} captured, ${kept.size} kept (${thinned} thinned), dropped ${JSON.stringify(dropped)}, ` +
        `conflicts=${conflicts}, ${pairs.length} parity-table pairs, tsSha=${tsSha.slice(0, 12)}${dirty ? " (src dirty)" : ""}`,
    );
    if (conflicts > 0) process.exit(1);
  } finally {
    await rm(captureDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
