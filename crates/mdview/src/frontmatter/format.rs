//! The formatter: `TS_BASELINE` `src/frontmatter.ts`, transcribed.

use std::sync::LazyLock;

use regex::Regex;

use crate::style::{Sgr, StyleName, create_styler, style_span};
use crate::text::{JS_WS_CLASS, js_trim, utf16_len};
use crate::width::Measure;

use super::js_value::*;
use super::yaml::*;

pub(super) fn dim(text: &str, sgr: Sgr) -> String {
    style_span(sgr, &create_styler(StyleName::Dim, None), text)
}

/// `ISO_TIMESTAMP`. JS `\d` is ASCII-only and the `regex` crate's is Unicode, so it is
/// spelled `[0-9]`.
pub(super) static ISO_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$",
    )
});

/// `trimIsoDate`.
pub(super) fn trim_iso_date(value: &str) -> String {
    ISO_TIMESTAMP
        .captures(js_trim(value))
        .and_then(|c| c.get(1))
        .map_or_else(|| value.to_owned(), |m| m.as_str().to_owned())
}

/// `formatScalar`.
pub(super) fn format_scalar(value: &JsValue) -> String {
    match value {
        JsValue::Null => "—".into(),
        JsValue::Str(s) if js_trim(s).is_empty() => "—".into(),
        JsValue::Str(s) => trim_iso_date(s),
        JsValue::Num(n) => js_number_to_string(*n),
        JsValue::Bool(b) => b.to_string(),
        other => json_stringify(other),
    }
}

/// `formatValue`.
pub(super) fn format_value(value: &JsValue) -> String {
    match value {
        JsValue::Arr(items) if items.is_empty() => "—".into(),
        JsValue::Arr(items) => items
            .iter()
            .map(format_scalar)
            .collect::<Vec<_>>()
            .join(", "),
        other => format_scalar(other),
    }
}

pub(super) static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(&format!("[{JS_WS_CLASS}]+")));

pub(super) fn to_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `wrapValue`.
pub(super) fn wrap_value(text: &str, width: i64, measure: Measure) -> Vec<String> {
    if width <= 0 || to_i64(measure.width(text)) <= width {
        return vec![text.to_owned()];
    }
    let words: Vec<&str> = WS_RUN.split(text).filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return vec![String::new()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in words {
        let candidate = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if !current.is_empty() && to_i64(measure.width(&candidate)) > width {
            lines.push(std::mem::replace(&mut current, word.to_owned()));
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
        .iter()
        .flat_map(|l| hard_split(l, width, measure))
        .collect()
}

/// `hardSplit`. `String.prototype.slice` counts UTF-16 units, so the cut is made over the
/// UTF-16 encoding; a cut inside a surrogate pair decodes to U+FFFD here where JS would carry
/// a lone surrogate.
pub(super) fn hard_split(line: &str, width: i64, measure: Measure) -> Vec<String> {
    if width <= 0 || to_i64(measure.width(line)) <= width {
        return vec![line.to_owned()];
    }
    let w = |units: &[u16]| to_i64(measure.width(&String::from_utf16_lossy(units)));
    let mut out = Vec::new();
    let mut remaining: Vec<u16> = line.encode_utf16().collect();
    while w(&remaining) > width {
        let mut cut = usize::try_from(width).unwrap_or(0).min(remaining.len());
        while cut > 1 && w(&remaining[..cut]) > width {
            cut -= 1;
        }
        out.push(String::from_utf16_lossy(&remaining[..cut]));
        remaining = remaining.split_off(cut);
    }
    if !remaining.is_empty() {
        out.push(String::from_utf16_lossy(&remaining));
    }
    out
}

/// `formatMapping`.
pub(super) fn format_mapping(
    record: &JsObject,
    target: i64,
    depth: usize,
    measure: Measure,
    sgr: Sgr,
) -> String {
    let entries = record.entries();
    if entries.is_empty() {
        return dim("—", sgr);
    }
    let indent = "  ".repeat(depth);
    let indent_width = to_i64(measure.width(&indent));
    let raw_max = entries
        .iter()
        .map(|(k, _)| to_i64(measure.width(k)))
        .max()
        .unwrap_or(0);
    let key_budget = 4.max((target - indent_width).div_euclid(2) - 2);
    let max_key_width = raw_max.min(key_budget);
    let value_width = 1.max(target - indent_width - (max_key_width + 2));
    let pad_width = usize::try_from(max_key_width).unwrap_or(0);

    let mut lines: Vec<String> = Vec::new();
    for (key, value) in entries {
        // `key.padEnd(maxKeyWidth)`: a UTF-16 length padded against a column count.
        let padded_key = format!(
            "{key}{}",
            " ".repeat(pad_width.saturating_sub(utf16_len(key)))
        );
        if let (JsValue::Obj(inner), true) = (value, depth < 1) {
            lines.push(format!("{indent}{}:", dim(&padded_key, sgr)));
            lines.push(format_mapping(inner, target, depth + 1, measure, sgr));
            continue;
        }
        let formatted = match value {
            JsValue::Obj(_) => json_stringify(value),
            other => format_value(other),
        };
        for (i, line) in wrap_value(&formatted, value_width, measure)
            .into_iter()
            .enumerate()
        {
            if i == 0 {
                lines.push(format!("{indent}{}: {line}", dim(&padded_key, sgr)));
            } else {
                lines.push(format!("{indent}{}  {line}", " ".repeat(pad_width)));
            }
        }
    }
    lines.join("\n")
}
