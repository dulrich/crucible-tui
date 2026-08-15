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
 * A resolved fence-language resolver: an immutable alias map, closed over.
 *
 * **F4, and the real fix rather than its shape** (`plans/marked-terminal-replacement.md`).
 * Until WP-3 this module carried a mutable `effectiveAliases` module global and a
 * `setHighlightAliases` setter, because `src/render.ts` called `resolveFenceLanguage(lang)`
 * with a single argument and there was no seam to hand a configured map through. WP-2 built
 * that seam — `LayoutContext.resolveFenceLanguage` — and this is what now lands in it: a
 * value produced once, at startup, from the user's `highlightAs` config, and threaded.
 *
 * The consequence worth stating: **there is no process state in this module any more.** The
 * `beforeEach`/`afterEach` pair in `tests/config.test.ts` existed only to stop one test file
 * leaking an installed alias into another through that global — a leak the comment above it
 * documents as real, and as masked in the full suite only by an accident of Bun's file
 * ordering. With the global gone, there is nothing left to leak and nothing left to reset.
 */
export type FenceLanguageResolver = (rawLang: string | undefined) => string | undefined;

/**
 * Build a resolver over the built-in aliases with `userAliases` layered on top — a user
 * entry for a fence that also has a built-in default wins.
 *
 * The merged map is frozen and captured by the returned closure, so a resolver handed to a
 * `LayoutContext` cannot be re-pointed partway through a document. Call it once per process
 * (`src/cli.ts`, after `loadConfig`); calling it again produces an independent resolver
 * rather than mutating the first, which is the entire behavioural difference from the
 * setter it replaces.
 */
export function makeFenceLanguageResolver(
  userAliases: Readonly<Record<string, string>> = {},
): FenceLanguageResolver {
  const aliases: Readonly<Record<string, string>> = Object.freeze({ ...LANG_ALIASES, ...userAliases });
  return (rawLang) => resolveWith(aliases, rawLang);
}

/**
 * The built-in-only resolver, built once because its input is a frozen constant.
 *
 * This is what the defaulted compatibility wrapper below resolves through, and what every
 * caller that never had user aliases in play — `scripts/sweep.ts`, `scripts/render-diff.ts`,
 * every test that renders directly — gets by default. Sharing one instance rather than
 * building a fresh closure per call is safe precisely because there is nothing mutable in
 * it.
 */
const BUILTIN_RESOLVER: FenceLanguageResolver = makeFenceLanguageResolver();

/** The built-in alias map alone, e.g. for `highlight-as --help`'s reference list. */
export function getBuiltinAliases(): Readonly<Record<string, string>> {
  return LANG_ALIASES;
}

/**
 * Whether `cli-highlight` (and therefore highlight.js) recognizes `language`.
 * `mdview highlight-as` validates against this before writing, so a typo'd or
 * unsupported target language is rejected at write time rather than producing
 * a fence that mysteriously never highlights later.
 */
export function isSupportedLanguage(language: string): boolean {
  return supportsLanguage(language.trim().toLowerCase());
}

/**
 * Resolve a fence's declared language to one `cli-highlight` supports, against `aliases`.
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
function resolveWith(
  aliases: Readonly<Record<string, string>>,
  rawLang: string | undefined,
): string | undefined {
  if (rawLang === undefined) return rawLang;
  const trimmed = rawLang.trim();
  if (trimmed === "") return rawLang;

  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  const lower = firstWord.toLowerCase();
  const aliased = aliases[lower] ?? lower;
  return supportsLanguage(aliased) ? aliased : "plaintext";
}

/**
 * The defaulted compatibility wrapper the plan requires: resolution against the built-in
 * aliases alone, with the single-argument call shape every existing caller already uses.
 *
 * A caller with user aliases to honour builds its own resolver with
 * `makeFenceLanguageResolver` and threads it — `src/cli.ts` is the only one, and
 * `renderDocumentDetailed` takes it as a parameter rather than reading a global.
 */
export function resolveFenceLanguage(rawLang: string | undefined): string | undefined {
  return BUILTIN_RESOLVER(rawLang);
}
