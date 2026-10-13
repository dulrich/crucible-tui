//! The wiki-link visitor — `styleWikiLabel` and `followWikiLink`, ported from
//! `TS_BASELINE` `src/wikilink.ts` (WP-3 of `plans/mdview-rust-port.md`). Recognition is lexer-side
//! (`lex.rs`); the resolver itself is `wikiresolve.rs`'s, wired in by WP-6.

use crate::ansi;
use crate::context::LayoutContext;
use crate::style::{StyleName, apply_style_chain};

/// `WIKI_LINK_STYLES`.
pub const WIKI_LINK_STYLES: &[StyleName] = &[StyleName::Cyan, StyleName::Underline];

const OSC8_OPEN: &str = "\u{1b}]8;;";

/// `styleWikiLabel`, given the walked label.
pub fn style_wiki_label(
    ctx: &LayoutContext,
    slug: &str,
    fragment: Option<&str>,
    embed: bool,
    inner: &str,
) -> String {
    let label = apply_style_chain(ctx.sgr, WIKI_LINK_STYLES, inner);
    let linked = follow_wiki_link(ctx, slug, fragment, label);
    if embed {
        format!("embed: {linked}")
    } else {
        linked
    }
}

fn follow_wiki_link(
    ctx: &LayoutContext,
    slug: &str,
    fragment: Option<&str>,
    label: String,
) -> String {
    let Some(resolve) = ctx.resolve_wiki_link.as_ref().filter(|_| ctx.hyperlinks) else {
        return label;
    };
    if label.contains(OSC8_OPEN) {
        return label;
    }
    match resolve(slug, fragment) {
        Some(href) => ansi::link(&label, &href, ctx.tmux),
        None => label,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{LayoutContextInit, test_init};
    use crate::style::Sgr;
    use std::rc::Rc;

    fn ctx(sgr: Sgr, hyperlinks: bool, resolver: bool) -> LayoutContext {
        LayoutContext::new(LayoutContextInit {
            resolve_wiki_link: resolver.then(|| {
                Rc::new(|slug: &str, _f: Option<&str>| Some(format!("file:///{slug}.md")))
                    as crate::context::WikiLinkResolver
            }),
            hyperlinks: Some(hyperlinks),
            ..test_init(80, sgr)
        })
    }

    #[test]
    fn label_styles_cyan_underline_and_embeds_prefix() {
        let c = ctx(Sgr::Full, false, false);
        assert_eq!(
            style_wiki_label(&c, "s", None, false, "s"),
            "\u{1b}[36m\u{1b}[4ms\u{1b}[24m\u{1b}[39m"
        );
        let plain = ctx(Sgr::None, false, false);
        assert_eq!(style_wiki_label(&plain, "s", None, true, "s"), "embed: s");
        let formats = ctx(Sgr::Formats, false, false);
        assert_eq!(
            style_wiki_label(&formats, "s", None, false, "s"),
            "\u{1b}[4ms\u{1b}[24m"
        );
    }

    #[test]
    fn a_resolver_links_only_under_hyperlinks() {
        let on = ctx(Sgr::None, true, true);
        assert_eq!(
            style_wiki_label(&on, "n", None, false, "n"),
            "\u{1b}]8;;file:///n.md\u{7}n\u{1b}]8;;\u{7}"
        );
        let off = ctx(Sgr::None, false, true);
        assert_eq!(style_wiki_label(&off, "n", None, false, "n"), "n");
    }
}
