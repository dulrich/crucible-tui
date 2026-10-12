//! Rendered-line primitives shared by render and the detectors, ported from
//! `src/list-lines.ts`: `strip_ansi` (a derivation of `ansi.rs`'s scanner), the marker
//! regexes, and `track_list_line`.
//!
//! Every TS `\s`/`\S` here is ECMAScript whitespace (`text::JS_WS_CLASS`), and `\d` is ASCII.

use std::sync::LazyLock;

use regex::Regex;

use crate::ansi::strip_sequences;
use crate::text::{JS_WS_CLASS, js_trim, js_trim_start};
use crate::width::Measure;

/// Every terminal sequence removed (`stripSequences`).
pub fn strip_ansi(value: &str) -> std::borrow::Cow<'_, str> {
    strip_sequences(value)
}

fn js(pattern: &str) -> Regex {
    let ws = format!("[{JS_WS_CLASS}]");
    let not_ws = format!("[^{JS_WS_CLASS}]");
    Regex::new(
        &pattern
            .replace(r"\s", &ws)
            .replace(r"\S", &not_ws)
            .replace(r"\d", "[0-9]"),
    )
    .expect("list-lines regex compiles")
}

/// `/^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/`
pub static LIST_BULLET: LazyLock<Regex> = LazyLock::new(|| js(r"^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s"));
static LIST_MARKER_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| js(r"^(\s{2,}(?:[•*\-◦‣+]|\d+\.)\s+)"));
/// `/^(?:\*|\d+\.)/`
pub static MARKER_SHAPED_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^(?:\*|\d+\.)"));
/// `/^\*\s/`
pub static REWRITABLE_MARKER_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^\*\s"));
/// `/^(?:[•*\-◦‣+]|\d+\.)\s/`
pub static COLUMN_ZERO_MARKER: LazyLock<Regex> =
    LazyLock::new(|| js(r"^(?:[\x{2022}*\-\x{25e6}\x{2023}+]|\d+\.)\s"));
static INDENTED_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^\s{2,}\S"));

/// `isGuardShapedLine`.
pub fn is_guard_shaped_line(text: &str) -> bool {
    MARKER_SHAPED_LINE.is_match(text) || COLUMN_ZERO_MARKER.is_match(text)
}

/// `isIndentedLine`: two or more leading whitespace, then a non-whitespace.
pub fn is_indented_line(line: &str) -> bool {
    INDENTED_LINE.is_match(line)
}

/// One open list item: its marker column and its text column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenListItem {
    pub marker_column: usize,
    pub text_column: usize,
}

/// `trackListLine`: update `open` for one rendered line; return the item a continuation
/// line belongs to, or `None` for a marker line, a blank line or a column-0 line.
pub fn track_list_line(
    line: &str,
    open: &mut Vec<OpenListItem>,
    measure: Measure,
) -> Option<OpenListItem> {
    if js_trim(line).is_empty() {
        return None;
    }
    if let Some(caps) = LIST_MARKER_PREFIX.captures(line) {
        let prefix = caps.get(1).map_or("", |m| m.as_str());
        let lead = prefix.len() - js_trim_start(prefix).len();
        let marker_column = measure.width(&prefix[..lead]);
        let text_column = measure.width(prefix);
        while open
            .last()
            .is_some_and(|top| top.marker_column >= marker_column)
        {
            open.pop();
        }
        open.push(OpenListItem {
            marker_column,
            text_column,
        });
        return None;
    }
    if !is_indented_line(line) {
        open.clear();
        return None;
    }
    open.last().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::NARROW_MEASURE;

    #[test]
    fn marker_regexes() {
        assert!(LIST_BULLET.is_match("  • item"));
        assert!(LIST_BULLET.is_match("    12. item"));
        assert!(!LIST_BULLET.is_match(" • item"));
        assert!(LIST_BULLET.is_match("\u{3000}\u{FEFF}- x"));
        assert!(!LIST_BULLET.is_match("  \u{85}- x"));
        assert!(is_guard_shaped_line("* x"));
        assert!(is_guard_shaped_line("3."));
        assert!(is_guard_shaped_line("◦ x"));
        assert!(!is_guard_shaped_line("-x"));
        assert!(is_guard_shaped_line("- x"));
        assert!(REWRITABLE_MARKER_LINE.is_match("* a"));
        assert!(!COLUMN_ZERO_MARKER.is_match("１. x"));
        assert!(is_indented_line("  x"));
        assert!(!is_indented_line("   "));
    }

    #[test]
    fn track_list_line_follows_nesting() {
        let mut open = Vec::new();
        let m = NARROW_MEASURE;
        assert_eq!(track_list_line("  • outer", &mut open, m), None);
        assert_eq!(
            open,
            vec![OpenListItem {
                marker_column: 2,
                text_column: 4
            }]
        );
        assert_eq!(track_list_line("      ◦ inner", &mut open, m), None);
        assert_eq!(open.len(), 2);
        assert_eq!(
            track_list_line("        cont", &mut open, m),
            Some(OpenListItem {
                marker_column: 6,
                text_column: 8
            })
        );
        assert_eq!(track_list_line("   ", &mut open, m), None);
        assert_eq!(open.len(), 2);
        assert_eq!(track_list_line("  • next", &mut open, m), None);
        assert_eq!(open.len(), 1);
        assert_eq!(track_list_line("prose", &mut open, m), None);
        assert!(open.is_empty());
        assert_eq!(track_list_line("    stray", &mut open, m), None);
    }

    #[test]
    fn strip_ansi_removes_every_sequence_kind() {
        let t = crate::ansi::link("x", "u", true);
        assert_eq!(strip_ansi(&format!("\u{1b}[1m{t}\u{1b}[22m")), "x");
    }
}
