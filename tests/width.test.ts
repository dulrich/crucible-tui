import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NARROW_MEASURE,
  PROBE_GLYPH,
  WIDE_MEASURE,
  measureFor,
  parseAmbiguousWidth,
  probeAmbiguousWidth,
  readCachedAmbiguousWidth,
  resolveAmbiguousCachePath,
  resolveAmbiguousWidth,
  terminalIdentity,
  writeCachedAmbiguousWidth,
} from "../src/width";
import { renderDocument } from "../src/render";
import { ASCII_GLYPHS, UNICODE_GLYPHS, resolveGlyphs, wideForcesAscii } from "../src/glyphs";
import { formatProbeReport, main, parseArgs } from "../src/cli";

const REPO_ROOT = join(import.meta.dir, "..");

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), "mdview-width-"));

// ---------------------------------------------------------------------------
// The single-import property
// ---------------------------------------------------------------------------

describe("string-width has exactly one importer", () => {
  /**
   * The property this WP is built on: the ambiguous-width setting is a per-call option
   * in `string-width@7`, so a module that imports it directly silently opts out of
   * whatever mode was resolved. **No width gate can catch that** — a check measured
   * with the wrong ruler passes — so it is asserted structurally instead.
   */
  test("only src/width.ts imports string-width across src/ and scripts/", async () => {
    const offenders: string[] = [];
    for (const dir of ["src", "scripts"]) {
      for (const name of await readdir(join(REPO_ROOT, dir))) {
        if (!name.endsWith(".ts")) continue;
        const relative = `${dir}/${name}`;
        const source = await readFile(join(REPO_ROOT, relative), "utf8");
        const imports = source.split("\n").some((line) => /^\s*import\s.*["']string-width["']/.test(line));
        if (imports && relative !== "src/width.ts") offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The measures
// ---------------------------------------------------------------------------

describe("Measure", () => {
  test("narrow counts ambiguous characters as 1 column, wide as 2", () => {
    for (const ch of ["—", "–", "→", "←", "…", "≥", "×", "•", "○", "─", "│"]) {
      expect(NARROW_MEASURE(ch)).toBe(1);
      expect(WIDE_MEASURE(ch)).toBe(2);
    }
  });

  test("neither mode changes unambiguous characters", () => {
    for (const ch of ["a", "-", "+", "‣", "◦", "✓", "漢", "😀", "⚠"]) {
      expect(NARROW_MEASURE(ch)).toBe(WIDE_MEASURE(ch));
    }
  });

  test("each measure reports which convention it applies", () => {
    expect(NARROW_MEASURE.ambiguous).toBe("narrow");
    expect(WIDE_MEASURE.ambiguous).toBe("wide");
    expect(measureFor("wide")).toBe(WIDE_MEASURE);
    expect(measureFor("narrow")).toBe(NARROW_MEASURE);
  });

  test("ANSI escapes stay zero-width in both modes", () => {
    expect(NARROW_MEASURE("\x1b[36mtext\x1b[39m")).toBe(4);
    expect(WIDE_MEASURE("\x1b[36mtext\x1b[39m")).toBe(4);
  });
});

describe("parseAmbiguousWidth", () => {
  test("accepts exactly the two documented spellings", () => {
    expect(parseAmbiguousWidth("narrow")).toBe("narrow");
    expect(parseAmbiguousWidth("wide")).toBe("wide");
  });

  // Matches `MDVIEW_GLYPHS`'s contract exactly: a bad value is ignored, never thrown on.
  test("ignores anything else instead of throwing", () => {
    for (const value of [undefined, "", "NARROW", "Wide", "true", "2", " wide "]) {
      expect(parseAmbiguousWidth(value)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal identity and the cache
// ---------------------------------------------------------------------------

describe("terminalIdentity", () => {
  test("separates the user's two real targets", () => {
    const urxvt = terminalIdentity({ TERM: "rxvt-unicode-256color", LANG: "en_US.UTF-8" });
    const ghosttyInZellij = terminalIdentity({
      TERM: "xterm-256color",
      TERM_PROGRAM: "ghostty",
      ZELLIJ: "0",
      LANG: "en_US.UTF-8",
    });
    expect(urxvt).not.toBe(ghosttyInZellij);
  });

  // A bare TERM is not enough: a multiplexer rewrites it, so ghostty bare and ghostty
  // inside zellij can present identically while drawing cells through different code.
  test("the multiplexer alone changes the identity", () => {
    const bare = { TERM: "xterm-256color", TERM_PROGRAM: "ghostty", LANG: "en_US.UTF-8" };
    expect(terminalIdentity(bare)).not.toBe(terminalIdentity({ ...bare, ZELLIJ: "0" }));
    expect(terminalIdentity({ ...bare, TMUX: "/tmp/x" })).not.toBe(terminalIdentity({ ...bare, ZELLIJ: "0" }));
  });

  // The locale is conventionally what drives a terminal's ambiguous-width behaviour,
  // so the same emulator can legitimately answer differently under a different LANG.
  test("the locale changes the identity", () => {
    const base = { TERM: "xterm-256color" };
    expect(terminalIdentity({ ...base, LANG: "en_US.UTF-8" })).not.toBe(
      terminalIdentity({ ...base, LANG: "ja_JP.UTF-8" }),
    );
  });

  test("is stable for the same environment", () => {
    const env = { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", LANG: "en_US.UTF-8" };
    expect(terminalIdentity(env)).toBe(terminalIdentity({ ...env }));
  });
});

describe("resolveAmbiguousCachePath", () => {
  test("prefers XDG_CACHE_HOME", () => {
    expect(resolveAmbiguousCachePath({ XDG_CACHE_HOME: "/example/cache" })).toBe(
      "/example/cache/mdview/ambiguous-width.json",
    );
  });

  test("falls back to ~/.cache", () => {
    const path = resolveAmbiguousCachePath({});
    expect(path.endsWith("/.cache/mdview/ambiguous-width.json")).toBe(true);
  });

  test("treats an empty XDG_CACHE_HOME as unset", () => {
    expect(resolveAmbiguousCachePath({ XDG_CACHE_HOME: "" })).toBe(resolveAmbiguousCachePath({}));
  });
});

describe("the cache", () => {
  test("round-trips one identity's answer", async () => {
    const path = join(await scratch(), "mdview", "ambiguous-width.json");
    expect(await writeCachedAmbiguousWidth("term=a", "wide", path)).toBe(true);
    expect((await readCachedAmbiguousWidth("term=a", path))?.ambiguous).toBe("wide");
  });

  // The whole point of keying it: ghostty must never inherit urxvt's answer.
  test("a different identity is a miss, not a wrong answer", async () => {
    const path = join(await scratch(), "mdview", "ambiguous-width.json");
    await writeCachedAmbiguousWidth("term=urxvt", "wide", path);
    expect(await readCachedAmbiguousWidth("term=ghostty", path)).toBeUndefined();
  });

  test("a second write preserves the first identity's entry", async () => {
    const path = join(await scratch(), "mdview", "ambiguous-width.json");
    await writeCachedAmbiguousWidth("term=urxvt", "wide", path);
    await writeCachedAmbiguousWidth("term=ghostty", "narrow", path);
    expect((await readCachedAmbiguousWidth("term=urxvt", path))?.ambiguous).toBe("wide");
    expect((await readCachedAmbiguousWidth("term=ghostty", path))?.ambiguous).toBe("narrow");
  });

  // A cache is reconstructible by definition, so every unusable shape degrades to a
  // re-probe. None of these may throw: a viewer that refuses to render because a
  // derived file it created is corrupt has mistaken its plumbing for the request.
  test("every corrupt shape reads as a miss and never throws", async () => {
    const dir = await scratch();
    const cases: Array<[string, string]> = [
      ["not-json", "{{{"],
      ["not-an-object", "[1,2,3]"],
      ["truncated", '{"version": 1, "entries": {"term=a": {"ambig'],
      ["wrong-version", '{"version": 99, "entries": {"term=a": {"ambiguous": "wide"}}}'],
      ["entries-not-an-object", '{"version": 1, "entries": []}'],
      ["entry-not-an-object", '{"version": 1, "entries": {"term=a": "wide"}}'],
      ["bad-value", '{"version": 1, "entries": {"term=a": {"ambiguous": "sideways"}}}'],
      ["empty", ""],
    ];
    for (const [name, body] of cases) {
      const path = join(dir, `${name}.json`);
      await writeFile(path, body, "utf8");
      expect(await readCachedAmbiguousWidth("term=a", path)).toBeUndefined();
    }
  });

  test("a missing file reads as a miss", async () => {
    expect(await readCachedAmbiguousWidth("term=a", join(await scratch(), "nope", "nope.json"))).toBeUndefined();
  });

  test("replaces a corrupt cache rather than refusing to write", async () => {
    const dir = await scratch();
    const path = join(dir, "ambiguous-width.json");
    await writeFile(path, "{{{ not json", "utf8");
    expect(await writeCachedAmbiguousWidth("term=a", "wide", path)).toBe(true);
    expect((await readCachedAmbiguousWidth("term=a", path))?.ambiguous).toBe("wide");
  });

  // An unwritable cache must cost a re-probe next time and nothing else.
  test("an unwritable path reports failure instead of throwing", async () => {
    const dir = await scratch();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    expect(await writeCachedAmbiguousWidth("term=a", "wide", join(blocker, "sub", "cache.json"))).toBe(false);
  });

  test("leaves no temp file behind", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "mdview"), { recursive: true });
    const path = join(dir, "mdview", "ambiguous-width.json");
    await writeCachedAmbiguousWidth("term=a", "wide", path);
    expect((await readdir(join(dir, "mdview"))).sort()).toEqual(["ambiguous-width.json"]);
  });
});

// ---------------------------------------------------------------------------
// A scripted terminal, so the probe is testable without a pty
// ---------------------------------------------------------------------------

interface ScriptedTerminal {
  stdin: never;
  stdout: never;
  written: () => string;
  rawModeCalls: () => boolean[];
}

// Deliberately matching the ESC control character, as `src/wrap.ts` and
// `src/detectors.ts` do: this double has to interpret the same escape sequences a real
// terminal would.
// eslint-disable-next-line no-control-regex
const CURSOR_TO_COLUMN = /^\x1b\[(\d*)G/;
// eslint-disable-next-line no-control-regex
const ANY_CSI_SEQUENCE = /^\x1b\[[0-9;]*[A-Za-z]/;

/**
 * A terminal that answers DSR and tracks a cursor column, advancing it by
 * `ambiguousColumns` for each East Asian Ambiguous character written.
 *
 * That is precisely the behaviour the probe exists to detect, so a test against this
 * double exercises the probe's real arithmetic, its cleanup and its escape sequences —
 * the only thing it cannot stand in for is a real emulator's *answer*, which is why the
 * probe also has to be run by hand in the user's own terminals.
 */
function scriptedTerminal(options: {
  ambiguousColumns: number;
  answers?: boolean;
  startColumn?: number;
  columns?: number;
  rowDriftAfterGlyph?: number;
  interrupt?: boolean;
}): ScriptedTerminal {
  const answers = options.answers ?? true;
  let column = options.startColumn ?? 1;
  let row = 5;
  let queue = "";
  const listeners = new Set<() => void>();
  const written: string[] = [];
  const rawModeCalls: boolean[] = [];
  let glyphsWritten = 0;

  const notify = (): void => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener();
    });
  };

  const stdout = {
    isTTY: true,
    columns: options.columns,
    write(text: string): void {
      written.push(text);
      let index = 0;
      while (index < text.length) {
        if (text.startsWith("\x1b[6n", index)) {
          if (options.interrupt) {
            queue += "\x03";
            notify();
          } else if (answers) {
            queue += `\x1b[${row};${column}R`;
            notify();
          }
          index += 4;
          continue;
        }
        const rest = text.slice(index);
        const cha = CURSOR_TO_COLUMN.exec(rest);
        if (cha) {
          column = Number(cha[1] ?? "1") || 1;
          index += cha[0].length;
          continue;
        }
        const other = ANY_CSI_SEQUENCE.exec(rest);
        if (other) {
          index += other[0].length;
          continue;
        }
        const ch = text[index] as string;
        if (ch === PROBE_GLYPH) {
          glyphsWritten += 1;
          column += options.ambiguousColumns;
          row += options.rowDriftAfterGlyph ?? 0;
        } else {
          column += 1;
        }
        index += 1;
      }
    },
  };

  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean): void {
      rawModeCalls.push(mode);
      stdin.isRaw = mode;
    },
    read(): Buffer | null {
      if (queue === "") return null;
      const chunk = Buffer.from(queue, "latin1");
      queue = "";
      return chunk;
    },
    on(_event: string, listener: () => void): void {
      listeners.add(listener);
    },
    off(_event: string, listener: () => void): void {
      listeners.delete(listener);
    },
    resume(): void {
      if (queue !== "") notify();
    },
    pause(): void {},
    unref(): void {},
  };

  return {
    stdin: stdin as never,
    stdout: stdout as never,
    written: () => written.join(""),
    rawModeCalls: () => rawModeCalls,
    glyphsWritten: () => glyphsWritten,
  } as ScriptedTerminal & { glyphsWritten: () => number };
}

describe("probeAmbiguousWidth", () => {
  test("infers narrow from a terminal that advances the cursor by 1", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 1 });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBe("narrow");
    expect(report.glyphColumns).toBe(1);
    expect(report.columns).toEqual({ before: 1, after: 2 });
  });

  test("infers wide from a terminal that advances the cursor by 2", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBe("wide");
    expect(report.glyphColumns).toBe(2);
  });

  // "Leave no visible artefact": the glyph goes down, then the cursor returns to the
  // column it was recorded at and the line is cleared from there.
  test("erases the test glyph by returning to the recorded column", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2, startColumn: 7 });
    await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    const written = terminal.written();
    expect(written).toContain(PROBE_GLYPH);
    expect(written.endsWith("\x1b[7G\x1b[K")).toBe(true);
  });

  test("restores the terminal's previous raw-mode setting", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 1 });
    await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(terminal.rawModeCalls()).toEqual([true, false]);
  });

  // The failure that matters most: a terminal that never answers must not hang and must
  // not leave the shell in raw mode.
  test("a silent terminal times out, restores cooked mode, and writes nothing", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 1, answers: false });
    const started = Date.now();
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 30);
    expect(report.ambiguous).toBeNull();
    expect(report.detail).toContain("no DSR reply");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(terminal.rawModeCalls()).toEqual([true, false]);
    expect(terminal.written()).not.toContain(PROBE_GLYPH);
  });

  // In raw mode Ctrl-C is a byte, not a signal — ISIG is exactly what raw mode turns
  // off — so it has to be recognised here or there is no way out but a kill, which is
  // the one path that cannot restore cooked mode.
  test("Ctrl-C during the probe aborts instead of hanging", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 1, interrupt: true });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 5000);
    expect(report.ambiguous).toBeNull();
    expect(terminal.rawModeCalls()).toEqual([true, false]);
  });

  test("refuses to probe when stdin is not a TTY", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    const stdin = { ...(terminal.stdin as object), isTTY: false } as never;
    const report = await probeAmbiguousWidth(stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBeNull();
    expect(report.detail).toContain("stdin is not a TTY");
  });

  test("refuses to probe when stdout is not a TTY", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    const stdout = { ...(terminal.stdout as object), isTTY: false } as never;
    const report = await probeAmbiguousWidth(terminal.stdin, stdout, 50);
    expect(report.ambiguous).toBeNull();
    expect(report.detail).toContain("stdout is not a TTY");
  });

  // A glyph written in the last column wraps, the second DSR reports a column on the
  // next row, and the erase would clear a line the probe never wrote. Reporting
  // "inconclusive" is a much better answer than corrupting the screen.
  test("refuses to probe within two columns of the right margin", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2, startColumn: 79, columns: 80 });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBeNull();
    expect(report.detail).toContain("right margin");
    expect(terminal.written()).not.toContain(PROBE_GLYPH);
  });

  test("treats a row change as inconclusive rather than as a width", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2, rowDriftAfterGlyph: 1 });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBeNull();
    expect(report.detail).toContain("row");
  });

  test("treats an impossible column difference as inconclusive", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 5 });
    const report = await probeAmbiguousWidth(terminal.stdin, terminal.stdout, 50);
    expect(report.ambiguous).toBeNull();
    expect(report.glyphColumns).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe("resolveAmbiguousWidth", () => {
  test("1. MDVIEW_AMBIGUOUS wins over everything, including a cached answer", async () => {
    const path = join(await scratch(), "cache.json");
    await writeCachedAmbiguousWidth(terminalIdentity({ TERM: "x" }), "wide", path);
    const resolved = await resolveAmbiguousWidth({ env: { TERM: "x", MDVIEW_AMBIGUOUS: "narrow" }, cachePath: path });
    expect(resolved.ambiguous).toBe("narrow");
    expect(resolved.source).toBe("env");
  });

  test("a malformed MDVIEW_AMBIGUOUS is ignored, never thrown on", async () => {
    const resolved = await resolveAmbiguousWidth({
      env: { TERM: "x", MDVIEW_AMBIGUOUS: "yes-please" },
      cachePath: join(await scratch(), "cache.json"),
    });
    expect(resolved.ambiguous).toBe("narrow");
    expect(resolved.source).toBe("default");
  });

  test("2. a cached answer for this identity wins over the fallback", async () => {
    const path = join(await scratch(), "cache.json");
    const env = { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" };
    await writeCachedAmbiguousWidth(terminalIdentity(env), "wide", path);
    const resolved = await resolveAmbiguousWidth({ env, cachePath: path });
    expect(resolved.ambiguous).toBe("wide");
    expect(resolved.source).toBe("cache");
    expect(resolved.measure).toBe(WIDE_MEASURE);
  });

  test("another terminal's cached answer is not inherited", async () => {
    const path = join(await scratch(), "cache.json");
    await writeCachedAmbiguousWidth(terminalIdentity({ TERM: "rxvt-unicode-256color" }), "wide", path);
    const resolved = await resolveAmbiguousWidth({ env: { TERM: "xterm-ghostty" }, cachePath: path });
    expect(resolved.ambiguous).toBe("narrow");
    expect(resolved.source).toBe("default");
  });

  test("--refresh skips the cache and re-probes", async () => {
    const path = join(await scratch(), "cache.json");
    const env = { TERM: "x" };
    await writeCachedAmbiguousWidth(terminalIdentity(env), "wide", path);
    const terminal = scriptedTerminal({ ambiguousColumns: 1 });
    const resolved = await resolveAmbiguousWidth({
      env,
      cachePath: path,
      refresh: true,
      allowProbe: true,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      timeoutMs: 50,
    });
    expect(resolved.source).toBe("probe");
    expect(resolved.ambiguous).toBe("narrow");
  });

  test("3. a live probe result is recorded in the cache", async () => {
    const path = join(await scratch(), "cache.json");
    const env = { TERM: "x" };
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    const resolved = await resolveAmbiguousWidth({
      env,
      cachePath: path,
      allowProbe: true,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      timeoutMs: 50,
    });
    expect(resolved.source).toBe("probe");
    expect(resolved.ambiguous).toBe("wide");
    expect((await readCachedAmbiguousWidth(terminalIdentity(env), path))?.ambiguous).toBe("wide");
  });

  test("--no-cache probes without recording", async () => {
    const path = join(await scratch(), "cache.json");
    const env = { TERM: "x" };
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    await resolveAmbiguousWidth({
      env,
      cachePath: path,
      allowProbe: true,
      noCache: true,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      timeoutMs: 50,
    });
    expect(await readCachedAmbiguousWidth(terminalIdentity(env), path)).toBeUndefined();
  });

  // The default direction that keeps every gate deterministic: probing is opt-in, so
  // `--check`, the sweep and the whole test suite get "no terminal I/O" for free.
  test("4. no probing unless the caller asks", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 2 });
    const resolved = await resolveAmbiguousWidth({
      env: { TERM: "x" },
      cachePath: join(await scratch(), "cache.json"),
      stdin: terminal.stdin,
      stdout: terminal.stdout,
    });
    expect(resolved.source).toBe("default");
    expect(resolved.ambiguous).toBe("narrow");
    expect(resolved.probe).toBeUndefined();
    expect(terminal.written()).toBe("");
  });

  test("a failed probe falls back to narrow and keeps the report", async () => {
    const terminal = scriptedTerminal({ ambiguousColumns: 1, answers: false });
    const resolved = await resolveAmbiguousWidth({
      env: { TERM: "x" },
      cachePath: join(await scratch(), "cache.json"),
      allowProbe: true,
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      timeoutMs: 30,
    });
    expect(resolved.ambiguous).toBe("narrow");
    expect(resolved.source).toBe("default");
    expect(resolved.probe?.ambiguous).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the mode actually does to a render
// ---------------------------------------------------------------------------

const AMBIGUOUS_DOC = `# Heading

A paragraph with em dashes — and arrows → and ellipses … running on long enough that
the line has to wrap somewhere in the middle of it all.

- a list item — with an em dash and enough words after it to reach the target width
- another item → with an arrow and, again, plenty of following words to force a wrap
`;

const ASCII_DOC = `# Heading

A paragraph with no ambiguous characters at all, just plain ASCII words running on
long enough that the line has to wrap somewhere in the middle of it.

- a list item with plain words and enough of them to reach the target width exactly
- another item with more plain words and, again, plenty of them to force a wrap here
`;

describe("threading the measure through a render", () => {
  test("the default argument is the narrow measure", () => {
    for (const width of [40, 60, 80, 100]) {
      expect(renderDocument(AMBIGUOUS_DOC, width)).toBe(renderDocument(AMBIGUOUS_DOC, width, UNICODE_GLYPHS, NARROW_MEASURE));
    }
  });

  /**
   * A wide mode that changes nothing is a wide mode that is not wired up — but the
   * change is **width-sensitive by construction, not present at every width**, and that
   * is worth stating because it is easy to mistake for the feature being dead. A line
   * only renders differently when its extra ambiguous columns push it *across* the
   * target: three em dashes make a line 3 columns wider, so a paragraph 6 columns
   * inside its budget is byte-identical in both modes. Asserting "differs at 60" would
   * therefore be asserting an accident of this fixture. The real claim is that the mode
   * reaches the renderer at all, so it is asserted over a range.
   */
  test("wide mode changes a document that carries ambiguous characters", () => {
    const widths = Array.from({ length: 101 }, (_, index) => 40 + index);
    const changed = widths.filter(
      (width) =>
        renderDocument(AMBIGUOUS_DOC, width, UNICODE_GLYPHS, WIDE_MEASURE) !==
        renderDocument(AMBIGUOUS_DOC, width, UNICODE_GLYPHS, NARROW_MEASURE),
    );
    expect(changed.length).toBeGreaterThan(0);
  });

  // ...and a wide mode that changes a document with no ambiguous characters is a bug.
  test("wide mode is a no-op on a document with no ambiguous characters", () => {
    for (const width of [40, 55, 72, 80, 116]) {
      expect(renderDocument(ASCII_DOC, width, ASCII_GLYPHS, WIDE_MEASURE)).toBe(
        renderDocument(ASCII_DOC, width, ASCII_GLYPHS, NARROW_MEASURE),
      );
    }
  });

  test("no rendered line exceeds the target when measured with the ruler it was allocated with", () => {
    for (const measure of [NARROW_MEASURE, WIDE_MEASURE]) {
      for (const width of [60, 80, 116]) {
        const rendered = renderDocument(AMBIGUOUS_DOC, width, ASCII_GLYPHS, measure);
        for (const line of rendered.split("\n")) expect(measure(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  /**
   * `─` (U+2500) is itself Ambiguous, so a rule built as `repeat(targetWidth - 1)`
   * measures *twice* the document width in wide mode — over budget on every single
   * frontmatter-carrying file. `renderRule` divides by the glyph's measured width for
   * exactly this reason; without it the tool's own divider is its widest line.
   */
  test("the frontmatter divider fits the target width in both modes", () => {
    const doc = "---\ntitle: A document\n---\n\nBody text.\n";
    for (const measure of [NARROW_MEASURE, WIDE_MEASURE]) {
      for (const width of [40, 80, 116]) {
        const rule = renderDocument(doc, width, UNICODE_GLYPHS, measure)
          .split("\n")
          .find((line) => line.startsWith("─")) as string;
        expect(measure(rule)).toBeLessThanOrEqual(width - 1);
        expect(measure(rule)).toBeGreaterThan(width - 3);
      }
    }
  });
});

describe("wide mode and the glyph tier", () => {
  test("narrow mode leaves glyph resolution exactly as it was", () => {
    const utf8 = { LANG: "en_US.UTF-8" };
    expect(resolveGlyphs(utf8, undefined, "narrow")).toBe(resolveGlyphs(utf8));
    expect(resolveGlyphs(utf8, "unicode", "narrow")).toBe(UNICODE_GLYPHS);
    expect(resolveGlyphs({ TERM: "linux" }, undefined, "narrow")).toBe(ASCII_GLYPHS);
  });

  // Arithmetic, not taste: see `wideForcesAscii`'s comment for the measurement.
  test("wide mode forces the ASCII tier, over every other input including --unicode", () => {
    expect(resolveGlyphs({ LANG: "en_US.UTF-8" }, undefined, "wide")).toBe(ASCII_GLYPHS);
    expect(resolveGlyphs({ LANG: "en_US.UTF-8" }, "unicode", "wide")).toBe(ASCII_GLYPHS);
    expect(resolveGlyphs({ MDVIEW_GLYPHS: "unicode" }, undefined, "wide")).toBe(ASCII_GLYPHS);
  });

  test("wideForcesAscii reports only the case a user asked for and did not get", () => {
    expect(wideForcesAscii("unicode", "wide")).toBe(true);
    expect(wideForcesAscii("unicode", "narrow")).toBe(false);
    expect(wideForcesAscii("ascii", "wide")).toBe(false);
    expect(wideForcesAscii(undefined, "wide")).toBe(false);
  });

  /**
   * The finding that forced the rule above, pinned so it cannot regress quietly: with
   * the Unicode tier under wide measurement a table's border row is *exactly twice* the
   * target, because `cli-table3` draws it as one ambiguous `─` per column of cell width
   * and `renderTable`'s re-render loop cannot shrink by its entire budget. With the
   * ASCII tier — the one wide mode actually gets — it fits.
   */
  test("the ASCII tier is the only tier whose tables fit in wide mode", async () => {
    const table = await readFile(join(REPO_ROOT, "tests/fixtures/wide-table.md"), "utf8");
    for (const width of [80, 100]) {
      const unicode = renderDocument(table, width, UNICODE_GLYPHS, WIDE_MEASURE);
      const widestUnicode = Math.max(...unicode.split("\n").map((line) => WIDE_MEASURE(line)));
      expect(widestUnicode).toBe(width * 2);

      const ascii = renderDocument(table, width, ASCII_GLYPHS, WIDE_MEASURE);
      for (const line of ascii.split("\n")) expect(WIDE_MEASURE(line)).toBeLessThanOrEqual(width);
    }
  });
});

// ---------------------------------------------------------------------------
// The command-line surface
// ---------------------------------------------------------------------------

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return chunks.join("");
};

describe("the probe subcommand", () => {
  test("parseArgs recognizes --probe and stops demanding a file", () => {
    expect(parseArgs(["--probe"]).probe).toBe(true);
    expect(parseArgs(["doc.md"]).probe).toBe(false);
  });

  // The report is the deliverable of the user-in-the-loop validation step: the user runs
  // it in urxvt and in ghostty+zellij and pastes the output back. So it has to carry
  // every input the resolution consumed, name the winning rule outright, and never let a
  // cached answer be mistaken for a live measurement.
  test("the report echoes its inputs and names the deciding rule", async () => {
    const env = {
      TERM: "rxvt-unicode-256color",
      COLORTERM: "rgb",
      LANG: "en_US.UTF-8",
      MDVIEW_AMBIGUOUS: "wide",
    };
    const resolution = await resolveAmbiguousWidth({ env, cachePath: join(await scratch(), "cache.json") });
    const report = formatProbeReport(resolution, env);
    expect(report).toContain("rxvt-unicode-256color");
    expect(report).toContain("en_US.UTF-8");
    expect(report).toContain("ambiguous width  wide");
    expect(report).toContain("decided by       env");
    expect(report).toContain(resolution.identity);
    expect(report).toContain(resolution.cachePath);
  });

  test("a cached answer is never presented as a live probe", async () => {
    const path = join(await scratch(), "cache.json");
    const env = { TERM: "xterm-ghostty" };
    await writeCachedAmbiguousWidth(terminalIdentity(env), "wide", path);
    const report = formatProbeReport(await resolveAmbiguousWidth({ env, cachePath: path }), env);
    expect(report).toContain("decided by       cache (NOT a live probe)");
  });

  test("`mdview probe --help` prints the subcommand's own usage", async () => {
    const output = await captureStdout(() => main(["probe", "--help"]));
    expect(output).toContain("usage: mdview probe");
  });

  test("`mdview help probe` prints the same usage", async () => {
    const output = await captureStdout(() => main(["help", "probe"]));
    expect(output).toContain("usage: mdview probe");
  });

  test("`mdview help` lists probe among the subcommands", async () => {
    const output = await captureStdout(() => main(["help"]));
    expect(output).toContain("probe [--refresh]");
    expect(output).toContain("MDVIEW_AMBIGUOUS");
  });

  test("help still refuses an unknown subcommand, now naming probe", async () => {
    await expect(main(["help", "nonsense"])).rejects.toThrow("view, highlight-as, probe, help");
  });

  test("probe rejects an unknown flag", async () => {
    await expect(main(["probe", "--nonsense"])).rejects.toThrow("probe: unknown argument");
  });

  test("probe rejects a nonsense timeout", async () => {
    await expect(main(["probe", "--timeout", "nope"])).rejects.toThrow("--timeout must be a positive number");
  });

  // Under `bun test` stdout is not a TTY, so this exercises the headless path end to
  // end: no probe, no terminal I/O, narrow, and a report that says so.
  //
  // This is the one test in this file that reaches `main`, so it is the one test that
  // reads the real `process.env` instead of an injected `env` — every case above hands
  // `resolveAmbiguousWidth` an explicit object. That makes it the only place the
  // developer's own shell can leak in: with `MDVIEW_AMBIGUOUS=wide` exported, rule 1
  // wins, the report says "wide", and this test fails for a reason that has nothing to
  // do with the code. CI never exports it, so the failure would only ever appear on a
  // maintainer's machine. Scrub the variable for the duration rather than weaken the
  // assertion — determinism regardless of the ambient environment is the property
  // `src/width.ts`'s header claims, and a test that inherits the environment cannot
  // demonstrate it.
  //
  // `XDG_CACHE_HOME` is redirected for the same reason, and that one was found the hard
  // way: `--no-cache` suppresses cache *writes*, not cache *reads*, so once the developer
  // has actually run `mdview probe` on this machine, rule 2 hits, the report says
  // "decided by cache", and the "not a TTY" line this asserts is never printed. The suite
  // was green until the tool was used for real. That is state leaking from the user's
  // home directory into a gate — the precise failure mode `src/width.ts`'s header argues
  // a process-global would cause, arriving instead through a cache file. Point the test
  // at a scratch dir; do not relax the assertion, and do not reach for `--refresh`, which
  // would hide the read path rather than isolate it.
  test("`mdview probe` is safe and honest with no terminal", async () => {
    const savedMode = process.env.MDVIEW_AMBIGUOUS;
    const savedCache = process.env.XDG_CACHE_HOME;
    delete process.env.MDVIEW_AMBIGUOUS;
    process.env.XDG_CACHE_HOME = await scratch();
    try {
      const output = await captureStdout(() => main(["probe", "--no-cache"]));
      expect(output).toContain("ambiguous width  narrow");
      expect(output).toContain("not a TTY");
      expect(output).toContain("Precedence, highest first");
    } finally {
      if (savedMode === undefined) delete process.env.MDVIEW_AMBIGUOUS;
      else process.env.MDVIEW_AMBIGUOUS = savedMode;
      if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedCache;
    }
  });
});
