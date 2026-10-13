//! The owned block leaves — code, hr, html, paragraph, heading, blockquote — and the shared
//! `transform`, ported from `TS_BASELINE` `src/blocks.ts` (WP-3 of `plans/mdview-rust-port.md`).
//!
//! Each function takes already-walked inline text where the TS original took a `parseInline`
//! callback: the walk (`walk.rs`) owns recursion, so these stay leaves. The syntax highlighter
//! is `highlight.rs` (WP-6a), reached only under `full`; under `none`/`formats` highlighting
//! is off by construction (`blocks.ts` `highlightCode`'s `sgr !== "full"` gate).

use std::sync::LazyLock;

use regex::Regex;

use crate::context::LayoutContext;
use crate::highlight::highlight_to_ansi;
use crate::inline::{COLON_REPLACER, emojify, fix_hard_return};
use crate::list_lines::strip_ansi;
use crate::style::{SgrMode, StyleName, apply_style_chain};
use crate::text::{JS_WS_CLASS, is_js_whitespace, js_trim_end};
use crate::wrap::wrap_ansi;

const TAB: &str = "    ";

const BLOCKQUOTE: &[StyleName] = &[StyleName::Gray, StyleName::Italic];
const HTML: &[StyleName] = &[StyleName::Gray];
const HEADING: &[StyleName] = &[StyleName::Green, StyleName::Bold];
const FIRST_HEADING: &[StyleName] = &[StyleName::Magenta, StyleName::Underline, StyleName::Bold];
const RESET: &[StyleName] = &[StyleName::Reset];

fn section(text: &str) -> String {
    format!("{text}\n\n")
}

fn indentify(indent: &str, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!("{indent}{}", text.replace('\n', &format!("\n{indent}")))
}

/// The five-entity decoder (`blocks.ts` `unescapeEntities`), in its original order.
pub fn unescape_entities(html: &str) -> String {
    html.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn style(ctx: &LayoutContext, names: &[StyleName], text: &str) -> String {
    apply_style_chain(ctx.sgr, names, text)
}

/// `highlightCode`: off unless `full` (`blocks.ts:192`), and `fixHardReturn` runs first. The
/// TS `catch` (flat yellow) is unreachable: `highlight_to_ansi` never throws.
fn highlight_code(ctx: &LayoutContext, code: &str, language: Option<&str>) -> String {
    if ctx.sgr != SgrMode::Full {
        return code.to_owned();
    }
    highlight_to_ansi(ctx.sgr, &fix_hard_return(code), language)
}

/// `renderCode`: the language resolved through `ctx.resolveFenceLanguage`, then highlighted.
pub fn render_code(ctx: &LayoutContext, lang: Option<&str>, text: &str) -> String {
    let language = ctx.resolve_fence_language.resolve(lang);
    section(&indentify(
        TAB,
        &highlight_code(ctx, text, language.as_deref()),
    ))
}

/// `renderHr`.
pub fn render_hr(ctx: &LayoutContext, rule: &str) -> String {
    section(&style(ctx, RESET, rule))
}

static HTML_LINE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([{JS_WS_CLASS}]*)((?:\*|[0-9]+\.)[{JS_WS_CLASS}])?"
    ))
    .expect("html prefix regex compiles")
});

/// `renderHtml`.
pub fn render_html(ctx: &LayoutContext, text: &str, budget: usize) -> String {
    wrap_html_lines(ctx, &style(ctx, HTML, text), budget)
}

fn wrap_html_lines(ctx: &LayoutContext, rendered: &str, budget: usize) -> String {
    rendered
        .split('\n')
        .map(|line| {
            if ctx.measure.width(line) <= budget {
                return line.to_owned();
            }
            let caps = HTML_LINE_PREFIX.captures(line);
            let indent = caps
                .as_ref()
                .and_then(|c| c.get(1))
                .map_or("", |m| m.as_str());
            let marker = caps
                .as_ref()
                .and_then(|c| c.get(2))
                .map_or("", |m| m.as_str());
            let prefix = format!("{indent}{marker}");
            let rest = &line[prefix.len()..];
            if indent.is_empty() || rest.is_empty() {
                return wrap_ansi(line, budget, ctx.measure).join("\n");
            }
            let prefix_width = ctx.measure.width(&prefix);
            let continuation = " ".repeat(prefix_width);
            wrap_ansi(
                rest,
                budget.saturating_sub(prefix_width).max(1),
                ctx.measure,
            )
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if i == 0 {
                    format!("{prefix}{w}")
                } else {
                    format!("{continuation}{w}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn reflow_section(ctx: &LayoutContext, text: &str, budget: usize) -> Vec<String> {
    let mut lines = wrap_ansi(text, budget, ctx.measure);
    if lines.last().is_some_and(|l| strip_ansi(l).is_empty()) {
        lines.pop();
    }
    lines
}

/// `text.split(/\r|<br \/>/)`.
fn split_hard_break_sections(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            parts.push(&text[start..i]);
            i += 1;
            start = i;
        } else if bytes[i..].starts_with(b"<br />") {
            parts.push(&text[start..i]);
            i += 6;
            start = i;
        } else {
            i += 1;
        }
    }
    parts.push(&text[start..]);
    parts
}

fn reflow(ctx: &LayoutContext, text: &str, budget: usize) -> String {
    let mut lines = Vec::new();
    for part in split_hard_break_sections(text) {
        lines.extend(reflow_section(ctx, part, budget));
    }
    lines.join("\n")
}

fn undo_colon(text: &str) -> String {
    text.replace(COLON_REPLACER, ":")
}

/// `transform`: emojify, then unescape, then `undoColon` — that order (`blocks.ts`).
pub fn transform(ctx: &LayoutContext, text: &str) -> String {
    undo_colon(&unescape_entities(&emojify(ctx, text)))
}

/// `renderParagraph`, given the walked inline text.
pub fn render_paragraph(ctx: &LayoutContext, inline: &str, budget: usize) -> String {
    let styled = style(ctx, RESET, &transform(ctx, inline));
    section(&reflow(ctx, &styled, budget))
}

/// `renderHeading`, given the walked inline text.
pub fn render_heading(ctx: &LayoutContext, depth: u8, inline: &str, budget: usize) -> String {
    let text = format!(
        "{} {}",
        "#".repeat(usize::from(depth)),
        transform(ctx, inline)
    );
    let chain = if depth == 1 { FIRST_HEADING } else { HEADING };
    section(&style(ctx, chain, &reflow(ctx, &text, budget)))
}

fn trim_keeping_first_indent(body: &str) -> String {
    let trimmed_end = js_trim_end(body);
    let rest = trimmed_end.trim_start_matches(is_js_whitespace);
    let lead = &trimmed_end[..trimmed_end.len() - rest.len()];
    if lead.is_empty() {
        return trimmed_end.to_owned();
    }
    let last_line = &lead[lead.rfind('\n').map_or(0, |i| i + 1)..];
    if last_line.bytes().all(|b| b == b' ') {
        format!("{last_line}{rest}")
    } else {
        rest.to_owned()
    }
}

/// `renderBlockquote`, given the walked body.
pub fn render_blockquote(ctx: &LayoutContext, body: &str) -> String {
    section(&style(
        ctx,
        BLOCKQUOTE,
        &indentify(TAB, &trim_keeping_first_indent(body)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::LayoutContextInit;
    use crate::glyphs::UNICODE_GLYPHS;
    use crate::lang::{AliasOnlySupport, FenceLanguageResolver};
    use crate::width::NARROW_MEASURE;
    use std::rc::Rc;

    fn ctx(sgr: SgrMode) -> LayoutContext {
        LayoutContext::new(LayoutContextInit {
            width: 80,
            glyphs: &UNICODE_GLYPHS,
            measure: NARROW_MEASURE,
            resolve_fence_language: FenceLanguageResolver::builtin(Rc::new(AliasOnlySupport)),
            resolve_wiki_link: None,
            emoji: true,
            sgr,
            hyperlinks: None,
            tmux: None,
        })
    }

    #[test]
    fn code_indents_by_four_and_closes_a_section() {
        let c = ctx(SgrMode::None);
        assert_eq!(render_code(&c, None, "a\nb"), "    a\n    b\n\n");
        assert_eq!(render_code(&c, None, ""), "\n\n");
        assert_eq!(
            render_code(&ctx(SgrMode::Formats), Some("rust"), "x"),
            "    x\n\n"
        );
        assert_eq!(
            strip_ansi(&render_code(&ctx(SgrMode::Full), None, "x")),
            "    x\n\n"
        );
    }

    #[test]
    fn transform_order_is_emojify_unescape_undo_colon() {
        let c = ctx(SgrMode::None);
        assert_eq!(transform(&c, "&amp;lt; :rocket:"), "< \u{1f680} ");
        assert_eq!(transform(&c, "a*#COLON|*rocket*#COLON|*"), "a:rocket:");
    }

    #[test]
    fn heading_prefixes_hashes_and_styles_by_depth() {
        let c = ctx(SgrMode::None);
        assert_eq!(render_heading(&c, 2, "Hi", 80), "## Hi\n\n");
        let f = ctx(SgrMode::Full);
        assert_eq!(
            render_heading(&f, 1, "Hi", 80),
            "\u{1b}[35m\u{1b}[4m\u{1b}[1m# Hi\u{1b}[22m\u{1b}[24m\u{1b}[39m\n\n"
        );
    }

    #[test]
    fn paragraph_splits_on_hard_returns_and_br() {
        let c = ctx(SgrMode::None);
        assert_eq!(render_paragraph(&c, "a\rb<br />c", 80), "a\nb\nc\n\n");
    }

    #[test]
    fn blockquote_keeps_a_space_only_first_indent() {
        let c = ctx(SgrMode::None);
        assert_eq!(render_blockquote(&c, "x\n\n"), "    x\n\n");
        assert_eq!(render_blockquote(&c, "\n  x\n"), "      x\n\n");
        assert_eq!(render_blockquote(&c, "\n\tx"), "    x\n\n");
    }

    #[test]
    fn html_wraps_indented_lines_under_their_prefix() {
        let c = ctx(SgrMode::None);
        assert_eq!(render_html(&c, "<div>", 80), "<div>");
        assert_eq!(render_html(&c, "  aaa bbb", 6), "  aaa\n  bbb");
    }
}
