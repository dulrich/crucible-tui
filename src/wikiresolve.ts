/**
 * Vault-root discovery, a lazy file index, wiki-link slug resolution and `file://` URI
 * formatting — the pure half of `plans/follow-wiki-links.md`'s D1, D2 and D6.
 *
 * Everything here is a function of an explicitly injected `WikiFs`, never of `node:fs`
 * directly except inside `defaultWikiFs` itself — no `process.env`, no argv, no TTY read,
 * no escape byte (root `AGENTS.md`, "Dependencies": policy and emission stay owned by
 * this repo, decided from inputs threaded in, never read from the process). D6 keeps the
 * renderer pure: this module is wired in from `src/cli.ts` only (WP-2), never called from
 * a renderer visitor directly.
 *
 * - `findVaultRoot` walks up from a file's directory to the nearest ancestor holding
 *   `.obsidian` or `.git` (D1) — either as a file or a directory, since a git worktree's
 *   own `.git` is a file, not a directory.
 * - `buildWikiIndex` lists a root once (skipping dot-directories, `node_modules`, and
 *   never descending into a symlinked directory) and indexes files by exact relative
 *   path and by basename, in both an exact-case tier and a case-insensitive tier.
 * - `resolveWikiSlug` applies D2's rules in order — exact relative path, then unique
 *   basename, then a deterministic tiebreak (fewest path segments, then
 *   lexicographically smallest relative path) — exact-case first, then the same three
 *   rules case-insensitively.
 * - `fileUri` percent-encodes an absolute path (and an optional fragment) per RFC 3986:
 *   only unreserved characters and `/` stay literal; everything else — space, `#`, `%`,
 *   `?`, every other reserved character, and non-ASCII — is escaped as UTF-8 octets.
 * - `createWikiLinkResolver` composes the above into the one function the
 *   `resolveWikiLink` seam (`src/layout-context.ts`, WP-2) will carry; the root and the
 *   index are built on the returned resolver's first call, never at creation, so a
 *   render that never emits a resolving wiki-link never pays for either.
 *
 * What this module deliberately does not do: it never renders, never emits an OSC-8
 * sequence, and never decides *whether* to hyperlink at all — `ctx.hyperlinks` and
 * `styleWikiLabel` (WP-2) own that entirely. It also never walks outside `root`: a slug
 * that is absolute or carries a `..` segment refuses to resolve rather than escaping the
 * vault.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One entry from `WikiFs.list`. `relPath` is root-relative, POSIX-separated (`/`, never
 * `\`, regardless of host OS) and carries no leading `./`. A symlinked directory is
 * reported here with `isSymbolicLink: true` and `isDirectory: true` — this module
 * follows a symlink exactly once, with a single non-recursive `stat`, purely to
 * classify what it points to; it never lists the target's contents. A broken symlink,
 * or one pointing at a non-directory, reports `isDirectory: false`. `list` does not
 * descend into anything with `isSymbolicLink: true`, whatever its `isDirectory` says —
 * that flag exists so `buildWikiIndex`'s plain "skip directories" filter also skips a
 * symlinked directory's own entry, rather than indexing it as if it were an openable
 * file.
 */
export interface WikiEntry {
  readonly relPath: string;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The injected filesystem seam (audit E1's pinned shape). `exists` answers "is there
 * anything at all at this path" (file or directory, no distinction — `.git` is a
 * directory in an ordinary clone and a file in a worktree, and D1 treats both as a hit).
 * `list` returns every entry reachable under `root`, at every depth, without descending
 * into a directory named `.git`, `.obsidian`, `node_modules`, or any other
 * dot-directory, and without following a symlinked directory.
 */
export interface WikiFs {
  exists(path: string): boolean;
  list(root: string): readonly WikiEntry[];
}

/** A directory name `list` reaches into `root` but must never descend past. */
function isExcludedDirName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/** Follows one symlink (never its target's contents) to classify it; broken → not a directory. */
function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Iterative directory walk (no recursion), one `readdirSync` per directory. Measured
 * directly against this Bun (1.3.11): `readdirSync(root, { recursive: true,
 * withFileTypes: true })` **does** follow a symlinked directory into its target — the
 * probe reproduced this by symlinking one directory into another and observing the
 * recursive listing descend through the link and report the target's own contents with
 * `parentPath` rewritten to the link's path. That is the opposite of what `WikiFs.list`
 * needs (a symlinked directory reported, never descended into), so this walk is
 * explicit rather than delegating to the recursive option. Confirmed separately: the
 * plain, non-recursive `readdirSync(dir, { withFileTypes: true })` this walk actually
 * calls reports `isDirectory(): false` / `isSymbolicLink(): true` for both a live
 * symlinked directory and a broken one, without following either — exactly the
 * per-directory primitive this walk needs.
 */
function listDirectoryTree(root: string): readonly WikiEntry[] {
  const entries: WikiEntry[] = [];
  // Each stack frame is the chain of name segments from `root` down to a directory this
  // walk still needs to read; `[]` means `root` itself.
  const stack: string[][] = [[]];
  while (stack.length > 0) {
    const segments = stack.pop();
    if (segments === undefined) break; // unreachable — guarded by `stack.length > 0`
    const absoluteDir = segments.length === 0 ? root : join(root, ...segments);
    let dirents;
    try {
      dirents = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      continue; // vanished or unreadable between listing and reading — skip, don't throw
    }
    for (const dirent of dirents) {
      const childSegments = [...segments, dirent.name];
      const isSymbolicLink = dirent.isSymbolicLink();
      const isDirectory = isSymbolicLink ? statIsDirectory(join(absoluteDir, dirent.name)) : dirent.isDirectory();
      entries.push({
        relPath: childSegments.join("/"),
        isDirectory,
        isSymbolicLink,
      });
      // Never descend into a symlink, whether or not it points at a directory — this
      // is the one rule that must not read `isDirectory` for a symlinked entry.
      if (isDirectory && !isSymbolicLink && !isExcludedDirName(dirent.name)) {
        stack.push(childSegments);
      }
    }
  }
  return entries;
}

/** `WikiFs` over `node:fs`, via the iterative walk above. */
export const defaultWikiFs: WikiFs = {
  exists: (path: string): boolean => existsSync(path),
  list: (root: string): readonly WikiEntry[] => listDirectoryTree(root),
};

/**
 * D1: starting at `dirname(filePath)`, walk up through ancestors; the first directory
 * containing `.obsidian` or `.git` (either — an `exists` check, not a directory check)
 * is the root. If the filesystem root is reached with no hit, the file's own directory
 * is the root.
 */
export function findVaultRoot(filePath: string, fs: WikiFs = defaultWikiFs): string {
  const start = dirname(filePath);
  let dir = start;
  while (true) {
    if (fs.exists(join(dir, ".obsidian")) || fs.exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // reached the filesystem root without a hit
    dir = parent;
  }
}

/** One case tier's two lookup shapes over the same file set. */
interface SlugTier {
  /** Exact relative path (as indexed — lowercased for the case-insensitive tier). */
  readonly byRelPath: ReadonlyMap<string, string>;
  /**
   * Basename (as indexed — lowercased for the case-insensitive tier) to every relative
   * path sharing it; a bucket with more than one entry is D2 rule (c)'s ambiguous case.
   */
  readonly byBasename: ReadonlyMap<string, readonly string[]>;
}

/**
 * The built index: a vault root plus its files, indexed by exact relative path and by
 * basename, twice over — once exact-case, once case-insensitive (D2: exact-case tiers
 * are tried first, then the same rules case-insensitively). Deliberately just two maps
 * per tier plus the root that made them — `resolveWikiSlug` needs nothing richer.
 */
export interface WikiIndex {
  readonly root: string;
  readonly exact: SlugTier;
  readonly caseInsensitive: SlugTier;
}

/** The last `/`-separated segment of a POSIX-style relative path or slug. */
function lastPathSegment(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function addToBucket(bucket: Map<string, string[]>, key: string, relPath: string): void {
  const existing = bucket.get(key);
  if (existing) existing.push(relPath);
  else bucket.set(key, [relPath]);
}

/**
 * Lists `root` once and indexes files only (directories, including excluded ones, are
 * skipped here — `list` already declined to descend into the excluded ones, but a
 * directory entry itself, e.g. a non-dot subdirectory, is still returned by `list` and
 * is not a resolution candidate). A symlinked file is a file (its `isDirectory` is
 * `false`) and is indexed like any other.
 */
export function buildWikiIndex(root: string, fs: WikiFs = defaultWikiFs): WikiIndex {
  const exactByRelPath = new Map<string, string>();
  const exactByBasename = new Map<string, string[]>();
  const ciByRelPath = new Map<string, string>();
  const ciByBasename = new Map<string, string[]>();

  for (const entry of fs.list(root)) {
    if (entry.isDirectory) continue;
    const relPath = entry.relPath;

    if (!exactByRelPath.has(relPath)) exactByRelPath.set(relPath, relPath);
    const lowerRelPath = relPath.toLowerCase();
    if (!ciByRelPath.has(lowerRelPath)) ciByRelPath.set(lowerRelPath, relPath);

    const basename = lastPathSegment(relPath);
    addToBucket(exactByBasename, basename, relPath);
    addToBucket(ciByBasename, basename.toLowerCase(), relPath);
  }

  return {
    root,
    exact: { byRelPath: exactByRelPath, byBasename: exactByBasename },
    caseInsensitive: { byRelPath: ciByRelPath, byBasename: ciByBasename },
  };
}

/** D2 rule (c): fewest path segments, then lexicographically smallest `relPath`. */
function pickBest(candidates: readonly string[]): string {
  return candidates.reduce((best, candidate) => (compareCandidates(candidate, best) < 0 ? candidate : best));
}

function compareCandidates(a: string, b: string): number {
  const segmentDiff = a.split("/").length - b.split("/").length;
  if (segmentDiff !== 0) return segmentDiff;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Applies D2 rules (a), (b) and (c) within a single case tier. `caseFold` lowercases
 * both the slug-derived candidates and the tier lookups for the case-insensitive tier,
 * and is the identity for the exact-case tier — the tier's own maps are already keyed
 * that way by `buildWikiIndex`.
 */
function resolveInTier(tier: SlugTier, slug: string, caseFold: (s: string) => string): string | undefined {
  const pathCandidates = [slug, `${slug}.md`].map(caseFold);

  // Rule (a): exact relative path, `slug` before `slug + ".md"`.
  for (const candidate of pathCandidates) {
    const hit = tier.byRelPath.get(candidate);
    if (hit !== undefined) return hit;
  }

  // Rule (b): basename match on the slug's own last path segment (not the candidate's —
  // a slug with no `/` and a slug with one are treated alike; matching the full slug as
  // a relative-path suffix is not attempted). Rule (c) breaks any resulting tie.
  const lastSegment = lastPathSegment(slug);
  const basenameCandidates = [lastSegment, `${lastSegment}.md`].map(caseFold);
  const matches = new Set<string>();
  for (const candidate of basenameCandidates) {
    const bucket = tier.byBasename.get(candidate);
    if (bucket) for (const relPath of bucket) matches.add(relPath);
  }
  if (matches.size === 0) return undefined;
  return pickBest([...matches]);
}

const identity = (s: string): string => s;
const lower = (s: string): string => s.toLowerCase();

/**
 * D2, exactly: refuses (`undefined`) a slug that is absolute or carries a `..` segment;
 * trims surrounding whitespace; tries the exact-case tier's three rules, then the
 * case-insensitive tier's. Returns the resolved file's absolute path (`join(root,
 * relPath)`), never a bare `relPath`.
 */
export function resolveWikiSlug(index: WikiIndex, rawSlug: string): string | undefined {
  const slug = rawSlug.trim();
  if (slug === "" || slug.startsWith("/")) return undefined;
  if (slug.split("/").some((segment) => segment === "..")) return undefined;

  const exact = resolveInTier(index.exact, slug, identity);
  if (exact !== undefined) return join(index.root, exact);

  const caseInsensitive = resolveInTier(index.caseInsensitive, slug, lower);
  if (caseInsensitive !== undefined) return join(index.root, caseInsensitive);

  return undefined;
}

/** RFC 3986 unreserved characters: the only bytes this module ever leaves literal. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

function percentEncodeByte(byte: number): string {
  return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * Percent-encodes every character outside RFC 3986's unreserved set, one Unicode code
 * point at a time (so a surrogate pair is never split); a non-ASCII code point is
 * encoded as its UTF-8 octets, each octet its own `%XX`. Used for both a path segment
 * and the fragment: the fragment's contract only requires `#`, `%`, space and control
 * characters to be encoded and permits leaving more bare, and encoding to the same
 * strict unreserved-only set is a valid (if conservative) way to satisfy that floor —
 * recorded here so a reviewer doesn't mistake the reuse for having missed the fragment's
 * looser allowance.
 */
function percentEncode(text: string): string {
  let out = "";
  for (const ch of text) {
    if (UNRESERVED.test(ch)) {
      out += ch;
    } else {
      for (const byte of new TextEncoder().encode(ch)) out += percentEncodeByte(byte);
    }
  }
  return out;
}

/**
 * `file://` URI for an absolute path, per RFC 8089/3986: each `/`-separated segment is
 * percent-encoded independently (so the separators themselves stay literal) and joined
 * back with `/`, giving the standard triple-slash form (`file://` + empty authority +
 * the encoded absolute path, which itself starts with `/`). An optional fragment is
 * appended encoded, behind its own literal `#`. The caller guarantees `absPath` is
 * absolute; this function does not check.
 */
export function fileUri(absPath: string, fragment?: string): string {
  const encodedPath = absPath.split("/").map(percentEncode).join("/");
  const base = `file://${encodedPath}`;
  return fragment === undefined ? base : `${base}#${percentEncode(fragment)}`;
}

/**
 * Composes root discovery, index build and slug resolution into the one function the
 * `resolveWikiLink` seam carries. The root is found and the index built on the returned
 * function's **first call only**, then memoised in this closure for every later call —
 * never at `createWikiLinkResolver`'s own call, so a render with hyperlinks off, or one
 * that never emits a resolving wiki-link, never touches the filesystem here at all.
 */
export function createWikiLinkResolver(
  filePath: string,
  fs: WikiFs = defaultWikiFs,
): (slug: string, fragment?: string) => string | undefined {
  let index: WikiIndex | undefined;
  return (slug: string, fragment?: string): string | undefined => {
    if (index === undefined) {
      const root = findVaultRoot(filePath, fs);
      index = buildWikiIndex(root, fs);
    }
    const absPath = resolveWikiSlug(index, slug);
    return absPath === undefined ? undefined : fileUri(absPath, fragment);
  };
}
