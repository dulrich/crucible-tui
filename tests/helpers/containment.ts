import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Containment rules for a repo that is published publicly but developed next to
 * private siblings (WP-2h).
 *
 * The guard this replaces was a **denylist of five literal private strings**. A
 * denylist can only ever contain the leaks somebody already found: it was extended
 * twice by hand after near-misses, and both times it was still a name behind. It
 * also could not survive publication — the five literals *were* the disclosure, and
 * a history scrub would have rewritten the guard's own constants into placeholders.
 *
 * These rules are the inverse shape. Nothing private is named here. Each rule
 * describes what this repo's *own* content looks like and flags everything else, so
 * a sibling nobody has enumerated — one added next year — is caught by construction:
 *
 *   1. `foreign-path`   a path-shaped citation whose first segment is not a directory
 *                       this repo has, not an installed package, and not the
 *                       sanctioned fake root. This is how a neighbour's internal
 *                       layout leaks — `<other_tool>/<dir>/<file>.ts`, written out in
 *                       full. (Angle brackets here because the literal shape, spelled
 *                       plainly in this comment, is itself a finding. It was.)
 *   2. `home-path`      an absolute path under a home-like root, naming any account
 *                       other than the sanctioned fake one. This is how the machine's
 *                       directory layout leaks.
 *   3. `neighbour-name` a bare mention of a directory that actually sits around this
 *                       repo on this machine — read from the filesystem at run time,
 *                       never written down. This is how a name leaks in prose, where
 *                       it is not path-shaped and rule 1 cannot see it.
 *
 * Rules 1 and 2 need no configuration and no filesystem context beyond the repo
 * itself, so they are always on and are sufficient on their own. Rule 3 needs only
 * the directories that already exist around the checkout, which are always readable.
 * There is deliberately no mode in which the guard has nothing to check — one narrow
 * exception, `EXEMPT_ROOT_DIRS` below (`runs/**`, WP-12d), which stops the guard short of
 * a directory that is not part of the shared corpus in the first place. All three rules
 * still run on everything else, without exception.
 *
 * The one sanctioned fake vocabulary is `example` — `example/...` as a relative root
 * and `/home/example/...` as an absolute one. Test data and documentation that needs
 * a plausible path uses it; anything else is a finding.
 */

/** The single sanctioned fake path root. Everything else is a finding. */
export const SANCTIONED_FAKE_ROOT = "example";

/**
 * Filesystem-standard directory names. These are excluded from the neighbour set:
 * they sit on every machine's ancestor chain, they can never be a private project,
 * and several of them are ordinary English words that occur in prose.
 */
const FILESYSTEM_ROOTS = new Set([
  "bin",
  "boot",
  "cdrom",
  "dev",
  "etc",
  "home",
  "lib",
  "lib64",
  "lost+found",
  "media",
  "mnt",
  "opt",
  "proc",
  "root",
  "run",
  "sbin",
  "snap",
  "srv",
  "swapfile",
  "sys",
  "tmp",
  "usr",
  "Users",
  "var",
]);

/** Never walked: generated or vendored trees with no authored content. */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

/**
 * Machine-generated lock files. Exempt from rule 1 only: their base64 integrity
 * hashes and package `bin` entries are path-shaped by accident, and they carry no
 * authored prose. Rules 2 and 3 still apply to them, which is what would catch a
 * private registry URL or a home-relative resolution path.
 */
const GENERATED_LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export type ContainmentRule = "foreign-path" | "home-path" | "neighbour-name" | "listed-name";

export interface ContainmentFinding {
  rule: ContainmentRule;
  /** The exact text that triggered the rule. */
  token: string;
}

export interface ContainmentContext {
  /** Directory names this repo actually contains, plus its own top-level entries. */
  own: Set<string>;
  /** Installed package names, including `@scope/name` forms. */
  packages: Set<string>;
  /** Directory names that sit around this repo on this machine. */
  neighbours: Set<string>;
  /** Supplemental private names, if a list was supplied (see `loadSupplementalNames`). */
  listed: Set<string>;
}

/**
 * A path-shaped citation: a first segment that could be a directory name, followed
 * by at least one more segment.
 *
 * The lookbehind rejects anything already anchored to something else — a preceding
 * word character, `.`, `/`, `@`, `:`, `~`, `$`, `\`, `<`, `>` or `-`. That is what
 * keeps `node:fs/promises`, `@types/bun`, `$XDG_CONFIG_HOME/mdview/config.json`,
 * `/\s/.exec(...)`, `<path>/manifest.json` and the tail of an absolute path from
 * being read as relative citations.
 */
const PATH_CITATION = /(?<![\w./@:~$<>\\-])([A-Za-z_][A-Za-z0-9_.-]*)((?:\/[A-Za-z0-9_.-]+)+\/?)/g;

/** An absolute path under a home-like root, capturing the account segment. */
const HOME_PATH = /\/(?:home|Users|root)\/([A-Za-z0-9._-]+)/g;

/**
 * Code context: backtick spans (markdown inline code, template literals) and
 * double-quoted strings. Single quotes are deliberately not code context — in prose
 * they are apostrophes, and treating them as delimiters mis-brackets whole sentences.
 */
const CODE_SPAN = /`[^`]*`|"[^"]*"/g;

function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const match of line.matchAll(CODE_SPAN)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A name distinctive enough that it cannot be an ordinary English word: it carries a
 * separator or a digit and is long enough not to be an abbreviation. Distinctive
 * names are flagged wherever they appear; plain ones only inside a code span, where a
 * bare word is being used as an identifier rather than as prose.
 *
 * Real project directories are overwhelmingly of the first kind (`snake_case`,
 * `kebab-case`, a trailing version digit) and can therefore be caught mid-sentence.
 * The second kind is why the distinction exists at all: several directories beside a
 * checkout are single ordinary English words, and flagging those in prose would make
 * the guard unusable — which is how a guard ends up switched off.
 */
function isDistinctive(name: string): boolean {
  return name.length >= 4 && /[_-]|\d/.test(name);
}

/** Every finding on one line of one file. */
export function scanLine(
  line: string,
  context: ContainmentContext,
  options: { generatedLockfile?: boolean } = {},
): ContainmentFinding[] {
  const findings: ContainmentFinding[] = [];

  if (!options.generatedLockfile) {
    for (const match of line.matchAll(PATH_CITATION)) {
      const whole = match[0];
      const first = match[1] ?? "";
      const segments = (match[2] ?? "").split("/").filter((segment) => segment.length > 0);
      if (first === SANCTIONED_FAKE_ROOT) continue;
      if (context.own.has(first) || context.packages.has(first)) continue;
      if (context.packages.has(`${first}/${segments[0] ?? ""}`)) continue;
      // A citation names a file or a directory: it either ends in a slash or its last
      // segment carries an extension. Without this, English slash-lists ("either/or")
      // and ratios read as paths.
      const last = segments[segments.length - 1] ?? "";
      if (!whole.endsWith("/") && !/\.[A-Za-z0-9]{1,5}$/.test(last)) continue;
      findings.push({ rule: "foreign-path", token: whole });
    }
  }

  for (const match of line.matchAll(HOME_PATH)) {
    if (match[1] === SANCTIONED_FAKE_ROOT) continue;
    findings.push({ rule: "home-path", token: match[0] });
  }

  const spans = codeSpans(line);
  const inCode = (index: number): boolean => spans.some(([start, end]) => index >= start && index < end);

  for (const [names, rule] of [
    [context.neighbours, "neighbour-name"],
    [context.listed, "listed-name"],
  ] as Array<[Set<string>, ContainmentRule]>) {
    for (const name of names) {
      const pattern = new RegExp(`(?<![A-Za-z0-9_.-])${escapeForRegExp(name)}(?![A-Za-z0-9_-])`, "g");
      for (const match of line.matchAll(pattern)) {
        // A supplied private name is always a finding; a neighbour that is an ordinary
        // word is one only where it is being used as an identifier.
        if (rule === "listed-name" || isDistinctive(name) || inCode(match.index)) {
          findings.push({ rule, token: name });
        }
      }
    }
  }

  return findings;
}

/**
 * The directory holding the repository's *shared* git metadata, via
 * `git rev-parse --git-common-dir`. In an ordinary checkout this resolves to
 * `<root>/.git`; **in a worktree it resolves through the `gitdir:` pointer back to the
 * main checkout's `.git`** — which is exactly what `basename(root)` cannot do, because a
 * worktree's `root` is the branch-ish scratch directory (`.worktrees/<branch>`), not the
 * repository's real name.
 *
 * Returns `undefined` for anything that is not a git checkout at all (a plain extracted
 * tarball, `git` missing from `PATH`) — this is a widening supplement to `basename(root)`,
 * never a replacement, so its absence must degrade gracefully rather than error the way a
 * missing `node_modules` does for `packageNames`.
 */
function gitCommonDirRoot(root: string): string | undefined {
  try {
    const output = execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output.length === 0) return undefined;
    return dirname(resolve(root, output)); // strip the trailing `.git`
  } catch {
    return undefined;
  }
}

/**
 * This checkout's own `package.json` `name` field, if one exists and parses. Same
 * evidence standard as `isPackageCheckout` below: a name is trusted only when it comes
 * from a manifest this checkout actually carries, at its own root.
 */
function ownPackageName(root: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)) {
      const name = (manifest as Record<string, unknown>).name;
      if (typeof name === "string" && name.length > 0) return name;
    }
  } catch {
    // no manifest, unreadable, or unparsable — no evidence, so nothing to add
  }
  return undefined;
}

/**
 * The repository's real root: a worktree resolved back to its main checkout via git's
 * common dir, or `root` itself when there is no such metadata to consult. `ownNames` and
 * `neighbourNames` both key their location-dependent lookups off this rather than off
 * `root` directly, which is what makes a worktree and its main checkout produce the
 * **same answer** — the same own-name set and the same ancestor chain to walk for
 * siblings (WP-12a: from `.worktrees/<branch>`, `basename(root)` is the branch-ish
 * scratch name and the ancestor walk passes through the `.worktrees` directory itself,
 * neither of which describes this repo or its real neighbours).
 */
function canonicalRoot(root: string): string {
  return gitCommonDirRoot(root) ?? resolve(root);
}

/** Directory names anywhere inside `root`, plus `root`'s own top-level entries. */
function ownNames(root: string): Set<string> {
  const names = new Set<string>([basename(root), basename(canonicalRoot(root))]);
  const packageName = ownPackageName(root);
  if (packageName !== undefined) names.add(packageName);
  const recurse = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        names.add(entry.name);
        recurse(join(dir, entry.name));
      }
    }
  };
  recurse(root);
  for (const entry of readdirSync(root)) names.add(entry);
  // Conventional directories this repo may not have yet but owns the name of.
  for (const name of SKIP_DIRS) names.add(name);
  return names;
}

/**
 * Packages this repo **used to install and still documents by name**.
 *
 * Rule 1 whitelists a path citation whose first segment is an installed package, because
 * `<package>/index.js` is a public npm path and not a neighbour's internal layout.
 * (Angle brackets for the same reason this file's own header uses them.) That
 * whitelist reads `node_modules`, so the moment a dependency is *removed* every citation of
 * its internals in this repo's own plans and forensics turns into a finding — which is what
 * happened when WP-6 of `plans/marked-terminal-replacement.md` removed `marked-terminal`
 * and the plan's own line 56, citing the file it replaced, was flagged.
 *
 * That is a false positive of the sharpest kind: the plan's whole subject is that package,
 * and the citation is the evidence for a decision. Deleting the citation to satisfy the
 * guard would delete the reason. So the two packages that removal took out are listed here,
 * explicitly and with their reason.
 *
 * **This list is not a general escape hatch and must not become one.** An entry is only
 * legitimate for a package that was genuinely a declared dependency of *this* repo and was
 * genuinely removed by a recorded work package — both checkable from
 * `THIRD-PARTY-LICENSES.txt`'s history. It can never launder a private neighbour's name,
 * because a neighbour was never an npm dependency here. Rules 2 and 3 are untouched by it.
 */
const DOCUMENTED_FORMER_PACKAGES = new Set([
  // Removed in WP-6 of `plans/marked-terminal-replacement.md` — the renderer this repo
  // replaced method by method, cited throughout `src/`, `plans/` and `reviews/`.
  "marked-terminal",
  // Undeclared since WP-3 of `plans/tn-review-remediation.md` and physically removed with
  // `marked-terminal`, which was the only thing still requiring it.
  "cli-table3",
]);

/**
 * Installed package names. A missing `node_modules` is a hard error rather than an
 * empty set: silently treating every dependency citation as foreign would bury the
 * real findings in noise, and silently treating them as fine would be the inert-gate
 * failure this guard exists to avoid.
 *
 * Plus `DOCUMENTED_FORMER_PACKAGES` above, for the same reason read the other way round.
 */
function packageNames(root: string): Set<string> {
  const modules = join(root, "node_modules");
  let entries: string[];
  try {
    entries = readdirSync(modules);
  } catch {
    throw new Error(
      `containment: cannot read ${modules} — install dependencies before running the guard`,
    );
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      names.add(entry);
      for (const scoped of readdirSync(join(modules, entry))) names.add(`${entry}/${scoped}`);
    } else {
      names.add(entry);
    }
  }
  for (const name of DOCUMENTED_FORMER_PACKAGES) names.add(name);
  return names;
}

/**
 * Is `dir` demonstrably a working checkout of the installed package `name`, rather
 * than a private sibling that merely shares its name? The evidence required is a
 * `package.json` whose own `name` field matches. Nothing else counts — a bare
 * directory of the right name proves nothing.
 */
function isPackageCheckout(dir: string, name: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return false; // no manifest, or unreadable — no evidence, so not exempt
  }
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest) &&
    (manifest as Record<string, unknown>).name === name
  );
}

/**
 * Every directory name on this repo's ancestor chain and every directory sitting
 * beside one of those ancestors — read from the filesystem, never enumerated in
 * source. This is the rule that catches a sibling nobody has thought of: it does not
 * need to know what the neighbours are called, only that they are neighbours.
 *
 * A public clone somewhere with unrelated neighbours simply produces a different,
 * equally correct set; a name collision there is a loud failure with the offending
 * token named, not a silent pass.
 *
 * The walk starts from `canonicalRoot(root)`, not `root` itself (WP-12a). A worktree's
 * `root` sits under a `.worktrees/<branch>` directory that is not part of the checked-out
 * repository at all — walking from there would collect `.worktrees` and the branch label
 * as if they were real siblings, and the ancestor chain above them would stop one level
 * too shallow. Resolving to the main checkout first makes the ancestor chain — and
 * therefore this whole set — identical whether the guard runs from the main checkout or
 * from any worktree of it.
 *
 * **One exemption, and it is evidence-based on purpose.** A contributor who checks a
 * dependency out beside the repo to read its source — which this repo's own docs
 * describe doing — would otherwise turn every mention of that dependency into a
 * finding, and a guard that fails for reasons unrelated to your change is a guard
 * that gets switched off. But exempting *every* installed package name wholesale
 * would be worse: `scanLine`'s path rule already treats a package name as a safe
 * first segment, so this rule is the **only** thing that catches a private sibling
 * whose name collides with a package (`<pkg-named-sibling>/private/layout.ts` is
 * exempt under the path rule and caught here). Dropping the whole intersection would
 * remove that backstop.
 *
 * So the exemption requires proof that the directory *is* the dependency: a
 * `package.json` naming itself. A private sibling that merely shares a name with an
 * npm package stays in the set.
 */
function neighbourNames(root: string, own: Set<string>, packages: Set<string>): Set<string> {
  // name -> the directories carrying that name, so a collision can be adjudicated
  // against the actual directory rather than against the name alone.
  const sources = new Map<string, string[]>();
  const note = (name: string, dir: string): void => {
    if (name.length === 0 || FILESYSTEM_ROOTS.has(name)) return;
    const existing = sources.get(name);
    if (existing) existing.push(dir);
    else sources.set(name, [dir]);
  };

  let current = dirname(canonicalRoot(root));
  for (;;) {
    note(basename(current), current);
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        note(entry.name, join(current, entry.name));
      }
    } catch {
      // An unreadable ancestor contributes nothing; rules 1 and 2 still apply.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const names = new Set(sources.keys());
  for (const name of own) names.delete(name);
  for (const name of names) {
    if (!packages.has(name)) continue;
    const dirs = sources.get(name) ?? [];
    if (dirs.some((dir) => isPackageCheckout(dir, name))) names.delete(name);
  }
  return names;
}

export function buildContext(root: string, listed: Set<string> = new Set()): ContainmentContext {
  const own = ownNames(root);
  const packages = packageNames(root);
  return { own, packages, neighbours: neighbourNames(root, own, packages), listed };
}

/**
 * Top-level directories exempted from the containment scan entirely (WP-12d, user
 * decision 2026-07-29). This is not the `SKIP_DIRS` shape — those carry no authored
 * content at all. `runs/` is the opposite: real control-plane material (execution
 * briefs, dispatch notes) that must cite real absolute paths to be self-contained, and
 * is deliberately *not* published-facing.
 *
 * **The guard's boundary is the whole repository minus `SKIP_DIRS` and this exemption,
 * full stop.** It is **not** derived from what the gate corpus samples, and has not been
 * since WP-1 of `plans/gate-corpus-reframe.md` — before that WP, this comment justified
 * the `runs/**` exemption by pointing at `corpus/default-manifest.json`'s glob list, on
 * the premise that the guard's job was to protect *that* corpus specifically. Reasoning
 * from the corpus was true only by coincidence, and the coincidence was the risk: the
 * gate corpus is now a fixed, explicit path list scoped to `tests/fixtures/`, so
 * pointing at it here would no longer even describe a set that overlaps `plans/` or
 * `README.md` at all. **`collectFiles` (below) scans the entire repository minus
 * `SKIP_DIRS` and this exemption — independent of the gate corpus, and unchanged by
 * this rewrite.** `tests/containment.test.ts` pins the one
 * assertion that keeps this exemption and the gate corpus provably disjoint: no gate
 * corpus entry may begin `runs/`, and no corpus root may be or resolve into `runs/`. If
 * that assertion ever fails, this exemption is wrong and must shrink, not the manifest.
 *
 * **`plans/` is deliberately not here.** Every file under `plans/` is fully governed by
 * all three rules regardless of gate-corpus membership; a plan citing a real private
 * path is a real finding, not a control-plane exception.
 *
 * **What this does not solve.** Whether `runs/` (or anything else) should be filtered out
 * of an eventual *public push* of this repo is a separate, live, cross-repo question,
 * explicitly out of scope here — this exemption only concerns what the containment guard
 * checks today, not what a future publication step must additionally strip.
 *
 * Root-relative and top-level only: matches `<root>/runs/**`, not a directory named
 * `runs` appearing anywhere else in the tree (unlike `SKIP_DIRS`, which matches by name
 * at any depth — that asymmetry is intentional, since this is a narrow, named carve-out
 * rather than "never authored content").
 */
export const EXEMPT_ROOT_DIRS = new Set(["runs"]);

/**
 * Every file under `root`, skipping generated and vendored trees.
 *
 * **`SKIP_DIRS` is matched by name, before the entry's type is consulted, and that
 * ordering is the point.** The check used to sit *inside* the `isDirectory()` branch,
 * which quietly assumed every skippable name is a directory. **In a git worktree `.git`
 * is a file**, holding a line like `gitdir: /abs/path/to/main/.git/worktrees/<name>`. The
 * old form therefore scanned it, found an absolute home path **git itself had written**,
 * and failed containment on plumbing rather than on anything this repo contains. That
 * made every worktree unusable and pushed dispatched work into full clones instead —
 * which then had to live in a dedicated parent directory to dodge the neighbour rule,
 * and which registered as phantom initiatives in the fleet's own tooling.
 */
export function collectFiles(root: string): string[] {
  const files: string[] = [];
  const recurse = (dir: string, isRoot: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (isRoot && entry.isDirectory() && EXEMPT_ROOT_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        recurse(full, false);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  recurse(root, true);
  return files;
}

export interface FileFinding extends ContainmentFinding {
  file: string;
  line: number;
}

/** Run every rule over every file under `root`. */
export function scanTree(root: string, context: ContainmentContext): FileFinding[] {
  const findings: FileFinding[] = [];
  for (const file of collectFiles(root)) {
    const generatedLockfile = GENERATED_LOCKFILES.has(basename(file));
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // unreadable or binary — no authored content to leak
    }
    text.split("\n").forEach((line, index) => {
      for (const finding of scanLine(line, context, { generatedLockfile })) {
        findings.push({ ...finding, file, line: index + 1 });
      }
    });
  }
  return findings;
}

export type SupplementalSource = "env" | "absent";

export interface SupplementalNames {
  names: Set<string>;
  source: SupplementalSource;
  path?: string;
}

/**
 * Optional supplement to the rules above: a list of private strings that are not
 * path-shaped and are not directory names — a person, a client, a host — supplied
 * from outside this repo so that publishing the repo discloses none of them.
 *
 * Resolution mirrors `src/config.ts`'s corpus-manifest handling: this repo is *told*
 * a path and knows nothing about the other end. It never contains the list, never
 * contains the list's location, and never contains a single name from it.
 *
 * The two states are deliberately the only two:
 *
 *  - **unset** — `source: "absent"`. Rules 1–3 run, which is the whole binding guard;
 *    callers are expected to say out loud that the supplement was not applied.
 *  - **set** — the file must exist and must parse to a non-empty list of non-empty
 *    strings. Anything else **throws**. A pointer to a file that is missing, moved,
 *    or malformed is exactly how an opt-in check rots into a check that can never
 *    fail, so it is a hard error rather than a fallback to "absent".
 */
export async function loadSupplementalNames(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupplementalNames> {
  const path = env.MDVIEW_PRIVATE_NAMES;
  if (path === undefined || path.length === 0) return { names: new Set(), source: "absent" };

  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    throw new Error(`containment: MDVIEW_PRIVATE_NAMES points at ${path}, which cannot be read`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`containment: ${path} is not valid JSON: ${message}`);
  }

  const names =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).names
      : undefined;
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`containment: ${path} must hold a non-empty "names" array`);
  }
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`containment: ${path} contains a non-string or empty name`);
    }
  }
  return { names: new Set(names as string[]), source: "env", path };
}
