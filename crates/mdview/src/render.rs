//! The render entry point: sentinels, `wrapCode`, code ranges, the post-compose passes.
//!
//! WP-1 of `plans/mdview-rust-port.md` declares only the signature, and the body is a stub that
//! **always fails**: a Rust side that renders nothing must never pass any gate, so the parity
//! server reports `error: "unimplemented"` for every request and `render-diff` counts it as an
//! error, never as a match. WP-3 fills it.

use crate::token::Token;

/// Glyph capability tier (mirrors `src/glyphs.ts`'s `GlyphTier`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Unicode,
    Ascii,
}

/// East Asian Ambiguous width (mirrors `src/width.ts`'s `AmbiguousWidth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ambiguous {
    Narrow,
    Wide,
}

/// How much SGR a render emits (mirrors `src/colour.ts`'s `SgrMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sgr {
    Full,
    Formats,
    None,
}

/// The resolved colour policy, passed explicitly — never read from the environment here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub sgr: Sgr,
    pub hyperlinks: bool,
    pub tmux: bool,
}

/// Every input `renderDocumentDetailed` takes, by value.
#[derive(Debug, Clone)]
pub struct RenderOptions {
    pub width: usize,
    pub tier: Tier,
    pub ambiguous: Ambiguous,
    pub policy: Policy,
    pub emoji: Option<bool>,
    /// The viewed file's path, for the wiki-link resolver under hyperlinks.
    pub path: Option<String>,
}

/// What a render returns: the text and its 1-based inclusive code ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderOutput {
    pub text: String,
    pub code_ranges: Vec<(usize, usize)>,
}

/// Why a render did not produce output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    Unimplemented,
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::Unimplemented => f.write_str("unimplemented"),
        }
    }
}

/// Render `source`. `tokens`, when given, replaces the adapter's lex of the body (the R-gate).
pub fn render(
    _source: &str,
    _tokens: Option<&[Token]>,
    _options: &RenderOptions,
) -> Result<RenderOutput, RenderError> {
    Err(RenderError::Unimplemented)
}
