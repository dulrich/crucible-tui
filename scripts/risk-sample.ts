/**
 * The risk-targeted render sample — WP-9 binding run, rev 5 of `plans/mdview-rust-port.md`.
 *
 * Rev 5 replaced "T2 E2E at all combos" with the T2 lexer-diff plus an all-combo render-diff
 * over a *sample* of T2 chosen by risk signal rather than by stride. This script builds that
 * sample. It reads a corpus manifest (the T2 one), the JSONL `scripts/lexer-diff.ts
 * --sites-out` wrote over the same manifest, scans each file's bytes for the constructs the
 * port has historically diverged on, and writes an explicit-path manifest `render-diff
 * --manifest` resolves to exactly those files.
 *
 * Two kinds of signal:
 *
 * - **Take-all** — every file carrying the signal joins: a lexer site (attributed or not), a
 *   frontmatter block that fails to parse (D-A), a raw C0 control byte or ESC, CRLF or BOM, a
 *   table of nine or more columns (the allocator's minimum-feasible path).
 * - **Capped** — a construct common enough that taking every file would be the whole corpus;
 *   at most `--per-signal` files each, chosen by sha256 of the path, so the sample is
 *   deterministic and does not lean on any one corpus's walk order.
 *
 * The output carries no body text, and this script names no private path: both the
 * manifest it reads and the one it writes are arguments.
 *
 * Usage: `bun run scripts/risk-sample.ts --manifest <t2.json> --sites <sites.jsonl>
 *   --out <sample.json> [--per-signal N]` (default 60).
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";

import { parse as parseYaml } from "yaml";

import { splitFrontmatter } from "../src/frontmatter";

import { loadManifest, resolveCorpusFiles, selectCorpusFiles } from "./corpus";

type Signal = { name: string; takeAll: boolean; test: (text: string) => boolean };

const lines = (text: string): string[] => text.split("\n");
const maxTableColumns = (text: string): number => {
  let max = 0;
  for (const line of lines(text)) {
    if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) continue;
    max = Math.max(max, line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").length);
  }
  return max;
};
const frontmatterFails = (text: string): boolean => {
  const { meta } = splitFrontmatter(text);
  if (meta === null) return false;
  try {
    parseYaml(meta, { logLevel: "error" });
    return false;
  } catch {
    return true;
  }
};

const COMMON_LANGS = new Set([
  "", "bash", "sh", "shell", "console", "text", "txt", "plaintext", "json", "yaml", "yml", "ts",
  "typescript", "js", "javascript", "python", "py", "rust", "rs", "markdown", "md", "toml", "diff",
]);

const SIGNALS: Signal[] = [
  { name: "frontmatter-degraded", takeAll: true, test: frontmatterFails },
  // C0 controls other than tab/LF/CR, and DEL — includes ESC, so authored SGR lands here.
  {
    name: "control-bytes",
    takeAll: true,
    test: (t) => [...t].some((c) => {
      const code = c.charCodeAt(0);
      return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    }),
  },
  { name: "crlf-or-bom", takeAll: true, test: (t) => t.startsWith("﻿") || t.includes("\r\n") },
  { name: "wide-table", takeAll: true, test: (t) => maxTableColumns(t) >= 9 },
  { name: "table", takeAll: false, test: (t) => maxTableColumns(t) >= 2 },
  { name: "cjk", takeAll: false, test: (t) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(t) },
  // East Asian Ambiguous candidates the probe/`wide` mode moves: box drawing, circled digits,
  // arrows, Greek/Cyrillic, ±×÷ and friends.
  { name: "ambiguous-width", takeAll: false, test: (t) => /[¡±×÷Α-ωЁ-я←-⇿①-⓿─-╿■-◿☀-⛿]/.test(t) },
  { name: "emoji", takeAll: false, test: (t) => /\p{Extended_Pictographic}|:[a-z0-9_+-]+:/u.test(t) },
  { name: "html", takeAll: false, test: (t) => /^ {0,3}<\/?[A-Za-z!]/m.test(t) },
  { name: "wiki-link", takeAll: false, test: (t) => t.includes("[[") },
  {
    name: "uncommon-fence-lang",
    takeAll: false,
    test: (t) => [...t.matchAll(/^ {0,3}(?:```|~~~)\s*([^\s`{]*)/gm)].some((m) => !COMMON_LANGS.has((m[1] ?? "").toLowerCase())),
  },
  { name: "fence-in-list", takeAll: false, test: (t) => /^ {2,}(?:```|~~~)/m.test(t) },
  { name: "blockquote-list", takeAll: false, test: (t) => /^ {0,3}>\s*(?:[-*+]|\d+[.)])\s/m.test(t) },
  { name: "deep-list", takeAll: false, test: (t) => /^ {6,}(?:[-*+]|\d+[.)])\s/m.test(t) },
  { name: "tab-indent-list", takeAll: false, test: (t) => /^\t+(?:[-*+]|\d+[.)])\s/m.test(t) },
  { name: "task-list", takeAll: false, test: (t) => /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX~\-!?/>]\]/m.test(t) },
  { name: "hard-break", takeAll: false, test: (t) => / {2,}\n\S/.test(t) || /<br\s*\/?>/i.test(t) },
  { name: "emphasis-dense", takeAll: false, test: (t) => /\*{3,}|_{3,}\S|\*\*[^\s*][^*\n]*\*\*[^\s*.,;:!?)]/.test(t) },
  { name: "long-token", takeAll: false, test: (t) => /\S{100,}/.test(t) },
  { name: "nested-brackets", takeAll: false, test: (t) => /\[[^\]\n]*\[[^\]\n]*\]\([^)\n]*\)[^\]\n]*\]\(/.test(t) },
  { name: "setext-or-hr", takeAll: false, test: (t) => /^\S[^\n]*\n {0,3}(?:=+|-{2,})\s*$/m.test(t) },
];

interface Options {
  manifest: string;
  sites: string;
  out: string;
  perSignal: number;
}

function parseArgs(args: string[]): Options {
  const options: Partial<Options> = { perSignal: 60 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string => {
      const value = args[++i];
      if (value === undefined) throw new Error(`risk-sample: ${arg} needs a value`);
      return value;
    };
    if (arg === "--manifest") options.manifest = next();
    else if (arg === "--sites") options.sites = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--per-signal") options.perSignal = Number.parseInt(next(), 10);
    else throw new Error(`risk-sample: unknown argument "${arg}"`);
  }
  if (options.manifest === undefined || options.sites === undefined || options.out === undefined) {
    throw new Error("risk-sample: --manifest, --sites and --out are required");
  }
  if (!Number.isInteger(options.perSignal) || (options.perSignal ?? 0) < 1) {
    throw new Error("risk-sample: --per-signal must be a positive integer");
  }
  return options as Options;
}

const pathKey = (file: string): string => createHash("sha256").update(file).digest("hex");

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  const manifest = await loadManifest(options.manifest);
  const files: string[] = [];
  for (const spec of manifest.corpora) {
    const resolved = await resolveCorpusFiles(spec);
    if (resolved === null) continue;
    files.push(...selectCorpusFiles(resolved, spec, { all: true }));
  }

  const chosen = new Map<string, Set<string>>();
  const add = (file: string, why: string): void => {
    const reasons = chosen.get(file) ?? new Set<string>();
    reasons.add(why);
    chosen.set(file, reasons);
  };

  const siteText = await readFile(options.sites, "utf8");
  for (const line of siteText.split("\n")) {
    if (line.trim() === "") continue;
    const record = JSON.parse(line) as { file: string };
    add(record.file, "lexer-site");
  }

  const candidates = new Map<string, string[]>(SIGNALS.map((s) => [s.name, []]));
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const signal of SIGNALS) {
      if (!signal.test(text)) continue;
      if (signal.takeAll) add(file, signal.name);
      else candidates.get(signal.name)?.push(file);
    }
  }
  const counts: Record<string, { candidates: number; taken: number }> = {};
  for (const signal of SIGNALS) {
    const pool = candidates.get(signal.name) ?? [];
    if (signal.takeAll) {
      const taken = [...chosen.values()].filter((r) => r.has(signal.name)).length;
      counts[signal.name] = { candidates: taken, taken };
      continue;
    }
    const taken = [...pool].sort((a, b) => pathKey(a).localeCompare(pathKey(b))).slice(0, options.perSignal);
    for (const file of taken) add(file, signal.name);
    counts[signal.name] = { candidates: pool.length, taken: taken.length };
  }
  counts["lexer-site"] = {
    candidates: [...chosen.values()].filter((r) => r.has("lexer-site")).length,
    taken: [...chosen.values()].filter((r) => r.has("lexer-site")).length,
  };

  // The output's root is the deepest directory every chosen file sits under, so the
  // manifest's globs are exact relative paths and this script hard-codes no location.
  const dirs = [...chosen.keys()].map((f) => dirname(f).split(sep));
  const common: string[] = [];
  for (let i = 0; dirs.every((d) => d[i] !== undefined && d[i] === dirs[0]?.[i]); i++) common.push(dirs[0]?.[i] ?? "");
  const root = common.join(sep) || sep;
  const globs = [...chosen.keys()].map((f) => relative(root, f)).sort();
  const out = {
    version: 1,
    generated: new Date().toISOString().slice(0, 10),
    generator: "crucible-tui scripts/risk-sample.ts (rev 5 of plans/mdview-rust-port.md)",
    note: `risk-targeted render sample of ${options.manifest}; ${globs.length} files of ${files.length}`,
    signals: counts,
    corpora: [{ name: "risk-sample", root, globs }],
  };
  await writeFile(options.out, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`risk-sample: scanned=${files.length} sample=${globs.length} -> ${options.out}`);
  for (const [name, c] of Object.entries(counts)) console.log(`risk-sample: ${name} candidates=${c.candidates} taken=${c.taken}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
