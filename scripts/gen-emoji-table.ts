/**
 * Generates `crates/mdview/src/emoji_data.rs` from node-emoji's own name map (WP-3 of
 * `plans/mdview-rust-port.md`, Dependency posture "Emoji"), so the Rust port's shortcode set
 * matches `nodeEmoji.get` by construction.
 *
 * Input: `node-emoji@2.2.0` (`node_modules/node-emoji/lib/index.js`), whose name map is
 * `emojilib@2.4.0`'s `emojis.json` — enumerated through node-emoji's public `search("")` and
 * confirmed entry by entry through `get(":name:")`, the exact call `TS_BASELINE` `src/inline.ts` makes. Only
 * names the inline pass can ever ask for are kept: `insertEmojis`'s capture class is
 * `[A-Za-z0-9_\-+]+`, so any other name is unreachable.
 *
 * Usage: `bun run scripts/gen-emoji-table.ts` (writes) or `--check` (exits 1 if stale).
 * A leaf: imports nothing from `scripts/`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as nodeEmoji from "node-emoji";

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log("usage: bun run scripts/gen-emoji-table.ts [--check]\n\nRegenerate the emoji table (writes), or with --check exit 1 if it is stale (writes nothing).");
  process.exit(0);
}

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "crates/mdview/src/emoji_data.rs");
const version = (JSON.parse(readFileSync(join(ROOT, "node_modules/node-emoji/package.json"), "utf8")) as {
  version: string;
}).version;
if (version !== "2.2.0") throw new Error(`gen-emoji-table: expected node-emoji 2.2.0, found ${version}`);

const REACHABLE = /^[A-Za-z0-9_\-+]+$/;
const entries = new Map<string, string>();
for (const { name } of nodeEmoji.search("")) {
  if (!REACHABLE.test(name)) continue;
  const glyph = nodeEmoji.get(`:${name}:`);
  if (glyph) entries.set(name, glyph);
}
const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const rustString = (s: string): string =>
  `"${[...s].map((c) => (/^[\x20-\x7e]$/.test(c) && c !== '"' && c !== "\\" ? c : `\\u{${(c.codePointAt(0) as number).toString(16)}}`)).join("")}"`;

const body = [
  "//! node-emoji's shortcode name map, generated — do not edit.",
  "//!",
  `//! Input: node-emoji@${version} (\`node_modules/node-emoji/lib/index.js\`, name map from`,
  "//! emojilib@2.4.0 `emojis.json`), every name matching `[A-Za-z0-9_\\-+]+` (the only names",
  "//! `TS_BASELINE` `src/inline.ts`'s `insertEmojis` can capture), resolved through `nodeEmoji.get`.",
  "//! Generator: `bun run scripts/gen-emoji-table.ts` (`--check` verifies it is current).",
  "",
  "/// `(name, glyph)`, sorted by name bytes for binary search.",
  "pub const EMOJI: &[(&str, &str)] = &[",
  ...sorted.map(([name, glyph]) => `    (${rustString(name)}, ${rustString(glyph)}),`),
  "];",
  "",
  "/// `nodeEmoji.get(name)` for a bare name (colons already removed).",
  "pub fn get(name: &str) -> Option<&'static str> {",
  "    EMOJI",
  "        .binary_search_by(|(n, _)| n.as_bytes().cmp(name.as_bytes()))",
  "        .ok()",
  "        .map(|i| EMOJI[i].1)",
  "}",
  "",
].join("\n");

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== body) {
    console.error("gen-emoji-table: crates/mdview/src/emoji_data.rs is stale; run bun run scripts/gen-emoji-table.ts");
    process.exit(1);
  }
  console.log(`gen-emoji-table: up to date (${sorted.length} names)`);
} else {
  writeFileSync(OUT, body);
  console.log(`gen-emoji-table: wrote ${sorted.length} names`);
}
