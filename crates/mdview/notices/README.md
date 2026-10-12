# Vendored notices — mdview

Licence texts for code and data copied, ported or generated into the `mdview` binary from sources that are **not** in its Cargo runtime closure, so `cargo metadata` cannot find them. `scripts/gen-licenses.ts` copies every `*.LICENSE.txt` here, in name order, into `THIRD-PARTY-LICENSES.txt`'s "Vendored notices" section (WP-9 of `plans/mdview-rust-port.md`). A file added here ships on the next `bun run gen-licenses`.

| File | Covers | Source |
|---|---|---|
| `emojilib.LICENSE.txt` | the shortcode keyword data `node-emoji` is built from, generated into `src/emoji_data.rs` | `emojilib@2.4.0` (MIT) |
| `get-east-asian-width.LICENSE.txt` | the East Asian Width tables copied into `src/width/tables.rs` | `get-east-asian-width@1.6.0` (MIT) |
| `highlight.js.LICENSE.txt` | the language-name alias map generated into `src/hljs_map.rs` | `highlight.js@10.7.3` (BSD-3-Clause) |
| `node-emoji.LICENSE.txt` | the shortcode name map generated into `src/emoji_data.rs` | `node-emoji@2.2.0` (MIT) |
| `string-width.LICENSE.txt` | the width algorithm ported into `src/width.rs` | `string-width@8.2.2` (MIT) |
| `two-face-syntaxes.LICENSE.txt` | every syntax definition in two-face's embedded set, compiled into the binary by `build.rs` | `two-face@0.5.2+bat-0.26.1`, its bundled `acknowledgements_full.bin` (syntaxes section, decoded verbatim) |
| `unicode.LICENSE.txt` | the Unicode Character Database properties behind the width tables | Unicode License V3, as shipped in `zerovec@0.11.8`'s `LICENSE` |

The vendored PowerShell grammar's notice lives beside it, in `../syntaxes/`.
