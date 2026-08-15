#!/usr/bin/env bun
/**
 * Emoji shortcode behavioural audit (WP-3, `plans/corpus-symlink-membership.md`).
 *
 * The record in `src/AGENTS.md` and `src/render.ts` describes a test that decided
 * `emoji: false` for `markedTerminal()` — 392 prose shortcodes across 59 files,
 * all reachable only through symlink-following. That test was a throwaway
 * subagent invocation; nothing in the repo could re-run it. This script is that
 * test, committed.
 *
 * **Method, and it is not negotiable — this is what keeps the result from
 * drifting from reality.** For every `:shortcode:`-shaped token found in the
 * corpus, render it twice through `renderDocument` — once with shortcode
 * substitution forced on, once forced off — and keep only tokens whose rendered
 * bytes actually differ. This is a behavioural test, never a `node-emoji` table
 * lookup: consulting a substitution table would only prove the table exists, not
 * what the renderer does with it. Rendering both ways and diffing bytes exercises
 * `src/inline.ts`'s `emojify` itself, so the result cannot drift from what this
 * tool actually ships.
 *
 * **It rendered through bare `marked-terminal` until WP-6 of
 * `plans/marked-terminal-replacement.md`**, which removed that dependency. The
 * substitution it toggled is now this repo's own — same `node-emoji` call, same
 * stray-space defect, reproduced deliberately — and `renderDocument`'s
 * `emojiOverride` parameter is the same on/off decision the library's option was.
 * The change makes the audit stricter rather than looser: it now measures the
 * renderer that ships instead of a library that no longer runs.
 *
 * **Fence-aware, and table-aware for the same reason.** `src/blocks.ts`'s `code`
 * never runs the transform that substitutes shortcodes (a transcription of
 * `marked-terminal`'s own behaviour, kept), so a shortcode on a fenced source line
 * is inert. This repo's `renderTable` (`src/table.ts`) is a second exemption of
 * the identical shape: it renders cell text directly rather than dispatching it
 * through the inline tokenizer substitution hooks into, so a shortcode inside a
 * table cell is *always* inert, independent of the `emoji` decision's value.
 * Neither exemption is assumed — a fenced-context token is rendered inside a
 * fenced snippet and diffed on/off same as prose; a table-context token is
 * rendered inside a one-cell table and checked for literal survival, because
 * there is nothing to toggle there and an on/off diff would report inertness for
 * the wrong reason.
 *
 * **Per-root reporting.** Counts are grouped by corpus (manifest entry), never
 * summed into one figure — summing "the user's own documents" with "vendored
 * dependency READMEs" into one number is exactly what made the original decision
 * wrong (see the plan's Context section).
 *
 * Corpus: read from `MDVIEW_CORPUS_MANIFEST` via the same precedence chain
 * `scripts/sweep.ts` uses (env var, then config key, then the bundled public-safe
 * default) — see `resolveManifestSource`/`resolveCorpusManifestPath`. This script
 * hardcodes no corpus path anywhere in its source; every root name and file path
 * it prints at runtime comes from whatever manifest it is pointed at.
 *
 * **Corpus selection is the sweep's, not a copy of it (WP-4).** This script used to
 * re-implement the sampling predicate — reading `--all` straight off `process.argv` and
 * ignoring `--limit` entirely — so the same flags selected different files here than in
 * `scripts/sweep.ts`, with nothing able to notice. Both now parse with `parseArgs` and
 * select with `selectCorpusFiles`, so `--all`, `--limit` and `--manifest` mean exactly
 * what the sweep documents: `--limit` overrides a corpus's manifest `sample` and, as
 * there, does nothing at all on a corpus that declares none. The sweep's rendering flags
 * (`--widths`, `--glyphs`, `--ambiguous`, `--detect`, the `--max-*` ratchets) parse but
 * have no meaning here — this audit renders each *token*, never the corpus.
 *
 * Usage:
 *   MDVIEW_CORPUS_MANIFEST=/path/to/manifest.json bun run scripts/emoji-audit.ts
 *   bun run scripts/emoji-audit.ts --all       # disable manifest `sample` stride-sampling
 *   bun run scripts/emoji-audit.ts --limit 50  # override a corpus's `sample` (needs one)
 *
 * Re-run against the bundled public-safe default manifest with no env var set —
 * it will just report over the small public corpus instead.
 */
import { readFile } from "node:fs/promises";
import { loadManifest, resolveCorpusFiles, resolveManifestSource, selectCorpusFiles } from "./corpus";
import { parseArgs } from "./sweep";
import { UNICODE_GLYPHS } from "../src/glyphs";
import { renderDocument } from "../src/render";
import { NARROW_MEASURE } from "../src/width";

/** Loose enough to catch every real node-emoji shortcode shape; false positives
 * (a timestamp like `:30:`, a Windows drive-adjacent path) are harmless because
 * the behavioural render is what actually decides — a non-shortcode token simply
 * never differs and is silently excluded from every count below. */
const SHORTCODE_RE = /:[a-z0-9_+-]+:/gi;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s*\|/;

/** `token -> did emoji:true vs emoji:false rendering differ`, keyed by fence
 * context too, since the same token can behave differently fenced vs not. */
const tokenCache = new Map<string, boolean>();
/** `token -> did the literal token text survive this repo's real table renderer`. */
const tableTokenCache = new Map<string, boolean>();

/**
 * Render a snippet through **this repo's own renderer**, with shortcode substitution
 * forced on or off.
 *
 * **This used to construct a bare `marked-terminal` instance** and toggle its `emoji`
 * option; WP-6 of `plans/marked-terminal-replacement.md` removed the dependency, and this
 * is the replacement. The method is unchanged and still behavioural — render twice, diff
 * bytes, never consult a `node-emoji` table — but the renderer being exercised is now the
 * one that actually ships, which is strictly the better question: `emojiOverride` is the
 * same on/off decision the library's option carried, threaded through `LayoutContext` and
 * `src/inline.ts`'s `emojify`, and the fence exemption it is used to test is now this
 * repo's own `renderCode` rather than the library's. The table probe below already worked
 * this way and said so; the two probes now differ only in the snippet they build.
 *
 * Width is irrelevant to the emoji pass, so a fixed 80 is fine, and the glyph tier and
 * measure are pinned explicitly so no environment detection can reach either.
 */
function renderSnippet(snippet: string, emoji: boolean): string {
  return renderDocument(snippet, 80, UNICODE_GLYPHS, NARROW_MEASURE, emoji);
}

function tokenDiffers(token: string, fenced: boolean): boolean {
  const key = `${fenced ? "f" : "p"}:${token}`;
  const cached = tokenCache.get(key);
  if (cached !== undefined) return cached;
  const snippet = fenced ? "```\n" + token + "\n```\n" : token;
  const withEmoji = renderSnippet(snippet, true);
  const withoutEmoji = renderSnippet(snippet, false);
  const differs = withEmoji !== withoutEmoji;
  tokenCache.set(key, differs);
  return differs;
}

/** Does the literal token survive unchanged through this repo's actual table
 * renderer? Not an on/off diff — `renderTable` never dispatches inline tokens
 * regardless of the `emoji` option, so there is nothing to toggle; this checks
 * the claim directly against the real, current render pipeline instead of
 * assuming it. */
function tokenSurvivesTable(token: string): boolean {
  const cached = tableTokenCache.get(token);
  if (cached !== undefined) return cached;
  const table = `| Col |\n| --- |\n| ${token} |\n`;
  const rendered = renderSnippet(table, true);
  const survives = rendered.includes(token);
  tableTokenCache.set(token, survives);
  return survives;
}

export interface FileAudit {
  path: string;
  proseHits: string[];
  fencedHits: string[];
  fencedAnomalies: string[];
  tableHits: string[];
  tableAnomalies: string[];
}

/** Scan one file's raw source for shortcode-shaped tokens, classify each by
 * fence/table/prose context, and behaviourally test each occurrence. */
export async function auditFile(path: string): Promise<FileAudit> {
  const result: FileAudit = {
    path,
    proseHits: [],
    fencedHits: [],
    fencedAnomalies: [],
    tableHits: [],
    tableAnomalies: [],
  };
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    return result;
  }
  let inFence = false;
  for (const line of source.split("\n")) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const matches = line.match(SHORTCODE_RE);
    if (!matches) continue;
    const inTable = !inFence && TABLE_ROW_RE.test(line);
    for (const token of matches) {
      if (inFence) {
        const differs = tokenDiffers(token, true);
        result.fencedHits.push(token);
        // Expected: false. If a fenced token ever differs, the fence exemption
        // this whole decision leans on is not universal — surface it, don't hide it.
        if (differs) result.fencedAnomalies.push(token);
      } else if (inTable) {
        const survives = tokenSurvivesTable(token);
        result.tableHits.push(token);
        // Expected: true (token survives, unsubstituted). If it does not, this
        // repo's table renderer is not the exemption it is documented to be.
        if (!survives) result.tableAnomalies.push(token);
      } else {
        const differs = tokenDiffers(token, false);
        if (differs) result.proseHits.push(token);
      }
    }
  }
  return result;
}

interface RootTally {
  name: string;
  root: string;
  filesScanned: number;
  proseShortcodes: number;
  proseFiles: Set<string>;
  fencedShortcodes: number;
  fencedAnomalies: number;
  tableShortcodes: number;
  tableAnomalies: number;
}

async function main(): Promise<void> {
  const { options } = parseArgs(process.argv.slice(2));
  const { path: manifestPath, source } = await resolveManifestSource(options.manifestFlag);
  const manifest = await loadManifest(manifestPath);
  console.log(`manifest: ${manifestPath} (source=${source}, ${manifest.corpora.length} corpora)`);

  const tallies: RootTally[] = [];
  let totalProse = 0;
  let totalFenced = 0;
  let totalAnomalies = 0;
  let totalTable = 0;
  let totalTableAnomalies = 0;
  const proseFileList: string[] = [];

  for (const spec of manifest.corpora) {
    const files = await resolveCorpusFiles(spec, {});
    if (files === null) {
      console.log(`[${spec.name}] SKIPPED — corpus root not found`);
      continue;
    }
    const selected = selectCorpusFiles(files, spec, options);

    const tally: RootTally = {
      name: spec.name,
      root: spec.root,
      filesScanned: selected.length,
      proseShortcodes: 0,
      proseFiles: new Set(),
      fencedShortcodes: 0,
      fencedAnomalies: 0,
      tableShortcodes: 0,
      tableAnomalies: 0,
    };

    for (const file of selected) {
      const audit = await auditFile(file);
      if (audit.proseHits.length > 0) {
        tally.proseShortcodes += audit.proseHits.length;
        tally.proseFiles.add(file);
        proseFileList.push(`${file} :: ${audit.proseHits.join(", ")}`);
      }
      tally.fencedShortcodes += audit.fencedHits.length;
      tally.fencedAnomalies += audit.fencedAnomalies.length;
      tally.tableShortcodes += audit.tableHits.length;
      tally.tableAnomalies += audit.tableAnomalies.length;
    }

    totalProse += tally.proseShortcodes;
    totalFenced += tally.fencedShortcodes;
    totalAnomalies += tally.fencedAnomalies;
    totalTable += tally.tableShortcodes;
    totalTableAnomalies += tally.tableAnomalies;
    tallies.push(tally);
  }

  console.log("");
  console.log("root | files | prose shortcodes (files) | fenced (inert) | fenced anomalies | table (inert) | table anomalies");
  console.log("---|---|---|---|---|---|---");
  for (const t of tallies) {
    console.log(
      `${t.name} | ${t.filesScanned} | ${t.proseShortcodes} (${t.proseFiles.size}) | ${t.fencedShortcodes} | ${t.fencedAnomalies} | ${t.tableShortcodes} | ${t.tableAnomalies}`,
    );
  }
  console.log("");
  console.log(
    `TOTAL: ${totalProse} prose shortcodes across ${tallies.reduce((n, t) => n + t.proseFiles.size, 0)} files; ` +
      `${totalFenced} fenced (inert) occurrences (${totalAnomalies} anomalies); ` +
      `${totalTable} table-cell (inert) occurrences (${totalTableAnomalies} anomalies).`,
  );

  if (proseFileList.length > 0) {
    console.log("");
    console.log("Prose-shortcode files:");
    for (const line of proseFileList) console.log(`  ${line}`);
  }

  if (totalProse === 0) {
    console.log("");
    console.log("DECISION INPUT: zero authored prose shortcodes found — emoji:false has no content cost here.");
  } else {
    console.log("");
    console.log("DECISION INPUT: authored prose shortcodes exist — emoji:false would change rendered content.");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
