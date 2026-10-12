/**
 * WP-3 of `plans/mdview-rust-port.md`: the frontmatter acceptance census (audit E1). Every
 * distinct frontmatter block in T0 (`tests/fixtures/**\/*.md` plus the golden render sources)
 * and T1 is handed to TS (`src/frontmatter.ts`'s own split, the `yaml` package's parse, and
 * `formatMetaBlockDetailed`) and to Rust (`crates/mdview`'s `frontmatter.rs`, reached through
 * the `frontmatter-probe` example binary) at several widths, both colour extremes and both
 * ambiguous-width measures.
 *
 * Required to agree exactly: parse/fail, and the formatted block plus its verbatim ranges.
 * The one allowed diff is D-A — the diagnostic text of a failed parse — and only when both
 * failed, the echoed block is byte-identical, the diff stays within the diagnostic lines, and
 * the verbatim range moves by exactly the change in diagnostic line count. D-A cases are
 * counted separately.
 *
 * Usage: `bun run scripts/frontmatter-census.ts --t1 <manifest> | --no-t1` (or
 * `MDVIEW_PORT_T1_MANIFEST`). Exits non-zero iff any disagreement remains.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { parse } from "yaml";
import { formatMetaBlockDetailed, splitFrontmatter } from "../src/frontmatter";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import { loadManifest, resolveCorpusFiles } from "./corpus";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const t1Index = argv.indexOf("--t1");
const t1Path = t1Index >= 0 ? argv[t1Index + 1] : process.env.MDVIEW_PORT_T1_MANIFEST;
const skipT1 = argv.includes("--no-t1");
if (!skipT1 && !t1Path) {
  throw new Error("frontmatter-census: pass --t1 <manifest> (or MDVIEW_PORT_T1_MANIFEST), or --no-t1");
}

const sources: Array<[tier: "T0" | "T1", text: string]> = [];
for (const f of [...new Glob("tests/fixtures/**/*.md").scanSync({ cwd: ROOT })].sort()) {
  sources.push(["T0", readFileSync(join(ROOT, f), "utf8")]);
}
const golden = readFileSync(join(ROOT, "crates/mdview/tests/golden/render.jsonl"), "utf8").split("\n");
for (const line of golden.slice(1)) {
  if (line.trim() === "") continue;
  sources.push(["T0", (JSON.parse(line) as { source: string }).source]);
}
if (!skipT1) {
  const manifest = await loadManifest(t1Path as string);
  for (const spec of manifest.corpora) {
    const files = await resolveCorpusFiles(spec);
    if (files === null) throw new Error(`T1 corpus ${spec.name} root is missing: ${spec.root}`);
    for (const file of files) sources.push(["T1", readFileSync(file, "utf8")]);
  }
}

// Synthetic witnesses for the core-schema and JS-semantics corners the corpus may not reach
// (attempt-1 brief: yes/no/on/off, 0o17, .inf, ~, timestamps; Critical Files 7).
const SYNTHETIC = [
  "a: yes\nb: no\nc: on\nd: off\ne: True\nf: FALSE\ng: tRUE",
  "o: 0o17\nh: 0x1F\nH: 0xFFFFFFFFFFFFFFFFFF\ni: .inf\nj: -.Inf\nk: .nan\nl: ~\nm: null\nn: Null\np:",
  "t1: 2026-07-06\nt2: 2026-07-06T12:30:00Z\nt3: 2026-07-06 12:30\nt4: ' 2026-07-06 '",
  "a: 1e21\nb: 1e-7\nc: 0.1\nd: 1.50\ne: 007\nf: -0\ng: +5\nh: 12:30\ni: 123456789012345678901234\nj: .5\nk: -.5e3\nl: 1.\nm: 2E+2\nn: 0.000001\no: 1e300",
  "x: 1\nx: 2",
  "1: a\n1.0: b",
  "1: a\n\"1\": b",
  "~: a\nnull: b",
  "b: 1\n10: x\n2: y\n01: z\n-1: w\n4294967295: big\n4294967294: edge\na: 3",
  "created: {{today}}\ntitle: x",
  "a:\n  b:\n    c: 1\n    d: [1, 2]\n  e: {x: 1, '2': 2, 1: 3}",
  "a: &x [1, 2]\nb: *x\nc: &y {k: v}\nd: *y",
  "a: !!str 1\nb: !foo bar\nc: !!int 7\nd: !!str",
  "a: 1\n...\nb: 2",
  "a: 1\n---\nb: 2",
  "a: 'q''uote'\nb: \"esc\\t\\u00e9\\n\"\nc: |\n  line1\n  line2\nd: >\n  folded\n  text",
  "a: [[1, 2], {b: c}, null, true, 1.5, '']\nb: []\nc: {}\nd: [~]",
  "a: value: other",
  "a: [unterminated",
  "\ta: 1",
  "a:\n\t- 1",
  "キー: 値\n長いキーの名前: 長い値の文字列がここにあります",
  "a: \"\\u0001ctl\"\nb:\n  c: {d: \"x\\\"y\"}",
  "? [a, b]\n: v\nk: 1",
  "a: *undefined",
  "just a scalar: line\nnot: [a, b]: c",
  "- not\n- a map",
  "__proto__: x\nconstructor: y",
  "a: 1 # comment\n# whole\nb: '#not'",
];

const metas = new Map<string, "T0" | "T1">();
for (const meta of SYNTHETIC) metas.set(meta, "T0");
for (const [tier, text] of sources) {
  const { meta } = splitFrontmatter(text);
  if (meta !== null && !metas.has(meta)) metas.set(meta, tier);
}

type Combo = [meta: string, width: number, sgr: "none" | "full", ambiguous: "narrow" | "wide"];
const combos: Combo[] = [];
for (const meta of metas.keys()) {
  for (const width of [12, 40, 80, 160]) for (const sgr of ["none", "full"] as const) combos.push([meta, width, sgr, "narrow"]);
  combos.push([meta, 80, "none", "wide"]);
}

const probe = join(ROOT, "target/release/examples/frontmatter-probe");
const build = spawnSync("cargo", ["build", "--release", "--locked", "-p", "mdview", "--example", "frontmatter-probe"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (build.status !== 0) throw new Error("cargo build of frontmatter-probe failed");
const result = spawnSync(probe, [], { input: combos.map((c) => JSON.stringify(c)).join("\n") + "\n", maxBuffer: 1 << 30 });
if (result.status !== 0) throw new Error(`frontmatter-probe failed: ${result.stderr}`);
type Answer = { parsed: boolean; text?: string; ranges?: Array<[number, number]>; error?: string };
const answers = result.stdout.toString("utf8").trimEnd().split("\n").map((l) => JSON.parse(l) as Answer);

const parsedTs = new Map<string, boolean>();
for (const meta of metas.keys()) {
  try {
    parse(meta, { logLevel: "error" });
    parsedTs.set(meta, true);
  } catch {
    parsedTs.set(meta, false);
  }
}

const classes = new Map<string, Array<{ tier: string; combo: Combo; ts: string; rust: string }>>();
const record = (cls: string, tier: string, combo: Combo, ts: string, rust: string) => {
  const list = classes.get(cls) ?? [];
  list.push({ tier, combo, ts, rust });
  classes.set(cls, list);
};
let agree = 0;
/** `String.prototype.toWellFormed` (ES2024; the repo targets an older lib): lone surrogates → U+FFFD. */
const wellFormed = (s: string): string =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
let daCases = 0;
let loneSurrogateCombos = 0;
const daMetas = new Set<string>();
combos.forEach((combo, i) => {
  const [meta, width, sgr, ambiguous] = combo;
  const tier = metas.get(meta) as string;
  const answer = answers[i] as Answer;
  const tsRaw = formatMetaBlockDetailed(meta, width, ambiguous === "wide" ? WIDE_MEASURE : NARROW_MEASURE, sgr);
  // `hardSplit` slices UTF-16 units and can cut a surrogate pair; a lone surrogate reaches
  // stdout as U+FFFD (UTF-8 has no encoding for it), which is what Rust carries. Compare the
  // bytes the terminal receives.
  const ts = { ...tsRaw, text: wellFormed(tsRaw.text) };
  if (ts.text !== tsRaw.text) loneSurrogateCombos += 1;
  const tsParsed = parsedTs.get(meta) as boolean;
  if (answer.error !== undefined) return record("rust-error", tier, combo, ts.text, answer.error);
  if (tsParsed !== answer.parsed) return record(`parse ts=${tsParsed} rust=${answer.parsed}`, tier, combo, ts.text, answer.text ?? "");
  const rustText = answer.text as string;
  const rustRanges = answer.ranges as Array<[number, number]>;
  if (rustText === ts.text && JSON.stringify(rustRanges) === JSON.stringify(ts.verbatimRanges)) {
    agree += 1;
    return;
  }
  if (!tsParsed) {
    // D-A: both failed. The echo is everything from the verbatim range's first line on.
    const tsLines = ts.text.split("\n");
    const rsLines = rustText.split("\n");
    const tsRange = ts.verbatimRanges[0];
    const rsRange = rustRanges[0];
    if (tsRange && rsRange && ts.verbatimRanges.length === 1 && rustRanges.length === 1) {
      const tsDiag = tsRange[0] - 1;
      const rsDiag = rsRange[0] - 1;
      const sameEcho = tsLines.slice(tsDiag).join("\n") === rsLines.slice(rsDiag).join("\n");
      const shifted = rsRange[0] - tsRange[0] === rsDiag - tsDiag && rsRange[1] - tsRange[1] === rsDiag - tsDiag;
      const diagLinesOnly = tsLines.length - tsDiag === rsLines.length - rsDiag;
      if (sameEcho && shifted && diagLinesOnly) {
        daCases += 1;
        daMetas.add(meta);
        return;
      }
    }
    return record("failed-parse echo/ranges differ (not D-A)", tier, combo, ts.text, rustText);
  }
  record("format", tier, combo, ts.text, rustText);
});

let disagreements = 0;
for (const [cls, list] of classes) {
  disagreements += list.length;
  const distinct = new Set(list.map((d) => d.combo[0]));
  console.log(`class ${JSON.stringify(cls)}: ${list.length} combo(s) over ${distinct.size} distinct block(s)`);
  const shown = new Set<string>();
  for (const d of list) {
    if (shown.has(d.combo[0]) || shown.size >= 6) continue;
    shown.add(d.combo[0]);
    console.log(`  [${d.tier}] combo=${JSON.stringify(d.combo.slice(1))} meta=${JSON.stringify(d.combo[0].slice(0, 300))}`);
    let at = 0;
    while (at < d.ts.length && d.ts[at] === d.rust[at]) at += 1;
    const from = Math.max(0, at - 60);
    console.log(`    first difference at UTF-16 offset ${at}`);
    console.log(`    ts  =${JSON.stringify(d.ts.slice(from, at + 60))}`);
    console.log(`    rust=${JSON.stringify(d.rust.slice(from, at + 60))}`);
  }
}
const t0 = [...metas.values()].filter((t) => t === "T0").length;
const failed = [...parsedTs.values()].filter((p) => !p).length;
console.log(
  `frontmatter-census: sources=${sources.length} blocks=${metas.size} (T0=${t0} T1=${metas.size - t0}) tsFailed=${failed} combos=${combos.length} agree=${agree} D-A=${daCases} (over ${daMetas.size} block(s)) loneSurrogateWellFormed=${loneSurrogateCombos} disagreements=${disagreements}`,
);
process.exit(disagreements === 0 && combos.length > 0 ? 0 : 1);
