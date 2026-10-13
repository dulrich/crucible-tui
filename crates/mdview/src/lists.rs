//! Owned list composition, ported from `TS_BASELINE` `src/lists.ts` (WP-4b of `plans/mdview-rust-port.md`):
//! `renderList`, `composeItem`, unordered and ordered composition, numbering, task states,
//! `fixNestedLists` and `visibleMap`, the claim domains (`isPointedLine`, `claimLine`),
//! `realignEmbeddedContinuations` and `substituteBullets`.
//!
//! **Typed since WP-R10 of `plans/rust-port-code-quality-remediation.md`.** From composition
//! until `ListTextLayout::list_body` emits it, a list is a `Vec<RenderedLine>` (`list_lines.rs`):
//! fence state, raw indent, marker and body as fields. Bytes become typed once, in [`compose`]
//! (the walk hands each item back as a `String`), and leave once, in [`emit_list`].
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

use crate::ansi::{has_sequences, strip_sequences};
use crate::blocks::{TAB, transform};
use crate::context::{LayoutContext, PrefixEntry};
use crate::glyphs::GlyphSet;
use crate::list_lines::{
    Fence, FenceWalk, Marker, OpenListItem, RenderedLine, track_list_line, visible_map,
};
use crate::render::RenderError;
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
/// and is not a JS line terminator. An empty line stays empty. Typed, that is: prefix each
/// line's indent unless the line is empty or starts with a terminator.
pub fn indent_lines(indent: &str, lines: &mut [RenderedLine]) {
    for line in lines {
        let first = line
            .indent
            .chars()
            .chain(line.marker_text().chars())
            .chain(line.body.chars())
            .next();
        if first.is_some_and(|c| !is_js_line_terminator(c)) {
            line.indent.insert_str(0, indent);
        }
    }
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

/// `RAW_TASK_STATE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]( *)/` (`lists.ts:305`). JS `.`
/// is one UTF-16 code unit that is not a line terminator, so an astral character never matches.
static RAW_TASK_STATE: LazyLock<Regex> = LazyLock::new(|| {
    js_regex(
        r"^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([^\n\r\x{2028}\x{2029}\x{10000}-\x{10FFFF}])\]( *)",
    )
});

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

/// `fixNestedLists()` (`lists.ts:202-217`), per typed line. A line with no sequences takes the
/// single `replace` (`$1\n<indent>$2$3`, i.e. a split after group 1); otherwise the decision is
/// made on the visible text and the split lands at the matching raw offset.
///
/// The head piece keeps its typed fields (a split always falls after the marker, since group 1
/// starts at a visible non-space). Each later piece is a nested list the walk glued onto its
/// parent's text in bytes, so it is re-typed here, where it enters as a line of its own.
pub fn fix_nested_lists(lines: Vec<RenderedLine>, sentinel: char) -> Vec<RenderedLine> {
    let mut out = Vec::with_capacity(lines.len());
    for mut line in lines {
        let text = line.emit("*");
        let splits: Vec<usize> = if has_sequences(&text) {
            let (visible, raw_offsets) = visible_map(&text);
            fix_nested_boundaries(&visible)
                .into_iter()
                .map(|b| raw_offsets[b])
                .collect()
        } else {
            fix_nested_boundaries(&text)
        };
        let Some(&head_end) = splits.first() else {
            out.push(line);
            continue;
        };
        let mut walk = FenceWalk::resume(sentinel, line.fence == Fence::Inside);
        line.fence = Fence::of(&walk.step(&text[..head_end]));
        line.body
            .truncate(head_end - line.indent.len() - line.marker_text().len());
        out.push(line);
        for (i, &start) in splits.iter().enumerate() {
            let end = splits.get(i + 1).copied().unwrap_or(text.len());
            let piece = format!("{TAB}{}", &text[start..end]);
            let fence = Fence::of(&walk.step(&piece));
            out.push(RenderedLine::type_line(&piece, fence));
        }
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

/// `renderList()` (`lists.ts:483-516`), typed: the items' bytes enter at [`compose`], and the
/// composed lines leave as [`RenderedLine`]s for `ListTextLayout::list_body` to wrap and emit.
pub fn render_list(
    ctx: &LayoutContext,
    ordered: bool,
    items: &[ListItem],
    parse: &dyn Fn(&[Token], bool) -> R,
    sentinel: char,
) -> Result<Vec<RenderedLine>, RenderError> {
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

    let mut lines = compose(&groups, sentinel, ordered);
    indent_lines(TAB, &mut lines);
    let mut lines = fix_nested_lists(lines, sentinel);
    realign_embedded_continuations(&mut lines, ctx.measure);
    section(&mut lines, sentinel);
    Ok(lines)
}

/// `section()` (`blocks.ts`), typed: the two blank lines its `"\n\n"` appends, in whatever
/// fence state the last line leaves.
fn section(lines: &mut Vec<RenderedLine>, sentinel: char) {
    let inside = lines.last().is_some_and(|last| {
        let flips = last.indent.matches(sentinel).count() + last.body.matches(sentinel).count();
        (last.fence == Fence::Inside) != (flips % 2 == 1)
    });
    let fence = if inside { Fence::Inside } else { Fence::Prose };
    for _ in 0..2 {
        lines.push(RenderedLine {
            fence,
            indent: String::new(),
            marker: None,
            body: String::new(),
        });
    }
}

/// `claimLine()` (`lists.ts:538-541`): raw bytes for a fence line, stripped bytes for prose.
pub fn claim_line(line: &str, started_inside_code: bool, carries_sentinel: bool) -> bool {
    if started_inside_code || carries_sentinel {
        is_pointed_line(line)
    } else {
        is_pointed_line(&strip_sequences(line))
    }
}

/// `composeUnordered()` and `composeOrdered()` (`lists.ts:557-575`, `633-656`): the list
/// pipeline's entry, where every item line is typed once. A claimed line keeps its own indent;
/// any other is padded to the item's marker width. An ordered item's first line takes its
/// number in place of the `* ` composition put there (TS: `line.replace(BULLET_POINT, marker)`,
/// a no-op on the one first line that does not start `* ` — an empty last item trimmed to `*`).
fn compose(groups: &[Vec<&str>], sentinel: char, ordered: bool) -> Vec<RenderedLine> {
    let mut lines = Vec::new();
    let mut walk = FenceWalk::new(sentinel);
    for (index, group) in groups.iter().enumerate() {
        let pad = to_spaces(&if ordered {
            numbered_point(index + 1)
        } else {
            BULLET_POINT.to_owned()
        });
        for (position, raw) in group.iter().enumerate() {
            let fence = walk.step(raw);
            let mut line = RenderedLine::type_line(raw, Fence::of(&fence));
            if ordered && position == 0 {
                if raw.starts_with(BULLET_POINT) {
                    line.marker = Some(Marker::Ordered(format!("{}.", index + 1)));
                }
            } else if !claim_line(raw, fence.started_inside, fence.carries_sentinel) {
                line.indent.insert_str(0, &pad);
            }
            lines.push(line);
        }
    }
    lines
}

/// The leading run of literal spaces (`/^ */.exec(s)[0].length`).
fn leading_spaces(s: &str) -> usize {
    s.len() - s.trim_start_matches(' ').len()
}

/// `realignEmbeddedContinuations()` (`lists.ts:691-737`). The item stack is still tracked over
/// each line's visible text (`track_list_line` is the detectors' shared primitive); the indent
/// it trims is the line's own field, so no raw-versus-visible slicing is left.
pub fn realign_embedded_continuations(lines: &mut [RenderedLine], measure: Measure) {
    let mut open: Vec<OpenListItem> = Vec::new();
    let tab = TAB.len();
    for line in lines {
        if line.fence.touches() {
            continue;
        }
        let bare = strip_sequences(&line.emit("*")).into_owned();
        let Some(item) = track_list_line(&bare, &mut open, measure) else {
            continue;
        };
        let Some(own) = open.first() else {
            continue;
        };
        let added = own.text_column as isize - own.marker_column as isize;
        let indent = leading_spaces(&line.visible_indent());
        if item.marker_column <= tab
            || own.marker_column != tab
            || added <= 0
            || indent <= item.text_column
        {
            continue;
        }
        let target = (item.text_column as isize).max(indent as isize - added) as usize;
        let remove = indent - target;
        if leading_spaces(&line.indent) < remove {
            continue;
        }
        line.indent.drain(..remove);
        if !is_pointed_line(&bare) && is_pointed_line(&bare[remove..]) {
            line.indent.insert(0, ' ');
        }
    }
}

/// `substituteBullets()` (`lists.ts:757-791`), as a property of the line: the glyph a line's
/// marker is spelled with at emission. Only a [`Marker::Bullet`] qualifies, on a line that did
/// not start inside a fence, with a visible indent of spaces on the four-column grid.
pub fn bullet_glyph(line: &RenderedLine, glyphs: &GlyphSet) -> &'static str {
    let indent = line.visible_indent();
    let on_grid = !indent.is_empty()
        && indent.bytes().all(|b| b == b' ')
        && indent.len().is_multiple_of(TAB.len());
    if line.marker != Some(Marker::Bullet)
        || line.fence == Fence::Inside
        || !on_grid
        || glyphs.bullets.is_empty()
    {
        return "*";
    }
    glyphs.bullets[(indent.len() / TAB.len() - 1) % glyphs.bullets.len()]
}

/// The list pipeline's one exit to bytes: every line emitted and joined, bullets substituted
/// when `glyphs` is given (the outermost list only).
pub fn emit_list(lines: &[RenderedLine], glyphs: Option<&GlyphSet>) -> String {
    lines
        .iter()
        .map(|line| line.emit(glyphs.map_or("*", |g| bullet_glyph(line, g))))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests;
