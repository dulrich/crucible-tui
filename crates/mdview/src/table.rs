//! The wide-table allocator and emitter, ported from `src/table.ts`.
//!
//! WP-5a of `plans/mdview-rust-port.md` ports the first half: cell normalization (the
//! span-cell contract), `tableGrid`, `naturalWidths`, the allocator and the two wraps. The
//! emitter (`resolveBorderChars` … `renderGrid`, `chromeWidth`'s other consumer) is WP-5b's;
//! until then a `table` token still renders as `RenderError::Unimplemented`.
//!
//! **Offsets.** A `CellSpan`'s `start`/`end` and a `CellFragment`'s `start`/`end` are UTF-16
//! code-unit indices into the cell text, exactly as in TS (`table.ts:99-110`); WP-5b's
//! emitter converts at its slicing seam with `text::utf16_to_byte`.

use crate::style::StyleName;
use crate::text::{Align, js_trim_end, js_trim_start, split_token, utf16_len, utf16_to_byte};
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

/// A marked `align` entry: `null` (and anything unrecognised) is `"left"` via `?? "left"`.
fn align_of(value: Option<&str>) -> Align {
    match value {
        Some("center") => Align::Center,
        Some("right") => Align::Right,
        _ => Align::Left,
    }
}

/// `tableGrid` over a table's three fields.
pub fn table_grid(
    header: &[TableCell],
    rows: &[Vec<TableCell>],
    align: &[Option<String>],
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
        .map(|i| align_of(align.get(i).and_then(|a| a.as_deref())))
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

#[cfg(test)]
mod tests;
