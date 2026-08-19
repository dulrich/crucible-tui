import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  classifyColourAxis,
  collectColourDigests,
  colourChildEnv,
  digestText,
  parseColourDigestStreams,
  runColourAxis,
  type ColourDigestStream,
} from "../scripts/corpus";

/**
 * The colour axis (WP-1, `plans/own-the-token-walk.md`).
 *
 * **The load-bearing test in this file is the first one.** A colour axis whose two
 * children silently resolve the *same* mode is a gate that cannot fail — the shape root
 * `AGENTS.md`'s "Flag order matters" paragraph names as worse than no gate at all — and
 * nothing about the environment we intended to set can rule it out, because the colour
 * decision is made by three separate packages at module load. So the assertion is on
 * **observed rendered output**: SGR present in one child's renders and absent from the
 * other's, for the same file at the same width.
 *
 * Everything here spawns subprocesses for the reason `tests/helpers/color.ts:15-46`
 * records: Bun's module cache is shared across a whole `bun test` run, so a module that
 * resolves its colour decision at load has already resolved by the time any test executes,
 * and no in-process mutation of `FORCE_COLOR` can move it. **The renderer's own decision is
 * no longer one of those** — WP-1 of `plans/colour-policy.md` made it a per-call
 * resolution over an explicit input — but `cli-highlight`'s bundled `chalk` and
 * `@colors/colors` still are, and both put styling into rendered output, so the digests
 * this file compares still have to come from two processes. WP-2 retires the last two.
 */

let dir: string;
let manifest: string;

/** A paragraph whose only styling is emphasis: coloured or not, the characters match. */
const PLAIN =
  "Some **bold** text in a plain paragraph, long enough that it has to wrap at forty " +
  "columns and not at a hundred, which is what makes the width axis observable.\n";
/**
 * A wiki link. `styleWikiLink` (`src/render.ts:62-65`) hardcodes `\x1b[36m\x1b[4m` and
 * consults no colour decision at all, so this file carries SGR **even in a colourless
 * render** — it is the producer this axis exists to make visible. Out of scope to repair
 * here (the successor plan owns it); in scope to measure.
 */
const WIKI = "A paragraph with a [[wiki-link]] in it.\n";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mdview-colour-axis-"));
  await writeFile(join(dir, "plain.md"), PLAIN);
  await writeFile(join(dir, "wiki.md"), WIKI);
  manifest = join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      generated: "2026-08-17T00:00:00Z",
      generator: "tests/colour-axis.test.ts",
      corpora: [{ name: "probe", root: ".", globs: ["*.md"] }],
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const argsFor = (widths: string): string[] => ["--manifest", manifest, "--widths", widths];

const digestFor = (stream: ColourDigestStream, name: string, width: number) => {
  const found = stream.digests.find((entry) => entry.path.endsWith(`/${name}`) && entry.width === width);
  if (!found) throw new Error(`no digest for ${name} at width ${width}`);
  return found;
};

describe("the two children resolve opposite colour modes (WP-1)", () => {
  test("the same file renders with SGR in one child and without it in the other", async () => {
    const args = argsFor("40,80");
    const [colour, colourless] = await Promise.all([
      collectColourDigests("on", args),
      collectColourDigests("off", args),
    ]);

    const on = colour[0];
    const off = colourless[0];
    expect(on?.corpus).toBe("probe");
    expect(off?.corpus).toBe("probe");
    expect(on?.digests.length).toBe(4);
    expect(off?.digests.length).toBe(4);

    // Observed output, not intended environment: every render in the colour child carries
    // SGR, and the plain paragraph in the colourless child carries none.
    expect(on!.digests.every((entry) => entry.hasSgr)).toBe(true);
    expect(digestFor(off!, "plain.md", 40).hasSgr).toBe(false);
    expect(digestFor(off!, "plain.md", 80).hasSgr).toBe(false);

    // And the invariant this whole instrument exists for, holding on that file: different
    // bytes, identical characters.
    expect(digestFor(on!, "plain.md", 80).strippedSha).toBe(digestFor(off!, "plain.md", 80).strippedSha);
  });

  test("an ambient FORCE_COLOR/NO_COLOR/MDVIEW_COLOR cannot decide either child", async () => {
    // The failure this guards is a developer or CI runner with one of these exported: both
    // children would inherit it, both would resolve the same mode, and the axis would
    // report a clean sheet forever. `colourChildEnv` decides all three on both children, so
    // the ambient values below must not reach either render.
    //
    // **`MDVIEW_COLOR` joined the list at WP-1 of `plans/colour-policy.md`, and it is the
    // most dangerous of the three**: it sits *above* `NO_COLOR`, which sits above
    // `FORCE_COLOR`, so an ambient `MDVIEW_COLOR=never` would flatten the whole axis on its
    // own. The assertions are on **observed rendered output**, not on the environment we
    // intended to set.
    const saved = {
      force: process.env.FORCE_COLOR,
      no: process.env.NO_COLOR,
      mdview: process.env.MDVIEW_COLOR,
    };
    try {
      process.env.FORCE_COLOR = "0";
      process.env.NO_COLOR = "1";
      process.env.MDVIEW_COLOR = "never";
      const [colour] = await collectColourDigests("on", argsFor("80"));
      expect(digestFor(colour!, "plain.md", 80).hasSgr).toBe(true);

      process.env.FORCE_COLOR = "3";
      delete process.env.NO_COLOR;
      process.env.MDVIEW_COLOR = "always";
      const [colourless] = await collectColourDigests("off", argsFor("80"));
      expect(digestFor(colourless!, "plain.md", 80).hasSgr).toBe(false);
    } finally {
      for (const [key, value] of [
        ["FORCE_COLOR", saved.force],
        ["NO_COLOR", saved.no],
        ["MDVIEW_COLOR", saved.mdview],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("colourChildEnv pins the mode and sanitizes what outranks it, mutating nothing", () => {
    const base = {
      PATH: "/usr/bin",
      FORCE_COLOR: "1",
      NO_COLOR: "1",
      MDVIEW_COLOR: "never",
      MDVIEW_CORPUS_MANIFEST: "/m.json",
    };
    const on = colourChildEnv("on", base);
    const off = colourChildEnv("off", base);
    expect(on.FORCE_COLOR).toBe("3");
    expect(off.FORCE_COLOR).toBe("0");
    for (const env of [on, off]) {
      expect("NO_COLOR" in env).toBe(false);
      expect("MDVIEW_COLOR" in env).toBe(false);
    }
    // The corpus manifest is *not* sanitized away: the child has to resolve the same
    // population the parent did.
    expect(on.MDVIEW_CORPUS_MANIFEST).toBe("/m.json");
    expect(base.NO_COLOR).toBe("1");
    expect(base.FORCE_COLOR).toBe("1");
    expect(base.MDVIEW_COLOR).toBe("never");
  });
});

describe("the width axis is real, not five copies of one render (WP-1)", () => {
  test("the same file digests differently at two widths, in the same colour mode", async () => {
    // **This is the trap that has invalidated this measurement four times across three
    // authors.** `renderDocumentDetailed(source, targetWidth, ...)` takes its width as a
    // **positional number** (`src/render.ts:776-782`); hand it an options object and every
    // width renders identically, every count comes out an exact multiple of the width
    // count, and the axis reports a number about nothing. Nothing in the type system
    // catches it and no other gate here would notice, so it is asserted directly: a
    // paragraph long enough to wrap has to produce different characters at 40 than at 100.
    const [colourless] = await collectColourDigests("off", argsFor("40,100"));
    const narrow = digestFor(colourless!, "plain.md", 40);
    const wide = digestFor(colourless!, "plain.md", 100);
    expect(narrow.strippedSha).not.toBe(wide.strippedSha);
  });
});

describe("runColourAxis: the end-to-end join over a manifest corpus", () => {
  test("the wiki-link producer lands in SGR-only, and the plain paragraph in identical", async () => {
    const [axis] = await runColourAxis(argsFor("40,80"));
    expect(axis?.corpus).toBe("probe");
    expect(axis?.combos).toBe(4);
    expect(axis?.errors).toEqual([]);
    // `wiki.md` at both widths: same characters, SGR in the colourless render.
    expect(axis?.sgrOnly).toBe(2);
    expect(axis?.identical).toBe(2);
    expect(axis?.charDiffOnly).toBe(0);
    expect(axis?.both).toBe(0);
    expect(axis?.sgrAny).toBe(2);
    expect(axis?.charDiff).toBe(0);
  });
});

describe("--colour-mode on: the sweep itself, re-exec'd in colour (WP-1)", () => {
  test("it runs the ordinary sweep in a colour child and reports the same corpus", async () => {
    // The re-exec is the only way to sweep in colour at all — the colour decision is made
    // before this process's first import — so it is exercised rather than assumed. What is
    // asserted is the ordinary sweep contract, unchanged: the corpus line, and exit 0.
    const proc = Bun.spawn(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "../scripts/sweep.ts"),
        "--manifest",
        manifest,
        "--widths",
        "80",
        "--colour-mode",
        "on",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[probe] files=2 combos=2 overflow=0 errors=0");
    // It is the sweep, not the axis: no bucket line is printed. (Matched on the printed
    // line's shape, not the bare word — the temp manifest's own path contains it.)
    expect(stdout).not.toContain("] colour-axis combos=");
  });
});

describe("classifyColourAxis: three buckets, and the totals the ratchets read", () => {
  const digest = (path: string, width: number, sha: string, hasSgr: boolean) => ({
    corpus: "c",
    path,
    width,
    strippedSha: sha,
    hasSgr,
  });
  const stream = (digests: ReturnType<typeof digest>[]): ColourDigestStream => ({
    corpus: "c",
    digests,
    errors: [],
  });

  test("every combo lands in exactly one bucket, and the totals overlap on purpose", () => {
    const colour = stream([
      digest("/a.md", 80, "same", true),
      digest("/b.md", 80, "same", true),
      digest("/c.md", 80, "left", true),
      digest("/d.md", 80, "left", true),
    ]);
    const colourless = stream([
      // same characters, no SGR — the invariant holding
      digest("/a.md", 80, "same", false),
      // same characters, SGR present — SGR-only
      digest("/b.md", 80, "same", true),
      // different characters, no SGR — character difference only
      digest("/c.md", 80, "right", false),
      // different characters AND SGR — both
      digest("/d.md", 80, "right", true),
    ]);

    const axis = classifyColourAxis("c", colour, colourless, 1.5);
    expect(axis.combos).toBe(4);
    expect(axis.identical).toBe(1);
    expect(axis.sgrOnly).toBe(1);
    expect(axis.charDiffOnly).toBe(1);
    expect(axis.both).toBe(1);
    // The two ratchet totals each include `both`. That is the whole finding behind this
    // package: the disjoint `sgrOnly` bucket cannot see unwanted SGR in a combo that also
    // differs in characters, and a ratchet reading it would miss roughly half of them.
    expect(axis.charDiff).toBe(2);
    expect(axis.sgrAny).toBe(2);
    expect(axis.elapsedSeconds).toBe(1.5);
  });

  test("SGR is judged on the colourless side only", () => {
    // Colour in a colour render is the point; only colour in a render that asked for
    // none is a defect. A combo whose *colour* side has SGR and whose colourless side
    // does not is the invariant holding, not a hit.
    const axis = classifyColourAxis(
      "c",
      stream([digest("/a.md", 80, "same", true)]),
      stream([digest("/a.md", 80, "same", false)]),
      0,
    );
    expect(axis.identical).toBe(1);
    expect(axis.sgrAny).toBe(0);
  });

  test("an unpaired combo is an error, not a silent drop from the denominator", () => {
    const axis = classifyColourAxis(
      "c",
      stream([digest("/a.md", 80, "same", true), digest("/only-on.md", 80, "x", true)]),
      stream([digest("/a.md", 80, "same", false), digest("/only-off.md", 80, "y", false)]),
      0,
    );
    expect(axis.combos).toBe(1);
    expect(axis.errors.map((entry) => entry.path).sort()).toEqual(["/only-off.md", "/only-on.md"]);
    expect(axis.errors.map((entry) => entry.message).sort()).toEqual([
      "present in the colour stream but missing from the colourless stream",
      "present in the colourless stream but missing from the colour stream",
    ]);
  });

  test("a child's render error is carried through, tagged with the mode it came from", () => {
    const axis = classifyColourAxis(
      "c",
      { corpus: "c", digests: [], errors: [{ corpus: "c", path: "/a.md", width: 80, message: "width 80: boom" }] },
      { corpus: "c", digests: [], errors: [] },
      0,
    );
    expect(axis.errors).toEqual([
      { corpus: "c", path: "/a.md", width: 80, message: "colour-on width 80: boom" },
    ]);
  });

  test("a missing stream is an empty one, not a crash", () => {
    const axis = classifyColourAxis("c", undefined, undefined, 0);
    expect(axis.combos).toBe(0);
    expect(axis.errors).toEqual([]);
  });
});

describe("digestText: the character channel and the SGR flag", () => {
  test("the sha is of the stripped text, so colour cannot move it", () => {
    const plain = digestText("bold text");
    const styled = digestText("\u001b[1mbold\u001b[22m text");
    expect(styled.strippedSha).toBe(plain.strippedSha);
    expect(styled.hasSgr).toBe(true);
    expect(plain.hasSgr).toBe(false);
  });

  test("an OSC-8 hyperlink is not SGR, and this instrument does not claim to see it", () => {
    // `stripAnsi` (`src/list-lines.ts`) removes SGR only. `src/inline.ts` emits OSC-8
    // hyperlinks independently of the colour decision, so they are deliberately outside
    // what this axis measures — recorded in the plan, not a gap to close here.
    const link = digestText("\u001b]8;;https://example.com\u0007text\u001b]8;;\u0007");
    expect(link.hasSgr).toBe(false);
  });
});

describe("parseColourDigestStreams: the child's wire format", () => {
  test("digests, errors and empty corpora are all recoverable, in first-seen order", () => {
    const streams = parseColourDigestStreams(
      [
        JSON.stringify({ corpus: "a", begin: true }),
        JSON.stringify({ corpus: "a", path: "/x.md", width: 80, strippedSha: "sha", hasSgr: true }),
        JSON.stringify({ corpus: "a", path: "/y.md", width: 80, error: "width 80: boom" }),
        JSON.stringify({ corpus: "b", begin: true }),
        "",
      ].join("\n"),
    );
    expect(streams.map((stream) => stream.corpus)).toEqual(["a", "b"]);
    expect(streams[0]?.digests).toEqual([
      { corpus: "a", path: "/x.md", width: 80, strippedSha: "sha", hasSgr: true },
    ]);
    expect(streams[0]?.errors).toEqual([
      { corpus: "a", path: "/y.md", width: 80, message: "width 80: boom" },
    ]);
    // A corpus that resolved no files still reports itself, so the parent prints a line
    // for it rather than silently dropping it from the run.
    expect(streams[1]?.digests).toEqual([]);
  });
});
