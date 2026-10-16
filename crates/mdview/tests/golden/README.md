# Golden files — a Rust-renderer snapshot

`render.jsonl` is a snapshot of the Rust renderer's output: one record per line, `{source, width, tier, ambiguous, emoji, policy, text, codeRanges}`, under a header line recording `engine: "rust"`, `capturedAt` (the commit the tree was captured at) and the record count. `crates/mdview/tests/golden.rs` replays every record through `mdview::render::render` and requires exact `text` and `codeRanges` equality — no relaxation, no allowlist.

Re-capture it deliberately, from the repository root:

```bash
cargo test -p mdview --locked --test golden -- --ignored regenerate_render_golden --nocapture
```

It keeps every record's `source` and option fields byte-for-byte and re-renders only `text` and `codeRanges`. Default `cargo test` never runs it. **A re-capture is a reviewed behaviour change, not a fix-up**: the diff of `render.jsonl` is the behaviour change, and it lands with the renderer change that caused it.

History: the records were first captured from the TypeScript renderer at `d3889c5` (`TS_BASELINE` = `c097c66` is the last commit carrying that renderer); the TS-era allowlist, the SGR-stripped relaxation and the frozen visitor byte tables were retired when `plans/rust-port-stage-3.md` (WP-1) re-baselined the file on Rust.
