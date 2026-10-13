//! The wide-table allocator and emitter, ported from `TS_BASELINE` `src/table.ts`.
//!
//! WP-5a of `plans/mdview-rust-port.md` ports the first half: cell normalization (the
//! span-cell contract), `tableGrid`, `naturalWidths`, the allocator and the two wraps. The
//! emitter (`drawRule` … `renderGrid`) is WP-5b's and sits at the bottom of this
//! file; `render.rs`'s `table` visitor calls `render_table`.
//!
//! **Offsets.** A `CellSpan`'s `start`/`end` and a `CellFragment`'s `start`/`end` are UTF-16
//! code-unit indices into the cell text, exactly as in TS (`table.ts:99-110`); the emitter
//! converts at its one slicing seam, `style_fragment`, with `text::utf16_to_byte`.

use crate::glyphs::{BorderChars, GlyphSet};
use crate::style::Sgr;
use crate::style::{StyleName, apply_style, apply_style_chain, create_styler};
use crate::text::{
    Align, js_trim_end, js_trim_start, pad_to_width, split_token, utf16_len, utf16_to_byte,
};
use crate::token::{TableCell, Token};
use crate::width::Measure;
use crate::wikilink::WIKI_LINK_STYLES;

const PADDING_LEFT: usize = 1;
const PADDING_RIGHT: usize = 1;
const BORDER_COLUMNS: usize = 1;

/// Per-column content floor (`MIN_COLUMN_WIDTH`).
pub const MIN_COLUMN_WIDTH: usize = 6;

/// Hard lower bound on a cell width (`ABSOLUTE_MIN_COLUMN_WIDTH`).
pub const ABSOLUTE_MIN_COLUMN_WIDTH: usize = 1;

/// Display columns consumed by borders and padding for an N-column table.
pub fn chrome_width(column_count: usize) -> usize {
    if column_count == 0 {
        return 0;
    }
    let vertical_rules = column_count + 1;
    vertical_rules * BORDER_COLUMNS + column_count * (PADDING_LEFT + PADDING_RIGHT)
}

/// Convert an allocated content width to the full cell width, padding included.
pub fn cell_width(content_width: usize) -> usize {
    content_width + PADDING_LEFT + PADDING_RIGHT
}

// ---------------------------------------------------------------------------
// Cell text
// ---------------------------------------------------------------------------

/// Undo the five entities `marked` escapes (`/&(?:amp|lt|gt|quot|#39);/g`, left to right).
pub fn decode_entities(text: &str) -> String {
    const ENTITIES: [(&str, &str); 5] = [
        ("&amp;", "&"),
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        if let Some((entity, decoded)) = ENTITIES.iter().find(|(e, _)| tail.starts_with(e)) {
            out.push_str(decoded);
            rest = &tail[entity.len()..];
        } else {
            out.push('&');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// One styled run in a cell's finished text; UTF-16 offsets, half-open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellSpan {
    pub start: usize,
    pub end: usize,
    pub styles: Vec<StyleName>,
}

/// A cell's finished text plus the styling it owes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CellContent {
    pub text: String,
    pub spans: Vec<CellSpan>,
}

/// Pre-normalization text and spans, in raw walk coordinates.
struct RawCell {
    text: String,
    spans: Vec<CellSpan>,
}

fn plain_cell(text: String) -> RawCell {
    RawCell {
        text,
        spans: Vec::new(),
    }
}

/// `concatCells`: rebase each part's spans onto the joined string (UTF-16 `text.length`).
fn concat_cells(mut parts: Vec<RawCell>) -> RawCell {
    if parts.len() == 1 {
        return parts.remove(0);
    }
    let mut text = String::new();
    let mut spans = Vec::new();
    let mut base = 0;
    for part in parts {
        for span in part.spans {
            spans.push(CellSpan {
                start: span.start + base,
                end: span.end + base,
                styles: span.styles,
            });
        }
        base += utf16_len(&part.text);
        text.push_str(&part.text);
    }
    RawCell { text, spans }
}

/// `walkInline` (`table.ts:167`): flatten, never normalize.
fn walk_inline(tokens: &[Token], fallback: &str) -> RawCell {
    if tokens.is_empty() {
        return plain_cell(decode_entities(fallback));
    }
    concat_cells(tokens.iter().map(walk_one).collect())
}

fn walk_one(token: &Token) -> RawCell {
    match token {
        Token::Text { text, .. }
        | Token::Escape { text }
        | Token::Codespan { text }
        | Token::Html { text } => plain_cell(decode_entities(text)),
        Token::Strong { text, tokens }
        | Token::Em { text, tokens }
        | Token::Del { text, tokens, .. } => walk_inline(tokens, text),
        Token::Link { href, text, tokens } => {
            let label = walk_inline(tokens, text);
            if href.is_empty() || *href == label.text {
                return label;
            }
            concat_cells(vec![label, plain_cell(format!(" ({href})"))])
        }
        Token::Image { text, .. } => plain_cell(decode_entities(text)),
        Token::Br => plain_cell(" ".to_owned()),
        Token::Wikilink {
            slug,
            embed,
            alias,
            tokens,
            ..
        } => {
            let label = walk_inline(tokens, alias.as_deref().unwrap_or(slug));
            let lead = utf16_len(&label.text) - utf16_len(js_trim_start(&label.text));
            let tail = utf16_len(js_trim_end(&label.text));
            let spans = if lead >= tail {
                Vec::new()
            } else {
                vec![CellSpan {
                    start: lead,
                    end: tail,
                    styles: WIKI_LINK_STYLES.to_vec(),
                }]
            };
            let styled = RawCell {
                text: label.text,
                spans,
            };
            if *embed {
                concat_cells(vec![plain_cell("embed: ".to_owned()), styled])
            } else {
                styled
            }
        }
        // The `default` arm (`table.ts:224`). Block tokens never occur inside a cell; the
        // census schema drops their `raw`/`text`, so their empty-children fallback is "".
        Token::Heading { tokens, .. }
        | Token::Blockquote { tokens }
        | Token::Paragraph { tokens } => walk_inline(tokens, ""),
        Token::Code { text, .. } => plain_cell(decode_entities(text)),
        Token::Space | Token::Hr | Token::Table { .. } | Token::List { .. } => {
            plain_cell(String::new())
        }
    }
}

/// `WHITESPACE.test(charAt(i))`: every JS `\s` is in the BMP, so one code unit decides.
fn unit_is_ws(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(crate::text::is_js_whitespace)
}

/// `normalizeCell` (`table.ts:251`): collapse + trim, carrying spans, in UTF-16 units.
fn normalize_cell(raw: RawCell) -> CellContent {
    let source: Vec<u16> = raw.text.encode_utf16().collect();
    let mut positions = vec![0usize; source.len() + 1];
    let mut collapsed: Vec<u16> = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if unit_is_ws(source[index]) {
            positions[index] = collapsed.len();
            index += 1;
            collapsed.push(u16::from(b' '));
            while index < source.len() && unit_is_ws(source[index]) {
                positions[index] = collapsed.len();
                index += 1;
            }
            continue;
        }
        positions[index] = collapsed.len();
        collapsed.push(source[index]);
        index += 1;
    }
    positions[source.len()] = collapsed.len();

    // Every run is now one ASCII space, so the JS trims reduce to the ends' spaces.
    let lead = usize::from(collapsed.first() == Some(&u16::from(b' ')));
    let tail = collapsed.len() - usize::from(collapsed.last() == Some(&u16::from(b' ')));
    let text_units: &[u16] = if lead >= tail {
        &[]
    } else {
        &collapsed[lead..tail]
    };
    let text = String::from_utf16_lossy(text_units);
    if raw.spans.is_empty() {
        return CellContent {
            text,
            spans: Vec::new(),
        };
    }
    let len = text_units.len();
    let clamp = |at: usize| -> usize {
        let p = positions.get(at).copied().unwrap_or(0);
        p.saturating_sub(lead).min(len)
    };
    let mut spans = Vec::new();
    for span in raw.spans {
        let start = clamp(span.start);
        let end = clamp(span.end);
        if start < end {
            spans.push(CellSpan {
                start,
                end,
                styles: span.styles,
            });
        }
    }
    CellContent { text, spans }
}

/// `flattenInline`.
pub fn flatten_inline(tokens: &[Token], fallback: &str) -> CellContent {
    normalize_cell(walk_inline(tokens, fallback))
}

/// `cellText`.
pub fn cell_text(cell: &TableCell) -> CellContent {
    flatten_inline(&cell.tokens, &cell.text)
}

/// `TableGrid`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableGrid {
    pub header: Vec<CellContent>,
    pub rows: Vec<Vec<CellContent>>,
    pub aligns: Vec<Align>,
    pub column_count: usize,
}

/// `tableGrid` over a table's three fields.
pub fn table_grid(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    align: &[Option<Align>],
) -> TableGrid {
    let header: Vec<CellContent> = header.iter().map(cell_text).collect();
    let raw_rows: Vec<Vec<CellContent>> = rows
        .iter()
        .map(|row| row.iter().map(cell_text).collect())
        .collect();
    let column_count = raw_rows.iter().map(Vec::len).fold(header.len(), usize::max);
    let pad = |row: Vec<CellContent>| -> Vec<CellContent> {
        let mut row = row;
        row.truncate(column_count);
        row.resize(column_count, CellContent::default());
        row
    };
    let aligns = (0..column_count)
        .map(|i| align.get(i).copied().flatten().unwrap_or_default())
        .collect();
    TableGrid {
        header: pad(header),
        rows: raw_rows.into_iter().map(pad).collect(),
        aligns,
        column_count,
    }
}

/// `naturalWidths`: widest `text` per column (spans never measured), floored at 1.
pub fn natural_widths(
    header: &[CellContent],
    rows: &[Vec<CellContent>],
    measure: Measure,
) -> Vec<usize> {
    header
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let mut widest = measure.width(&cell.text);
            for row in rows {
                let width = measure.width(row.get(index).map_or("", |c| c.text.as_str()));
                if width > widest {
                    widest = width;
                }
            }
            ABSOLUTE_MIN_COLUMN_WIDTH.max(widest)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/// `Allocation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Allocation {
    pub widths: Vec<usize>,
    pub total_width: usize,
    pub fits: bool,
}

fn floor_widths(natural: &[usize]) -> Vec<usize> {
    natural
        .iter()
        .map(|&w| ABSOLUTE_MIN_COLUMN_WIDTH.max(w.min(MIN_COLUMN_WIDTH)))
        .collect()
}

fn sum(values: &[usize]) -> usize {
    values.iter().sum()
}

/// `proportionalShares`: largest remainder, with JS's double arithmetic reproduced.
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn proportional_shares(weights: &[usize], total: i64) -> Vec<usize> {
    if weights.is_empty() {
        return Vec::new();
    }
    let weight_total = sum(weights);
    if weight_total == 0 || total <= 0 {
        return vec![0; weights.len()];
    }
    let exact: Vec<f64> = weights
        .iter()
        .map(|&w| (w as f64 * total as f64) / weight_total as f64)
        .collect();
    let mut shares: Vec<usize> = exact.iter().map(|v| v.floor() as usize).collect();
    let mut order: Vec<(usize, f64)> = exact
        .iter()
        .enumerate()
        .map(|(i, v)| (i, v - v.floor()))
        .collect();
    // `b.fraction - a.fraction || a.index - b.index`: descending fraction, ascending index.
    order.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    let mut remainder = total - sum(&shares) as i64;
    for (index, _) in order {
        if remainder <= 0 {
            break;
        }
        shares[index] += 1;
        remainder -= 1;
    }
    shares
}

/// `keepNaturalColumns`: fixpoint of "at or under an equal share of what is unclaimed".
#[allow(clippy::cast_precision_loss)]
fn keep_natural_columns(natural: &[usize], budget: i64) -> Vec<bool> {
    let mut keep = vec![false; natural.len()];
    loop {
        let mut flexible = Vec::new();
        let mut claimed = 0usize;
        for (index, &width) in natural.iter().enumerate() {
            if keep[index] {
                claimed += width;
            } else {
                flexible.push(index);
            }
        }
        if flexible.is_empty() {
            break;
        }
        let fair_share = (budget - claimed as i64) as f64 / flexible.len() as f64;
        let newly: Vec<usize> = flexible
            .into_iter()
            .filter(|&i| natural[i] as f64 <= fair_share)
            .collect();
        if newly.is_empty() {
            break;
        }
        for index in newly {
            keep[index] = true;
        }
    }
    keep
}

/// `allocateWidths` (`table.ts:449`).
#[allow(clippy::cast_possible_wrap, clippy::cast_sign_loss)]
pub fn allocate_widths(natural: &[usize], target_width: usize) -> Allocation {
    let column_count = natural.len();
    if column_count == 0 {
        return Allocation {
            widths: Vec::new(),
            total_width: 0,
            fits: true,
        };
    }
    let chrome = chrome_width(column_count);
    let budget = target_width as i64 - chrome as i64;
    let finish = |widths: Vec<usize>| -> Allocation {
        let total_width = sum(&widths) + chrome;
        Allocation {
            widths,
            total_width,
            fits: total_width <= target_width,
        }
    };

    if (sum(natural) as i64) <= budget {
        return finish(natural.to_vec());
    }
    let floors = floor_widths(natural);
    if (sum(&floors) as i64) > budget {
        return finish(floors);
    }
    let keep = keep_natural_columns(natural, budget);
    let flexible: Vec<usize> = (0..column_count).filter(|&i| !keep[i]).collect();
    if flexible.is_empty() {
        return finish(floors);
    }
    let claimed: usize = (0..column_count)
        .filter(|&i| keep[i])
        .map(|i| natural[i])
        .sum();
    let weights: Vec<usize> = flexible.iter().map(|&i| natural[i]).collect();
    let shares = proportional_shares(&weights, budget - claimed as i64);

    let mut widths = natural.to_vec();
    for (position, &column) in flexible.iter().enumerate() {
        widths[column] = floors[column].max(shares[position]);
    }

    let mut overshoot = sum(&widths) as i64 - budget;
    while overshoot > 0 {
        let mut victim: Option<usize> = None;
        let mut widest: i64 = -1;
        for &column in &flexible {
            let width = widths[column];
            if width > floors[column] && (width as i64) > widest {
                widest = width as i64;
                victim = Some(column);
            }
        }
        let Some(victim) = victim else { break };
        widths[victim] -= 1;
        overshoot -= 1;
    }
    finish(widths)
}

// ---------------------------------------------------------------------------
// Lossless splitting
// ---------------------------------------------------------------------------

/// `wrapText`: greedy fill on `/\s+/` (JS whitespace) boundaries, over-long words hard-split.
pub fn wrap_text(text: &str, width: usize, measure: Measure) -> Vec<String> {
    let limit = width.max(1);
    let words: Vec<&str> = text
        .split(crate::text::is_js_whitespace)
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in words {
        let pieces = if measure.width(word) > limit {
            split_token(word, limit, measure)
        } else {
            vec![word.to_owned()]
        };
        for piece in pieces {
            if current.is_empty() {
                current = piece;
                continue;
            }
            if measure.width(&current) + 1 + measure.width(&piece) <= limit {
                current.push(' ');
                current.push_str(&piece);
            } else {
                lines.push(std::mem::replace(&mut current, piece));
            }
        }
    }
    lines.push(current);
    lines
}

/// One wrapped line of a cell; `start`/`end` are UTF-16 offsets, `None` when unlocated
/// (TS's `-1`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CellFragment {
    pub text: String,
    pub start: Option<usize>,
    pub end: Option<usize>,
}

/// `text.startsWith(line, at)` with `at` in UTF-16 units. An `at` inside a surrogate pair
/// can never match in JS (no line begins with a lone low surrogate), so it is rejected.
fn starts_with_at(text: &str, line: &str, at: usize) -> bool {
    let byte = utf16_to_byte(text, at);
    if utf16_len(&text[..byte]) != at {
        return at > utf16_len(text) && line.is_empty();
    }
    text[byte..].starts_with(line)
}

/// `wrapFragments` (`table.ts:566`): `wrap_text`'s lines with their offsets recovered.
pub fn wrap_fragments(text: &str, width: usize, measure: Measure) -> Vec<CellFragment> {
    let mut fragments = Vec::new();
    let mut cursor = 0;
    for line in wrap_text(text, width, measure) {
        let start = if starts_with_at(text, &line, cursor) {
            Some(cursor)
        } else if starts_with_at(text, &line, cursor + 1) {
            Some(cursor + 1)
        } else {
            None
        };
        match start {
            None => fragments.push(CellFragment {
                text: line,
                start: None,
                end: None,
            }),
            Some(start) => {
                let end = start + utf16_len(&line);
                fragments.push(CellFragment {
                    text: line,
                    start: Some(start),
                    end: Some(end),
                });
                cursor = end;
            }
        }
    }
    fragments
}

/// `styleBorder` (`table.ts:745`): grey, hue-class, so dropped under `formats`.
fn style_border(sgr: Sgr, text: &str) -> String {
    apply_style(sgr, &create_styler(StyleName::Gray, None), text)
}

/// `styleHead` (`table.ts:746`): bold, format-class, so kept under `formats`.
fn style_head(sgr: Sgr, text: &str) -> String {
    apply_style(sgr, &create_styler(StyleName::Bold, None), text)
}

/// `styleFragment` (`table.ts:761`), per fragment, nothing crossing.
///
/// **The UTF-16 → byte seam.** Span and fragment offsets are UTF-16 code units (as in TS);
/// every `fragment.text.slice(a, b)` here becomes a byte slice through `utf16_to_byte`
/// over the fragment text. A span edge inside a surrogate pair rounds to a char boundary
/// rather than splitting the pair as JS would; no producer emits such an edge.
fn style_fragment(fragment: &CellFragment, spans: &[CellSpan], sgr: Sgr) -> String {
    let Some(f_start) = fragment.start else {
        return fragment.text.clone();
    };
    if spans.is_empty() {
        return fragment.text.clone();
    }
    let f_end = fragment.end.unwrap_or(f_start);
    let text = fragment.text.as_str();
    let slice = |a: usize, b: usize| -> &str {
        let a = utf16_to_byte(text, a - f_start);
        let b = utf16_to_byte(text, b - f_start).max(a);
        &text[a..b]
    };
    let mut out = String::new();
    let mut cursor = f_start;
    for span in spans {
        let start = span.start.max(f_start);
        let end = span.end.min(f_end);
        if start >= end {
            continue;
        }
        if start > cursor {
            out.push_str(slice(cursor, start));
        }
        out.push_str(&apply_style_chain(sgr, &span.styles, slice(start, end)));
        cursor = end;
    }
    if cursor == f_start {
        return fragment.text.clone();
    }
    out.push_str(&text[utf16_to_byte(text, cursor - f_start)..]);
    out
}

/// One cell wrapped into its display lines, with its spans (`table.ts:783`).
struct LaidOutCell<'a> {
    fragments: Vec<CellFragment>,
    spans: &'a [CellSpan],
}

#[derive(Clone, Copy)]
enum RuleKind {
    Top,
    Mid,
    Bottom,
}

/// `drawRule` (`table.ts:802`): one border-style wrap per column, as `cli-table3` emitted.
fn draw_rule(widths: &[usize], chars: &BorderChars, kind: RuleKind, sgr: Sgr) -> String {
    let (first, inner, fill, last) = match kind {
        RuleKind::Top => (chars.top_left, chars.top_mid, chars.top, chars.top_right),
        RuleKind::Mid => (chars.left_mid, chars.mid_mid, chars.mid, chars.right_mid),
        RuleKind::Bottom => (
            chars.bottom_left,
            chars.bottom_mid,
            chars.bottom,
            chars.bottom_right,
        ),
    };
    let mut out = String::new();
    for (column, &width) in widths.iter().enumerate() {
        let left = if column == 0 { first } else { inner };
        let right = if column == widths.len() - 1 { last } else { "" };
        let piece = format!("{left}{}{right}", fill.repeat(cell_width(width)));
        out.push_str(&style_border(sgr, &piece));
    }
    out
}

/// `drawLine` (`table.ts:839`): alignment applied here; short cells pad below.
#[allow(clippy::too_many_arguments)]
fn draw_line(
    row: &[LaidOutCell<'_>],
    line_index: usize,
    widths: &[usize],
    aligns: &[Align],
    chars: &BorderChars,
    is_head: bool,
    measure: Measure,
    sgr: Sgr,
) -> String {
    let mut out = String::new();
    for (column, &width) in widths.iter().enumerate() {
        let left = style_border(
            sgr,
            if column == 0 {
                chars.left
            } else {
                chars.middle
            },
        );
        let right = if column == widths.len() - 1 {
            style_border(sgr, chars.right)
        } else {
            String::new()
        };
        let cell = row.get(column);
        let fragment = cell.and_then(|c| c.fragments.get(line_index));
        let content = match (cell, fragment) {
            (Some(cell), Some(fragment)) => format!(
                "{}{}{}",
                " ".repeat(PADDING_LEFT),
                pad_to_width(
                    &style_fragment(fragment, cell.spans, sgr),
                    width,
                    aligns.get(column).copied().unwrap_or(Align::Left),
                    measure,
                ),
                " ".repeat(PADDING_RIGHT)
            ),
            _ => " ".repeat(cell_width(width)),
        };
        out.push_str(&left);
        if is_head {
            out.push_str(&style_head(sgr, &content));
        } else {
            out.push_str(&content);
        }
        out.push_str(&right);
    }
    out
}

/// `rowHeight` (`table.ts:876`): the tallest cell, at least 1.
fn row_height(row: &[LaidOutCell<'_>]) -> usize {
    row.iter().map(|c| c.fragments.len()).fold(1, usize::max)
}

/// `composeTable` (`table.ts:886`): top rule, header, a rule before every body row, bottom.
fn compose_table(
    header: &[LaidOutCell<'_>],
    rows: &[Vec<LaidOutCell<'_>>],
    widths: &[usize],
    aligns: &[Align],
    chars: &BorderChars,
    measure: Measure,
    sgr: Sgr,
) -> String {
    let emit_row = |row: &[LaidOutCell<'_>], is_head: bool, out: &mut Vec<String>| {
        for line_index in 0..row_height(row) {
            out.push(draw_line(
                row, line_index, widths, aligns, chars, is_head, measure, sgr,
            ));
        }
    };
    let mut out = vec![draw_rule(widths, chars, RuleKind::Top, sgr)];
    emit_row(header, true, &mut out);
    for row in rows {
        out.push(draw_rule(widths, chars, RuleKind::Mid, sgr));
        emit_row(row, false, &mut out);
    }
    out.push(draw_rule(widths, chars, RuleKind::Bottom, sgr));
    format!("{}\n", out.join("\n"))
}

/// `renderTable` (`table.ts:935`) over a `table` token's three fields.
pub fn render_table(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    align: &[Option<Align>],
    target_width: usize,
    glyphs: &GlyphSet,
    measure: Measure,
    sgr: Sgr,
) -> String {
    render_grid(
        &table_grid(header, rows, align),
        target_width,
        glyphs,
        measure,
        sgr,
    )
}

/// `renderGrid`'s `layout` closure (`table.ts:969`).
fn lay_out_row<'g>(
    row: &'g [CellContent],
    widths: &[usize],
    measure: Measure,
) -> Vec<LaidOutCell<'g>> {
    row.iter()
        .enumerate()
        .map(|(index, cell)| LaidOutCell {
            fragments: wrap_fragments(
                &cell.text,
                widths
                    .get(index)
                    .copied()
                    .unwrap_or(ABSOLUTE_MIN_COLUMN_WIDTH),
                measure,
            ),
            spans: &cell.spans,
        })
        .collect()
}

/// `renderGrid` (`table.ts:955`): allocate, wrap, emit.
pub fn render_grid<'g>(
    grid: &'g TableGrid,
    target_width: usize,
    glyphs: &GlyphSet,
    measure: Measure,
    sgr: Sgr,
) -> String {
    if grid.column_count == 0 {
        return String::new();
    }
    let natural = natural_widths(&grid.header, &grid.rows, measure);
    let widths = allocate_widths(&natural, target_width).widths;
    let layout =
        |row: &'g [CellContent]| -> Vec<LaidOutCell<'g>> { lay_out_row(row, &widths, measure) };
    let header = layout(&grid.header);
    let rows: Vec<Vec<LaidOutCell<'_>>> = grid.rows.iter().map(|r| layout(r)).collect();
    compose_table(
        &header,
        &rows,
        &widths,
        &grid.aligns,
        glyphs.border,
        measure,
        sgr,
    )
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_doc;
#[cfg(test)]
mod tests_emit;
#[cfg(test)]
mod tests_spans;
