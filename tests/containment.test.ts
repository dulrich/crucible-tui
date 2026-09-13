import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildContext,
  collectFiles,
  EXEMPT_ROOT_DIRS,
  loadSupplementalNames,
  scanLine,
  scanTree,
  type ContainmentContext,
} from "./helpers/containment";
import { BUNDLED_DEFAULT_MANIFEST } from "../src/config";

const MDVIEW_ROOT = join(import.meta.dir, "..");

// --- containment (WP-1 constraint 4, reshaped in WP-2h) ---------------------
//
// This replaced a denylist of five literal private strings. A denylist can only
// contain the leaks somebody already found; it was extended twice by hand and was a
// name behind both times. It also could not survive the publication it existed to
// protect — the literals *were* the disclosure, and a history scrub would have
// rewritten the guard's own constants into placeholders.
//
// The rules live in `tests/helpers/containment.ts` and name nothing private: they
// describe what this repo's own content looks like and flag everything else, so a
// sibling nobody has enumerated is caught by construction. See that file's header.
//
// **This block deliberately has no self-exception.** The old guard excluded its own
// file, which is where a denylist hides. The fixtures below are assembled from parts
// at run time precisely so that this file does not itself contain the shapes it
// tests for, and the whole tree — this file included — goes through the same scan.

describe("containment rules", () => {
  const context: ContainmentContext = {
    own: new Set(["src", "tests", "scripts"]),
    packages: new Set(["marked", "@types/bun"]),
    // Invented. These name nothing on any machine; the point of the exercise is that
    // the rules do not need to know what a neighbour is called in order to flag it.
    neighbours: new Set(["widget_factory", "ledger"]),
    listed: new Set(),
  };
  // Assembled, never written out: a literal here would be a finding in this file.
  const foreignPath = ["widget_factory", "internal", "web", "markdown.ts"].join("/");
  const homePath = ["", "home", "someone", "notes.md"].join("/");
  const fakeHomePath = ["", "home", "example", "notes.md"].join("/");
  const rules = (line: string): string[] => scanLine(line, context).map((finding) => finding.rule);

  test("flags a path citation into a directory this repo does not have", () => {
    expect(rules(`// adapted from ${foreignPath}:7`)).toContain("foreign-path");
  });

  test("flags such a citation even when the first segment is on no list anywhere", () => {
    // The whole point: `quarterly_reports` is not a neighbour here, not in any private
    // list, and was invented for this assertion. The rule flags it for its *shape*.
    const unknown = ["quarterly_reports", "packages", "core", "index.ts"].join("/");
    expect(rules(`see ${unknown}`)).toEqual(["foreign-path"]);
  });

  test("allows a path into this repo's own directories", () => {
    expect(rules(`see ${["src", "render.ts"].join("/")} and ${["tests", "fixtures"].join("/")}/`)).toEqual([]);
  });

  test("allows a path into an installed package", () => {
    expect(rules(`${["marked", "lib", "marked.cjs"].join("/")} and @types/bun/index.d.ts`)).toEqual([]);
  });

  test("allows the sanctioned fake root, relative and absolute", () => {
    expect(rules(`render ${["example", "plan.md"].join("/")} at ${fakeHomePath}`)).toEqual([]);
  });

  test("flags an absolute path naming any other account", () => {
    expect(rules(`corpus at ${homePath}`)).toEqual(["home-path"]);
  });

  test("flags a distinctive neighbour name in bare prose, where no path rule can see it", () => {
    expect(rules("the same trick widget_factory uses")).toEqual(["neighbour-name"]);
  });

  test("flags a plain-word neighbour name used as an identifier", () => {
    expect(rules("see the `ledger` tool")).toEqual(["neighbour-name"]);
  });

  test("leaves a plain-word neighbour name alone in ordinary prose", () => {
    // Otherwise every directory on this machine whose name is an English word — and
    // there are several — makes the guard unusable, which is how guards get disabled.
    expect(rules("the ledger of what changed")).toEqual([]);
  });

  test("does not read an English slash-list, a ratio, or a regex as a path", () => {
    expect(rules("either/or, 50/50, and /\\s/.exec(text)")).toEqual([]);
  });

  test("does not read a shell variable or a placeholder as a path", () => {
    expect(rules("$XDG_CONFIG_HOME/mdview/config.json and <path>/manifest.json")).toEqual([]);
  });

  test("a supplied private name is flagged wherever it appears, prose included", () => {
    const listed = { ...context, listed: new Set(["quietly"]) };
    expect(scanLine("it fails quietly", listed).map((f) => f.rule)).toEqual(["listed-name"]);
  });

  test("the neighbour rule is the only backstop for the path rule's package exemption", () => {
    // Pins *why* `neighbourNames` refuses to drop the whole neighbours-and-packages
    // intersection. The path rule treats an installed package name as a safe first
    // segment — it has to, so `marked/lib/marked.cjs` can be cited — which means a
    // private sibling sharing a package's name slips past it. This rule catches it.
    // Subtract `packages` from `neighbours` wholesale and both rules go blind at once.
    const collision: ContainmentContext = {
      ...context,
      packages: new Set(["ledger_core"]),
      neighbours: new Set(["ledger_core"]),
    };
    const cited = `see ${["ledger_core", "private", "layout.ts"].join("/")}`;
    expect(scanLine(cited, collision).map((f) => f.rule)).toEqual(["neighbour-name"]);
  });
});

// WP-12d (user decision 2026-07-29): execution briefs and plans are checked into a repo's
// `runs/` directory carrying real absolute paths, so the containment guard must not scan
// there — but every rule must keep running everywhere else, `plans/` included, since plans
// are inside the shared corpus. These tests plant an identical violation in four
// locations and prove the guard's verdict differs *only* for the one that is exempt, then
// clean the fixtures up. The literal is assembled at run time for the same reason the
// synthetic fixtures above are: this file has no self-exception and is scanned like any
// other.
describe("the runs/ exemption is exactly that narrow (WP-12d)", () => {
  const plantedCitation = ["quietly_planted_zz", "internal", "layout.ts"].join("/");
  const plantedLine = `see ${plantedCitation} for the real layout\n`;

  test("a planted violation is still caught under src/, tests/fixtures/, and a root *.md — but not under runs/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-runs-exemption-"));
    try {
      await mkdir(join(dir, "node_modules"), { recursive: true });
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "tests", "fixtures"), { recursive: true });
      await mkdir(join(dir, "runs", "dispatch"), { recursive: true });
      await writeFile(join(dir, "src", "module.ts"), `// ${plantedLine}`);
      await writeFile(join(dir, "tests", "fixtures", "note.md"), plantedLine);
      await writeFile(join(dir, "README.md"), plantedLine);
      await writeFile(join(dir, "runs", "dispatch", "brief.md"), plantedLine);

      const context = buildContext(dir);
      const findings = scanTree(dir, context);
      const findingsUnder = (relPath: string) =>
        findings.filter((f) => relative(dir, f.file) === relPath);

      expect(findingsUnder(join("src", "module.ts")).length).toBeGreaterThan(0);
      expect(findingsUnder(join("tests", "fixtures", "note.md")).length).toBeGreaterThan(0);
      expect(findingsUnder("README.md").length).toBeGreaterThan(0);
      // The exemption: the identical planted string, in a file under `runs/`, is invisible.
      expect(findingsUnder(join("runs", "dispatch", "brief.md")).length).toBe(0);
      expect(findings).toHaveLength(3); // src/, tests/fixtures/, README.md — runs/ contributes nothing
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("collectFiles never descends into a top-level runs/ at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-runs-collect-"));
    try {
      await mkdir(join(dir, "runs", "dispatch"), { recursive: true });
      await writeFile(join(dir, "runs", "dispatch", "brief.md"), "anything\n");
      await writeFile(join(dir, "keep.md"), "# keep\n");
      const files = collectFiles(dir);
      expect(files.some((f) => f.endsWith("keep.md"))).toBe(true);
      expect(files.some((f) => f.includes(`${join("runs", "dispatch")}`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("collectFiles skips a top-level FEEDBACK.md and nothing else by that name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-feedback-collect-"));
    try {
      await mkdir(join(dir, "docs"), { recursive: true });
      await writeFile(join(dir, "FEEDBACK.md"), "user scratchpad\n");
      await writeFile(join(dir, "docs", "FEEDBACK.md"), "not the scratchpad\n");
      await writeFile(join(dir, "keep.md"), "# keep\n");
      const files = collectFiles(dir);
      expect(files.some((f) => f.endsWith("keep.md"))).toBe(true);
      expect(files.some((f) => f === join(dir, "FEEDBACK.md"))).toBe(false);
      expect(files.some((f) => f === join(dir, "docs", "FEEDBACK.md"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a nested directory literally named runs/ (not at the repo root) is not exempt", async () => {
    // The exemption is root-relative and top-level only — `<root>/runs/**`, never a
    // directory that merely happens to be named `runs` somewhere deeper in the tree.
    const dir = await mkdtemp(join(tmpdir(), "mdview-nested-runs-"));
    try {
      await mkdir(join(dir, "src", "runs"), { recursive: true });
      await writeFile(join(dir, "src", "runs", "scheduler.ts"), "export const runs = 1;\n");
      const files = collectFiles(dir);
      expect(files.some((f) => f.endsWith(join("src", "runs", "scheduler.ts")))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no default-manifest entry can ever match anything under runs/ — the assertion that makes the exemption enforceable", async () => {
    // Since WP-1 of `plans/gate-corpus-reframe.md` the bundled manifest's `globs` are an
    // explicit, wildcard-free path list (the gate corpus, scoped to `tests/fixtures/`),
    // not a live-document glob — but this assertion's two guarantees are unchanged and
    // still load-bearing: the exemption (`EXEMPT_ROOT_DIRS`, `tests/helpers/
    // containment.ts`) and the gate corpus must stay provably disjoint, whatever either
    // one is at the time. The wildcard checks below are retained as defense-in-depth —
    // the manifest *schema* still allows a `*`/`**` segment even though no current entry
    // uses one — so a future entry that reintroduced a wildcard overlapping `runs/` would
    // still be caught here, not just by the eligibility assertion in `tests/gate-corpus.test.ts`.
    const manifestPath = BUNDLED_DEFAULT_MANIFEST;
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      corpora: Array<{ root: string; globs?: string[] }>;
    };
    expect(manifest.corpora.length).toBeGreaterThan(0);
    for (const spec of manifest.corpora) {
      const resolvedRoot = resolve(dirname(manifestPath), spec.root);
      // No corpus root may be, or resolve into, the exempted directory.
      expect(basename(resolvedRoot)).not.toBe("runs");
      for (const glob of spec.globs ?? []) {
        // No entry may begin `runs/` — as a literal segment (the live case today, since
        // every entry is wildcard-free) or as a bare wildcard that could expand to match
        // `runs` itself (the defense-in-depth case).
        const firstSegment = glob.split("/")[0] ?? "";
        const overlapsRuns = EXEMPT_ROOT_DIRS.has(firstSegment) || firstSegment === "**" || firstSegment === "*";
        expect(overlapsRuns).toBe(false);
      }
    }
    // And the exemption itself must still be exactly what this test assumes — nothing
    // broader could quietly widen it without this failing too.
    expect([...EXEMPT_ROOT_DIRS]).toEqual(["runs"]);
  });
});

describe("a dependency checked out beside the repo is not a private neighbour", () => {
  // A contributor reading a dependency's source next to their checkout — which this
  // repo's own docs describe doing — must not turn every mention of that dependency
  // into a finding. A guard that fails for reasons unrelated to your change is a guard
  // that gets switched off.
  const DEP = "zz-fixture-dep";

  async function scaffold(withManifest: boolean): Promise<{ dir: string; repo: string }> {
    const dir = await mkdtemp(join(tmpdir(), "mdview-neighbours-"));
    const repo = join(dir, "repo");
    await mkdir(join(repo, "node_modules", DEP), { recursive: true });
    await mkdir(join(dir, DEP), { recursive: true });
    if (withManifest) {
      await writeFile(join(dir, DEP, "package.json"), JSON.stringify({ name: DEP }));
    }
    return { dir, repo };
  }

  test("exempt when the directory proves it is that package", async () => {
    const { dir, repo } = await scaffold(true);
    try {
      expect(buildContext(repo).neighbours.has(DEP)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still a neighbour when it only shares the name — this is the hole left open, on purpose", async () => {
    // The exemption is evidence-based, not name-based. A private sibling that happens
    // to be called the same thing as an installed package keeps being flagged.
    const { dir, repo } = await scaffold(false);
    try {
      expect(buildContext(repo).neighbours.has(DEP)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still a neighbour when its manifest names something else", async () => {
    const { dir, repo } = await scaffold(false);
    try {
      await writeFile(join(dir, DEP, "package.json"), JSON.stringify({ name: "@private/something" }));
      expect(buildContext(repo).neighbours.has(DEP)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("supplemental private-name list", () => {
  // The list itself is private and lives outside this repo. This repo is *told* a
  // path and knows nothing about the other end — the same shape as the corpus
  // manifest above, for the same reason.

  test("absent when unset: the always-on rules are the whole guard", async () => {
    const result = await loadSupplementalNames({});
    expect(result.source).toBe("absent");
    expect(result.names.size).toBe(0);
  });

  test("a pointer to a file that cannot be read is a hard error, never a silent skip", async () => {
    // This is the inert-gate failure mode: an opt-in check whose input has moved, and
    // which therefore passes forever while checking nothing.
    await expect(
      loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: join(MDVIEW_ROOT, "no", "such", "list.json") }),
    ).rejects.toThrow(/cannot be read/);
  });

  test("a malformed or empty list is a hard error too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-containment-"));
    try {
      const bad = join(dir, "bad.json");
      await writeFile(bad, "not json");
      await expect(loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: bad })).rejects.toThrow(/not valid JSON/);

      const empty = join(dir, "empty.json");
      await writeFile(empty, JSON.stringify({ names: [] }));
      await expect(loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: empty })).rejects.toThrow(/non-empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed list loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-containment-"));
    try {
      const good = join(dir, "names.json");
      await writeFile(good, JSON.stringify({ names: ["alpha", "beta"] }));
      const result = await loadSupplementalNames({ MDVIEW_PRIVATE_NAMES: good });
      expect(result.source).toBe("env");
      expect([...result.names].sort()).toEqual(["alpha", "beta"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// A git worktree stores `.git` as a *file* whose contents are an absolute path written by
// git. `collectFiles` used to test `SKIP_DIRS` only inside its `isDirectory()` branch, so
// it scanned that file and failed containment on git's own plumbing — which made worktrees
// unusable and pushed dispatched work into full clones parked inside the code root.
describe("skip rules match by name, not by entry type", () => {
  test("a worktree's `.git` file is skipped rather than scanned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-worktree-"));
    try {
      // Exactly the shape git writes. The account is the sanctioned fake one: the guard has
      // no self-exception, so a test *about* the home-path rule must not trip it — writing a
      // realistic account name here failed the suite on its own fixture, which is the design
      // working rather than an inconvenience.
      await writeFile(join(dir, ".git"), "gitdir: /home/example/main-repo/.git/worktrees/wp-1\n");
      await writeFile(join(dir, "real.ts"), "export const x = 1;\n");
      const files = collectFiles(dir);
      expect(files.some((file) => file.endsWith("/real.ts"))).toBe(true);
      expect(files.some((file) => file.endsWith("/.git"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a file sharing a skipped directory's name is skipped too", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-skipname-"));
    try {
      await writeFile(join(dir, "dist"), "not a directory\n");
      await writeFile(join(dir, "keep.md"), "# keep\n");
      const files = collectFiles(dir);
      expect(files.some((file) => file.endsWith("/keep.md"))).toBe(true);
      expect(files.some((file) => file.endsWith("/dist"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// WP-12a: `ownNames` used to seed itself from nothing but `basename(root)`, and
// `neighbourNames` walked ancestors from `root` itself. Both are true of a plain checkout
// only by coincidence — a worktree's `root` is a branch-ish scratch directory
// (`.worktrees/<branch>`), so its basename is not the repo's name and its ancestor chain
// passes through a directory (`.worktrees`) that is not a real sibling. Measured on the
// real checkout this repo runs from: 0 findings from the main checkout, dozens from a
// worktree of the exact same commit, every one a self-reference. This test describes the
// *shape* of the bug — a real git worktree parked under a dot-prefixed scratch directory,
// with its leaf named for the branch rather than the repo — without hardcoding any path
// on this machine.
describe("a worktree resolves its own identity the same way the main checkout does", () => {
  test("own name, neighbour set, and self-exemption all match between a repo and its worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-worktree-identity-"));
    try {
      const mainRepo = join(dir, "sample-repo");
      await mkdir(join(mainRepo, "node_modules"), { recursive: true });
      execFileSync("git", ["init", "-q", mainRepo]);
      execFileSync("git", ["-C", mainRepo, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", mainRepo, "config", "user.name", "test"]);
      await writeFile(join(mainRepo, "README.md"), "placeholder\n");
      execFileSync("git", ["-C", mainRepo, "add", "README.md"]);
      execFileSync("git", ["-C", mainRepo, "commit", "-q", "-m", "init"]);

      // The exact shape from the brief: a worktree under a dot-prefixed sibling directory,
      // its leaf named for the branch, not for the repo.
      const scratchDir = join(dir, ".worktrees", "some-branch");
      execFileSync("git", ["-C", mainRepo, "worktree", "add", "-q", scratchDir, "-b", "some-branch"]);
      await mkdir(join(scratchDir, "node_modules"), { recursive: true });

      const mainContext = buildContext(mainRepo);
      const worktreeContext = buildContext(scratchDir);

      // The repo's real name is recognized as "own" from the worktree, not just from the
      // main checkout — this is the fix, resolving through git's common dir rather than
      // trusting the checkout's leaf directory name.
      expect(worktreeContext.own.has(basename(mainRepo))).toBe(true);
      // The ancestor-derived neighbour set is identical from both locations: the walk keys
      // off the resolved repo root, not off wherever this particular checkout happens to
      // live, so `.worktrees` and the branch label never enter it.
      expect([...worktreeContext.neighbours].sort()).toEqual([...mainContext.neighbours].sort());
      // And the repo never appears as its own neighbour — the failure mode this fixes.
      expect(worktreeContext.neighbours.has(basename(mainRepo))).toBe(false);
      expect(mainContext.neighbours.has(basename(mainRepo))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("no private reference reaches a public clone of this repo", () => {
  test("the bundled default manifest is clean", async () => {
    const text = await Bun.file(BUNDLED_DEFAULT_MANIFEST).text();
    const context = buildContext(MDVIEW_ROOT);
    const findings = text
      .split("\n")
      .flatMap((line, index) => scanLine(line, context).map((f) => `${index + 1}: ${f.rule} "${f.token}"`));
    expect(findings).toEqual([]);
  });

  test("no file under this repo carries a foreign path, a home path, or a neighbour's name", async () => {
    const supplemental = await loadSupplementalNames();
    if (supplemental.source === "absent") {
      // Loud on purpose. The three always-on rules below are the binding guard and are
      // sufficient without this; the supplement only adds private strings that are
      // neither path-shaped nor directory names. Saying so beats a silent skip.
      console.error(
        "containment: MDVIEW_PRIVATE_NAMES is unset — supplemental name list not applied; " +
          "the always-on path, home-path and neighbour rules still ran.",
      );
    }
    const context = buildContext(MDVIEW_ROOT, supplemental.names);
    expect(context.neighbours.size).toBeGreaterThan(0);
    const findings = scanTree(MDVIEW_ROOT, context).map(
      (finding) => `${relative(MDVIEW_ROOT, finding.file)}:${finding.line} ${finding.rule} "${finding.token}"`,
    );
    expect(findings).toEqual([]);
  });
});
