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
//! The module is cut by concern: [`split`] finds the block, [`js_value`] is the JS value model
//! and its ECMAScript conversions, [`yaml`] composes it from yaml-rust2's events, and [`format`]
//! lays the metadata block out.

mod format;
mod js_value;
mod split;
mod yaml;

use format::{dim, format_mapping, to_i64, wrap_value};
pub use js_value::{JsObject, JsValue, js_number_to_string, json_stringify};
pub use split::split_frontmatter;
pub use yaml::parse_frontmatter;

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
    use super::yaml::prettify_error;
    use super::*;

    #[test]
    fn split_requires_a_key_shaped_first_line() {
        assert_eq!(
            split_frontmatter("---\ntitle: x\n---\nbody"),
            (Some("title: x".into()), "body")
        );
        assert_eq!(split_frontmatter("---\nnot yaml\n---\nb").0, None);
        assert_eq!(
            split_frontmatter("---\r\na: 1\r\n---\r\nb"),
            (Some("a: 1".into()), "b")
        );
        assert_eq!(
            split_frontmatter("---\na: 1\n---"),
            (Some("a: 1".into()), "")
        );
        assert_eq!(split_frontmatter("no fm").0, None);
    }

    fn fmt(meta: &str, width: usize) -> MetaBlockResult {
        format_meta_block_detailed(meta, width, crate::width::NARROW_MEASURE, Sgr::None)
    }

    #[test]
    fn number_to_string_is_ecmascript() {
        for (x, s) in [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000_001, "0.000001"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (f64::INFINITY, "Infinity"),
            (f64::NAN, "NaN"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
        ] {
            assert_eq!(js_number_to_string(x), s);
        }
    }

    #[test]
    fn core_schema_scalars() {
        let v = parse_frontmatter("a: yes\nb: on\nc: True\nd: 0o17\ne: 0x1F\nf: .inf\ng: ~\nh: 1.50\ni: 007\nj: 12:30\nk: 2026-07-06\nl: '1'")
            .expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"a":"yes","b":"on","c":true,"d":15,"e":31,"f":null,"g":null,"h":1.5,"i":7,"j":"12:30","k":"2026-07-06","l":"1"}"#
        );
    }

    #[test]
    fn object_keys_put_integer_like_keys_first() {
        let v = parse_frontmatter("b: 1\n10: x\n2: y\n01: z\na: 3").expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"1":"z","2":"y","10":"x","b":1,"a":3}"#
        );
    }

    #[test]
    fn duplicate_scalar_keys_fail_like_unique_keys() {
        assert!(parse_frontmatter("x: 1\nx: 2").is_err());
        assert!(parse_frontmatter("1: a\n1.0: b").is_err());
        assert!(parse_frontmatter("~: a\nnull: b").is_err());
        // `1` and `"1"` are not `===`: both land on key "1", the later value in place.
        assert_eq!(
            json_stringify(&parse_frontmatter("1: a\nz: 0\n\"1\": b").expect("parses")),
            r#"{"1":"b","z":0}"#
        );
    }

    #[test]
    fn collection_keys_are_flow_stringified() {
        let v = parse_frontmatter("created: {{today}}\n? [a, b]\n: v").expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"created":{"{ today }":null},"[ a, b ]":"v"}"#
        );
    }

    #[test]
    fn a_leading_tab_indent_fails_as_yaml_does() {
        assert!(parse_frontmatter("\ta: 1").is_err());
        assert!(parse_frontmatter("# c\n \ta: 1").is_err());
        assert!(parse_frontmatter("a: 1\n\t# c").is_ok());
    }

    #[test]
    fn multiple_documents_fail() {
        assert!(parse_frontmatter("a: 1\n---\nb: 2").is_err());
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
    fn prettify_appends_position_excerpt_and_caret() {
        assert_eq!(
            prettify_error("a: 1\nb: x y: z", "info", 2, 4),
            "info at line 2, column 5:\n\nb: x y: z\n    ^\n"
        );
    }

    #[test]
    fn prettify_includes_the_previous_line_at_a_line_start() {
        assert_eq!(
            prettify_error("a:\n  - b\nc", "info", 3, 0),
            "info at line 3, column 1:\n\n  - b\nc\n^\n"
        );
    }

    #[test]
    fn prettify_recentres_and_folds_a_long_line_at_80_units() {
        let line = "x".repeat(200);
        let expected = format!(
            "info at line 1, column 151:\n\n…{}…\n{}^\n",
            "x".repeat(78),
            " ".repeat(40)
        );
        assert_eq!(prettify_error(&line, "info", 1, 150), expected);
    }

    #[test]
    fn prettify_counts_columns_in_utf16_units() {
        // `😀` is one char and two UTF-16 units, as `yaml`'s `col` counts it.
        assert_eq!(
            prettify_error("k: 😀 x", "info", 1, 5),
            "info at line 1, column 7:\n\nk: 😀 x\n      ^\n"
        );
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
