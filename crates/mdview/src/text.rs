//! Grapheme splitting and display-width padding, ported from `TS_BASELINE` `src/text.ts`, plus the JS
//! string-semantics primitives the port needs everywhere (Critical Files 8 of
//! `plans/mdview-rust-port.md`).
//!
//! **JS whitespace is not Rust's.** ECMAScript `\s` and `String.prototype.trim` use
//! WhiteSpace + LineTerminator: that set *includes* U+FEFF and *excludes* U+0085, where
//! Rust's `char::is_whitespace` is the reverse on both. Every port of a TS `trim()`/`\s`
//! goes through [`js_trim`], [`is_js_whitespace`] or [`JS_WS_CLASS`] — never `str::trim`.
//!
//! **Offsets.** TS indexes strings in UTF-16 code units; Rust in UTF-8 bytes. Every ported
//! function in this crate works in bytes; where a TS value *is* a UTF-16 offset or length
//! (a cap on `segment.length`, a tiebreak), convert at that seam with [`utf16_len`] /
//! [`utf16_to_byte`] / [`byte_to_utf16`] and say so at the call.

use unicode_segmentation::UnicodeSegmentation;

use crate::width::{Measure, NARROW_MEASURE};

/// ECMAScript `\s`, as the body of a `regex`-crate character class: `[` + this + `]`.
pub const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// ECMAScript `\s` membership (WhiteSpace ∪ LineTerminator).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `s.length` in JS: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The byte offset of UTF-16 offset `units` (clamped to the end; an offset inside a
/// surrogate pair rounds up to the end of that scalar).
pub fn utf16_to_byte(s: &str, units: usize) -> usize {
    let mut seen = 0;
    for (byte, c) in s.char_indices() {
        if seen >= units {
            return byte;
        }
        seen += c.len_utf16();
    }
    s.len()
}

/// The UTF-16 offset of byte offset `byte` (which must be a char boundary).
pub fn byte_to_utf16(s: &str, byte: usize) -> usize {
    utf16_len(&s[..byte])
}

/// Split a string into grapheme clusters, so emoji sequences are never cut apart.
///
/// TS uses ICU's `Intl.Segmenter`; this is `unicode-segmentation`'s extended clusters.
/// Their agreement over the corpus is measured by `scripts/width-census.ts` (WP-2 gate 2; deleted at WP-9, `TS_BASELINE` = `c097c66`).
pub fn graphemes(text: &str) -> Vec<&str> {
    text.graphemes(true).collect()
}

/// Hard-split one unbreakable token into chunks no wider than `width` display columns.
/// `split_token(t, w).concat() == t` for every `t`.
pub fn split_token(token: &str, width: usize, measure: Measure) -> Vec<String> {
    let limit = width.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_width = 0;
    for grapheme in token.graphemes(true) {
        let grapheme_width = measure.width(grapheme);
        if current_width > 0 && current_width + grapheme_width > limit {
            chunks.push(std::mem::take(&mut current));
            current_width = 0;
        }
        current.push_str(grapheme);
        current_width += grapheme_width;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push(String::new());
    }
    chunks
}

/// Which side of a cell the slack goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// Pad `text` out to `width` display columns; never truncates. Centre splits an odd
/// slack to the right (`cli-table3`'s `pad()`).
pub fn pad_to_width(text: &str, width: usize, align: Align, measure: Measure) -> String {
    let slack = width.saturating_sub(measure.width(text));
    if slack == 0 {
        return text.to_owned();
    }
    match align {
        Align::Right => " ".repeat(slack) + text,
        Align::Center => {
            let right = slack.div_ceil(2);
            format!("{}{text}{}", " ".repeat(slack - right), " ".repeat(right))
        }
        Align::Left => format!("{text}{}", " ".repeat(slack)),
    }
}

/// `pad_to_width` with the TS defaults (left, narrow).
pub fn pad_left(text: &str, width: usize) -> String {
    pad_to_width(text, width, Align::Left, NARROW_MEASURE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::WIDE_MEASURE;

    #[test]
    fn js_trim_includes_bom_and_excludes_nel() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(js_trim_start("  a "), "a ");
        assert_eq!(js_trim_end("  a "), "  a");
    }

    #[test]
    fn utf16_offsets_convert_at_the_seam() {
        let s = "a😀b";
        assert_eq!(utf16_len(s), 4);
        assert_eq!(utf16_to_byte(s, 1), 1);
        assert_eq!(utf16_to_byte(s, 3), 5);
        assert_eq!(byte_to_utf16(s, 5), 3);
    }

    #[test]
    fn split_token_is_lossless_and_grapheme_safe() {
        let token = "👨‍👩‍👧abcdef漢字";
        let chunks = split_token(token, 3, NARROW_MEASURE);
        assert_eq!(chunks.concat(), token);
        assert_eq!(chunks[0], "👨‍👩‍👧a");
        assert_eq!(split_token("", 5, NARROW_MEASURE), vec![String::new()]);
        assert_eq!(split_token("abc", 0, NARROW_MEASURE), vec!["a", "b", "c"]);
    }

    #[test]
    fn pad_to_width_measures_with_the_callers_ruler() {
        assert_eq!(
            pad_to_width("ab", 5, Align::Center, NARROW_MEASURE),
            " ab  "
        );
        assert_eq!(pad_to_width("ab", 4, Align::Right, NARROW_MEASURE), "  ab");
        assert_eq!(
            pad_to_width("abcdef", 4, Align::Left, NARROW_MEASURE),
            "abcdef"
        );
        assert_eq!(pad_to_width("—", 3, Align::Left, NARROW_MEASURE), "—  ");
        assert_eq!(pad_to_width("—", 3, Align::Left, WIDE_MEASURE), "— ");
        assert_eq!(pad_left("\u{1b}[1mx\u{1b}[22m", 2), "\u{1b}[1mx\u{1b}[22m ");
    }
}
