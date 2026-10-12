# Golden files — the TypeScript renderer's frozen output

Captured from the TypeScript renderer by `scripts/golden-capture.ts` (WP-1 of `plans/mdview-rust-port.md`); `crates/mdview/tests/golden.rs` replays them against the Rust renderer, with `golden-allowlist.txt` naming each record a ratified divergence explains.

| File | Captured from | Holds |
|---|---|---|
| `render.jsonl` | `d3889c5` (header `tsSha`; `srcDirty: true`, the WP-1 tree in flight) | one `renderDocumentDetailed` record per line: `{source, width, tier, ambiguous, emoji, policy, text, codeRanges}` |
| `parity-tables.jsonl` | `d3889c5` (header `tsSha`) | the frozen marked-terminal visitor byte tables (`tests/helpers/{block,inline}-parity-golden.ts`), as `{suite, name, color, emoji, expected}` |

The TypeScript renderer, the capture script and the helper tables it read were deleted at WP-9; all of them are at `TS_BASELINE` = `c097c66`, the last commit carrying that renderer. These files can no longer be regenerated — they are a fixed record, and a change to one is a change to the record, not a re-capture.
