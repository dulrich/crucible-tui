import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadManifest, resolveCorpusFiles } from "../scripts/corpus";
import { BUNDLED_DEFAULT_MANIFEST } from "../scripts/measure/config";

// --- The gate corpus contract (WP-1, plans/gate-corpus-reframe.md) ----------
//
// `corpus/default-manifest.json` used to be a glob over live documents
// (`README.md`, `AGENTS.md`, `plans/*.md`, `tests/fixtures/*.md`), so its own bytes
// moved every time any of those files was edited — the disease this WP replaced.
// The gate corpus is now a fixed, explicit, wildcard-free path list: the 10 direct
// `tests/fixtures/*.md` fixtures plus every `tests/fixtures/witnesses/defect-*.md`
// witness that swept clean (`overflow=0 errors=0`) at the 5 default widths and both
// glyph tiers — never `tests/fixtures/witnesses/README.md`, never anything under
// `plans/`. Two independent layers enforce it: the **eligibility assertion** below
// (decidable path shape + owning-test evidence — see plans/gate-corpus-reframe.md's
// cycle-3 f1 for exactly what this does and does not guarantee) and the **exact-set
// pin** (fixed membership). A third test pins the resolver contract the eligibility
// assertion's path-shape reasoning depends on: a wildcard-free manifest entry
// resolves to exact-path membership, not a prefix or substring match.

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "tests/fixtures");
const WITNESSES_ROOT = resolve(REPO_ROOT, "tests/fixtures/witnesses");
const WITNESS_INDEX_PATH = join(WITNESSES_ROOT, "witness-index.json");

interface WitnessRecord {
  fixture: string;
  test_file: string;
}

interface WitnessIndex {
  witnesses: WitnessRecord[];
}

function loadWitnessIndex(): WitnessIndex {
  return JSON.parse(readFileSync(WITNESS_INDEX_PATH, "utf8")) as WitnessIndex;
}

/** Repo-root-relative path -> is it a *direct* `tests/fixtures/*.md` fixture? */
function isDirectFixturePath(relPath: string): boolean {
  const segments = relPath.split("/");
  return (
    segments.length === 3 &&
    segments[0] === "tests" &&
    segments[1] === "fixtures" &&
    relPath.endsWith(".md")
  );
}

/**
 * Repo-root-relative path -> is it named by a `witness-index.json` record whose
 * `test_file` exists in the repo? This is the "owning-test evidence" cycle-3 f1
 * narrowed the guarantee to: decidable path shape plus a record proving *some* test
 * owns this fixture, not a proof that the fixture's *content* is test data rather
 * than prose placed inside `tests/fixtures/` (that residue is review's, per the plan).
 */
function isEligibleWitnessPath(relPath: string, index: WitnessIndex): boolean {
  return index.witnesses.some(
    (record) => record.fixture === relPath && existsSync(join(REPO_ROOT, record.test_file)),
  );
}

async function loadBundledRepoCorpus() {
  const manifest = await loadManifest(BUNDLED_DEFAULT_MANIFEST);
  const spec = manifest.corpora.find((c) => c.name === "repo");
  if (!spec) throw new Error('bundled manifest has no "repo" corpus');
  return spec;
}

describe("gate corpus eligibility (WP-1, plans/gate-corpus-reframe.md)", () => {
  test("every manifest entry is a direct tests/fixtures/*.md path, or a witness-index.json-named fixture with owning-test evidence", async () => {
    const spec = await loadBundledRepoCorpus();
    const globs = spec.globs ?? [];
    expect(globs.length).toBeGreaterThan(0);

    const witnessIndex = loadWitnessIndex();

    for (const glob of globs) {
      // Wildcard-free: this is the resolver-contract test's job to prove exact-path
      // membership for, but eligibility assumes no `*` reaches this far.
      expect(glob.includes("*")).toBe(false);
      // Never the witnesses README, and never under plans/.
      expect(glob.endsWith("README.md")).toBe(false);
      expect(glob.startsWith("plans/")).toBe(false);

      const eligible = isDirectFixturePath(glob) || isEligibleWitnessPath(glob, witnessIndex);
      expect(eligible).toBe(true);

      // Canonical resolution stays inside the fixture-owned roots — `tests/fixtures/`
      // (which covers `tests/fixtures/witnesses/` too, since it is a subdirectory).
      const resolved = resolve(REPO_ROOT, spec.root, glob);
      const canonical = realpathSync(resolved);
      const insideFixtures = canonical === FIXTURES_ROOT || canonical.startsWith(`${FIXTURES_ROOT}/`);
      expect(insideFixtures).toBe(true);
    }
  });

  test("a hostile manifest entry outside the fixture-owned roots is rejected by the same predicate, even naming a real file", () => {
    // plans/gate-corpus-reframe.md, cycle-2 f2 / cycle-3 f1: the guarantee is path
    // shape plus owning-test evidence, not "no prose could ever sneak in" — but a path
    // like this, entirely outside tests/fixtures/, must never pass regardless.
    const witnessIndex = loadWitnessIndex();
    const hostileEntries = [
      "plans/gate-corpus-reframe.md",
      "README.md",
      "AGENTS.md",
      "docs/adr/0001-editor-path.md",
      "tests/fixtures/witnesses/README.md",
    ];
    for (const entry of hostileEntries) {
      const eligible = isDirectFixturePath(entry) || isEligibleWitnessPath(entry, witnessIndex);
      expect(eligible).toBe(false);
    }
  });
});

describe("gate corpus exact-set pin (WP-1, plans/gate-corpus-reframe.md)", () => {
  const EXPECTED_MEMBERS = [
    "tests/fixtures/blockquote-list.md",
    "tests/fixtures/coalesced-colon-guard-continuation.md",
    "tests/fixtures/coalesced-guard-collision.md",
    "tests/fixtures/fenced-list.md",
    "tests/fixtures/loose-list.md",
    "tests/fixtures/nested-list.md",
    "tests/fixtures/simple.md",
    "tests/fixtures/task-ordered-text.md",
    "tests/fixtures/tight-list.md",
    "tests/fixtures/wide-table.md",
    "tests/fixtures/witnesses/defect-0-crlf-frontmatter.md",
    "tests/fixtures/witnesses/defect-1-2-unparseable-frontmatter.md",
    "tests/fixtures/witnesses/defect-3-nested-mapping.md",
    "tests/fixtures/witnesses/defect-wp14-list-item-inline-markup.md",
  ].sort();

  test("resolveCorpusFiles resolves the fixed 14-file membership, and nothing else", async () => {
    const spec = await loadBundledRepoCorpus();
    const files = await resolveCorpusFiles(spec, {});
    expect(files).not.toBeNull();
    const relPaths = (files ?? []).map((f) => relative(REPO_ROOT, f)).sort();
    expect(relPaths).toEqual(EXPECTED_MEMBERS);
  });

  test("the two legitimately-overflowing witnesses stay out (defect-2-success-path-overwide.md, defect-cjk-excerpt.md)", async () => {
    const spec = await loadBundledRepoCorpus();
    const files = await resolveCorpusFiles(spec, {});
    const relPaths = (files ?? []).map((f) => relative(REPO_ROOT, f));
    expect(relPaths).not.toContain("tests/fixtures/witnesses/defect-2-success-path-overwide.md");
    expect(relPaths).not.toContain("tests/fixtures/witnesses/defect-cjk-excerpt.md");
  });
});

describe("resolver contract: wildcard-free entry ⇒ exact-path membership (matchSegment equality, scripts/corpus.ts:347)", () => {
  test("a wildcard-free glob matches only its exact filename, never a file that merely shares a prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-gate-corpus-resolver-"));
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "note.md"), "# note\n");
      await writeFile(join(dir, "note-2.md"), "# note 2\n");
      await writeFile(join(dir, "notebook.md"), "# notebook\n");

      const files = await resolveCorpusFiles({ name: "resolver-contract", root: dir, globs: ["note.md"] }, {});
      expect(files).not.toBeNull();
      expect((files ?? []).map((f) => f.split("/").pop())).toEqual(["note.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a wildcard-free multi-segment glob matches only the exact nested path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mdview-gate-corpus-resolver-nested-"));
    try {
      await mkdir(join(dir, "witnesses"), { recursive: true });
      await writeFile(join(dir, "witnesses", "defect-x.md"), "# x\n");
      await writeFile(join(dir, "witnesses", "defect-x-2.md"), "# x2\n");

      const files = await resolveCorpusFiles(
        { name: "resolver-contract-nested", root: dir, globs: ["witnesses/defect-x.md"] },
        {},
      );
      expect(files).not.toBeNull();
      expect((files ?? []).map((f) => f.split("/").pop())).toEqual(["defect-x.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
