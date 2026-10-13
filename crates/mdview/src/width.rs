//! Display width: the owned port of `string-width@8.2.2` (`node_modules/string-width/index.js`)
//! and of `TS_BASELINE` `src/width.ts`'s `Measure` around it.
//!
//! Not `unicode-width`: that crate disagrees with string-width on ambiguous characters
//! (spike S5). The data tables are generated (`width/tables.rs`, `bun run
//! scripts/gen-width-tables.ts`) from two independent inputs — the engine's `\p{…}` classes
//! and `get-east-asian-width@1.6.0`'s `lookup.js` — and this file is the algorithm.
//!
//! The probe and its cache are `TS_BASELINE` `src/width.ts` too, but live in `probe.rs`.
//!
//! Two seams this port documents rather than hides:
//! - **Segmentation.** TS segments with ICU (`Intl.Segmenter`), this with
//!   `unicode-segmentation`; WP-2's gate 2 measures their agreement over the corpus.
//! - **`segment.length > 50`** (`isDoubleWidthNonRgiEmojiSequence`) is a UTF-16 length, and is
//!   computed as one here. Lone surrogates (the `\p{Surrogate}` arm) cannot occur in a Rust
//!   `str`.

mod tables;

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use unicode_segmentation::UnicodeSegmentation;

use crate::text::utf16_len;

/// East Asian Ambiguous width (mirrors `TS_BASELINE` `src/width.ts`'s `AmbiguousWidth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ambiguous {
    Narrow,
    Wide,
}

/// `ansi-regex@6.2.2`'s pattern, which both `TS_BASELINE` `src/width.ts`'s `ANSI_SEQUENCE` and
/// `strip-ansi` use. `\d` is spelled `[0-9]` (the `regex` crate's `\d` is Unicode).
static ANSI_SEQUENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:\x1B\](?s:.)*?(?:\x07|\x1B\x5C|\x{9C}))|[\x1B\x{9B}][\[\]()#;?]*(?:[0-9]{1,4}(?:[;:][0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]",
    )
    .expect("ANSI_SEQUENCE compiles")
});

/// `stripAnsi`: remove every ansi-regex match (fast path when no introducer is present).
pub fn strip_ansi_regex(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains('\u{1b}') || text.contains('\u{9b}') {
        ANSI_SEQUENCE.replace_all(text, "")
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

fn in_table(table: &[(u32, u32)], c: char) -> bool {
    let cp = c as u32;
    table
        .binary_search_by(|&(lo, hi)| {
            if hi < cp {
                std::cmp::Ordering::Less
            } else if lo > cp {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn is_zero_width_char(c: char) -> bool {
    in_table(tables::ZERO_WIDTH, c)
}

fn is_extended_pictographic(c: char) -> bool {
    in_table(tables::EXTENDED_PICTOGRAPHIC, c)
}

/// `get-east-asian-width`'s `eastAsianWidth(codePoint, {ambiguousAsWide})`.
pub fn east_asian_width(c: char, ambiguous_as_wide: bool) -> usize {
    if in_table(tables::EAW_WIDE, c) || (ambiguous_as_wide && in_table(tables::EAW_AMBIGUOUS, c)) {
        2
    } else {
        1
    }
}

/// `/^\p{RGI_Emoji}$/v`, exact wherever it can change a width: the table holds every RGI
/// string whose first scalar is not EAW wide; for a wide-first string the fallback branch
/// below returns the same 2 (see `scripts/gen-width-tables.ts`).
fn is_rgi_emoji_for_width(segment: &str) -> bool {
    tables::RGI_NARROW_FIRST
        .binary_search_by(|probe| probe.as_bytes().cmp(segment.as_bytes()))
        .is_ok()
}

fn is_double_width_non_rgi_emoji_sequence(segment: &str) -> bool {
    // UTF-16 length, as `segment.length` is in JS.
    if utf16_len(segment) > 50 {
        return false;
    }
    let mut chars = segment.chars();
    if let (Some(first), Some('\u{20E3}'), None) = (chars.next(), chars.next(), chars.next())
        && (first.is_ascii_digit() || first == '#' || first == '*')
    {
        return true;
    }
    if segment.contains('\u{200D}') {
        return segment
            .chars()
            .filter(|&c| is_extended_pictographic(c))
            .count()
            >= 2;
    }
    false
}

fn is_hangul_leading(cp: u32) -> bool {
    (0x1100..=0x115F).contains(&cp) || (0xA960..=0xA97C).contains(&cp)
}
fn is_hangul_vowel(cp: u32) -> bool {
    (0x1160..=0x11A7).contains(&cp) || (0xD7B0..=0xD7C6).contains(&cp)
}
fn is_hangul_trailing(cp: u32) -> bool {
    (0x11A8..=0x11FF).contains(&cp) || (0xD7CB..=0xD7FB).contains(&cp)
}
fn is_hangul_jamo(cp: u32) -> bool {
    is_hangul_leading(cp) || is_hangul_vowel(cp) || is_hangul_trailing(cp)
}

fn hangul_cluster_width(visible: &str, wide: bool) -> Option<usize> {
    let points: Vec<char> = visible
        .chars()
        .filter(|&c| !is_zero_width_char(c))
        .collect();
    if points.is_empty() {
        return None;
    }
    let mut width = 0;
    let mut index = 0;
    while index < points.len() {
        let cp = points[index] as u32;
        if !is_hangul_jamo(cp) {
            if width == 0 {
                return None;
            }
            for &rest in &points[index..] {
                width += east_asian_width(rest, wide);
            }
            return Some(width);
        }
        if is_hangul_leading(cp)
            && points
                .get(index + 1)
                .is_some_and(|&n| is_hangul_vowel(n as u32))
        {
            width += 2;
            index += if points
                .get(index + 2)
                .is_some_and(|&n| is_hangul_trailing(n as u32))
            {
                3
            } else {
                2
            };
            continue;
        }
        width += east_asian_width(points[index], wide);
        index += 1;
    }
    Some(width)
}

fn trailing_width(visible: &str, wide: bool) -> usize {
    visible
        .chars()
        .skip(1)
        .filter(|&c| in_table(tables::SPACING_MARK, c) || ('\u{FF00}'..='\u{FFEF}').contains(&c))
        .map(|c| east_asian_width(c, wide))
        .sum()
}

/// `stringWidth(input, {ambiguousIsNarrow})` from `string-width@8.2.2`, transcribed.
pub fn string_width(input: &str, ambiguous_is_narrow: bool) -> usize {
    if input.is_empty() {
        return 0;
    }
    let string = strip_ansi_regex(input);
    if string.is_empty() {
        return 0;
    }
    if string.chars().all(|c| ('\u{20}'..='\u{7E}').contains(&c)) {
        return utf16_len(&string);
    }
    let wide = !ambiguous_is_narrow;
    let mut width = 0;
    for segment in string.graphemes(true) {
        if segment.chars().all(is_zero_width_char) {
            continue;
        }
        if is_rgi_emoji_for_width(segment) || is_double_width_non_rgi_emoji_sequence(segment) {
            width += 2;
            continue;
        }
        let visible = segment.trim_start_matches(is_zero_width_char);
        if let Some(h) = hangul_cluster_width(visible, wide) {
            width += h;
            continue;
        }
        let first = visible
            .chars()
            .next()
            .expect("a non-zero-width cluster has a visible scalar");
        width += east_asian_width(first, wide);
        width += trailing_width(visible, wide);
    }
    width
}

/// The cap `TS_BASELINE` `src/width.ts` puts on each per-cluster cache before clearing it.
const WIDTH_CACHE_LIMIT: usize = 4096;

thread_local! {
    static CACHES: RefCell<[HashMap<String, usize>; 2]> = RefCell::new([HashMap::new(), HashMap::new()]);
}

/// A display-width ruler with its ambiguous mode attached (`TS_BASELINE` `src/width.ts`'s `Measure`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Measure {
    pub ambiguous: Ambiguous,
}

impl Measure {
    /// Columns `text` occupies: sequences stripped, then the sum of each grapheme
    /// cluster's own `stringWidth`, memoized per cluster.
    ///
    /// The narrow ruler calls string-width with **no options** (`width.ts:146-154`) — the
    /// library default `ambiguousIsNarrow: true` — and the wide one with
    /// `{ambiguousIsNarrow: false}`.
    pub fn width(&self, text: &str) -> usize {
        let plain = strip_ansi_regex(text);
        let slot = usize::from(self.ambiguous == Ambiguous::Wide);
        let narrow = self.ambiguous == Ambiguous::Narrow;
        CACHES.with(|caches| {
            let mut caches = caches.borrow_mut();
            let cache = &mut caches[slot];
            let mut total = 0;
            for segment in plain.graphemes(true) {
                if let Some(&hit) = cache.get(segment) {
                    total += hit;
                    continue;
                }
                let w = string_width(segment, narrow);
                if cache.len() >= WIDTH_CACHE_LIMIT {
                    cache.clear();
                }
                cache.insert(segment.to_owned(), w);
                total += w;
            }
            total
        })
    }
}

pub const NARROW_MEASURE: Measure = Measure {
    ambiguous: Ambiguous::Narrow,
};
pub const WIDE_MEASURE: Measure = Measure {
    ambiguous: Ambiguous::Wide,
};

/// `measureFor`.
pub fn measure_for(ambiguous: Ambiguous) -> Measure {
    Measure { ambiguous }
}

/// `parseAmbiguousWidth`: exactly `narrow` or `wide`, anything else `None`.
pub fn parse_ambiguous_width(value: Option<&str>) -> Option<Ambiguous> {
    match value {
        Some("narrow") => Some(Ambiguous::Narrow),
        Some("wide") => Some(Ambiguous::Wide),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(s: &str) -> usize {
        NARROW_MEASURE.width(s)
    }
    fn w(s: &str) -> usize {
        WIDE_MEASURE.width(s)
    }

    #[test]
    fn ascii_and_empty() {
        assert_eq!(n(""), 0);
        assert_eq!(n("hello"), 5);
        assert_eq!(w("hello"), 5);
    }

    #[test]
    fn ambiguous_characters_follow_the_mode() {
        for s in ["—", "–", "→", "…", "•", "─", "│", "×", "é"] {
            assert_eq!(n(s), 1, "{s} narrow");
        }
        for s in ["—", "→", "•", "─", "│"] {
            assert_eq!(w(s), 2, "{s} wide");
        }
        assert_eq!(n("é"), 1);
        for s in ["◦", "‣", "✓"] {
            assert_eq!(w(s), 1, "{s} is 1 either way");
        }
    }

    #[test]
    fn cjk_and_emoji_are_double_width_in_both_modes() {
        assert_eq!(n("漢字"), 4);
        assert_eq!(w("漢字"), 4);
        assert_eq!(n("😀"), 2);
        assert_eq!(n("👨‍👩‍👧"), 2);
        assert_eq!(n("❤️"), 2);
        assert_eq!(n("❤"), 1);
        assert_eq!(n("🇺🇸"), 2);
        assert_eq!(n("#️⃣"), 2);
        assert_eq!(n("#\u{20E3}"), 2);
        assert_eq!(n("👍🏽"), 2);
    }

    #[test]
    fn zero_width_clusters_and_marks() {
        assert_eq!(n("\u{200B}"), 0);
        assert_eq!(n("\u{301}"), 0);
        assert_eq!(n("e\u{301}"), 1);
        assert_eq!(n("\t"), 0);
        assert_eq!(n("\u{0}"), 0);
        assert_eq!(n("ｶﾞ"), 2);
    }

    #[test]
    fn hangul_jamo_compose_to_a_syllable_block() {
        assert_eq!(n("\u{1100}\u{1161}"), 2);
        assert_eq!(n("\u{1100}\u{1161}\u{11A8}"), 2);
        assert_eq!(n("한국어"), 6);
    }

    #[test]
    fn sequences_are_stripped_before_measurement() {
        assert_eq!(n("\u{1b}[31mred\u{1b}[39m"), 3);
        assert_eq!(n("\u{1b}]8;;https://x\u{7}label\u{1b}]8;;\u{7}"), 5);
        assert_eq!(n("\u{9b}31mx"), 1);
    }

    #[test]
    fn the_cache_does_not_change_answers() {
        for _ in 0..3 {
            assert_eq!(n("—a—"), 3);
            assert_eq!(w("—a—"), 5);
        }
    }

    #[test]
    fn string_width_matches_its_own_fast_path() {
        assert_eq!(string_width("abc", true), 3);
        assert_eq!(string_width("\u{1b}[1m", true), 0);
    }

    #[test]
    fn parse_ambiguous_width_is_exact() {
        assert_eq!(parse_ambiguous_width(Some("wide")), Some(Ambiguous::Wide));
        assert_eq!(
            parse_ambiguous_width(Some("narrow")),
            Some(Ambiguous::Narrow)
        );
        assert_eq!(parse_ambiguous_width(Some("WIDE")), None);
        assert_eq!(parse_ambiguous_width(None), None);
        assert_eq!(measure_for(Ambiguous::Wide), WIDE_MEASURE);
    }
}
