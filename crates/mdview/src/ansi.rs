//! The terminal-sequence grammar (scan and OSC-8 link), ported from `src/ansi.ts`.
//!
//! Three rules carried over unchanged: spans concatenate back to the input byte for byte;
//! every non-`Text` span is width 0 by construction; a malformed sequence carries its raw
//! bytes and never consumes visible text (an unknown introducer consumes the ESC alone).
//! The sentinels (code points 0 and 1) are `Text`.
//!
//! **One seam, unrepresentable in UTF-8:** TS reads a CSI final as one UTF-16 *code unit*
//! (`text[index]`), so an astral final splits a surrogate pair between a malformed span and
//! the following text span. Here the final is a whole scalar, so the malformed span takes
//! the whole character. Spans still concatenate back to the input.
//!
//! This module (OSC-8, DCS) and `style.rs` (SGR) are the only writers of escape bytes.

use crate::width::{Measure, NARROW_MEASURE};

const ESC: char = '\u{1b}';
const BEL: char = '\u{07}';
const ST_FINAL: char = '\\';
const ST_C1: char = '\u{9c}';
const OSC8_PREFIX: &str = "\u{1b}]8;";

/// The five span kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpanKind {
    Text,
    Sgr,
    Osc8,
    Dcs,
    Malformed,
}

impl SpanKind {
    /// The TS spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            SpanKind::Text => "text",
            SpanKind::Sgr => "sgr",
            SpanKind::Osc8 => "osc8",
            SpanKind::Dcs => "dcs",
            SpanKind::Malformed => "malformed",
        }
    }
}

/// One span: its kind, its exact bytes, and its display columns (0 unless `Text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span<'a> {
    pub kind: SpanKind,
    pub raw: &'a str,
    pub width: usize,
}

/// `scan`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanResult<'a> {
    pub spans: Vec<Span<'a>>,
    pub visible: String,
    pub malformed: bool,
}

fn is_csi_parameter(c: char) -> bool {
    c.is_ascii_digit() || matches!(c, ';' | ':' | '<' | '=' | '>' | '?')
}

fn is_csi_intermediate(c: char) -> bool {
    (' '..='/').contains(&c)
}

fn osc_kind(raw: &str) -> SpanKind {
    if raw.starts_with(OSC8_PREFIX) {
        SpanKind::Osc8
    } else {
        SpanKind::Malformed
    }
}

/// One sequence read at byte `start`, where `text[start]` is ESC.
fn read_sequence(text: &str, start: usize) -> (SpanKind, &str) {
    match text[start + 1..].chars().next() {
        Some('[') => {
            let mut index = start + 2;
            let rest = &text[index..];
            let mut it = rest.chars().peekable();
            while let Some(&c) = it.peek() {
                if !is_csi_parameter(c) {
                    break;
                }
                index += c.len_utf8();
                it.next();
            }
            while let Some(&c) = it.peek() {
                if !is_csi_intermediate(c) {
                    break;
                }
                index += c.len_utf8();
                it.next();
            }
            match it.next() {
                None => (SpanKind::Malformed, &text[start..]),
                Some(final_char) => {
                    let raw = &text[start..index + final_char.len_utf8()];
                    let kind = if final_char == 'm' {
                        SpanKind::Sgr
                    } else {
                        SpanKind::Malformed
                    };
                    (kind, raw)
                }
            }
        }
        Some(']') => {
            let from = start + 2;
            let mut iter = text[from..].char_indices().peekable();
            while let Some((offset, c)) = iter.next() {
                let index = from + offset;
                if c == BEL || c == ST_C1 {
                    let raw = &text[start..index + c.len_utf8()];
                    return (osc_kind(raw), raw);
                }
                if c == ESC {
                    if iter.peek().map(|&(_, n)| n) == Some(ST_FINAL) {
                        let raw = &text[start..index + 2];
                        return (osc_kind(raw), raw);
                    }
                    return (SpanKind::Malformed, &text[start..index]);
                }
            }
            (SpanKind::Malformed, &text[start..])
        }
        Some('P') => {
            let from = start + 2;
            let bytes = text.as_bytes();
            let mut index = from;
            while index < bytes.len() {
                if bytes[index] != 0x1b {
                    index += 1;
                    continue;
                }
                match bytes.get(index + 1) {
                    Some(0x1b) => {
                        index += 2;
                        continue;
                    }
                    Some(b'\\') => return (SpanKind::Dcs, &text[start..index + 2]),
                    _ => return (SpanKind::Malformed, &text[start..index]),
                }
            }
            (SpanKind::Malformed, &text[start..])
        }
        _ => (SpanKind::Malformed, &text[start..start + 1]),
    }
}

fn walk<'a>(
    text: &'a str,
    mut on_text: impl FnMut(&'a str),
    mut on_sequence: impl FnMut(SpanKind, &'a str),
) {
    let mut index = 0;
    while index < text.len() {
        let Some(found) = text[index..].find(ESC) else {
            on_text(&text[index..]);
            return;
        };
        let escape = index + found;
        if escape > index {
            on_text(&text[index..escape]);
        }
        let (kind, raw) = read_sequence(text, escape);
        on_sequence(kind, raw);
        index = escape + raw.len();
    }
}

/// Scan `text` into its ordered span sequence; `measure` applies to `Text` spans only.
pub fn scan(text: &str, measure: Measure) -> ScanResult<'_> {
    let mut spans = Vec::new();
    let mut visible = String::new();
    let mut malformed = false;
    let spans_ref = std::cell::RefCell::new(&mut spans);
    walk(
        text,
        |chunk| {
            spans_ref.borrow_mut().push(Span {
                kind: SpanKind::Text,
                raw: chunk,
                width: measure.width(chunk),
            });
            visible.push_str(chunk);
        },
        |kind, raw| {
            spans_ref.borrow_mut().push(Span {
                kind,
                raw,
                width: 0,
            });
            if kind == SpanKind::Malformed {
                malformed = true;
            }
        },
    );
    ScanResult {
        spans,
        visible,
        malformed,
    }
}

/// `scan` with the default narrow ruler.
pub fn scan_narrow(text: &str) -> ScanResult<'_> {
    scan(text, NARROW_MEASURE)
}

/// Whether `text` carries any terminal sequence at all (an ESC).
pub fn has_sequences(text: &str) -> bool {
    text.contains(ESC)
}

/// Every visible column of `text`, every sequence removed (`scan(text).visible`).
pub fn strip_sequences(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains(ESC) {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut visible = String::with_capacity(text.len());
    walk(text, |chunk| visible.push_str(chunk), |_, _| {});
    std::borrow::Cow::Owned(visible)
}

/// A hyperlink destination with BEL, ESC and C1 ST stripped (Decision 1).
pub fn sanitize_href(href: &str) -> String {
    href.chars()
        .filter(|&c| c != ESC && c != BEL && c != ST_C1)
        .collect()
}

/// `ansi-escapes@7.3.0` `wrapOsc` (`base.js:18-27`), with `isTmux` passed in.
fn wrap_osc(sequence: &str, tmux: bool) -> String {
    if tmux {
        format!(
            "\u{1b}Ptmux;{}\u{1b}\\",
            sequence.replace(ESC, "\u{1b}\u{1b}")
        )
    } else {
        sequence.to_owned()
    }
}

/// An OSC-8 hyperlink (`ansi-escapes@7.3.0` `base.js:141-145`) with the href sanitized.
pub fn link(label: &str, url: &str, tmux: bool) -> String {
    let open = wrap_osc(&format!("{OSC8_PREFIX};{}\u{7}", sanitize_href(url)), tmux);
    let close = wrap_osc(&format!("{OSC8_PREFIX};\u{7}"), tmux);
    format!("{open}{label}{close}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const E: &str = "\u{1b}";

    fn kinds(text: &str) -> Vec<(&'static str, String)> {
        scan_narrow(text)
            .spans
            .iter()
            .map(|s| (s.kind.as_str(), s.raw.to_owned()))
            .collect()
    }

    fn roundtrip(text: &str) {
        let r = scan_narrow(text);
        let joined: String = r.spans.iter().map(|s| s.raw).collect();
        assert_eq!(joined, text);
        assert_eq!(strip_sequences(text), r.visible);
    }

    #[test]
    fn sgr_is_recognised_and_width_zero() {
        let t = format!("{E}[31mred{E}[39m");
        let r = scan_narrow(&t);
        assert_eq!(r.visible, "red");
        assert!(!r.malformed);
        assert_eq!(r.spans.len(), 3);
        assert_eq!(r.spans[0].kind, SpanKind::Sgr);
        assert_eq!(r.spans[0].width, 0);
        assert_eq!(r.spans[1].width, 3);
    }

    #[test]
    fn non_sgr_csi_is_malformed() {
        assert_eq!(
            kinds(&format!("{E}[2Jx")),
            vec![("malformed", format!("{E}[2J")), ("text", "x".into())]
        );
        assert_eq!(
            kinds(&format!("a{E}[12")),
            vec![("text", "a".into()), ("malformed", format!("{E}[12"))]
        );
    }

    #[test]
    fn osc8_with_each_terminator() {
        for term in ["\u{7}", "\u{1b}\\", "\u{9c}"] {
            let t = format!("{E}]8;;https://x{term}label");
            let k = kinds(&t);
            assert_eq!(k[0].0, "osc8", "{term:?}");
            assert_eq!(k[1], ("text", "label".into()));
            roundtrip(&t);
        }
        assert_eq!(kinds(&format!("{E}]0;title\u{7}"))[0].0, "malformed");
    }

    #[test]
    fn osc_with_a_stray_esc_stops_before_it() {
        let t = format!("{E}]8;;x{E}[31mz");
        assert_eq!(
            kinds(&t),
            vec![
                ("malformed", format!("{E}]8;;x")),
                ("sgr", format!("{E}[31m")),
                ("text", "z".into())
            ]
        );
        assert_eq!(kinds(&format!("{E}]8;;x"))[0].0, "malformed");
    }

    #[test]
    fn dcs_doubles_esc_and_ends_at_st() {
        let wrapped = link("lbl", "https://x", true);
        let k = kinds(&wrapped);
        assert_eq!(
            k.iter().map(|x| x.0).collect::<Vec<_>>(),
            vec!["dcs", "text", "dcs"]
        );
        assert_eq!(strip_sequences(&wrapped), "lbl");
        assert_eq!(
            kinds(&format!("{E}Pabc{E}x"))[0],
            ("malformed", format!("{E}Pabc"))
        );
        assert_eq!(kinds(&format!("{E}Pabc"))[0].0, "malformed");
    }

    #[test]
    fn unknown_introducer_consumes_the_esc_alone() {
        assert_eq!(
            kinds(&format!("{E}Zab")),
            vec![("malformed", E.into()), ("text", "Zab".into())]
        );
        assert_eq!(kinds(E), vec![("malformed", E.into())]);
        assert!(scan_narrow(&format!("{E}Z")).malformed);
    }

    #[test]
    fn sentinels_are_text() {
        assert_eq!(kinds("\u{0}a\u{1}"), vec![("text", "\u{0}a\u{1}".into())]);
    }

    #[test]
    fn spans_concatenate_back_over_a_generated_corpus() {
        let pieces = [
            "a", " ", "漢", "😀", E, "[", "31", "m", "]", "8;;", "\u{7}", "\\", "P", "\u{9c}", ";",
            "\u{0}",
        ];
        let mut seed: u32 = 7;
        for _ in 0..2000 {
            let mut s = String::new();
            for _ in 0..12 {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                s.push_str(pieces[(seed >> 16) as usize % pieces.len()]);
            }
            roundtrip(&s);
        }
    }

    #[test]
    fn link_matches_ansi_escapes_bytes() {
        assert_eq!(link("l", "u", false), format!("{E}]8;;u\u{7}l{E}]8;;\u{7}"));
        assert_eq!(
            link("l", "u", true),
            format!("{E}Ptmux;{E}{E}]8;;u\u{7}{E}\\l{E}Ptmux;{E}{E}]8;;\u{7}{E}\\")
        );
        assert_eq!(
            link("l", "a\u{7}b\u{1b}c\u{9c}d", false),
            format!("{E}]8;;abcd\u{7}l{E}]8;;\u{7}")
        );
    }

    #[test]
    fn has_sequences_is_an_esc_test() {
        assert!(has_sequences("a\u{1b}"));
        assert!(!has_sequences("a\u{9b}31m"));
    }
}
