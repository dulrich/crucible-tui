//! Census helper for WP-3's frontmatter acceptance census (`scripts/frontmatter-census.ts`):
//! reads one JSON `[meta, width, sgr, ambiguous]` per stdin line, with `sgr` one of
//! `"none"`/`"formats"`/`"full"` and `ambiguous` `"narrow"`/`"wide"`, and answers one JSON
//! line each: `{parsed, text, ranges}` from `frontmatter.rs`.

use std::io::{BufRead, Write};

use mdview::frontmatter::{format_meta_block_detailed, parse_frontmatter};
use mdview::render::Sgr;
use mdview::width::{NARROW_MEASURE, WIDE_MEASURE};

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line.expect("stdin line");
        let (meta, width, sgr, ambiguous): (String, usize, String, String) =
            serde_json::from_str(&line).expect("[meta, width, sgr, ambiguous]");
        let sgr = match sgr.as_str() {
            "full" => Sgr::Full,
            "formats" => Sgr::Formats,
            _ => Sgr::None,
        };
        let measure = if ambiguous == "wide" {
            WIDE_MEASURE
        } else {
            NARROW_MEASURE
        };
        let parsed = parse_frontmatter(&meta).is_ok();
        let answer = match format_meta_block_detailed(&meta, width, measure, sgr) {
            Ok(r) => {
                serde_json::json!({"parsed": parsed, "text": r.text, "ranges": r.verbatim_ranges})
            }
            Err(e) => serde_json::json!({"parsed": parsed, "error": e.to_string()}),
        };
        writeln!(out, "{answer}").expect("stdout");
    }
}
