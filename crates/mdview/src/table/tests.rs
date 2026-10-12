//! Transcribed from `tests/table-normalization.test.ts`, `tests/table-allocation.test.ts` and
//! `tests/wikilink-table.test.ts` — every case that does not need the emitter (WP-5b's).

use super::*;
use crate::render::Tier;
use crate::style::StyleName::{Cyan, Underline};
use crate::width::{NARROW_MEASURE, WIDE_MEASURE};

/// Must stay byte-identical to the TS fixture (`tests/AGENTS.md`, the width-sensitive trap).
const LONG_PATH: &str = "example/backend/services/api/src/csv-importer.test.ts";
const GATE_COMMAND: &str = "bun run design:verify";
const N: Measure = NARROW_MEASURE;

fn lex_table(source: &str) -> TableGrid {
    for token in crate::lex::lex(source, Tier::Unicode) {
        if let Token::Table {
            header,
            rows,
            align,
        } = token
        {
            return table_grid(&header, &rows, &align);
        }
    }
    panic!("fixture contains no table");
}

fn body_cell(source: &str) -> CellContent {
    lex_table(source).rows[0][0].clone()
}

fn build_table(headers: &[&str], rows: &[&[&str]]) -> TableGrid {
    let divider: Vec<&str> = headers.iter().map(|_| "---").collect();
    let body: Vec<String> = rows
        .iter()
        .map(|row| format!("| {} |", row.join(" | ")))
        .collect();
    lex_table(&format!(
        "| {} |\n| {} |\n{}\n",
        headers.join(" | "),
        divider.join(" | "),
        body.join("\n")
    ))
}

fn wiki(start: usize, end: usize) -> CellSpan {
    CellSpan {
        start,
        end,
        styles: vec![Cyan, Underline],
    }
}

fn content(text: &str, spans: Vec<CellSpan>) -> CellContent {
    CellContent {
        text: text.to_owned(),
        spans,
    }
}

// --- allocateWidths ---------------------------------------------------------

#[test]
fn leaves_a_fitting_table_at_natural_widths() {
    let a = allocate_widths(&[4, 6, 5], 80);
    assert_eq!(a.widths, vec![4, 6, 5]);
    assert!(a.fits);
    assert_eq!(a.total_width, 4 + 6 + 5 + chrome_width(3));
}

#[test]
fn shrinks_only_over_budget_columns_and_fills_exactly() {
    let a = allocate_widths(&[3, 200], 80);
    assert_eq!(a.widths[0], 3);
    assert_eq!(a.widths[1], 80 - chrome_width(2) - 3);
    assert_eq!(a.total_width, 80);
    assert!(a.fits);
}

#[test]
fn never_below_the_floor() {
    let a = allocate_widths(&[120, 120, 120, 8], 60);
    for w in &a.widths {
        assert!(*w >= 8.min(MIN_COLUMN_WIDTH));
    }
    assert!(a.widths.iter().all(|w| *w > 0));
}

#[test]
fn sanctioned_overflow_at_the_floor() {
    let a = allocate_widths(&[40; 9], 80);
    assert!(!a.fits);
    assert_eq!(a.widths, vec![MIN_COLUMN_WIDTH; 9]);
    assert_eq!(a.total_width, 9 * MIN_COLUMN_WIDTH + chrome_width(9));
    assert_eq!(a.total_width, 82);
}

#[test]
fn empty_column_set() {
    assert_eq!(
        allocate_widths(&[], 80),
        Allocation {
            widths: vec![],
            total_width: 0,
            fits: true
        }
    );
}

#[test]
fn nine_columns_fit_once_wide_enough() {
    // `renderTable with nine or more columns`, allocator half: 82 is the minimum feasible.
    let a = allocate_widths(&[40; 9], 82);
    assert!(a.fits);
    assert_eq!(a.total_width, 82);
}

#[test]
fn narrow_column_beside_200_char_column_keeps_both() {
    // `renderTable column collapse`, allocator half.
    let long = "x".repeat(200);
    let grid = build_table(&["WP", "Description"], &[&["A1", &long]]);
    let natural = natural_widths(&grid.header, &grid.rows, N);
    assert_eq!(natural, vec![2, 200]);
    let a = allocate_widths(&natural, 80);
    assert_eq!(a.widths[0], 2);
    assert_eq!(a.total_width, 80);
}

#[test]
fn long_token_does_not_starve_narrow_column() {
    let grid = build_table(&["ID", "Path"], &[&["Q1", LONG_PATH]]);
    let natural = natural_widths(&grid.header, &grid.rows, N);
    assert_eq!(natural, vec![2, 53]);
    let a = allocate_widths(&natural, 40);
    assert_eq!(a.widths[0], 2);
    assert!(a.widths[1] >= MIN_COLUMN_WIDTH);
    assert!(a.fits);
}

#[test]
fn proportional_shares_largest_remainder() {
    assert_eq!(proportional_shares(&[1, 1, 1], 10), vec![4, 3, 3]);
    assert_eq!(proportional_shares(&[], 10), Vec::<usize>::new());
    assert_eq!(proportional_shares(&[3, 5], 0), vec![0, 0]);
    assert_eq!(proportional_shares(&[3, 5], -4), vec![0, 0]);
    assert_eq!(sum(&proportional_shares(&[7, 11, 13], 29)), 29);
}

#[test]
fn keep_natural_columns_reaches_a_fixpoint() {
    // budget 30: 3 <= 10 keeps the first; then 27/2 = 13.5 keeps 12; 50 never.
    assert_eq!(
        keep_natural_columns(&[3, 12, 50], 30),
        vec![true, true, false]
    );
}

#[test]
fn chrome_and_cell_width() {
    assert_eq!(chrome_width(0), 0);
    assert_eq!(chrome_width(3), 10);
    assert_eq!(cell_width(6), 8);
}

// --- splitToken (table-normalization.test.ts) -------------------------------

#[test]
fn split_token_is_lossless() {
    for w in [1, 2, 6, 7, 12, 40] {
        assert_eq!(split_token(LONG_PATH, w, N).concat(), LONG_PATH);
    }
}

#[test]
fn split_token_never_exceeds_width_nor_ellipsizes() {
    for w in [6, 7, 12] {
        for chunk in split_token(LONG_PATH, w, N) {
            assert!(N.width(&chunk) <= w);
        }
    }
    assert!(!split_token(LONG_PATH, 6, N).join("|").contains('…'));
}

#[test]
fn split_token_cjk_and_emoji() {
    let chunks = split_token("你好世界你好世界", 6, N);
    assert_eq!(chunks.concat(), "你好世界你好世界");
    assert_eq!(chunks[0], "你好世");
    let family = "👩\u{200d}👩\u{200d}👧\u{200d}👦";
    assert_eq!(
        split_token(&format!("{family}{family}"), 2, N),
        vec![family, family]
    );
}

// --- wrapText -----------------------------------------------------------------

#[test]
fn wrap_text_wraps_and_hard_splits() {
    let wrapped = wrap_text(&format!("{GATE_COMMAND} {LONG_PATH}"), 10, N);
    for line in &wrapped {
        assert!(N.width(line) <= 10);
    }
    let squeezed: String = wrapped.concat().split_whitespace().collect();
    assert!(squeezed.contains(LONG_PATH));
    assert!(!wrapped.concat().contains('…'));
}

#[test]
fn wrap_text_fits_on_one_line_and_empty() {
    assert_eq!(wrap_text(GATE_COMMAND, 40, N), vec![GATE_COMMAND]);
    assert_eq!(wrap_text("", 10, N), vec![""]);
    assert_eq!(wrap_text(" \t\u{a0} ", 10, N), vec![""]);
    assert_eq!(wrap_text("ab", 0, N), vec!["a", "b"]);
}

#[test]
fn wrap_text_splits_on_js_whitespace_only() {
    // U+FEFF is JS `\s`; U+0085 is not.
    assert_eq!(wrap_text("a\u{feff}b", 1, N), vec!["a", "b"]);
    assert_eq!(wrap_text("a\u{85}b", 10, N), vec!["a\u{85}b"]);
}

// --- wrapFragments ------------------------------------------------------------

#[test]
fn wrap_fragments_recovers_offsets() {
    let frags = wrap_fragments("pre abcdefghijklmnop post", 12, N);
    let got: Vec<(&str, Option<usize>)> =
        frags.iter().map(|f| (f.text.as_str(), f.start)).collect();
    assert_eq!(
        got,
        vec![
            ("pre", Some(0)),
            ("abcdefghijkl", Some(4)),
            ("mnop post", Some(16))
        ]
    );
    assert_eq!(frags[2].end, Some(25));
}

#[test]
fn wrap_fragments_offsets_are_utf16() {
    let frags = wrap_fragments("😀😀 ab", 4, N);
    assert_eq!(frags[0].start, Some(0));
    assert_eq!(frags[0].end, Some(4));
    assert_eq!(frags[1].start, Some(5));
}

#[test]
fn un_normalized_text_degrades_to_unlocated_fragments() {
    let frags = wrap_fragments("a   b", 1, N);
    assert_eq!(frags[0].start, Some(0));
    assert_eq!(frags[1].start, None);
    assert_eq!(frags[1].end, None);
}

// --- cellText -----------------------------------------------------------------

#[test]
fn cell_text_flattens_inline_markup() {
    let grid = build_table(
        &["A"],
        &[
            &["`bun run design:verify`"],
            &["**bold** and *em*"],
            &["a < b & c"],
        ],
    );
    let texts: Vec<&str> = grid.rows.iter().map(|r| r[0].text.as_str()).collect();
    assert_eq!(
        texts,
        vec!["bun run design:verify", "bold and em", "a < b & c"]
    );
    for row in &grid.rows {
        assert!(!row[0].text.contains('\u{1b}'));
        assert!(row[0].spans.is_empty());
    }
}

#[test]
fn cell_text_keeps_label_and_href() {
    let grid = build_table(&["A"], &[&["[label](https://example.test/x)"]]);
    assert_eq!(grid.rows[0][0].text, "label (https://example.test/x)");
}

#[test]
fn whitespace_collapses_and_trims() {
    assert_eq!(
        body_cell("| col |\n|---|\n|   a   b \t c   |\n").text,
        "a b c"
    );
}

#[test]
fn entities_decode_before_collapse() {
    assert_eq!(
        body_cell("| col |\n|---|\n| a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; |\n").text,
        "a & b <c> \"d\" 'e'"
    );
}

#[test]
fn decode_entities_is_one_pass() {
    assert_eq!(
        decode_entities("&amp;lt; &AMP; & &#39"),
        "&lt; &AMP; & &#39"
    );
}

#[test]
fn markup_with_href_carries_no_span() {
    let flat =
        body_cell("| col |\n|---|\n| **bold** and `code` and [l](https://example.test/x) |\n");
    assert_eq!(flat.text, "bold and code and l (https://example.test/x)");
    assert!(flat.spans.is_empty());
}

#[test]
fn wide_fixture_grid_carries_no_span() {
    let source = include_str!("../../../../tests/fixtures/wide-table.md");
    let grid = lex_table(source);
    for cell in grid.header.iter().chain(grid.rows.iter().flatten()) {
        assert!(cell.spans.is_empty());
        assert!(!cell.text.contains('\u{1b}'));
    }
}

#[test]
fn measurement_reads_text_only() {
    let bare = vec![content("alpha beta", vec![])];
    let spanned = vec![content("alpha beta", vec![wiki(0, 5)])];
    assert_eq!(
        natural_widths(&spanned, std::slice::from_ref(&spanned), N),
        natural_widths(&bare, std::slice::from_ref(&bare), N)
    );
}

#[test]
fn natural_widths_floor_at_one_and_measure_modes() {
    let header = vec![content("", vec![]), content("±±", vec![])];
    assert_eq!(natural_widths(&header, &[], N), vec![1, 2]);
    assert_eq!(natural_widths(&header, &[], WIDE_MEASURE), vec![1, 4]);
}

// --- the wiki-link producer -----------------------------------------------------

#[test]
fn bare_label_one_span() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[wiki-slug]] |\n"),
        content("wiki-slug", vec![wiki(0, 9)])
    );
}

#[test]
fn span_clipped_to_label_amid_prose() {
    assert_eq!(
        body_cell("| col |\n|---|\n| pre [[mid]] post |\n"),
        content("pre mid post", vec![wiki(4, 7)])
    );
}

#[test]
fn adjacent_labels_two_spans() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[a]][[bb]] |\n"),
        content("abb", vec![wiki(0, 1), wiki(1, 3)])
    );
}

#[test]
fn label_children_flatten() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[**bold** and `code`]] |\n"),
        content("bold and code", vec![wiki(0, 13)])
    );
    assert_eq!(
        body_cell("| col |\n|---|\n| [[https://example.test/p]] |\n"),
        content("https://example.test/p", vec![wiki(0, 22)])
    );
}

#[test]
fn embed_prefix_outside_span() {
    assert_eq!(
        body_cell("| col |\n|---|\n| ![[note]] |\n"),
        content("embed: note", vec![wiki(7, 11)])
    );
}

#[test]
fn c6b_offsets_survive_normalization() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[ b ]] |\n"),
        content("b", vec![wiki(0, 1)])
    );
    assert_eq!(
        body_cell("| col |\n|---|\n| [[a   b]] |\n"),
        content("a b", vec![wiki(0, 3)])
    );
    assert_eq!(
        body_cell("| col |\n|---|\n|   x   [[ a   b ]]   y   |\n"),
        content("x a b y", vec![wiki(2, 5)])
    );
}

#[test]
fn entities_around_label_offsets_post_decode() {
    assert_eq!(
        body_cell("| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n"),
        content("a & b <c>", vec![wiki(4, 5)])
    );
}

#[test]
fn empty_label_no_span() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[   ]] |\n"),
        content("", vec![])
    );
}

#[test]
fn grid_spans_are_exactly_labelled_cells() {
    let grid = lex_table("| [[h]] | plain |\n|---|---|\n| [[a]] | b |\n| c | [[d]] |\n");
    let counts: Vec<Vec<usize>> = std::iter::once(&grid.header)
        .chain(grid.rows.iter())
        .map(|row| row.iter().map(|c| c.spans.len()).collect())
        .collect();
    assert_eq!(counts, vec![vec![1, 0], vec![1, 0], vec![0, 1]]);
}

#[test]
fn spans_are_utf16_after_astral_text() {
    assert_eq!(
        body_cell("| col |\n|---|\n| 😀 [[x]] |\n"),
        content("😀 x", vec![wiki(3, 4)])
    );
}

// --- wikilink-table.test.ts, the grid half ------------------------------------------

#[test]
fn c6_edge_grid_texts() {
    let cases = [
        ("| col |\n|---|\n| [[a]] x |\n", "a x"),
        ("| col |\n|---|\n| [[a]][[b]] |\n", "ab"),
        ("| col |\n|---|\n| [[a   b]] |\n", "a b"),
        ("| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n", "a & b <c>"),
        ("| col |\n|---|\n| ![[note]] |\n", "embed: note"),
    ];
    for (source, text) in cases {
        assert_eq!(body_cell(source).text, text, "{source}");
    }
}

#[test]
fn d4_escaped_pipe_keeps_alias_unescaped_splits() {
    assert_eq!(
        body_cell("| col |\n|---|\n| [[s\\|Alias]] |\n"),
        content("Alias", vec![wiki(0, 5)])
    );
    let grid = lex_table("| a | b |\n|---|---|\n| [[s|Alias]] | y |\n");
    let texts: Vec<&str> = grid.rows[0].iter().map(|c| c.text.as_str()).collect();
    assert_eq!(texts, vec!["[[s", "Alias]]"]);
    assert!(grid.rows[0].iter().all(|c| c.spans.is_empty()));
}

#[test]
fn table_grid_pads_rows_and_defaults_alignment() {
    let grid = lex_table("| L | C | R | D |\n|:---|:---:|---:|---|\n| a |\n");
    assert_eq!(grid.column_count, 4);
    assert_eq!(
        grid.aligns,
        vec![Align::Left, Align::Center, Align::Right, Align::Left]
    );
    assert_eq!(grid.rows[0].len(), 4);
    assert_eq!(grid.rows[0][3], CellContent::default());
}

#[test]
fn flatten_falls_back_to_decoded_text() {
    assert_eq!(flatten_inline(&[], "  a &amp;  b ").text, "a & b");
}
