import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { scan } from "../scripts/measure/ansi";
import { mdviewBinary, readStyleTable } from "../scripts/revision";
import { osc8Link } from "./helpers/osc8";
import {
  classifyColourAxis,
  collectColourDigests,
  colourChildEnv,
  digestSequences,
  parseColourDigestStreams,
  runColourAxis,
  unionCorpusNames,
  type ColourDigestRecord,
  type ColourDigestStream,
  type WireSequence,
} from "../scripts/colour-axis";

// The committed table, read from the built renderer (WP-9 of `plans/mdview-rust-port.md`).
const COMMITTED = readStyleTable(mdviewBinary(resolve(import.meta.dir, "..")));
const STYLE_TABLE = Object.fromEntries(
  ["reset", "bold", "underline", "red", "yellow", "cyan", "gray"].map((name) => {
    const code = COMMITTED[name];
    if (code === undefined) throw new Error(`style table has no ${name}`);
    return [name, code];
  }),
) as unknown as Record<"reset" | "bold" | "underline" | "red" | "yellow" | "cyan" | "gray", { open: string; close: string }>;

/**
 * The colour axis (WP-1, `plans/own-the-token-walk.md`; three exact gates since WP-5,
 * `plans/colour-policy.md`; a fourth `formats` child, folded into G2/G3, since WP-4 of
 * `plans/colour-modes.md`).
 *
 * **The load-bearing tests in this file are the first two.** An axis whose children
 * silently resolve the *same* mode is a gate that cannot fail — the shape root
 * `AGENTS.md`'s "Flag order matters" paragraph names as worse than no gate at all — and
 * nothing about the environment we intended to set can rule it out, because the colour
 * decision is resolved from inputs handed in rather than asserted here. So the assertions
 * are on **observed rendered output**: sequences present in one child's renders and
 * absent from another's, for the same file at the same width.
 *
 * Everything here spawns subprocesses for the reason `tests/helpers/color.ts:15-46`
 * records: Bun's module cache is shared across a whole `bun test` run. Nothing in this
 * renderer resolves colour at module load any more (WP-1/WP-2 of `plans/colour-policy.md`),
 * so the subprocesses stay for what *this file* asserts rather than for what the renderer
 * needs — whether the three children resolve the modes they claim is only observable
 * across a process boundary. See `scripts/corpus.ts`'s colour-axis header.
 */

let dir: string;
let manifest: string;

/** Written out rather than typed literally, per this repo's own sentinel convention. */
const ESC = String.fromCharCode(27);
/** BEL, the xterm-compatible OSC terminator — same convention as `TS_BASELINE` `src/ansi.ts`'s. */
const BEL = String.fromCharCode(7);

/** A paragraph whose only styling is emphasis: coloured or not, the characters match. */
const PLAIN =
  "Some **bold** text in a plain paragraph, long enough that it has to wrap at forty " +
  "columns and not at a hundred, which is what makes the width axis observable.\n";
/**
 * A wiki link — the producer this axis was seeded with, and the one it retired.
 *
 * `styleWikiLink` (`TS_BASELINE` `src/render.ts`, deleted at WP-4 of `plans/colour-policy.md`) hardcoded
 * `\x1b[36m\x1b[4m` into the *source* before the lexer and consulted no colour decision at
 * all, so this file used to carry SGR **even in a colourless render**. The label is styled
 * through `TS_BASELINE` `src/style.ts` under the resolved policy now, so both the `off` and `default`
 * children emit no escape for it and every gate passes on this file.
 */
const WIKI = "A paragraph with a [[wiki-link]] in it.\n";
/**
 * An **authored** escape — real terminal bytes the author put in the source, which
 * Decision 1 of `plans/colour-policy.md` requires to survive verbatim, at every colour
 * level, in every child including `default`. It is what keeps every gate below
 * non-vacuous rather than trivially green over an all-plain corpus, and its meaning is
 * pinned separately for each gate (WP-5, brief item 7):
 *
 * - **G1 fires on it, deliberately.** G1's claim is "the piped default emits zero
 *   sequences", full stop — it does not distinguish an authored escape from a producer
 *   leak, because a scanner reading finished text cannot know provenance. `runColourAxis`
 *   below asserts this file lands in `g1Failures` at every width, with the exact
 *   sequences named, which is what makes a real G1 failure legible: a reviewer sees
 *   `sgr:"\x1b[31m"`/`sgr:"\x1b[39m"` and can go verify it against the source.
 * - **G2 does not fire on it.** `scan()` classifies these bytes as ordinary SGR spans in
 *   *both* the `on` and `off` renders (the source is untouched by the colour decision),
 *   so both children's `visible` text is identical — the character channel holds.
 * - **G3 does not fire on it either, and that is a known, accepted limitation rather than
 *   a bug.** The two bytes chosen (`31m` red open, `39m` default-fg close) are also
 *   members of `STYLE_TABLE`'s committed set, so G3's SGR arm — exact membership, not
 *   provenance — cannot distinguish "the renderer emitted this" from "the author typed
 *   these exact bytes and they survived verbatim". G3 is a grammar/vocabulary check, not
 *   a source-position audit; distinguishing the two would need source-range tracking this
 *   WP does not add.
 */
const AUTHORED = `A paragraph with an authored ${ESC}[31mescape${ESC}[39m in it.\n`;

/**
 * The `formats` child's positive non-vacuity seed (WP-4, `plans/colour-modes.md`,
 * cycle-1 f13 / cycle-3 f6): a table, because its head (`bold`, format-class) and its
 * border (`gray`, hue-class) are two producers of the *same* renderer disagreeing under
 * one mode — no paragraph `reset` framing sits around either to mask the result.
 */
const TABLE = "| Head |\n| --- |\n| Cell |\n";
/**
 * The negative seed: a **hue-only** codespan. `TS_BASELINE` `src/inline.ts`'s `CODESPAN` styler is
 * `createStyler("yellow")` alone, with no format-class link in its chain, so the whole
 * chain filters to nothing under `formats` and — per `TS_BASELINE` `src/style.ts`'s `filterChain`
 * contract — emits **nothing at all**, not an empty open/close pair.
 */
const CODESPAN = "A paragraph with a hue-only `code span` inside it.\n";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mdview-colour-axis-"));
  await writeFile(join(dir, "plain.md"), PLAIN);
  await writeFile(join(dir, "wiki.md"), WIKI);
  await writeFile(join(dir, "authored.md"), AUTHORED);
  const seedsDir = join(dir, "seeds");
  await mkdir(seedsDir);
  await writeFile(join(seedsDir, "table.md"), TABLE);
  await writeFile(join(seedsDir, "codespan.md"), CODESPAN);
  manifest = join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      generated: "2026-08-19T00:00:00Z",
      generator: "tests/colour-axis.test.ts",
      corpora: [
        { name: "probe", root: ".", globs: ["*.md"] },
        // A second corpus, not a second manifest resolution: WP-4's non-vacuity seeds live
        // here so they cannot perturb `probe`'s own pinned combo/gate counts above.
        { name: "seeds", root: "seeds", globs: ["*.md"] },
      ],
    }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const argsFor = (widths: string): string[] => ["--manifest", manifest, "--widths", widths];

const digestFor = (stream: ColourDigestStream, name: string, width: number): ColourDigestRecord => {
  const found = stream.digests.find((entry) => entry.file.endsWith(`/${name}`) && entry.width === width);
  if (!found) throw new Error(`no digest for ${name} at width ${width}`);
  return found;
};

/** The `seeds` corpus's own stream, picked out of a child's per-corpus array by name. */
const seedsStream = (streams: ColourDigestStream[]): ColourDigestStream => {
  const found = streams.find((stream) => stream.corpus === "seeds");
  if (!found) throw new Error("no stream for corpus seeds");
  return found;
};

describe("the four children resolve distinct colour decisions (WP-5/WP-4)", () => {
  test("on carries sequences everywhere; off and default carry none for the plain file, formats carries its bold", async () => {
    const args = argsFor("40,80");
    const [on, off, defaultStream, formats] = await Promise.all([
      collectColourDigests("on", args),
      collectColourDigests("off", args),
      collectColourDigests("default", args),
      collectColourDigests("formats", args),
    ]);

    expect(on[0]?.corpus).toBe("probe");
    expect(off[0]?.corpus).toBe("probe");
    expect(defaultStream[0]?.corpus).toBe("probe");
    expect(formats[0]?.corpus).toBe("probe");
    expect(on[0]?.digests.length).toBe(6);
    expect(off[0]?.digests.length).toBe(6);
    expect(defaultStream[0]?.digests.length).toBe(6);
    expect(formats[0]?.digests.length).toBe(6);

    // Observed output, not intended environment: every render in the `on` child carries a
    // sequence, and the plain paragraph carries none in `off` or `default` (`none` emits
    // nothing of the tool's own).
    expect(on[0]!.digests.every((entry) => entry.sequences.length > 0 || entry.malformed)).toBe(true);
    expect(digestFor(off[0]!, "plain.md", 40).sequences).toEqual([]);
    expect(digestFor(off[0]!, "plain.md", 80).sequences).toEqual([]);
    expect(digestFor(defaultStream[0]!, "plain.md", 40).sequences).toEqual([]);
    expect(digestFor(defaultStream[0]!, "plain.md", 80).sequences).toEqual([]);
    // `**bold**` is format-class, so — unlike `off`/`default` — it survives `formats`
    // exactly as it survives `full`: the shape this axis exists to distinguish from a
    // hue-class style, which would not.
    expect(digestFor(formats[0]!, "plain.md", 40).sequences.length).toBeGreaterThan(0);
    expect(digestFor(formats[0]!, "plain.md", 80).sequences.length).toBeGreaterThan(0);

    // And the invariant G2 exists to check, holding on that file: different bytes,
    // identical characters, for both pairs it now compares.
    expect(digestFor(on[0]!, "plain.md", 80).visibleSha).toBe(digestFor(off[0]!, "plain.md", 80).visibleSha);
    expect(digestFor(formats[0]!, "plain.md", 80).visibleSha).toBe(digestFor(off[0]!, "plain.md", 80).visibleSha);
  });

  test("an ambient FORCE_COLOR/NO_COLOR/MDVIEW_COLOR/TMUX/TERM cannot decide any child", async () => {
    // The failure this guards is a developer or CI runner with one of these exported, or a
    // harness invoked from inside a real tmux session: every child would inherit it and
    // the axis would report a clean sheet forever. `colourChildEnv` decides all five on
    // every child, so the ambient values below must not reach any render. The assertions
    // are on **observed rendered output**, not on the environment we intended to set.
    const saved = {
      force: process.env.FORCE_COLOR,
      no: process.env.NO_COLOR,
      mdview: process.env.MDVIEW_COLOR,
      tmux: process.env.TMUX,
      term: process.env.TERM,
    };
    try {
      process.env.FORCE_COLOR = "0";
      process.env.NO_COLOR = "1";
      process.env.MDVIEW_COLOR = "never";
      process.env.TMUX = "/tmp/tmux-1000/default,1,0";
      process.env.TERM = "tmux-256color";
      const [on] = await collectColourDigests("on", argsFor("80"));
      expect(digestFor(on!, "plain.md", 80).sequences.length).toBeGreaterThan(0);

      process.env.FORCE_COLOR = "3";
      delete process.env.NO_COLOR;
      process.env.MDVIEW_COLOR = "always";
      const [off] = await collectColourDigests("off", argsFor("80"));
      expect(digestFor(off!, "plain.md", 80).sequences).toEqual([]);

      process.env.FORCE_COLOR = "3";
      process.env.NO_COLOR = "1";
      process.env.MDVIEW_COLOR = "always";
      const [defaultStream] = await collectColourDigests("default", argsFor("80"));
      expect(digestFor(defaultStream!, "plain.md", 80).sequences).toEqual([]);

      // `formats` is pinned via `MDVIEW_COLOR=never` — the ambient `always` above must not
      // survive `colourChildEnv`'s overwrite. `plain.md` cannot tell `formats` from a
      // leaked `full`, since its only styling (`**bold**`) is format-class and identical
      // under both — `wiki.md`'s cyan (hue-class) is the discriminator: present under a
      // leaked `full`, absent under a correctly-pinned `formats`.
      process.env.FORCE_COLOR = "3";
      delete process.env.NO_COLOR;
      process.env.MDVIEW_COLOR = "always";
      const [formats] = await collectColourDigests("formats", argsFor("80"));
      const formatsWiki = digestFor(formats!, "wiki.md", 80);
      expect(formatsWiki.sequences.some((sequence) => sequence.raw === STYLE_TABLE.cyan.open)).toBe(false);
      // And it is a real `formats` render, not an accidentally-`none` one: the wiki-link's
      // underline (format-class) is correctly still present.
      expect(formatsWiki.sequences.some((sequence) => sequence.raw === STYLE_TABLE.underline.open)).toBe(true);
    } finally {
      for (const [key, value] of [
        ["FORCE_COLOR", saved.force],
        ["NO_COLOR", saved.no],
        ["MDVIEW_COLOR", saved.mdview],
        ["TMUX", saved.tmux],
        ["TERM", saved.term],
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
      TMUX: "/tmp/tmux-1000/default,1,0",
      TERM: "tmux-256color",
      MDVIEW_CORPUS_MANIFEST: "/m.json",
    };
    const on = colourChildEnv("on", base);
    const off = colourChildEnv("off", base);
    const defaultEnv = colourChildEnv("default", base);
    const formatsEnv = colourChildEnv("formats", base);
    expect(on.FORCE_COLOR).toBe("3");
    expect(off.FORCE_COLOR).toBe("0");
    expect("FORCE_COLOR" in defaultEnv).toBe(false);
    expect("FORCE_COLOR" in formatsEnv).toBe(false);
    // `formats` is the one child that pins a value the other three sanitize away:
    // `MDVIEW_COLOR=never`, one of the three explicit `never`-directive routes.
    expect(formatsEnv.MDVIEW_COLOR).toBe("never");
    for (const env of [on, off, defaultEnv]) {
      expect("NO_COLOR" in env).toBe(false);
      expect("MDVIEW_COLOR" in env).toBe(false);
      expect("TMUX" in env).toBe(false);
      expect("TERM" in env).toBe(false);
    }
    expect("NO_COLOR" in formatsEnv).toBe(false);
    expect("TMUX" in formatsEnv).toBe(false);
    expect("TERM" in formatsEnv).toBe(false);
    // The corpus manifest is *not* sanitized away: the child has to resolve the same
    // population the parent did.
    expect(on.MDVIEW_CORPUS_MANIFEST).toBe("/m.json");
    expect(base.NO_COLOR).toBe("1");
    expect(base.FORCE_COLOR).toBe("1");
    expect(base.MDVIEW_COLOR).toBe("never");
    expect(base.TMUX).toBe("/tmp/tmux-1000/default,1,0");
    expect(base.TERM).toBe("tmux-256color");
  });
});

describe("the width axis is real, not five copies of one render (WP-1)", () => {
  test("the same file digests differently at two widths, in the same colour mode", async () => {
    // **This is the trap that has invalidated this measurement four times across three
    // authors.** `renderDocumentDetailed(source, targetWidth, ...)` takes its width as a
    // **positional number**; hand it an options object and every width renders
    // identically, every count comes out an exact multiple of the width count, and the
    // axis reports a number about nothing. Nothing in the type system catches it and no
    // other gate here would notice, so it is asserted directly: a paragraph long enough
    // to wrap has to produce different characters at 40 than at 100.
    const [off] = await collectColourDigests("off", argsFor("40,100"));
    const narrow = digestFor(off!, "plain.md", 40);
    const wide = digestFor(off!, "plain.md", 100);
    expect(narrow.visibleSha).not.toBe(wide.visibleSha);
  });
});

describe("runColourAxis: the end-to-end join over a manifest corpus (WP-5/WP-4)", () => {
  test("the authored escape is the only G1 failure, and its own G3-formats failure — every other gate is clean", async () => {
    const [axis] = await runColourAxis(argsFor("40,80"));
    expect(axis?.corpus).toBe("probe");
    expect(axis?.combos).toBe(6);
    expect(axis?.errors).toEqual([]);

    // G1: `authored.md` at both widths, and only that file — see the constant's own doc
    // comment for why this is the deliberate, legible shape of that failure.
    expect(axis?.g1).toBe(2);
    expect(axis?.g1Failures.every((entry) => entry.file.endsWith("/authored.md"))).toBe(true);
    const widths = axis?.g1Failures.map((entry) => entry.width).sort();
    expect(widths).toEqual([40, 80]);
    for (const failure of axis?.g1Failures ?? []) {
      expect(failure.malformed).toBe(false);
      expect(failure.sequences).toEqual([
        { kind: "sgr", raw: `${ESC}[31m` },
        { kind: "sgr", raw: `${ESC}[39m` },
      ]);
    }

    // G2: the character channel holds for every file, `authored.md` included, on both
    // pairs the gate now compares — the authored bytes strip identically regardless of
    // which colour decision produced the render.
    expect(axis?.g2).toBe(0);

    // G3's `on` arm: `31m`/`39m` are members of the *full* committed style table, so the
    // `on` child's render of `authored.md` cannot be told apart from this renderer's own
    // red styling at the sequence-grammar level that arm checks (see the constant's doc
    // comment).
    //
    // G3's `formats` arm (WP-4, `plans/colour-modes.md`): `red` is hue-class, and the
    // authored escape survives `formats` verbatim (Decision 1), so it fails the narrower
    // format/control vocabulary — pinned here as a **deliberate, legible expected
    // failure**, exactly as the same file already, deliberately, fails G1. Four failures:
    // one open, one close, at each of the two widths.
    expect(axis?.g3).toBe(4);
    const formatsFailures = axis?.g3Failures.filter((entry) => entry.child === "formats") ?? [];
    expect(formatsFailures.length).toBe(4);
    expect(formatsFailures.every((entry) => entry.file.endsWith("/authored.md"))).toBe(true);
    expect(formatsFailures.every((entry) => entry.reason === "sgr not in the committed format/control vocabulary")).toBe(
      true,
    );
    expect(new Set(formatsFailures.map((entry) => entry.sequence?.raw))).toEqual(
      new Set([`${ESC}[31m`, `${ESC}[39m`]),
    );
    expect(axis?.g3Failures.filter((entry) => entry.child === "on")).toEqual([]);
  });

  test("the retired wiki-link producer emits nothing in the off or default child", async () => {
    // The direct half of the WP-4 inversion, asserted on the digest rather than on a
    // gate count, so a future regression names the file rather than a number.
    const [off, defaultStream] = await Promise.all([
      collectColourDigests("off", argsFor("40,80")),
      collectColourDigests("default", argsFor("40,80")),
    ]);
    expect(digestFor(off[0]!, "wiki.md", 40).sequences).toEqual([]);
    expect(digestFor(off[0]!, "wiki.md", 80).sequences).toEqual([]);
    expect(digestFor(defaultStream[0]!, "wiki.md", 40).sequences).toEqual([]);
    expect(digestFor(defaultStream[0]!, "wiki.md", 80).sequences).toEqual([]);
    expect(digestFor(off[0]!, "authored.md", 80).sequences.length).toBeGreaterThan(0);
  });
});

/**
 * The `formats` child's two non-vacuity seeds (WP-4, `plans/colour-modes.md`, cycle-1
 * f13 / cycle-3 f6). Each is proven live, not merely absent: the positive arm asserts
 * both bytes present under `on` before asserting the format one survives and the hue one
 * drops under `formats`; the negative arm asserts the hue byte present under `on` before
 * asserting zero sequences under `formats` — so an accidentally-inert filter (one that
 * happens to render nothing under `formats` for any reason) cannot pass either test.
 * These fixtures live in the `seeds` corpus (see `beforeAll`), kept separate from `probe`
 * so they cannot perturb that corpus's own pinned combo/gate counts above.
 */
describe("non-vacuity seeds for the formats child (WP-4, cycle-1 f13 / cycle-3 f6)", () => {
  test("positive: the table's bold head survives formats, its grey border does not", async () => {
    const [on, formats] = await Promise.all([
      collectColourDigests("on", argsFor("80")),
      collectColourDigests("formats", argsFor("80")),
    ]);
    const onRaw = digestFor(seedsStream(on), "table.md", 80).sequences.map((s) => s.raw);
    const formatsRaw = digestFor(seedsStream(formats), "table.md", 80).sequences.map((s) => s.raw);

    // The arm is alive: `on` really does carry both the bold head and the grey border, so
    // `formats` dropping one of them is a real filter, not an accident of an empty fixture.
    expect(onRaw).toContain(STYLE_TABLE.bold.open);
    expect(onRaw).toContain(STYLE_TABLE.gray.open);

    // The claim: `formats` keeps the format-class pair and drops the hue-class one.
    expect(formatsRaw).toContain(STYLE_TABLE.bold.open);
    expect(formatsRaw).toContain(STYLE_TABLE.bold.close);
    expect(formatsRaw).not.toContain(STYLE_TABLE.gray.open);
    expect(formatsRaw).not.toContain(STYLE_TABLE.gray.close);
  });

  test("negative: a hue-only codespan is styled under on and contributes nothing under formats", async () => {
    const [on, formats] = await Promise.all([
      collectColourDigests("on", argsFor("80")),
      collectColourDigests("formats", argsFor("80")),
    ]);
    const onRecord = digestFor(seedsStream(on), "codespan.md", 80);
    const formatsRecord = digestFor(seedsStream(formats), "codespan.md", 80);

    // The arm is alive: the codespan really is styled under `on`.
    expect(onRecord.sequences.some((s) => s.raw === STYLE_TABLE.yellow.open)).toBe(true);

    // The claim: a hue-only chain filters to nothing under `formats` — not an empty
    // open/close pair, no sequence at all from this producer (`TS_BASELINE` `src/style.ts`'s
    // `filterChain` contract). The paragraph's own `reset` framing (Decision 8, control
    // class, emitted whenever `sgr !== "none"`) still wraps the line — a *different*
    // producer's contribution, asserted separately so it cannot be mistaken for codespan
    // residue: the render's only sequences are that framing, both `reset`, none `yellow`.
    expect(formatsRecord.sequences.some((s) => s.raw === STYLE_TABLE.yellow.open)).toBe(false);
    expect(formatsRecord.sequences.some((s) => s.raw === STYLE_TABLE.yellow.close)).toBe(false);
    expect(formatsRecord.sequences.length).toBe(2);
    expect(formatsRecord.sequences.every((s) => s.raw === STYLE_TABLE.reset.open)).toBe(true);
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
    expect(stdout).toContain("[probe] files=3 combos=3 overflow=0 errors=0");
    // It is the sweep, not the axis: no axis line is printed. (Matched on the printed
    // line's shape, not the bare word — the temp manifest's own path contains it.)
    expect(stdout).not.toContain("] colour-axis combos=");
  });
});

describe("classifyColourAxis: the four-way join and the three exact gates (WP-5/WP-4)", () => {
  const record = (
    file: string,
    width: number,
    visibleSha: string,
    sequences: WireSequence[] = [],
    malformed = false,
  ): ColourDigestRecord => ({ corpus: "c", file, width, visibleSha, sequences, malformed });
  const stream = (digests: ColourDigestRecord[], errors: ColourDigestStream["errors"] = []): ColourDigestStream => ({
    corpus: "c",
    digests,
    errors,
  });
  /**
   * A `formats` stream matching one `off` visible-text hash (`"same"` by default, since
   * that is what `off` uses in every test below that doesn't call this with an override) —
   * so a test not about the `formats`/`off` pair doesn't trip G2's new arm by accident.
   */
  const cleanFormats = (files: string[] = ["/a.md"], width = 80, visibleSha = "same"): ColourDigestStream =>
    stream(files.map((file) => record(file, width, visibleSha)));

  test("a fully joined combo with no divergence passes every gate", () => {
    const on = stream([record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.red.open }])]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    // A legitimate format-class sequence, same visible text as `off` — proves the formats
    // arm does not spuriously fail on content it is authorized to emit.
    const formats = stream([record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.bold.open }])]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 1.5);
    expect(axis.combos).toBe(1);
    expect(axis.g1).toBe(0);
    expect(axis.g2).toBe(0);
    expect(axis.g3).toBe(0);
    expect(axis.errors).toEqual([]);
    expect(axis.elapsedSeconds).toBe(1.5);
  });

  test("G1 fires when the default child carries any recognised sequence", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.red.open }])]);
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(), 0);
    expect(axis.g1).toBe(1);
    expect(axis.g1Failures).toEqual([
      { corpus: "c", file: "/a.md", width: 80, sequences: [{ kind: "sgr", raw: STYLE_TABLE.red.open }], malformed: false },
    ]);
  });

  test("G1 fires when the default child is malformed, even with no recognised sequence", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same", [], true)]);
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(), 0);
    expect(axis.g1).toBe(1);
    expect(axis.g1Failures[0]?.malformed).toBe(true);
    expect(axis.g1Failures[0]?.sequences).toEqual([]);
  });

  test("G2 fires when the on and off children's visible text diverges", () => {
    const on = stream([record("/a.md", 80, "left")]);
    const off = stream([record("/a.md", 80, "right")]);
    const defaultStream = stream([record("/a.md", 80, "right")]);
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(["/a.md"], 80, "right"), 0);
    expect(axis.g2).toBe(1);
    expect(axis.g2Failures).toEqual([
      { corpus: "c", file: "/a.md", width: 80, pair: "on-off", leftVisibleSha: "left", rightVisibleSha: "right" },
    ]);
  });

  test("G2 fires when the formats and off children's visible text diverges (WP-4)", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "different")]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g2).toBe(1);
    expect(axis.g2Failures).toEqual([
      { corpus: "c", file: "/a.md", width: 80, pair: "formats-off", leftVisibleSha: "different", rightVisibleSha: "same" },
    ]);
  });

  test("G2 can fire on both arms for the same combo — up to two failures per key", () => {
    const on = stream([record("/a.md", 80, "left")]);
    const off = stream([record("/a.md", 80, "right")]);
    const defaultStream = stream([record("/a.md", 80, "right")]);
    const formats = stream([record("/a.md", 80, "third")]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g2).toBe(2);
    expect(axis.g2Failures.map((entry) => entry.pair).sort()).toEqual(["formats-off", "on-off"]);
  });

  test("G3's on arm accepts a committed-table SGR pair and rejects one outside it", () => {
    const committed = record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.red.open }]);
    const uncommitted = record("/b.md", 80, "same", [{ kind: "sgr", raw: `${ESC}[92m` }]);
    const off = stream([record("/a.md", 80, "same"), record("/b.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same"), record("/b.md", 80, "same")]);
    const axis = classifyColourAxis(
      "c",
      stream([committed, uncommitted]),
      off,
      defaultStream,
      cleanFormats(["/a.md", "/b.md"], 80),
      0,
    );
    expect(axis.g3).toBe(1);
    expect(axis.g3Failures).toEqual([
      {
        corpus: "c",
        file: "/b.md",
        width: 80,
        child: "on",
        sequence: { kind: "sgr", raw: `${ESC}[92m` },
        reason: "sgr not in the committed style table",
      },
    ]);
  });

  test("G3's formats arm accepts a format/control pair and rejects a hue one (WP-4)", () => {
    const on = stream([record("/a.md", 80, "same"), record("/b.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same"), record("/b.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same"), record("/b.md", 80, "same")]);
    const formatOk = record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.underline.open }]);
    const hueRejected = record("/b.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.red.open }]);
    const axis = classifyColourAxis("c", on, off, defaultStream, stream([formatOk, hueRejected]), 0);
    expect(axis.g3).toBe(1);
    expect(axis.g3Failures).toEqual([
      {
        corpus: "c",
        file: "/b.md",
        width: 80,
        child: "formats",
        sequence: { kind: "sgr", raw: STYLE_TABLE.red.open },
        reason: "sgr not in the committed format/control vocabulary",
      },
    ]);
  });

  test("G3's formats arm accepts the control class too (reset, Decision 8)", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "same", [{ kind: "sgr", raw: STYLE_TABLE.reset.open }])]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g3).toBe(0);
  });

  test("G3 accepts a well-formed OSC-8 hyperlink with no tmux wrapper, on either arm", () => {
    const rendered = osc8Link("label", "https://example.invalid", false);
    const sequences = scan(rendered).spans.filter(
      (span): span is { kind: "osc8"; raw: string; width: number } => span.kind === "osc8",
    );
    expect(sequences.length).toBeGreaterThan(0);
    const wire = sequences.map((s) => ({ kind: "osc8" as const, raw: s.raw }));
    const on = stream([record("/a.md", 80, "same", wire)]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "same", wire)]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g3).toBe(0);
  });

  test("G3 accepts a tmux-wrapped OSC-8 hyperlink on either arm — the DCS arm, injected tmux, non-vacuous", () => {
    // `link(..., tmux=true)` is `TS_BASELINE` `src/ansi.ts`'s own construction of exactly what a tmux
    // session sees (cycle-3 f7): the wrapper this WP's G3 must have a DCS arm for, or a
    // gate over the plan's own emitted output would reject something the plan introduces.
    const rendered = osc8Link("label", "https://example.invalid", true);
    const dcsSpans = scan(rendered).spans.filter((span) => span.kind === "dcs");
    expect(dcsSpans.length).toBe(2); // open and close, each its own DCS-wrapped OSC-8
    const wire = dcsSpans.map((s) => ({ kind: "dcs" as const, raw: s.raw }));
    const on = stream([record("/a.md", 80, "same", wire)]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "same", wire)]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g3).toBe(0);
  });

  test("G3 rejects a tmux DCS wrapper whose payload is not a valid OSC-8 sequence, on either arm", () => {
    // A well-formed *outer* DCS frame (`scan` classifies it `dcs`) around a payload that
    // is not an OSC-8 open or close at all — the negative case for the same arm above.
    const hostile = `${ESC}Ptmux;hello${ESC}\\`;
    expect(scan(hostile).spans.map((span) => span.kind)).toEqual(["dcs"]);
    const on = stream([record("/a.md", 80, "same", [{ kind: "dcs", raw: hostile }])]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "same", [{ kind: "dcs", raw: hostile }])]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g3).toBe(2);
    expect(axis.g3Failures.map((entry) => entry.child).sort()).toEqual(["formats", "on"]);
    for (const failure of axis.g3Failures) {
      expect(failure.reason).toBe("dcs payload is not a valid doubled-ESC OSC-8 open or close");
    }
  });

  test("G3 fires on a malformed on-child sequence", () => {
    const on = stream([record("/a.md", 80, "same", [], true)]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(), 0);
    expect(axis.g3).toBe(1);
    expect(axis.g3Failures[0]?.child).toBe("on");
    expect(axis.g3Failures[0]?.sequence).toBeUndefined();
    expect(axis.g3Failures[0]?.reason).toBe("malformed sequence in the colour-on render");
  });

  test("G3 fires on a malformed formats-child sequence (WP-4)", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([record("/a.md", 80, "same", [], true)]);
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.g3).toBe(1);
    expect(axis.g3Failures[0]?.child).toBe("formats");
    expect(axis.g3Failures[0]?.sequence).toBeUndefined();
    expect(axis.g3Failures[0]?.reason).toBe("malformed sequence in the formats-child render");
  });

  test("a key missing from one child becomes a mode-tagged error, and the combo is excluded", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([]); // /a.md never reported by the default child
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(), 0);
    expect(axis.combos).toBe(0);
    expect(axis.errors).toEqual([{ mode: "default", corpus: "c", file: "/a.md", width: 80, reason: "missing" }]);
  });

  test("a key missing from the formats child becomes a mode-tagged error too (WP-4)", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([record("/a.md", 80, "same")]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const formats = stream([]); // /a.md never reported by the formats child
    const axis = classifyColourAxis("c", on, off, defaultStream, formats, 0);
    expect(axis.combos).toBe(0);
    expect(axis.errors).toEqual([{ mode: "formats", corpus: "c", file: "/a.md", width: 80, reason: "missing" }]);
  });

  test("a key present but errored in one child becomes a mode-tagged child-error", () => {
    const on = stream([record("/a.md", 80, "same")]);
    const off = stream([], [{ corpus: "c", file: "/a.md", width: 80, message: "width 80: boom" }]);
    const defaultStream = stream([record("/a.md", 80, "same")]);
    const axis = classifyColourAxis("c", on, off, defaultStream, cleanFormats(), 0);
    expect(axis.combos).toBe(0);
    expect(axis.errors).toEqual([
      { mode: "off", corpus: "c", file: "/a.md", width: 80, reason: "child-error", message: "width 80: boom" },
    ]);
  });

  test("missing streams are treated as empty, not a crash", () => {
    const axis = classifyColourAxis("c", undefined, undefined, undefined, undefined, 0);
    expect(axis.combos).toBe(0);
    expect(axis.errors).toEqual([]);
    expect(axis.g1).toBe(0);
    expect(axis.g2).toBe(0);
    expect(axis.g3).toBe(0);
  });
});

describe("unionCorpusNames: the corpus-only-in-one-mode case (WP-5, cycle-3 f8; WP-4)", () => {
  const streamFor = (corpus: string): ColourDigestStream => ({ corpus, digests: [], errors: [] });

  test("a corpus resolved by only one child still appears, in first-seen order", () => {
    const on = [streamFor("a"), streamFor("b")];
    const off = [streamFor("a")];
    const defaultStreams = [streamFor("a"), streamFor("c")];
    const formats = [streamFor("a"), streamFor("d")];
    expect(unionCorpusNames(on, off, defaultStreams, formats)).toEqual(["a", "b", "c", "d"]);
  });

  test("an empty set of children still resolves to no corpora, not a crash", () => {
    expect(unionCorpusNames([], [], [], [])).toEqual([]);
  });

  test("a corpus present in every child is not duplicated", () => {
    const on = [streamFor("a")];
    const off = [streamFor("a")];
    const defaultStreams = [streamFor("a")];
    const formats = [streamFor("a")];
    expect(unionCorpusNames(on, off, defaultStreams, formats)).toEqual(["a"]);
  });
});

describe("digestSequences: the visible-text channel and the sequence list (WP-5)", () => {
  test("the sha is of the visible text, so colour cannot move it", () => {
    const plain = digestSequences("bold text");
    const styled = digestSequences(`${ESC}[1mbold${ESC}[22m text`);
    expect(styled.visibleSha).toBe(plain.visibleSha);
    expect(styled.sequences).toEqual([
      { kind: "sgr", raw: `${ESC}[1m` },
      { kind: "sgr", raw: `${ESC}[22m` },
    ]);
    expect(plain.sequences).toEqual([]);
    expect(plain.malformed).toBe(false);
  });

  test("an OSC-8 hyperlink is a sequence this instrument sees", () => {
    const link = digestSequences(`${ESC}]8;;https://example.com${BEL}text${ESC}]8;;${BEL}`);
    expect(link.sequences.map((s) => s.kind)).toEqual(["osc8", "osc8"]);
    expect(link.visibleSha).toBe(digestSequences("text").visibleSha);
  });

  test("a tmux-wrapped hyperlink is seen too, as two dcs spans, envelope and all", () => {
    const wrapped = digestSequences(osc8Link("text", "https://example.com", true));
    expect(wrapped.sequences.map((s) => s.kind)).toEqual(["dcs", "dcs"]);
    expect(wrapped.visibleSha).toBe(digestSequences("text").visibleSha);
  });

  test("a malformed sequence sets the flag and is not enumerated in sequences", () => {
    // An unrecognised CSI final byte: well-formed grammar, not a kind this renderer emits.
    const hostile = digestSequences(`${ESC}[2Jtext`);
    expect(hostile.malformed).toBe(true);
    expect(hostile.sequences).toEqual([]);
  });
});

describe("parseColourDigestStreams: the child's v2 wire format (WP-5)", () => {
  test("digests, errors and empty corpora are all recoverable, in first-seen order", () => {
    const streams = parseColourDigestStreams(
      [
        JSON.stringify({ corpus: "a", begin: true }),
        JSON.stringify({
          corpus: "a",
          file: "/x.md",
          width: 80,
          visibleSha: "sha",
          sequences: [{ kind: "sgr", raw: `${ESC}[1m` }],
          malformed: false,
        }),
        JSON.stringify({ corpus: "a", file: "/y.md", width: 80, error: "width 80: boom" }),
        JSON.stringify({ corpus: "b", begin: true }),
        "",
      ].join("\n"),
    );
    expect(streams.map((stream) => stream.corpus)).toEqual(["a", "b"]);
    expect(streams[0]?.digests).toEqual([
      {
        corpus: "a",
        file: "/x.md",
        width: 80,
        visibleSha: "sha",
        sequences: [{ kind: "sgr", raw: `${ESC}[1m` }],
        malformed: false,
      },
    ]);
    expect(streams[0]?.errors).toEqual([{ corpus: "a", file: "/y.md", width: 80, message: "width 80: boom" }]);
    // A corpus that resolved no files still reports itself, so the parent prints a line
    // for it rather than silently dropping it from the run.
    expect(streams[1]?.digests).toEqual([]);
  });
});
