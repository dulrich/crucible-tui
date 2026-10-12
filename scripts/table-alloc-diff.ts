/**
 * WP-5a of `plans/mdview-rust-port.md`: the allocator differential.
 *
 * For every table in T0 (`tests/fixtures/**\/*.md`) and, given `--t1 <manifest>` or
 * `MDVIEW_PORT_T1_MANIFEST`, every table in every T1 corpus, this lexes with the TS lexer
 * (`lexBody`, per glyph tier), runs `src/table.ts`'s own `tableGrid`, `naturalWidths` and
 * `allocateWidths`, and compares the result against `mdview __parity table-alloc` fed the
 * census-normalized token — at the five default widths × both glyph tiers × both ambiguous
 * modes.
 *
 * Usage: `bun run scripts/table-alloc-diff.ts [--t1 <manifest>]`. Prints
 * `table-alloc-diff: tables=N combos=N mismatches=N` and exits non-zero on any mismatch or
 * on `tables=0`. A leaf: imports `src/` and `scripts/corpus.ts`, `token-schema.ts` and
 * `sweep-options.ts` only, and is imported by nothing.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import type { Token, Tokens } from "marked";
import { splitFrontmatter } from "../src/frontmatter";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../src/glyphs";
import { lexBody } from "../src/render";
import { allocateWidths, naturalWidths, tableGrid } from "../src/table";
import { NARROW_MEASURE, WIDE_MEASURE } from "../src/width";
import { loadManifest, resolveCorpusFiles } from "./corpus";
import { DEFAULT_WIDTHS } from "./sweep-options";
import { normalizeToken } from "./token-schema";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const t1Index = argv.indexOf("--t1");
const t1Path = t1Index >= 0 ? argv[t1Index + 1] : process.env.MDVIEW_PORT_T1_MANIFEST;

const files = [...new Glob("tests/fixtures/**/*.md").scanSync({ cwd: ROOT })].map((f) => join(ROOT, f)).sort();
if (t1Path) {
  const manifest = await loadManifest(t1Path);
  for (const spec of manifest.corpora) {
    const resolved = await resolveCorpusFiles(spec);
    if (resolved === null) throw new Error(`table-alloc-diff: T1 corpus ${spec.name} root is missing: ${spec.root}`);
    files.push(...resolved);
  }
}

/** Every table token, depth first — tables can sit inside lists and blockquotes. */
function collectTables(tokens: readonly Token[], out: Tokens.Table[]): void {
  for (const token of tokens) {
    if (token.type === "table") out.push(token as Tokens.Table);
    const nested = (token as { tokens?: Token[] }).tokens;
    if (Array.isArray(nested)) collectTables(nested, out);
    const items = (token as { items?: Array<{ tokens?: Token[] }> }).items;
    if (Array.isArray(items)) for (const item of items) collectTables(item.tokens ?? [], out);
  }
}

const TIERS = [
  ["unicode", UNICODE_GLYPHS],
  ["ascii", ASCII_GLYPHS],
] as const;
const MODES = [
  ["narrow", NARROW_MEASURE],
  ["wide", WIDE_MEASURE],
] as const;

interface Combo {
  label: string;
  request: string;
  expected: string;
}
const combos: Combo[] = [];
let tables = 0;
for (const file of files) {
  const body = splitFrontmatter(readFileSync(file, "utf8")).body;
  for (const [tier, glyphs] of TIERS) {
    const found: Tokens.Table[] = [];
    collectTables(lexBody(body, glyphs), found);
    if (tier === "unicode") tables += found.length;
    found.forEach((table, index) => {
      const grid = tableGrid(table);
      const census = normalizeToken(table);
      for (const [ambiguous, measure] of MODES) {
        const natural = naturalWidths(grid.header, grid.rows, measure);
        for (const width of DEFAULT_WIDTHS) {
          const allocation = allocateWidths(natural, width);
          combos.push({
            label: `${file} table#${index} tier=${tier} ambiguous=${ambiguous} width=${width}`,
            request: JSON.stringify({ table: census, width, tier, ambiguous }),
            expected: JSON.stringify({
              grid,
              natural,
              widths: allocation.widths,
              totalWidth: allocation.totalWidth,
              fits: allocation.fits,
            }),
          });
        }
      }
    });
  }
}

const build = spawnSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "mdview", "--features", "parity-tokens"],
  { cwd: ROOT, stdio: "inherit" },
);
if (build.status !== 0) throw new Error("table-alloc-diff: cargo build of mdview (parity-tokens) failed");

const result = spawnSync(join(ROOT, "target/release/mdview"), ["__parity", "table-alloc"], {
  input: combos.map((c) => c.request).join("\n") + "\n",
  maxBuffer: 1 << 30,
});
if (result.status !== 0) throw new Error(`table-alloc-diff: __parity table-alloc failed: ${result.stderr}`);
const responses = result.stdout.toString("utf8").split("\n").filter((l) => l !== "");
if (responses.length !== combos.length) {
  throw new Error(`table-alloc-diff: ${combos.length} requests but ${responses.length} responses`);
}

let mismatches = 0;
combos.forEach((combo, i) => {
  const actual = responses[i] as string;
  if (actual === combo.expected) return;
  mismatches += 1;
  if (mismatches <= 20) console.log(`mismatch: ${combo.label}\n  ts:   ${combo.expected}\n  rust: ${actual}`);
});

console.log(`table-alloc-diff: tables=${tables} combos=${combos.length} mismatches=${mismatches}`);
process.exit(mismatches > 0 || tables === 0 ? 1 : 0);
