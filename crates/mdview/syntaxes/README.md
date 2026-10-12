# Vendored grammars

Sublime syntax definitions that two-face's set lacks, compiled into mdview by `../build.rs` (WP-6c of `plans/mdview-rust-port.md`). Each `<Name>.sublime-syntax` carries its notice as `<Name>.LICENSE.txt`, which `scripts/gen-licenses.ts` folds into `THIRD-PARTY-LICENSES.txt`.

| File | Upstream | Commit | sha256 | License |
|---|---|---|---|---|
| `PowerShell.sublime-syntax` | https://github.com/SublimeText/PowerShell | `2938700b586aeaa9c1d2dc0c04a1cc569ff3c24e` | `0b3a72aa262a3998429952162818e2f68c433bb3228680a21e8d066cc7bfda62` | MIT (`PowerShell.LICENSE.txt`, sha256 `4cbacdf136ebd84b5276f18801c054e3eabc29bc1c17206f5e4d9d57965d5742`) |

Vendored byte-for-byte; never hand-edit. To update, replace the file from a pinned upstream commit and update this row.
