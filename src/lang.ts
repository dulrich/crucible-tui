/**
 * Fence-language normalization for syntax highlighting.
 *
 * `marked-terminal` hands a fence's declared language straight to `cli-highlight` (via
 * an internal `highlight()` helper), which does not throw on an unknown language — it
 * logs via `console.error` and carries on, so the `try`/`catch` around it never helps
 * (verified against `marked-terminal`'s `index.js:590`; see the WP-3 execution brief).
 * That message reaches stderr on every unrecognized fence in interactive use — the
 * vault's single largest fence category, `dataviewjs` (280 occurrences), triggers it on
 * every render. This module resolves a declared language to one `cli-highlight` actually
 * supports before it ever reaches that path, so the message never fires.
 */
import { supportsLanguage } from "cli-highlight";

// Locked mapping (user-confirmed, `plans/vault-readiness.md` decision 3): `dataviewjs`
// is plain JavaScript handed to Obsidian's Dataview plugin, so it highlights correctly
// as JS; `dataview` is a SQL-like query language and the user asked for it to highlight
// as SQL on the chance it comes out acceptably. Every other unsupported language (the
// corpus also carries `tasks`, `query`, `mermaid`, and the `ad-*` admonition family)
// needs no entry of its own — the generic `supportsLanguage()` guard below already
// routes anything it doesn't recognize to `"plaintext"`.
const LANG_ALIASES: Readonly<Record<string, string>> = {
  dataviewjs: "javascript",
  dataview: "sql",
};

/**
 * Resolve a fence's declared language to one `cli-highlight` supports.
 *
 * - Marked puts the *whole* fence info-string tail into `token.lang` — ` ```js
 *   {highlight=1} ` arrives as `"js {highlight=1}"` — so only the first
 *   whitespace-delimited word is the language; the rest is discarded for this lookup.
 * - Normalizes case-insensitively (`DataviewJS` resolves the same as `dataviewjs`)
 *   before both the alias lookup and the `supportsLanguage()` guard.
 * - An empty or absent language is returned unchanged, never forced to `"plaintext"` —
 *   that would change today's rendering for the common case of a plain, unlabelled
 *   fence, which this WP does not touch.
 * - Never passes a *present but unsupported* language through as-is or as `undefined`:
 *   `undefined` would make `cli-highlight` auto-detect and colorize arbitrarily, which
 *   is not what "unsupported" should mean here. `"plaintext"` is itself always
 *   supported, so the fallback cannot recurse into the same problem.
 */
export function resolveFenceLanguage(rawLang: string | undefined): string | undefined {
  if (rawLang === undefined) return rawLang;
  const trimmed = rawLang.trim();
  if (trimmed === "") return rawLang;

  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  const lower = firstWord.toLowerCase();
  const aliased = LANG_ALIASES[lower] ?? lower;
  return supportsLanguage(aliased) ? aliased : "plaintext";
}
