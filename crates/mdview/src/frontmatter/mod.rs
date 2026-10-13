//! YAML frontmatter split and metadata block, ported from `TS_BASELINE` `src/frontmatter.ts`.
//!
//! WP-3 of `plans/mdview-rust-port.md`. The YAML is read with yaml-rust2's **event-level**
//! `Parser`, and the value `yaml@2.9.0`'s `parse` would hand `TS_BASELINE` `src/frontmatter.ts` is rebuilt here
//! as a [`JsValue`]: the core-schema plain-scalar resolution (`node_modules/yaml/dist/schema/core/`,
//! `node_modules/yaml/dist/schema/common/null.js`), `uniqueKeys`' duplicate test (`node_modules/yaml/dist/compose/util-map-includes.js`), the JS
//! object key (`node_modules/yaml/dist/nodes/addPairToJSMap.js`'s `stringifyKey`) and `Object.keys` order (integer-like
//! keys ascending first). Formatting then follows `TS_BASELINE` `src/frontmatter.ts` line by line, with
//! ECMAScript `String(number)` and `JSON.stringify` transcribed below.
//!
//! The one allowed difference is D-A: a failed parse's diagnostic text is yaml-rust2's message,
//! not `yaml`'s. Whether a block parses, the echo and the verbatim range bookkeeping are exact.
//!
//! The split, the JS value model and the yaml-rust2 composer live in the `ofm` crate
//! (`plans/ofm-crate-extraction.md`) and are re-exported here; [`format`] lays the metadata
//! block out.

mod format;

use format::{dim, format_mapping, to_i64, wrap_value};
pub use ofm::frontmatter::{
    JsObject, JsValue, js_number_to_string, json_stringify, parse_frontmatter, split_frontmatter,
};

use crate::style::Sgr;
use crate::text::js_trim_end;
use crate::width::Measure;

/// `MetaBlockResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaBlockResult {
    pub text: String,
    pub verbatim_ranges: Vec<(usize, usize)>,
}

fn line_span(block: &str, offset: usize) -> (usize, usize) {
    (offset + 1, offset + block.split('\n').count())
}

/// `formatMetaBlockDetailed`.
pub fn format_meta_block_detailed(
    meta: &str,
    target_width: usize,
    measure: Measure,
    sgr: Sgr,
) -> MetaBlockResult {
    let target = to_i64(target_width);
    match parse_frontmatter(meta) {
        Err(reason) => {
            let (summary, detail) = reason
                .find('\n')
                .map_or((reason.as_str(), ""), |i| (&reason[..i], &reason[i..]));
            let wrapped = wrap_value(
                &format!("! could not parse frontmatter: {summary}"),
                target,
                measure,
            );
            let diagnostic = dim(&(wrapped.join("\n") + detail), sgr);
            let echo = dim(js_trim_end(meta), sgr);
            let offset = diagnostic.split('\n').count();
            MetaBlockResult {
                text: format!("{diagnostic}\n{echo}"),
                verbatim_ranges: vec![line_span(&echo, offset)],
            }
        }
        Ok(JsValue::Obj(record)) => MetaBlockResult {
            text: format_mapping(&record, target, 0, measure, sgr),
            verbatim_ranges: Vec::new(),
        },
        Ok(_) => {
            let echo = dim(js_trim_end(meta), sgr);
            MetaBlockResult {
                verbatim_ranges: vec![line_span(&echo, 0)],
                text: echo,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(meta: &str, width: usize) -> MetaBlockResult {
        format_meta_block_detailed(meta, width, crate::width::NARROW_MEASURE, Sgr::None)
    }

    #[test]
    fn mapping_formats_with_padded_keys_and_em_dashes() {
        assert_eq!(
            fmt(
                "title: x\ntags: []\nempty: ''\nn:\nlist: [a, 1, {b: c}]",
                80
            )
            .text,
            "title: x\ntags : —\nempty: —\nn    : —\nlist : a, 1, {\"b\":\"c\"}"
        );
    }

    #[test]
    fn timestamps_trim_to_the_date() {
        assert_eq!(fmt("d: 2026-07-06T12:30:00Z", 80).text, "d: 2026-07-06");
    }

    #[test]
    fn nested_mapping_recurses_once_then_stringifies() {
        assert_eq!(
            fmt("a:\n  b:\n    c: 1\n  e: 2", 80).text,
            "a:\n  b: {\"c\":1}\n  e: 2"
        );
        assert_eq!(fmt("a: {}", 80).text, "a:\n—");
    }

    #[test]
    fn long_values_wrap_under_the_key_column() {
        assert_eq!(fmt("k: aaa bbb ccc", 8).text, "k: aaa\n   bbb\n   ccc");
        assert_eq!(fmt("k: abcdefgh", 6).text, "k: abc\n   def\n   gh");
    }

    #[test]
    fn a_non_mapping_document_is_echoed_verbatim() {
        let r = fmt("- a\n- b\n", 80);
        assert_eq!(r.text, "- a\n- b");
        assert_eq!(r.verbatim_ranges, vec![(1, 2)]);
    }

    #[test]
    fn a_failed_parse_echoes_under_its_diagnostic() {
        let r = fmt("a: [unterminated\nb: 1", 200);
        let lines: Vec<&str> = r.text.split('\n').collect();
        assert!(lines[0].starts_with("! could not parse frontmatter: "));
        assert_eq!(&lines[lines.len() - 2..], &["a: [unterminated", "b: 1"]);
        let start = lines.len() - 1;
        assert_eq!(r.verbatim_ranges, vec![(start, start + 1)]);
    }

    #[test]
    fn a_failed_parse_diagnostic_has_the_excerpt_layout() {
        let r = fmt("a: b\nk: x {a: b} c", 200);
        let lines: Vec<&str> = r.text.split('\n').collect();
        assert!(lines[0].ends_with(':'), "{lines:?}");
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "k: x {a: b} c");
        assert!(lines[3].trim_start() == "^", "{lines:?}");
        assert_eq!(lines[4], "");
        assert_eq!(r.verbatim_ranges, vec![(6, 7)]);
    }

    #[test]
    fn dim_wraps_keys_and_echo_under_colour() {
        let r = format_meta_block_detailed("a: 1", 80, crate::width::NARROW_MEASURE, Sgr::Formats);
        assert_eq!(r.text, "\u{1b}[2ma\u{1b}[22m: 1");
    }
}
