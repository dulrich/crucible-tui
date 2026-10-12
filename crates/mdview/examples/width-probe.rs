//! Census helper for WP-2's gates (`scripts/width-census.ts`, deleted at WP-9; `TS_BASELINE` = `c097c66`): reads one JSON string per
//! stdin line and answers one line each.
//!
//! - `width-probe width`: `[narrow, wide]` — `Measure::width` under both modes.
//! - `width-probe segment`: the `unicode-segmentation` grapheme clusters, as a JSON array.
//! - `width-probe wrap`: input `[text, width, "narrow"|"wide"]`, output `wrap_ansi`'s lines.

use std::io::{BufRead, Write};

use mdview::text::graphemes;
use mdview::width::{NARROW_MEASURE, WIDE_MEASURE};
use mdview::wrap::wrap_ansi;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.expect("stdin line");
        if mode == "wrap" {
            let (text, width, ambiguous): (String, usize, String) =
                serde_json::from_str(&line).expect("[text, width, ambiguous]");
            let measure = if ambiguous == "wide" {
                WIDE_MEASURE
            } else {
                NARROW_MEASURE
            };
            writeln!(
                out,
                "{}",
                serde_json::json!(wrap_ansi(&text, width, measure))
            )
            .expect("stdout");
            continue;
        }
        let text: String = serde_json::from_str(&line).expect("a JSON string per line");
        let answer = match mode.as_str() {
            "width" => {
                serde_json::json!([NARROW_MEASURE.width(&text), WIDE_MEASURE.width(&text)])
            }
            "segment" => serde_json::json!(graphemes(&text)),
            other => panic!("unknown mode {other:?}; expected width or segment"),
        };
        writeln!(out, "{answer}").expect("stdout");
    }
    out.flush().expect("flush");
}
