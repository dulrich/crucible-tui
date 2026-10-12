# jsonedit

A visudo-style safe editor and validator for JSON, JSONC and JSON5 (`plans/jsonedit.md`; prior art and the parser spike are `references/jsonedit-prior-art.md`). `src/lib.rs` is the CLI, `src/validate.rs` the pure validator, `src/edit.rs` the loop, `src/indent.rs` indent detection; `src/main.rs` is thin.

## The ten invariants (binding)

1. **Verbatim write-back** — the bytes written are the bytes the editor left; nothing is re-serialised.
2. **Atomic replace** — temp in the target's directory, `sync_all`, original mode bits (0644 for a new file), best-effort `fchown` (EPERM ignored), `rename`.
3. **Symlinks followed, never replaced** — `canonicalize`, operate on the resolved path; a dangling link is refused.
4. **Buffer** — `$TMPDIR/<stem>.jsonedit-<pid>-<n>.<ext>`, mode 0600, keeps the extension; removed after a write or exit, kept (path printed) on abort.
5. **Editor** — `$VISUAL`, `$EDITOR`, `vi`; split shell-style by `edit::split_shell` (quotes, backslashes, no expansion); the buffer path is appended; non-zero exit = abort.
6. **After the editor** — unchanged → "no changes", nothing written; invalid → diagnostics + `(e)dit again, e(x)it without saving, (a)bort keeping the buffer` (EOF = abort); no write-anyway for invalid bytes.
7. **Concurrent change** — the target's bytes at open are compared with disk just before the replace; a difference offers re-edit (disk becomes the new baseline) or abort.
8. **Missing target** — empty buffer; an empty save creates nothing (exit 0); created only when valid.
9. **Non-interactive stdin** — never prompts; invalid or concurrent change → keep buffer, print path, exit 1.
10. **Indent style** — detected, never rewritten. A file needs ≥3 indented non-blank lines (`indent::MIN_INDENTED`) to be judged; a style is dominant when ≥80% (`indent::DOMINANCE`) of those lines agree — all-tab lines for tabs, or all-space lines whose width is a multiple of the narrowest space indent. Otherwise ambiguous: TTY asks once before the editor, non-TTY has no reference. `--indent tab|N` (edit mode only) skips detection. Changed/new lines (line-set diff against the original) that don't fit → warning listing up to 5 line numbers and `(w)rite anyway`; non-TTY warns and writes.

## Validation rules (`src/validate.rs`)

`.jsonc` → JSONC, `.json5` → JSON5, else strict JSON; `--dialect` overrides. Beyond the parser's per-dialect profile: duplicate keys at any depth (all dialects), raw U+0000–U+001F in strings (JSON/JSONC; accepted in JSON5), empty or comment-only input, and a stripped leading BOM that does not shift columns. Positions are 1-based line and character column.

## Exit codes

0 written / unchanged / empty-new-file / valid `--check`; 1 invalid, aborted, exited, editor failed; 2 usage.

## Tests

`tests/edit.rs` drives `edit::edit` with an injected `EditEnv` — the editor is a `sh -c` one-liner that rewrites `$1`, prompt answers are a `Cursor`, `tty` is a flag — each in a fresh temp dir. **Never call `run`/`run_with` in edit mode from a test**: they build the real environment and launch `$EDITOR`. Indent detection is unit-tested in `src/indent.rs`; validation in `tests/validate.rs`.
