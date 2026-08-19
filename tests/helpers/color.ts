import { resolve } from "node:path";

/**
 * Forced-color test fixture.
 *
 * **The gating this helper was built for has moved three times, and the helper is still the
 * fixture for what a forced-colour child sees.** `marked-terminal` delegated syntax
 * highlighting to `cli-highlight`, which was gated behind `chalk.level === 0` — true
 * whenever stdout is not a TTY, which is always true under `bun test` — so the highlight
 * path, and any highlight.js "language not found" diagnostic, was dead code in every normal
 * test run. WP-2 of `plans/colour-policy.md` made the gate the resolved policy handed in as
 * a value (`src/highlight.ts` reads nothing else), so an in-process test can reach the
 * highlighting path by asking for it — which is what `tests/blocks.test.ts` does. What
 * still needs a child is a claim about how the *policy itself* resolves from an
 * environment, which is this helper's job.
 *
 * **The third move is WP-2 of `plans/colour-modes.md`, and it narrows the gate rather than
 * relocating it: the highlighter runs under `sgr === "full"` and under nothing else**
 * (`highlightCode`, `src/blocks.ts`; Decision 3's named producer exception). The practical
 * consequence for anything built on this helper is that a `formats`-mode render — the new
 * output of `--color=never`, `MDVIEW_COLOR=never` and config `never` — reaches the *same*
 * colourless code branch a `none`-mode render does, so a fence carries no theme spans and
 * no `fixHardReturn`. `forcedColorChildEnv` below pins `FORCE_COLOR=3`, which resolves to
 * `full`, so this helper's own children are unaffected; a future helper that wanted to
 * exercise `formats` would have to pin `MDVIEW_COLOR=never` instead, and would find the
 * highlighter deliberately dark.
 *
 * Two facts about the original trap, both verified against this repo's
 * `render.ts`/`highlight.js` before this helper was written (see
 * plans/vault-readiness.md's WP-1 brief), and both still worth knowing because the second
 * one is about highlight.js and highlight.js has not gone anywhere:
 *
 * 1. Chalk resolves its color level at MODULE-LOAD time, not per call. Setting
 *    `FORCE_COLOR` after `render.ts` (and therefore chalk) has already been
 *    imported does nothing.
 * 2. highlight.js's "language not found" diagnostic is emitted via
 *    `console.error`, NOT `console.warn` (highlight.js/lib/core.js: the
 *    `LANGUAGE_NOT_FOUND` message goes through an `error()` helper that is a thin
 *    wrapper over `console.error`). The plan document says `console.warn`; that
 *    is wrong, and this helper patches `console.error` — patching only
 *    `console.warn` would make any test built on it pass vacuously.
 *
 * DEVIATION FROM THE BRIEF, discovered while building this: the brief's
 * prescribed shape — "await import(...) the render module after setting
 * FORCE_COLOR" **inside the same test process** — reliably fails as soon as
 * ANY other test file in the same `bun test` run has already imported
 * `src/render.ts` (directly, or transitively via `src/cli.ts`). Bun's module
 * cache is shared across all test files in one `bun test` invocation; the first
 * import — regardless of which file or whether it is static or dynamic —
 * resolves chalk's level once for the whole process, and every later dynamic
 * import of the same specifier (even with a cache-busting query string, which I
 * also tried) returns the already-cached module. `tests/render.test.ts` and
 * `tests/cli.test.ts` both import `src/render.ts` (the former via a top-level
 * `await import`), and both sort alphabetically before `tests/sweep.test.ts`, so
 * this is not a hypothetical — it reproduces on every `bun test tests` run, not
 * just in isolation.
 *
 * The fix: run the render in a genuinely fresh `bun` **subprocess**, with
 * `FORCE_COLOR=3` set in that subprocess's environment before its own module
 * graph loads for the first time. This is immune to whatever the parent test
 * process has already cached, and matches the brief's own manual repro command
 * (`FORCE_COLOR=3 bun run src/cli.ts ...`), which is itself a fresh
 * process. The env-var-before-module-load invariant the brief states is
 * preserved; only the "same process, dynamic import" mechanism was wrong for
 * use inside a shared test run.
 */

/**
 * The child environment for a forced-colour render, sanitized then pinned.
 *
 * **Inheriting `process.env` and setting only `FORCE_COLOR` stopped being safe at WP-1 of
 * `plans/colour-policy.md`, and the failure it now prevents is silent.** `FORCE_COLOR` is
 * the *fourth* slot in the ratified precedence table; `MDVIEW_COLOR` and `NO_COLOR` both
 * outrank it. A developer or CI runner with either exported would hand every helper below
 * a child that renders **colourless while claiming to be the forced-colour side** — and the
 * assertions built on it (parity against the `colorOn` golden, the highlighter's stderr
 * diagnostic) would pass vacuously rather than fail, because a colourless render simply
 * never reaches the branches under test.
 *
 * Exported so a test can assert directly on what it produces, rather than only through the
 * behaviour of a subprocess it spawned.
 */
export function forcedColorChildEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.MDVIEW_COLOR;
  delete env.NO_COLOR;
  // `FORCE_COLOR` needs no delete: the next line overwrites it unconditionally.
  env.FORCE_COLOR = "3";
  return env;
}

export interface ForcedColorRenderResult {
  text: string;
  /** Every message passed to a patched console method during the render. */
  messages: string[];
}

interface ChildResult {
  text: string;
  messages: string[];
  error?: string;
}

const RENDER_MODULE_PATH = resolve(import.meta.dir, "../../src/render.ts");

// Executed inside the child `bun -e` process. Patches both console.error (the
// verified real sink) and console.warn (belt-and-braces, per the brief) before
// importing the render module, then renders stdin at the width passed as the
// last-but-one argv entry and prints a JSON result to stdout.
const CHILD_SCRIPT = `
const argv = process.argv;
const modulePath = argv[argv.length - 1];
const targetWidth = Number(argv[argv.length - 2]);
const messages = [];
const capture = (...args) => { messages.push(args.map(String).join(" ")); };
console.error = capture;
console.warn = capture;
const { renderDocumentDetailed } = await import(modulePath);
const source = await Bun.stdin.text();
try {
  const { text } = renderDocumentDetailed(source, targetWidth);
  process.stdout.write(JSON.stringify({ text, messages }));
} catch (error) {
  process.stdout.write(JSON.stringify({ text: "", messages, error: String(error) }));
}
`;

/**
 * Render \`source\` in a fresh subprocess with FORCE_COLOR=3 set before that
 * process's module graph loads, capturing anything written to console.error /
 * console.warn during the render.
 */
export async function renderWithForcedColor(
  source: string,
  targetWidth: number,
): Promise<ForcedColorRenderResult> {
  const proc = Bun.spawn(
    ["bun", "-e", CHILD_SCRIPT, "--", String(targetWidth), RENDER_MODULE_PATH],
    {
      env: forcedColorChildEnv(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  proc.stdin.write(source);
  await proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`renderWithForcedColor subprocess exited ${exitCode}: ${stderr}`);
  }

  let parsed: ChildResult;
  try {
    parsed = JSON.parse(stdout) as ChildResult;
  } catch {
    throw new Error(
      `renderWithForcedColor subprocess produced non-JSON stdout: ${stdout}\nstderr: ${stderr}`,
    );
  }

  if (parsed.error) {
    throw new Error(`renderWithForcedColor render failed: ${parsed.error}`);
  }

  return { text: parsed.text, messages: parsed.messages };
}
