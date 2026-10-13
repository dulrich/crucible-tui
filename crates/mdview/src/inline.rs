//! The owned inline visitors, the emoji pass and the colon sentinel, ported from
//! `TS_BASELINE` `src/inline.ts` (WP-3 of `plans/mdview-rust-port.md`).
//!
//! The `DEL_TOKENIZER` half of `TS_BASELINE` `src/inline.ts` is lexer-side and lives in `lex.rs`. Quirks kept
//! on purpose, each a transcription of the TS original:
//! - `fixHardReturn` replaces only the **first** `\r` (`String.prototype.replace` with a string
//!   pattern), and its replacement is `String(/\n/g)` — the five characters `/\n/g`.
//! - the emoji capture is lazy (`+?`) under a global replace, so `:a:b:` tries `:a:` first.

use std::sync::LazyLock;

use regex::Regex;

use crate::ansi;
use crate::context::LayoutContext;
use crate::emoji_data;
use crate::style::{StyleName, apply_style_chain};

/// `COLON_REPLACER`: codespans hide their colons from the emoji pass behind this.
pub const COLON_REPLACER: &str = "*#COLON|*";

/// `HARD_RETURN`: what `br` renders as, settled later by the paragraph reflow.
pub const HARD_RETURN: &str = "\r";

/// `String(/\n/g)`.
const HARD_RETURN_REPLACEMENT: &str = "/\\n/g";

pub const STRONG: &[StyleName] = &[StyleName::Bold];
pub const EM: &[StyleName] = &[StyleName::Italic];
pub const CODESPAN: &[StyleName] = &[StyleName::Yellow];
pub const DEL: &[StyleName] = &[StyleName::Dim, StyleName::Gray, StyleName::Strikethrough];
pub const LINK: &[StyleName] = &[StyleName::Blue];
pub const HREF: &[StyleName] = &[StyleName::Blue, StyleName::Underline];

/// `fixHardReturn`: the first `\r` only.
pub fn fix_hard_return(text: &str) -> String {
    text.replacen(HARD_RETURN, HARD_RETURN_REPLACEMENT, 1)
}

static EMOJI_SHORTCODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":([A-Za-z0-9_\-+]+?):").expect("emoji regex compiles"));

/// `insertEmojis`: every known `:name:` becomes its glyph plus one space.
fn insert_emojis(text: &str) -> String {
    EMOJI_SHORTCODE
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let whole = &caps[0];
            match emoji_data::get(&caps[1]) {
                Some(glyph) => format!("{glyph} "),
                None => whole.to_owned(),
            }
        })
        .into_owned()
}

/// `emojify`.
pub fn emojify(ctx: &LayoutContext, text: &str) -> String {
    if ctx.emoji {
        insert_emojis(text)
    } else {
        text.to_owned()
    }
}

fn style(ctx: &LayoutContext, names: &[StyleName], text: &str) -> String {
    apply_style_chain(ctx.sgr, names, text)
}

/// `renderStrong`, given the already-walked children.
pub fn render_strong(ctx: &LayoutContext, inner: &str) -> String {
    style(ctx, STRONG, inner)
}

/// `renderEm`.
pub fn render_em(ctx: &LayoutContext, inner: &str) -> String {
    style(ctx, EM, &fix_hard_return(inner))
}

/// `renderCodespan`.
pub fn render_codespan(ctx: &LayoutContext, text: &str) -> String {
    let text = fix_hard_return(text);
    style(ctx, CODESPAN, &text.replace(':', COLON_REPLACER))
}

/// `renderBr`.
pub fn render_br() -> String {
    HARD_RETURN.to_owned()
}

/// `renderDel`.
pub fn render_del(ctx: &LayoutContext, inner: &str) -> String {
    style(ctx, DEL, inner)
}

/// `renderLink`, given the walked label.
pub fn render_link(ctx: &LayoutContext, href: &str, text: &str) -> String {
    let has_text = !text.is_empty() && text != href;
    let mut out = String::new();
    if ctx.hyperlinks {
        let label = if text.is_empty() {
            style(ctx, HREF, href)
        } else {
            style(ctx, HREF, &emojify(ctx, text))
        };
        out = ansi::link(&label, &href.replace('+', "%20"), ctx.tmux);
    } else {
        if has_text {
            out.push_str(&emojify(ctx, text));
            out.push_str(" (");
        }
        out.push_str(&style(ctx, HREF, href));
        if has_text {
            out.push(')');
        }
    }
    style(ctx, LINK, &out)
}

/// `renderImage`. The en dash is the original's.
pub fn render_image(href: &str, title: Option<&str>, text: &str) -> String {
    let mut out = format!("![{text}");
    if let Some(t) = title.filter(|t| !t.is_empty()) {
        out.push_str(" – ");
        out.push_str(t);
    }
    format!("{out}]({href})\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{LayoutContextInit, test_init};
    use crate::style::Sgr;

    fn ctx(sgr: Sgr, emoji: bool, hyperlinks: bool) -> LayoutContext {
        LayoutContext::new(LayoutContextInit {
            emoji,
            hyperlinks: Some(hyperlinks),
            ..test_init(80, sgr)
        })
    }

    #[test]
    fn fix_hard_return_replaces_the_first_cr_with_the_regex_source() {
        assert_eq!(fix_hard_return("a\rb\rc"), "a/\\n/gb\rc");
        assert_eq!(fix_hard_return("none"), "none");
    }

    #[test]
    fn emoji_shortcodes_substitute_with_a_trailing_space() {
        let c = ctx(Sgr::None, true, false);
        assert_eq!(emojify(&c, "a :rocket: b"), "a \u{1f680}  b");
        assert_eq!(emojify(&c, ":nope_not_real:"), ":nope_not_real:");
        assert_eq!(emojify(&c, ":+1:"), "\u{1f44d} ");
        let off = ctx(Sgr::None, false, false);
        assert_eq!(emojify(&off, ":rocket:"), ":rocket:");
    }

    #[test]
    fn codespan_hides_colons_and_styles_yellow() {
        let c = ctx(Sgr::Full, true, false);
        assert_eq!(
            render_codespan(&c, "a:b"),
            "\u{1b}[33ma*#COLON|*b\u{1b}[39m"
        );
        let plain = ctx(Sgr::None, true, false);
        assert_eq!(render_codespan(&plain, "x"), "x");
    }

    #[test]
    fn link_text_and_href_forms() {
        let c = ctx(Sgr::None, true, false);
        assert_eq!(render_link(&c, "http://x", "label"), "label (http://x)");
        assert_eq!(render_link(&c, "http://x", "http://x"), "http://x");
        assert_eq!(render_link(&c, "http://x", ""), "http://x");
        let h = ctx(Sgr::None, true, true);
        assert_eq!(
            render_link(&h, "a+b", "t"),
            "\u{1b}]8;;a%20b\u{7}t\u{1b}]8;;\u{7}"
        );
    }

    #[test]
    fn image_renders_alt_title_and_href() {
        assert_eq!(render_image("u", None, "alt"), "![alt](u)\n");
        assert_eq!(render_image("u", Some("T"), "alt"), "![alt – T](u)\n");
        assert_eq!(render_image("u", Some(""), "alt"), "![alt](u)\n");
    }

    #[test]
    fn del_and_em_styles() {
        let c = ctx(Sgr::Full, true, false);
        assert_eq!(
            render_del(&c, "x"),
            "\u{1b}[2m\u{1b}[90m\u{1b}[9mx\u{1b}[29m\u{1b}[39m\u{1b}[22m"
        );
        assert_eq!(render_em(&c, "x"), "\u{1b}[3mx\u{1b}[23m");
        assert_eq!(render_br(), "\r");
    }
}
