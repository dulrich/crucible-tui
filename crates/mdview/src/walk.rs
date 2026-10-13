//! The owned token walk, ported from `TS_BASELINE` `src/walk.ts`'s `TokenWalker` (WP-3 of
//! `plans/mdview-rust-port.md`).
//!
//! Dispatch is an **exhaustive `match`** over `token.rs`'s `Token` — the 19 types
//! `walk.ts:246-391` dispatches — so a token type the walk does not handle is a compile error,
//! not `walk.ts`'s run-time `Token with "…" type was not found.` Kept from marked's `Parser`:
//! - `parse` coalesces consecutive block `text` tokens with `"\n"`, and at top level wraps the
//!   coalesced body in a synthesized paragraph whose one child is a token-less text token
//!   (`walk.ts:284`);
//! - `space` renders as `""`; `escape` routes to the `text` visitor (`parseInline`).
//!
//! The two walks keep `walk.ts`'s split exactly: a block-only type reached by `parse_inline`
//! (and an inline-only one reached by `parse`) is the unknown-token error, not a render.

use crate::render::RenderError;
use crate::text::Align;
use crate::token::{ListItem, TableCell, Token};

pub type R = Result<String, RenderError>;

/// The renderer methods the walk calls (`WalkRendererMethods`). Each one receives the token
/// it was dispatched; recursion goes back through `parse`/`parse_inline`.
pub trait Visitors {
    fn hr(&self) -> R;
    fn heading(&self, depth: u8, tokens: &[Token]) -> R;
    fn code(&self, lang: Option<&str>, text: &str) -> R;
    fn table(&self, header: &[TableCell], rows: &[Vec<TableCell>], align: &[Option<Align>]) -> R;
    fn blockquote(&self, tokens: &[Token]) -> R;
    fn list(&self, ordered: bool, items: &[ListItem]) -> R;
    fn html(&self, text: &str) -> R;
    fn paragraph(&self, tokens: &[Token]) -> R;
    /// `text` for a `text` or `escape` token: `text` is its text, `tokens` its children if any.
    fn text(&self, text: &str, tokens: Option<&[Token]>) -> R;
    fn link(&self, href: &str, tokens: &[Token]) -> R;
    fn image(&self, href: &str, title: Option<&str>, text: &str) -> R;
    fn strong(&self, tokens: &[Token]) -> R;
    fn em(&self, tokens: &[Token]) -> R;
    fn codespan(&self, text: &str) -> R;
    fn br(&self) -> R;
    fn del(&self, tokens: &[Token]) -> R;
    fn wikilink(&self, slug: &str, fragment: Option<&str>, embed: bool, tokens: &[Token]) -> R;
}

fn type_name(token: &Token) -> &'static str {
    match token {
        Token::Space => "space",
        Token::Hr => "hr",
        Token::Heading { .. } => "heading",
        Token::Code { .. } => "code",
        Token::Table { .. } => "table",
        Token::Blockquote { .. } => "blockquote",
        Token::List { .. } => "list",
        Token::Html { .. } => "html",
        Token::Paragraph { .. } => "paragraph",
        Token::Text { .. } => "text",
        Token::Escape { .. } => "escape",
        Token::Link { .. } => "link",
        Token::Image { .. } => "image",
        Token::Strong { .. } => "strong",
        Token::Em { .. } => "em",
        Token::Codespan { .. } => "codespan",
        Token::Br => "br",
        Token::Del { .. } => "del",
        Token::Wikilink { .. } => "wikilink",
    }
}

fn unknown(token: &Token) -> RenderError {
    RenderError::UnknownToken(type_name(token))
}

/// `TokenWalker.parse(tokens, top)`.
pub fn parse<V: Visitors + ?Sized>(v: &V, tokens: &[Token], top: bool) -> R {
    let mut out = String::new();
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        match token {
            Token::Space => {}
            Token::Hr => out.push_str(&v.hr()?),
            Token::Heading { depth, tokens } => out.push_str(&v.heading(*depth, tokens)?),
            Token::Code { lang, text } => out.push_str(&v.code(lang.as_deref(), text)?),
            Token::Table {
                header,
                rows,
                align,
            } => out.push_str(&v.table(header, rows, align)?),
            Token::Blockquote { tokens } => out.push_str(&v.blockquote(tokens)?),
            Token::List { ordered, items } => out.push_str(&v.list(*ordered, items)?),
            Token::Html { text } => out.push_str(&v.html(text)?),
            Token::Paragraph { tokens } => out.push_str(&v.paragraph(tokens)?),
            Token::Text {
                text, tokens: kids, ..
            } => {
                let mut body = v.text(text, kids.as_deref())?;
                while let Some(Token::Text {
                    text, tokens: kids, ..
                }) = tokens.get(i + 1)
                {
                    i += 1;
                    body.push('\n');
                    body.push_str(&v.text(text, kids.as_deref())?);
                }
                if top {
                    let synthesized = [Token::Text {
                        raw: body.clone(),
                        text: body,
                        tokens: None,
                    }];
                    out.push_str(&v.paragraph(&synthesized)?);
                } else {
                    out.push_str(&body);
                }
            }
            Token::Escape { .. }
            | Token::Link { .. }
            | Token::Image { .. }
            | Token::Strong { .. }
            | Token::Em { .. }
            | Token::Codespan { .. }
            | Token::Br
            | Token::Del { .. }
            | Token::Wikilink { .. } => return Err(unknown(token)),
        }
        i += 1;
    }
    Ok(out)
}

/// `TokenWalker.parseInline(tokens)`.
pub fn parse_inline<V: Visitors + ?Sized>(v: &V, tokens: &[Token]) -> R {
    let mut out = String::new();
    for token in tokens {
        match token {
            Token::Wikilink {
                slug,
                fragment,
                embed,
                tokens,
                ..
            } => out.push_str(&v.wikilink(slug, fragment.as_deref(), *embed, tokens)?),
            Token::Escape { text } => out.push_str(&v.text(text, None)?),
            Token::Html { text } => out.push_str(&v.html(text)?),
            Token::Link { href, tokens, .. } => out.push_str(&v.link(href, tokens)?),
            Token::Image { href, title, text } => {
                out.push_str(&v.image(href, title.as_deref(), text)?);
            }
            Token::Strong { tokens, .. } => out.push_str(&v.strong(tokens)?),
            Token::Em { tokens, .. } => out.push_str(&v.em(tokens)?),
            Token::Codespan { text } => out.push_str(&v.codespan(text)?),
            Token::Br => out.push_str(&v.br()?),
            Token::Del { tokens, .. } => out.push_str(&v.del(tokens)?),
            Token::Text {
                text, tokens: kids, ..
            } => out.push_str(&v.text(text, kids.as_deref())?),
            Token::Space
            | Token::Hr
            | Token::Heading { .. }
            | Token::Code { .. }
            | Token::Table { .. }
            | Token::Blockquote { .. }
            | Token::List { .. }
            | Token::Paragraph { .. } => return Err(unknown(token)),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A visitor that records the shape of what it was called with.
    struct Echo;
    impl Visitors for Echo {
        fn hr(&self) -> R {
            Ok("<hr>".into())
        }
        fn heading(&self, d: u8, t: &[Token]) -> R {
            Ok(format!("<h{d}>{}", parse_inline(self, t)?))
        }
        fn code(&self, _l: Option<&str>, t: &str) -> R {
            Ok(format!("<code>{t}"))
        }
        fn table(&self, _h: &[TableCell], _r: &[Vec<TableCell>], _a: &[Option<Align>]) -> R {
            Ok("<table>".into())
        }
        fn blockquote(&self, t: &[Token]) -> R {
            Ok(format!("<q>{}", parse(self, t, true)?))
        }
        fn list(&self, _o: bool, _i: &[ListItem]) -> R {
            Ok("<list>".into())
        }
        fn html(&self, t: &str) -> R {
            Ok(t.into())
        }
        fn paragraph(&self, t: &[Token]) -> R {
            Ok(format!("<p>{}</p>", parse_inline(self, t)?))
        }
        fn text(&self, t: &str, _k: Option<&[Token]>) -> R {
            Ok(t.into())
        }
        fn link(&self, h: &str, _t: &[Token]) -> R {
            Ok(h.into())
        }
        fn image(&self, h: &str, _ti: Option<&str>, _t: &str) -> R {
            Ok(h.into())
        }
        fn strong(&self, t: &[Token]) -> R {
            Ok(format!("*{}*", parse_inline(self, t)?))
        }
        fn em(&self, t: &[Token]) -> R {
            parse_inline(self, t)
        }
        fn codespan(&self, t: &str) -> R {
            Ok(t.into())
        }
        fn br(&self) -> R {
            Ok("|".into())
        }
        fn del(&self, t: &[Token]) -> R {
            parse_inline(self, t)
        }
        fn wikilink(&self, s: &str, _f: Option<&str>, _e: bool, _t: &[Token]) -> R {
            Ok(format!("[[{s}]]"))
        }
    }

    fn text(s: &str) -> Token {
        Token::Text {
            raw: s.into(),
            text: s.into(),
            tokens: None,
        }
    }

    #[test]
    fn consecutive_top_level_text_coalesces_into_one_synthesized_paragraph() {
        let out = parse(
            &Echo,
            &[text("a"), text("b"), Token::Space, text("c")],
            true,
        )
        .unwrap();
        assert_eq!(out, "<p>a\nb</p><p>c</p>");
    }

    #[test]
    fn nested_text_is_not_wrapped() {
        assert_eq!(
            parse(&Echo, &[text("a"), text("b")], false).unwrap(),
            "a\nb"
        );
    }

    #[test]
    fn escape_routes_to_text_and_space_renders_empty() {
        let out = parse_inline(
            &Echo,
            &[
                Token::Escape { text: "&".into() },
                Token::Br,
                Token::Strong {
                    text: "x".into(),
                    tokens: vec![text("x")],
                },
            ],
        )
        .unwrap();
        assert_eq!(out, "&|*x*");
        assert_eq!(
            parse(&Echo, &[Token::Space, Token::Hr], true).unwrap(),
            "<hr>"
        );
    }

    #[test]
    fn a_block_token_in_an_inline_walk_is_the_unknown_token_error() {
        assert_eq!(
            parse_inline(&Echo, &[Token::Hr]),
            Err(RenderError::UnknownToken("hr"))
        );
        assert_eq!(
            parse(&Echo, &[Token::Br], true),
            Err(RenderError::UnknownToken("br"))
        );
    }
}
