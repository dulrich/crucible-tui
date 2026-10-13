# ofm

Pure Obsidian-Flavored-Markdown parse primitives (`plans/ofm-crate-extraction.md`). Consumers: mdview (re-exports these under its old public paths) and an out-of-repo path-dependency consumer.

## Rules (binding)

- **Pure.** No I/O, no env/argv/TTY reads, no terminal or render dependencies (no `syntect`, `two-face`, `rustix`, `unicode-segmentation`, `serde`), no glyph `Tier`. Gate: `cargo tree --locked -e normal -p ofm --prefix none --format '{p}' | grep -E '^(syntect|two-face|rustix|unicode-segmentation|serde|serde_json) '` exits 1.
- **One grammar.** `wikilink::match_wikilink` and `comrak_options()` are the only copies; mdview's lexer calls them. Changing either changes mdview's rendering — run mdview's golden tests and `bun run verify`'s render-diff.
- **Pins** match mdview's exactly (`=x.y.z`); no dependency mdview does not already carry.
- **Span contract.** `parse(source)` spans are byte ranges into the whole `source` (frontmatter included), on char boundaries; no pre-normalization shifts them (CRLF, NUL, BOM covered by tests). Every span self-verifies via `check_spans` (empty = holds): a wikilink re-matches `match_wikilink_with(span, true)` exactly — after `\|` → `|` when `in_table`; tag = `#`+name; block id = `^`+id; footnote ref = `[^label]`; bracketed link/image starts `[`/`![`; angle autolink = `<dest>`; bare autolink = its destination text. comrak's inline sourcepos is never trusted raw: table cells map through the unescaped cell's byte offsets, lazy-tab lines re-anchor (`parse.rs` `lazy_tab_shift`).
- **Agreement rule.** `crates/mdview/tests/ofm_agreement.rs` holds `parse`'s wiki-link multiset equal to mdview's lexer over every golden source and fixture, apart from named allowlist classes (each with its reason; today only *fragment-only*: ofm emits `[[#h]]` with empty target, the lexer does not). Never widen the allowlist to pass — find the cause. `cargo run --release -p mdview --example ofm-agreement -- <dir>` runs the same checks over a directory, printing aggregates only.
- **Publication guard:** no tracked file here may name a sibling directory (`tests/AGENTS.md`).

## Modules

- `frontmatter` — `split_frontmatter`, `parse_frontmatter` (yaml-rust2 events → `JsValue`), `JsValue`/`JsObject`, `json_stringify`, `js_number_to_string`. The metadata-block formatter stays in mdview.
- `js` — ECMAScript whitespace: `JS_WS_CLASS`, `is_js_whitespace`, `js_trim*`.
- `wikilink` — `match_wikilink` (`\n` excluded per `plans/wiki-link-tokenizer.md` D2), `match_wikilink_with(s, allow_empty_target)` (fragment-only links; mdview's lexer keeps `false`) and `Wiki`.
- `parse` / `note` / `check` — `parse(source) -> Note` (one comrak pass with footnotes on, definitions left in place, plus an AST walk; gaps between non-text inline nodes are tokenized for wikilinks, tags, block ids), the item types, and `check_spans`. Link resolution is the consumer's.
- `comrak_options()` — mdview's lexer base options, verbatim.
