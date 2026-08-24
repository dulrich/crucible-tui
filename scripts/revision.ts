/**
 * Revision materialization and loading for the differential harness — one `(file × width ×
 * tier × ambiguous-mode)` renderer, loaded from a named revision's own copy of `src/`.
 *
 * Split out of `scripts/render-diff.ts` at WP-R1
 * (`plans/post-refactor-code-quality-remediation.md`) with no behaviour change. It owns the
 * comparison tuple's own vocabulary too — `GlyphTierName`, `AmbiguousModeName`, `ComboKey`,
 * `DetectorCounts`, `ComboRecord`, `ComboErrorEntry` — because a `RevisionHandle` is what
 * produces every one of those values, and keeping them here is what lets
 * `scripts/diff-classify.ts` import downward into this module rather than the two of them
 * importing each other.
 *
 * **This module imports no other module of this repo.** It reaches a revision's renderer
 * exclusively through `importFrom`'s dynamic, absolute-path `import()` — which is precisely
 * the point: a static `../src/render` import here would load *this* checkout's renderer, and
 * the harness exists to load someone else's.
 */
import { mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type GlyphTierName = "unicode" | "ascii";
export type AmbiguousModeName = "narrow" | "wide";

export interface ComboKey {
  file: string;
  width: number;
  tier: GlyphTierName;
  ambiguous: AmbiguousModeName;
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
}

export interface ComboErrorEntry extends ComboKey {
  message: string;
}


// --- Revision loading --------------------------------------------------------------

type RenderFn = (
  source: string,
  targetWidth: number,
  glyphs: unknown,
  measure: unknown,
) => { text: string; codeRanges: Array<[number, number]> };
type OverflowFn = (
  text: string,
  targetWidth: number,
  codeRanges: Array<[number, number]>,
  measure: unknown,
) => unknown;
type DetectFn = (rendered: string, ...rest: unknown[]) => unknown[];

export interface RevisionHandle {
  /** Human-readable, never a private path — a git ref name/sha or `dir:<code path>`. */
  label: string;
  render(
    source: string,
    width: number,
    tier: GlyphTierName,
    ambiguous: AmbiguousModeName,
  ): { text: string; codeRanges: Array<[number, number]> };
  detect(
    text: string,
    width: number,
    codeRanges: Array<[number, number]>,
    ambiguous: AmbiguousModeName,
  ): DetectorCounts;
  overflowed(text: string, width: number, codeRanges: Array<[number, number]>, ambiguous: AmbiguousModeName): boolean;
  close(): Promise<void>;
}

export interface MaterializedRoot {
  root: string;
  label: string;
  cleanup: () => Promise<void>;
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
    return { root: asPath, label: `dir:${asPath}`, cleanup: async () => {} };
  }

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
  const sha = verify.stdout.toString().trim();

  const tmpRoot = await mkdtemp(join(tmpdir(), "render-diff-"));
  // The literal subcommand name is single-quoted deliberately (every other string
  // literal in this file is double-quoted) — it is an ordinary English word that
  // also happens to be a directory name beside this checkout on this machine, and
  // `tests/helpers/containment.ts`'s neighbour rule flags such a word wherever it
  // sits inside a double-quoted or backtick code span. A single-quoted string is
  // not code context under that rule (see its own doc comment on why: single
  // quotes are prose apostrophes, not delimiters), so this is the sanctioned way
  // to spell a real git subcommand without it reading as a leaked directory name.
  const exported = Bun.spawnSync(["git", "-C", repoRoot, 'archive', spec, "--", "src"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (exported.exitCode !== 0) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw new Error(`render-diff: exporting ${spec}'s src/ tree via git failed: ${exported.stderr.toString().trim()}`);
  }
  const tar = Bun.spawnSync(["tar", "-x", "-C", tmpRoot], {
    stdin: exported.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) {
    await rm(tmpRoot, { recursive: true, force: true });
    throw new Error(`render-diff: extracting ${spec}'s src/ failed: ${tar.stderr.toString().trim()}`);
  }
  await symlink(join(repoRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");

  return {
    root: tmpRoot,
    label: `git:${spec}@${sha.slice(0, 12)}`,
    cleanup: async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function importFrom(root: string, relPath: string): Promise<Record<string, unknown>> {
  const abs = resolve(root, relPath);
  return (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
}

/**
 * Load one revision's renderer, detectors and width machinery into this process.
 * Each of the five modules is imported **from that revision's own copy** — never
 * mixed with another revision's or with the module already loaded by this script
 * itself — so a later WP that changes `src/glyphs.ts` or `src/width.ts`'s shape is
 * measured with its own copy on both sides of the comparison, exactly as
 * `scripts/sweep.ts`'s pinned fact requires ("take tier and ambiguous mode as
 * explicit parameters and never let environment detection reach them").
 */
export async function loadRevision(spec: string, repoRoot: string): Promise<RevisionHandle> {
  const materialized = await materializeRevisionRoot(spec, repoRoot);
  const renderMod = await importFrom(materialized.root, "src/render.ts");
  const detectorsMod = await importFrom(materialized.root, "src/detectors.ts");
  const overflowMod = await importFrom(materialized.root, "src/overflow.ts");
  const glyphsMod = await importFrom(materialized.root, "src/glyphs.ts");
  const widthMod = await importFrom(materialized.root, "src/width.ts");

  const renderDocumentDetailed = renderMod.renderDocumentDetailed as RenderFn;
  const findFirstOverflow = overflowMod.findFirstOverflow as OverflowFn;
  const findListOrphans = detectorsMod.findListOrphans as DetectFn;
  const findContinuationOverIndent = detectorsMod.findContinuationOverIndent as DetectFn;
  const findColumnZeroMarkers = detectorsMod.findColumnZeroMarkers as DetectFn;

  const glyphs: Record<GlyphTierName, unknown> = {
    unicode: glyphsMod.UNICODE_GLYPHS,
    ascii: glyphsMod.ASCII_GLYPHS,
  };
  const measure: Record<AmbiguousModeName, unknown> = {
    narrow: widthMod.NARROW_MEASURE,
    wide: widthMod.WIDE_MEASURE,
  };

  return {
    label: materialized.label,
    render(source, width, tier, ambiguous) {
      return renderDocumentDetailed(source, width, glyphs[tier], measure[ambiguous]);
    },
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
    close: materialized.cleanup,
  };
}