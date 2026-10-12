//! The render entry point, ported from `src/render.ts` (WP-3 of `plans/mdview-rust-port.md`):
//! the code sentinel, `wrapCode`, the code-range walk, the post-compose passes and
//! `renderDocumentDetailed`'s orchestration.
//!
//! A feature a later work package owns — lists (WP-4), tables (WP-5), the highlighter (WP-6) —
//! returns `RenderError::Missing(feature)`, never a panic and never a partial render, so the
//! parity server reports `unimplemented: <feature>` and `render-diff` counts it as an error.
//!
//! The list-free halves of `src/list-layout.ts`'s `text`/`paragraph`/`heading`/`blockquote`
//! visitors live here until WP-4 owns that module: with no list open, `listDepth() === 0`, so
//! `wrappedText` is `renderInlineText` and the `inlineDepth`/`quoteColumns` counters are read
//! by nothing.

use std::rc::Rc;
use std::sync::LazyLock;

use regex::Regex;

use crate::blocks;
use crate::context::{LayoutContext, LayoutContextInit, PrefixEntry};
use crate::frontmatter;
use crate::glyphs::{GlyphSet, glyphs_for};
use crate::inline;
use crate::lang::{AliasOnlySupport, FenceLanguageResolver};
use crate::lex;
use crate::list_lines::{is_guard_shaped_line, strip_ansi};
use crate::token::Token;
use crate::walk::{self, R, Visitors};
use crate::width::{Measure, measure_for};
use crate::wikilink;

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
    /// The renderer as a whole is not available.
    Unimplemented,
    /// A feature a later work package owns: `list`, `table` or `highlight`.
    Missing(&'static str),
    /// `walk.ts`'s `Token with "…" type was not found.`: a token reached the wrong walk.
    UnknownToken(&'static str),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::Unimplemented => f.write_str("unimplemented"),
            RenderError::Missing(feature) => write!(f, "unimplemented: {feature}"),
            RenderError::UnknownToken(t) => write!(f, "Token with \"{t}\" type was not found."),
        }
    }
}

/// `SENTINEL`: code point 0 brackets every rendered fence.
pub const SENTINEL: char = '\u{0}';
/// `TASK_STATE_SENTINEL`: code point 1, the ASCII tier's task-literal marker.
const TASK_STATE_SENTINEL: char = '\u{1}';

/// `wrapCode`: sentinels around the fence, trailing newlines left outside.
fn wrap_code(rendered: &str) -> String {
    let trimmed = rendered.trim_end_matches('\n');
    let trailing = &rendered[trimmed.len()..];
    format!("{SENTINEL}{trimmed}{SENTINEL}{trailing}")
}

/// `renderRule`.
fn render_rule(glyphs: &GlyphSet, target_width: usize, measure: Measure) -> String {
    let glyph_columns = measure.width(glyphs.rule).max(1);
    glyphs
        .rule
        .repeat(target_width.saturating_sub(1) / glyph_columns)
}

/// `extractCodeRanges`: remove the sentinels, recording 1-based inclusive line spans.
fn extract_code_ranges(rendered: &str) -> RenderOutput {
    let mut code_ranges = Vec::new();
    let mut text = String::with_capacity(rendered.len());
    let mut line = 1;
    let mut open: Option<usize> = None;
    for ch in rendered.chars() {
        if ch == SENTINEL {
            match open.take() {
                None => open = Some(line),
                Some(start) => code_ranges.push((start, line)),
            }
            continue;
        }
        text.push(ch);
        if ch == '\n' {
            line += 1;
        }
    }
    RenderOutput { text, code_ranges }
}

/// `EMOJI_TRAILING_SPACE`; the pass runs per line, so `$` is the line's end.
static EMOJI_TRAILING_SPACE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(\p{Extended_Pictographic}\x{FE0F}?) ((?:\x1b\[[0-9;]*m)*)$")
        .expect("emoji trailing-space regex compiles")
});

fn strip_emoji_line(line: &str) -> String {
    EMOJI_TRAILING_SPACE.replace(line, "${1}${2}").into_owned()
}

/// `stripEmojiTrailingSpace`, code ranges exempt.
fn strip_emoji_trailing_space(body: &str, code_ranges: &[(usize, usize)]) -> String {
    let mut range_index = 0;
    body.split('\n')
        .enumerate()
        .map(|(index, line)| {
            let line_number = index + 1;
            while range_index < code_ranges.len() && code_ranges[range_index].1 < line_number {
                range_index += 1;
            }
            let in_code = code_ranges
                .get(range_index)
                .is_some_and(|&(a, b)| line_number >= a && line_number <= b);
            if in_code {
                line.to_owned()
            } else {
                strip_emoji_line(line)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The owned renderer object: every visitor `src/render.ts` installs, over one layout.
struct Renderer<'a> {
    layout: &'a LayoutContext,
}

impl Renderer<'_> {
    fn budget(&self) -> usize {
        self.layout
            .width
            .saturating_sub(self.layout.prefix.width())
            .max(1)
    }
}

impl Visitors for Renderer<'_> {
    fn hr(&self) -> R {
        let l = self.layout;
        Ok(blocks::render_hr(
            l,
            &render_rule(l.glyphs, l.width, l.measure),
        ))
    }

    fn heading(&self, depth: u8, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(blocks::render_heading(
            self.layout,
            depth,
            &inner,
            self.budget(),
        ))
    }

    fn code(&self, lang: Option<&str>, text: &str) -> R {
        Ok(wrap_code(&blocks::render_code(self.layout, lang, text)?))
    }

    fn table(&self, _token: &Token) -> R {
        // seam: crate::table's renderTable port (WP-5)
        Err(RenderError::Missing("table"))
    }

    fn blockquote(&self, tokens: &[Token]) -> R {
        self.layout.prefix.push(PrefixEntry {
            columns: 4,
            list: false,
        });
        let body = walk::parse(self, tokens, true);
        self.layout.prefix.pop();
        Ok(blocks::render_blockquote(self.layout, &body?))
    }

    fn list(&self, _token: &Token) -> R {
        // seam: crate::list_layout's ownedList over crate::lists' renderList (WP-4)
        Err(RenderError::Missing("list"))
    }

    fn html(&self, text: &str) -> R {
        Ok(blocks::render_html(self.layout, text, self.budget()))
    }

    fn paragraph(&self, tokens: &[Token]) -> R {
        let budget = self.budget();
        let inner = walk::parse_inline(self, tokens)?;
        let result = blocks::render_paragraph(self.layout, &inner, budget);
        let marker = |line: &str| is_guard_shaped_line(&strip_ansi(line));
        if !result.split('\n').skip(1).any(marker) {
            return Ok(result);
        }
        Ok(
            blocks::render_paragraph(self.layout, &inner, budget.saturating_sub(1).max(1))
                .split('\n')
                .enumerate()
                .map(|(i, line)| {
                    if i > 0 && marker(line) {
                        format!(" {line}")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"),
        )
    }

    fn text(&self, text: &str, _tokens: Option<&[Token]>) -> R {
        // `wrappedText` with no list open is `renderInlineText`.
        Ok(text.to_owned())
    }

    fn link(&self, href: &str, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(inline::render_link(self.layout, href, &inner))
    }

    fn image(&self, href: &str, title: Option<&str>, text: &str) -> R {
        Ok(inline::render_image(href, title, text))
    }

    fn strong(&self, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(inline::render_strong(self.layout, &inner))
    }

    fn em(&self, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(inline::render_em(self.layout, &inner))
    }

    fn codespan(&self, text: &str) -> R {
        Ok(inline::render_codespan(self.layout, text))
    }

    fn br(&self) -> R {
        Ok(inline::render_br())
    }

    fn del(&self, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(inline::render_del(self.layout, &inner))
    }

    fn wikilink(&self, slug: &str, fragment: Option<&str>, embed: bool, tokens: &[Token]) -> R {
        let inner = walk::parse_inline(self, tokens)?;
        Ok(wikilink::style_wiki_label(
            self.layout,
            slug,
            fragment,
            embed,
            &inner,
        ))
    }
}

/// Render `source` (`renderDocumentDetailed`). `tokens`, when given, replaces the adapter's lex
/// of the body (the R-gate); they are marked's own, already pre-processed by `lexBody`.
pub fn render(
    source: &str,
    tokens: Option<&[Token]>,
    options: &RenderOptions,
) -> Result<RenderOutput, RenderError> {
    let target_width = options.width;
    let glyphs = glyphs_for(options.tier);
    let measure = measure_for(options.ambiguous);
    let sgr = options.policy.sgr;

    let (meta, body) = frontmatter::split_frontmatter(source);
    let meta_result = meta
        .as_deref()
        .map(|m| frontmatter::format_meta_block_detailed(m, target_width, measure, sgr))
        .transpose()?;
    let meta_block = match &meta_result {
        Some(r) => format!(
            "{}\n{}\n\n",
            r.text,
            render_rule(glyphs, target_width, measure)
        ),
        None => String::new(),
    };

    let emoji = options.emoji.unwrap_or(options.tier == Tier::Unicode);
    let layout = LayoutContext::new(LayoutContextInit {
        width: target_width,
        glyphs,
        measure,
        resolve_fence_language: FenceLanguageResolver::builtin(Rc::new(AliasOnlySupport)),
        resolve_wiki_link: None,
        emoji,
        sgr,
        hyperlinks: Some(options.policy.hyperlinks),
        tmux: Some(options.policy.tmux),
    });

    let lexed;
    let body_tokens = match tokens {
        Some(t) => t,
        None => {
            lexed = lex::lex(body, options.tier);
            &lexed
        }
    };
    let rendered_body = walk::parse(&Renderer { layout: &layout }, body_tokens, true)?;
    let RenderOutput {
        text: stripped_body,
        code_ranges: body_ranges,
    } = extract_code_ranges(&rendered_body);
    let cleaned_body: String = stripped_body
        .chars()
        .filter(|&c| c != TASK_STATE_SENTINEL)
        .collect();
    let emoji_cleaned = strip_emoji_trailing_space(&cleaned_body, &body_ranges);

    let meta_line_offset = meta_block.matches('\n').count();
    let mut code_ranges: Vec<(usize, usize)> =
        meta_result.map(|r| r.verbatim_ranges).unwrap_or_default();
    code_ranges.extend(
        body_ranges
            .iter()
            .map(|&(a, b)| (a + meta_line_offset, b + meta_line_offset)),
    );
    Ok(RenderOutput {
        text: format!("{meta_block}{emoji_cleaned}"),
        code_ranges,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::glyphs::{ASCII_GLYPHS, UNICODE_GLYPHS};
    use crate::width::NARROW_MEASURE;

    fn opts(width: usize, tier: Tier, sgr: Sgr) -> RenderOptions {
        RenderOptions {
            width,
            tier,
            ambiguous: Ambiguous::Narrow,
            policy: Policy {
                sgr,
                hyperlinks: false,
                tmux: false,
            },
            emoji: None,
            path: None,
        }
    }

    fn r(source: &str) -> RenderOutput {
        render(source, None, &opts(80, Tier::Unicode, Sgr::None)).expect("renders")
    }

    #[test]
    fn wrap_code_keeps_trailing_newlines_outside() {
        assert_eq!(wrap_code("a\nb\n\n"), "\u{0}a\nb\u{0}\n\n");
    }

    #[test]
    fn code_ranges_are_one_based_inclusive_lines() {
        let out = extract_code_ranges("p\n\n\u{0}    a\n    b\u{0}\n\n");
        assert_eq!(out.code_ranges, vec![(3, 4)]);
        assert!(!out.text.contains(SENTINEL));
    }

    #[test]
    fn a_fence_after_prose_records_its_range() {
        let out = r("para\n\n```\ncode\n```\n");
        assert_eq!(out.text, "para\n\n    code\n\n");
        assert_eq!(out.code_ranges, vec![(3, 3)]);
    }

    #[test]
    fn frontmatter_offsets_body_code_ranges() {
        let out = render(
            "---\ntitle: x\n---\n```\nc\n```\n",
            None,
            &opts(80, Tier::Unicode, Sgr::None),
        );
        assert_eq!(out, Err(RenderError::Missing("frontmatter")));
    }

    #[test]
    fn rule_fills_width_minus_one() {
        assert_eq!(render_rule(&UNICODE_GLYPHS, 5, NARROW_MEASURE), "────");
        assert_eq!(render_rule(&ASCII_GLYPHS, 0, NARROW_MEASURE), "");
    }

    #[test]
    fn emoji_trailing_space_is_stripped_at_line_end_outside_code() {
        assert_eq!(
            strip_emoji_trailing_space("a \u{1f680} ", &[]),
            "a \u{1f680}"
        );
        assert_eq!(
            strip_emoji_trailing_space("x\n\u{1f680} \u{1b}[0m", &[(1, 1)]),
            "x\n\u{1f680}\u{1b}[0m"
        );
        assert_eq!(
            strip_emoji_trailing_space("\u{1f680} ", &[(1, 1)]),
            "\u{1f680} "
        );
    }

    #[test]
    fn lists_tables_and_full_colour_fences_are_unimplemented_not_partial() {
        assert_eq!(
            render("- a\n", None, &opts(80, Tier::Unicode, Sgr::None)),
            Err(RenderError::Missing("list"))
        );
        assert_eq!(
            render("|a|\n|-|\n|b|\n", None, &opts(80, Tier::Unicode, Sgr::None)),
            Err(RenderError::Missing("table"))
        );
        assert_eq!(
            render("```\nx\n```\n", None, &opts(80, Tier::Unicode, Sgr::Full)),
            Err(RenderError::Missing("highlight"))
        );
        assert_eq!(
            RenderError::Missing("list").to_string(),
            "unimplemented: list"
        );
    }

    #[test]
    fn headings_paragraphs_and_blockquotes_compose() {
        assert_eq!(r("# T\n\nbody\n").text, "# T\n\nbody\n\n");
        assert_eq!(r("> q\n").text, "    q\n\n");
        assert_eq!(r("***\n").text.chars().filter(|&c| c == '─').count(), 79);
    }

    #[test]
    fn emoji_defaults_on_for_unicode_and_off_for_ascii() {
        assert_eq!(r(":rocket:\n").text, "\u{1f680}\n\n");
        let ascii = render(":rocket:\n", None, &opts(80, Tier::Ascii, Sgr::None)).unwrap();
        assert_eq!(ascii.text, ":rocket:\n\n");
    }
}
