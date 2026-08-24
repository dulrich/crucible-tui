import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// The instrumentation dependency graph is a DAG (WP-R1,
// `plans/post-refactor-code-quality-remediation.md`)
// ---------------------------------------------------------------------------
//
// **This is a regression gate for a cycle that existed and was defended in a comment.**
// Before WP-R1 the three instrument modules formed one strongly connected component:
//
//   scripts/corpus.ts      imported `sha256Hex`  from scripts/render-diff.ts
//   scripts/render-diff.ts imported `parseWidths` from scripts/sweep.ts
//   scripts/sweep.ts       imported the sweep library from scripts/corpus.ts
//
// so the sweep's *library* imported a *CLI*, which imported another CLI, which imported the
// library. `scripts/corpus.ts` carried a comment arguing the cycle was benign — nothing
// called across it during module evaluation, every `import.meta.main` gate was false in an
// imported module, and `sha256Hex` was a hoisted declaration. That reasoning was correct and
// is exactly why the cycle survived: a cycle that is harmless today is a cycle nobody
// notices tightening, and each of the three edges was one symbol wide. WP-R1 moved those
// symbols into leaves (`scripts/hash.ts`, `scripts/sweep-options.ts`) and split the two
// giants (`scripts/colour-axis.ts`, `scripts/revision.ts`, `scripts/diff-classify.ts`)
// instead of re-arguing the benignness.
//
// The check is structural, not a list of forbidden pairs: seed the graph with every
// TypeScript file under `scripts/`, follow every relative import transitively (which reaches
// `src/` as well), and assert Tarjan finds no strongly connected component larger than one
// node. A component of size one with a self-edge is a cycle too, and is asserted separately.
//
// **Non-vacuity is asserted directly** rather than inferred from today's zero: the last test
// runs the same analyzer over a synthetic pair of mutually importing modules in a temporary
// directory and requires it to report them. A graph checker that silently resolved nothing
// would pass the first two tests forever.

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPTS_ROOT = join(REPO_ROOT, "scripts");

/** Directories a TypeScript source tree never has its own modules in. */
const SKIP_DIRS = new Set(["node_modules", "dist"]);

/** Every `.ts` file under `root`, recursively, dot-directories and vendor trees skipped. */
async function collectTsFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await collectTsFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found.sort();
}

/**
 * Resolve one relative specifier the way this repo writes them.
 *
 * Every relative import in `scripts/` and `src/` is extensionless (`./corpus`,
 * `../src/render`), which is the convention the whole suite already follows; an explicit
 * `.ts` and a directory `index.ts` are accepted too so that adopting either later does not
 * silently make this gate blind. Returns `null` when nothing on disk matches — which the
 * first test below treats as a failure in its own right.
 */
async function resolveRelative(fromFile: string, specifier: string): Promise<string | null> {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  return null;
}

interface ImportGraph {
  /** Absolute file path -> the absolute paths of the repo modules it imports. */
  edges: Map<string, string[]>;
  /** Relative specifiers that matched no file on disk. */
  unresolved: Array<{ from: string; specifier: string }>;
}

/**
 * Build the transitive relative-import graph reachable from `seeds`.
 *
 * Specifiers are read with Bun's own transpiler rather than a regular expression, so a
 * doc comment quoting an import line — this repo's header comments are full of them — can
 * never become an edge, and a dynamic `import()` of a string literal does become one.
 * Only relative specifiers are followed: a bare package name is not this repo's module.
 */
async function buildImportGraph(seeds: string[]): Promise<ImportGraph> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const edges = new Map<string, string[]>();
  const unresolved: Array<{ from: string; specifier: string }> = [];
  const queue = [...seeds];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (edges.has(file)) continue;
    const raw = await Bun.file(file).text();
    // `scanImports` rejects a shebang outright ("Unexpected #!/usr/bin/env"), and several
    // modules here carry one because they are also executable entry points. Blanking the
    // first line rather than deleting it keeps nothing else about the source shifted.
    const source = raw.startsWith("#!") ? raw.slice(raw.indexOf("\n") + 1) : raw;
    const deps: string[] = [];
    for (const record of transpiler.scanImports(source)) {
      if (!record.path.startsWith(".")) continue;
      const target = await resolveRelative(file, record.path);
      if (target === null) {
        unresolved.push({ from: file, specifier: record.path });
        continue;
      }
      deps.push(target);
      queue.push(target);
    }
    edges.set(file, deps);
  }
  return { edges, unresolved };
}

/** Tarjan's algorithm. Returns every strongly connected component, largest first. */
function stronglyConnectedComponents(edges: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, counter);
    lowlink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowlink.set(node, Math.min(lowlink.get(node) as number, lowlink.get(next) as number));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node) as number, index.get(next) as number));
      }
    }
    if (lowlink.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop() as string;
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
      }
      components.push(component);
    }
  };

  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components.sort((a, b) => b.length - a.length);
}

const rel = (file: string): string => relative(REPO_ROOT, file);

const seeds = await collectTsFiles(SCRIPTS_ROOT);
const { edges, unresolved } = await buildImportGraph(seeds);

const tempRoots: string[] = [];
afterAll(async () => {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true });
});

describe("scripts/ import graph", () => {
  test("the graph is non-empty and reaches src/ — a checker that resolved nothing would pass everything", () => {
    expect(seeds.length).toBeGreaterThan(5);
    const reached = [...edges.keys()].map(rel);
    expect(reached).toContain(join("scripts", "corpus.ts"));
    expect(reached).toContain(join("scripts", "sweep.ts"));
    expect(reached).toContain(join("scripts", "render-diff.ts"));
    // Following relative imports out of `scripts/` must actually cross into `src/`, or the
    // resolver is silently dropping every `../src/...` edge.
    expect(reached.some((path) => path.startsWith(`src${"/"}`))).toBe(true);
  });

  test("every relative import under scripts/ resolves to a file that exists", () => {
    const misses = unresolved.map((miss) => `${rel(miss.from)} -> ${miss.specifier}`).sort();
    expect(misses).toEqual([]);
  });

  test("no module imports itself", () => {
    const selfEdges = [...edges.entries()]
      .filter(([file, deps]) => deps.includes(file))
      .map(([file]) => rel(file))
      .sort();
    expect(selfEdges).toEqual([]);
  });

  test("no strongly connected component is larger than one node", () => {
    const cycles = stronglyConnectedComponents(edges)
      .filter((component) => component.length > 1)
      .map((component) => component.map(rel).sort().join(" <-> "))
      .sort();
    expect(cycles).toEqual([]);
  });
});

describe("the cycle detector itself", () => {
  test("reports a synthetic two-module cycle, so today's zero is not vacuous", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdview-acyclic-"));
    tempRoots.push(root);
    // Two modules that import each other, spelled exactly the way this repo spells a
    // relative import: extensionless, sibling-relative. This is the pre-WP-R1 shape,
    // shrunk to two nodes.
    await writeFile(join(root, "alpha.ts"), 'import { beta } from "./beta";\nexport const alpha = beta;\n');
    await writeFile(join(root, "beta.ts"), 'import { alpha } from "./alpha";\nexport const beta = alpha;\n');

    const synthetic = await buildImportGraph(await collectTsFiles(root));
    expect(synthetic.unresolved).toEqual([]);

    const cycles = stronglyConnectedComponents(synthetic.edges).filter((component) => component.length > 1);
    expect(cycles).toHaveLength(1);
    expect((cycles[0] as string[]).map((file) => relative(root, file)).sort()).toEqual(["alpha.ts", "beta.ts"]);
  });

  test("reports a synthetic self-import", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdview-acyclic-"));
    tempRoots.push(root);
    await writeFile(join(root, "solo.ts"), 'import { solo } from "./solo";\nexport const solo = 1;\n');

    const synthetic = await buildImportGraph(await collectTsFiles(root));
    const selfEdges = [...synthetic.edges.entries()].filter(([file, deps]) => deps.includes(file));
    expect(selfEdges).toHaveLength(1);
  });

  test("does not mistake an import line quoted inside a comment for an edge", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdview-acyclic-"));
    tempRoots.push(root);
    // Every module in `scripts/` carries a header comment that names the modules it used
    // to import; a regex-based scanner would turn each of those sentences into a live
    // edge and re-report the cycle WP-R1 removed.
    await writeFile(
      join(root, "quoted.ts"),
      '/** This module no longer does: import { thing } from "./ghost"; */\nexport const quoted = 1;\n',
    );

    const synthetic = await buildImportGraph(await collectTsFiles(root));
    expect(synthetic.unresolved).toEqual([]);
    expect(synthetic.edges.get(join(root, "quoted.ts"))).toEqual([]);
  });
});
