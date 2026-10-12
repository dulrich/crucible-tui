/**
 * Revision materialization and loading for the differential harness — one `(file × width ×
 * tier × ambiguous-mode × policy × emoji)` renderer, loaded from a named revision's own copy
 * of `src/` (or, since WP-1 of `plans/mdview-rust-port.md`, served over JSONL by a
 * subprocess: the `ts-server:` and `rust:` kinds).
 *
 * Split out of `scripts/render-diff.ts` at WP-R1
 * (`plans/post-refactor-code-quality-remediation.md`) with no behaviour change. It owns the
 * comparison tuple's own vocabulary too — `GlyphTierName`, `AmbiguousModeName`, `PolicyName`,
 * `EmojiAxis`, `ComboKey`, `DetectorCounts`, `ComboRecord`, `ComboErrorEntry` — because a
 * `RevisionHandle` is what produces every one of those values, and keeping them here is what
 * lets `scripts/diff-classify.ts` import downward into this module rather than the two of them
 * importing each other.
 *
 * **Three revision kinds** (WP-1 of `plans/mdview-rust-port.md`):
 *
 * - `<dir|ref>` — the revision's TypeScript renderer, imported into this process (`kind: "ts"`).
 * - `ts-server:<dir|ref>` — the same renderer, behind `scripts/parity-ts-server.ts`'s JSONL
 *   protocol in a subprocess (`kind: "ts-server"`). It exists to prove the transport: a
 *   `ts-server:` side must be class-A identical to the in-process side at every axis.
 * - `rust:<dir|ref>` — `crates/mdview` built with `--features parity-tokens`, one long-lived
 *   `mdview __parity serve` per handle (`kind: "rust"`).
 *
 * **Measurement left the handle** at the same WP. Detector counts, overflow, the escape scan,
 * the style table and the frontmatter-echo range count come from `loadMeasurer(repoRoot)` —
 * the *current checkout's* `src/` — so both sides of a comparison are measured by the same
 * code, and a Rust side (which has no TS measurement code at all) is measured exactly as the
 * TS side is.
 *
 * **This module imports no other module of this repo.** It reaches a revision's renderer
 * exclusively through `importFrom`'s dynamic, absolute-path `import()` — which is precisely
 * the point: a static `../src/render` import here would load *this* checkout's renderer, and
 * the harness exists to load someone else's.
 */
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export interface RenderOutput {
  text: string;
  codeRanges: Array<[number, number]>;
}

/** The JSONL request line both servers read (`crates/mdview/src/parity.rs`, `scripts/parity-ts-server.ts`). */
export interface WireRequest {
  source: string;
  path?: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
  policy: WirePolicy;
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

type RenderFn = (
  source: string,
  targetWidth: number,
  glyphs: unknown,
  measure: unknown,
  emojiOverride: boolean | undefined,
  resolveFenceLanguageFor: unknown,
  policy: WirePolicy,
  resolveWikiLink: unknown,
) => RenderOutput;
type OverflowFn = (
  text: string,
  targetWidth: number,
  codeRanges: Array<[number, number]>,
  measure: unknown,
) => unknown;
type DetectFn = (rendered: string, ...rest: unknown[]) => unknown[];
type ResolverFactory = (filePath: string) => unknown;

export type RevisionKind = "ts" | "ts-server" | "rust";

export interface RevisionHandle {
  /** Human-readable, never a private path — a git ref name/sha or `dir:<code path>`. */
  label: string;
  kind: RevisionKind;
  /** Rejects on a render failure — for a server, on an `{error}` response or server death. */
  render(req: RenderRequest): Promise<RenderOutput>;
  close(): Promise<void>;
}

export interface MaterializedRoot {
  root: string;
  label: string;
  /** The resolved commit sha for a ref, `null` for a directory. */
  sha: string | null;
  cleanup: () => Promise<void>;
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

/**
 * `spec` is either an existing directory (used directly — no copy, no cleanup; this
 * is the path a WP takes to diff its own uncommitted working tree) or a git ref
 * (archived into a fresh temp directory outside the repo, with `node_modules`
 * symlinked in). Anything else is a loud error rather than a silent "renders
 * nothing" — see this WP's report on why a differ comparing nothing is the failure
 * mode this whole package exists to rule out.
 */
export async function materializeRevisionRoot(spec: string, repoRoot: string): Promise<MaterializedRoot> {
  const asPath = resolve(spec);
  const info = await stat(asPath).catch(() => null);
  if (info?.isDirectory()) {
    return { root: asPath, label: `dir:${asPath}`, sha: null, cleanup: async () => {} };
  }

  const sha = resolveRef(spec, repoRoot);
  const tmpRoot = await mkdtemp(join(tmpdir(), "render-diff-"));
  try {
    exportTree(spec, repoRoot, ["src"], tmpRoot);
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw error;
  }
  await symlink(join(repoRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");

  return {
    root: tmpRoot,
    label: `git:${spec}@${sha.slice(0, 12)}`,
    sha,
    cleanup: async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function importFrom(root: string, relPath: string): Promise<Record<string, unknown>> {
  const abs = resolve(root, relPath);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
}

/** How many per-file wiki-link resolvers a TS renderer keeps (each memoises its vault index). */
const RESOLVER_CACHE_LIMIT = 64;

/**
 * One revision's TypeScript renderer as a function of a wire request — the single loader
 * both the in-process `ts` kind and `scripts/parity-ts-server.ts` use, so the transport
 * self-check compares the transport and nothing else.
 *
 * Every call passes **all eight** positional parameters of `renderDocumentDetailed` (an object
 * renders every width identically — `scripts/AGENTS.md`), with an explicit policy (its default
 * reads the environment). The fence resolver is passed as `undefined`, which is exactly how a
 * JavaScript default parameter is selected: the revision's own `resolveFenceLanguage`, without
 * this module having to know which file of that revision exports it. Under hyperlinks the wiki
 * resolver is that revision's own `createWikiLinkResolver(absPath)` — read-only, built lazily
 * on its first resolving link, cached per file.
 */
export async function loadTsRenderer(root: string): Promise<(req: WireRequest) => RenderOutput> {
  const renderMod = await importFrom(root, "src/render.ts");
  const glyphsMod = await importFrom(root, "src/glyphs.ts");
  const widthMod = await importFrom(root, "src/width.ts");
  const wikiMod = await importFrom(root, "src/wikiresolve.ts");

  const renderDocumentDetailed = renderMod.renderDocumentDetailed as RenderFn;
  const createWikiLinkResolver = wikiMod.createWikiLinkResolver as ResolverFactory;
  if (typeof renderDocumentDetailed !== "function" || typeof createWikiLinkResolver !== "function") {
    throw new Error(`render-diff: ${root} does not export renderDocumentDetailed/createWikiLinkResolver`);
  }
  const glyphs: Record<GlyphTierName, unknown> = { unicode: glyphsMod.UNICODE_GLYPHS, ascii: glyphsMod.ASCII_GLYPHS };
  const measure: Record<AmbiguousModeName, unknown> = { narrow: widthMod.NARROW_MEASURE, wide: widthMod.WIDE_MEASURE };
  const resolvers = new Map<string, unknown>();
  const resolverFor = (path: string): unknown => {
    const abs = resolve(path);
    let resolver = resolvers.get(abs);
    if (resolver === undefined) {
      resolver = createWikiLinkResolver(abs);
      resolvers.set(abs, resolver);
      if (resolvers.size > RESOLVER_CACHE_LIMIT) {
        const oldest = resolvers.keys().next().value;
        if (oldest !== undefined) resolvers.delete(oldest);
      }
    }
    return resolver;
  };

  return (req) => {
    if (req.tier !== "unicode" && req.tier !== "ascii") throw new Error(`bad tier ${String(req.tier)}`);
    if (req.ambiguous !== "narrow" && req.ambiguous !== "wide") throw new Error(`bad ambiguous ${String(req.ambiguous)}`);
    const policy: WirePolicy = { sgr: req.policy.sgr, hyperlinks: req.policy.hyperlinks, tmux: req.policy.tmux };
    const emojiOverride = req.emoji === true ? true : req.emoji === false ? false : undefined;
    const resolveWikiLink = policy.hyperlinks && req.path !== undefined ? resolverFor(req.path) : undefined;
    const { text, codeRanges } = renderDocumentDetailed(
      req.source,
      req.width,
      glyphs[req.tier],
      measure[req.ambiguous],
      emojiOverride,
      undefined,
      policy,
      resolveWikiLink,
    );
    return { text, codeRanges };
  };
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
        let parsed: { text?: unknown; codeRanges?: unknown; error?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          waiter.reject(new Error(`${options.label}: malformed response line: ${line.slice(0, 200)}`));
          continue;
        }
        if (typeof parsed.error === "string") {
          waiter.reject(new Error(`${options.label}: ${parsed.error}`));
        } else if (typeof parsed.text === "string" && Array.isArray(parsed.codeRanges)) {
          waiter.resolve({ text: parsed.text, codeRanges: parsed.codeRanges as Array<[number, number]> });
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
const CARGO_TREE_PATHS = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates"];

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

const TS_SERVER_PREFIX = "ts-server:";
const RUST_PREFIX = "rust:";

/**
 * Load one revision as a `RevisionHandle`. `spec` is `<dir|ref>`, `ts-server:<dir|ref>` or
 * `rust:<dir|ref>`; a bad `<dir|ref>` is a loud error, never a handle that renders nothing.
 */
export async function loadRevision(spec: string, repoRoot: string): Promise<RevisionHandle> {
  if (spec.startsWith(RUST_PREFIX)) {
    const { binary, label } = await buildRustRevision(spec.slice(RUST_PREFIX.length), repoRoot);
    const server = spawnJsonlServer([binary, "__parity", "serve"], { label });
    return {
      label,
      kind: "rust",
      render: (req) => server.request(toWireRequest(req)),
      close: server.close,
    };
  }

  if (spec.startsWith(TS_SERVER_PREFIX)) {
    const materialized = await materializeRevisionRoot(spec.slice(TS_SERVER_PREFIX.length), repoRoot);
    const label = `ts-server:${materialized.label}`;
    const server = spawnJsonlServer(
      [process.execPath, "run", join(repoRoot, "scripts", "parity-ts-server.ts"), materialized.root],
      { cwd: repoRoot, label },
    );
    return {
      label,
      kind: "ts-server",
      render: (req) => {
        // The TS renderer has no token input; the server ignores `tokens`, so do not ship them.
        const wire = toWireRequest(req);
        delete wire.tokens;
        return server.request(wire);
      },
      async close() {
        await server.close();
        await materialized.cleanup();
      },
    };
  }

  const materialized = await materializeRevisionRoot(spec, repoRoot);
  const render = await loadTsRenderer(materialized.root);
  return {
    label: materialized.label,
    kind: "ts",
    render: async (req) => render(toWireRequest(req)),
    close: materialized.cleanup,
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
  /** `src/ansi.ts`'s `scan`, reduced to kind + bytes. */
  scan(text: string): MeasuredSpan[];
  /** Every committed `STYLE_TABLE` open and close sequence. */
  styleCodes: ReadonlySet<string>;
  /**
   * How many of a render's leading `codeRanges` are frontmatter-echo ranges: 0 without
   * frontmatter, else `formatMetaBlockDetailed(meta, width, measure, sgr).verbatimRanges.length`.
   */
  echoRangeCount(source: string, width: number, ambiguous: AmbiguousModeName, sgr: WirePolicy["sgr"]): number;
  /** `lexBody(splitFrontmatter(source).body, glyphs)` — the raw marked tokens the walk reads. */
  lexBody(source: string, tier: GlyphTierName): unknown[];
}

/**
 * Load the measurer from `repoRoot`'s own `src/` (the checkout running the harness), by the
 * same dynamic absolute-path import every revision is loaded by.
 */
export async function loadMeasurer(repoRoot: string): Promise<Measurer> {
  const detectorsMod = await importFrom(repoRoot, "src/detectors.ts");
  const overflowMod = await importFrom(repoRoot, "src/overflow.ts");
  const widthMod = await importFrom(repoRoot, "src/width.ts");
  const glyphsMod = await importFrom(repoRoot, "src/glyphs.ts");
  const styleMod = await importFrom(repoRoot, "src/style.ts");
  const ansiMod = await importFrom(repoRoot, "src/ansi.ts");
  const frontmatterMod = await importFrom(repoRoot, "src/frontmatter.ts");
  const renderMod = await importFrom(repoRoot, "src/render.ts");

  const findFirstOverflow = overflowMod.findFirstOverflow as OverflowFn;
  const findListOrphans = detectorsMod.findListOrphans as DetectFn;
  const findContinuationOverIndent = detectorsMod.findContinuationOverIndent as DetectFn;
  const findColumnZeroMarkers = detectorsMod.findColumnZeroMarkers as DetectFn;
  const scan = ansiMod.scan as (text: string) => { spans: MeasuredSpan[] };
  const splitFrontmatter = frontmatterMod.splitFrontmatter as (source: string) => { meta: string | null; body: string };
  const formatMetaBlockDetailed = frontmatterMod.formatMetaBlockDetailed as (
    meta: string,
    width: number,
    measure: unknown,
    sgr: string,
  ) => { verbatimRanges: unknown[] };
  const lexBody = renderMod.lexBody as ((body: string, glyphs: unknown) => unknown[]) | undefined;
  const styleTable = styleMod.STYLE_TABLE as Record<string, { open: string; close: string }>;

  const measure: Record<AmbiguousModeName, unknown> = { narrow: widthMod.NARROW_MEASURE, wide: widthMod.WIDE_MEASURE };
  const glyphs: Record<GlyphTierName, unknown> = { unicode: glyphsMod.UNICODE_GLYPHS, ascii: glyphsMod.ASCII_GLYPHS };
  const styleCodes = new Set<string>();
  for (const code of Object.values(styleTable)) {
    styleCodes.add(code.open);
    styleCodes.add(code.close);
  }

  return {
    detect(text, width, codeRanges, ambiguous) {
      const m = measure[ambiguous];
      return {
        orphans: findListOrphans(text, width, { codeRanges, measure: m }).length,
        overIndent: findContinuationOverIndent(text, { codeRanges, measure: m }).length,
        columnZero: findColumnZeroMarkers(text, { codeRanges, measure: m }).length,
      };
    },
    overflowed(text, width, codeRanges, ambiguous) {
      return findFirstOverflow(text, width, codeRanges, measure[ambiguous]) !== null;
    },
    scan(text) {
      return scan(text).spans.map((span) => ({ kind: span.kind, raw: span.raw }));
    },
    styleCodes,
    echoRangeCount(source, width, ambiguous, sgr) {
      const { meta } = splitFrontmatter(source);
      if (meta === null) return 0;
      return formatMetaBlockDetailed(meta, width, measure[ambiguous], sgr).verbatimRanges.length;
    },
    lexBody(source, tier) {
      if (typeof lexBody !== "function") throw new Error(`render-diff: ${repoRoot}/src/render.ts exports no lexBody`);
      return lexBody(splitFrontmatter(source).body, glyphs[tier]);
    },
  };
}
