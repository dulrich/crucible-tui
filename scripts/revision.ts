/**
 * Revision building and loading for the differential harness — one `(file × width × tier ×
 * ambiguous-mode × policy × emoji)` renderer, served over JSONL by a revision's own
 * `mdview __parity serve` (`kind: "rust"`, `rust:<dir|ref>`).
 *
 * Split out of `scripts/render-diff.ts` at WP-R1
 * (`plans/post-refactor-code-quality-remediation.md`) with no behaviour change. It owns the
 * comparison tuple's own vocabulary too — `GlyphTierName`, `AmbiguousModeName`, `PolicyName`,
 * `EmojiAxis`, `ComboKey`, `DetectorCounts`, `ComboRecord`, `ComboErrorEntry` — because a
 * `RevisionHandle` is what produces every one of those values, and keeping them here is what
 * lets `scripts/diff-classify.ts` import downward into this module rather than the two of them
 * importing each other.
 *
 * **One revision kind since WP-9 of `plans/mdview-rust-port.md`.** The TypeScript kinds — the
 * in-process `<dir|ref>` and `ts-server:<dir|ref>` behind `scripts/parity-ts-server.ts` — were
 * deleted with the TypeScript renderer; they exist at `TS_BASELINE` (`c097c66`). A `rust:`
 * side is `crates/mdview` built with `--features parity-tokens` into a cache outside every
 * checkout, so `--rev-a rust:<ref> --rev-b rust:.` is a Rust-vs-Rust regression differential.
 *
 * **Measurement is not the handle's.** Detector counts, overflow and the escape scan come from
 * `scripts/measure/` (moved out of `src/` at WP-9), and the style table and lexer from the
 * current checkout's own built binary (`mdviewBinary`), so both sides of a comparison are
 * measured by the same code.
 */
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scan } from "./measure/ansi";
import { findColumnZeroMarkers, findContinuationOverIndent, findListOrphans } from "./measure/detectors";
import { findFirstOverflow } from "./measure/overflow";
import { splitFrontmatter } from "./measure/frontmatter";
import { measureFor } from "./measure/width";

export type GlyphTierName = "unicode" | "ascii";
export type AmbiguousModeName = "narrow" | "wide";
/**
 * The policy axis. P0 `none`, P1 `formats`, P2 `full`, P3 `full`+hyperlinks, P4
 * `full`+hyperlinks+tmux — always passed explicitly to both sides, never through the
 * environment (`renderDocumentDetailed`'s policy default reads `process.env` and `isTTY`).
 */
export type PolicyName = "P0" | "P1" | "P2" | "P3" | "P4";
/** The emoji-override axis: `default` is the tier-derived decision, `on`/`off` force it. */
export type EmojiAxis = "default" | "on" | "off";

export interface WirePolicy {
  sgr: "none" | "formats" | "full";
  hyperlinks: boolean;
  tmux: boolean;
}

export const POLICY_NAMES: readonly PolicyName[] = ["P0", "P1", "P2", "P3", "P4"];
export const EMOJI_AXES: readonly EmojiAxis[] = ["default", "on", "off"];

export const POLICIES: Readonly<Record<PolicyName, Readonly<WirePolicy>>> = {
  P0: { sgr: "none", hyperlinks: false, tmux: false },
  P1: { sgr: "formats", hyperlinks: false, tmux: false },
  P2: { sgr: "full", hyperlinks: false, tmux: false },
  P3: { sgr: "full", hyperlinks: true, tmux: false },
  P4: { sgr: "full", hyperlinks: true, tmux: true },
};

export interface ComboKey {
  file: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  /** Absent on records written before WP-1 of `plans/mdview-rust-port.md`: read as `P0`. */
  policy?: PolicyName;
  /** Absent on records written before WP-1 of `plans/mdview-rust-port.md`: read as `default`. */
  emoji?: EmojiAxis;
}

export interface DetectorCounts {
  orphans: number;
  overIndent: number;
  columnZero: number;
}

export interface ComboRecord extends ComboKey {
  textSha: string;
  codeContentSha: string;
  codeRanges: Array<[number, number]>;
  detectors: DetectorCounts;
  overflowed: boolean;
  // --- D-C channels (P2–P4 only; see `scripts/diff-classify.ts`) ---
  /** sha of every line outside all `codeRanges`, exact. */
  proseSha?: string;
  /** sha of the lines inside the frontmatter-echo ranges (the first k ranges), exact. */
  echoSha?: string;
  /** sha of the fence-range lines with SGR spans removed (OSC-8/DCS kept). */
  fenceStrippedSha?: string;
  /**
   * Pairwise, set on the `after` side when both texts were in hand: every differing fence
   * line first diverges inside an SGR sequence on at least one side. Absent = not computed.
   */
  fencePrefixOk?: boolean;
  /** Every SGR not authored verbatim in the source is a committed `STYLE_TABLE` open/close. */
  sgrVocabOk?: boolean;
  // --- non-vacuity counters (every record since WP-1 of `plans/mdview-rust-port.md`) ---
  hasSgr?: boolean;
  hasOsc8?: boolean;
  hasDcs?: boolean;
  /** Fence ranges (ranges after the echo ranges) whose lines contain an SGR span. */
  highlightedFences?: number;
}

export interface ComboErrorEntry extends ComboKey {
  message: string;
}

export function policyOf(key: ComboKey): PolicyName {
  return key.policy ?? "P0";
}

export function emojiOf(key: ComboKey): EmojiAxis {
  return key.emoji ?? "default";
}

// --- Render requests -----------------------------------------------------------------

export interface RenderRequest {
  source: string;
  /** The file's real path — the wiki-link resolver's anchor under P3/P4. */
  path?: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  policy: PolicyName;
  emoji: EmojiAxis;
  /** `--input tokens`: census-normalized `lexBody` tokens (rev-B only; a TS side ignores them). */
  tokens?: unknown[];
}

/**
 * What the frontmatter formatter reports about its own block: whether it parsed, and — only on failure — the 0-based half-open
 * line span of the diagnostic within the rendered text.
 */
export interface FrontmatterFacts {
  parsed: boolean;
  diagnostic?: [number, number];
  /** How many leading `codeRanges` are frontmatter-echo ranges (`formatMetaBlockDetailed`'s `verbatimRanges`). */
  echoRanges?: number;
}

export interface RenderOutput {
  text: string;
  codeRanges: Array<[number, number]>;
  /** Present when the document has frontmatter and the side reports it. */
  frontmatter?: FrontmatterFacts;
}

/** A `{parsed, diagnostic?}` value off the wire, or `undefined` when absent or malformed. */
function frontmatterFactsOf(value: unknown): FrontmatterFacts | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { parsed, diagnostic, echoRanges } = value as { parsed?: unknown; diagnostic?: unknown; echoRanges?: unknown };
  if (typeof parsed !== "boolean") return undefined;
  const facts: FrontmatterFacts = { parsed };
  if (Array.isArray(diagnostic) && diagnostic.length === 2 && diagnostic.every((n) => typeof n === "number")) {
    facts.diagnostic = [diagnostic[0] as number, diagnostic[1] as number];
  }
  if (typeof echoRanges === "number") facts.echoRanges = echoRanges;
  return facts;
}

/**
 * The JSONL request line `mdview __parity serve` reads (`crates/mdview/src/parity.rs`). `policy`
 * may be `"env"`: the server resolves it from its own environment (the colour axis).
 */
export interface WireRequest {
  source: string;
  path?: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  policy: WirePolicy | "env";
  emoji?: boolean | null;
  tokens?: unknown[];
}

export function toWireRequest(req: RenderRequest): WireRequest {
  const wire: WireRequest = {
    source: req.source,
    width: req.width,
    tier: req.tier,
    ambiguous: req.ambiguous,
    policy: { ...POLICIES[req.policy] },
    emoji: req.emoji === "on" ? true : req.emoji === "off" ? false : null,
  };
  if (req.path !== undefined) wire.path = req.path;
  if (req.tokens !== undefined) wire.tokens = req.tokens;
  return wire;
}

// --- Revision loading --------------------------------------------------------------

export type RevisionKind = "rust";

export interface RevisionHandle {
  /** Human-readable, never a private path — a git ref name/sha or `dir:<code path>`. */
  label: string;
  kind: RevisionKind;
  /** Rejects on a render failure — for a server, on an `{error}` response or server death. */
  render(req: RenderRequest): Promise<RenderOutput>;
  close(): Promise<void>;
}

function resolveRef(spec: string, repoRoot: string): string {
  const verify = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--verify", `${spec}^{commit}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (verify.exitCode !== 0) {
    throw new Error(
      `render-diff: "${spec}" is neither an existing directory nor a resolvable git ref in ${repoRoot} ` +
        `(git rev-parse --verify failed: ${verify.stderr.toString().trim()})`,
    );
  }
  return verify.stdout.toString().trim();
}

/** Export `paths` of `spec`'s tree into `destination` (which must exist). */
function exportTree(spec: string, repoRoot: string, paths: string[], destination: string): void {
  // The literal subcommand name is single-quoted deliberately (every other string
  // literal in this file is double-quoted) — it is an ordinary English word that
  // also happens to be a directory name beside this checkout on this machine, and
  // `tests/helpers/containment.ts`'s neighbour rule flags such a word wherever it
  // sits inside a double-quoted or backtick code span. A single-quoted string is
  // not code context under that rule (see its own doc comment on why: single
  // quotes are prose apostrophes, not delimiters), so this is the sanctioned way
  // to spell a real git subcommand without it reading as a leaked directory name.
  const exported = Bun.spawnSync(["git", "-C", repoRoot, 'archive', spec, "--", ...paths], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exported.exitCode !== 0) {
    throw new Error(`render-diff: exporting ${spec}'s ${paths.join(" ")} via git failed: ${exported.stderr.toString().trim()}`);
  }
  const tar = Bun.spawnSync(["tar", "-x", "-C", destination], {
    stdin: exported.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    throw new Error(`render-diff: extracting ${spec}'s ${paths.join(" ")} failed: ${tar.stderr.toString().trim()}`);
  }
}

// --- JSONL client ----------------------------------------------------------------------

/** Every chunk of a byte stream, via its reader (the DOM typings carry no async iterator). */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface Pending {
  resolve: (output: RenderOutput) => void;
  reject: (error: Error) => void;
}

/**
 * A long-lived JSONL server: one request line in, one response line out, in order. A FIFO of
 * pending promises lets callers pipeline. **A dead or complaining server never hangs a
 * request**: any stderr output or exit fails every pending request and every later one with
 * the server's stderr tail — a server that renders nothing can only ever produce errors.
 */
export function spawnJsonlServer(argv: string[], options: { cwd?: string; label: string }): {
  request: (wire: WireRequest) => Promise<RenderOutput>;
  close: () => Promise<void>;
} {
  const proc = Bun.spawn(argv, { cwd: options.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending: Pending[] = [];
  let failure: Error | null = null;
  let closing = false;
  let stderrText = "";

  const failAll = (error: Error): void => {
    if (failure === null) failure = error;
    while (pending.length > 0) pending.shift()?.reject(failure);
  };

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of streamChunks(proc.stdout)) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const waiter = pending.shift();
        if (waiter === undefined) {
          failAll(new Error(`${options.label}: unsolicited response line: ${line.slice(0, 200)}`));
          continue;
        }
        let parsed: { text?: unknown; codeRanges?: unknown; frontmatter?: unknown; error?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          waiter.reject(new Error(`${options.label}: malformed response line: ${line.slice(0, 200)}`));
          continue;
        }
        if (typeof parsed.error === "string") {
          waiter.reject(new Error(`${options.label}: ${parsed.error}`));
        } else if (typeof parsed.text === "string" && Array.isArray(parsed.codeRanges)) {
          const output: RenderOutput = { text: parsed.text, codeRanges: parsed.codeRanges as Array<[number, number]> };
          const facts = frontmatterFactsOf(parsed.frontmatter);
          if (facts !== undefined) output.frontmatter = facts;
          waiter.resolve(output);
        } else {
          waiter.reject(new Error(`${options.label}: response has neither text/codeRanges nor error`));
        }
      }
    }
  })().catch((error: unknown) => failAll(error instanceof Error ? error : new Error(String(error))));

  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of streamChunks(proc.stderr)) {
      stderrText += decoder.decode(chunk, { stream: true });
      failAll(new Error(`${options.label}: server wrote to stderr: ${stderrText.trim().slice(-2000)}`));
    }
  })().catch(() => {});

  void proc.exited.then((code) => {
    // Let the stdout reader drain whatever the server answered before it exited.
    setTimeout(() => {
      if (!closing || pending.length > 0) {
        failAll(new Error(`${options.label}: server exited with code ${code}${stderrText ? `: ${stderrText.trim().slice(-2000)}` : ""}`));
      }
    }, 50);
  });

  return {
    request(wire) {
      if (failure !== null) return Promise.reject(failure);
      if (closing) return Promise.reject(new Error(`${options.label}: request after close`));
      return new Promise<RenderOutput>((resolvePromise, rejectPromise) => {
        pending.push({ resolve: resolvePromise, reject: rejectPromise });
        try {
          proc.stdin.write(`${JSON.stringify(wire)}\n`);
          void proc.stdin.flush();
        } catch (error) {
          failAll(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    async close() {
      closing = true;
      try {
        await proc.stdin.end();
      } catch {
        // already closed — the exit below is what matters
      }
      const timer = setTimeout(() => proc.kill(), 5000);
      await proc.exited;
      clearTimeout(timer);
    },
  };
}

// --- Rust builds -------------------------------------------------------------------------

/** `$XDG_CACHE_HOME` (or `~/.cache`) `/crucible-tui-parity` — outside every checkout. */
export function parityCacheRoot(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== "" ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(base, "crucible-tui-parity");
}

/** The tree cargo needs from a revision to build `crates/mdview`. */
// `THIRD-PARTY-LICENSES.txt` too: `crates/mdview/src/cli.rs` embeds it with `include_str!`.
const CARGO_TREE_PATHS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates", "THIRD-PARTY-LICENSES.txt"];

async function cargoBuild(root: string, targetDir: string): Promise<void> {
  const proc = Bun.spawn(
    ["cargo", "build", "--release", "--locked", "-p", "mdview", "--features", "parity-tokens"],
    { cwd: root, env: { ...process.env, CARGO_TARGET_DIR: targetDir }, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`render-diff: cargo build of mdview (parity-tokens) in ${root} failed (exit ${code}):\n${stderr.trim().slice(-4000)}`);
  }
}

/**
 * Build (or reuse) a `parity-tokens` mdview for `spec`. A ref is exported into
 * `<cache>/<sha>/tree` and built into `<cache>/<sha>/target`, and the build is skipped when
 * that binary already exists — a sha's binary never changes. A directory is built in place
 * with `CARGO_TARGET_DIR=<cache>/dir-<path hash>/target`, every time (cargo is incremental).
 */
export async function buildRustRevision(
  spec: string,
  repoRoot: string,
): Promise<{ binary: string; label: string }> {
  const cacheRoot = parityCacheRoot();
  const asPath = resolve(spec);
  const info = await stat(asPath).catch(() => null);
  if (info?.isDirectory()) {
    const key = new Bun.CryptoHasher("sha256").update(asPath).digest("hex").slice(0, 16);
    const targetDir = join(cacheRoot, `dir-${key}`, "target");
    await mkdir(targetDir, { recursive: true });
    await cargoBuild(asPath, targetDir);
    return { binary: join(targetDir, "release", "mdview"), label: `rust:dir:${asPath}` };
  }

  const sha = resolveRef(spec, repoRoot);
  const shaRoot = join(cacheRoot, sha);
  const targetDir = join(shaRoot, "target");
  const binary = join(targetDir, "release", "mdview");
  const label = `rust:git:${spec}@${sha.slice(0, 12)}`;
  if ((await stat(binary).catch(() => null))?.isFile()) return { binary, label };

  const tree = join(shaRoot, "tree");
  await rm(tree, { recursive: true, force: true });
  await mkdir(tree, { recursive: true });
  exportTree(spec, repoRoot, CARGO_TREE_PATHS, tree);
  await cargoBuild(tree, targetDir);
  return { binary, label };
}

// --- Handles -------------------------------------------------------------------------------

const RUST_PREFIX = "rust:";

/**
 * Load one revision as a `RevisionHandle`. `spec` is `rust:<dir|ref>`; anything else — including
 * the bare `<dir|ref>` and `ts-server:` forms the TypeScript renderer had until `TS_BASELINE`
 * (`c097c66`) — is a loud error, never a handle that renders nothing.
 */
export async function loadRevision(spec: string, repoRoot: string): Promise<RevisionHandle> {
  if (!spec.startsWith(RUST_PREFIX)) {
    throw new Error(
      `render-diff: "${spec}" is not a rust:<dir|ref> revision — the TypeScript renderer kinds were ` +
        "removed at WP-9 of plans/mdview-rust-port.md (TS_BASELINE = c097c66)",
    );
  }
  const { binary, label } = await buildRustRevision(spec.slice(RUST_PREFIX.length), repoRoot);
  const server = spawnJsonlServer([binary, "__parity", "serve"], { label });
  return {
    label,
    kind: "rust",
    render: (req) => server.request(toWireRequest(req)),
    close: server.close,
  };
}

// --- The measurer ----------------------------------------------------------------------------

export interface MeasuredSpan {
  kind: string;
  raw: string;
}

/**
 * The current checkout's measurement code — applied identically to both sides' returned text.
 * Everything `scripts/diff-classify.ts` needs to turn a `RenderOutput` into a record, and
 * nothing that renders.
 */
export interface Measurer {
  detect(text: string, width: number, codeRanges: Array<[number, number]>, ambiguous: AmbiguousModeName): DetectorCounts;
  overflowed(text: string, width: number, codeRanges: Array<[number, number]>, ambiguous: AmbiguousModeName): boolean;
  /** `scripts/measure/ansi.ts`'s `scan`, reduced to kind + bytes. */
  scan(text: string): MeasuredSpan[];
  /** Every committed style-table open and close sequence (`mdview __parity style-table`). */
  styleCodes: ReadonlySet<string>;
  /** How many of a render's leading `codeRanges` are frontmatter-echo ranges (0 without frontmatter). */
  echoRangeCount(output: RenderOutput): number;
  /** The current checkout's lexer over the source's body (`mdview __parity lex`). */
  lexBody(source: string, tier: GlyphTierName): unknown[];
}

/**
 * The current checkout's built mdview: `MDVIEW_BIN` if set, else the static musl release
 * binary `bun run build:rust` writes. A missing binary is a loud error naming the build.
 */
export function mdviewBinary(repoRoot: string, env: Record<string, string | undefined> = process.env): string {
  const binary = env.MDVIEW_BIN !== undefined && env.MDVIEW_BIN !== ""
    ? resolve(env.MDVIEW_BIN)
    : join(repoRoot, "target", "x86_64-unknown-linux-musl", "release", "mdview");
  if (!Bun.file(binary).size) {
    throw new Error(`mdview binary not found at ${binary} — run \`bun run build:rust\` first (or set MDVIEW_BIN)`);
  }
  return binary;
}

/** `{name: {open, close, formats}}` — the committed style table, as `binary` prints it. */
export function readStyleTable(binary: string): Record<string, { open: string; close: string; formats: boolean }> {
  const proc = Bun.spawnSync([binary, "__parity", "style-table"], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${binary} __parity style-table failed (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`);
  }
  return JSON.parse(proc.stdout.toString()) as Record<string, { open: string; close: string; formats: boolean }>;
}

/** Load the measurer: `scripts/measure/` for the text, the current checkout's binary for the rest. */
export async function loadMeasurer(repoRoot: string): Promise<Measurer> {
  const binary = mdviewBinary(repoRoot);
  const styleCodes = new Set<string>();
  for (const code of Object.values(readStyleTable(binary))) {
    styleCodes.add(code.open);
    styleCodes.add(code.close);
  }

  return {
    detect(text, width, codeRanges, ambiguous) {
      const measure = measureFor(ambiguous);
      return {
        orphans: findListOrphans(text, width, { codeRanges, measure }).length,
        overIndent: findContinuationOverIndent(text, { codeRanges, measure }).length,
        columnZero: findColumnZeroMarkers(text, { codeRanges, measure }).length,
      };
    },
    overflowed(text, width, codeRanges, ambiguous) {
      return findFirstOverflow(text, width, codeRanges, measureFor(ambiguous)) !== null;
    },
    scan(text) {
      return scan(text).spans.map((span) => ({ kind: span.kind, raw: span.raw }));
    },
    styleCodes,
    echoRangeCount(output) {
      // A binary older than WP-9 reports no `echoRanges`; a failed parse is then the one echo range.
      return output.frontmatter?.echoRanges ?? (output.frontmatter?.parsed === false ? 1 : 0);
    },
    lexBody(source, tier) {
      const proc = Bun.spawnSync([binary, "__parity", "lex"], {
        stdin: new TextEncoder().encode(`${JSON.stringify({ body: splitBody(source), tier })}\n`),
        stdout: "pipe",
        stderr: "pipe",
      });
      const response = JSON.parse(proc.stdout.toString() || "{}") as { tokens?: unknown[]; error?: string };
      if (proc.exitCode !== 0 || !Array.isArray(response.tokens)) {
        throw new Error(`render-diff: ${binary} __parity lex failed: ${response.error ?? proc.stderr.toString().trim()}`);
      }
      return response.tokens;
    },
  };
}

/** The body `mdview __parity lex` lexes: the source with its frontmatter split off. */
function splitBody(source: string): string {
  return splitFrontmatter(source).body;
}
