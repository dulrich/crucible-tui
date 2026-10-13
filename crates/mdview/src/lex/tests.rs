use super::*;

fn text(raw: &str) -> Token {
    Token::Text {
        raw: raw.into(),
        text: escape_no_encode(raw),
        tokens: None,
    }
}

#[test]
fn normalizes_line_endings_and_sentinels() {
    assert_eq!(normalize("a\r\nb\rc\u{0}d\u{1}e"), "a\nb\ncde");
}

#[test]
fn escape_keeps_entities() {
    assert_eq!(
        escape_no_encode("a & b &amp; <c> \"q\" it's"),
        "a &amp; b &amp; &lt;c&gt; &quot;q&quot; it&#39;s"
    );
    assert_eq!(escape_encode("&amp;"), "&amp;amp;");
}

#[test]
fn paragraph_keeps_marked_text_and_breaks() {
    let t = lex("a & b\n   cont  \nx", Tier::Unicode);
    assert_eq!(
        t,
        vec![Token::Paragraph {
            tokens: vec![text("a & b\n   cont"), Token::Br, text("x")]
        }]
    );
}

#[test]
fn leading_bom_stays_paragraph_content_as_in_marked() {
    // D-D: marked sees the BOM as text, so a following html line is inline html.
    let t = lex("\u{feff}<img src=\"x\"/>\n\nText.\n", Tier::Unicode);
    assert_eq!(
        t,
        vec![
            Token::Paragraph {
                tokens: vec![
                    text("\u{feff}"),
                    Token::Html {
                        text: "<img src=\"x\"/>".into()
                    }
                ]
            },
            Token::Space,
            Token::Paragraph {
                tokens: vec![text("Text.")]
            },
        ]
    );
    let h = lex("\u{feff}# T\n", Tier::Unicode);
    assert!(matches!(&h[0], Token::Paragraph { .. }), "{h:?}");
}

#[test]
fn html_trailer_stops_at_its_container() {
    let html = |t: &[Token]| -> Vec<String> {
        fn walk(t: &[Token], out: &mut Vec<String>) {
            for x in t {
                match x {
                    Token::Html { text } => out.push(text.clone()),
                    Token::Blockquote { tokens } => walk(tokens, out),
                    Token::List { items, .. } => {
                        for i in items {
                            walk(&i.tokens, out);
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut out = Vec::new();
        walk(t, &mut out);
        out
    };
    let t = lex("- a\n\n  </details>\n\n- b\n", Tier::Unicode);
    assert_eq!(html(&t), vec!["</details>\n"]);
    let t = lex("> a\n>\n> </details>\n\nz\n", Tier::Unicode);
    assert_eq!(html(&t), vec!["</details>"]);
    let t = lex("- a\n\n  </details>\n\n\n- b\n", Tier::Unicode);
    assert_eq!(html(&t), vec!["</details>\n\n"]);
}

#[test]
fn code_span_past_comraks_backtick_cache_is_recognised() {
    let t = lex("x `` y `a` z `b`.\n", Tier::Unicode);
    let Token::Paragraph { tokens } = &t[0] else {
        panic!("{t:?}")
    };
    let spans = tokens
        .iter()
        .filter(|x| matches!(x, Token::Codespan { .. }))
        .count();
    assert_eq!(spans, 2, "{tokens:?}");
    let t = lex("x \\`a` b\n", Tier::Unicode);
    let Token::Paragraph { tokens } = &t[0] else {
        panic!("{t:?}")
    };
    assert!(!tokens.iter().any(|x| matches!(x, Token::Codespan { .. })));
}

#[test]
fn indented_blank_after_quote_in_item_is_the_quotes_space() {
    let t = lex("- a\n\n  > q\n    \n- b\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!("{t:?}")
    };
    let Some(Token::Blockquote { tokens }) = items[0].tokens.last() else {
        panic!("{:?}", items[0].tokens)
    };
    assert_eq!(tokens.last(), Some(&Token::Space));
    let t = lex("- a\n\n  > q\n  \n- b\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!("{t:?}")
    };
    let Some(Token::Blockquote { tokens }) = items[0].tokens.last() else {
        panic!("{:?}", items[0].tokens)
    };
    assert_ne!(
        tokens.last(),
        Some(&Token::Space),
        "a dedented-empty line is no space"
    );
}

#[test]
fn crlf_body_lexes_like_lf() {
    assert_eq!(
        lex("a\r\nb\r\n", Tier::Unicode),
        lex("a\nb\n", Tier::Unicode)
    );
}

#[test]
fn space_tokens_follow_marked_consumption() {
    let t = lex("a\n\nb\n", Tier::Unicode);
    assert_eq!(t.len(), 3);
    assert_eq!(t[1], Token::Space);
    let t = lex("# h\n\nb", Tier::Unicode);
    assert_eq!(t.len(), 2, "a heading consumes its newlines");
    let t = lex("a\n\n", Tier::Unicode);
    assert_eq!(t.last(), Some(&Token::Space));
}

#[test]
fn list_item_raw_is_rebuilt_from_source() {
    let t = lex("- a\n  b\n- c\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!("{t:?}")
    };
    assert_eq!(items[0].raw, "- a\n  b\n");
    assert_eq!(items[1].raw, "- c");
    let Token::Text { raw, text, .. } = &items[0].tokens[0] else {
        panic!()
    };
    assert_eq!(raw, "a\n\nb");
    assert_eq!(text, "a\nb");
}

#[test]
fn loose_list_from_blank_line_between_items() {
    let t = lex("- a\n\n- b\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!()
    };
    assert!(items.iter().all(|i| i.loose));
}

#[test]
fn unicode_task_item_carries_the_glyph() {
    let t = lex("- [x] done\n- [/] half\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!()
    };
    assert!(!items[0].task);
    assert_eq!(items[0].raw, "- ✓ done\n");
    let Token::Text { text, .. } = &items[1].tokens[0] else {
        panic!()
    };
    assert_eq!(text, "◐ half");
}

#[test]
fn ascii_task_item_keeps_the_sentinel_literal() {
    let t = lex("- [ ] todo\n- [/] half\n", Tier::Ascii);
    let Token::List { items, .. } = &t[0] else {
        panic!()
    };
    let Token::Text { text, .. } = &items[0].tokens[0] else {
        panic!()
    };
    assert_eq!(text, "[\u{1} ] todo");
    let Token::Text { text, .. } = &items[1].tokens[0] else {
        panic!()
    };
    assert_eq!(text, "[/] half");
    assert!(!items[1].task);
}

#[test]
fn ascii_sentinel_at_nested_list_end_leaves_no_space() {
    // `[\u{1} ]` is one byte longer than `[ ]`; a nested list ending on it (with a trailing
    // space) must end after the substitution, or the residual ` ] ` reads as a `space`.
    let t = lex("- a:\n  - b\n  - [ ] \n- c\n", Tier::Ascii);
    let Token::List { items, .. } = &t[0] else {
        panic!()
    };
    assert!(matches!(
        items[0].tokens.as_slice(),
        [Token::Text { .. }, Token::List { .. }]
    ));
}

#[test]
fn ordered_and_quoted_task_items_are_real_tasks() {
    let t = lex("1. [x] a\n", Tier::Unicode);
    let Token::List { items, .. } = &t[0] else {
        panic!()
    };
    assert!(items[0].task);
    assert_eq!(items[0].checked, Some(true));
    let t = lex("> - [/] b\n", Tier::Unicode);
    let Token::Blockquote { tokens } = &t[0] else {
        panic!()
    };
    let Token::List { items, .. } = &tokens[0] else {
        panic!()
    };
    assert!(items[0].task);
}

#[test]
fn task_line_inside_fence_is_verbatim() {
    let t = lex("```\n- [ ] x\n```\n", Tier::Unicode);
    assert_eq!(
        t[0],
        Token::Code {
            lang: Some(String::new()),
            text: "- [ ] x".into()
        }
    );
}

#[test]
fn wikilink_embed_fragment_alias() {
    let t = lex("see ![[note#sec|An *alias*]] end", Tier::Unicode);
    let Token::Paragraph { tokens } = &t[0] else {
        panic!()
    };
    assert_eq!(tokens[0], text("see "));
    let Token::Wikilink {
        slug,
        fragment,
        embed,
        alias,
        tokens: label,
    } = &tokens[1]
    else {
        panic!("{tokens:?}")
    };
    assert_eq!(slug, "note");
    assert_eq!(fragment.as_deref(), Some("sec"));
    assert!(*embed);
    assert_eq!(alias.as_deref(), Some("An *alias*"));
    assert!(matches!(label[1], Token::Em { .. }));
}

#[test]
fn wikilink_label_defaults_to_slug() {
    let t = lex("[[a b]]", Tier::Unicode);
    let Token::Paragraph { tokens } = &t[0] else {
        panic!()
    };
    let Token::Wikilink {
        tokens: label,
        alias,
        ..
    } = &tokens[0]
    else {
        panic!()
    };
    assert_eq!(alias, &None);
    assert_eq!(label, &vec![text("a b")]);
}

#[test]
fn inline_forms() {
    let t = lex(
        "*e* **s** `c&d` [l](h) ![i](s \"t\") ~~d~~ \\* <b>",
        Tier::Unicode,
    );
    let Token::Paragraph { tokens } = &t[0] else {
        panic!()
    };
    let kinds: Vec<&str> = tokens
        .iter()
        .map(|t| match t {
            Token::Em { .. } => "em",
            Token::Strong { .. } => "strong",
            Token::Codespan { .. } => "codespan",
            Token::Link { .. } => "link",
            Token::Image { .. } => "image",
            Token::Del { .. } => "del",
            Token::Escape { .. } => "escape",
            Token::Html { .. } => "html",
            Token::Text { .. } => "text",
            _ => "other",
        })
        .filter(|k| *k != "text")
        .collect();
    assert_eq!(
        kinds,
        [
            "em", "strong", "codespan", "link", "image", "del", "escape", "html"
        ]
    );
    assert!(tokens.contains(&Token::Codespan {
        text: "c&amp;d".into()
    }));
    assert!(tokens.contains(&Token::Image {
        href: "s".into(),
        title: Some("t".into()),
        text: "i".into()
    }));
}

#[test]
fn table_cells_split_like_marked() {
    let t = lex("| a | b \\| c |\n|---|:-:|\n| 1 |\n", Tier::Unicode);
    let Token::Table {
        header,
        rows,
        align,
    } = &t[0]
    else {
        panic!("{t:?}")
    };
    assert_eq!(header[1].text, "b | c");
    assert_eq!(align, &vec![None, Some(crate::text::Align::Center)]);
    assert_eq!(rows[0][1].text, "");
}

#[test]
fn table_cell_spans_after_an_escaped_pipe_keep_their_place() {
    let t = lex("| h |\n|---|\n| `a \\| b` then `c` |\n", Tier::Unicode);
    let Token::Table { rows, .. } = &t[0] else {
        panic!("{t:?}")
    };
    let kinds: Vec<String> = rows[0][0]
        .tokens
        .iter()
        .map(|k| match k {
            Token::Codespan { text } => format!("code:{text}"),
            Token::Text { raw, .. } => format!("text:{raw}"),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(kinds, ["code:a | b", "text: then ", "code:c"]);
}

#[test]
fn references_resolve_past_comraks_expansion_cap() {
    // Far more resolved-reference bytes than the input is long: comrak alone stops
    // resolving once the cap is spent; marked resolves every one.
    let url = format!("https://example.test/{}", "x".repeat(200));
    let body = format!("{}\n\n[r]: {url}\n", "[a][r] ".repeat(40));
    let t = lex(&body, Tier::Unicode);
    let Token::Paragraph { tokens } = &t[0] else {
        panic!("{t:?}")
    };
    let links = tokens
        .iter()
        .filter(|k| matches!(k, Token::Link { href, .. } if *href == url))
        .count();
    assert_eq!(links, 40);
}

#[test]
fn final_hr_leaves_its_blank_lines_to_a_space() {
    let t = lex("a\n\n---\n\n", Tier::Unicode);
    assert!(
        matches!(t.as_slice(), [_, Token::Space, Token::Hr, Token::Space]),
        "{t:?}"
    );
}

#[test]
fn task_state_line_matches_the_prepass_regex() {
    assert_eq!(task_state_line("  - [x] a"), Some((4, 'x')));
    assert_eq!(task_state_line("- [x]a"), None);
    assert_eq!(task_state_line("1. [x] a"), None);
    assert_eq!(task_state_line("> - [x] a"), None);
}

#[test]
fn heading_trailing_hashes() {
    assert_eq!(atx_text("# a #"), (2, 3));
    assert_eq!(atx_text("# a#"), (2, 4));
}

fn json(body: &str) -> String {
    serde_json::to_string(&lex(body, Tier::Unicode)).unwrap()
}

#[test]
fn autolink_keeps_a_trailing_pop_directional_isolate_like_marked() {
    let j = json("see \u{2068}https://a.io/x\u{2069}\nnext\n");
    assert!(j.contains("\"href\":\"https://a.io/x\u{2069}\""), "{j}");
    assert!(j.contains("\"raw\":\"\\nnext\""), "{j}");
}

#[test]
fn tab_after_an_item_marker_is_three_spaces_like_marked() {
    let j = json("1.\t**b**: c\n");
    assert!(j.contains("\"raw\":\"   **b**: c\""), "{j}");
    // A tab after a space keeps its place (marked's `^\t+` does not match).
    let j = json("- \tx\n");
    assert!(!j.contains("\"   x"), "{j}");
}

#[test]
fn escaped_bracket_in_emphasis_inside_a_link_label_is_unescaped() {
    let j = json("[**x\\[y\\]**](https://a.io/)\n");
    assert!(j.contains("\"text\":\"x[y]\""), "{j}");
    assert!(!j.contains("\"escape\""), "{j}");
}

#[test]
fn url_autolink_inside_an_open_bracket_is_linked_like_marked() {
    let j = json("See: [https://a.io/x]\n");
    assert!(j.contains("\"href\":\"https://a.io/x]\""), "{j}");
    assert!(j.contains("\"raw\":\"See: [\""), "{j}");
    let j = json("Go [www.a.io/x]\n");
    assert!(j.contains("\"href\":\"http://www.a.io/x]\""), "{j}");
    // Outside a bracket nothing changes: comrak's own autolink stands.
    let j = json("See: https://a.io/x.\n");
    assert!(j.contains("\"href\":\"https://a.io/x\""), "{j}");
    // An underscored host stays text (GFM §6.9), bracket or not.
    let j = json("See [https://a_b/c]\n");
    assert!(!j.contains("\"link\""), "{j}");
}

#[test]
fn email_autolink_ending_in_a_digit_is_linked_like_marked() {
    let j = json("pkg: name@1.2.3's notes\n");
    assert!(j.contains("\"href\":\"mailto:name@1.2.3\""), "{j}");
    assert!(j.contains("\"raw\":\"'s notes\""), "{j}");
    // A trailing `-`/`_` still is not part of an address.
    let j = json("a@b.c_ d\n");
    assert!(!j.contains("\"link\""), "{j}");
}

#[test]
fn lazy_quote_line_after_a_partly_consumed_tab_keeps_its_offsets() {
    let j = json("- > a\n\tb [x](https://a.io/p/)\n");
    assert!(j.contains("\"raw\":\"a\\n  b \""), "{j}");
    assert!(
        j.contains("\"href\":\"https://a.io/p/\",\"text\":\"x\""),
        "{j}"
    );
    assert!(!j.contains("\"raw\":\")\""), "{j}");
    let j = json("1. > a\n\t https://a.io/p  \n\tb\n");
    assert!(j.contains("\"href\":\"https://a.io/p\""), "{j}");
}

#[test]
fn leading_definition_consumes_its_newlines_like_marked() {
    assert!(!json("[a]: /u \"t\"\n<p>\n").starts_with("[{\"type\":\"space\""));
    assert!(!json("[a]: /u\n\n\nx\n").starts_with("[{\"type\":\"space\""));
}

#[test]
fn definition_on_an_unterminated_last_line_is_a_definition() {
    let j = json("p\n\n[a]: <https://a.io/b+c=>");
    assert!(!j.contains("\"link\""), "{j}");
}

#[test]
fn nbsp_line_after_a_nested_item_is_kept_as_content() {
    let j = json("- a.\n\n  - b.\n\u{a0}\n\nc\n");
    assert!(j.contains("\"text\":\"b.\\n\u{a0}\""), "{j}");
    let j = json("- a.\n\n  - b.\n\u{a0}\n");
    assert!(j.contains("\"text\":\"b.\\n\u{a0}\""), "{j}");
    // A trailing U+00A0 on the last item's last line stays in its text (comrak's reading).
    let j = json("- a.\u{a0}\n   \n    - b.\u{a0}\n       \n- d\n");
    assert!(j.contains("\"text\":\"b.\u{a0}\""), "{j}");
    assert!(json("- a\u{a0}\n").contains("\"text\":\"a\u{a0}\""));
}

#[test]
fn lazy_image_line_after_an_indented_continuation_is_an_image() {
    let j = json("- a\n\t\t- b\n![](p.png)\n\nc\n");
    assert!(j.contains("\"type\":\"image\""), "{j}");
    let j = json("- a\n      - b\n[x](p.png)\n");
    assert!(j.contains("\"href\":\"p.png\""), "{j}");
}
