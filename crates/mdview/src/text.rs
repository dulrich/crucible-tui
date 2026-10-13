//! Grapheme splitting and display-width padding, ported from `TS_BASELINE` `src/text.ts`, plus the JS
//! string-semantics primitives (the whitespace set is `ofm::js`, re-exported here) the port needs everywhere (Critical Files 8 of
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

pub use ofm::js::{JS_WS_CLASS, is_js_whitespace, js_trim, js_trim_end, js_trim_start};

/// A JS regex source compiled with JS class semantics: `\s` and `\S` are ECMAScript whitespace
/// ([`JS_WS_CLASS`]) and its complement, `\d` is ASCII `[0-9]`. Inside a hand-written class,
/// `[\s…]` becomes a nested class, which `regex` reads as the union. Panics on a bad pattern:
/// every caller passes a literal.
pub fn js_regex(pattern: &str) -> regex::Regex {
    let ws = format!("[{JS_WS_CLASS}]");
    let not_ws = format!("[^{JS_WS_CLASS}]");
    regex::Regex::new(
        &pattern
            .replace(r"\s", &ws)
            .replace(r"\S", &not_ws)
            .replace(r"\d", "[0-9]"),
    )
    .expect("JS regex compiles")
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
///
/// Serialized lowercase (`"left"`/`"center"`/`"right"`), the parity wire spelling. On
/// deserialization any unrecognised string is `Left` — marked's `?? "left"` fallback — never an
/// error (audit E1 of `plans/rust-port-code-quality-remediation.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

impl<'de> serde::Deserialize<'de> for Align {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(d)?.as_str() {
            "center" => Align::Center,
            "right" => Align::Right,
            _ => Align::Left,
        })
    }
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
    fn align_round_trips_lowercase_and_falls_back_to_left() {
        let parsed: Vec<Option<Align>> =
            serde_json::from_str(r#"[null, "left", "center", "right", "justify"]"#).expect("ok");
        assert_eq!(
            parsed,
            [
                None,
                Some(Align::Left),
                Some(Align::Center),
                Some(Align::Right),
                Some(Align::Left)
            ]
        );
        let spelled = serde_json::to_string(&[None, Some(Align::Center), Some(Align::Right)]);
        assert_eq!(spelled.expect("ok"), r#"[null,"center","right"]"#);
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
