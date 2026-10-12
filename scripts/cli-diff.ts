/**
 * The CLI differential (WP-8 of `plans/mdview-rust-port.md`): one argv × env matrix run
 * against both CLIs, comparing stdout, stderr and exit code — and, for `highlight-as`, the
 * config file bytes it leaves behind.
 *
 * Sides: TS is `bun run src/cli.ts`; Rust is the release musl binary
 * `target/x86_64-unknown-linux-musl/release/mdview` (`bun run build:rust`), or the path in
 * `--rust <path>`. Every case runs with a scrubbed environment (`PATH` only) plus its own
 * env, with `HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` pointed at a per-case temp dir
 * that is rebuilt at the **same path** for each side, so printed paths agree.
 *
 * Classes:
 * - **render-independent** (help, licenses, usage/file errors, `highlight-as`, probe-only):
 *   must match exactly;
 * - **render-dependent**: must match exactly, except that a Rust run reporting the
 *   renderer's `Unimplemented` (`mdview: render: unimplemented`, exit 2) is counted as
 *   `pending-renderer` and not compared. **`pending-renderer` must reach 0 by WP-9.**
 *
 * The pty: `script -qec '<cmd>' /dev/null` (util-linux) for the TTY and hyperlink-ceiling
 * cases. The pty merges stderr into stdout and turns `\n` into `\r\n`; the only
 * normalization applied is `\r\n` → `\n` on pty output, which the pty itself injects. The
 * pager is never run under the pty (a real `less` would wait for a keypress); pty cases pass
 * `--no-pager` or `--check`, and the pager decision is covered by `pager.rs`'s unit tests.
 *
 * Not in the matrix, deliberately: a malformed-JSON config in a render-independent case (the
 * parse message is JavaScriptCore's wording in TS and serde_json's in Rust), and stdout
 * `BrokenPipe` (TS crashes with exit 1; Rust exits 0 quietly — `tests/cli_binary.rs`).
 * The render-dependent "config malformed" case does run. `runSide`'s `maskParse` masks only
 * that parse message's tail, so the render beneath it is still compared byte for byte.
 *
 * A leaf: imports nothing from `scripts/`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const rustFlag = argv.indexOf("--rust");
const RUST =
  rustFlag >= 0 ? resolve(argv[rustFlag + 1] ?? "") : join(ROOT, "target/x86_64-unknown-linux-musl/release/mdview");
const BUN = process.execPath;
const SANDBOX = join(tmpdir(), `mdview-cli-diff-${process.pid}`);

interface Case {
  name: string;
  args: string[];
  env?: Record<string, string>;
  dependent?: boolean;
  pty?: boolean;
  config?: string;
  readConfig?: boolean;
}

const fx = (name: string): string => join(ROOT, "tests/fixtures", name);
const UNREADABLE = join(SANDBOX, "unreadable.md");
const WIDE = fx("wide-table.md");
const NARROW = { MDVIEW_AMBIGUOUS: "narrow" };

const cases: Case[] = [];
const ind = (name: string, args: string[], extra: Partial<Case> = {}): void => {
  cases.push({ name, args, ...extra });
};
const dep = (name: string, args: string[], extra: Partial<Case> = {}): void => {
  cases.push({ name, args, dependent: true, ...extra });
};

// --- render-independent -------------------------------------------------------------
for (const args of [
  ["--help"], ["-h"], ["help"], ["help", "view"], ["help", "help"], ["help", "highlight-as"], ["help", "probe"],
  ["view", "--help"], ["highlight-as", "--help"], ["highlight-as", "x", "-h"], ["probe", "--help"], ["probe", "-h"],
  ["--licenses"], ["--licenses", "--width", "80"], ["--help", "--licenses"], ["view", "--licenses"],
  ["--help", "--check", "--ascii", "--no-pager", "--plain", "--color=never", "--hyperlinks=always"],
]) ind(`ok ${args.join(" ")}`, args);
for (const args of [
  [], [""], ["view"], ["help", "nope"], ["--bogus"], ["-"], ["a.md", "b.md"], ["", "b.md"],
  ["--ascii", "--unicode", "x.md"], ["--unicode", "--ascii", "x.md"], ["--color=bad", "x.md"], ["--color=", "x.md"],
  ["--hyperlinks=sometimes", "x.md"], ["--width"], ["--width", "", "x.md"], ["--width", "0", "x.md"],
  ["--width", "-5", "x.md"], ["--width", "abc", "x.md"], ["--width", "--check", "x.md"], ["--width", "Infinity", "x.md"],
  ["--help", "--bogus"], ["--check"], ["--no-pager", "--plain"],
  [join(SANDBOX, "missing.md")], [SANDBOX], [UNREADABLE], ["view", join(SANDBOX, "nope.md")],
  [join(SANDBOX, "missing.md"), "--width", "80"],
]) ind(`err ${JSON.stringify(args)}`, args);
// probe-only paths (piped: no live probe, deterministic report)
ind("probe env narrow", ["probe"], { env: NARROW });
ind("probe env wide", ["probe"], { env: { MDVIEW_AMBIGUOUS: "wide", TERM: "xterm", LANG: "C.UTF-8" } });
ind("probe default", ["probe"], { env: { TERM: "screen", TMUX: "1", COLORTERM: "truecolor" } });
ind("probe --probe flag", ["--probe"], { env: NARROW });
ind("probe flags", ["probe", "--refresh", "--no-cache", "--timeout", "0x20"], { env: NARROW });
ind("probe cached", ["probe"], {
  env: { TERM: "xterm" },
  config: undefined,
});
for (const args of [["probe", "--timeout"], ["probe", "--timeout", "0"], ["probe", "--timeout", "x"], ["probe", "--bogus"], ["probe", "extra"]]) {
  ind(`probe err ${args.join(" ")}`, args);
}
// highlight-as: stdout, stderr, exit, and the config file bytes
const HL: Partial<Case> = { readConfig: true };
for (const [name, args, config] of [
  ["hl create", ["highlight-as", "DataView", "JavaScript"], undefined],
  ["hl update preserves keys", ["highlight-as", "tasks", "sql"], '{"emoji":true,"z":2.0,"highlightAs":{"x":1,"a":"sql"},"10":[]}'],
  ["hl overwrite existing", ["highlight-as", "a", "plaintext"], '{"highlightAs":{"a":"sql","b":"javascript"}}'],
  ["hl non-object highlightAs", ["highlight-as", "a", "sql"], '{"highlightAs":"nope","color":"never"}'],
  ["hl refuses array", ["highlight-as", "a", "sql"], "[1,2]"],
  ["hl refuses null", ["highlight-as", "a", "sql"], "null"],
  ["hl refuses number", ["highlight-as", "a", "sql"], "42"],
  ["hl unsupported", ["highlight-as", "a", "nosuchlang"], undefined],
  ["hl empty fence", ["highlight-as", " ", "sql"], undefined],
  ["hl no args", ["highlight-as"], undefined],
  ["hl one arg", ["highlight-as", "a"], undefined],
  ["hl three args", ["highlight-as", "a", "b", "c"], undefined],
  ["hl flag", ["highlight-as", "a", "--x", "b"], undefined],
] as [string, string[], string | undefined][]) {
  ind(name, args, { ...HL, config });
}
ind("pty help", ["--help"], { pty: true });
ind("pty probe env", ["probe"], { pty: true, env: NARROW });

// --- render-dependent ---------------------------------------------------------------
const flagSets: string[][] = [
  ["--check", "--width", "80"], ["--no-pager"], ["--no-pager", "--ascii"], ["--no-pager", "--unicode"],
  ["--no-pager", "--color"], ["--no-pager", "--no-color"], ["--no-pager", "--plain"], ["--no-pager", "--hyperlinks"],
  ["--no-pager", "--color=always", "--hyperlinks=always"], ["--width", "0x50", "--check"], ["--check", "--width", "20"],
  ["--width", "40"], ["view", "--no-pager"],
];
for (const flags of flagSets) dep(`render ${flags.join(" ")}`, flags[0] === "view" ? [...flags, WIDE] : [WIDE, ...flags], { env: NARROW });
for (const [name, env] of [
  ["NO_COLOR", { NO_COLOR: "" }], ["FORCE_COLOR=3", { FORCE_COLOR: "3" }], ["FORCE_COLOR=0", { FORCE_COLOR: "0" }],
  ["TERM=dumb", { TERM: "dumb" }], ["TMUX", { TMUX: "/tmp/x,1,0", TERM: "tmux-256color" }],
  ["MDVIEW_GLYPHS=ascii", { MDVIEW_GLYPHS: "ascii" }], ["LANG utf8", { LANG: "en_US.UTF-8" }],
  ["MDVIEW_COLOR=bad", { MDVIEW_COLOR: "bad" }], ["wide unicode", { MDVIEW_AMBIGUOUS: "wide" }],
] as [string, Record<string, string>][]) {
  dep(`env ${name}`, [WIDE, "--no-pager", ...(name === "wide unicode" ? ["--unicode"] : [])], { env: { ...NARROW, ...env } });
}
for (const [name, config] of [
  ["config color", '{"color":"always","hyperlinks":"always"}'], ["config bad keys", '{"color":3,"emoji":"x","highlightAs":[]}'],
  ["config malformed", "{nope"], ["config highlightAs", '{"highlightAs":{"x":"sql"},"corpusManifest":"m.json"}'],
] as [string, string][]) {
  dep(name, [fx("fenced-list.md"), "--no-pager"], { env: NARROW, config });
}
for (const f of ["loose-list.md", "nested-list.md", "blockquote-list.md"]) dep(`fixture ${f}`, [fx(f), "--check", "--width", "80"], { env: NARROW });
dep("pty view", [WIDE, "--no-pager"], { pty: true, env: NARROW });
dep("pty hyperlinks ceiling", [WIDE, "--no-pager", "--hyperlinks=always"], { pty: true, env: { ...NARROW, TERM: "xterm-256color" } });
dep("pty check", [WIDE, "--check", "--width", "80"], { pty: true, env: NARROW });
dep("pty plain", [WIDE, "--no-pager", "--plain"], { pty: true, env: NARROW });

// --- runner -------------------------------------------------------------------------
interface Result {
  stdout: string;
  stderr: string;
  code: number | null;
  config?: string;
}

const shellQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

function runSide(command: string[], c: Case): Result {
  const home = join(SANDBOX, "home");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "mdview"), { recursive: true });
  const configPath = join(home, "mdview", "config.json");
  if (c.config !== undefined) writeFileSync(configPath, c.config);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, ...c.env };
  const full = [...command, ...c.args];
  const result = c.pty
    ? spawnSync("script", ["-qec", full.map(shellQuote).join(" "), "/dev/null"], { env, cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "" })
    : spawnSync(full[0] as string, full.slice(1), { env, cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const norm = (s: string): string => (c.pty ? s.replaceAll("\r\n", "\n") : s);
  // The one engine-worded message: a malformed config's JSON parse error is JavaScriptCore's
  // text in TS and serde_json's in Rust (see the header). Only the message tail after the
  // config path is masked; the warning's prefix, path, exit code and the render stay exact.
  const maskParse = (s: string): string =>
    s.replace(/^(mdview: ignoring malformed config at [^\n]*?config\.json: )[^\n]*$/m, "$1<json parse message>");
  return {
    stdout: norm(result.stdout ?? ""),
    stderr: maskParse(norm(result.stderr ?? "")),
    code: result.status,
    config: c.readConfig && existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined,
  };
}

if (!existsSync(RUST)) {
  process.stderr.write(`cli-diff: Rust binary not found at ${RUST} (run \`bun run build:rust\`)\n`);
  process.exit(2);
}
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(UNREADABLE, "# unreadable\n");
chmodSync(UNREADABLE, 0o000);

let independent = 0;
let independentMatched = 0;
let dependentMatched = 0;
let pending = 0;
const mismatches: string[] = [];
for (const c of cases) {
  const ts = runSide([BUN, "run", join(ROOT, "src/cli.ts")], c);
  const rs = runSide([RUST], c);
  if (!c.dependent) independent += 1;
  const isPending =
    c.dependent && rs.code === 2 && (rs.stderr + rs.stdout).includes("mdview: render: unimplemented");
  if (isPending) {
    pending += 1;
    continue;
  }
  const diffs: string[] = [];
  if (ts.code !== rs.code) diffs.push(`exit ts=${ts.code} rust=${rs.code}`);
  if (ts.stdout !== rs.stdout) diffs.push(`stdout differs\n  ts:   ${JSON.stringify(ts.stdout.slice(0, 300))}\n  rust: ${JSON.stringify(rs.stdout.slice(0, 300))}`);
  if (ts.stderr !== rs.stderr) diffs.push(`stderr differs\n  ts:   ${JSON.stringify(ts.stderr.slice(0, 300))}\n  rust: ${JSON.stringify(rs.stderr.slice(0, 300))}`);
  if (ts.config !== rs.config) diffs.push(`config differs\n  ts:   ${JSON.stringify(ts.config)}\n  rust: ${JSON.stringify(rs.config)}`);
  if (diffs.length > 0) {
    mismatches.push(`[${c.dependent ? "dependent" : "independent"}] ${c.name}\n  ${diffs.join("\n  ")}`);
  } else if (c.dependent) {
    dependentMatched += 1;
  } else {
    independentMatched += 1;
  }
}
chmodSync(UNREADABLE, 0o600);
rmSync(SANDBOX, { recursive: true, force: true });

for (const m of mismatches) process.stdout.write(`${m}\n`);
process.stdout.write(
  `cli-diff: rust=${RUST.slice(ROOT.length + 1)} cases=${cases.length} independent=${independentMatched}/${independent} dependent-matched=${dependentMatched} pending-renderer=${pending} mismatches=${mismatches.length}\n`,
);
process.exit(mismatches.length > 0 ? 1 : 0);
