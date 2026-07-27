import { Marked } from "marked";
import type { Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import { renderTable } from "./table";
import { formatMetaBlock, splitFrontmatter } from "./frontmatter";

// Obsidian wiki-links aren't markdown; style them before parsing so they render as
// recognizable links-to-nowhere instead of literal brackets. Adapted from
// example_tracker/apps/web/src/markdown.ts:7 (WIKI_LINK) — same regex, ANSI output
// instead of an HTML <span>.
const WIKI_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

// Obsidian's custom checkbox states aren't GFM tasklist syntax — marked's tasklist
// extension only recognizes " ", "x", "X". Adapted from
// example_tracker/apps/web/src/markdown.ts:15 (TASK_STATE_LINE) and :18-42
// (TASK_STATES), mapping to terminal glyphs instead of lucide icon markers (there is
// no DOM here to mount SVGs into).
const TASK_STATE_LINE = /^(\s*[-*+]\s+)\[(.)\](\s)/;

// Line-by-line pre-pass with a fence toggle, adapted from
// example_tracker/apps/web/src/markdown.ts:16 (FENCE_LINE), so neither rewrite runs
// inside a fenced code block. The web renderer only guards its task-state pass this
// way (see markdown.ts:45-46, which notes the wiki-link pass has "the same latent
// gap"); this tool closes that gap for both passes, since the corpus commonly quotes
// `[[slug]]` inside fenced example commands.
const FENCE_LINE = /^\s*(```|~~~)/;

const TASK_GLYPHS: Record<string, string> = {
  " ": "○",
  x: "✓",
  X: "✓",
  "/": "◐",
  "-": "✗",
  ">": "➤",
  "<": "◷",
  "?": "?",
  "!": "!",
  "*": "★",
  '"': "❝",
  l: "📍",
  b: "🔖",
  i: "ℹ",
  S: "🐖",
  I: "💡",
  p: "👍",
  c: "👎",
  f: "🔥",
  k: "🔑",
  w: "🏆",
  u: "⬆",
  d: "⬇",
};

function styleWikiLink(label: string): string {
  // cyan + underline, per the plan's suggestion (plans/mdview.md WP-2).
  return `\x1b[36m\x1b[4m${label}\x1b[24m\x1b[39m`;
}

function rewriteTaskState(line: string): string {
  const match = TASK_STATE_LINE.exec(line);
  if (!match) return line;

  const [full, prefix, char, gap] = match;
  // noUncheckedIndexedAccess: capture groups type as string | undefined even though
  // the outer regex guarantees them once `match` is non-null.
  if (full === undefined || prefix === undefined || char === undefined || gap === undefined) {
    return line;
  }

  const glyph = TASK_GLYPHS[char];
  if (glyph === undefined) return line;

  return `${prefix}${glyph}${gap}${line.slice(full.length)}`;
}

function preprocessBody(body: string): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (FENCE_LINE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      const withTaskState = rewriteTaskState(line);
      return withTaskState.replace(
        WIKI_LINK,
        (_match, slug: string, alias?: string) => styleWikiLink(alias ?? slug),
      );
    })
    .join("\n");
}

/**
 * Render a markdown document to ANSI for the terminal: the frontmatter block (when
 * present) as a readable metadata block, followed by the rendered prose body. Wires
 * `marked` + `marked-terminal`, overriding the `table` renderer with WP-3's
 * `renderTable` — `marked-terminal`'s own table renderer never receives the terminal
 * width and must not be left in place.
 */
export function renderDocument(source: string, targetWidth: number): string {
  const { meta, body } = splitFrontmatter(source);
  const metaBlock = meta !== null ? `${formatMetaBlock(meta, targetWidth)}\n\n` : "";

  const processedBody = preprocessBody(body);

  const instance = new Marked();
  const extension = markedTerminal({ width: targetWidth, reflowText: true });
  if (extension.renderer) {
    extension.renderer.table = (token: Tokens.Table) => renderTable(token, targetWidth);
  }
  instance.use(extension);

  const rendered = instance.parse(processedBody, { async: false });
  return `${metaBlock}${rendered}`;
}
