//! Table-driven validator tests: every row of the strictness table in
//! `references/jsonedit-prior-art.md`, in all three dialects, plus the four gaps.

use jsonedit::{Diagnostic, Dialect, run_with, validate};
use std::path::Path;

const OK: bool = true;
const NO: bool = false;

fn ok(src: &[u8], d: Dialect) -> bool {
    validate(src, d).is_ok()
}

fn one(src: &[u8], d: Dialect) -> Diagnostic {
    let mut e = validate(src, d).expect_err("expected invalid");
    assert_eq!(e.len(), 1, "{e:?}");
    e.remove(0)
}

#[test]
fn strictness_table() {
    // (input, strict, jsonc, json5)
    let rows: &[(&str, bool, bool, bool)] = &[
        ("{\"a\": 1 // c\n}", NO, OK, OK),
        ("{\"a\": /* c */ 1}", NO, OK, OK),
        ("{\"a\": 1,}", NO, OK, OK),
        ("[1, 2,]", NO, OK, OK),
        ("[1 2]", NO, NO, NO),
        ("{\"a\": 1 \"b\": 2}", NO, NO, NO),
        ("{a: 1}", NO, NO, OK),
        ("{1: 1}", NO, NO, OK),
        ("'s'", NO, NO, OK),
        ("0xFF", NO, NO, OK),
        ("+1", NO, NO, OK),
        (".5", NO, NO, OK),
        ("5.", NO, NO, OK),
        ("Infinity", NO, NO, OK),
        ("NaN", NO, NO, OK),
        ("\"\\x41\"", NO, NO, OK),
        ("\"a\\\nb\"", NO, NO, OK),
        ("\"\\q\"", NO, NO, OK),
        ("01", NO, NO, NO),
        ("{} {}", NO, NO, NO),
        ("\"\\ud800\"", NO, NO, NO),
        ("[foo]", NO, NO, NO),
        ("42", OK, OK, OK),
        ("{\"a\": 1, \"a\": 2}", NO, NO, NO),
        ("\"a\tb\"", NO, NO, OK),
        ("", NO, NO, NO),
        ("\u{feff}{}", OK, OK, OK),
    ];
    for (src, s, c, f) in rows {
        let got = (
            ok(src.as_bytes(), Dialect::Json),
            ok(src.as_bytes(), Dialect::Jsonc),
            ok(src.as_bytes(), Dialect::Json5),
        );
        assert_eq!(got, (*s, *c, *f), "row {src:?}");
    }
}

#[test]
fn duplicate_key_nested_in_array_of_objects() {
    let src = b"{\n  \"items\": [{\"id\": 1}, {\"id\": 2, \"id\": 3}]\n}";
    for d in [Dialect::Json, Dialect::Jsonc, Dialect::Json5] {
        let e = one(src, d);
        assert_eq!((e.line, e.column), (2, 34), "{d:?}");
        assert!(e.message.contains("\"id\""));
    }
}

#[test]
fn all_findings_reported_in_order() {
    let e = validate(b"{\"a\": \"x\ty\", \"a\": 1}", Dialect::Json).unwrap_err();
    assert_eq!(e.iter().map(|d| d.column).collect::<Vec<_>>(), vec![9, 14]);
}

#[test]
fn raw_control_character() {
    let e = one(b"{\"k\": \"a\tb\"}", Dialect::Jsonc);
    assert_eq!((e.line, e.column), (1, 9));
    assert!(e.message.contains("U+0009"));
    assert!(validate(b"{\"k\": \"a\tb\"}", Dialect::Json5).is_ok());
}

#[test]
fn no_value_inputs() {
    for d in [Dialect::Json, Dialect::Jsonc, Dialect::Json5] {
        for src in ["", "  \n\t ", "\u{feff}"] {
            assert!(!ok(src.as_bytes(), d), "{d:?} {src:?}");
        }
    }
    for d in [Dialect::Jsonc, Dialect::Json5] {
        assert!(
            one(b"// only\n/* c */\n", d)
                .message
                .contains("no JSON value")
        );
    }
}

#[test]
fn bom_does_not_shift_columns() {
    let e = one(b"\xef\xbb\xbf{\n  \"a\": 1,,\n}", Dialect::Json);
    assert_eq!((e.line, e.column), (2, 10));
    // Line 1: the BOM is not counted (editors do not show it).
    let e = one(b"\xef\xbb\xbf{\"a\": 1,,}", Dialect::Json);
    assert_eq!((e.line, e.column), (1, 9));
    let e = one(b"\xef\xbb\xbf{\"a\": 1, \"a\": 2}", Dialect::Json);
    assert_eq!((e.line, e.column), (1, 10));
}

#[test]
fn non_utf8_is_positioned() {
    let e = one(b"{\n  \"\xc3\xbc\": \"\xff\"\n}", Dialect::Json);
    assert_eq!((e.line, e.column), (2, 9));
    assert!(e.message.contains("UTF-8"));
    let e = one(b"\xef\xbb\xbf\x80", Dialect::Json);
    assert_eq!((e.line, e.column), (1, 1));
}

#[test]
fn columns_count_characters() {
    let e = one("{\"ü\": 1,, }".as_bytes(), Dialect::Json);
    assert_eq!((e.line, e.column), (1, 9));
    let e = one("{\"ü\": 1, \"ü\": 2}".as_bytes(), Dialect::Json);
    assert_eq!((e.line, e.column), (1, 10));
}

#[test]
fn strict_hint_names_dialect() {
    assert!(
        one(b"{} // c", Dialect::Json)
            .message
            .contains("--dialect jsonc")
    );
    assert!(
        one(b"[1,]", Dialect::Json)
            .message
            .contains("--dialect jsonc")
    );
    assert!(!one(b"[1 2]", Dialect::Json).message.contains("--dialect"));
}

#[test]
fn dialect_from_extension() {
    let cases = [
        ("a.json", Dialect::Json),
        ("a.jsonc", Dialect::Jsonc),
        ("a.JSONC", Dialect::Jsonc),
        ("a.json5", Dialect::Json5),
        ("a.Json5", Dialect::Json5),
        ("tsconfig", Dialect::Json),
        ("a.txt", Dialect::Json),
    ];
    for (p, d) in cases {
        assert_eq!(Dialect::from_path(Path::new(p)), d, "{p}");
    }
}

fn call(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = run_with(&args, &mut out, &mut err);
    (
        code,
        String::from_utf8(out).unwrap(),
        String::from_utf8(err).unwrap(),
    )
}

fn fx(name: &str) -> String {
    format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn cli_check_exit_codes() {
    for f in ["valid.json", "valid.jsonc", "valid.json5"] {
        assert_eq!(
            call(&["--check", &fx(f)]),
            (0, String::new(), String::new()),
            "{f}"
        );
    }
    let f = fx("comment.json");
    let (code, out, err) = call(&["--check", &f]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert!(
        err.starts_with(&format!("{f}:2:3: Comments are not allowed")),
        "{err}"
    );
    assert_eq!(call(&["--check", "--dialect", "jsonc", &f]).0, 0);
    assert_eq!(call(&["--dialect", "jsonc", "--check", &f]).0, 0);
    let (code, _, err) = call(&["--check", &fx("duplicate.json")]);
    assert_eq!(code, 1);
    assert!(err.contains(":2:23: duplicate key \"id\""), "{err}");
    let (code, _, err) = call(&["--check", &fx("bom-error-line2.json")]);
    assert_eq!(code, 1);
    assert!(err.contains(":2:10: "), "{err}");
    let (code, _, err) = call(&["--check", &fx("does-not-exist.json")]);
    assert_eq!(code, 1);
    assert!(err.contains("does-not-exist.json"));
}

#[test]
fn cli_usage_errors_exit_two() {
    let v = fx("valid.json");
    let v = v.as_str();
    for args in [
        &["--check"][..],
        &["--check", "--dialect", "yaml", v][..],
        &["--check", "--dialect"][..],
        &["--check", v, v][..],
        &["--check", "--bogus", v][..],
        &["--indent", "x", v][..],
    ] {
        let (code, out, err) = call(args);
        assert_eq!((code, out.as_str()), (2, ""), "{args:?}");
        assert!(err.contains("usage:"), "{args:?}");
    }
}
