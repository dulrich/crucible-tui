//! The validator: one `jsonc-parser` profile per dialect, plus the four checks
//! the parser leaves to its caller (`references/jsonedit-prior-art.md`,
//! "Spike — `jsonc-parser` per-dialect strictness"): duplicate keys, raw
//! control characters in strings, empty / comment-only input, and a leading
//! UTF-8 BOM. Pure: no I/O, no environment; never panics on any byte input.
//!
//! Positions: `line` is 1-based; `column` is 1-based and counted in
//! characters, the same unit as the parser's `column_display()`.
//!
//! BOM rule: the BOM is stripped before parsing and is **not** counted in
//! line-1 columns, because editors do not display it — the reported column is
//! where the user's cursor lands.

use jsonc_parser::ast::{ObjectPropName, Value};
use jsonc_parser::errors::ParseErrorKind;
use jsonc_parser::{CollectOptions, ParseOptions, parse_to_ast};
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Json,
    Jsonc,
    Json5,
}

impl Dialect {
    /// Parses a `--dialect` value.
    pub fn from_name(name: &str) -> Option<Dialect> {
        match name {
            "json" => Some(Dialect::Json),
            "jsonc" => Some(Dialect::Jsonc),
            "json5" => Some(Dialect::Json5),
            _ => None,
        }
    }

    /// `.jsonc` → JSONC, `.json5` → JSON5 (case-insensitive), anything else → strict JSON.
    pub fn from_path(path: &Path) -> Dialect {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        match ext.as_deref() {
            Some("jsonc") => Dialect::Jsonc,
            Some("json5") => Dialect::Json5,
            _ => Dialect::Json,
        }
    }

    fn options(self) -> ParseOptions {
        let strict = ParseOptions {
            allow_comments: false,
            allow_loose_object_property_names: false,
            allow_trailing_commas: false,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
            allow_bare_decimal_point_numbers: false,
            allow_non_finite_numbers: false,
            allow_extended_string_escapes: false,
        };
        match self {
            Dialect::Json => strict,
            Dialect::Jsonc => ParseOptions {
                allow_comments: true,
                allow_trailing_commas: true,
                ..strict
            },
            Dialect::Json5 => ParseOptions {
                allow_missing_commas: false,
                ..ParseOptions::default()
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub line: usize,
    pub column: usize,
    pub message: String,
}

const BOM: &str = "\u{feff}";

/// 1-based line and character column of byte offset `at` in `text`.
fn position(text: &str, at: usize) -> (usize, usize) {
    let before = &text[..at];
    let line = before.matches('\n').count() + 1;
    let line_start = before.rfind('\n').map_or(0, |i| i + 1);
    (line, before[line_start..].chars().count() + 1)
}

fn diag(text: &str, at: usize, message: String) -> Diagnostic {
    let (line, column) = position(text, at);
    Diagnostic {
        line,
        column,
        message,
    }
}

pub fn validate(bytes: &[u8], dialect: Dialect) -> Result<(), Vec<Diagnostic>> {
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => {
            let valid = &bytes[..e.valid_up_to()];
            // The prefix is valid UTF-8 by construction.
            let prefix = std::str::from_utf8(valid).unwrap_or("");
            let prefix = prefix.strip_prefix(BOM).unwrap_or(prefix);
            return Err(vec![diag(
                prefix,
                prefix.len(),
                "invalid UTF-8 byte sequence".to_string(),
            )]);
        }
    };
    let text = text.strip_prefix(BOM).unwrap_or(text);

    let parsed = match parse_to_ast(text, &CollectOptions::default(), &dialect.options()) {
        Ok(p) => p,
        Err(e) => {
            let mut message = e.kind().to_string();
            if dialect == Dialect::Json {
                match e.kind() {
                    ParseErrorKind::CommentsNotAllowed
                    | ParseErrorKind::TrailingCommasNotAllowed => {
                        message.push_str(" in strict JSON (use --dialect jsonc for JSONC)");
                    }
                    _ => {}
                }
            }
            return Err(vec![Diagnostic {
                line: e.line_display(),
                column: e.column_display(),
                message,
            }]);
        }
    };
    let Some(value) = parsed.value else {
        return Err(vec![diag(
            text,
            text.len(),
            "no JSON value in input".to_string(),
        )]);
    };

    let mut found: Vec<(usize, String)> = Vec::new();
    walk(text, &value, dialect, &mut found);
    if found.is_empty() {
        return Ok(());
    }
    found.sort_by_key(|(at, _)| *at);
    Err(found
        .into_iter()
        .map(|(at, msg)| diag(text, at, msg))
        .collect())
}

/// Collects duplicate-key and control-character findings as (byte offset, message).
fn walk(text: &str, value: &Value, dialect: Dialect, found: &mut Vec<(usize, String)>) {
    match value {
        Value::Object(obj) => {
            let mut seen: HashSet<&str> = HashSet::new();
            for prop in &obj.properties {
                let (key, range) = match &prop.name {
                    ObjectPropName::String(s) => {
                        check_string(text, s.range.start, s.range.end, dialect, found);
                        (s.value.as_ref(), s.range)
                    }
                    ObjectPropName::Word(w) => (w.value, w.range),
                };
                if !seen.insert(key) {
                    found.push((range.start, format!("duplicate key \"{key}\"")));
                }
                walk(text, &prop.value, dialect, found);
            }
        }
        Value::Array(arr) => {
            for el in &arr.elements {
                walk(text, el, dialect, found);
            }
        }
        Value::StringLit(s) => check_string(text, s.range.start, s.range.end, dialect, found),
        _ => {}
    }
}

/// RFC 8259 forbids unescaped U+0000–U+001F inside strings; the parser accepts
/// them, so strict JSON and JSONC reject them here.
///
/// JSON5 policy: accepted. The JSON5 spec's string grammar admits any
/// SourceCharacter except the quote, backslash and line terminators, so a raw
/// tab is valid JSON5; line terminators are already the parser's to reject.
fn check_string(
    text: &str,
    start: usize,
    end: usize,
    dialect: Dialect,
    found: &mut Vec<(usize, String)>,
) {
    if dialect == Dialect::Json5 {
        return;
    }
    let Some(raw) = text.get(start..end) else {
        return;
    };
    for (i, b) in raw.bytes().enumerate() {
        if b < 0x20 {
            found.push((
                start + i,
                format!("unescaped control character U+{b:04X} in string"),
            ));
        }
    }
}
