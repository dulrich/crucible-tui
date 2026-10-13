//! The Unicode/ASCII capability tier, ported from `TS_BASELINE` `src/glyphs.ts`.
//!
//! Handed an environment value, never reading one. Precedence, highest first: resolved
//! ambiguous width `wide` (forces ASCII, `glyphs.ts:113`) → the `--ascii`/`--unicode`
//! override → `MDVIEW_GLYPHS` → detection (`TERM` in the dumb list → ASCII, else a UTF-8
//! locale → Unicode).

use std::sync::LazyLock;

use regex::Regex;

use crate::colour::Env;
use crate::width::Ambiguous;

/// Glyph capability tier (mirrors `TS_BASELINE` `src/glyphs.ts`'s `GlyphTier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Unicode,
    Ascii,
}

/// One border glyph per slot (`TS_BASELINE` `table.ts:639`), `cli-table3`'s slot names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BorderChars {
    pub top_left: &'static str,
    pub top_mid: &'static str,
    pub top: &'static str,
    pub top_right: &'static str,
    pub left_mid: &'static str,
    pub mid_mid: &'static str,
    pub mid: &'static str,
    pub right_mid: &'static str,
    pub bottom_left: &'static str,
    pub bottom_mid: &'static str,
    pub bottom: &'static str,
    pub bottom_right: &'static str,
    pub left: &'static str,
    pub middle: &'static str,
    pub right: &'static str,
}

/// `UNICODE_BORDER` (`table.ts:666`): `cli-table3`'s default charset, byte for byte.
pub const UNICODE_BORDER: BorderChars = BorderChars {
    top_left: "┌",
    top_mid: "┬",
    top: "─",
    top_right: "┐",
    left_mid: "├",
    mid_mid: "┼",
    mid: "─",
    right_mid: "┤",
    bottom_left: "└",
    bottom_mid: "┴",
    bottom: "─",
    bottom_right: "┘",
    left: "│",
    middle: "│",
    right: "│",
};

/// The ASCII tier's border (`TS_BASELINE` `src/glyphs.ts`'s `tableChars`).
pub const ASCII_BORDER: BorderChars = BorderChars {
    top_left: "+",
    top_mid: "+",
    top: "-",
    top_right: "+",
    left_mid: "+",
    mid_mid: "+",
    mid: "-",
    right_mid: "+",
    bottom_left: "+",
    bottom_mid: "+",
    bottom: "-",
    bottom_right: "+",
    left: "|",
    middle: "|",
    right: "|",
};

/// One tier's glyphs.
#[derive(Debug, PartialEq, Eq)]
pub struct GlyphSet {
    pub tier: Tier,
    pub bullets: &'static [&'static str],
    pub rule: &'static str,
    pub border: &'static BorderChars,
    pub rewrite_task_states: bool,
}

pub static UNICODE_GLYPHS: GlyphSet = GlyphSet {
    tier: Tier::Unicode,
    bullets: &["•", "◦", "‣"],
    rule: "─",
    border: &UNICODE_BORDER,
    rewrite_task_states: true,
};

pub static ASCII_GLYPHS: GlyphSet = GlyphSet {
    tier: Tier::Ascii,
    bullets: &["-"],
    rule: "-",
    border: &ASCII_BORDER,
    rewrite_task_states: false,
};

/// The set for a tier.
pub fn glyphs_for(tier: Tier) -> &'static GlyphSet {
    match tier {
        Tier::Unicode => &UNICODE_GLYPHS,
        Tier::Ascii => &ASCII_GLYPHS,
    }
}

const DUMB_TERMS: &[&str] = &["linux", "dumb", "vt100", "vt220", "ansi"];

static UTF8: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)utf-?8").expect("utf8 regex"));

fn non_empty<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|v| !v.is_empty())
}

fn has_utf8_locale(env: &Env) -> bool {
    let locale = non_empty(env, "LC_ALL")
        .or_else(|| non_empty(env, "LC_CTYPE"))
        .or_else(|| non_empty(env, "LANG"))
        .unwrap_or("");
    UTF8.is_match(locale)
}

fn detect_tier(env: &Env) -> Tier {
    let term = env.get("TERM").map(String::as_str).unwrap_or("");
    if DUMB_TERMS.contains(&term) {
        return Tier::Ascii;
    }
    if has_utf8_locale(env) {
        Tier::Unicode
    } else {
        Tier::Ascii
    }
}

/// `resolveGlyphs(env, override, ambiguous)`.
pub fn resolve_glyphs(
    env: &Env,
    override_tier: Option<Tier>,
    ambiguous: Option<Ambiguous>,
) -> &'static GlyphSet {
    if ambiguous == Some(Ambiguous::Wide) {
        return &ASCII_GLYPHS;
    }
    if let Some(tier) = override_tier {
        return glyphs_for(tier);
    }
    match env.get("MDVIEW_GLYPHS").map(String::as_str) {
        Some("ascii") => return &ASCII_GLYPHS,
        Some("unicode") => return &UNICODE_GLYPHS,
        _ => {}
    }
    glyphs_for(detect_tier(env))
}

/// `wideForcesAscii`: whether an explicit `--unicode` is being overridden by `wide`.
pub fn wide_forces_ascii(override_tier: Option<Tier>, ambiguous: Ambiguous) -> bool {
    ambiguous == Ambiguous::Wide && override_tier == Some(Tier::Unicode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::{NARROW_MEASURE, WIDE_MEASURE};

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn detection_by_term_and_locale() {
        assert_eq!(
            resolve_glyphs(&env(&[("LANG", "en_US.UTF-8")]), None, None).tier,
            Tier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LANG", "en_US.utf8")]), None, None).tier,
            Tier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LANG", "C")]), None, None).tier,
            Tier::Ascii
        );
        assert_eq!(resolve_glyphs(&Env::new(), None, None).tier, Tier::Ascii);
        for term in DUMB_TERMS {
            assert_eq!(
                resolve_glyphs(&env(&[("TERM", term), ("LANG", "en_US.UTF-8")]), None, None).tier,
                Tier::Ascii
            );
        }
        // An empty LC_ALL falls through to LANG (`||`, not `??`).
        assert_eq!(
            resolve_glyphs(&env(&[("LC_ALL", ""), ("LANG", "x.UTF-8")]), None, None).tier,
            Tier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LC_ALL", "C"), ("LANG", "x.UTF-8")]), None, None).tier,
            Tier::Ascii
        );
    }

    #[test]
    fn precedence_wide_then_override_then_env() {
        let utf = env(&[("LANG", "en_US.UTF-8"), ("MDVIEW_GLYPHS", "ascii")]);
        assert_eq!(resolve_glyphs(&utf, None, None).tier, Tier::Ascii);
        assert_eq!(
            resolve_glyphs(&utf, Some(Tier::Unicode), None).tier,
            Tier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&utf, Some(Tier::Unicode), Some(Ambiguous::Wide)).tier,
            Tier::Ascii
        );
        assert_eq!(
            resolve_glyphs(&env(&[("MDVIEW_GLYPHS", "unicode")]), None, None).tier,
            Tier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("MDVIEW_GLYPHS", "UNICODE")]), None, None).tier,
            Tier::Ascii
        );
    }

    #[test]
    fn wide_forces_ascii_only_for_an_explicit_unicode() {
        assert!(wide_forces_ascii(Some(Tier::Unicode), Ambiguous::Wide));
        assert!(!wide_forces_ascii(None, Ambiguous::Wide));
        assert!(!wide_forces_ascii(Some(Tier::Unicode), Ambiguous::Narrow));
    }

    #[test]
    fn every_glyph_is_one_column_narrow_and_ascii_in_both() {
        for g in UNICODE_GLYPHS.bullets.iter().chain([&UNICODE_GLYPHS.rule]) {
            assert_eq!(NARROW_MEASURE.width(g), 1, "{g}");
        }
        assert_eq!(WIDE_MEASURE.width("•"), 2);
        let b = ASCII_GLYPHS.border;
        for c in [
            b.top_left,
            b.top_mid,
            b.top,
            b.top_right,
            b.left_mid,
            b.mid_mid,
            b.mid,
            b.right_mid,
            b.bottom_left,
            b.bottom_mid,
            b.bottom,
            b.bottom_right,
            b.left,
            b.middle,
            b.right,
        ] {
            assert_eq!(WIDE_MEASURE.width(c), 1);
        }
        assert_eq!(ASCII_GLYPHS.border.top_left, "+");
        assert_eq!(UNICODE_GLYPHS.border.top_left, "┌");
        assert!(!ASCII_GLYPHS.rewrite_task_states);
    }
}
