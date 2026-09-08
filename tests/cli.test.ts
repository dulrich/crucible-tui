import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { main, parseArgs, resolveWidth } from "../src/cli";
import { loadManifest, resolveCorpusFiles } from "../scripts/corpus";
import { BUNDLED_DEFAULT_MANIFEST } from "../src/config";

const fixture = (name: string): string => `${import.meta.dir}/fixtures/${name}`;

// Control bytes are built, never pasted — matching src/ansi.ts's own convention and
// tests/ansi.test.ts's: a literal ESC or BEL in a source file is invisible in every
// editor and every diff.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/**
 * Set/restore one or more `process.env` variables around a run, matching the pattern
 * `tests/width.test.ts`'s `mdview probe` test already established: scrub or set for the
 * duration, restore exactly (including "was absent") afterward, whatever the run does or
 * throws. `undefined` in `vars` means "delete this variable for the duration."
 */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Capture both stdout and stderr for the duration of `run`, restoring both after. */
async function captureIO(run: () => Promise<void>): Promise<{ stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: outChunks.join(""), stderr: errChunks.join("") };
}

describe("resolveWidth", () => {
  test("explicit width wins over columns and fallback", () => {
    expect(resolveWidth(72, 200)).toBe(72);
  });

  test("terminal columns win over the fallback when width is not explicit", () => {
    expect(resolveWidth(undefined, 132)).toBe(132);
  });

  test("falls back to 100 when neither explicit width nor columns are available", () => {
    expect(resolveWidth(undefined, undefined)).toBe(100);
  });

  test("ignores a non-positive column count and falls back", () => {
    expect(resolveWidth(undefined, 0)).toBe(100);
  });
});

describe("parseArgs", () => {
  test("parses the positional file and defaults", () => {
    const options = parseArgs(["doc.md"]);
    expect(options).toEqual({
      file: "doc.md",
      width: undefined,
      noPager: false,
      check: false,
      help: false,
      licenses: false,
      probe: false,
      color: undefined,
      hyperlinks: undefined,
      plain: false,
    });
  });

  /**
   * `--color`, the highest slot in the colour precedence table (`src/colour.ts`).
   *
   * **mdview's own flag is the only argv authority now, and that is the user-visible half
   * of WP-1 of `plans/colour-policy.md`.** Until this package `supports-color` scanned the
   * whole of `process.argv` through `has-flag`, so `--color`, `--no-color` and
   * `--color=256` all changed rendered output without this parser ever seeing them — and a
   * `--color` aimed at the `bun` wrapper worked just as well as one aimed at mdview.
   */
  describe("--color", () => {
    test("bare --color means always: a user who typed it is asking for colour", () => {
      expect(parseArgs(["doc.md", "--color"]).color).toBe("always");
    });

    test("each explicit value parses as itself", () => {
      expect(parseArgs(["doc.md", "--color=auto"]).color).toBe("auto");
      expect(parseArgs(["doc.md", "--color=always"]).color).toBe("always");
      expect(parseArgs(["doc.md", "--color=never"]).color).toBe("never");
    });

    test("repeated, the last one wins — in both directions", () => {
      expect(parseArgs(["doc.md", "--color=never", "--color"]).color).toBe("always");
      expect(parseArgs(["doc.md", "--color=always", "--color=never"]).color).toBe("never");
    });

    test("an unrecognised value is a CLI error naming the three it accepts", () => {
      // Deliberately unlike `MDVIEW_COLOR=sometimes`, which is noted and ignored: a typo on
      // the command line is being made right now and can be corrected right now, where a
      // typo in an exported variable would otherwise refuse every document for the rest of
      // that shell's life.
      expect(() => parseArgs(["doc.md", "--color=sometimes"])).toThrow(/--color must be auto, always or never/);
      expect(() => parseArgs(["doc.md", "--color="])).toThrow(/--color must be/);
    });

    test("the value is never taken from the next argument, so the file is still the file", () => {
      // `--color never doc.md` cannot mean what it looks like: the flag has to work with no
      // value at all, so a following word is a positional argument, not this flag's value.
      expect(() => parseArgs(["doc.md", "--color", "never"])).toThrow(/unexpected extra argument: never/);
      const options = parseArgs(["--color", "doc.md"]);
      expect(options.color).toBe("always");
      expect(options.file).toBe("doc.md");
    });

    test("absent means absent — not 'auto' typed by the user", () => {
      expect(parseArgs(["doc.md"]).color).toBeUndefined();
    });
  });

  /**
   * `--no-color` (WP-3 of `plans/colour-modes.md`): an alias for `--color=never`, landing
   * in the very same `color` field. **This used to be rejected outright** — the ratified
   * surface was `--color=never` alone, and the test asserting that lived here until this
   * WP added the alias on its own authority (Decision-adjacent, not Decision 1-8 numbered,
   * but the plan's WP-3 text names it explicitly). It is not a second field: the whole
   * point is that nothing downstream of `parseArgs` can see two colour flags disagreeing.
   */
  describe("--no-color", () => {
    test("is an alias for --color=never, landing in the same field", () => {
      expect(parseArgs(["doc.md", "--no-color"]).color).toBe("never");
    });

    test("takes no value — it is a bare flag, unlike --color", () => {
      expect(() => parseArgs(["doc.md", "--no-color=never"])).toThrow(/unknown argument: --no-color=never/);
    });

    test("last-wins against --color, in both directions, exactly as --color=X --color=Y already does", () => {
      expect(parseArgs(["doc.md", "--color=always", "--no-color"]).color).toBe("never");
      expect(parseArgs(["doc.md", "--no-color", "--color=always"]).color).toBe("always");
    });
  });

  /**
   * `--plain` (Decision 2): a bare boolean, absolute and explicit. No `=WHEN` form — see
   * `runView`'s own construction (exercised below, under "main — --plain") for what it does
   * beyond parsing: the CLI-boundary short-circuit around `resolveColourPolicy` entirely.
   */
  describe("--plain", () => {
    test("is recognized and defaults to false", () => {
      expect(parseArgs(["doc.md", "--plain"]).plain).toBe(true);
      expect(parseArgs(["doc.md"]).plain).toBe(false);
    });

    test("takes no value", () => {
      expect(() => parseArgs(["doc.md", "--plain=true"])).toThrow(/unknown argument: --plain=true/);
    });

    test("coexists with --color and --hyperlinks at the parse level — parseArgs never adjudicates, only runView does", () => {
      // parseArgs is a pure recorder of what was typed; the short-circuit that makes
      // --plain override everything else lives in `runView`, not here. See "main —
      // --plain" below for the behavioural half of this claim.
      const options = parseArgs(["doc.md", "--plain", "--color=always", "--hyperlinks=always"]);
      expect(options.plain).toBe(true);
      expect(options.color).toBe("always");
      expect(options.hyperlinks).toBe("always");
    });
  });

  /**
   * `--hyperlinks[=WHEN]` (Decision 6): `--color`'s own conventions, transplanted onto the
   * independent hyperlink axis. The precedence itself — non-TTY ceiling, then this flag,
   * then `MDVIEW_HYPERLINKS`, then config, then terminal detection — is `resolveHyperlinks`'s
   * and is covered directly in `tests/colour.test.ts`; these cases are parsing only.
   */
  describe("--hyperlinks", () => {
    test("bare --hyperlinks means always", () => {
      expect(parseArgs(["doc.md", "--hyperlinks"]).hyperlinks).toBe("always");
    });

    test("each explicit value parses as itself", () => {
      expect(parseArgs(["doc.md", "--hyperlinks=auto"]).hyperlinks).toBe("auto");
      expect(parseArgs(["doc.md", "--hyperlinks=always"]).hyperlinks).toBe("always");
      expect(parseArgs(["doc.md", "--hyperlinks=never"]).hyperlinks).toBe("never");
    });

    test("repeated, the last one wins — in both directions", () => {
      expect(parseArgs(["doc.md", "--hyperlinks=never", "--hyperlinks"]).hyperlinks).toBe("always");
      expect(parseArgs(["doc.md", "--hyperlinks=always", "--hyperlinks=never"]).hyperlinks).toBe("never");
    });

    test("an unrecognised value is a CLI error naming the three it accepts", () => {
      expect(() => parseArgs(["doc.md", "--hyperlinks=sometimes"])).toThrow(
        /--hyperlinks must be auto, always or never/,
      );
    });

    test("absent means absent, independent of --color", () => {
      expect(parseArgs(["doc.md", "--color=always"]).hyperlinks).toBeUndefined();
      expect(parseArgs(["doc.md"]).hyperlinks).toBeUndefined();
    });

    test("--color and --hyperlinks are independent fields — a conflicting pair parses fine", () => {
      // The conflict is adjudicated downstream, through one input object
      // (`resolveColourPolicy`'s `flag`/`hyperlinkFlag`), not rejected here.
      const options = parseArgs(["doc.md", "--color=always", "--hyperlinks=never"]);
      expect(options.color).toBe("always");
      expect(options.hyperlinks).toBe("never");
    });
  });

  test("recognizes --width", () => {
    expect(parseArgs(["doc.md", "--width", "80"]).width).toBe(80);
  });

  test("recognizes --no-pager", () => {
    expect(parseArgs(["doc.md", "--no-pager"]).noPager).toBe(true);
  });

  test("recognizes --check", () => {
    expect(parseArgs(["doc.md", "--check"]).check).toBe(true);
  });

  test("recognizes --help and -h without requiring a file", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("rejects an unknown flag with a clear error", () => {
    expect(() => parseArgs(["doc.md", "--bogus"])).toThrow("unknown argument: --bogus");
  });

  test("rejects a missing positional file", () => {
    expect(() => parseArgs(["--width", "80"])).toThrow("missing required argument");
  });

  test("rejects --width with no value", () => {
    expect(() => parseArgs(["doc.md", "--width"])).toThrow("missing value for --width");
  });
});

describe("main", () => {
  test("--help prints usage and exits zero (resolves without throwing)", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main(["--help"]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("usage: mdview");
  });

  test("renders fixtures/simple.md with --no-pager without throwing", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await main([fixture("simple.md"), "--no-pager"]);
    } finally {
      process.stdout.write = original;
    }

    expect(chunks.join("")).toContain("Simple fixture");
  });

  test("a missing file path throws a readable error", async () => {
    await expect(main([fixture("does-not-exist.md"), "--no-pager"])).rejects.toThrow(
      "cannot read file",
    );
  });
});

/**
 * `--no-color`, `--plain` and `--hyperlinks` at the `main` level (WP-3 of
 * `plans/colour-modes.md`). Everything above this point exercises `parseArgs` in
 * isolation; these exercise `runView`'s own construction — the `--no-color` alias
 * reaching the same route WP-2 already landed bytes for, and Decision 2's CLI-boundary
 * short-circuit around `resolveColourPolicy` under `--plain`.
 */
describe("main — --no-color / --plain", () => {
  test("--no-color renders byte-identical to --color=never — the same route by two spellings (Decision 5)", async () => {
    // Neither call sets FORCE_COLOR/NO_COLOR/MDVIEW_COLOR, so the only thing deciding the
    // colour mode is the flag itself — the case the alias claim is actually about.
    const viaNoColor = await captureIO(() => main([fixture("tight-list.md"), "--no-pager", "--no-color"]));
    const viaColorNever = await captureIO(() => main([fixture("tight-list.md"), "--no-pager", "--color=never"]));
    expect(viaNoColor.stdout).toBe(viaColorNever.stdout);
    // Non-vacuous: `never` is `formats`, not `none` — the reset framing (Decision 8) still
    // wraps every paragraph and list item, so both renders carry ESC bytes.
    expect(viaNoColor.stdout).toContain(String.fromCharCode(27));
  });

  test("--plain: a malformed MDVIEW_COLOR produces no stderr warning — the CLI-boundary short-circuit (Decision 2)", async () => {
    const { stderr } = await withEnv({ MDVIEW_COLOR: "sometimes" }, () =>
      captureIO(() => main([fixture("simple.md"), "--no-pager", "--plain"])),
    );
    expect(stderr).toBe("");
  });

  test("the same malformed MDVIEW_COLOR, without --plain, does warn — the non-vacuity control for the case above", async () => {
    const { stderr } = await withEnv({ MDVIEW_COLOR: "sometimes" }, () =>
      captureIO(() => main([fixture("simple.md"), "--no-pager"])),
    );
    expect(stderr).toContain("MDVIEW_COLOR");
  });

  test("--plain: a malformed MDVIEW_HYPERLINKS produces no stderr warning, even on a terminal where it would otherwise be read", async () => {
    // `resolveHyperlinks`'s non-TTY ceiling is checked *before* `MDVIEW_HYPERLINKS` is ever
    // read, so this case is vacuous unless stdout is (made to look like) a terminal — the
    // one deliberate `isTTY` fake in this file, restored in `finally` regardless of outcome.
    const stdout = process.stdout as unknown as { isTTY?: boolean };
    const savedIsTTY = stdout.isTTY;
    stdout.isTTY = true;
    try {
      const { stderr } = await withEnv({ MDVIEW_HYPERLINKS: "maybe" }, () =>
        captureIO(() => main([fixture("simple.md"), "--no-pager", "--plain"])),
      );
      expect(stderr).toBe("");
    } finally {
      stdout.isTTY = savedIsTTY;
    }
  });

  test("the same malformed MDVIEW_HYPERLINKS, without --plain, does warn on a terminal — the control", async () => {
    const stdout = process.stdout as unknown as { isTTY?: boolean };
    const savedIsTTY = stdout.isTTY;
    stdout.isTTY = true;
    try {
      const { stderr } = await withEnv({ MDVIEW_HYPERLINKS: "maybe" }, () =>
        captureIO(() => main([fixture("simple.md"), "--no-pager"])),
      );
      expect(stderr).toContain("MDVIEW_HYPERLINKS");
    } finally {
      stdout.isTTY = savedIsTTY;
    }
  });

  test("--plain overrides forced colour and forced hyperlinks, and is byte-identical to none+no-links (Decision 2)", async () => {
    const stdout = process.stdout as unknown as { isTTY?: boolean };
    const savedIsTTY = stdout.isTTY;
    stdout.isTTY = true;
    try {
      const forcedFull = await withEnv({ FORCE_COLOR: "3", MDVIEW_HYPERLINKS: "always" }, () =>
        captureIO(() => main([fixture("tight-list.md"), "--no-pager"])),
      );
      // Non-vacuous: the forced environment, without --plain, really did produce colour.
      expect(forcedFull.stdout).toContain(String.fromCharCode(27));

      const plain = await withEnv({ FORCE_COLOR: "3", MDVIEW_HYPERLINKS: "always" }, () =>
        captureIO(() => main([fixture("tight-list.md"), "--no-pager", "--plain"])),
      );
      expect(plain.stdout).not.toContain(String.fromCharCode(27));

      // NO_COLOR outranks FORCE_COLOR (`resolveColor`'s own precedence), so this reaches
      // `sgr: "none"` even with FORCE_COLOR=3 still set — and MDVIEW_HYPERLINKS=never turns
      // the other axis off explicitly, through the ordinary resolvers rather than the
      // short-circuit. If these two renders differ, `--plain` moved a byte no plan
      // authorized on some path other than the one this test isolates.
      const noneNoLinks = await withEnv(
        { FORCE_COLOR: "3", NO_COLOR: "1", MDVIEW_HYPERLINKS: "never" },
        () => captureIO(() => main([fixture("tight-list.md"), "--no-pager"])),
      );
      expect(plain.stdout).toBe(noneNoLinks.stdout);
    } finally {
      stdout.isTTY = savedIsTTY;
    }
  });
});

/**
 * The brief's own item 7 opens: "`--plain` ≡ `none`+no-links **byte-equivalence** on
 * escape-bearing synthetics (authored SGR, OSC-8, DCS, malformed CSI, lone ESC) and the
 * gate corpus files." The describe block above covers the equivalence on one styled
 * fixture (`tight-list.md`, forced via `FORCE_COLOR`/`MDVIEW_HYPERLINKS`); it does not
 * cover authored escape bytes surviving *through* the equivalence, and it does not cover
 * the corpus. Both gaps are closed here — flagged in orchestrator review against the
 * first pass of this WP, recorded in the report rather than silently folded in.
 *
 * Temp files only, per the brief's constraint: the gate corpus is a fixed, exact-set,
 * wildcard-free manifest (`plans/gate-corpus-reframe.md`) and nothing may be added to it
 * to build these cases; the synthetic document is written to a scratch directory and
 * never touches `tests/fixtures/`.
 */
describe("main — --plain byte-equivalence, extended: escape-bearing synthetics and the gate corpus", () => {
  async function withTempFile<T>(name: string, content: string, run: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "mdview-cli-plain-test-"));
    try {
      const path = join(dir, name);
      await writeFile(path, content, "utf8");
      return await run(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("--plain is byte-identical to none+no-links on a document carrying all five escape-bearing forms (Decision 2)", async () => {
    // One tight paragraph, all five forms: authored SGR, an authored OSC-8 pair, an
    // authored DCS sequence, a malformed (non-SGR) CSI, and a lone ESC. A bare "u" OSC-8
    // destination rather than a real URL, matching tests/ansi.test.ts's own synthetics,
    // so GFM autolinking is never a variable here; no `]` or backslash-then-punctuation
    // appears anywhere, so CommonMark's own escape/link syntax never reinterprets a
    // byte. Rendered at a width comfortably wider than the one visible line, so no wrap
    // boundary is ever near an escape sequence — `src/wrap.ts` is span-native either way
    // (WP-3 of `plans/colour-policy.md`), but this keeps the case about Decision 2 alone.
    const synthetic =
      `Escapes: sgr ${ESC}[31mred${ESC}[39m and osc8 ${ESC}]8;;u${BEL}label${ESC}]8;;${BEL} ` +
      `and dcs ${ESC}Pdata${ESC}\\then and csi ${ESC}[2Jhere and lone a${ESC}b end.\n`;

    await withTempFile("synthetic.md", synthetic, async (path) => {
      const plain = await captureIO(() => main([path, "--no-pager", "--width", "200", "--plain"]));
      const noneNoLinks = await withEnv({ NO_COLOR: "1", MDVIEW_HYPERLINKS: "never" }, () =>
        captureIO(() => main([path, "--no-pager", "--width", "200"])),
      );
      expect(plain.stdout).toBe(noneNoLinks.stdout);

      // Non-vacuous, and the fidelity half of Decision 2 (cycle-2 f6): every authored
      // sequence reached the output unmoved and unmodified — content is never this
      // tool's to strip, at any colour mode including --plain.
      expect(plain.stdout).toContain(`${ESC}[31mred${ESC}[39m`);
      expect(plain.stdout).toContain(`${ESC}]8;;u${BEL}label${ESC}]8;;${BEL}`);
      expect(plain.stdout).toContain(`${ESC}Pdata${ESC}\\`);
      expect(plain.stdout).toContain(`${ESC}[2J`);
      expect(plain.stdout).toContain(`a${ESC}b`);
    });
  });

  test("--plain is byte-identical to none+no-links on every gate corpus file, at one width", async () => {
    // The bundled manifest's "repo" corpus — the same 14 files `bun run sweep` reports
    // as `files=14` — resolved the way `tests/gate-corpus.test.ts` does, never by
    // re-listing paths here: the gate corpus is a fixed exact set and this test must not
    // be able to drift from it.
    const manifest = await loadManifest(BUNDLED_DEFAULT_MANIFEST);
    const spec = manifest.corpora.find((corpus) => corpus.name === "repo");
    if (!spec) throw new Error('bundled manifest has no "repo" corpus');
    const files = await resolveCorpusFiles(spec, {});
    expect(files).not.toBeNull();
    expect((files as string[]).length).toBe(14);

    for (const file of files as string[]) {
      const plain = await captureIO(() => main([file, "--no-pager", "--width", "100", "--plain"]));
      const noneNoLinks = await withEnv({ NO_COLOR: "1", MDVIEW_HYPERLINKS: "never" }, () =>
        captureIO(() => main([file, "--no-pager", "--width", "100"])),
      );
      expect(plain.stdout).toBe(noneNoLinks.stdout);
    }
  });
});

/**
 * **Wiki-links become `file://` hyperlinks on the existing `--hyperlinks` axis** — WP-2 of
 * `plans/follow-wiki-links.md`, at the one boundary that builds a resolver at all.
 *
 * `src/cli.ts` is the only place the filesystem is consulted for a wiki-link's target (D6):
 * it builds `createWikiLinkResolver(resolve(options.file))` **only** when the resolved policy
 * has hyperlinks on, so there is no second gate that could disagree with `renderLink`'s. The
 * three runs below are that one decision seen from both sides.
 *
 * The tree is built under `os.tmpdir()` with `mkdtemp`, never spelled as a literal path — the
 * publication guard (`tests/helpers/containment.ts`) forbids a home-path or sibling-directory
 * name in tracked content, and a vault-root test has to name a root somewhere.
 */
describe("main — following wiki-links (--hyperlinks)", () => {
  /** `<tmp>/.git/` + `note.md` (containing `[[target]]`) + `target.md`, cleaned up after. */
  async function withVault<T>(run: (notePath: string, dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "mdview-cli-wikilink-test-"));
    try {
      // `.git` is what makes this directory a vault root under D1 — the nearest ancestor
      // holding `.obsidian` or `.git` — so the resolution is scoped to the temp tree and
      // can never reach the checkout this suite runs in.
      await mkdir(join(dir, ".git"));
      const notePath = join(dir, "note.md");
      await writeFile(notePath, "See [[target]] now.\n", "utf8");
      await writeFile(join(dir, "target.md"), "# Target\n", "utf8");
      return await run(notePath, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("--plain and --hyperlinks=never emit no OSC-8 for a resolving wiki-link", async () => {
    await withVault(async (notePath) => {
      const plain = await captureIO(() => main([notePath, "--no-pager", "--plain"]));
      expect(plain.stdout).not.toContain(`${ESC}]8`);
      expect(plain.stdout).toContain("See target now.");

      // Colour forced *on* and hyperlinks off: the two axes are independent, so this is the
      // run that shows the link is gated by the hyperlink axis alone and not by colour.
      const never = await captureIO(() =>
        main([notePath, "--no-pager", "--hyperlinks=never", "--color=always"]),
      );
      expect(never.stdout).not.toContain(`${ESC}]8`);
      expect(never.stdout).toContain("target");
    });
  });

  test("--hyperlinks=always on a TTY links the label to the target's file:// URI", async () => {
    await withVault(async (notePath) => {
      // **The non-TTY ceiling outranks `--hyperlinks=always`** (`src/colour.ts`), so without
      // this the flag decides nothing and the assertion below would be unreachable. Saved and
      // restored exactly, including "was absent", like every other process-state test here.
      const savedIsTTY = process.stdout.isTTY;
      let output: string;
      try {
        process.stdout.isTTY = true;
        output = (
          await captureIO(() => main([notePath, "--no-pager", "--hyperlinks=always", "--color=always"]))
        ).stdout;
      } finally {
        process.stdout.isTTY = savedIsTTY;
      }

      expect(output).toContain(`${ESC}]8;;file://`);
      const destination = output.slice(output.indexOf(`${ESC}]8;;`) + 5, output.indexOf(BEL));
      expect(destination.startsWith("file:///")).toBe(true);
      // The resolver found the sibling note, not the note being viewed: the destination is
      // `target.md` under the same temp root. The path is percent-encoded by
      // `src/wikiresolve.ts`, and `mkdtemp`'s own suffix is unreserved, so it survives literal.
      expect(destination.endsWith("/target.md")).toBe(true);
      expect(output).toContain("target");
    });
  });

  test("a slug naming nothing is left alone, on the same TTY run that links a resolving one", async () => {
    await withVault(async (notePath, dir) => {
      await writeFile(join(dir, "note.md"), "See [[target]] and [[nowhere]].\n", "utf8");
      const savedIsTTY = process.stdout.isTTY;
      let output: string;
      try {
        process.stdout.isTTY = true;
        output = (
          await captureIO(() => main([notePath, "--no-pager", "--hyperlinks=always", "--color=always"]))
        ).stdout;
      } finally {
        process.stdout.isTTY = savedIsTTY;
      }

      // Exactly one pair — one open and one close — for the one slug that resolves (D3).
      expect(output.split(`${ESC}]8;;`).length - 1).toBe(2);
      expect(output).toContain("nowhere");
    });
  });
});
