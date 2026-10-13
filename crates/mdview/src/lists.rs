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

use crate::ansi::{has_sequences, scan_narrow, strip_sequences};
use crate::blocks::{TAB, section, transform};
use crate::context::{LayoutContext, PrefixEntry};
use crate::glyphs::GlyphSet;
use crate::list_lines::{FenceWalk, OpenListItem, map_fenced_lines, track_list_line};
use crate::style::{StyleName, apply_style_chain};
use crate::text::{js_regex, js_trim, js_trim_end, js_trim_start};
use crate::token::{ListItem, Token};
use crate::walk::R;
use crate::width::Measure;

/// `BULLET_POINT` (`lists.ts:96`).
const BULLET_POINT: &str = "* ";

/// `LIST_ITEM = createStyler("reset")` (`lists.ts:105`).
const LIST_ITEM: &[StyleName] = &[StyleName::Reset];

/// The ECMAScript line terminators JS `.` refuses and an `m`-flag `$` matches before.
fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
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

/// `TASK_GLYPHS` (`lists.ts:252-276`), the Unicode tier's task-state table — the one table
/// both composition ([`task_glyph`]) and the lexer's pre-pass ([`task_glyph_char`]) read.
const TASK_GLYPHS: &[(char, &str)] = &[
    (' ', "○"),
    ('x', "✓"),
    ('X', "✓"),
    ('/', "◐"),
    ('-', "✗"),
    ('>', "➤"),
    ('<', "◷"),
    ('?', "?"),
    ('!', "!"),
    ('*', "★"),
    ('"', "❝"),
    ('l', "📍"),
    ('b', "🔖"),
    ('i', "ℹ"),
    ('S', "🐖"),
    ('I', "💡"),
    ('p', "👍"),
    ('c', "👎"),
    ('f', "🔥"),
    ('k', "🔑"),
    ('w', "🏆"),
    ('u', "⬆"),
    ('d', "⬇"),
];

/// The glyph for a task-state character, if the table has one.
pub fn task_glyph_char(state: char) -> Option<&'static str> {
    TASK_GLYPHS
        .iter()
        .find(|(c, _)| *c == state)
        .map(|(_, g)| *g)
}

/// The glyph for a task state, if it is exactly one character the table has.
pub fn task_glyph(state: &str) -> Option<&'static str> {
    let mut chars = state.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => task_glyph_char(c),
        _ => None,
    }
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
    let parsed = {
        let _prefix = ctx.prefix.scoped(PrefixEntry {
            columns: marker_width,
            list: false,
        });
        parse(&tokens, item.loose)
    };
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
                .filter(|line| !strip_sequences(line).is_empty())
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
        is_pointed_line(&strip_sequences(line))
    }
}

/// `composeUnordered()` (`lists.ts:557-575`).
fn compose_unordered(groups: &[Vec<&str>], sentinel: char) -> Vec<String> {
    let pad = to_spaces(BULLET_POINT);
    let mut lines = Vec::new();
    let mut walk = FenceWalk::new(sentinel);
    for group in groups {
        for line in group {
            let fence = walk.step(line);
            lines.push(
                if claim_line(line, fence.started_inside, fence.carries_sentinel) {
                    (*line).to_owned()
                } else {
                    format!("{pad}{line}")
                },
            );
        }
    }
    lines
}

/// `composeOrdered()` (`lists.ts:633-656`). The first line's `line.replace(BULLET_POINT, marker)`
/// is a first-occurrence string replace.
fn compose_ordered(groups: &[Vec<&str>], sentinel: char) -> Vec<String> {
    let mut lines = Vec::new();
    let mut walk = FenceWalk::new(sentinel);
    for (index, group) in groups.iter().enumerate() {
        let marker = numbered_point(index + 1);
        let pad = to_spaces(&marker);
        for (position, line) in group.iter().enumerate() {
            let fence = walk.step(line);
            if position == 0 {
                lines.push(line.replacen(BULLET_POINT, &marker, 1));
                continue;
            }
            lines.push(
                if claim_line(line, fence.started_inside, fence.carries_sentinel) {
                    (*line).to_owned()
                } else {
                    format!("{pad}{line}")
                },
            );
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
    let tab = TAB.len();
    map_fenced_lines(body, sentinel, |fence| {
        let line = fence.line;
        if fence.touches_fence() {
            return line.to_owned();
        }
        let bare = strip_sequences(line);
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
    map_fenced_lines(body, sentinel, |fence| {
        let line = fence.line;
        // Only a leading marker is rewritten, so a line that opens a fence still qualifies.
        if fence.started_inside {
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
}

#[cfg(test)]
mod tests;
