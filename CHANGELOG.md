# Changelog

All notable changes to crucible-tui. One version covers the whole repo (mdview, jsonedit and the ofm library). Release rule: the `publish` skill's `## Releases` section; local specifics in `AGENTS.md`.

## 0.1.0 — 2026-11-10

- mdview: a terminal markdown viewer for the documents a working repo produces, with frontmatter shown as a labelled metadata block and fenced code passed through byte-for-byte.
- mdview: wide tables are wrapped losslessly (no cell is truncated), and prose and lists reflow ANSI-safely at every nesting depth, in both tight and loose list styles.
- mdview: Obsidian-style wiki-links, syntax highlighting for fenced code, and environment-detected Unicode/ASCII glyph tiers, shipped as a static musl binary.
- jsonedit: validate and edit JSON, JSONC and JSON5 files visudo-style, writing back atomically only if the result parses, without losing the file's bytes.
- ofm: a library of pure Obsidian-Flavored-Markdown parse primitives (frontmatter, wiki-link grammar, comrak base options), not published to crates.io.
