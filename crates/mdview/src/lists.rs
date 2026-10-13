//! Owned list composition, ported from `TS_BASELINE` `src/lists.ts` (WP-4b of `plans/mdview-rust-port.md`):
//! `renderList`, `composeItem`, unordered and ordered composition, numbering, task states,
//! `fixNestedLists` and `visibleMap`, the claim domains (`isPointedLine`, `claimLine`),
//! `realignEmbeddedContinuations` and `substituteBullets`.
//!
//! A transcription with the TS file as the spec, bugs included. The *why* behind every rule is
//! the TS module's own comments and `docs/agents/list-pipeline.md`; this file cites
//! `lists.ts:NNN` for each.
//!
//! **JS regex semantics, emulated by hand where Rust's `regex` differs.** `fixNestedLists`'
//! `/…(?:.*)+$/gm` and `indentLines`' `/(^|\n)(.+)/g` both use JS `.`, which excludes the four
//! ECMAScript line terminators (`\n`, `\r`, U+2028, U+2029), and `fixNestedLists`' `m`-flag `$`
//! matches before any of them. Both are therefore applied per JS line rather than through a
//! Rust `(?m)` regex, whose `.` and `$` only know `\n`. `RAW_TASK_STATE`'s `(.)` matches one
//! UTF-16 code unit, so it is restricted to the BMP. Offsets are bytes throughout; TS's UTF-16
//! offsets (`visibleMap`) only ever address ASCII spaces and the `*`, so the two agree.

use std::sync::LazyLock;

use regex::Regex;

use crate::ansi::{has_sequences, scan_narrow};
use crate::blocks::transform;
use crate::context::{LayoutContext, PrefixEntry};
use crate::glyphs::GlyphSet;
use crate::list_lines::{OpenListItem, strip_ansi, track_list_line};
use crate::style::{StyleName, apply_style_chain};
use crate::text::{JS_WS_CLASS, js_trim, js_trim_end, js_trim_start};
use crate::token::{ListItem, Token};
use crate::walk::R;
use crate::width::Measure;

/// `TAB` (`lists.ts:93`): four spaces, as a string.
const TAB: &str = "    ";

/// `BULLET_POINT` (`lists.ts:96`).
const BULLET_POINT: &str = "* ";

/// `LIST_ITEM = createStyler("reset")` (`lists.ts:105`).
const LIST_ITEM: &[StyleName] = &[StyleName::Reset];

/// The ECMAScript line terminators JS `.` refuses and an `m`-flag `$` matches before.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn js_regex(pattern: &str) -> Regex {
    let ws = format!("[{JS_WS_CLASS}]");
    let not_ws = format!("[^{JS_WS_CLASS}]");
    Regex::new(
        &pattern
            .replace(r"\s", &ws)
            .replace(r"\S", &not_ws)
            .replace(r"\d", "[0-9]"),
    )
    .expect("lists regex compiles")
}

/// `section()` (`lists.ts:108`).
fn section(text: &str) -> String {
    format!("{text}\n\n")
}

/// `indentLines()` (`lists.ts:121`): `text.replace(/(^|\n)(.+)/g, "$1" + indent + "$2")`.
///
/// Without an `m` flag `^` is the string start only, and `(.+)` needs one non-terminator, so the
/// indent goes at the string start and after every `\n`, exactly where the next character exists
/// and is not a JS line terminator. An empty line stays empty.
pub fn indent_lines(indent: &str, text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at_line_start = true;
    for c in text.chars() {
        if at_line_start && !is_js_line_terminator(c) {
            out.push_str(indent);
        }
        out.push(c);
        at_line_start = c == '\n';
    }
    out
}

/// `POINT_REGEX` (`lists.ts:128-130`): `(?:\*|\d+\.)`, with `\d` ASCII.
const POINT_REGEX: &str = r"(?:\*|[0-9]+\.)";

/// `fixNestedLists`' regex body for the `TAB` indent, applied to one JS line (no terminators),
/// so JS `.` is any character and the `m`-flag `$` is the segment end.
static FIX_NESTED: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(&format!(
        r"(\S(?: |  )?)((?:{TAB})+)({POINT_REGEX}(?:.*)+)$"
    ))
});

/// `isPointedLine` for the `TAB` indent (`lists.ts:229-231`).
static POINTED_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^(?:{TAB})*{POINT_REGEX}")).expect("compiles"));

/// `UNORDERED_MARKER_LINE = /^((?: {4})+)\*(\s)/` (`lists.ts:805`).
static UNORDERED_MARKER_LINE: LazyLock<Regex> = LazyLock::new(|| js_regex(r"^((?: {4})+)\*(\s)"));

/// `RAW_TASK_STATE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]( *)/` (`lists.ts:305`). JS `.`
/// is one UTF-16 code unit that is not a line terminator, so an astral character never matches.
static RAW_TASK_STATE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([^\n\r\x{2028}\x{2029}\x{10000}-\x{10FFFF}])\]( *)",
    )
});

/// `visibleMap()` (`lists.ts:146-160`): the visible text, plus the raw byte offset every visible
/// byte came from and a final end-of-string entry.
pub fn visible_map(text: &str) -> (String, Vec<usize>) {
    let mut visible = String::new();
    let mut raw_offsets = Vec::new();
    let mut raw_index = 0;
    for span in scan_narrow(text).spans {
        if span.kind == crate::ansi::SpanKind::Text {
            raw_offsets.extend(raw_index..raw_index + span.raw.len());
            visible.push_str(span.raw);
        }
        raw_index += span.raw.len();
    }
    raw_offsets.push(raw_index);
    (visible, raw_offsets)
}

/// Every `fixNestedLists` split point in `text`: the byte offset just after group 1 of each
/// match. The global `m`-flag regex cannot cross a JS line terminator (`\S`, spaces and `.`
/// all refuse one), and each match runs to its line's end, so at most one match per line.
fn fix_nested_boundaries(text: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut push_line = |line_start: usize, line: &str| {
        if let Some(caps) = FIX_NESTED.captures(line) {
            let g1 = caps.get(1).expect("group 1 always participates");
            out.push(line_start + g1.end());
        }
    };
    for (i, c) in text.char_indices() {
        if is_js_line_terminator(c) {
            push_line(start, &text[start..i]);
            start = i + c.len_utf8();
        }
    }
    push_line(start, &text[start..]);
    out
}

/// `fixNestedLists()` (`lists.ts:202-217`). Text with no sequences takes the single `replace`
/// (`$1\n<indent>$2$3`, i.e. an insertion after group 1); otherwise the decision is made on the
/// visible text and the insertion lands at the matching raw offset.
pub fn fix_nested_lists(body: &str) -> String {
    let insertions: Vec<usize> = if has_sequences(body) {
        let (visible, raw_offsets) = visible_map(body);
        fix_nested_boundaries(&visible)
            .into_iter()
            .map(|b| raw_offsets[b])
            .collect()
    } else {
        fix_nested_boundaries(body)
    };
    let mut out = body.to_owned();
    for offset in insertions.into_iter().rev() {
        out.insert_str(offset, &format!("\n{TAB}"));
    }
    out
}

/// `isPointedLine(line, TAB)` (`lists.ts:229-231`).
pub fn is_pointed_line(line: &str) -> bool {
    POINTED_LINE.is_match(line)
}

/// `toSpaces()` (`lists.ts:234`): one space per UTF-16 unit (every caller passes ASCII).
fn to_spaces(s: &str) -> String {
    " ".repeat(crate::text::utf16_len(s))
}

/// `numberedPoint()` (`lists.ts:239`).
fn numbered_point(n: usize) -> String {
    format!("{n}. ")
}

/// `TASK_GLYPHS` (`lists.ts:252-276`).
pub fn task_glyph(state: &str) -> Option<&'static str> {
    Some(match state {
        " " => "○",
        "x" | "X" => "✓",
        "/" => "◐",
        "-" => "✗",
        ">" => "➤",
        "<" => "◷",
        "?" => "?",
        "!" => "!",
        "*" => "★",
        "\"" => "❝",
        "l" => "📍",
        "b" => "🔖",
        "i" => "ℹ",
        "S" => "🐖",
        "I" => "💡",
        "p" => "👍",
        "c" => "👎",
        "f" => "🔥",
        "k" => "🔑",
        "w" => "🏆",
        "u" => "⬆",
        "d" => "⬇",
        _ => return None,
    })
}

/// `renderTaskState()` (`lists.ts:371-398`). TS mutates the item's tokens in place; here the
/// caller's owned copy (`tokens`, a clone of `item.tokens`) is mutated, which is what the walk
/// then parses.
fn render_task_state(ctx: &LayoutContext, item: &ListItem, tokens: &mut [Token]) -> String {
    if !item.task {
        return String::new();
    }
    let caps = RAW_TASK_STATE.captures(&item.raw);
    let state = match &caps {
        Some(c) => c.get(1).map_or("", |m| m.as_str()).to_owned(),
        None if item.checked == Some(true) => "x".to_owned(),
        None => " ".to_owned(),
    };
    let gap = match &caps {
        Some(c) => c.get(2).map_or("", |m| m.as_str()).to_owned(),
        None => " ".to_owned(),
    };
    let glyph = if ctx.glyphs.rewrite_task_states {
        task_glyph(&state)
    } else {
        None
    };
    let prefix = match glyph {
        None => format!("[{state}]{gap}"),
        Some(g) => format!("{g}{gap}"),
    };

    let Some(first) = tokens.first_mut() else {
        return prefix;
    };
    let inline = match first {
        Token::Text {
            tokens: Some(kids), ..
        }
        | Token::Paragraph { tokens: kids } => kids,
        _ => return prefix,
    };
    match inline.first_mut() {
        Some(Token::Text { text, raw, .. }) => {
            *text = format!("{prefix}{text}");
            *raw = format!("{prefix}{raw}");
        }
        _ => inline.insert(
            0,
            Token::Text {
                raw: prefix.clone(),
                text: prefix.clone(),
                tokens: None,
            },
        ),
    }
    // `first.text` is a string on a block `text` token (and on marked's `paragraph`, whose
    // `text` no visitor reads and the Rust token does not carry).
    if let Token::Text { text, .. } = first {
        *text = format!("{prefix}{text}");
    }
    String::new()
}

/// `composeItem()` (`lists.ts:415-448`).
fn compose_item(
    ctx: &LayoutContext,
    item: &ListItem,
    parse: &dyn Fn(&[Token], bool) -> R,
    marker_width: usize,
) -> R {
    let mut tokens = item.tokens.clone();
    let mut text = render_task_state(ctx, item, &mut tokens);
    ctx.prefix.push(PrefixEntry {
        columns: marker_width,
        list: false,
    });
    let parsed = parse(&tokens, item.loose);
    ctx.prefix.pop();
    text.push_str(&parsed?);
    if text.contains('\n') {
        text = js_trim(&text).to_owned();
    }
    Ok(apply_style_chain(
        ctx.sgr,
        LIST_ITEM,
        &transform(ctx, &text),
    ))
}

/// `renderList()` (`lists.ts:483-516`).
pub fn render_list(
    ctx: &LayoutContext,
    ordered: bool,
    items: &[ListItem],
    parse: &dyn Fn(&[Token], bool) -> R,
    sentinel: char,
) -> R {
    let mut segments = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let marker_width = if ordered {
            numbered_point(index + 1).len()
        } else {
            BULLET_POINT.len()
        };
        segments.push(format!(
            "{BULLET_POINT}{}",
            compose_item(ctx, item, parse, marker_width)?
        ));
    }
    if !segments.is_empty() {
        segments[0] = js_trim_start(&segments[0]).to_owned();
        let last = segments.len() - 1;
        segments[last] = js_trim_end(&segments[last]).to_owned();
    }
    let groups: Vec<Vec<&str>> = segments
        .iter()
        .map(|segment| {
            segment
                .split('\n')
                .filter(|line| !strip_ansi(line).is_empty())
                .collect()
        })
        .collect();

    let lines = if ordered {
        compose_ordered(&groups, sentinel)
    } else {
        compose_unordered(&groups, sentinel)
    };
    let body = fix_nested_lists(&indent_lines(TAB, &lines.join("\n")));
    Ok(section(&realign_embedded_continuations(
        &body,
        ctx.measure,
        sentinel,
    )))
}

/// `claimLine()` (`lists.ts:538-541`): raw bytes for a fence line, stripped bytes for prose.
pub fn claim_line(line: &str, started_inside_code: bool, carries_sentinel: bool) -> bool {
    if started_inside_code || carries_sentinel {
        is_pointed_line(line)
    } else {
        is_pointed_line(&strip_ansi(line))
    }
}

/// The per-line sentinel walk shared by the composers and the de-drift: flip `inside_code` on
/// every sentinel occurrence; return `(startedInsideCode, carriesSentinel)`.
fn walk_sentinels(line: &str, sentinel: char, inside_code: &mut bool) -> (bool, bool) {
    let started = *inside_code;
    let mut carries = false;
    for ch in line.chars() {
        if ch == sentinel {
            *inside_code = !*inside_code;
            carries = true;
        }
    }
    (started, carries)
}

/// `composeUnordered()` (`lists.ts:557-575`).
fn compose_unordered(groups: &[Vec<&str>], sentinel: char) -> Vec<String> {
    let pad = to_spaces(BULLET_POINT);
    let mut lines = Vec::new();
    let mut inside_code = false;
    for group in groups {
        for line in group {
            let (started, carries) = walk_sentinels(line, sentinel, &mut inside_code);
            lines.push(if claim_line(line, started, carries) {
                (*line).to_owned()
            } else {
                format!("{pad}{line}")
            });
        }
    }
    lines
}

/// `composeOrdered()` (`lists.ts:633-656`). The first line's `line.replace(BULLET_POINT, marker)`
/// is a first-occurrence string replace.
fn compose_ordered(groups: &[Vec<&str>], sentinel: char) -> Vec<String> {
    let mut lines = Vec::new();
    let mut inside_code = false;
    for (index, group) in groups.iter().enumerate() {
        let marker = numbered_point(index + 1);
        let pad = to_spaces(&marker);
        for (position, line) in group.iter().enumerate() {
            let (started, carries) = walk_sentinels(line, sentinel, &mut inside_code);
            if position == 0 {
                lines.push(line.replacen(BULLET_POINT, &marker, 1));
                continue;
            }
            lines.push(if claim_line(line, started, carries) {
                (*line).to_owned()
            } else {
                format!("{pad}{line}")
            });
        }
    }
    lines
}

/// The leading run of literal spaces (`/^ */.exec(s)[0].length`).
fn leading_spaces(s: &str) -> usize {
    s.len() - s.trim_start_matches(' ').len()
}

/// `realignEmbeddedContinuations()` (`lists.ts:691-737`).
pub fn realign_embedded_continuations(body: &str, measure: Measure, sentinel: char) -> String {
    let mut open: Vec<OpenListItem> = Vec::new();
    let mut inside_code = false;
    let tab = TAB.len();
    body.split('\n')
        .map(|line| {
            let (started, carries) = walk_sentinels(line, sentinel, &mut inside_code);
            if started || carries {
                return line.to_owned();
            }
            let bare = strip_ansi(line);
            let Some(item) = track_list_line(&bare, &mut open, measure) else {
                return line.to_owned();
            };
            if item.marker_column <= tab {
                return line.to_owned();
            }
            let Some(own) = open.first() else {
                return line.to_owned();
            };
            if own.marker_column != tab {
                return line.to_owned();
            }
            let added = own.text_column as isize - own.marker_column as isize;
            if added <= 0 {
                return line.to_owned();
            }
            let indent = leading_spaces(&bare);
            if indent <= item.text_column {
                return line.to_owned();
            }
            let target = (item.text_column as isize).max(indent as isize - added) as usize;
            let remove = indent - target;
            if leading_spaces(line) < remove {
                return line.to_owned();
            }
            let realigned = &line[remove..];
            let bare_realigned = &bare[remove..];
            if is_pointed_line(&bare) || !is_pointed_line(bare_realigned) {
                return realigned.to_owned();
            }
            format!(" {realigned}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `substituteBullets()` (`lists.ts:757-791`).
pub fn substitute_bullets(body: &str, glyphs: &GlyphSet, sentinel: char) -> String {
    let bullet_for = |indent_columns: usize| -> &'static str {
        let depth = (indent_columns as f64 / TAB.len() as f64).round().max(1.0) as usize;
        if glyphs.bullets.is_empty() {
            return "*";
        }
        glyphs.bullets[(depth - 1) % glyphs.bullets.len()]
    };
    let mut inside_code = false;
    body.split('\n')
        .map(|line| {
            let (started, _) = walk_sentinels(line, sentinel, &mut inside_code);
            if started {
                return line.to_owned();
            }
            if !has_sequences(line) {
                let Some(caps) = UNORDERED_MARKER_LINE.captures(line) else {
                    return line.to_owned();
                };
                let indent = caps.get(1).map_or("", |m| m.as_str());
                let gap = caps.get(2).map_or("", |m| m.as_str());
                let whole = caps.get(0).expect("group 0").end();
                return format!(
                    "{indent}{}{gap}{}",
                    bullet_for(indent.len()),
                    &line[whole..]
                );
            }
            let (visible, raw_offsets) = visible_map(line);
            let Some(caps) = UNORDERED_MARKER_LINE.captures(&visible) else {
                return line.to_owned();
            };
            let indent = caps.get(1).map_or(0, |m| m.len());
            let at = raw_offsets[indent];
            format!("{}{}{}", &line[..at], bullet_for(indent), &line[at + 1..])
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    //! Every expected value below is the TS renderer's own output (`TS_BASELINE` `src/lists.ts` and
    //! `renderDocumentDetailed`), generated by a gitignored oracle under `target/`; none is
    //! derived by hand. Sources are minimal synthetic snippets or public `tests/fixtures/`.

    use super::*;
    use crate::glyphs::{ASCII_GLYPHS, UNICODE_GLYPHS};
    use crate::render::{Policy, RenderOptions, RenderOutput, Sgr, Tier, render};
    use crate::width::NARROW_MEASURE;

    const S: char = '\0';
    const U: Tier = Tier::Unicode;
    const A: Tier = Tier::Ascii;
    const N: Sgr = Sgr::None;
    const F: Sgr = Sgr::Full;
    const M: Sgr = Sgr::Formats;

    /// `(groups, composeUnordered, composeOrdered)`.
    type ComposeRow<'a> = (&'a [&'a [&'a str]], &'a [&'a str], &'a [&'a str]);
    /// `(fixture, [(width, tier, sgr, fnv1a(text + NUL + JSON(codeRanges)))])`.
    type FixtureRow<'a> = (&'a str, &'a [(usize, Tier, Sgr, u64)]);

    fn doc(source: &str, width: usize, tier: Tier, sgr: Sgr) -> RenderOutput {
        let options = RenderOptions {
            tier,
            policy: Policy {
                sgr,
                hyperlinks: false,
                tmux: false,
            },
            ..RenderOptions::plain(width)
        };
        render(source, None, &options).expect("renders")
    }

    #[test]
    fn indent_lines_skips_empty_lines_and_js_line_terminators() {
        let rows: &[(&str, &str)] = &[
            ("a\nb", "    a\n    b"),
            ("", ""),
            ("\n\nx", "\n\n    x"),
            ("a\r\nb", "    a\r\n    b"),
            ("a b\nc", "    a b\n    c"),
            ("\nx", "\n    x"),
            ("a\n\n  b\n", "    a\n\n      b\n"),
        ];
        for (input, want) in rows {
            assert_eq!(indent_lines(TAB, input), *want, "{input:?}");
        }
    }

    #[test]
    fn fix_nested_lists_splits_joins_on_visible_text() {
        let rows: &[(&str, &str)] = &[
            ("alpha    * sub", "alpha\n        * sub"),
            ("alpha     * sub", "alpha \n        * sub"),
            ("alpha      * sub", "alpha  \n        * sub"),
            ("alpha       * sub", "alpha       * sub"),
            ("alpha        * sub", "alpha\n            * sub"),
            ("alpha    12. sub", "alpha\n        12. sub"),
            ("alpha    *sub", "alpha\n        *sub"),
            ("    * alpha\n        * sub", "    * alpha\n        * sub"),
            ("a    * b    * c", "a\n        * b    * c"),
            (
                "one\ntwo    * x\nthree        1. y",
                "one\ntwo\n        * x\nthree\n            1. y",
            ),
            ("x\r    * y", "x\r    * y"),
            ("x z    * y", "x z\n        * y"),
            ("    \u{1b}[0m    * item", "    \u{1b}[0m    * item"),
            (
                "text\u{1b}[0m    * sub\u{1b}[0m",
                "text\u{1b}[0m\n        * sub\u{1b}[0m",
            ),
            (
                "\u{1b}[1mtext\u{1b}[22m        * sub\nnext    * q",
                "\u{1b}[1mtext\u{1b}[22m\n            * sub\nnext\n        * q",
            ),
            ("\u{1b}[0mα    * β", "\u{1b}[0mα\n        * β"),
        ];
        for (input, want) in rows {
            assert_eq!(fix_nested_lists(input), *want, "{input:?}");
        }
    }

    #[test]
    fn claim_line_asks_raw_bytes_for_fences_and_stripped_text_for_prose() {
        let rows: &[(&str, bool, bool, bool, bool)] = &[
            ("* a", true, true, true, true),
            ("    * a", true, true, true, true),
            ("  * a", false, false, false, false),
            ("1.5x", true, true, true, true),
            ("    12.", true, true, true, true),
            ("- a", false, false, false, false),
            ("\u{1b}[0m    * a", false, true, false, false),
            ("        *", true, true, true, true),
            ("", false, false, false, false),
            ("a* b", false, false, false, false),
        ];
        for (line, pointed, prose, started, carries) in rows {
            assert_eq!(is_pointed_line(line), *pointed, "{line:?}");
            assert_eq!(claim_line(line, false, false), *prose, "{line:?}");
            assert_eq!(claim_line(line, true, false), *started, "{line:?}");
            assert_eq!(claim_line(line, false, true), *carries, "{line:?}");
        }
    }

    #[test]
    fn visible_map_addresses_every_visible_byte_and_the_end() {
        let rows: &[(&str, &str, &[usize])] = &[
            ("", "", &[0]),
            ("abc", "abc", &[0, 1, 2, 3]),
            ("\u{1b}[0mab\u{1b}[1mc\u{1b}[22m", "abc", &[4, 5, 10, 16]),
            (
                "\u{1b}]8;;http://x\u{7}ln\u{1b}]8;;\u{7}!",
                "ln!",
                &[14, 15, 22, 23],
            ),
        ];
        for (input, visible, offsets) in rows {
            assert_eq!(
                visible_map(input),
                ((*visible).to_owned(), offsets.to_vec()),
                "{input:?}"
            );
        }
    }

    #[test]
    fn composers_pad_unclaimed_lines_and_number_per_item() {
        let rows: &[ComposeRow<'_>] = &[
            (
                &[&["* a", "b"][..], &["* c", "    * d", "      e"][..]],
                &["* a", "  b", "* c", "    * d", "        e"],
                &["1. a", "   b", "2. c", "    * d", "         e"],
            ),
            (
                &[
                    &["* a", "\u{0}    * fenced", "    * still\u{0}"][..],
                    &["* b"][..],
                ],
                &["* a", "  \u{0}    * fenced", "    * still\u{0}", "* b"],
                &["1. a", "   \u{0}    * fenced", "    * still\u{0}", "2. b"],
            ),
            (
                &[&["* a", "\u{1b}[0m    * styled"][..], &["* b"][..]],
                &["* a", "\u{1b}[0m    * styled", "* b"],
                &["1. a", "\u{1b}[0m    * styled", "2. b"],
            ),
            (
                &[
                    &["* a", "\u{0}x\u{0}", "    * after"][..],
                    &["* b", "* q * r"][..],
                ],
                &["* a", "  \u{0}x\u{0}", "    * after", "* b", "* q * r"],
                &["1. a", "   \u{0}x\u{0}", "    * after", "2. b", "* q * r"],
            ),
            (
                &[
                    &["* one"][..],
                    &["* two", "cont"][..],
                    &["* three"][..],
                    &["* 4"][..],
                    &["* 5"][..],
                    &["* 6"][..],
                    &["* 7"][..],
                    &["* 8"][..],
                    &["* 9"][..],
                    &["* ten", "tail"][..],
                ],
                &[
                    "* one", "* two", "  cont", "* three", "* 4", "* 5", "* 6", "* 7", "* 8",
                    "* 9", "* ten", "  tail",
                ],
                &[
                    "1. one", "2. two", "   cont", "3. three", "4. 4", "5. 5", "6. 6", "7. 7",
                    "8. 8", "9. 9", "10. ten", "    tail",
                ],
            ),
        ];
        for (groups, unordered, ordered) in rows {
            let groups: Vec<Vec<&str>> = groups.iter().map(|g| g.to_vec()).collect();
            assert_eq!(compose_unordered(&groups, S), *unordered, "{groups:?}");
            assert_eq!(compose_ordered(&groups, S), *ordered, "{groups:?}");
        }
    }

    #[test]
    fn realign_pulls_embedded_continuations_back_like_the_reference() {
        let rows: &[(&str, &str)] = &[
            (
                "    * a\n          * b\n            cont\n            cont2",
                "    * a\n          * b\n            cont\n            cont2",
            ),
            (
                "    * a\n          * b\n              over",
                "    * a\n          * b\n            over",
            ),
            (
                "    1. a\n           * b\n               over",
                "    1. a\n           * b\n             over",
            ),
            (
                "    * a\n          * b\n    \u{1b}[0m          over",
                "    * a\n          * b\n  \u{1b}[0m          over",
            ),
            (
                "    * a\n          * b\n\u{0}              code\n              code\u{0}\n              over",
                "    * a\n          * b\n\u{0}              code\n              code\u{0}\n            over",
            ),
            (
                "    * a\n          * b\n              * looks",
                "    * a\n          * b\n              * looks",
            ),
            (
                "    * a\n          * b\n              12. x",
                "    * a\n          * b\n              12. x",
            ),
            ("plain\n      indented", "plain\n      indented"),
        ];
        for (input, want) in rows {
            assert_eq!(
                realign_embedded_continuations(input, NARROW_MEASURE, S),
                *want,
                "{input:?}"
            );
        }
    }

    #[test]
    fn substitute_bullets_rewrites_grid_markers_outside_fences() {
        let rows: &[(&str, &str, &str)] = &[
            (
                "    * a\n        * b\n            * c\n                * d",
                "    • a\n        ◦ b\n            ‣ c\n                • d",
                "    - a\n        - b\n            - c\n                - d",
            ),
            (
                "* top\n  * two\n     * odd",
                "* top\n  * two\n     * odd",
                "* top\n  * two\n     * odd",
            ),
            (
                "    *\tx\n    *　y\n    *x",
                "    •\tx\n    •　y\n    *x",
                "    -\tx\n    -　y\n    *x",
            ),
            (
                "\u{1b}[0m    * styled\n    \u{1b}[0m* inner",
                "\u{1b}[0m    • styled\n    \u{1b}[0m• inner",
                "\u{1b}[0m    - styled\n    \u{1b}[0m- inner",
            ),
            (
                "    * a\n\u{0}    * code\n    * in\u{0}\n    * after",
                "    • a\n\u{0}    * code\n    * in\u{0}\n    • after",
                "    - a\n\u{0}    * code\n    * in\u{0}\n    - after",
            ),
            (
                "    * one\u{0}line\u{0}\n    * next",
                "    • one\u{0}line\u{0}\n    • next",
                "    - one\u{0}line\u{0}\n    - next",
            ),
        ];
        for (input, unicode, ascii) in rows {
            assert_eq!(
                substitute_bullets(input, &UNICODE_GLYPHS, S),
                *unicode,
                "{input:?}"
            );
            assert_eq!(
                substitute_bullets(input, &ASCII_GLYPHS, S),
                *ascii,
                "{input:?}"
            );
        }
    }

    /// End to end through `render()`: numbering (B1), task states (B2), the pre-pass
    /// positions, P3, fences in items, nesting, the blockquote tier shift, `chalk.reset` under
    /// colour, loose and tight wrapping, the `COLON_REPLACER` split, inline markup, emoji and
    /// entities — and WP-4a's deferred "list reflow" and "WP-14" cases.
    #[test]
    fn lists_render_like_the_reference() {
        let rows: &[(&str, usize, Tier, Sgr, &str)] = &[
            (
                "1. alpha\n    - sub one\n    - sub two\n2. beta\n3. gamma\n",
                80,
                U,
                N,
                "    1. alpha\n        ◦ sub one\n        ◦ sub two\n    2. beta\n    3. gamma\n\n",
            ),
            (
                "1. alpha\n    - sub one\n    - sub two\n2. beta\n3. gamma\n",
                80,
                U,
                F,
                "    1. \u{1b}[0malpha\n        ◦ \u{1b}[0m\u{1b}[0msub one\u{1b}[0m\u{1b}[0m\u{1b}[0m\n    \u{1b}[0m    ◦ \u{1b}[0m\u{1b}[0msub two\u{1b}[0m\u{1b}[0m\u{1b}[0m\n    2. \u{1b}[0mbeta\u{1b}[0m\n    3. \u{1b}[0mgamma\u{1b}[0m\n\n",
            ),
            (
                "1. a\n   1. x\n   2. y\n2. b\n",
                80,
                U,
                N,
                "    1. a\n        1. x\n        2. y\n    2. b\n\n",
            ),
            ("5. five\n6. six\n", 80, A, N, "    1. five\n    2. six\n\n"),
            (
                "1. one\n2. two\n3. three\n4. four\n5. five\n6. six\n7. seven\n8. eight\n9. nine words wrap here now\n10. ten words wrap here now\n",
                26,
                U,
                N,
                "    1. one\n    2. two\n    3. three\n    4. four\n    5. five\n    6. six\n    7. seven\n    8. eight\n    9. nine words wrap\n       here now\n    10. ten words wrap\n        here now\n\n",
            ),
            (
                "> - [x] done\n> - [ ] todo\n",
                80,
                U,
                N,
                "        • ✓ done\n        • ○ todo\n\n",
            ),
            (
                "> - [x] done\n> - [ ] todo\n",
                80,
                A,
                N,
                "        - [x] done\n        - [ ] todo\n\n",
            ),
            (
                "1. [x] done\n2. [ ] todo\n",
                80,
                U,
                N,
                "    1. ✓ done\n    2. ○ todo\n\n",
            ),
            (
                "1. [X] done\n2. [ ] todo\n",
                80,
                A,
                N,
                "    1. [X] done\n    2. [ ] todo\n\n",
            ),
            (
                "> - [X]   spaced\n1. [x]  two\n",
                80,
                U,
                N,
                "        • ✓   spaced\n\n    1. ✓  two\n\n",
            ),
            (
                "> - [X]   spaced\n1. [x]  two\n",
                80,
                A,
                N,
                "        - [X]   spaced\n\n    1. [x]  two\n\n",
            ),
            (
                "> - [x] **bold** text\n",
                80,
                U,
                F,
                "\u{1b}[90m\u{1b}[3m        • \u{1b}[0m✓ \u{1b}[1mbold\u{1b}[22m text\u{1b}[0m\u{1b}[23m\u{1b}[39m\n\n",
            ),
            (
                "- [x] done\n- [/] half\n- [ ] todo\n",
                80,
                U,
                N,
                "    • ✓ done\n    • ◐ half\n    • ○ todo\n\n",
            ),
            (
                "- [x] done\n- [/] half\n- [ ] todo\n",
                80,
                A,
                N,
                "    - [x] done\n    - [/] half\n    - [ ] todo\n\n",
            ),
            (
                "### Phase 1\n- [ ] 1. Alpha initialized\n- [ ] 2. Beta configured\n",
                80,
                U,
                N,
                "### Phase 1\n\n    • ○ 1. Alpha initialized\n    • ○ 2. Beta configured\n\n",
            ),
            (
                "1. [ ]\n   ```\n   code\n   ```\n",
                80,
                U,
                N,
                "    1. [ ]    code\n\n",
            ),
            (
                "- item\n\n  ```\n  - [ ] code\n  * star\n  ```\n",
                80,
                U,
                N,
                "    • item\n          - [ ] code\n        * star\n\n",
            ),
            (
                "- item\n\n  ```\n  - [ ] code\n  * star\n  ```\n",
                80,
                A,
                M,
                "    - \u{1b}[0m\u{1b}[0m\u{1b}[0mitem\u{1b}[0m\u{1b}[0m\u{1b}[0m\n      \u{1b}[0m    - [ ] code\u{1b}[0m\n      \u{1b}[0m    * star\u{1b}[0m\n\n",
            ),
            (
                "- alpha\n  - sub\n    - subsub\n      - four\n",
                80,
                U,
                N,
                "    • alpha\n        ◦ sub\n            ‣ subsub\n                • four\n\n",
            ),
            (
                "- outer\n  > - quoted\n",
                80,
                U,
                N,
                "    • outer\n            ‣ quoted\n\n",
            ),
            (
                "- a\n- b\n  - c\n",
                80,
                U,
                F,
                "    • \u{1b}[0ma\u{1b}[0m\n    • \u{1b}[0mb\n        ◦ \u{1b}[0m\u{1b}[0mc\u{1b}[0m\u{1b}[0m\u{1b}[0m\n\n",
            ),
            (
                "- one long item text that wraps around the edge\n\n- two\n",
                20,
                U,
                N,
                "    • one long item\n      text that\n      wraps around\n      the edge\n    • two\n\n",
            ),
            (
                "- one long item text that wraps around the edge\n\n- two\n",
                20,
                U,
                F,
                "    • \u{1b}[0m\u{1b}[0m\u{1b}[0mone long item\u{1b}[0m\n      \u{1b}[0mtext that\u{1b}[0m\n      \u{1b}[0mwraps around\u{1b}[0m\n      \u{1b}[0mthe edge\u{1b}[0m\u{1b}[0m\u{1b}[0m\n    • \u{1b}[0m\u{1b}[0m\u{1b}[0mtwo\u{1b}[0m\u{1b}[0m\u{1b}[0m\n\n",
            ),
            (
                "- line one<br />line two\n\n- b\n",
                80,
                U,
                N,
                "    • line one\n      line two\n    • b\n\n",
            ),
            (
                "- para one\n\n  para two\n\n- b\n",
                80,
                U,
                N,
                "    • para one\n      para two\n    • b\n\n",
            ),
            (
                "- first line\n  continued here\n- second  \n  hard break\n",
                30,
                U,
                N,
                "    • first line continued\n      here\n    • second\n      hard break\n\n",
            ),
            (
                "- see https://example.com/a/very/long/path/that/exceeds/width ok\n",
                30,
                U,
                N,
                "    • see\n      https://example.com/a/ve\n      ry/long/path/that/exceed\n      s/width ok\n\n",
            ),
            (
                "- word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word word \n",
                40,
                U,
                N,
                "    • word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word word word word\n      word word word word\n\n",
            ),
            (
                "- top\n  - nested item with quite a lot of words that must wrap at depth two\n",
                30,
                A,
                N,
                "    - top\n        - nested item with\n          quite a lot of words\n          that must wrap at\n          depth two\n\n",
            ),
            (
                "- but omitting `pricing.input_cache_read:3.5` that one\n",
                38,
                U,
                N,
                "    • but omitting\n      pricing.input_cache_read:3.5\n      that one\n\n",
            ),
            (
                "- run `a:b` and `c:d` now\n  soft\n",
                20,
                U,
                N,
                "    • run\n      a:b\n      and\n      c:d\n      now soft\n\n",
            ),
            (
                "- but omitting\n  `pricing.input_cache_read:3.5` that one\n",
                34,
                U,
                N,
                "    • but omitting\n      pricing.input_cache_read*#CO\n      LON|*3.5 that one\n\n",
            ),
            (
                "- but omitting\n  `pricing.input_cache_read:3.5` that one\n",
                38,
                A,
                N,
                "    - but omitting\n      pricing.input_cache_read*#COLON\n      |*3.5 that one\n\n",
            ),
            (
                "- **bold** _em_ `code` [link](http://x) ~~del~~\n1. **b** text\n- [ ] *em* task\n",
                80,
                U,
                N,
                "    • bold em code link (http://x) del\n\n    1. b text\n\n    • ○ em task\n\n",
            ),
            (
                "- **bold** _em_ `code` [link](http://x) ~~del~~\n1. **b** text\n",
                80,
                U,
                F,
                "    • \u{1b}[0m\u{1b}[1mbold\u{1b}[22m \u{1b}[3mem\u{1b}[23m \u{1b}[33mcode\u{1b}[39m \u{1b}[34mlink (\u{1b}[34m\u{1b}[4mhttp://x\u{1b}[24m\u{1b}[39m\u{1b}[34m)\u{1b}[39m \u{1b}[2m\u{1b}[90m\u{1b}[9mdel\u{1b}[29m\u{1b}[39m\u{1b}[22m\u{1b}[0m\n\n    1. \u{1b}[0m\u{1b}[1mb\u{1b}[22m text\u{1b}[0m\n\n",
            ),
            (
                "- a\n  - b\n\n    ```\n    long fenced line that must never wrap at all\n    ```\n",
                30,
                U,
                N,
                "    • a\n        ◦ b\n                long fenced line that must never wrap at all\n\n",
            ),
            (
                "- a\n  - b\n\n    ```\n    long fenced line that must never wrap at all\n    ```\n",
                60,
                A,
                M,
                "    - \u{1b}[0ma\n        - \u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0mb\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[0m\n      \u{1b}[0m      \u{1b}[0m\u{1b}[0m    long fenced line that must never wrap at all\u{1b}[0m\u{1b}[0m\u{1b}[0m\n\n",
            ),
            (
                "> - a\n>   - b\n> - c\n",
                80,
                U,
                N,
                "        • a\n            ◦ b\n        • c\n\n",
            ),
            (
                "- 中文字符测试中文字符测试中文字符测试 wrap\n",
                20,
                U,
                N,
                "    • 中文字符测试中\n      文字符测试中文\n      字符测试 wrap\n\n",
            ),
            (
                "- :rocket: launch\n- `:tada:` code\n",
                80,
                U,
                N,
                "    • 🚀  launch\n    • :tada: code\n\n",
            ),
            ("- :rocket: launch\n", 80, A, N, "    - :rocket: launch\n\n"),
            ("- a &amp; b &lt;c&gt;\n", 80, U, N, "    • a & b <c>\n\n"),
            ("- x\n\n\n- y\n", 80, U, N, "    • x\n    • y\n\n"),
            ("* a\n+ b\n", 80, U, N, "    • a\n\n    • b\n\n"),
            (
                "- a\n\n  > quoted in item\n  > second\n",
                80,
                U,
                N,
                "    • a\n          quoted in item second\n\n",
            ),
            (
                "- # heading in item\n- b\n",
                80,
                U,
                F,
                "    • \u{1b}[0m\u{1b}[35m\u{1b}[4m\u{1b}[1m# heading in item\u{1b}[22m\u{1b}[24m\u{1b}[39m\u{1b}[0m\n    • \u{1b}[0mb\u{1b}[0m\n\n",
            ),
            (
                "- <b>html</b> item\n",
                80,
                U,
                N,
                "    • <b>html</b> item\n\n",
            ),
            (
                "- item ending in spaces   \n  - nested\n",
                80,
                U,
                N,
                "    • item ending in spaces       * nested\n\n",
            ),
            (
                "1. lead\n   and a second authored line * star token here and more words\n",
                40,
                U,
                N,
                "    1. lead and a second authored line *\n       star token here and more words\n\n",
            ),
            (
                "- lead\n  and 12. looks like a marker when it wraps onto a line\n",
                18,
                U,
                N,
                "    • lead and 12.\n      looks like a\n      marker when\n      it wraps\n      onto a line\n\n",
            ),
        ];
        let mut failures = Vec::new();
        for (source, width, tier, sgr, want) in rows {
            let got = doc(source, *width, *tier, *sgr).text;
            if got != *want {
                failures.push(format!(
                    "{source:?} w{width} {tier:?} {sgr:?}\n  want {want:?}\n  got  {got:?}"
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// `tests/list-layout.test.ts`, "the layout state is per render, not per module": a
    /// document rendered after another renders exactly as the reference renders it alone.
    #[test]
    fn the_layout_state_is_per_render() {
        let rows: &[(&str, &str, usize, &str)] = &[
            (
                "> quoted paragraph\n",
                "- one two three four five six seven\n",
                20,
                "    • one two three\n      four five six\n      seven\n\n",
            ),
            (
                "> - q\n>   - r\n",
                "- aaa bbb ccc ddd eee\n",
                14,
                "    • aaa bbb\n      ccc ddd\n      eee\n\n",
            ),
            (
                "para one\n\npara two\n\n# head\n",
                "- tight *em* item\n  soft\n",
                80,
                "    • tight em item soft\n\n",
            ),
        ];
        for (first, second, width, want) in rows {
            doc(first, *width, U, N);
            assert_eq!(
                doc(second, *width, U, N).text,
                *want,
                "{first:?} then {second:?}"
            );
            assert_eq!(doc(second, *width, U, N).text, *want, "{second:?} again");
        }
    }

    fn fnv1a(text: &str) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        for byte in text.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        hash
    }

    fn fixture(name: &str) -> &'static str {
        match name {
            "coalesced-guard-collision" => {
                include_str!("../../../tests/fixtures/coalesced-guard-collision.md")
            }
            "coalesced-colon-guard-continuation" => {
                include_str!("../../../tests/fixtures/coalesced-colon-guard-continuation.md")
            }
            "tight-list" => include_str!("../../../tests/fixtures/tight-list.md"),
            "nested-list" => include_str!("../../../tests/fixtures/nested-list.md"),
            "fenced-list" => include_str!("../../../tests/fixtures/fenced-list.md"),
            "blockquote-list" => include_str!("../../../tests/fixtures/blockquote-list.md"),
            "loose-list" => include_str!("../../../tests/fixtures/loose-list.md"),
            "task-ordered-text" => include_str!("../../../tests/fixtures/task-ordered-text.md"),
            other => panic!("no fixture {other}"),
        }
    }

    /// The list fixtures, including the binding guard-collision witnesses at their named
    /// widths (64-70: the corrupted 65 and 69 and their neighbours; 50/60/90/101 for the
    /// colon-guard drift), both tiers, colour off and on. The expected value is the FNV-1a
    /// hash of the reference's `text + NUL + JSON(codeRanges)`.
    #[test]
    fn list_fixtures_render_like_the_reference_at_the_named_widths() {
        let rows: &[FixtureRow<'_>] = &[
            (
                "coalesced-guard-collision",
                &[
                    (40, U, N, 0xc81bb5f635f1d407),
                    (64, U, N, 0x256302e00a8d3647),
                    (65, U, N, 0x96fff654dd079827),
                    (66, U, N, 0x11304de68fe13eff),
                    (68, U, N, 0xb54de82a23b8fa55),
                    (69, U, N, 0x2ab144fd993f9565),
                    (70, U, N, 0x1915b7b735c28a21),
                    (80, U, N, 0xe7d0ebb48bf9d04b),
                    (101, U, N, 0x3e542cc1cbf2eef3),
                    (120, U, N, 0xff89038cadbfd3c5),
                    (40, U, F, 0xaefb16b4f4e98d07),
                    (64, U, F, 0x096270f248cf13b9),
                    (65, U, F, 0x84c8159454005e8b),
                    (66, U, F, 0x864931e84585a9a9),
                    (68, U, F, 0x122b599a50cefced),
                    (69, U, F, 0x4d320f69763b9fa1),
                    (70, U, F, 0xa6c87ac5b073631b),
                    (80, U, F, 0x76865a30eaf381f3),
                    (101, U, F, 0x0da31fbe205adb5f),
                    (120, U, F, 0x80632233fc96ad1e),
                    (40, A, N, 0xdfcc6dc06e987b20),
                    (64, A, N, 0xecfbe920f19bd99e),
                    (65, A, N, 0x185ed708a593c010),
                    (66, A, N, 0xd6279820ce1b73f6),
                    (68, A, N, 0x063766fcd3bddbc2),
                    (69, A, N, 0x9c5af5255ed5aeb2),
                    (70, A, N, 0xfddf380cf2385ac6),
                    (80, A, N, 0x98afbe7f2f97adc0),
                    (101, A, N, 0x252d0d38b4476bf4),
                    (120, A, N, 0xc95e60eda8de2cae),
                    (40, A, F, 0xceb81f4c31fe8c7c),
                    (64, A, F, 0x8e48c796088232dc),
                    (65, A, F, 0x2f9af4b79454c2e8),
                    (66, A, F, 0xa4b9aa1d5d19a9bc),
                    (68, A, F, 0x1f8aefb35f94c89e),
                    (69, A, F, 0x0d12f1e04ed5a0f2),
                    (70, A, F, 0x9898e3d33b95952c),
                    (80, A, F, 0xfe8b10f2ca6ea864),
                    (101, A, F, 0xcdaa3e4e611bda34),
                    (120, A, F, 0xe98e584991805f99),
                ],
            ),
            (
                "coalesced-colon-guard-continuation",
                &[
                    (38, U, N, 0xafc84367d86f1475),
                    (50, U, N, 0xd96450aae3eefe17),
                    (60, U, N, 0x4b873cba034c981b),
                    (90, U, N, 0x85061b5c5ccf87d3),
                    (101, U, N, 0xb1b34a6c218332df),
                    (38, U, F, 0xff2723dd886eed54),
                    (50, U, F, 0x8a0221ac7af75350),
                    (60, U, F, 0x9caf5d6b71f83fd0),
                    (90, U, F, 0x36d62e36c48abeb0),
                    (101, U, F, 0x8799ad7e7ad232cc),
                    (38, A, N, 0x5cfbd0ac29b3f782),
                    (50, A, N, 0x0d367f82a1c1d026),
                    (60, A, N, 0xd7afdd1caf61bb0e),
                    (90, A, N, 0x56516e88980c5922),
                    (101, A, N, 0xb2924b2814d71bf6),
                    (38, A, F, 0x4fd4fca29082fb3d),
                    (50, A, F, 0xd1febe68bbea66a3),
                    (60, A, F, 0x2aff2a2c2a16640f),
                    (90, A, F, 0x9faf9be7185f177b),
                    (101, A, F, 0x16c05374c4990817),
                ],
            ),
            (
                "tight-list",
                &[
                    (40, U, N, 0xbf6dd2c1a3356aee),
                    (80, U, N, 0x803ea510061cb036),
                    (116, U, N, 0xd7a369143f206f9c),
                    (172, U, N, 0x5c8e2a11af691fc1),
                    (40, U, M, 0xb846df382ff7d82d),
                    (80, U, M, 0x305636dadcc42499),
                    (116, U, M, 0x652708bf56daaa37),
                    (172, U, M, 0xef9d86a7d1769592),
                    (40, A, N, 0xccbdc936bb6c33de),
                    (80, A, N, 0xc53aef631f87f8dc),
                    (116, A, N, 0x262bfb0fbe239d14),
                    (172, A, N, 0xa655a87aaec75101),
                    (40, A, M, 0x0402e2b529c96db9),
                    (80, A, M, 0x0f86f9fc5e5e1f1b),
                    (116, A, M, 0x850541f5cb026827),
                    (172, A, M, 0x8a1dd7ae35fb5646),
                ],
            ),
            (
                "nested-list",
                &[
                    (40, U, N, 0x75b44b7ea3ef8d5a),
                    (54, U, N, 0x3124656aa5c75030),
                    (80, U, N, 0x269ca83b9873d6aa),
                    (116, U, N, 0xceb5d44a96c29d5a),
                    (40, U, M, 0xfc9618ea3642c601),
                    (54, U, M, 0xc2ccc4ebb42f2699),
                    (80, U, M, 0x1afa393911901649),
                    (116, U, M, 0x8c4f7255aebf9f05),
                    (40, A, N, 0x2e19b99c0ae7142a),
                    (54, A, N, 0x89ba384b0e1d4c44),
                    (80, A, N, 0xd5f6c88be6f559a2),
                    (116, A, N, 0x7acf0f804c67050a),
                    (40, A, M, 0x5244e1b8e2295121),
                    (54, A, M, 0xed93db0855b84c59),
                    (80, A, M, 0x0257803b6f1929d5),
                    (116, A, M, 0xc111a3c619a2a425),
                ],
            ),
            (
                "fenced-list",
                &[
                    (40, U, N, 0xcfde1376bb8bbb85),
                    (55, U, N, 0xe0cf581bd367b969),
                    (101, U, N, 0x1f9220a64b978b77),
                    (116, U, N, 0xd800c062ac79b1eb),
                    (40, U, M, 0x73514a3a478f7d5f),
                    (55, U, M, 0x6410f7c3d4a90d41),
                    (101, U, M, 0xe7142f6fcd04a521),
                    (116, U, M, 0x101d139f38450dfd),
                    (40, A, N, 0x40950fb30b558c00),
                    (55, A, N, 0xf3d4667c60767680),
                    (101, A, N, 0x063546f921c52e8e),
                    (116, A, N, 0xf7c247b7d9118166),
                    (40, A, M, 0xcade382dd567dc32),
                    (55, A, M, 0xbb664c16a76b58cc),
                    (101, A, M, 0x9ba31a1c33e5a6f0),
                    (116, A, M, 0xafc61f26902e92d0),
                ],
            ),
            (
                "blockquote-list",
                &[
                    (40, U, N, 0xe285f4ae3bc41162),
                    (80, U, N, 0xaaf9fd4e4efb6da4),
                    (116, U, N, 0xb56674ae86b138f2),
                    (40, U, M, 0xf2cb80b5f3da95ff),
                    (80, U, M, 0x2bb24198debe6339),
                    (116, U, M, 0x020f315c2cd1be6f),
                    (40, A, N, 0x0da8f8ffaa1d6dc5),
                    (80, A, N, 0xa02b2532d3fc62c3),
                    (116, A, N, 0x4f8a57ebc206f261),
                    (40, A, M, 0x27d650434f81d556),
                    (80, A, M, 0x2065c5340dd4f316),
                    (116, A, M, 0xf4e061d3a16d9528),
                ],
            ),
            (
                "loose-list",
                &[
                    (40, U, N, 0x6cad818101d3ef0c),
                    (80, U, N, 0x50227e86c6a0691e),
                    (116, U, N, 0x7181ac18bc02107e),
                    (40, U, F, 0xf8f0acbd6cd430f1),
                    (80, U, F, 0x8329d1f9789180eb),
                    (116, U, F, 0x88804eb158a8b396),
                    (40, A, N, 0xa40168ef10b13b88),
                    (80, A, N, 0x49d044f48223f960),
                    (116, A, N, 0x046597128d533d1e),
                    (40, A, F, 0x1b69f30e2104ec8b),
                    (80, A, F, 0xfbf4bf618a18c685),
                    (116, A, F, 0x68028ac9fe7e076a),
                ],
            ),
            (
                "task-ordered-text",
                &[
                    (40, U, N, 0x649c7e86ba488641),
                    (80, U, N, 0x3f0633d891bf483b),
                    (40, U, F, 0xbba56215cbff8f01),
                    (80, U, F, 0x8e5dd30b406edce0),
                    (40, A, N, 0x16e197f100e59596),
                    (80, A, N, 0x120c8b507f2e0cc8),
                    (40, A, F, 0x0d4a9826b1863ef2),
                    (80, A, F, 0x5ef128a7af5a175f),
                ],
            ),
        ];
        let mut failures = Vec::new();
        for (name, combos) in rows {
            for (width, tier, sgr, want) in *combos {
                let out = doc(fixture(name), *width, *tier, *sgr);
                let ranges: Vec<String> = out
                    .code_ranges
                    .iter()
                    .map(|(a, b)| format!("[{a},{b}]"))
                    .collect();
                let key = format!("{}\0[{}]", out.text, ranges.join(","));
                if fnv1a(&key) != *want {
                    failures.push(format!("{name} w{width} {tier:?} {sgr:?}"));
                }
            }
        }
        assert!(failures.is_empty(), "diverge: {failures:?}");
    }
}
