import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig, writeHighlightAlias, type MdviewConfig } from "../src/config";
import { getBuiltinAliases, isSupportedLanguage, resolveFenceLanguage, setHighlightAliases } from "../src/lang";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "mdview-config-test-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function captureConsoleError(): { messages: string[]; restore: () => void } {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return { messages, restore: () => (console.error = original) };
}

describe("loadConfig (WP-4: highlightAs alongside WP-1's corpusManifest)", () => {
  test("a missing config file resolves to empty defaults, silently", async () => {
    const capture = captureConsoleError();
    try {
      const config = await loadConfig(join(tmpdir(), "mdview-config-test-does-not-exist", "config.json"));
      expect(config).toEqual({});
      expect(capture.messages).toEqual([]);
    } finally {
      capture.restore();
    }
  });

  test("loads a valid corpusManifest and highlightAs together", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ corpusManifest: "/some/manifest.json", highlightAs: { tasks: "yaml" } }),
      );
      const config = await loadConfig(path);
      expect(config).toEqual({
        corpusManifest: "/some/manifest.json",
        highlightAs: { tasks: "yaml" },
      });
    });
  });

  test("highlightAs keys and values are trimmed and lowercased on load", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ highlightAs: { " Tasks ": " YAML " } }));
      const config = await loadConfig(path);
      expect(config.highlightAs).toEqual({ tasks: "yaml" });
    });
  });

  test("invalid JSON falls back to defaults, with one clear stderr notice naming the path", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, "{not json");
      const capture = captureConsoleError();
      try {
        const config = await loadConfig(path);
        expect(config).toEqual({});
        expect(capture.messages).toHaveLength(1);
        expect(capture.messages[0]).toContain(path);
        expect(capture.messages[0]).not.toContain("\n    at "); // never a stack trace
      } finally {
        capture.restore();
      }
    });
  });

  test("a top-level JSON array falls back to defaults with a clear notice", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, "[]");
      const capture = captureConsoleError();
      try {
        const config = await loadConfig(path);
        expect(config).toEqual({});
        expect(capture.messages).toHaveLength(1);
        expect(capture.messages[0]).toContain(path);
      } finally {
        capture.restore();
      }
    });
  });

  test("a malformed highlightAs (not an object) is dropped, with a clear notice, other keys survive", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ corpusManifest: "/m.json", highlightAs: "not-an-object" }));
      const capture = captureConsoleError();
      try {
        const config = await loadConfig(path);
        expect(config).toEqual({ corpusManifest: "/m.json" });
        expect(capture.messages).toHaveLength(1);
        expect(capture.messages[0]).toContain(path);
        expect(capture.messages[0]).toContain("highlightAs");
      } finally {
        capture.restore();
      }
    });
  });

  test("bad individual highlightAs entries are dropped; good ones in the same object survive", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(
        path,
        JSON.stringify({ highlightAs: { good: "sql", bad: 42, alsoBad: "" } }),
      );
      const capture = captureConsoleError();
      try {
        const config = await loadConfig(path);
        expect(config.highlightAs).toEqual({ good: "sql" });
        expect(capture.messages).toHaveLength(1);
        expect(capture.messages[0]).toContain("bad");
        expect(capture.messages[0]).toContain("alsoBad");
      } finally {
        capture.restore();
      }
    });
  });
});

describe("writeHighlightAlias (WP-4)", () => {
  test("creates a config file that does not exist yet", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "sub", "config.json");
      const result = await writeHighlightAlias("tasks", "yaml", path);
      expect(result).toEqual({ path, created: true });
      const config = await loadConfig(path);
      expect(config).toEqual({ highlightAs: { tasks: "yaml" } });
    });
  });

  test("normalizes fence and language to trimmed lowercase", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeHighlightAlias("  Tasks  ", "  YAML  ", path);
      const config = await loadConfig(path);
      expect(config.highlightAs).toEqual({ tasks: "yaml" });
    });
  });

  test("preserves unrelated top-level keys already in the file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ corpusManifest: "/keep/me.json" }, null, 2));
      await writeHighlightAlias("tasks", "yaml", path);
      const config = await loadConfig(path);
      expect(config.corpusManifest).toBe("/keep/me.json");
      expect(config.highlightAs).toEqual({ tasks: "yaml" });
    });
  });

  test("preserves other highlightAs entries already in the file", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeHighlightAlias("tasks", "yaml", path);
      await writeHighlightAlias("query", "sql", path);
      const config = await loadConfig(path);
      expect(config.highlightAs).toEqual({ tasks: "yaml", query: "sql" });
    });
  });

  test("overwriting an existing fence's mapping replaces only that entry", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeHighlightAlias("tasks", "yaml", path);
      const second = await writeHighlightAlias("tasks", "json", path);
      expect(second.created).toBe(false);
      const config = await loadConfig(path);
      expect(config.highlightAs).toEqual({ tasks: "json" });
    });
  });

  test("refuses to write over a file that is not valid JSON, and names the path", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, "{not json");
      await expect(writeHighlightAlias("tasks", "yaml", path)).rejects.toThrow(
        new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      // left untouched — a failed write must not clobber a file it could not parse
      const raw = await Bun.file(path).text();
      expect(raw).toBe("{not json");
    });
  });

  test("refuses to write over a file whose top level is not an object", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, "[]");
      await expect(writeHighlightAlias("tasks", "yaml", path)).rejects.toThrow(/JSON object/);
    });
  });

  test("rejects an empty fence or language", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await expect(writeHighlightAlias("  ", "yaml", path)).rejects.toThrow("<fence>");
      await expect(writeHighlightAlias("tasks", "  ", path)).rejects.toThrow("<language>");
    });
  });

  test("leaves no temp file behind after a successful write", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeHighlightAlias("tasks", "yaml", path);
      const entries = await readdir(dir);
      expect(entries).toEqual(["config.json"]);
    });
  });
});

// --- lang.ts additions (WP-4: config-sourced aliases layered over the built-ins) ---
//
// These live here rather than in tests/lang.test.ts because this WP's file scope is
// `tests/config.test.ts`. `setHighlightAliases` is global, mutable module state (the
// only way a `highlight-as` write can affect `render.ts`'s single-argument
// `resolveFenceLanguage(token.lang)` call site without editing render.ts).
//
// **Module state is shared across test files in the same `bun test` invocation —
// re-verified on Bun 1.3.11 in WP-6 of `plans/tn-review-remediation.md`, with a
// two-line probe (one file sets `query -> sql`, a second file that never mentions
// the symbol observes `sql`, not the built-in default).** Deleting the `afterEach`
// below reproduces the failure directly: `bun test tests/config.test.ts
// tests/lang.test.ts` goes from 31 pass to 30 pass / 1 fail, because the last test
// in this `describe` leaves `query -> sql` set and `tests/lang.test.ts` expects the
// built-in default. **Today's full-suite gate (`bun test tests`) stays green even
// without this reset — but only by accident**: `tests/cli.test.ts` happens to run
// after this file and before `tests/lang.test.ts`, and one of its tests calls the
// real `main()` against a real file, which loads the real config and calls
// `setHighlightAliases` as a side effect, incidentally wiping the leak before
// `tests/lang.test.ts` runs. **That ordering is not alphabetical and is not
// guaranteed.** Measured on the full suite, the files run in this order: sweep,
// overflow, glyphs, render, containment, render-lists, config, detectors, wrap,
// width, witnesses, cli, frontmatter, table, licenses, lang. And the *same two
// files*, passed to `bun test` in the *same* argument order, ran in opposite
// orders in two different checkouts of this repo — which is exactly how WP-6's
// brief reached the wrong conclusion about whether the leak exists at all. The
// masking above is therefore luck that is re-rolled per machine: a reordering, a
// rename, or a change to what `tests/cli.test.ts` exercises brings it back. Both
// hooks: `afterEach` restores the built-in-only state so no later file observes a
// leftover override, and `beforeEach` protects this describe's own early tests
// (which assume no user alias is installed) from a leak arriving the other way —
// from an earlier-running file or test, exactly what `tests/cli.test.ts` does
// today.
describe("lang.ts: config-sourced highlight aliases (WP-4)", () => {
  beforeEach(() => {
    setHighlightAliases({});
  });

  afterEach(() => {
    setHighlightAliases({});
  });

  test("getBuiltinAliases exposes the locked defaults", () => {
    expect(getBuiltinAliases()).toEqual({ dataviewjs: "javascript", dataview: "sql" });
  });

  test("isSupportedLanguage matches cli-highlight's own answer, case-insensitively", () => {
    expect(isSupportedLanguage("javascript")).toBe(true);
    expect(isSupportedLanguage("JavaScript")).toBe(true);
    expect(isSupportedLanguage("plaintext")).toBe(true);
    expect(isSupportedLanguage("not-a-real-language")).toBe(false);
  });

  test("with no user aliases installed, resolution is exactly the built-in map", () => {
    expect(resolveFenceLanguage("dataviewjs")).toBe("javascript");
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
  });

  test("a user alias for a fence with no built-in default is layered in", () => {
    setHighlightAliases({ tasks: "yaml" });
    expect(resolveFenceLanguage("tasks")).toBe("yaml");
  });

  test("a user alias for a fence that already has a built-in default wins", () => {
    setHighlightAliases({ dataviewjs: "python" });
    expect(resolveFenceLanguage("dataviewjs")).toBe("python");
  });

  test("a user alias to an unsupported language still falls back to plaintext", () => {
    // setHighlightAliases itself does not validate — the CLI's write path does
    // (`isSupportedLanguage`, checked in `mdview highlight-as`) — so this pins that
    // resolveFenceLanguage's own supportsLanguage() guard is the last line of defense
    // regardless of how an alias reached the map.
    setHighlightAliases({ tasks: "not-a-real-language" });
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
  });

  test("calling setHighlightAliases again fully replaces the previous layering", () => {
    setHighlightAliases({ tasks: "yaml" });
    setHighlightAliases({ query: "sql" });
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
    expect(resolveFenceLanguage("query")).toBe("sql");
  });
});

describe("MdviewConfig shape (documentation-as-test)", () => {
  test("highlightAs is an optional Record<string, string>", () => {
    const config: MdviewConfig = { highlightAs: { tasks: "yaml" } };
    expect(config.highlightAs?.tasks).toBe("yaml");
  });
});
