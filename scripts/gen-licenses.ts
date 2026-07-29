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
 * unconditionally whenever a cell style property is set, and mdview's
 * `src/table.ts` does set style properties — so it ships real code and
 * must be reproduced like any other dependency, not waved through as
 * merely suggested.
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
await Bun.write(join(ROOT, "THIRD-PARTY-LICENSES.txt"), output);
console.log(`gen-licenses: wrote THIRD-PARTY-LICENSES.txt (${packages.length} packages)`);
