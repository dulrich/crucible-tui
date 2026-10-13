# ofm

Pure Obsidian-Flavored-Markdown parse primitives (`plans/ofm-crate-extraction.md`). Consumers: mdview (re-exports these under its old public paths) and an out-of-repo path-dependency consumer.

## Rules (binding)

- **Pure.** No I/O, no env/argv/TTY reads, no terminal or render dependencies (no `syntect`, `two-face`, `rustix`, `unicode-segmentation`, `serde`), no glyph `Tier`. Gate: `cargo tree --locked -e normal -p ofm --prefix none --format '{p}' | grep -E '^(syntect|two-face|rustix|unicode-segmentation|serde|serde_json) '` exits 1.
- **One grammar.** `wikilink::match_wikilink` and `comrak_options()` are the only copies; mdview's lexer calls them. Changing either changes mdview's rendering — run mdview's golden tests and `bun run verify`'s render-diff.
- **Pins** match mdview's exactly (`=x.y.z`); no dependency mdview does not already carry.
- **Publication guard:** no tracked file here may name a sibling directory (`tests/AGENTS.md`).

## Modules

- `frontmatter` — `split_frontmatter`, `parse_frontmatter` (yaml-rust2 events → `JsValue`), `JsValue`/`JsObject`, `json_stringify`, `js_number_to_string`. The metadata-block formatter stays in mdview.
- `js` — ECMAScript whitespace: `JS_WS_CLASS`, `is_js_whitespace`, `js_trim*`.
- `wikilink` — `match_wikilink` (`\n` excluded per `plans/wiki-link-tokenizer.md` D2) and `Wiki`.
- `comrak_options()` — mdview's lexer base options, verbatim.
