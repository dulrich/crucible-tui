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
 * The Cargo workspace (WP-1 of `plans/jsonedit.md`) adds five steps after
 * the mdview self-smoke and before the sweeps: `cargo fmt --check`, clippy
 * with warnings denied, `cargo test`, the static musl `bun run build:rust`
 * (via `cargo auditable`), and a smoke of the built jsonedit artifact. Every
 * graph-consuming cargo call runs `--locked`. `verify` never runs `cargo
 * install` or `rustup` either — toolchain setup stays outside, like `bun
 * install`.
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
// `bun run test:security` runs `trivy fs --scanners vuln --include-dev-deps --skip-db-update
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
       trivy fs --scanners vuln --include-dev-deps --exit-code 0 --severity CRITICAL,HIGH .

After that, "bun run test:security" (and therefore "bun run verify") runs
fully offline via --skip-db-update. See AGENTS.md's Run section.
`;

const TRIVY_STALE_DB_MESSAGE = `
verify: security scan (trivy) — DB COLD OR STALE

trivy is installed, but the scan above failed in a way that matches a
cold or stale vulnerability DB cache (no cache yet on a fresh clone, or the
DB's ~daily expiry). --skip-db-update refuses to fetch one for you.

Bootstrap (also the periodic refresh, if this reappears after being idle):
  trivy fs --scanners vuln --include-dev-deps --exit-code 0 --severity CRITICAL,HIGH .

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
  { name: "cargo fmt", run: () => sh(["cargo", "fmt", "--all", "--check"]) },
  {
    name: "cargo clippy",
    run: () => sh(["cargo", "clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]),
  },
  { name: "cargo test", run: () => sh(["cargo", "test", "--workspace", "--locked"]) },
  { name: "build (rust)", run: () => sh(["bun", "run", "build:rust"]) },
  {
    name: "artifact smoke (jsonedit)",
    run: () => sh(["./target/x86_64-unknown-linux-musl/release/jsonedit", "--version"]),
  },
  { name: "sweep (unicode)", run: () => sh(["bun", "run", "sweep"]) },
  { name: "sweep (ascii)", run: () => sh(["bun", "run", "sweep", "--", "--glyphs", "ascii"]) },
  {
    // The colour axis (WP-1, `plans/own-the-token-walk.md`; three exact gates since
    // WP-5, `plans/colour-policy.md`; a fourth child since WP-4, `plans/colour-modes.md`):
    // the same bundled corpus, rendered four times more — a forced-colour child, a
    // colourless one, an env-sanitized `default` child with no colour variable set at all,
    // and a `formats` child pinned via `MDVIEW_COLOR=never` — and joined on the union of
    // every `(file, width)` key any of the four reported. It costs about one extra sweep
    // of wall time because the four children run in parallel.
    //
    // **No thresholds — three exact, per-combo gates, over the fixed, explicit,
    // wildcard-free gate corpus** (`corpus/default-manifest.json` — WP-1,
    // `plans/gate-corpus-reframe.md`): G1 the `default` child emits zero terminal
    // sequences; G2 the `on`/`off` children's visible text is identical, extended to
    // `formats`/`off` at WP-4; G3 every `on` sequence parses as committed-table SGR, a
    // well-formed OSC-8 hyperlink, or a strictly-parsed tmux DCS wrapper around one,
    // extended at WP-4 to every `formats` sequence against the narrower format/control
    // vocabulary. The step exits non-zero iff any of `g1`/`g2`/`g3`/`errors` is non-zero —
    // still three gates, not four, since WP-4 folded the fourth child into G2/G3 rather
    // than adding a G4; the two ratchet counters this replaced (`--max-char-diff 31
    // --max-sgr 20`) were already measured at 0 and are deleted with their flags;
    // `scripts/AGENTS.md`'s colour-axis section carries the gate definitions and the
    // history of what used to move these numbers.
    //
    // The full-corpus pass stays opt-in: it is the private manifest's job, run by hand
    // with `MDVIEW_CORPUS_MANIFEST` set, and is deliberately not wired in here.
    name: "sweep (colour axis)",
    run: () => sh(["bun", "run", "sweep", "--", "--colour-mode", "both"]),
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
