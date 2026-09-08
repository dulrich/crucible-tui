import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildWikiIndex,
  createWikiLinkResolver,
  defaultWikiFs,
  fileUri,
  findVaultRoot,
  resolveWikiSlug,
  type WikiEntry,
  type WikiFs,
  type WikiIndex,
} from "../src/wikiresolve";

// Path literals are assembled from segments everywhere in this file, never spelled as one
// slash-joined string, matching `tests/helpers/containment.ts`'s own convention for its
// self-test fixtures — the publication guard cannot mistake test vocabulary for a real
// citation if no path-shaped substring ever appears in the source.
const p = (...segments: string[]): string => segments.join("/");
const abs = (...segments: string[]): string => `/${segments.join("/")}`;

/** A fake `relPath` entry, defaulting to a plain file. */
interface FakeEntry {
  relPath: string;
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
}

/** In-memory `WikiFs` for the pure tests, counting `list` calls for the laziness witness. */
interface CountingFs extends WikiFs {
  listCalls: number;
}

function fakeFs(entries: readonly FakeEntry[], existing: readonly string[] = []): CountingFs {
  const wikiEntries: WikiEntry[] = entries.map((entry) => ({
    relPath: entry.relPath,
    isDirectory: entry.isDirectory ?? false,
    isSymbolicLink: entry.isSymbolicLink ?? false,
  }));
  const existingSet = new Set(existing);
  const fs: CountingFs = {
    listCalls: 0,
    exists: (path: string): boolean => existingSet.has(path),
    list: (_root: string): readonly WikiEntry[] => {
      fs.listCalls += 1;
      return wikiEntries;
    },
  };
  return fs;
}

const VAULT = abs("vault");

function indexOf(entries: readonly FakeEntry[], root: string = VAULT): WikiIndex {
  return buildWikiIndex(root, fakeFs(entries));
}

/** Builds a real temp directory tree, runs `run` over its root, always cleans up. */
function withRealVault<T>(build: (root: string) => void, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "wikiresolve-"));
  try {
    build(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("findVaultRoot (D1)", () => {
  test("an ancestor with .obsidian is the root", () => {
    const fs = fakeFs([], [join(abs("vault"), ".obsidian")]);
    expect(findVaultRoot(join(VAULT, "sub", "note.md"), fs)).toBe(VAULT);
  });

  test("an ancestor with .git is the root", () => {
    const fs = fakeFs([], [join(abs("vault"), ".git")]);
    expect(findVaultRoot(join(VAULT, "sub", "note.md"), fs)).toBe(VAULT);
  });

  test("neither present anywhere up to the filesystem root: falls back to the file's own directory", () => {
    const fs = fakeFs([], []);
    const fileDir = join(VAULT, "sub");
    expect(findVaultRoot(join(fileDir, "note.md"), fs)).toBe(fileDir);
  });

  test("nested markers: the nearest ancestor wins, not the outermost", () => {
    const outer = VAULT;
    const inner = join(VAULT, "sub");
    const fs = fakeFs([], [join(outer, ".git"), join(inner, ".obsidian")]);
    expect(findVaultRoot(join(inner, "deep", "note.md"), fs)).toBe(inner);
  });

  test("a .git that is a file (a git worktree's gitdir pointer) counts exactly like a directory", () => {
    // `WikiFs.exists` answers "is there anything here at all" with no type distinction —
    // this is D1's own text: ".git" counts "either" as a file or a directory.
    const fs = fakeFs([], [join(VAULT, ".git")]);
    expect(findVaultRoot(join(VAULT, "sub", "note.md"), fs)).toBe(VAULT);
  });
});

describe("resolveWikiSlug — D2 rule (a): exact relative path", () => {
  test("slug alone matches an exact relative path with no .md appended", () => {
    const index = indexOf([{ relPath: "image.png" }]);
    expect(resolveWikiSlug(index, "image.png")).toBe(join(VAULT, "image.png"));
  });

  test("slug + '.md' matches when the bare slug does not", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "note.md"));
  });

  test("a folder-qualified slug matches its exact nested path", () => {
    const index = indexOf([{ relPath: p("folder", "note.md") }]);
    expect(resolveWikiSlug(index, p("folder", "note"))).toBe(join(VAULT, "folder", "note.md"));
  });
});

describe("resolveWikiSlug — D2 rule (b): unique basename match", () => {
  test("a bare slug resolves to a uniquely-named file nested anywhere under root", () => {
    const index = indexOf([{ relPath: p("resources", "deep", "note.md") }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "resources", "deep", "note.md"));
  });

  test("a folder-qualified slug still falls back to basename match when its exact path fails", () => {
    const index = indexOf([{ relPath: p("resources", "note.md") }]);
    expect(resolveWikiSlug(index, p("other", "note"))).toBe(join(VAULT, "resources", "note.md"));
  });

  test("matching the full slug as a relative-path suffix is not attempted", () => {
    // `p("mid", "note")`'s last segment is "note", which is unique — this must resolve by
    // basename alone rather than by any attempt to match "mid/note" as a path suffix.
    const index = indexOf([{ relPath: p("deep", "nested", "note.md") }]);
    expect(resolveWikiSlug(index, p("mid", "note"))).toBe(join(VAULT, "deep", "nested", "note.md"));
  });
});

describe("resolveWikiSlug — D2 rule (c): ambiguous basename tiebreak (the 657-ambiguous-basename case, in miniature)", () => {
  test("the shallowest match wins, regardless of lexicographic order", () => {
    const index = indexOf([
      { relPath: p("z", "y", "note.md") },
      { relPath: p("b", "note.md") },
      { relPath: "note.md" },
    ]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "note.md"));
  });

  test("a tie in depth breaks lexicographically smallest", () => {
    const index = indexOf([{ relPath: p("z", "note.md") }, { relPath: p("a", "note.md") }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "a", "note.md"));
  });

  test("three same-named notes at three different depths resolve to the shallowest", () => {
    const index = indexOf([
      { relPath: p("one", "two", "three", "note.md") },
      { relPath: p("one", "note.md") },
      { relPath: p("one", "two", "note.md") },
    ]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "one", "note.md"));
  });
});

describe("resolveWikiSlug — case-insensitive fallback", () => {
  test("an exact-case miss falls back to a case-insensitive match", () => {
    const index = indexOf([{ relPath: "Note.md" }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "Note.md"));
  });

  test("an exact-case hit is preferred over a case-insensitive one when both exist", () => {
    const index = indexOf([{ relPath: "Note.md" }, { relPath: "note.md" }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "note.md"));
  });

  test("case-insensitive matching also applies to folder-qualified slugs", () => {
    const index = indexOf([{ relPath: p("Folder", "Note.md") }]);
    expect(resolveWikiSlug(index, p("folder", "note"))).toBe(join(VAULT, "Folder", "Note.md"));
  });
});

describe("resolveWikiSlug — absolute and .. refusal", () => {
  test("an absolute slug never resolves", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, abs("note"))).toBeUndefined();
  });

  test("a slug carrying a leading .. segment never resolves", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, p("..", "note"))).toBeUndefined();
  });

  test("a slug carrying a .. segment in the middle never resolves", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, p("folder", "..", "note"))).toBeUndefined();
  });

  test("surrounding whitespace is trimmed before any refusal or resolution check", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, "  note  ")).toBe(join(VAULT, "note.md"));
  });
});

describe("resolveWikiSlug — .md implied vs. an explicit non-.md extension", () => {
  test("a slug naming a note with no extension implies .md", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "note.md"));
  });

  test("an embed slug that already names its own extension resolves without .md appended", () => {
    const index = indexOf([{ relPath: "image.png" }]);
    expect(resolveWikiSlug(index, "image.png")).toBe(join(VAULT, "image.png"));
  });

  test("an unresolvable slug (neither form exists) refuses cleanly", () => {
    const index = indexOf([{ relPath: "note.md" }]);
    expect(resolveWikiSlug(index, "missing")).toBeUndefined();
  });
});

describe("buildWikiIndex — file/directory/symlink classification", () => {
  test("directories are skipped and never resolvable", () => {
    const index = indexOf([
      { relPath: "folder", isDirectory: true },
      { relPath: "note.md" },
    ]);
    expect(resolveWikiSlug(index, "folder")).toBeUndefined();
    expect(resolveWikiSlug(index, "note")).toBe(join(VAULT, "note.md"));
  });

  test("a symlinked directory's own entry (isDirectory: true, isSymbolicLink: true) is not indexed as a file", () => {
    const index = indexOf([{ relPath: "linked", isDirectory: true, isSymbolicLink: true }]);
    expect(resolveWikiSlug(index, "linked")).toBeUndefined();
  });

  test("a symlinked file (isDirectory: false, isSymbolicLink: true) is indexed like any other file", () => {
    const index = indexOf([{ relPath: "linked.md", isDirectory: false, isSymbolicLink: true }]);
    expect(resolveWikiSlug(index, "linked")).toBe(join(VAULT, "linked.md"));
  });
});

describe("fileUri", () => {
  test("a plain absolute path becomes a triple-slash file URI", () => {
    expect(fileUri(abs("vault", "note.md"))).toBe(`file://${abs("vault", "note.md")}`);
  });

  test("a space is percent-encoded", () => {
    expect(fileUri(abs("a b", "c.md"))).toBe(`file://${abs("a%20b", "c.md")}`);
  });

  test("a literal # in the path is percent-encoded (never read as a fragment separator)", () => {
    expect(fileUri(abs("a#b", "c.md"))).toBe(`file://${abs("a%23b", "c.md")}`);
  });

  test("a literal % in the path is percent-encoded", () => {
    expect(fileUri(abs("a%b", "c.md"))).toBe(`file://${abs("a%25b", "c.md")}`);
  });

  test("a ? in the path is percent-encoded", () => {
    expect(fileUri(abs("a?b", "c.md"))).toBe(`file://${abs("a%3Fb", "c.md")}`);
  });

  test("non-ASCII characters are percent-encoded as UTF-8 octets", () => {
    expect(fileUri(abs("café", "c.md"))).toBe(`file://${abs("caf%C3%A9", "c.md")}`);
  });

  test("a fragment is appended behind a literal #, itself encoded", () => {
    expect(fileUri(abs("vault", "note.md"), "Heading One")).toBe(`file://${abs("vault", "note.md")}#Heading%20One`);
  });

  test("a # inside the fragment text itself is percent-encoded", () => {
    expect(fileUri(abs("vault", "note.md"), "a#b")).toBe(`file://${abs("vault", "note.md")}#a%23b`);
  });

  test("no fragment argument means no trailing #", () => {
    expect(fileUri(abs("vault", "note.md"))).not.toContain("#");
  });
});

describe("createWikiLinkResolver — laziness", () => {
  test("the index is never built at creation, and is built exactly once across many resolutions", () => {
    const fs = fakeFs([{ relPath: "note.md" }], [join(VAULT, ".git")]);
    const resolve = createWikiLinkResolver(join(VAULT, "x.md"), fs);
    expect(fs.listCalls).toBe(0);

    resolve("note");
    resolve("note");
    resolve("missing");

    expect(fs.listCalls).toBe(1);
  });

  test("a resolving slug produces a file:// URI, an unresolved one produces undefined", () => {
    const fs = fakeFs([{ relPath: "note.md" }], [join(VAULT, ".git")]);
    const resolve = createWikiLinkResolver(join(VAULT, "x.md"), fs);
    expect(resolve("note")).toBe(`file://${join(VAULT, "note.md")}`);
    expect(resolve("missing")).toBeUndefined();
  });

  test("a fragment reaches the produced URI", () => {
    const fs = fakeFs([{ relPath: "note.md" }], [join(VAULT, ".git")]);
    const resolve = createWikiLinkResolver(join(VAULT, "x.md"), fs);
    expect(resolve("note", "Section")).toBe(`file://${join(VAULT, "note.md")}#Section`);
  });
});

describe("defaultWikiFs (real filesystem)", () => {
  test("list() never descends into .git, .obsidian, node_modules, or any other dot-directory", () => {
    withRealVault(
      (root) => {
        mkdirSync(join(root, ".git"));
        writeFileSync(join(root, ".git", "inside.md"), "x");
        mkdirSync(join(root, ".obsidian"));
        writeFileSync(join(root, ".obsidian", "inside.md"), "x");
        mkdirSync(join(root, ".hidden"));
        writeFileSync(join(root, ".hidden", "inside.md"), "x");
        mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(root, "node_modules", "pkg", "inside.md"), "x");
        writeFileSync(join(root, "real.md"), "x");
      },
      (root) => {
        const relPaths = defaultWikiFs.list(root).map((entry) => entry.relPath);
        expect(relPaths).toContain("real.md");
        expect(relPaths).not.toContain(p(".git", "inside.md"));
        expect(relPaths).not.toContain(p(".obsidian", "inside.md"));
        expect(relPaths).not.toContain(p(".hidden", "inside.md"));
        expect(relPaths).not.toContain(p("node_modules", "pkg", "inside.md"));
        expect(relPaths).not.toContain(p("node_modules", "pkg"));
      },
    );
  });

  test("list() reports a symlinked directory but does not descend into it", () => {
    withRealVault(
      (root) => {
        mkdirSync(join(root, "target"));
        writeFileSync(join(root, "target", "nested.md"), "x");
        symlinkSync(join(root, "target"), join(root, "linked"));
      },
      (root) => {
        const entries = defaultWikiFs.list(root);
        const linked = entries.find((entry) => entry.relPath === "linked");
        expect(linked).toBeDefined();
        expect(linked?.isSymbolicLink).toBe(true);

        const relPaths = entries.map((entry) => entry.relPath);
        expect(relPaths).toContain(p("target", "nested.md"));
        expect(relPaths).not.toContain(p("linked", "nested.md"));
      },
    );
  });

  test("buildWikiIndex + resolveWikiSlug end-to-end over a real directory tree", () => {
    withRealVault(
      (root) => {
        mkdirSync(join(root, "notes"));
        writeFileSync(join(root, "notes", "hello.md"), "# Hello");
      },
      (root) => {
        const index = buildWikiIndex(root, defaultWikiFs);
        expect(resolveWikiSlug(index, "hello")).toBe(join(root, "notes", "hello.md"));
        expect(resolveWikiSlug(index, "nope")).toBeUndefined();
      },
    );
  });

  test("findVaultRoot: a .git directory and a .git file (a worktree's gitdir pointer) are both a hit", () => {
    withRealVault(
      (root) => {
        mkdirSync(join(root, ".git"));
        mkdirSync(join(root, "sub"));
      },
      (root) => {
        expect(findVaultRoot(join(root, "sub", "note.md"), defaultWikiFs)).toBe(root);
      },
    );

    withRealVault(
      (root) => {
        // Simulates a git worktree, where `.git` at the vault root is a plain file.
        writeFileSync(join(root, ".git"), "gitdir: elsewhere");
        mkdirSync(join(root, "sub"));
      },
      (root) => {
        expect(findVaultRoot(join(root, "sub", "note.md"), defaultWikiFs)).toBe(root);
      },
    );
  });
});
