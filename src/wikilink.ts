/**
 * Wiki-link recognition, carrier marking, and the post-walk styling pass.
 * WP-4 of `plans/colour-policy.md`.
 *
 * ## What changed, and what deliberately did not
 *
 * Obsidian wiki-links aren't markdown, so this tool rewrites them in a line-by-line
 * pre-pass over the source *before* `marked`'s lexer sees it. That much is unchanged.
 * What changed is **emission only**: `styleWikiLink` (`src/render.ts`, deleted here) put
 * `\x1b[36m\x1b[4m` … `\x1b[24m\x1b[39m` — a hardcoded cyan-plus-underline SGR pair —
 * into the markdown source, at **every** colour level including colourless. That made it
 * the last escape producer in the repo outside the styling authority, and the only one
 * whose bytes entered the lexer:
 *
 * - it emitted colour on a plain `mdview note.md | cat`, which is exactly what Decision 1
 *   of `plans/colour-policy.md` forbids ("default non-TTY stdout: zero tool-generated
 *   escape bytes");
 * - it emitted a style pair this repo's committed style table (`src/style.ts`) never
 *   authorized, bypassing the one gate that is supposed to decide;
 * - and it put tool-generated escapes into the *lexer input*, so every downstream claim
 *   about "what the lexer sees" had to carve out an exception for it.
 *
 * The replacement is the same idiom the two existing sentinels already use
 * (`SENTINEL` = code point 0, `TASK_STATE_SENTINEL` = code point 1, both in
 * `src/render.ts`): a **carrier pair** of control characters, code points 2 and 3, marking
 * where a wiki-link's label starts and ends. The pre-pass emits carriers; the fully
 * rendered document is walked once afterwards, each balanced pair is styled through
 * `applyStyle` under the resolved policy, and the carriers are removed. Colourless output
 * loses the escape bytes and keeps every visible character.
 *
 * **Control characters, not zero-width Unicode**, for the reason `TASK_STATE_SENTINEL`
 * records at length: the ASCII glyph tier exists for terminals that cannot render UTF-8,
 * and every gate here measures display *width* rather than code points, so an "invisible"
 * U+200B would be three bytes of exactly the thing that tier avoids and nothing would
 * have caught it.
 *
 * ## Recognition semantics are frozen
 *
 * `WIKI_LINK` below is byte-for-byte the regex `src/render.ts` carried, and it is applied
 * exactly as it was: line by line, skipped inside fenced blocks by `preprocessBody`'s own
 * `FENCE_LINE` toggle. Its consequences are **pinned as expected outputs rather than
 * discovered** (`tests/wikilink.test.ts`): a multiline alias does not match and continues
 * not to; an alias containing a Markdown link does not match, because the alias group is
 * `[^\]]+` and such an alias contains `]`; malformed input passes through unchanged; and
 * `![[embed]]` keeps its `embed: label` rendering. Anything about *which* text is a
 * wiki-link is a separate, deliberate change nobody has asked for.
 *
 * The regex is deliberately the same one an in-house web markdown renderer already uses
 * against the same corpus — same pattern, terminal styling instead of an HTML `<span>`.
 * Two documents rendered by two tools must decide what a wiki-link *is* the same way, or
 * they disagree about the same note. The one addition is the leading optional `!` group,
 * to catch Obsidian's `![[embed]]` syntax, which that renderer's pattern does not
 * recognize at all.
 */
import { type ColourGate, applyStyle, createStyler } from "./style";

/**
 * The label carriers: code points 2 (`STX`) and 3 (`ETX`), chosen for the same reason the
 * other two sentinels chose 0 and 1 — distinct code points, so a bug in one strip pass can
 * never interact with another's bookkeeping, and control characters that have no
 * legitimate place in markdown source.
 *
 * `src/ansi.ts`'s scanner classifies both as ordinary `text` (pinned in
 * `tests/ansi.test.ts` for code points 0 and 1, and here for 2 and 3), which is correct:
 * a carrier is **not** a terminal sequence. It is also zero display columns to
 * `src/width.ts`'s `Measure` — asserted in `tests/wikilink.test.ts` — so a label wrapped
 * by `src/wrap.ts` occupies exactly the columns its visible text does, which is what makes
 * the colourless render's visible text unmovable by this change.
 */
export const WIKI_LINK_OPEN = String.fromCharCode(2);
export const WIKI_LINK_CLOSE = String.fromCharCode(3);

/**
 * The wiki-link pattern, moved here from `src/render.ts:41` **verbatim** — see the
 * "Recognition semantics are frozen" note above. Exported so a test can assert the
 * recognition boundary directly rather than inferring it from rendered output.
 */
export const WIKI_LINK = /(!)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/**
 * Cyan + underline — `chalk.cyan.underline`, the chain whose `openAll`/`closeAll` are
 * exactly the four codes `styleWikiLink` hardcoded (`\x1b[36m\x1b[4m` / `\x1b[24m\x1b[39m`,
 * per `plans/mdview.md` WP-2's original suggestion). Built through `src/style.ts`'s
 * committed table, so the bytes are now the authority's rather than this file's.
 */
const WIKI_LINK_STYLE = createStyler("underline", createStyler("cyan"));

/**
 * Remove every carrier, unconditionally.
 *
 * Two callers, and the reasoning is the same one `stripSentinelChar` gives: a control
 * character has no legitimate place in markdown source, so stripping it from the incoming
 * document (`preprocessBody`) means a hostile or merely odd file cannot **forge** a styled
 * span; and stripping it from the rendered document means nothing invisible-but-present
 * ever reaches a terminal, whatever shape the carriers ended up in.
 */
export function stripWikiLinkCarriers(text: string): string {
  if (!text.includes(WIKI_LINK_OPEN) && !text.includes(WIKI_LINK_CLOSE)) return text;
  return text.split(WIKI_LINK_OPEN).join("").split(WIKI_LINK_CLOSE).join("");
}

/** Wrap a wiki-link's label in carriers. The entire emission side of the pre-pass. */
export function markWikiLink(label: string): string {
  return `${WIKI_LINK_OPEN}${label}${WIKI_LINK_CLOSE}`;
}

/**
 * Apply `WIKI_LINK` to one source line, emitting carriers. Callers own the fence toggle.
 *
 * `![[target]]` renders as `embed: label` rather than dropping the `!` on the floor (the
 * plain-link case, `bang === undefined`, is unchanged — no glyph either way, since this
 * must read identically under both glyph tiers and needs no capability detection). The
 * `embed: ` prefix sits **outside** the carriers, exactly where it sat outside the SGR
 * pair before, so its bytes do not move.
 */
export function markWikiLinks(line: string): string {
  return line.replace(WIKI_LINK, (_match, bang: string | undefined, slug: string, alias?: string) => {
    const label = markWikiLink(alias ?? slug);
    return bang === undefined ? label : `embed: ${label}`;
  });
}

/**
 * The post-walk pass: style each **balanced** carrier pair and remove every carrier.
 *
 * Runs over the fully rendered document, after the walk and after `extractCodeRanges` —
 * carriers are not newlines, so they cannot shift a code range's line numbers, and this
 * pass adds none either — and **before** `stripEmojiTrailingSpace`, which is the ordering
 * the plan specifies and which is load-bearing: that pass's regex tolerates trailing SGR
 * (`TRAILING_ANSI_SGR_SOURCE`) but knows nothing about carriers, so a carrier surviving
 * into it would suppress the strip in colourless mode only and split the two colour modes
 * apart on a line this change is not allowed to move.
 *
 * **Unbalanced carriers degrade to stripping, never to leaked bytes.** An opener with no
 * closer, a closer with no opener, and a second opener inside an open span are all simply
 * removed; the visible text survives unstyled. That is the safe direction: the failure a
 * carrier scheme must not have is emitting a half-open style pair into a terminal.
 *
 * Styling is `applyStyle` — the same emitter every other producer uses, gated on the
 * resolved policy — rather than a literal pair, which is the whole point of the package.
 * Two consequences follow from that and are deliberate:
 *
 * - a label whose rendered text carries a **nested** style that closes with one of this
 *   chain's own close codes (`\x1b[24m`, `\x1b[39m`) gets that code re-opened, per
 *   `chalk`'s `applyStyle`; the hardcoded pair left the rest of the label unstyled;
 * - a label that a wrap split across lines is **encased** — closed before each newline and
 *   reopened after — where the hardcoded pair emitted one open at the start and one close
 *   at the end regardless.
 *
 * Both make the wiki-link behave like every other styled span in the renderer. Neither can
 * move a visible character, since both only ever insert escape bytes, and neither can fire
 * at all with the policy off.
 */
export function styleWikiLinkCarriers(text: string, gate: ColourGate): string {
  if (!text.includes(WIKI_LINK_OPEN) && !text.includes(WIKI_LINK_CLOSE)) return text;

  let out = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(WIKI_LINK_OPEN, cursor);
    if (open === -1) {
      out += stripWikiLinkCarriers(text.slice(cursor));
      break;
    }
    // Anything before the opener is ordinary text — plus, possibly, an orphaned closer.
    out += stripWikiLinkCarriers(text.slice(cursor, open));

    const close = text.indexOf(WIKI_LINK_CLOSE, open + 1);
    if (close === -1) {
      // Orphaned opener: no pair, so no style. Keep the label's characters, drop the mark.
      out += stripWikiLinkCarriers(text.slice(open + 1));
      break;
    }

    out += applyStyle(gate, WIKI_LINK_STYLE, stripWikiLinkCarriers(text.slice(open + 1, close)));
    cursor = close + 1;
  }
  return out;
}
