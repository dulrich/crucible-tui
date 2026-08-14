#!/usr/bin/env bun
/**
 * Generates THIRD-PARTY-LICENSES.txt (WP-6b) from the actual installed
 * **runtime** dependency closure — not from all of `node_modules`, which
 * also holds devDependency tooling (eslint, typescript, ...) that never
 * ships in the published package or the compiled binary.
 *
 * Method: walk Node's own module resolution algorithm, starting from this
 * package's `dependencies` (never `devDependencies`), following each
 * resolved package's own `dependencies` *and* `optionalDependencies`
 * transitively. `optionalDependencies` is included deliberately, not
 * skipped: `cli-table3` declares `@colors/colors` as optional, but
 * `cli-table3`'s own `src/cell.js` does `require('@colors/colors/safe')`
 * unconditionally whenever a cell style property is set — so it ships real
 * code and must be reproduced like any other dependency, not waved through
 * as merely suggested. (Since WP-3 of `plans/tn-review-remediation.md`
 * `@colors/colors` is also a *direct* dependency of this package —
 * `src/table.ts` imports it for the border/head styling it took over from
 * `cli-table3` — so it would now be reached either way. The optional-edge
 * rule stays, because it is what keeps `cli-table3` itself, still pulled in
 * by `marked-terminal`, from dropping its own optional edges silently.)
 *
 * Each resolved package is identified by realpath, so a hoisting conflict
 * (bun nests a second copy of a package under whichever consumer needed a
 * different version — see `string-width`, `chalk`, `parse5`, `emoji-regex`,
 * `strip-ansi`, `ansi-regex` in this tree) still dedupes to one notice per
 * distinct name@version, not one per physical copy.
 *
 * Run: `bun run gen-licenses` (writes THIRD-PARTY-LICENSES.txt at the repo
 * root). Regenerate after any dependency change — this file is generated,
 * not hand-maintained.
 *
 * `--check` (used by `bun run verify` / WP-1) renders to memory and compares
 * against the file already on disk, exiting non-zero on any mismatch or on a
 * missing file, without writing anything — so a failing local run never
 * leaves the working tree dirty. The default (no flag) still writes, exactly
 * as before.
 *
 * **Why that check is a real gate, and not redundant with the unit tests.**
 * Going stale is a licence-compliance failure rather than a cosmetic one: add
 * a dependency, forget to regenerate, and the published repo ships
 * attribution that omits a package it actually redistributes. The generator
 * is deterministic — no timestamps, sorted, deduped — so rendering and
 * comparing is a real gate rather than a coin flip. And the distinction that
 * makes it irreplaceable: `tests/licenses.test.ts` asserts that specific
 * notices are *present*; **only this catches absence.** That reasoning lived
 * in `.github/workflows/ci.yml` until WP-1 collapsed the per-gate steps into
 * `bun run verify`; it moved here, to the code that now owns the check,
 * rather than being deleted along with the step that used to carry it.
 *
 * No filesystem path is ever written to the output. This repo is published
 * and grew up next to private ones; every off-the-shelf license aggregator
 * happily embeds `/home/<user>/.../node_modules/<pkg>/LICENSE` into its
 * output, which is exactly the leak `tests/helpers/containment.ts` exists to
 * catch. Every reference below is a bare `name@version`, nothing more.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  licenseFile: string;
  licenseText: string;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Node-style resolution: `<fromDir>/node_modules/<name>`, then walk up to ROOT. */
function resolvePackageDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === ROOT) return null;
    dir = dirname(dir);
  }
}

// Checked in this order; first match wins. Covers every package observed in
// this tree's closure (verified: all 49 resolve one of these).
const LICENSE_FILE_CANDIDATES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "license",
  "license.md",
  "license.txt",
  "LICENSE-MIT",
  "LICENSE-MIT.txt",
  "COPYING",
];

function findLicenseFile(dir: string): { name: string; text: string } | null {
  const entries = new Set(readdirSync(dir));
  for (const candidate of LICENSE_FILE_CANDIDATES) {
    if (entries.has(candidate)) {
      return { name: candidate, text: readFileSync(join(dir, candidate), "utf8").trimEnd() };
    }
  }
  return null;
}

const visited = new Map<string, PackageInfo>();

function visit(name: string, fromDir: string): void {
  const dir = resolvePackageDir(name, fromDir);
  if (!dir) {
    throw new Error(
      `gen-licenses: cannot resolve "${name}" in the runtime closure — run "bun install" first`,
    );
  }
  const real = realpathSync(dir);
  const pkg = readJson(join(real, "package.json")) as { name: string; version: string; license?: string };
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;

  const license = findLicenseFile(real);
  if (!license) {
    throw new Error(`gen-licenses: no LICENSE-shaped file found for ${key} — cannot generate a verbatim notice`);
  }

  visited.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? "UNKNOWN",
    licenseFile: license.name,
    licenseText: license.text,
  });

  const pkgFull = readJson(join(real, "package.json")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const deps = { ...(pkgFull.dependencies ?? {}), ...(pkgFull.optionalDependencies ?? {}) };
  for (const depName of Object.keys(deps)) {
    visit(depName, real);
  }
}

const rootPkg = readJson(join(ROOT, "package.json")) as { dependencies: Record<string, string> };
for (const depName of Object.keys(rootPkg.dependencies)) {
  visit(depName, ROOT);
}

const packages = [...visited.values()].sort((a, b) =>
  a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
);

// Notices called out by AGENTS.md's "Dependencies (WP-5)" as needing more than a
// bare SPDX id. `marked`'s package.json declares "license": "MIT", but its own
// LICENSE.md grants two separate things: MIT for marked itself, and a second,
// separate BSD-3-style license (with its own no-endorsement clause) for John
// Gruber's original Markdown spec. No single SPDX identifier covers both, which is
// why aggregation tooling calls this NOASSERTION rather than "MIT" — the declared
// field undercounts the grant. Both halves are reproduced in full below, verbatim
// from marked's own LICENSE.md (nothing paraphrased, nothing summarized).
const NOASSERTION_NOTES: Record<string, string> = {
  marked:
    'NOASSERTION — package.json declares "MIT", but LICENSE.md grants two separate ' +
    "licenses: MIT for marked itself, and a second, BSD-3-style license (with its " +
    "own no-endorsement clause) for John Gruber's original Markdown. Both are " +
    "reproduced in full below, verbatim from marked's own LICENSE.md.",
};

const lines: string[] = [];
lines.push("Third-party licenses for mdview (crucible-tui)");
lines.push("=".repeat(48));
lines.push("");
lines.push(
  "Generated by scripts/gen-licenses.ts from the installed runtime dependency " +
    'closure — this package\'s "dependencies", resolved transitively through each ' +
    'dependency\'s own "dependencies" and "optionalDependencies" — never from all of ' +
    "node_modules, which also holds devDependency tooling that never ships. " +
    "Regenerate after any dependency change: `bun run gen-licenses`. Do not hand-edit " +
    "below this header.",
);
lines.push("");
lines.push(`${packages.length} packages in the runtime closure.`);
lines.push("");
lines.push("-".repeat(48));

for (const pkg of packages) {
  const key = `${pkg.name}@${pkg.version}`;
  const note = NOASSERTION_NOTES[pkg.name];
  lines.push("");
  lines.push(key);
  lines.push(`License: ${note ? "NOASSERTION" : pkg.license}`);
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push(pkg.licenseText);
  lines.push("");
  lines.push("-".repeat(48));
}

const output = `${lines.join("\n")}\n`;
const targetPath = join(ROOT, "THIRD-PARTY-LICENSES.txt");

if (process.argv.includes("--check")) {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  if (existing === output) {
    console.log(`gen-licenses --check: THIRD-PARTY-LICENSES.txt is current (${packages.length} packages)`);
  } else {
    console.error(
      existing === null
        ? 'gen-licenses --check: THIRD-PARTY-LICENSES.txt does not exist — run "bun run gen-licenses" to generate it.'
        : 'gen-licenses --check: THIRD-PARTY-LICENSES.txt is stale — run "bun run gen-licenses" and commit the result.',
    );
    process.exit(1);
  }
} else {
  await Bun.write(targetPath, output);
  console.log(`gen-licenses: wrote THIRD-PARTY-LICENSES.txt (${packages.length} packages)`);
}
