import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadConfig, writeHighlightAlias, type MdviewConfig } from "../src/config";
import {
  getBuiltinAliases,
  isSupportedLanguage,
  makeFenceLanguageResolver,
  resolveFenceLanguage,
} from "../src/lang";

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

/**
 * The `color` key, added by WP-1 of `plans/colour-policy.md`.
 *
 * It is the fifth slot in the colour precedence table (`src/colour.ts`) and it obeys this
 * module's existing read-leniently contract rather than a new one of its own: a value it
 * cannot use costs that key alone, names the file, and never stops the document rendering.
 */
describe("loadConfig — the color key", () => {
  const write = async (dir: string, value: unknown): Promise<string> => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ corpusManifest: "/m.json", color: value }));
    return path;
  };

  test("the three directives load as themselves", async () => {
    await withTempDir(async (dir) => {
      for (const value of ["auto", "always", "never"] as const) {
        const path = await write(dir, value);
        expect((await loadConfig(path)).color).toBe(value);
      }
    });
  });

  test("case and whitespace are forgiven, matching how highlightAs treats a hand-edited file", async () => {
    await withTempDir(async (dir) => {
      expect((await loadConfig(await write(dir, " ALWAYS "))).color).toBe("always");
    });
  });

  test("an unrecognised value is dropped with one notice, and other keys survive", async () => {
    await withTempDir(async (dir) => {
      const path = await write(dir, "sometimes");
      const capture = captureConsoleError();
      try {
        expect(await loadConfig(path)).toEqual({ corpusManifest: "/m.json" });
        expect(capture.messages).toHaveLength(1);
        expect(capture.messages[0]).toContain(path);
        expect(capture.messages[0]).toContain("color");
      } finally {
        capture.restore();
      }
    });
  });

  test("a boolean is not a directive — the shape mistake the emoji key invites", async () => {
    // `emoji` next door *is* a boolean, so `"color": true` is the natural wrong guess. It is
    // rejected rather than read as "always", because guessing at a shape the user did not
    // write is how a config silently means something other than what it says.
    await withTempDir(async (dir) => {
      const path = await write(dir, true);
      const capture = captureConsoleError();
      try {
        expect((await loadConfig(path)).color).toBeUndefined();
        expect(capture.messages).toHaveLength(1);
      } finally {
        capture.restore();
      }
    });
  });

  test("an absent key is absent, not 'auto', and says nothing on stderr", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ corpusManifest: "/m.json" }));
      const capture = captureConsoleError();
      try {
        expect(await loadConfig(path)).toEqual({ corpusManifest: "/m.json" });
        expect(capture.messages).toEqual([]);
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

// --- lang.ts: the fence-language resolver (F4, WP-3 of the renderer replacement) ---
//
// These live here rather than in `tests/lang.test.ts` because the WP that added
// config-sourced aliases scoped itself to `tests/config.test.ts`, and moving them now would
// churn two files to say the same thing.
//
// **What changed, and why the isolation hooks are gone.** This describe block used to open
// with a `beforeEach`/`afterEach` pair calling `setHighlightAliases({})`, and a thirty-line
// comment explaining that `src/lang.ts` carried mutable module state, that Bun shares module
// state across test files in one invocation, that deleting the `afterEach` reproduced a real
// cross-file failure (`bun test tests/config.test.ts tests/lang.test.ts`: 31 pass → 30 pass /
// 1 fail), and that the full-suite gate stayed green only by an accident of file ordering
// which had been measured to differ between two checkouts of this repo.
//
// F4 removed the state rather than the symptom. `setHighlightAliases` is gone;
// `makeFenceLanguageResolver` returns a resolver over a frozen alias map, and `src/cli.ts`
// threads it into `renderDocumentDetailed` instead of installing it process-wide. There is
// no longer anything for one test — or one file — to leak into another, so the hooks are not
// merely unnecessary, they have nothing left to reset. The reproduction above was re-run
// with them removed and stays green; see this WP's report for the verbatim result.
//
// `resolveFenceLanguage` survives as the defaulted compatibility wrapper the plan requires:
// the same single-argument call shape, resolving against the built-in aliases alone.
describe("lang.ts: the fence-language resolver and its built-in defaults", () => {
  test("getBuiltinAliases exposes the locked defaults", () => {
    expect(getBuiltinAliases()).toEqual({ dataviewjs: "javascript", dataview: "sql" });
  });

  test("isSupportedLanguage matches highlight.js's own answer, case-insensitively", () => {
    expect(isSupportedLanguage("javascript")).toBe(true);
    expect(isSupportedLanguage("JavaScript")).toBe(true);
    expect(isSupportedLanguage("plaintext")).toBe(true);
    expect(isSupportedLanguage("not-a-real-language")).toBe(false);
  });

  test("the compatibility wrapper resolves against exactly the built-in map", () => {
    expect(resolveFenceLanguage("dataviewjs")).toBe("javascript");
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
  });

  test("a resolver built with no user aliases matches the compatibility wrapper", () => {
    const resolve = makeFenceLanguageResolver();
    expect(resolve("dataviewjs")).toBe("javascript");
    expect(resolve("tasks")).toBe("plaintext");
    expect(resolve(undefined)).toBe(undefined);
    expect(resolve("")).toBe("");
  });

  test("a user alias for a fence with no built-in default is layered in", () => {
    expect(makeFenceLanguageResolver({ tasks: "yaml" })("tasks")).toBe("yaml");
  });

  test("a user alias for a fence that already has a built-in default wins", () => {
    expect(makeFenceLanguageResolver({ dataviewjs: "python" })("dataviewjs")).toBe("python");
  });

  test("a user alias to an unsupported language still falls back to plaintext", () => {
    // The factory does not validate — the CLI's write path does (`isSupportedLanguage`,
    // checked in `mdview highlight-as`) — so this pins that the resolver's own
    // supportsLanguage() guard is the last line of defense regardless of how an alias
    // reached the map.
    expect(makeFenceLanguageResolver({ tasks: "not-a-real-language" })("tasks")).toBe("plaintext");
  });

  test("two resolvers are independent, and neither touches the built-in wrapper", () => {
    // The behavioural difference from the setter this replaced, stated as a test: building a
    // second resolver used to *replace* the first's layering process-wide.
    const first = makeFenceLanguageResolver({ tasks: "yaml" });
    const second = makeFenceLanguageResolver({ query: "sql" });
    expect(first("tasks")).toBe("yaml");
    expect(first("query")).toBe("plaintext");
    expect(second("tasks")).toBe("plaintext");
    expect(second("query")).toBe("sql");
    expect(resolveFenceLanguage("tasks")).toBe("plaintext");
    expect(resolveFenceLanguage("query")).toBe("plaintext");
  });

  test("the merged alias map is frozen, so a resolver cannot be re-pointed after the fact", () => {
    const aliases: Record<string, string> = { tasks: "yaml" };
    const resolve = makeFenceLanguageResolver(aliases);
    aliases.tasks = "sql";
    expect(resolve("tasks")).toBe("yaml");
  });
});

describe("MdviewConfig shape (documentation-as-test)", () => {
  test("highlightAs is an optional Record<string, string>", () => {
    const config: MdviewConfig = { highlightAs: { tasks: "yaml" } };
    expect(config.highlightAs?.tasks).toBe("yaml");
  });
});
