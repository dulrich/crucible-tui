/**
 * Generate `crates/mdview/src/width/tables.rs` — the data half of the Rust port of
 * `string-width@8.2.2` (WP-2 of `plans/mdview-rust-port.md`, Dependency posture "Width").
 *
 * Two independent provenance inputs, both named in the generated header:
 *
 * (a) **Engine-derived Unicode properties.** Every `\p{…}` class `string-width/index.js`
 *     tests, enumerated by this Bun over U+0000..U+10FFFF into range tables. `RGI_Emoji` is
 *     a property *of strings* and cannot be enumerated by code point; the generator tests
 *     a systematic candidate set against `/^\p{RGI_Emoji}$/v` and keeps only the members
 *     whose first code point is **not** East Asian Wide/Fullwidth — for every other RGI
 *     string the fallback branch of `stringWidth` already yields 2 (wide first scalar, and
 *     no RGI string carries a Spacing_Mark or a U+FF00..U+FFEF trailer), so membership
 *     cannot change the width. Candidates: every scalar; every scalar + U+FE0F; the twelve
 *     keycaps; every Emoji_Modifier_Base + each modifier; every regional-indicator pair; and
 *     every two-element ZWJ sequence whose first element starts with a non-wide Emoji
 *     scalar. A missed longer ZWJ sequence still falls under string-width's own
 *     "2+ Extended_Pictographic" rule.
 * (b) **`get-east-asian-width@1.6.0`'s `lookup.js`** range data, read through its own
 *     `isFullWidth`/`isWide`/`isAmbiguous` predicates.
 *
 * Usage: `bun run scripts/gen-width-tables.ts [--check]`. A leaf: imports nothing from
 * `scripts/`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- untyped private module of a locked transitive dependency
import { isAmbiguous, isFullWidth, isWide } from "../node_modules/get-east-asian-width/lookup.js";
// @ts-expect-error -- untyped fleet build-id helper
import { handleBuildFlags } from "./build-id.mjs";

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log("usage: bun run scripts/gen-width-tables.ts [--check]\n\nRegenerate the width tables (writes), or with --check exit 1 if they are stale (writes nothing).");
  process.exit(0);
}
const buildRc = handleBuildFlags(process.argv.slice(2), { path: import.meta.filename, name: "gen-width-tables.ts" });
if (buildRc !== null) process.exit(buildRc);

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "crates/mdview/src/width/tables.rs");
const EAW_VERSION = JSON.parse(
  readFileSync(join(ROOT, "node_modules/get-east-asian-width/package.json"), "utf8"),
).version as string;
if (EAW_VERSION !== "1.6.0") throw new Error(`get-east-asian-width is ${EAW_VERSION}, expected 1.6.0`);

const MAX = 0x10ffff;
const ch = (cp: number): string => String.fromCodePoint(cp);

function ranges(test: (cp: number) => boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let cp = 0; cp <= MAX + 1; cp += 1) {
    const hit = cp <= MAX && test(cp);
    if (hit && start < 0) start = cp;
    if (!hit && start >= 0) {
      out.push([start, cp - 1]);
      start = -1;
    }
  }
  return out;
}

const property = (name: string) => {
  const re = new RegExp(`^\\p{${name}}$`, "v");
  return (cp: number) => re.test(ch(cp));
};

const zeroWidth = (() => {
  const re = new RegExp(
    String.raw`^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Nonspacing_Mark}\p{Enclosing_Mark}\p{Surrogate}]$`,
    "v",
  );
  return (cp: number) => re.test(ch(cp));
})();
const eawWide = (cp: number): boolean => isFullWidth(cp) || isWide(cp);

const ZERO = ranges(zeroWidth);
const SPACING = ranges(property("Spacing_Mark"));
const EXTPICT = ranges(property("Extended_Pictographic"));
const WIDE = ranges(eawWide);
const AMBIGUOUS = ranges((cp) => isAmbiguous(cp));

// RGI_Emoji candidates (input a, strings).
const rgi = new RegExp(String.raw`^\p{RGI_Emoji}$`, "v");
const isEmoji = property("Emoji");
const isModBase = property("Emoji_Modifier_Base");
const MODIFIERS = [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff].map(ch);
const found = new Set<string>();
const consider = (s: string) => {
  if (rgi.test(s) && !eawWide(s.codePointAt(0) as number)) found.add(s);
};
const elements: string[] = [];
const narrowFirstElements: string[] = [];
for (let cp = 0; cp <= MAX; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = ch(cp);
  consider(c);
  consider(c + "️");
  if (!isEmoji(cp)) continue;
  const forms = [c, c + "️"];
  if (isModBase(cp)) for (const m of MODIFIERS) forms.push(c + m);
  for (const f of forms) {
    consider(f);
    elements.push(f);
    if (!eawWide(cp)) narrowFirstElements.push(f);
  }
}
for (const k of "0123456789#*") consider(`${k}️⃣`);
for (let a = 0x1f1e6; a <= 0x1f1ff; a += 1) for (let b = 0x1f1e6; b <= 0x1f1ff; b += 1) consider(ch(a) + ch(b));
for (const first of narrowFirstElements) for (const second of elements) consider(`${first}‍${second}`);
const RGI = [...found].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));

const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;
const table = (name: string, doc: string, rs: Array<[number, number]>) =>
  `/// ${doc} (${rs.length} ranges)\npub const ${name}: &[(u32, u32)] = &[\n${rs
    .map(([a, b]) => `    (${hex(a)}, ${hex(b)}),`)
    .join("\n")}\n];\n`;
const rustStr = (s: string) =>
  `"${[...s].map((c) => `\\u{${(c.codePointAt(0) as number).toString(16)}}`).join("")}"`;

const text = `// @generated by \`bun run scripts/gen-width-tables.ts\` — do not edit by hand.
//
// Provenance (two independent inputs, plans/mdview-rust-port.md "Width"):
//   (a) engine-derived Unicode properties: Bun ${Bun.version}, Unicode ${process.versions.unicode}, ICU ${process.versions.icu};
//       classes Default_Ignorable_Code_Point, Control, Format, Nonspacing_Mark, Enclosing_Mark,
//       Surrogate, Spacing_Mark, Extended_Pictographic, RGI_Emoji (strings; candidate-tested,
//       non-wide-first members only — see the generator's header), enumerated over U+0000..U+10FFFF;
//   (b) node_modules/get-east-asian-width/lookup.js @ ${EAW_VERSION} (isFullWidth || isWide; isAmbiguous).
// Consumer: crates/mdview/src/width.rs (the owned port of string-width@8.2.2).

${table("ZERO_WIDTH", "Default_Ignorable | Control | Format | Nonspacing_Mark | Enclosing_Mark | Surrogate", ZERO)}
${table("SPACING_MARK", "Spacing_Mark", SPACING)}
${table("EXTENDED_PICTOGRAPHIC", "Extended_Pictographic", EXTPICT)}
${table("EAW_WIDE", "get-east-asian-width isFullWidth || isWide", WIDE)}
${table("EAW_AMBIGUOUS", "get-east-asian-width isAmbiguous", AMBIGUOUS)}
/// RGI_Emoji members whose first scalar is not EAW wide/fullwidth, sorted by UTF-8 bytes (${RGI.length} strings)
pub const RGI_NARROW_FIRST: &[&str] = &[
${RGI.map((s) => `    ${rustStr(s)},`).join("\n")}
];
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT, "utf8");
  if (current !== text) {
    console.error(`gen-width-tables: ${OUT} is stale; re-run without --check`);
    process.exit(1);
  }
  console.log("gen-width-tables: up to date");
} else {
  writeFileSync(OUT, text);
  console.log(
    `gen-width-tables: wrote ${OUT} (zero ${ZERO.length}, mc ${SPACING.length}, extpict ${EXTPICT.length}, wide ${WIDE.length}, ambiguous ${AMBIGUOUS.length}, rgi ${RGI.length}; elements ${elements.length}/${narrowFirstElements.length})`,
  );
}
