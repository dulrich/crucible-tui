#!/usr/bin/env bun
/**
 * scripts/verify.ts — WP-1 (`plans/tn-review-remediation.md`) canonical
 * verification entrypoint. `bun run verify` is the one command AGENTS.md's
 * Run section and `.github/workflows/ci.yml` both call.
 *
 * Every step below runs the same command that already existed for it before
 * WP-1 (see AGENTS.md's Run section for the byte-identical list) plus three
 * gates that existed but were not wired into any single chain: the compiled
 * build, a smoke of the built artifact, and license freshness (in `--check`
 * mode, which never writes `THIRD-PARTY-LICENSES.txt`).
 *
 * Runs fail-fast, in order, and prints which step failed. `verify` never
 * runs `bun install` — local floats (`bun install`), CI freezes (`bun
 * install --frozen-lockfile`), and that asymmetry is deliberate.
 * Installation stays a separate step, run once before `verify`, in both
 * places.
 */

interface StepResult {
  code: number;
}

interface Step {
  name: string;
  run: () => StepResult;
}

function sh(cmd: string[]): StepResult {
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  return { code: proc.exitCode ?? 1 };
}

// --- Security step: trivy preflight -----------------------------------------
//
// `bun run test:security` runs `trivy fs --scanners vuln --skip-db-update
// --exit-code 1 --severity CRITICAL,HIGH .` (package.json — its command
// string is load-bearing and unchanged by this file). --skip-db-update is
// deliberately offline, which means it fails on any machine that has never
// run trivy: trivy absent from PATH (exit 127), or a cold/stale vulnerability
// DB cache (trivy's own "cannot skip downloading DB" / "--skip-db-update
// cannot be specified on the first run" errors, exit 1). Both are setup
// problems, not vulnerability findings, and a raw 127 or FATAL at the very
// last gate in the chain is not actionable. This preflight turns each into a
// loud, distinguishable, actionable message instead.
//
// Missing trivy FAILS the gate here rather than skipping with a warning.
// AGENTS.md's "Flag order matters" paragraph is this repo's standing
// doctrine that a gate able to silently pass is worse than no gate at all;
// "skip with a warning" is exactly that shape from CI's perspective — a
// green `bun run verify` that never actually ran a security scan. Failing
// loudly, with the exact bootstrap command, keeps the gate's teeth while
// still being immediately actionable instead of a bare exit 127.

const TRIVY_MISSING_MESSAGE = `
verify: security scan (trivy) — PREFLIGHT FAILED

trivy is not installed, or not on PATH, so "bun run test:security" cannot
run. This is a one-time environment setup gap, not a vulnerability finding —
the gate fails loudly rather than silently passing (see AGENTS.md's "Flag
order matters" doctrine: a gate that can silently pass is worse than no gate).

One-time bootstrap:
  1. Install trivy:
       curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh \\
         | sh -s -- -b ~/.local/bin v0.73.0
  2. Warm the vulnerability DB once (this WILL hit the network —
     --skip-db-update requires a DB that already exists):
       trivy fs --scanners vuln --exit-code 0 --severity CRITICAL,HIGH .

After that, "bun run test:security" (and therefore "bun run verify") runs
fully offline via --skip-db-update. See AGENTS.md's Run section.
`;

const TRIVY_STALE_DB_MESSAGE = `
verify: security scan (trivy) — DB COLD OR STALE

trivy is installed, but the scan above failed in a way that matches a
cold or stale vulnerability DB cache (no cache yet on a fresh clone, or the
DB's ~daily expiry). --skip-db-update refuses to fetch one for you.

Bootstrap (also the periodic refresh, if this reappears after being idle):
  trivy fs --scanners vuln --exit-code 0 --severity CRITICAL,HIGH .

Then re-run "bun run verify" (or "bun run test:security" directly). See
AGENTS.md's Run section.
`;

const COLD_STALE_DB_PATTERN =
  /cannot skip downloading db|--skip-db-update cannot be specified|db is (old|stale|outdated)|outdated database|database.*(old|stale|outdated)/i;

function runSecurityStep(): StepResult {
  if (!Bun.which("trivy")) {
    console.error(TRIVY_MISSING_MESSAGE);
    return { code: 1 };
  }

  const proc = Bun.spawnSync(["bun", "run", "test:security"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const code = proc.exitCode ?? 1;
  if (code !== 0 && COLD_STALE_DB_PATTERN.test(`${stdout}\n${stderr}`)) {
    console.error(TRIVY_STALE_DB_MESSAGE);
  }
  return { code };
}

// --- The chain ---------------------------------------------------------------

const steps: Step[] = [
  { name: "typecheck", run: () => sh(["bun", "run", "typecheck"]) },
  { name: "lint", run: () => sh(["bun", "run", "lint"]) },
  { name: "test", run: () => sh(["bun", "test", "tests"]) },
  { name: "build", run: () => sh(["bun", "run", "build"]) },
  {
    name: "artifact smoke",
    run: () => sh(["./dist/mdview", "--check", "--width", "80", "tests/fixtures/wide-table.md"]),
  },
  {
    name: "license freshness",
    run: () => sh(["bun", "run", "scripts/gen-licenses.ts", "--check"]),
  },
  {
    name: "self-smoke (--check)",
    run: () =>
      sh(["bun", "run", "src/cli.ts", "--check", "--width", "80", "tests/fixtures/wide-table.md"]),
  },
  { name: "sweep (unicode)", run: () => sh(["bun", "run", "sweep"]) },
  { name: "sweep (ascii)", run: () => sh(["bun", "run", "sweep", "--", "--glyphs", "ascii"]) },
  {
    // The colour axis (WP-1, `plans/own-the-token-walk.md`): the same bundled corpus,
    // rendered twice more — once in a forced-colour child, once in a colourless one —
    // and compared SGR-stripped against SGR-stripped. It costs about one extra sweep of
    // wall time because the two children run in parallel.
    //
    // **The two numbers are ratchets seeded from this instrument's own output**, not
    // targets: they are what the bundled corpus measured when the axis landed, and what
    // must not happen is either going up. They are also a function of the *population* —
    // the bundled manifest globs `plans/*.md` **and `AGENTS.md` and `README.md`**, so
    // adding a plan file, or editing any of those documents, changes both. A WP that does
    // and trips this re-measures with the same command and re-seeds here, in the same
    // commit, exactly as the sweep's own file count is re-quoted with its commit. See
    // `scripts/AGENTS.md`'s colour-axis section for the seeding record.
    //
    // **`--max-char-diff` was 62 until WP-2 of `plans/own-the-token-walk.md` and is 65
    // because that package rewrote `AGENTS.md`, not because it moved the renderer.**
    // `AGENTS.md` went from differing at 2 of the 5 widths to differing at all 5. The
    // evidence that it is population and not renderer, recorded because this is the one
    // number a walk rewrite must never be allowed to quietly move: rendering the *base*
    // `AGENTS.md` through the *new* renderer gives `charDiff=2` and the new one gives
    // `charDiff=5`, and `scripts/render-diff.ts --expect a` over 440 combos in each colour
    // mode reports `diffed=0` over the new text. `--max-sgr` did not move.
    //
    // **`--max-sgr` was 20 until `plans/styled-runs-and-colour-policy.md` was written and
    // is 25 because that file joined the globbed population**, with no source change in
    // the commit at all — and the cause is the same one the 20 already had. `sgrOnly`
    // does **not** mean "the two modes' escape streams differ"; it means the *colourless*
    // render still contains SGR (`classifyColourAxis`, `scripts/corpus.ts:1069-1075`), so
    // it is a leak counter, and the leak is `styleWikiLink`'s unconditional escapes. The
    // new plan file carries eight `[[…]]` occurrences. Isolated with a one-file manifest
    // per the procedure in `scripts/AGENTS.md`: the file as written reports
    // `charDiff=0 sgrAny=5`, and the same file with every wiki-link textually removed
    // reports `charDiff=0 sgrAny=0 identical=5`. Same renderer, same widths, −5.
    //
    // **`--max-char-diff` moved 65 → 66 in the same commit, and the extra one is a real
    // defect firing on the new plan file's own text.** Population again, not renderer —
    // but this time the new population member *demonstrates* one of the defects the plan
    // exists to remove, which is worth more than a clean number. Isolated to
    // `(plans/styled-runs-and-colour-policy.md, width 100)`; the other four widths are
    // character-identical. Rendered under `FORCE_COLOR=3` and `FORCE_COLOR=0` and
    // SGR-stripped, one bullet in that file's Summary differs two ways:
    //
    //   off: "…the shorthand for it"      / "       **bold** contributes nothing…"
    //   on:  "…the shorthand for it is"   / "    **bold** contributes nothing…"
    //
    // The wrap point moves — the coloured render packs one more word onto the line — and
    // the continuation indent differs by three columns. Neither run overflows; `--check`
    // passes at width 100 in both modes. Candidate sites are the three the plan
    // enumerates: `src/wrap.ts:44-62` (an escape-only part is accumulated into the
    // current word instead of flushing it, so the entry list differs), and
    // `src/lists.ts:147-150` / `:425` for the indent. **Not attributed to one of them
    // here** — that is the plan's WP-4 job, with this as its witness.
    //
    // **`--max-char-diff` moved 66 → 70 when rev 2 of that plan replaced rev 1's prose,
    // and that falsified the sentence this comment carried one commit earlier.** The
    // claim was "this is the last legitimate rise, because no package in that plan adds a
    // file to the globbed population." Adding a file is not the only way the population
    // changes: **editing a globbed file's content does it too.** The globs are
    // non-recursive and resolve to exactly the 23 files the sweep counts — `README.md`,
    // root `AGENTS.md`, `plans/*.md` (11) and `tests/fixtures/*.md` (10) — so
    // `src/AGENTS.md` and this file's own `scripts/AGENTS.md` are **not** members and are
    // free to edit, while **every plan revision, including a one-line Status-line edit**,
    // is a population change. Rev 2's rise is exactly that, with zero source changes in
    // the commit. Isolated with a one-file manifest: the plan file
    // alone reports `charDiff=5 sgrAny=5` at rev 2 where it reported `charDiff=1
    // sgrAny=5` at rev 1, i.e. the same defect now fires at all five widths instead of
    // one. The other 65 are unchanged.
    //
    // Two symptoms are visible in rev 2's text, both reproducible by rendering it under
    // `FORCE_COLOR=3` and `FORCE_COLOR=0` and stripping SGR from both:
    //
    //   width 80,  ~line 490: colourless ends "strips [ ]", coloured ends "strips [ ] "
    //   width 80,  ~line 841: a whitespace-only line present under colour, absent without
    //   width 100, ~line 208: the coloured render packs one more word onto the line and
    //                         the continuation indent differs by three columns
    //
    // The whitespace-only line has the shape `src/lists.ts:425`'s
    // `.filter((line) => line !== "")` would produce, and the moving wrap point the shape
    // `src/wrap.ts:44-62`'s escape-only word entry would produce — **but neither is
    // attributed here.** Inferring a site from a symptom is how a defect gets "fixed" by
    // coincidence; WP-1 of that plan bisects them and, first, makes the colour axis print
    // a per-file breakdown so the next rise is attributable by one command instead of by
    // a hand-built manifest. That plan makes `charDiff=0` a gate at its WP-5c and
    // `sgrAny=0` a gate at its WP-6, and requires every future move — up **or down** —
    // to be attributed per file before anything is re-seeded.
    //
    // The full-corpus pass stays opt-in: it is the private manifest's job, run by hand
    // with `MDVIEW_CORPUS_MANIFEST` set, and is deliberately not wired in here.
    name: "sweep (colour axis)",
    run: () =>
      sh(["bun", "run", "sweep", "--", "--colour-mode", "both", "--max-char-diff", "70", "--max-sgr", "25"]),
  },
  { name: "security scan", run: runSecurityStep },
];

for (const step of steps) {
  console.log(`\n> verify: ${step.name}`);
  const { code } = step.run();
  if (code !== 0) {
    console.error(`\nverify: FAILED at step "${step.name}" (exit ${code})`);
    process.exit(code);
  }
}

console.log("\nverify: all steps passed");
