//! The Unicode/ASCII capability tier, ported from `TS_BASELINE` `src/glyphs.ts`.
//!
//! Handed an environment value, never reading one. Precedence, highest first: resolved
//! ambiguous width `wide` (forces ASCII, `glyphs.ts:113`) → the `--ascii`/`--unicode`
//! override → `MDVIEW_GLYPHS` → detection (`TERM` in the dumb list → ASCII, else a UTF-8
//! locale → Unicode).

use std::sync::LazyLock;

use regex::Regex;

use crate::colour::Env;
pub use crate::render::Tier as GlyphTier;
use crate::width::AmbiguousWidth;

/// One tier's glyphs.
#[derive(Debug, PartialEq, Eq)]
pub struct GlyphSet {
    pub tier: GlyphTier,
    pub bullets: &'static [&'static str],
    pub rule: &'static str,
    /// `cli-table3`-named border characters, in `TS_BASELINE` `src/glyphs.ts`'s order; `None` = box drawing.
    pub table_chars: Option<&'static [(&'static str, &'static str)]>,
    pub rewrite_task_states: bool,
}

impl GlyphSet {
    /// One border character by its `cli-table3` name.
    pub fn table_char(&self, name: &str) -> Option<&'static str> {
        self.table_chars?
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| *v)
    }
}

pub static UNICODE_GLYPHS: GlyphSet = GlyphSet {
    tier: GlyphTier::Unicode,
    bullets: &["•", "◦", "‣"],
    rule: "─",
    table_chars: None,
    rewrite_task_states: true,
};

const ASCII_TABLE_CHARS: &[(&str, &str)] = &[
    ("top", "-"),
    ("top-mid", "+"),
    ("top-left", "+"),
    ("top-right", "+"),
    ("bottom", "-"),
    ("bottom-mid", "+"),
    ("bottom-left", "+"),
    ("bottom-right", "+"),
    ("left", "|"),
    ("left-mid", "+"),
    ("mid", "-"),
    ("mid-mid", "+"),
    ("right", "|"),
    ("right-mid", "+"),
    ("middle", "|"),
];

pub static ASCII_GLYPHS: GlyphSet = GlyphSet {
    tier: GlyphTier::Ascii,
    bullets: &["-"],
    rule: "-",
    table_chars: Some(ASCII_TABLE_CHARS),
    rewrite_task_states: false,
};

/// The set for a tier.
pub fn glyphs_for(tier: GlyphTier) -> &'static GlyphSet {
    match tier {
        GlyphTier::Unicode => &UNICODE_GLYPHS,
        GlyphTier::Ascii => &ASCII_GLYPHS,
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

fn detect_tier(env: &Env) -> GlyphTier {
    let term = env.get("TERM").map(String::as_str).unwrap_or("");
    if DUMB_TERMS.contains(&term) {
        return GlyphTier::Ascii;
    }
    if has_utf8_locale(env) {
        GlyphTier::Unicode
    } else {
        GlyphTier::Ascii
    }
}

/// `resolveGlyphs(env, override, ambiguous)`.
pub fn resolve_glyphs(
    env: &Env,
    override_tier: Option<GlyphTier>,
    ambiguous: Option<AmbiguousWidth>,
) -> &'static GlyphSet {
    if ambiguous == Some(AmbiguousWidth::Wide) {
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
pub fn wide_forces_ascii(override_tier: Option<GlyphTier>, ambiguous: AmbiguousWidth) -> bool {
    ambiguous == AmbiguousWidth::Wide && override_tier == Some(GlyphTier::Unicode)
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
            GlyphTier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LANG", "en_US.utf8")]), None, None).tier,
            GlyphTier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LANG", "C")]), None, None).tier,
            GlyphTier::Ascii
        );
        assert_eq!(
            resolve_glyphs(&Env::new(), None, None).tier,
            GlyphTier::Ascii
        );
        for term in DUMB_TERMS {
            assert_eq!(
                resolve_glyphs(&env(&[("TERM", term), ("LANG", "en_US.UTF-8")]), None, None).tier,
                GlyphTier::Ascii
            );
        }
        // An empty LC_ALL falls through to LANG (`||`, not `??`).
        assert_eq!(
            resolve_glyphs(&env(&[("LC_ALL", ""), ("LANG", "x.UTF-8")]), None, None).tier,
            GlyphTier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("LC_ALL", "C"), ("LANG", "x.UTF-8")]), None, None).tier,
            GlyphTier::Ascii
        );
    }

    #[test]
    fn precedence_wide_then_override_then_env() {
        let utf = env(&[("LANG", "en_US.UTF-8"), ("MDVIEW_GLYPHS", "ascii")]);
        assert_eq!(resolve_glyphs(&utf, None, None).tier, GlyphTier::Ascii);
        assert_eq!(
            resolve_glyphs(&utf, Some(GlyphTier::Unicode), None).tier,
            GlyphTier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&utf, Some(GlyphTier::Unicode), Some(AmbiguousWidth::Wide)).tier,
            GlyphTier::Ascii
        );
        assert_eq!(
            resolve_glyphs(&env(&[("MDVIEW_GLYPHS", "unicode")]), None, None).tier,
            GlyphTier::Unicode
        );
        assert_eq!(
            resolve_glyphs(&env(&[("MDVIEW_GLYPHS", "UNICODE")]), None, None).tier,
            GlyphTier::Ascii
        );
    }

    #[test]
    fn wide_forces_ascii_only_for_an_explicit_unicode() {
        assert!(wide_forces_ascii(
            Some(GlyphTier::Unicode),
            AmbiguousWidth::Wide
        ));
        assert!(!wide_forces_ascii(None, AmbiguousWidth::Wide));
        assert!(!wide_forces_ascii(
            Some(GlyphTier::Unicode),
            AmbiguousWidth::Narrow
        ));
    }

    #[test]
    fn every_glyph_is_one_column_narrow_and_ascii_in_both() {
        for g in UNICODE_GLYPHS.bullets.iter().chain([&UNICODE_GLYPHS.rule]) {
            assert_eq!(NARROW_MEASURE.width(g), 1, "{g}");
        }
        assert_eq!(WIDE_MEASURE.width("•"), 2);
        for (_, c) in ASCII_TABLE_CHARS {
            assert_eq!(WIDE_MEASURE.width(c), 1);
        }
        assert_eq!(ASCII_GLYPHS.table_char("top-left"), Some("+"));
        assert_eq!(UNICODE_GLYPHS.table_char("top-left"), None);
        assert!(!ASCII_GLYPHS.rewrite_task_states);
    }
}
