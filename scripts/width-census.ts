/**
 * WP-2 gates 1 and 2 of `plans/mdview-rust-port.md`: the width census and the
 * segmentation agreement, TS (`src/width.ts`, ICU `Intl.Segmenter`) against Rust
 * (`crates/mdview`'s `Measure` and `unicode-segmentation`, reached through the
 * `width-probe` example binary).
 *
 * Inputs: T0 = `tests/fixtures/**\/*.md`; T1 = every corpus of the manifest given by
 * `--t1 <manifest>` or `MDVIEW_PORT_T1_MANIFEST` (the port's private T1 manifest; this repo
 * does not know where it lives), resolved with `--all` semantics — read-only.
 *
 * Usage: `bun run scripts/width-census.ts --t1 <manifest> | --no-t1`. Exits non-zero iff
 * any cluster width disagrees, or any segmentation disagreement lies in T0.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import { wrapAnsi } from "../src/wrap";
import { link } from "../src/ansi";
import { loadManifest, resolveCorpusFiles } from "./corpus";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const t1Index = argv.indexOf("--t1");
const t1Path = t1Index >= 0 ? argv[t1Index + 1] : process.env.MDVIEW_PORT_T1_MANIFEST;
const skipT1 = argv.includes("--no-t1");
if (!skipT1 && !t1Path) throw new Error("width-census: pass --t1 <manifest> (or MDVIEW_PORT_T1_MANIFEST), or --no-t1");

const t0Files = [...new Glob("tests/fixtures/**/*.md").scanSync({ cwd: ROOT })].map((f) => join(ROOT, f)).sort();
const t1Files: string[] = [];
if (!skipT1) {
  const manifest = await loadManifest(t1Path as string);
  for (const spec of manifest.corpora) {
    const files = await resolveCorpusFiles(spec);
    if (files === null) throw new Error(`T1 corpus ${spec.name} root is missing: ${spec.root}`);
    t1Files.push(...files);
  }
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const clusters = new Set<string>();
const lines = new Map<string, "T0" | "T1">(); // distinct line -> first tier it was seen in
for (const [tier, files] of [["T0", t0Files], ["T1", t1Files]] as const) {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { segment } of segmenter.segment(text)) clusters.add(segment);
    for (const line of text.split("\n")) if (!lines.has(line)) lines.set(line, tier);
  }
}

const probe = join(ROOT, "target/release/examples/width-probe");
const build = spawnSync("cargo", ["build", "--release", "--locked", "-p", "mdview", "--example", "width-probe"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("cargo build of width-probe failed");

function ask(mode: "width" | "segment" | "wrap", inputs: unknown[]): unknown[] {
  const result = spawnSync(probe, [mode], {
    input: inputs.map((s) => JSON.stringify(s)).join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  if (result.status !== 0) throw new Error(`width-probe ${mode} failed: ${result.stderr}`);
  return result.stdout.toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
}

const codePoints = (s: string) =>
  [...s].map((c) => `U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

// Gate 1: per-cluster width, narrow and wide.
const clusterList = [...clusters];
const rustWidths = ask("width", clusterList) as Array<[number, number]>;
let widthDisagreements = 0;
clusterList.forEach((cluster, i) => {
  const ts: [number, number] = [NARROW_MEASURE(cluster), WIDE_MEASURE(cluster)];
  const rs = rustWidths[i] as [number, number];
  if (ts[0] !== rs[0] || ts[1] !== rs[1]) {
    widthDisagreements += 1;
    console.log(`width disagreement: ${codePoints(cluster)} ts=${ts} rust=${rs}`);
  }
});
console.log(
  `width census: files T0=${t0Files.length} T1=${t1Files.length} clusters=${clusterList.length} disagreements=${widthDisagreements}`,
);

// Supplementary (not the gate's population): every scalar alone and with U+FE0F, plus the
// keycaps and regional-indicator pairs — the table edges a corpus may never reach.
const synthetic: string[] = [];
for (let cp = 0; cp <= 0x10ffff; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  synthetic.push(String.fromCodePoint(cp), `${String.fromCodePoint(cp)}️`);
}
for (const k of "0123456789#*") synthetic.push(`${k}️⃣`, `${k}⃣`);
for (let a = 0x1f1e6; a <= 0x1f1ff; a += 1)
  for (let b = 0x1f1e6; b <= 0x1f1ff; b += 1) synthetic.push(String.fromCodePoint(a, b));
const syntheticWidths = ask("width", synthetic) as Array<[number, number]>;
let syntheticDisagreements = 0;
synthetic.forEach((s, i) => {
  const rs = syntheticWidths[i] as [number, number];
  if (NARROW_MEASURE(s) !== rs[0] || WIDE_MEASURE(s) !== rs[1]) {
    syntheticDisagreements += 1;
    if (syntheticDisagreements <= 20) console.log(`synthetic disagreement: ${codePoints(s)} ts=${NARROW_MEASURE(s)},${WIDE_MEASURE(s)} rust=${rs}`);
  }
});
console.log(`synthetic: strings=${synthetic.length} disagreements=${syntheticDisagreements}`);

// Gate 2: segmentation agreement, per distinct line.
const lineList = [...lines.keys()];
const rustSegments = ask("segment", lineList) as string[][];
let lineDisagreements = 0;
let lineWidthDisagreements = 0;
const distinct = new Map<string, { tier: "T0" | "T1"; rust: string[] }>();
lineList.forEach((line, i) => {
  const icu = Array.from(segmenter.segment(line), (s) => s.segment);
  const rs = rustSegments[i] as string[];
  if (icu.length === rs.length && icu.every((s, k) => s === rs[k])) return;
  lineDisagreements += 1;
  const tier = lines.get(line) as "T0" | "T1";
  const rustSet = new Set(rs);
  for (const cluster of icu) {
    if (rustSet.has(cluster)) continue;
    const seen = distinct.get(cluster);
    if (!seen || (seen.tier === "T1" && tier === "T0")) {
      distinct.set(cluster, { tier, rust: rs.filter((r) => cluster.includes(r)) });
    }
  }
});
for (const [cluster, { tier, rust }] of distinct) {
  console.log(`segment disagreement [${tier}]: icu ${codePoints(cluster)} -> rust ${rust.map((r) => `[${codePoints(r)}]`).join(" ")}`);
}
const lineWidths = ask("width", lineList) as Array<[number, number]>;
lineList.forEach((line, i) => {
  const rs = lineWidths[i] as [number, number];
  if (NARROW_MEASURE(line) !== rs[0] || WIDE_MEASURE(line) !== rs[1]) lineWidthDisagreements += 1;
});
const t0Distinct = [...distinct.values()].filter((d) => d.tier === "T0").length;
console.log(
  `segmentation: lines=${lineList.length} disagreeingLines=${lineDisagreements} distinctClusters=${distinct.size} inT0=${t0Distinct} lineWidthDisagreements=${lineWidthDisagreements}`,
);

// Supplementary: wrapAnsi over every distinct T0 line (plus styled and linked variants) at
// three widths and both rulers.
const wrapInputs: Array<[string, number, "narrow" | "wide"]> = [];
for (const [line, tier] of lines) {
  if (tier !== "T0" || line === "") continue;
  const words = line.split(" ");
  const styled = words.map((w, k) => (k % 3 === 0 ? `\u001b[36m${w}\u001b[39m` : w)).join(" ");
  const linked = link(line.slice(0, 30), "https://example.com/x", true) + line.slice(30);
  for (const text of [line, styled, linked])
    for (const width of [7, 33, 80]) for (const amb of ["narrow", "wide"] as const) wrapInputs.push([text, width, amb]);
}
const rustWraps = ask("wrap", wrapInputs) as string[][];
let wrapDisagreements = 0;
wrapInputs.forEach(([text, width, amb], i) => {
  const ts = wrapAnsi(text, width, amb === "wide" ? WIDE_MEASURE : NARROW_MEASURE);
  if (JSON.stringify(ts) !== JSON.stringify(rustWraps[i])) {
    wrapDisagreements += 1;
    if (wrapDisagreements <= 5) console.log(`wrap disagreement: ${JSON.stringify([text, width, amb])}`);
  }
});
console.log(`wrap: cases=${wrapInputs.length} disagreements=${wrapDisagreements}`);

process.exit(wrapDisagreements > 0 || widthDisagreements > 0 || t0Distinct > 0 ? 1 : 0);
