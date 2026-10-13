//! The render entry point, ported from `TS_BASELINE` `src/render.ts` (WP-3 of `plans/mdview-rust-port.md`):
//! the code sentinel, `wrapCode`, the code-range walk, the post-compose passes and
//! `renderDocumentDetailed`'s orchestration.
//!
//! The one error a render can return is `RenderError::UnknownToken`: a token reached the walk
//! it does not belong to, never a panic and never a partial render.
//!
//! Five visitors — `list`, `text`, `paragraph`, `heading`, `blockquote` — share one render's
//! layout state and live in `list_layout.rs` (`TS_BASELINE` `src/list-layout.ts`); the renderer object here
//! delegates to them, exactly as `TS_BASELINE` `src/render.ts` assigns `createListTextLayout`'s methods.

use std::sync::LazyLock;

use regex::Regex;

use crate::blocks;
pub use crate::colour::Policy;
use crate::context::{LayoutContext, LayoutContextInit};
use crate::frontmatter;
pub use crate::glyphs::Tier;
use crate::glyphs::{GlyphSet, glyphs_for};
use crate::inline;
use crate::lang::FenceLanguageResolver;
use crate::lex;
use crate::list_layout::{ListTextLayout, create_list_text_layout};
pub use crate::style::Sgr;
use crate::text::Align;
use crate::token::{ListItem, TableCell, Token};
use crate::walk::{self, R, Visitors};
pub use crate::width::Ambiguous;
use crate::width::{Measure, measure_for};
use crate::wikilink;

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
    /// The config's `highlightAs` fence-language aliases (`makeFenceLanguageResolver`'s input),
    /// layered over the built-ins; empty for the default resolver.
    pub highlight_as: std::collections::BTreeMap<String, String>,
}

impl RenderOptions {
    /// The plain baseline: Unicode tier, narrow ambiguous width, no SGR, no hyperlinks, no tmux,
    /// emoji following the tier, no path and no user fence aliases. Vary it with struct-update
    /// syntax.
    pub fn plain(width: usize) -> Self {
        RenderOptions {
            width,
            tier: Tier::Unicode,
            ambiguous: Ambiguous::Narrow,
            policy: Policy {
                sgr: Sgr::None,
                hyperlinks: false,
                tmux: false,
            },
            emoji: None,
            path: None,
            highlight_as: Default::default(),
        }
    }
}

/// What a render returns: the text, its 1-based inclusive code ranges, and — when the source
/// has frontmatter — what the frontmatter formatter knew about its own block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderOutput {
    pub text: String,
    pub code_ranges: Vec<(usize, usize)>,
    pub frontmatter: Option<FrontmatterFacts>,
}

/// What the frontmatter formatter knows about its own block, for the R-gate's D-A attribution
/// (`scripts/divergences.ts`'s `RenderSide.frontmatter`), computed once by [`render`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontmatterFacts {
    /// Whether the block parsed.
    pub parsed: bool,
    /// Only on a failed parse: the 0-based half-open line span `[start, end)` of the diagnostic
    /// within the rendered text. The meta block opens the document, and a failed parse's echo
    /// range starts on the line after the diagnostic, so the span is `[0, echo_start - 1)`.
    pub diagnostic: Option<(usize, usize)>,
    /// How many of `code_ranges`' leading entries are frontmatter-echo ranges.
    pub echo_ranges: usize,
}

/// Why a render did not produce output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// `walk.ts`'s `Token with "…" type was not found.`: a token reached the wrong walk.
    UnknownToken(&'static str),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
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
    RenderOutput {
        text,
        code_ranges,
        frontmatter: None,
    }
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

/// The owned renderer object: every visitor `TS_BASELINE` `src/render.ts` installs, over one layout.
pub(crate) struct Renderer<'a> {
    layout: &'a LayoutContext,
    /// `createListTextLayout(layout, SENTINEL)`: the five layout-state visitors.
    pub(crate) list_text: ListTextLayout<'a>,
}

impl<'a> Renderer<'a> {
    /// One renderer, and one fresh layout state, per render.
    pub(crate) fn new(layout: &'a LayoutContext) -> Self {
        Renderer {
            layout,
            list_text: create_list_text_layout(layout, SENTINEL),
        }
    }

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
        self.list_text.heading(self, depth, tokens)
    }

    fn code(&self, lang: Option<&str>, text: &str) -> R {
        Ok(wrap_code(&blocks::render_code(self.layout, lang, text)))
    }

    fn table(&self, header: &[TableCell], rows: &[Vec<TableCell>], align: &[Option<Align>]) -> R {
        // `TS_BASELINE` `src/render.ts:813`: the budget is `max(1, targetWidth - prefix.width())`.
        let l = self.layout;
        Ok(crate::table::render_table(
            header,
            rows,
            align,
            self.budget(),
            l.glyphs,
            l.measure,
            l.sgr,
        ))
    }

    fn blockquote(&self, tokens: &[Token]) -> R {
        self.list_text.blockquote(self, tokens)
    }

    fn list(&self, ordered: bool, items: &[ListItem]) -> R {
        self.list_text.list(self, ordered, items)
    }

    fn html(&self, text: &str) -> R {
        Ok(blocks::render_html(self.layout, text, self.budget()))
    }

    fn paragraph(&self, tokens: &[Token]) -> R {
        self.list_text.paragraph(self, tokens)
    }

    fn text(&self, text: &str, tokens: Option<&[Token]>) -> R {
        self.list_text.text(self, text, tokens)
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
        .map(|m| frontmatter::format_meta_block_detailed(m, target_width, measure, sgr));
    let frontmatter = meta_result.as_ref().map(|r| {
        let diagnostic = match r.verbatim_ranges.first() {
            Some(&(start, _)) if start > 1 => Some((0, start - 1)),
            _ => None,
        };
        FrontmatterFacts {
            parsed: diagnostic.is_none(),
            diagnostic,
            echo_ranges: r.verbatim_ranges.len(),
        }
    });
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
        resolve_fence_language: FenceLanguageResolver::new(&options.highlight_as),
        // `createWikiLinkResolver(resolve(file))`, only under hyperlinks (`TS_BASELINE` `src/cli.ts`); the
        // path arrives already absolute (`cli.rs`, `parity.rs`).
        resolve_wiki_link: options
            .policy
            .hyperlinks
            .then_some(options.path.as_deref())
            .flatten()
            .map(|path| crate::wikiresolve::create_wiki_link_resolver(path).into_context()),
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
    let rendered_body = walk::parse(&Renderer::new(&layout), body_tokens, true)?;
    let RenderOutput {
        text: stripped_body,
        code_ranges: body_ranges,
        ..
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
        frontmatter,
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
            highlight_as: Default::default(),
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
        let out = out.expect("renders");
        assert_eq!(
            out.text,
            format!("title: x\n{}\n\n    c\n\n", "─".repeat(79))
        );
        assert_eq!(out.code_ranges, vec![(4, 4)]);
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
