//! YAML frontmatter split and value model, ported from `TS_BASELINE` `src/frontmatter.ts`.
//!
//! The YAML is read with yaml-rust2's **event-level** `Parser`, and the value `yaml@2.9.0`'s
//! `parse` would hand `TS_BASELINE` `src/frontmatter.ts` is rebuilt here as a [`JsValue`]: the
//! core-schema plain-scalar resolution, `uniqueKeys`' duplicate test, the JS object key and
//! `Object.keys` order (integer-like keys ascending first), with ECMAScript `String(number)` and
//! `JSON.stringify` transcribed. The one allowed difference is D-A of `plans/mdview-rust-port.md`:
//! a failed parse's diagnostic text is yaml-rust2's message, not `yaml`'s.
//!
//! [`split`] finds the block, [`js_value`] is the JS value model and its ECMAScript
//! conversions, [`yaml`] composes it from yaml-rust2's events. The metadata-block formatter
//! stays in mdview.

mod js_value;
mod split;
mod yaml;

pub use js_value::{JsObject, JsValue, js_number_to_string, json_stringify};
pub use split::split_frontmatter;
pub use yaml::parse_frontmatter;

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
}
