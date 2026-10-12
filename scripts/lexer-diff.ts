/**
 * The L-gate — WP-1 of `plans/mdview-rust-port.md`.
 *
 * Per file × glyph tier, compare the token list the TS walk consumes (`lexBody`, from the
 * **current checkout's** `src/`, census-normalized by `./token-schema`) against the Rust
 * adapter's tokens (`mdview __parity lex`, one long-lived process, JSONL, FIFO). Every
 * minimal differing subtree is a *site*, and every site is attributed by `./divergences`:
 * an allowed diff is always exactly one ratified entry; anything else is `disallowed`.
 *
 * **What a site is (`diffTokens`).** Walk both trees together from the root list:
 *
 * - two arrays of **different length** → the arrays themselves are the site (the parent
 *   array, at the path of the array). Positional pairing past a length mismatch would
 *   attribute misaligned nodes, so the walk stops there;
 * - two arrays of equal length whose node `type`s differ at some position → the arrays are
 *   the site too (WP-7): equal length with a type mismatch is a misalignment exactly like a
 *   length mismatch (e.g. `[text, del, text]` against `[text, codespan, text]`), and pairing
 *   it positionally would split one difference into sites no entry can judge alone;
 * - two arrays of equal length and equal types → pair positionally and descend into each
 *   element;
 * - two records (census nodes, list items, table cells) → the record is the site when the
 *   `type`s differ, when the key sets differ (`text.tokens` presence is load-bearing), when
 *   any scalar field differs, or when an array of scalars (`align`) differs; otherwise
 *   descend into every structural field (arrays holding records or arrays);
 * - a record against a non-record → that element is the site.
 *
 * **What fails.** A Rust `{error}` response, a crash, a response that does not normalize
 * onto the census schema, or a TS lex that throws is an *error* for that file × tier —
 * never a match, never skipped. The run fails when `disallowed > 0`, `errors > 0`, or zero
 * pairs were compared: a lexer-diff that compared nothing never passes. A predicate
 * collision (two entries matching one site) throws out of `attribute()` and aborts the run.
 *
 * **The dumper.** `--dump <file> [--tier unicode|ascii]` prints the normalized `lexBody`
 * tokens for one file as JSON — census fields only, so a dump is stable.
 *
 * Imports: `./corpus`, `./divergences`, `./token-schema` within `scripts/` (all three are
 * leaves or below this module, so the DAG stays acyclic) and the current checkout's
 * `src/render.ts`, `src/frontmatter.ts`, `src/glyphs.ts` statically, as
 * `scripts/colour-axis.ts` does — the L-gate is always about *this* checkout's lexer.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { splitFrontmatter } from "../src/frontmatter";
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "../src/glyphs";
import { lexBody } from "../src/render";

import { loadManifest, resolveCorpusFiles, resolveManifestSource, selectCorpusFiles } from "./corpus";
import { attribute, type Node, type Tier, type TokenSite } from "./divergences";
import { normalizeTokens, type CensusToken } from "./token-schema";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const DEFAULT_MDVIEW = resolve(REPO_ROOT, "target/release/mdview");
export const TIERS: readonly Tier[] = ["unicode", "ascii"];

const glyphsFor = (tier: Tier): GlyphSet => (tier === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS);

/** The census-normalized TS token list for one source document at one tier. */
export function tsTokens(source: string, tier: Tier): CensusToken[] {
  return normalizeTokens(lexBody(splitFrontmatter(source).body, glyphsFor(tier)));
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStructuralArray = (v: unknown): v is unknown[] =>
  Array.isArray(v) && v.some((e) => Array.isArray(e) || isRec(e));

/** Every minimal differing subtree between two normalized token trees. */
/**
 * An inline container (`del`, `strong`, `em`) whose extent differs between the sides — `del`
 * by `raw`, `strong`/`em` by `text`. Its delimiters moved, so its siblings are re-partitioned
 * around it: the enclosing array is the site, as for a type mismatch (WP-7 attempt 2).
 */
function extentDiffers(a: unknown, b: unknown): boolean {
  if (!isRec(a) || !isRec(b)) return false;
  if (a.type === "del") return a.raw !== b.raw;
  if (a.type === "strong" || a.type === "em") return a.text !== b.text;
  return false;
}

export function diffTokens(ts: unknown[], rust: unknown[], tier: Tier): TokenSite[] {
  const sites: TokenSite[] = [];
  const site = (path: string, a: unknown, b: unknown): void => {
    sites.push({ path, ts: a as Node | Node[] | undefined, rust: b as Node | Node[] | undefined, tier });
  };
  const typeOf = (v: unknown): unknown => (isRec(v) ? v.type : undefined);
  const walkArray = (path: string, a: unknown[], b: unknown[]): void => {
    if (a.length !== b.length || a.some((x, i) => typeOf(x) !== typeOf(b[i]) || extentDiffers(x, b[i]))) {
      site(path, a, b);
      return;
    }
    for (let i = 0; i < a.length; i++) walkValue(`${path}[${i}]`, a[i], b[i]);
  };
  const walkValue = (path: string, a: unknown, b: unknown): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      walkArray(path, a, b);
      return;
    }
    if (!isRec(a) || !isRec(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) site(path, a, b);
      return;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const structural: string[] = [];
    for (const key of keys) {
      if (!(key in a) || !(key in b)) return site(path, a, b);
      const va = a[key];
      const vb = b[key];
      if (isStructuralArray(va) || isStructuralArray(vb) || isRec(va) || isRec(vb)) {
        if (Array.isArray(va) !== Array.isArray(vb)) return site(path, a, b);
        structural.push(key);
      } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
        return site(path, a, b);
      }
    }
    for (const key of structural) walkValue(`${path}.${key}`, a[key], b[key]);
  };
  walkArray("$", ts, rust);
  return sites;
}

// ---------------------------------------------------------------------------
// The Rust adapter: one long-lived `mdview __parity lex`, JSONL, FIFO
// ---------------------------------------------------------------------------

type LexResponse = { tokens?: unknown; error?: string };

export class LexServer {
  private readonly proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  private readonly pending: Array<{ resolve: (r: LexResponse) => void }> = [];
  private dead: string | null = null;

  constructor(binary: string) {
    this.proc = Bun.spawn([binary, "__parity", "lex"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void this.readLoop();
    void this.proc.exited.then((code) => this.fail(`mdview __parity lex exited (code ${code})`));
  }

  private fail(reason: string): void {
    this.dead ??= reason;
    for (const waiter of this.pending.splice(0)) waiter.resolve({ error: reason });
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = this.proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const waiter = this.pending.shift();
          if (!waiter) continue;
          try {
            waiter.resolve(JSON.parse(line) as LexResponse);
          } catch {
            waiter.resolve({ error: `unparseable response line: ${line.slice(0, 120)}` });
          }
        }
      }
    } finally {
      this.fail("mdview __parity lex closed its stdout");
    }
  }

  lex(body: string, tier: Tier): Promise<LexResponse> {
    if (this.dead !== null) return Promise.resolve({ error: this.dead });
    return new Promise((resolveResponse) => {
      this.pending.push({ resolve: resolveResponse });
      try {
        this.proc.stdin.write(`${JSON.stringify({ body, tier })}\n`);
        this.proc.stdin.flush();
      } catch (error) {
        this.fail(`write to mdview __parity lex failed: ${String(error)}`);
      }
    });
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end();
    } catch {
      // already gone
    }
    await this.proc.exited;
  }
}

// ---------------------------------------------------------------------------
// The library entry point
// ---------------------------------------------------------------------------

export interface LexerDiffOptions {
  files: string[];
  tiers: readonly Tier[];
  /** Path to an `mdview` binary that speaks `__parity lex`. */
  mdview: string;
}

export interface LexerDiffSummary {
  files: number;
  pairs: number;
  /** Attributed site count per registry id. */
  attributed: Record<string, number>;
  disallowed: number;
  errors: number;
  disallowedSites: Array<{ file: string; tier: Tier; path: string; reason: string }>;
  errorEntries: Array<{ file: string; tier: Tier; error: string }>;
  ok: boolean;
}

export async function runLexerDiff(options: LexerDiffOptions): Promise<LexerDiffSummary> {
  const summary: LexerDiffSummary = {
    files: 0,
    pairs: 0,
    attributed: {},
    disallowed: 0,
    errors: 0,
    disallowedSites: [],
    errorEntries: [],
    ok: false,
  };
  const server = new LexServer(options.mdview);
  try {
    for (const file of options.files) {
      summary.files++;
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        for (const tier of options.tiers) summary.errorEntries.push({ file, tier, error: `read: ${String(error)}` });
        continue;
      }
      const body = splitFrontmatter(source).body;
      for (const tier of options.tiers) {
        let ts: CensusToken[];
        let rust: CensusToken[];
        try {
          ts = normalizeTokens(lexBody(body, glyphsFor(tier)));
        } catch (error) {
          summary.errorEntries.push({ file, tier, error: `ts lex: ${String(error)}` });
          continue;
        }
        const response = await server.lex(body, tier);
        if (response.error !== undefined || !Array.isArray(response.tokens)) {
          summary.errorEntries.push({ file, tier, error: `rust: ${response.error ?? "response carries no tokens"}` });
          continue;
        }
        try {
          rust = normalizeTokens(response.tokens);
        } catch (error) {
          summary.errorEntries.push({ file, tier, error: `rust tokens off-schema: ${String(error)}` });
          continue;
        }
        summary.pairs++;
        for (const site of diffTokens(ts, rust, tier)) {
          const verdict = attribute(site);
          if ("id" in verdict) {
            summary.attributed[verdict.id] = (summary.attributed[verdict.id] ?? 0) + 1;
          } else {
            summary.disallowed++;
            summary.disallowedSites.push({ file, tier, path: site.path, reason: verdict.disallowed });
          }
        }
      }
    }
  } finally {
    await server.close();
  }
  summary.errors = summary.errorEntries.length;
  summary.ok = summary.pairs > 0 && summary.errors === 0 && summary.disallowed === 0;
  return summary;
}

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  manifestFlag?: string;
  corpus: string;
  all: boolean;
  limit?: number;
  shard?: { index: number; count: number };
  tiers: Tier[];
  mdview?: string;
  dump?: string;
  dumpTier: Tier;
}

function parseTier(value: string | undefined, flag: string): Tier {
  if (value === "unicode" || value === "ascii") return value;
  throw new Error(`${flag} must be unicode or ascii (got ${JSON.stringify(value)})`);
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { corpus: "all", all: false, tiers: [...TIERS], dumpTier: "unicode" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = (): string => {
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--manifest") options.manifestFlag = next();
    else if (arg === "--corpus") options.corpus = next();
    else if (arg === "--all") options.all = true;
    else if (arg === "--limit") {
      const value = Number(next());
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit must be a positive integer");
      options.limit = value;
    } else if (arg === "--shard") {
      const match = /^(\d+)\/(\d+)$/.exec(next());
      const index = Number(match?.[1]);
      const count = Number(match?.[2]);
      if (!match || count < 1 || index < 1 || index > count) throw new Error("--shard must be i/n with 1 <= i <= n");
      options.shard = { index, count };
    } else if (arg === "--tiers") {
      options.tiers = next()
        .split(",")
        .map((t) => parseTier(t.trim(), "--tiers"));
    } else if (arg === "--mdview") options.mdview = next();
    else if (arg === "--dump") options.dump = next();
    else if (arg === "--tier") options.dumpTier = parseTier(next(), "--tier");
    else throw new Error(`lexer-diff: unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

/** Build the current checkout's `mdview` (a no-op when up to date) and return its path. */
export function buildDefaultMdview(): string {
  const result = Bun.spawnSync(["cargo", "build", "--release", "--locked", "-p", "mdview"], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`lexer-diff: cargo build -p mdview failed (exit ${result.exitCode})`);
  return DEFAULT_MDVIEW;
}

async function selectFiles(options: CliOptions): Promise<string[]> {
  const { path: manifestPath, source } = await resolveManifestSource(options.manifestFlag);
  console.log(`lexer-diff: corpus manifest ${manifestPath} (${source})`);
  const manifest = await loadManifest(manifestPath);
  const targets =
    options.corpus === "all" ? manifest.corpora : manifest.corpora.filter((spec) => spec.name === options.corpus);
  if (targets.length === 0) throw new Error(`lexer-diff: unknown corpus "${options.corpus}"`);
  const files: string[] = [];
  for (const spec of targets) {
    const resolved = await resolveCorpusFiles(spec, {});
    if (resolved === null) {
      console.log(`lexer-diff: [${spec.name}] SKIPPED — corpus root not found: ${spec.root}`);
      continue;
    }
    files.push(...selectCorpusFiles(resolved, spec, { all: options.all, limit: options.limit }));
  }
  files.sort();
  const shard = options.shard;
  return shard ? files.filter((_, k) => k % shard.count === shard.index - 1) : files;
}

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const options = parseArgs(args);
  if (options.dump !== undefined) {
    const source = await readFile(options.dump, "utf8");
    console.log(JSON.stringify(tsTokens(source, options.dumpTier), null, 2));
    return 0;
  }
  const files = await selectFiles(options);
  const mdview = options.mdview ?? buildDefaultMdview();
  const summary = await runLexerDiff({ files, tiers: options.tiers, mdview });
  for (const entry of summary.errorEntries.slice(0, 20)) {
    console.log(`lexer-diff: ERROR ${entry.file} [${entry.tier}]: ${entry.error}`);
  }
  if (summary.errorEntries.length > 20) console.log(`lexer-diff: … ${summary.errorEntries.length - 20} more errors`);
  for (const entry of summary.disallowedSites.slice(0, 50)) {
    console.log(`lexer-diff: DISALLOWED ${entry.file} [${entry.tier}] ${entry.path}: ${entry.reason}`);
  }
  for (const [id, count] of Object.entries(summary.attributed).sort()) {
    console.log(`lexer-diff: attributed ${id}=${count}`);
  }
  // Disallowed sites an unratified entry matches, per entry: what the user is asked to rule on.
  const unratified: Record<string, number> = {};
  for (const entry of summary.disallowedSites) {
    const m = / (\S+) matches but is not ratified$/.exec(` ${entry.reason}`);
    if (m?.[1]) unratified[m[1]] = (unratified[m[1]] ?? 0) + 1;
  }
  for (const [id, count] of Object.entries(unratified).sort()) {
    console.log(`lexer-diff: unratified ${id}=${count}`);
  }
  console.log(
    `lexer-diff: files=${summary.files} tiers=${options.tiers.join(",")} pairs=${summary.pairs} ` +
      `disallowed=${summary.disallowed} errors=${summary.errors} ok=${summary.ok}`,
  );
  if (summary.pairs === 0) console.log("lexer-diff: compared nothing — this is a failure, never a pass");
  return summary.ok ? 0 : 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    });
}
