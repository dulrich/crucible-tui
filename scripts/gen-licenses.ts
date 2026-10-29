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
 * skipped, and the case that established the rule is worth keeping now that
 * both packages in it are gone: `cli-table3` declared `@colors/colors` as
 * optional while its own cell code required it unconditionally whenever a
 * style property was set — so an "optional" edge shipped real code, and a
 * walker that skipped optional edges would have published an incomplete
 * notice file. Neither package is in this tree any more. `cli-table3` left
 * with `marked-terminal` (WP-6 of `plans/marked-terminal-replacement.md`),
 * and `@colors/colors` left at WP-2 of `plans/colour-policy.md`, when
 * `TS_BASELINE` `src/table.ts`'s border/head styling moved onto `src/style.ts`'s committed
 * style table — so the direct-ownership note this header used to carry about
 * both is history, not current fact. The rule stays: any dependency may do
 * what `cli-table3` did.
 *
 * Each resolved package is identified by realpath, so a hoisting conflict
 * (bun nests a second copy of a package under whichever consumer needed a
 * different version — `string-width`, `chalk`, `parse5`, `emoji-regex`,
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
// @ts-expect-error -- untyped fleet build-id helper
import { handleBuildFlags } from "./build-id.mjs";

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log("usage: bun run scripts/gen-licenses.ts [--check]\n\nRegenerate THIRD-PARTY-LICENSES.txt (writes), or with --check exit 1 if it is stale (writes nothing).");
  process.exit(0);
}
const buildRc = handleBuildFlags(process.argv.slice(2), { path: import.meta.filename, name: "gen-licenses.ts" });
if (buildRc !== null) process.exit(buildRc);

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
  const deps = { ...pkgFull.dependencies, ...pkgFull.optionalDependencies };
  for (const depName of Object.keys(deps)) {
    visit(depName, real);
  }
}

// Empty since WP-9 of `plans/mdview-rust-port.md`: the renderer is Rust, and every npm package
// left is a devDependency of the scripts. The walk stays, so a runtime dependency added later
// is noticed rather than silently unlisted.
const rootPkg = readJson(join(ROOT, "package.json")) as { dependencies?: Record<string, string> };
for (const depName of Object.keys(rootPkg.dependencies ?? {})) {
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

// --- Cargo runtime closure ---------------------------------------------------

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  license_file: string | null;
  manifest_path: string;
}
interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  resolve: { nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
}

interface CargoInfo {
  name: string;
  version: string;
  license: string;
  licenseText: string | null;
}

function cargoClosure(): CargoInfo[] {
  const proc = Bun.spawnSync(
    ["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", "x86_64-unknown-linux-musl"],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`gen-licenses: cargo metadata failed:\n${new TextDecoder().decode(proc.stderr)}`);
  }
  const meta = JSON.parse(new TextDecoder().decode(proc.stdout)) as CargoMetadata;
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const seen = new Set<string>();
  const queue = [...members];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue;
      if (members.has(dep.pkg) || seen.has(dep.pkg)) continue;
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  // `cargo metadata` unifies features across build and normal edges, so a crate that is also a
  // build-dependency (syntect, for crates/mdview/build.rs) lists its build-only features' deps
  // (yaml-rust) as normal edges. `cargo tree -e normal` resolves the target graph separately;
  // a crate it does not name never ships, and is dropped here.
  const tree = Bun.spawnSync(
    [
      "cargo", "tree", "--locked", "--workspace", "-e", "normal",
      "--target", "x86_64-unknown-linux-musl", "--prefix", "none", "--format", "{p}",
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (tree.exitCode !== 0) {
    throw new Error(`gen-licenses: cargo tree failed:\n${new TextDecoder().decode(tree.stderr)}`);
  }
  const shipped = new Set(
    new TextDecoder()
      .decode(tree.stdout)
      .split("\n")
      .map((l) => /^(\S+) v(\S+)/.exec(l))
      .filter((m) => m !== null)
      .map((m) => `${m[1]}@${m[2]}`),
  );
  const infos = new Map<string, CargoInfo>();
  for (const id of seen) {
    const pkg = byId.get(id);
    if (!pkg) throw new Error(`gen-licenses: cargo metadata names an unknown package id ${id}`);
    if (!shipped.has(`${pkg.name}@${pkg.version}`)) continue;
    const dir = dirname(pkg.manifest_path);
    const files = pkg.license_file
      ? [pkg.license_file]
      : readdirSync(dir)
          .filter((f) => /^(LICEN[CS]E|COPYING)/i.test(f))
          .sort();
    const licenseText =
      files.length > 0 ? files.map((f) => readFileSync(join(dir, f), "utf8").trimEnd()).join("\n\n") : null;
    infos.set(`${pkg.name}@${pkg.version}`, {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      licenseText,
    });
  }
  return [...infos.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

const crates = cargoClosure();

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

lines.push("");
lines.push("=".repeat(48));
lines.push("Cargo (Rust) runtime closure — jsonedit, mdview");
lines.push("=".repeat(48));
lines.push("");
lines.push(
  "Generated from `cargo metadata --filter-platform x86_64-unknown-linux-musl`: normal " +
    "(non-dev, non-build) dependency edges from the workspace members, transitively, " +
    "excluding the members themselves.",
);
lines.push("");
lines.push(`${crates.length} crates in the runtime closure.`);
lines.push("");
lines.push("-".repeat(48));

for (const krate of crates) {
  lines.push("");
  lines.push(`${krate.name}@${krate.version}`);
  lines.push(`License: ${krate.license}`);
  lines.push("");
  lines.push(
    krate.licenseText ??
      `NOTE: this crate ships no licence file in its published package; its declared SPDX licence expression is "${krate.license}".`,
  );
  lines.push("");
  lines.push("-".repeat(48));
}

// --- Vendored grammars (crates/mdview/syntaxes/) ------------------------------
// Each `<Name>.sublime-syntax` is compiled into the mdview binary by its build.rs; its
// notice is the `<Name>.LICENSE.txt` beside it. A grammar without one fails the generator.
const SYNTAX_DIR = join(ROOT, "crates", "mdview", "syntaxes");
const grammars = readdirSync(SYNTAX_DIR)
  .filter((f) => f.endsWith(".sublime-syntax"))
  .sort()
  .map((f) => {
    const name = f.slice(0, -".sublime-syntax".length);
    const notice = join(SYNTAX_DIR, `${name}.LICENSE.txt`);
    if (!existsSync(notice)) throw new Error(`gen-licenses: vendored grammar ${f} has no ${name}.LICENSE.txt`);
    return { name, text: readFileSync(notice, "utf8").trimEnd() };
  });

lines.push("");
lines.push("=".repeat(48));
lines.push("Vendored grammars — mdview");
lines.push("=".repeat(48));
lines.push("");
lines.push(
  "Sublime syntax definitions vendored under crates/mdview/syntaxes/ and compiled into the " +
    "mdview binary; upstream source and commit are recorded in that directory's README.md.",
);
lines.push("");
lines.push(`${grammars.length} vendored grammars.`);
lines.push("");
lines.push("-".repeat(48));

for (const grammar of grammars) {
  lines.push("");
  lines.push(`${grammar.name}.sublime-syntax`);
  lines.push("");
  lines.push(grammar.text);
  lines.push("");
  lines.push("-".repeat(48));
}

// --- Vendored notices (crates/mdview/notices/) -------------------------------
// Code and data ported or generated into the binary from packages outside the Cargo closure
// (string-width, get-east-asian-width, node-emoji/emojilib, highlight.js's alias names, the
// Unicode data licence, two-face's syntax licences). `gen-licenses` never walks
// devDependencies, so none of these would carry over on their own; the directory's README.md
// says what each file covers.
const NOTICE_DIR = join(ROOT, "crates", "mdview", "notices");
const notices = readdirSync(NOTICE_DIR)
  .filter((f) => f.endsWith(".LICENSE.txt"))
  .sort()
  .map((f) => ({ name: f.slice(0, -".LICENSE.txt".length), text: readFileSync(join(NOTICE_DIR, f), "utf8").trimEnd() }));

lines.push("");
lines.push("=".repeat(48));
lines.push("Vendored notices — mdview");
lines.push("=".repeat(48));
lines.push("");
lines.push(
  "Licence texts for code and tables ported or generated into the mdview binary from sources " +
    "outside its Cargo closure; crates/mdview/notices/README.md records what each covers.",
);
lines.push("");
lines.push(`${notices.length} vendored notices.`);
lines.push("");
lines.push("-".repeat(48));

for (const notice of notices) {
  lines.push("");
  lines.push(notice.name);
  lines.push("");
  lines.push(notice.text);
  lines.push("");
  lines.push("-".repeat(48));
}

const counts = `${packages.length} npm packages + ${crates.length} crates + ${grammars.length} vendored grammars + ${notices.length} vendored notices`;
const output = `${lines.join("\n")}\n`;
const targetPath = join(ROOT, "THIRD-PARTY-LICENSES.txt");

if (process.argv.includes("--check")) {
  const existing = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
  if (existing === output) {
    console.log(`gen-licenses --check: THIRD-PARTY-LICENSES.txt is current (${counts})`);
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
  console.log(`gen-licenses: wrote THIRD-PARTY-LICENSES.txt (${counts})`);
}
