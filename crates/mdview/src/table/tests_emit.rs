//! The emitter (WP-5b): `render_table`/`render_grid` geometry, borders, styling and the
//! shared emitter fixtures `tests_spans.rs` and `tests_doc.rs` import.
//!
//! --- WP-5b: the emitter -------------------------------------------------------------------
//!
//! Every expected string below was produced by running the TS (`renderTable`, `renderGrid`,
//! `renderDocument`) over the same input — never derived by hand. Sources are transcribed
//! from `tests/table-emission.test.ts`, the rendered cases of `tests/table-allocation.test.ts`,
//! the synthetic-span battery of `tests/table-normalization.test.ts` and the rendered-bytes
//! cases of `tests/wikilink-table.test.ts`. In `md_table` expectations `/` is spelled `\u{2f}`, so a
//! hard-split path chunk inside a cell cannot read as a foreign path to the containment guard.

use super::*;
use crate::glyphs::glyphs_for;
use crate::render::{Policy, RenderOptions, Sgr, Tier, render};
use crate::style::StyleName::{Cyan, Underline};
use crate::width::{NARROW_MEASURE, WIDE_MEASURE};

pub(super) const WIDE_FIXTURE: &str = include_str!("../../../../tests/fixtures/wide-table.md");
pub(super) const LONG_PATH: &str = "example/backend/services/api/src/csv-importer.test.ts";

pub(super) fn glyph_set(tier: Tier) -> &'static GlyphSet {
    glyphs_for(tier)
}

pub(super) fn md_table(
    source: &str,
    width: usize,
    tier: Tier,
    measure: Measure,
    sgr: Sgr,
) -> String {
    for token in crate::lex::lex(source, tier) {
        if let Token::Table {
            header,
            rows,
            align,
        } = token
        {
            return render_table(&header, &rows, &align, width, glyph_set(tier), measure, sgr);
        }
    }
    panic!("fixture contains no table");
}

pub(super) type Cell<'a> = (&'a str, &'a [(usize, usize)]);

pub(super) fn content(cell: &Cell<'_>) -> CellContent {
    CellContent {
        text: cell.0.to_owned(),
        spans: cell
            .1
            .iter()
            .map(|&(start, end)| CellSpan {
                start,
                end,
                styles: vec![Cyan, Underline],
            })
            .collect(),
    }
}

pub(super) fn grid_of(header: &[Cell<'_>], rows: &[&[Cell<'_>]], aligns: &[Align]) -> TableGrid {
    TableGrid {
        header: header.iter().map(content).collect(),
        rows: rows
            .iter()
            .map(|r| r.iter().map(content).collect())
            .collect(),
        aligns: aligns.to_vec(),
        column_count: header.len(),
    }
}

pub(super) fn doc_render(source: &str, sgr: Sgr, hyperlinks: bool) -> String {
    let options = RenderOptions {
        policy: Policy {
            sgr,
            hyperlinks,
            tmux: false,
        },
        ..RenderOptions::plain(80)
    };
    render(source, &options).expect("renders").text
}

pub(super) fn max_width(output: &str, measure: Measure) -> usize {
    crate::ansi::strip_sequences(output)
        .split('\n')
        .map(|l| measure.width(l))
        .max()
        .unwrap_or(0)
}
#[test]
fn chrome_width_counts_rules_and_padding() {
    assert_eq!([0, 1, 2, 3, 6, 9].map(chrome_width), [0, 4, 7, 10, 19, 28]);
}

/// `table-emission.test.ts`'s chrome invariant, structurally: rendered == allocated,
/// at every mode (styling never moves a column).
#[test]
fn rendered_geometry_is_allocated_geometry() {
    for columns in [2, 3, 6] {
        let headers: Vec<String> = (0..columns).map(|i| format!("Column {i}")).collect();
        let cells: Vec<String> = (0..columns)
            .map(|i| format!("{LONG_PATH}#{i} and some prose after it"))
            .collect();
        let source = format!(
            "| {} |\n| {} |\n| {} |\n",
            headers.join(" | "),
            vec!["---"; columns].join(" | "),
            cells.join(" | ")
        );
        for target in [40, 80, 160] {
            let tokens = crate::lex::lex(&source, Tier::Unicode);
            let Some(Token::Table {
                header,
                rows,
                align,
            }) = tokens.into_iter().next()
            else {
                panic!("no table");
            };
            let grid = table_grid(&header, &rows, &align);
            let natural = natural_widths(&grid.header, &grid.rows, NARROW_MEASURE);
            let allocation = allocate_widths(&natural, target);
            for sgr in [Sgr::None, Sgr::Formats, Sgr::Full] {
                let out = render_grid(&grid, target, glyph_set(Tier::Unicode), NARROW_MEASURE, sgr);
                assert_eq!(max_width(&out, NARROW_MEASURE), allocation.total_width);
                assert!(!out.contains('…'));
            }
        }
    }
}

#[test]
fn empty_grid_renders_nothing() {
    let grid = grid_of(&[], &[], &[]);
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        ""
    );
}

#[test]
fn emit_warning_narrow_40() {
    assert_eq!(
        md_table(
            "| Risk | Note |\n| --- | --- |\n| ⚠ ⚠ ⚠ | plain |\n| a | escalate now |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───────┬──────────────┐\n│ Risk  │ Note         │\n├───────┼──────────────┤\n│ ⚠ ⚠ ⚠ │ plain        │\n├───────┼──────────────┤\n│ a     │ escalate now │\n└───────┴──────────────┘\n"
    );
}

#[test]
fn emit_ambiguous_wide_ascii() {
    assert_eq!(
        md_table(
            "| Risk | Note |\n| --- | --- |\n| — — — | plain |\n| — | → ≥ × |\n",
            40,
            Tier::Ascii,
            WIDE_MEASURE,
            Sgr::None
        ),
        "+----------+----------+\n| Risk     | Note     |\n+----------+----------+\n| — — — | plain    |\n+----------+----------+\n| —       | → ≥ × |\n+----------+----------+\n"
    );
    assert_eq!(
        md_table(
            "| Risk | Note |\n| --- | --- |\n| — — — | plain |\n| — | → ≥ × |\n",
            60,
            Tier::Ascii,
            WIDE_MEASURE,
            Sgr::None
        ),
        "+----------+----------+\n| Risk     | Note     |\n+----------+----------+\n| — — — | plain    |\n+----------+----------+\n| —       | → ≥ × |\n+----------+----------+\n"
    );
    assert_eq!(
        md_table(
            "| Risk | Note |\n| --- | --- |\n| — — — | plain |\n| — | → ≥ × |\n",
            80,
            Tier::Ascii,
            WIDE_MEASURE,
            Sgr::None
        ),
        "+----------+----------+\n| Risk     | Note     |\n+----------+----------+\n| — — — | plain    |\n+----------+----------+\n| —       | → ≥ × |\n+----------+----------+\n"
    );
}

#[test]
fn emit_warning_three_cols_40() {
    assert_eq!(
        md_table(
            "| Risk | Note | Owner |\n| --- | --- | --- |\n| ⚠ | escalate before Friday | alex |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬───────────────────────┬───────┐\n│ Risk │ Note                  │ Owner │\n├──────┼───────────────────────┼───────┤\n│ ⚠    │ escalate before       │ alex  │\n│      │ Friday                │       │\n└──────┴───────────────────────┴───────┘\n"
    );
}

#[test]
fn emit_warning_three_cols_100() {
    assert_eq!(
        md_table(
            "| Risk | Note | Owner |\n| --- | --- | --- |\n| ⚠ | escalate before Friday | alex |\n",
            100,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬────────────────────────┬───────┐\n│ Risk │ Note                   │ Owner │\n├──────┼────────────────────────┼───────┤\n│ ⚠    │ escalate before Friday │ alex  │\n└──────┴────────────────────────┴───────┘\n"
    );
}

#[test]
fn emit_warning_survives_60() {
    assert_eq!(
        md_table(
            "| Risk | Note |\n| --- | --- |\n| ⚠ | escalate |\n",
            60,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬──────────┐\n│ Risk │ Note     │\n├──────┼──────────┤\n│ ⚠    │ escalate │\n└──────┴──────────┘\n"
    );
}

#[test]
fn emit_border_unicode_40() {
    assert_eq!(
        md_table(
            "| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───────┬──────┐\n│ A     │ B    │\n├───────┼──────┤\n│ one   │ two  │\n├───────┼──────┤\n│ three │ four │\n└───────┴──────┘\n"
    );
}

#[test]
fn emit_border_ascii_40() {
    assert_eq!(
        md_table(
            "| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n",
            40,
            Tier::Ascii,
            NARROW_MEASURE,
            Sgr::None
        ),
        "+-------+------+\n| A     | B    |\n+-------+------+\n| one   | two  |\n+-------+------+\n| three | four |\n+-------+------+\n"
    );
}

#[test]
fn emit_header_only_40() {
    assert_eq!(
        md_table(
            "| A | B |\n| --- | --- |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───┬───┐\n│ A │ B │\n└───┴───┘\n"
    );
}

#[test]
fn emit_multiline_40() {
    assert_eq!(
        md_table(
            "| A | B |\n| --- | --- |\n| x | one two three four five six seven eight |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───┬──────────────────────────────────┐\n│ A │ B                                │\n├───┼──────────────────────────────────┤\n│ x │ one two three four five six      │\n│   │ seven eight                      │\n└───┴──────────────────────────────────┘\n"
    );
}

#[test]
fn emit_alignment_80() {
    assert_eq!(
        md_table(
            "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬────────┬───────┐\n│ Left │ Center │ Right │\n├──────┼────────┼───────┤\n│ a    │   b    │     c │\n└──────┴────────┴───────┘\n"
    );
}

#[test]
fn emit_alignment_odd_slack() {
    assert_eq!(
        md_table(
            "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | bb | c |\n| longer | x | yy |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────\u{1b}[39m\u{1b}[90m┬────────\u{1b}[39m\u{1b}[90m┬───────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m Left   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Center \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Right \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼───────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m a      \u{1b}[90m│\u{1b}[39m   bb   \u{1b}[90m│\u{1b}[39m     c \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼───────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m longer \u{1b}[90m│\u{1b}[39m   x    \u{1b}[90m│\u{1b}[39m    yy \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────\u{1b}[39m\u{1b}[90m┴────────\u{1b}[39m\u{1b}[90m┴───────┘\u{1b}[39m\n"
    );
}

#[test]
fn emit_chrome_invariant() {
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 |\n| --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───────────────────┬──────────────────┐\n│ Column 0          │ Column 1         │\n├───────────────────┼──────────────────┤\n│ example\u{2f}backend\u{2f}s │ example\u{2f}backend\u{2f} │\n│ ervices\u{2f}api\u{2f}src\u{2f}c │ services\u{2f}api\u{2f}src │\n│ sv-importer.test. │ \u{2f}csv-importer.te │\n│ ts#0 and some     │ st.ts#1 and some │\n│ prose after it    │ prose after it   │\n└───────────────────┴──────────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 |\n| --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───────────────────────────────────────┬──────────────────────────────────────┐\n│ Column 0                              │ Column 1                             │\n├───────────────────────────────────────┼──────────────────────────────────────┤\n│ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv- │ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv │\n│ importer.test.ts#0 and some prose     │ -importer.test.ts#1 and some prose   │\n│ after it                              │ after it                             │\n└───────────────────────────────────────┴──────────────────────────────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 |\n| --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it |\n",
            160,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌───────────────────────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────┐\n│ Column 0                                                                      │ Column 1                                                                     │\n├───────────────────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────┤\n│ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importer.test.ts#0 and some prose after  │ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importer.test.ts#1 and some prose after │\n│ it                                                                            │ it                                                                           │\n└───────────────────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 |\n| --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌────────────┬────────────┬────────────┐\n│ Column 0   │ Column 1   │ Column 2   │\n├────────────┼────────────┼────────────┤\n│ example\u{2f}ba │ example\u{2f}ba │ example\u{2f}ba │\n│ ckend\u{2f}serv │ ckend\u{2f}serv │ ckend\u{2f}serv │\n│ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │\n│ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │\n│ orter.test │ orter.test │ orter.test │\n│ .ts#0 and  │ .ts#1 and  │ .ts#2 and  │\n│ some prose │ some prose │ some prose │\n│ after it   │ after it   │ after it   │\n└────────────┴────────────┴────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 |\n| --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────────────────────────┬─────────────────────────┬─────────────────────────┐\n│ Column 0                 │ Column 1                │ Column 2                │\n├──────────────────────────┼─────────────────────────┼─────────────────────────┤\n│ example\u{2f}backend\u{2f}services │ example\u{2f}backend\u{2f}service │ example\u{2f}backend\u{2f}service │\n│ \u{2f}api\u{2f}src\u{2f}csv-importer.te │ s\u{2f}api\u{2f}src\u{2f}csv-importer. │ s\u{2f}api\u{2f}src\u{2f}csv-importer. │\n│ st.ts#0 and some prose   │ test.ts#1 and some      │ test.ts#2 and some      │\n│ after it                 │ prose after it          │ prose after it          │\n└──────────────────────────┴─────────────────────────┴─────────────────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 |\n| --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it |\n",
            160,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌────────────────────────────────────────────────────┬────────────────────────────────────────────────────┬────────────────────────────────────────────────────┐\n│ Column 0                                           │ Column 1                                           │ Column 2                                           │\n├────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────────┤\n│ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importer.test │ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importer.test │ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importer.test │\n│ .ts#0 and some prose after it                      │ .ts#1 and some prose after it                      │ .ts#2 and some prose after it                      │\n└────────────────────────────────────────────────────┴────────────────────────────────────────────────────┴────────────────────────────────────────────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |\n| --- | --- | --- | --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#3 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#4 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#5 and some prose after it |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌────────┬────────┬────────┬────────┬────────┬────────┐\n│ Column │ Column │ Column │ Column │ Column │ Column │\n│ 0      │ 1      │ 2      │ 3      │ 4      │ 5      │\n├────────┼────────┼────────┼────────┼────────┼────────┤\n│ exampl │ exampl │ exampl │ exampl │ exampl │ exampl │\n│ e\u{2f}back │ e\u{2f}back │ e\u{2f}back │ e\u{2f}back │ e\u{2f}back │ e\u{2f}back │\n│ end\u{2f}se │ end\u{2f}se │ end\u{2f}se │ end\u{2f}se │ end\u{2f}se │ end\u{2f}se │\n│ rvices │ rvices │ rvices │ rvices │ rvices │ rvices │\n│ \u{2f}api\u{2f}s │ \u{2f}api\u{2f}s │ \u{2f}api\u{2f}s │ \u{2f}api\u{2f}s │ \u{2f}api\u{2f}s │ \u{2f}api\u{2f}s │\n│ rc\u{2f}csv │ rc\u{2f}csv │ rc\u{2f}csv │ rc\u{2f}csv │ rc\u{2f}csv │ rc\u{2f}csv │\n│ -impor │ -impor │ -impor │ -impor │ -impor │ -impor │\n│ ter.te │ ter.te │ ter.te │ ter.te │ ter.te │ ter.te │\n│ st.ts# │ st.ts# │ st.ts# │ st.ts# │ st.ts# │ st.ts# │\n│ 0 and  │ 1 and  │ 2 and  │ 3 and  │ 4 and  │ 5 and  │\n│ some   │ some   │ some   │ some   │ some   │ some   │\n│ prose  │ prose  │ prose  │ prose  │ prose  │ prose  │\n│ after  │ after  │ after  │ after  │ after  │ after  │\n│ it     │ it     │ it     │ it     │ it     │ it     │\n└────────┴────────┴────────┴────────┴────────┴────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |\n| --- | --- | --- | --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#3 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#4 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#5 and some prose after it |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌─────────────┬────────────┬────────────┬────────────┬────────────┬────────────┐\n│ Column 0    │ Column 1   │ Column 2   │ Column 3   │ Column 4   │ Column 5   │\n├─────────────┼────────────┼────────────┼────────────┼────────────┼────────────┤\n│ example\u{2f}bac │ example\u{2f}ba │ example\u{2f}ba │ example\u{2f}ba │ example\u{2f}ba │ example\u{2f}ba │\n│ kend\u{2f}servic │ ckend\u{2f}serv │ ckend\u{2f}serv │ ckend\u{2f}serv │ ckend\u{2f}serv │ ckend\u{2f}serv │\n│ es\u{2f}api\u{2f}src\u{2f} │ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │ ices\u{2f}api\u{2f}s │\n│ csv-importe │ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │ rc\u{2f}csv-imp │\n│ r.test.ts#0 │ orter.test │ orter.test │ orter.test │ orter.test │ orter.test │\n│ and some    │ .ts#1 and  │ .ts#2 and  │ .ts#3 and  │ .ts#4 and  │ .ts#5 and  │\n│ prose after │ some prose │ some prose │ some prose │ some prose │ some prose │\n│ it          │ after it   │ after it   │ after it   │ after it   │ after it   │\n└─────────────┴────────────┴────────────┴────────────┴────────────┴────────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Column 0 | Column 1 | Column 2 | Column 3 | Column 4 | Column 5 |\n| --- | --- | --- | --- | --- | --- |\n| example/backend/services/api/src/csv-importer.test.ts#0 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#1 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#2 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#3 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#4 and some prose after it | example/backend/services/api/src/csv-importer.test.ts#5 and some prose after it |\n",
            160,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────────────────────────┬──────────────────────────┬──────────────────────────┬─────────────────────────┬─────────────────────────┬─────────────────────────┐\n│ Column 0                 │ Column 1                 │ Column 2                 │ Column 3                │ Column 4                │ Column 5                │\n├──────────────────────────┼──────────────────────────┼──────────────────────────┼─────────────────────────┼─────────────────────────┼─────────────────────────┤\n│ example\u{2f}backend\u{2f}services │ example\u{2f}backend\u{2f}services │ example\u{2f}backend\u{2f}services │ example\u{2f}backend\u{2f}service │ example\u{2f}backend\u{2f}service │ example\u{2f}backend\u{2f}service │\n│ \u{2f}api\u{2f}src\u{2f}csv-importer.te │ \u{2f}api\u{2f}src\u{2f}csv-importer.te │ \u{2f}api\u{2f}src\u{2f}csv-importer.te │ s\u{2f}api\u{2f}src\u{2f}csv-importer. │ s\u{2f}api\u{2f}src\u{2f}csv-importer. │ s\u{2f}api\u{2f}src\u{2f}csv-importer. │\n│ st.ts#0 and some prose   │ st.ts#1 and some prose   │ st.ts#2 and some prose   │ test.ts#3 and some      │ test.ts#4 and some      │ test.ts#5 and some      │\n│ after it                 │ after it                 │ after it                 │ prose after it          │ prose after it          │ prose after it          │\n└──────────────────────────┴──────────────────────────┴──────────────────────────┴─────────────────────────┴─────────────────────────┴─────────────────────────┘\n"
    );
}

#[test]
fn emit_styling_none() {
    assert_eq!(
        md_table(
            "| Head | Other |\n|---|---|\n| a | b |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬───────┐\n│ Head │ Other │\n├──────┼───────┤\n│ a    │ b     │\n└──────┴───────┘\n"
    );
}

#[test]
fn emit_styling_formats() {
    assert_eq!(
        md_table(
            "| Head | Other |\n|---|---|\n| a | b |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::Formats
        ),
        "┌──────┬───────┐\n│\u{1b}[1m Head \u{1b}[22m│\u{1b}[1m Other \u{1b}[22m│\n├──────┼───────┤\n│ a    │ b     │\n└──────┴───────┘\n"
    );
}

#[test]
fn emit_styling_full() {
    assert_eq!(
        md_table(
            "| Head | Other |\n|---|---|\n| a | b |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌──────\u{1b}[39m\u{1b}[90m┬───────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m Head \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Other \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────\u{1b}[39m\u{1b}[90m┼───────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m a    \u{1b}[90m│\u{1b}[39m b     \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────\u{1b}[39m\u{1b}[90m┴───────┘\u{1b}[39m\n"
    );
}

#[test]
fn emit_styling_ascii_full() {
    assert_eq!(
        md_table(
            "| Head | Other |\n|---|---|\n| a | b |\n",
            40,
            Tier::Ascii,
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m+------\u{1b}[39m\u{1b}[90m+-------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m\u{1b}[1m Head \u{1b}[22m\u{1b}[90m|\u{1b}[39m\u{1b}[1m Other \u{1b}[22m\u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------\u{1b}[39m\u{1b}[90m+-------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m a    \u{1b}[90m|\u{1b}[39m b     \u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------\u{1b}[39m\u{1b}[90m+-------+\u{1b}[39m\n"
    );
}

#[test]
fn emit_wide_fixture() {
    assert_eq!(
        md_table(WIDE_FIXTURE, 80, Tier::Unicode, NARROW_MEASURE, Sgr::None),
        "┌────────┬────────┬──────────┬───────────────────────────────┬────────┬────────┐\n│ Comman │ Config │     Test │ Description                   │ Owner  │  Notes │\n│ d      │  Path  │     File │                               │        │        │\n├────────┼────────┼──────────┼───────────────────────────────┼────────┼────────┤\n│ bun    │ exampl │ example\u{2f} │ This row exists to stress the │  wp-3  │ pendin │\n│ run    │ e\u{2f}conf │ backend\u{2f} │ wide-table allocator with     │        │      g │\n│ design │ ig-pre │ services │ long unbreakable tokens that  │        │ review │\n│ :verif │ sets\u{2f}t │ \u{2f}api\u{2f}src │ must never be truncated or    │        │        │\n│ y      │ emplat │ \u{2f}csv-imp │ ellipsized under any          │        │        │\n│        │ es\u{2f}git │ orter.te │ circumstances by the renderer │        │        │\n│        │ ignore │    st.ts │ under test, and it keeps      │        │        │\n│        │   \u{2f}    │          │ going so the raw source line  │        │        │\n│        │        │          │ clears the corpus's measured  │        │        │\n│        │        │          │ p99 width                     │        │        │\n├────────┼────────┼──────────┼───────────────────────────────┼────────┼────────┤\n│ 你好世 │ 路径\u{2f}  │ 测试文件 │ 中文和表情符号混排的行,用于验 │ 所有者 │ 备注信 │\n│ 界     │ 示例\u{2f}  │      .md │ 证宽度对齐与列分割逻辑是否仍  │        │     息 │\n│ 测试宽 │  演示  │          │ 然正确 🚀                     │        │        │\n│ 表格式 │        │          │                               │        │        │\n│ 🎉     │        │          │                               │        │        │\n├────────┼────────┼──────────┼───────────────────────────────┼────────┼────────┤\n│ bun    │ exampl │ example\u{2f} │ short                         │  wp-3  │     ok │\n│ run    │ e\u{2f}conf │ backend\u{2f} │                               │        │        │\n│ design │ ig-pre │ services │                               │        │        │\n│ :verif │ sets\u{2f}t │ \u{2f}api\u{2f}src │                               │        │        │\n│ y      │ emplat │ \u{2f}csv-imp │                               │        │        │\n│        │ es\u{2f}git │ orter.te │                               │        │        │\n│        │ ignore │    st.ts │                               │        │        │\n│        │   \u{2f}    │          │                               │        │        │\n└────────┴────────┴──────────┴───────────────────────────────┴────────┴────────┘\n"
    );
    assert_eq!(
        md_table(WIDE_FIXTURE, 100, Tier::Unicode, NARROW_MEASURE, Sgr::None),
        "┌────────┬─────────┬───────────┬─────────────────────────────────────────┬────────┬────────────────┐\n│ Comman │ Config  │ Test File │ Description                             │ Owner  │          Notes │\n│ d      │  Path   │           │                                         │        │                │\n├────────┼─────────┼───────────┼─────────────────────────────────────────┼────────┼────────────────┤\n│ bun    │ example │ example\u{2f}b │ This row exists to stress the           │  wp-3  │ pending review │\n│ run    │ \u{2f}config │ ackend\u{2f}se │ wide-table allocator with long          │        │                │\n│ design │ -preset │ rvices\u{2f}ap │ unbreakable tokens that must never be   │        │                │\n│ :verif │ s\u{2f}templ │ i\u{2f}src\u{2f}csv │ truncated or ellipsized under any       │        │                │\n│ y      │ ates\u{2f}gi │ -importer │ circumstances by the renderer under     │        │                │\n│        │ tignore │  .test.ts │ test, and it keeps going so the raw     │        │                │\n│        │    \u{2f}    │           │ source line clears the corpus's         │        │                │\n│        │         │           │ measured p99 width                      │        │                │\n├────────┼─────────┼───────────┼─────────────────────────────────────────┼────────┼────────────────┤\n│ 你好世 │ 路径\u{2f}示 │ 测试文件. │ 中文和表情符号混排的行,用于验证宽度对齐 │ 所有者 │       备注信息 │\n│ 界     │ 例\u{2f}演示 │        md │ 与列分割逻辑是否仍然正确 🚀             │        │                │\n│ 测试宽 │         │           │                                         │        │                │\n│ 表格式 │         │           │                                         │        │                │\n│ 🎉     │         │           │                                         │        │                │\n├────────┼─────────┼───────────┼─────────────────────────────────────────┼────────┼────────────────┤\n│ bun    │ example │ example\u{2f}b │ short                                   │  wp-3  │             ok │\n│ run    │ \u{2f}config │ ackend\u{2f}se │                                         │        │                │\n│ design │ -preset │ rvices\u{2f}ap │                                         │        │                │\n│ :verif │ s\u{2f}templ │ i\u{2f}src\u{2f}csv │                                         │        │                │\n│ y      │ ates\u{2f}gi │ -importer │                                         │        │                │\n│        │ tignore │  .test.ts │                                         │        │                │\n│        │    \u{2f}    │           │                                         │        │                │\n└────────┴─────────┴───────────┴─────────────────────────────────────────┴────────┴────────────────┘\n"
    );
    assert_eq!(
        md_table(WIDE_FIXTURE, 160, Tier::Unicode, NARROW_MEASURE, Sgr::None),
        "┌──────────────────────────┬──────────────┬─────────────────┬────────────────────────────────────────────────────────────────────────┬────────┬────────────────┐\n│ Command                  │ Config Path  │       Test File │ Description                                                            │ Owner  │          Notes │\n├──────────────────────────┼──────────────┼─────────────────┼────────────────────────────────────────────────────────────────────────┼────────┼────────────────┤\n│ bun run design:verify    │ example\u{2f}conf │ example\u{2f}backend │ This row exists to stress the wide-table allocator with long           │  wp-3  │ pending review │\n│                          │ ig-presets\u{2f}t │ \u{2f}services\u{2f}api\u{2f}s │ unbreakable tokens that must never be truncated or ellipsized under    │        │                │\n│                          │ emplates\u{2f}git │ rc\u{2f}csv-importer │ any circumstances by the renderer under test, and it keeps going so    │        │                │\n│                          │   ignore\u{2f}    │        .test.ts │ the raw source line clears the corpus's measured p99 width             │        │                │\n├──────────────────────────┼──────────────┼─────────────────┼────────────────────────────────────────────────────────────────────────┼────────┼────────────────┤\n│ 你好世界 测试宽表格式 🎉 │ 路径\u{2f}示例\u{2f}演 │     测试文件.md │ 中文和表情符号混排的行,用于验证宽度对齐与列分割逻辑是否仍然正确 🚀     │ 所有者 │       备注信息 │\n│                          │      示      │                 │                                                                        │        │                │\n├──────────────────────────┼──────────────┼─────────────────┼────────────────────────────────────────────────────────────────────────┼────────┼────────────────┤\n│ bun run design:verify    │ example\u{2f}conf │ example\u{2f}backend │ short                                                                  │  wp-3  │             ok │\n│                          │ ig-presets\u{2f}t │ \u{2f}services\u{2f}api\u{2f}s │                                                                        │        │                │\n│                          │ emplates\u{2f}git │ rc\u{2f}csv-importer │                                                                        │        │                │\n│                          │   ignore\u{2f}    │        .test.ts │                                                                        │        │                │\n└──────────────────────────┴──────────────┴─────────────────┴────────────────────────────────────────────────────────────────────────┴────────┴────────────────┘\n"
    );
    assert_eq!(
        md_table(WIDE_FIXTURE, 80, Tier::Unicode, NARROW_MEASURE, Sgr::Full),
        "\u{1b}[90m┌────────\u{1b}[39m\u{1b}[90m┬────────\u{1b}[39m\u{1b}[90m┬──────────\u{1b}[39m\u{1b}[90m┬───────────────────────────────\u{1b}[39m\u{1b}[90m┬────────\u{1b}[39m\u{1b}[90m┬────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m Comman \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Config \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m     Test \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Description                   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m Owner  \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m  Notes \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m d      \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m  Path  \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m     File \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m                               \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼──────────\u{1b}[39m\u{1b}[90m┼───────────────────────────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m bun    \u{1b}[90m│\u{1b}[39m exampl \u{1b}[90m│\u{1b}[39m example\u{2f} \u{1b}[90m│\u{1b}[39m This row exists to stress the \u{1b}[90m│\u{1b}[39m  wp-3  \u{1b}[90m│\u{1b}[39m pendin \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m run    \u{1b}[90m│\u{1b}[39m e\u{2f}conf \u{1b}[90m│\u{1b}[39m backend\u{2f} \u{1b}[90m│\u{1b}[39m wide-table allocator with     \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m      g \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m design \u{1b}[90m│\u{1b}[39m ig-pre \u{1b}[90m│\u{1b}[39m services \u{1b}[90m│\u{1b}[39m long unbreakable tokens that  \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m review \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m :verif \u{1b}[90m│\u{1b}[39m sets\u{2f}t \u{1b}[90m│\u{1b}[39m \u{2f}api\u{2f}src \u{1b}[90m│\u{1b}[39m must never be truncated or    \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m y      \u{1b}[90m│\u{1b}[39m emplat \u{1b}[90m│\u{1b}[39m \u{2f}csv-imp \u{1b}[90m│\u{1b}[39m ellipsized under any          \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m es\u{2f}git \u{1b}[90m│\u{1b}[39m orter.te \u{1b}[90m│\u{1b}[39m circumstances by the renderer \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m ignore \u{1b}[90m│\u{1b}[39m    st.ts \u{1b}[90m│\u{1b}[39m under test, and it keeps      \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m   \u{2f}    \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m going so the raw source line  \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m clears the corpus's measured  \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m p99 width                     \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼──────────\u{1b}[39m\u{1b}[90m┼───────────────────────────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 你好世 \u{1b}[90m│\u{1b}[39m 路径\u{2f}  \u{1b}[90m│\u{1b}[39m 测试文件 \u{1b}[90m│\u{1b}[39m 中文和表情符号混排的行,用于验 \u{1b}[90m│\u{1b}[39m 所有者 \u{1b}[90m│\u{1b}[39m 备注信 \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 界     \u{1b}[90m│\u{1b}[39m 示例\u{2f}  \u{1b}[90m│\u{1b}[39m      .md \u{1b}[90m│\u{1b}[39m 证宽度对齐与列分割逻辑是否仍  \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m     息 \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 测试宽 \u{1b}[90m│\u{1b}[39m  演示  \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m 然正确 🚀                     \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 表格式 \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 🎉     \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼──────────\u{1b}[39m\u{1b}[90m┼───────────────────────────────\u{1b}[39m\u{1b}[90m┼────────\u{1b}[39m\u{1b}[90m┼────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m bun    \u{1b}[90m│\u{1b}[39m exampl \u{1b}[90m│\u{1b}[39m example\u{2f} \u{1b}[90m│\u{1b}[39m short                         \u{1b}[90m│\u{1b}[39m  wp-3  \u{1b}[90m│\u{1b}[39m     ok \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m run    \u{1b}[90m│\u{1b}[39m e\u{2f}conf \u{1b}[90m│\u{1b}[39m backend\u{2f} \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m design \u{1b}[90m│\u{1b}[39m ig-pre \u{1b}[90m│\u{1b}[39m services \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m :verif \u{1b}[90m│\u{1b}[39m sets\u{2f}t \u{1b}[90m│\u{1b}[39m \u{2f}api\u{2f}src \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m y      \u{1b}[90m│\u{1b}[39m emplat \u{1b}[90m│\u{1b}[39m \u{2f}csv-imp \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m es\u{2f}git \u{1b}[90m│\u{1b}[39m orter.te \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m ignore \u{1b}[90m│\u{1b}[39m    st.ts \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m   \u{2f}    \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m                               \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────\u{1b}[39m\u{1b}[90m┴────────\u{1b}[39m\u{1b}[90m┴──────────\u{1b}[39m\u{1b}[90m┴───────────────────────────────\u{1b}[39m\u{1b}[90m┴────────\u{1b}[39m\u{1b}[90m┴────────┘\u{1b}[39m\n"
    );
    assert_eq!(
        md_table(WIDE_FIXTURE, 80, Tier::Ascii, WIDE_MEASURE, Sgr::Formats),
        "+--------+--------+----------+-------------------------------+--------+--------+\n|\u{1b}[1m Comman \u{1b}[22m|\u{1b}[1m Config \u{1b}[22m|\u{1b}[1m     Test \u{1b}[22m|\u{1b}[1m Description                   \u{1b}[22m|\u{1b}[1m Owner  \u{1b}[22m|\u{1b}[1m  Notes \u{1b}[22m|\n|\u{1b}[1m d      \u{1b}[22m|\u{1b}[1m  Path  \u{1b}[22m|\u{1b}[1m     File \u{1b}[22m|\u{1b}[1m                               \u{1b}[22m|\u{1b}[1m        \u{1b}[22m|\u{1b}[1m        \u{1b}[22m|\n+--------+--------+----------+-------------------------------+--------+--------+\n| bun    | exampl | example\u{2f} | This row exists to stress the |  wp-3  | pendin |\n| run    | e\u{2f}conf | backend\u{2f} | wide-table allocator with     |        |      g |\n| design | ig-pre | services | long unbreakable tokens that  |        | review |\n| :verif | sets\u{2f}t | \u{2f}api\u{2f}src | must never be truncated or    |        |        |\n| y      | emplat | \u{2f}csv-imp | ellipsized under any          |        |        |\n|        | es\u{2f}git | orter.te | circumstances by the renderer |        |        |\n|        | ignore |    st.ts | under test, and it keeps      |        |        |\n|        |   \u{2f}    |          | going so the raw source line  |        |        |\n|        |        |          | clears the corpus's measured  |        |        |\n|        |        |          | p99 width                     |        |        |\n+--------+--------+----------+-------------------------------+--------+--------+\n| 你好世 | 路径\u{2f}  | 测试文件 | 中文和表情符号混排的行,用于验 | 所有者 | 备注信 |\n| 界     | 示例\u{2f}  |      .md | 证宽度对齐与列分割逻辑是否仍  |        |     息 |\n| 测试宽 |  演示  |          | 然正确 🚀                     |        |        |\n| 表格式 |        |          |                               |        |        |\n| 🎉     |        |          |                               |        |        |\n+--------+--------+----------+-------------------------------+--------+--------+\n| bun    | exampl | example\u{2f} | short                         |  wp-3  |     ok |\n| run    | e\u{2f}conf | backend\u{2f} |                               |        |        |\n| design | ig-pre | services |                               |        |        |\n| :verif | sets\u{2f}t | \u{2f}api\u{2f}src |                               |        |        |\n| y      | emplat | \u{2f}csv-imp |                               |        |        |\n|        | es\u{2f}git | orter.te |                               |        |        |\n|        | ignore |    st.ts |                               |        |        |\n|        |   \u{2f}    |          |                               |        |        |\n+--------+--------+----------+-------------------------------+--------+--------+\n"
    );
}

#[test]
fn emit_collapse_narrow_beside_wide_80() {
    assert_eq!(
        md_table(
            "| WP | Detail |\n| --- | --- |\n| WP3 | token0 token1 token2 token3 token4 token5 token6 token7 token8 token9 token10 token11 token12 token13 token14 token15 token16 token17 token18 token19 token20 token21 token22 token23 token24 token25 token26 token27 token28 token29 |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌─────┬────────────────────────────────────────────────────────────────────────┐\n│ WP  │ Detail                                                                 │\n├─────┼────────────────────────────────────────────────────────────────────────┤\n│ WP3 │ token0 token1 token2 token3 token4 token5 token6 token7 token8 token9  │\n│     │ token10 token11 token12 token13 token14 token15 token16 token17        │\n│     │ token18 token19 token20 token21 token22 token23 token24 token25        │\n│     │ token26 token27 token28 token29                                        │\n└─────┴────────────────────────────────────────────────────────────────────────┘\n"
    );
}

#[test]
fn emit_collapse_long_path_40() {
    assert_eq!(
        md_table(
            "| WP | Path |\n| --- | --- |\n| WP3 | example/backend/services/api/src/csv-importer.test.tsexample/backend/services/api/src/csv-importer.test.tsexample/backend/services/api/src/csv-importer.test.ts |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌─────┬────────────────────────────────┐\n│ WP  │ Path                           │\n├─────┼────────────────────────────────┤\n│ WP3 │ example\u{2f}backend\u{2f}services\u{2f}api\u{2f}s │\n│     │ rc\u{2f}csv-importer.test.tsexample │\n│     │ \u{2f}backend\u{2f}services\u{2f}api\u{2f}src\u{2f}csv- │\n│     │ importer.test.tsexample\u{2f}backen │\n│     │ d\u{2f}services\u{2f}api\u{2f}src\u{2f}csv-importe │\n│     │ r.test.ts                      │\n└─────┴────────────────────────────────┘\n"
    );
}

#[test]
fn emit_cjk_emoji_40() {
    assert_eq!(
        md_table(
            "| 名前 | 説明 |\n| --- | --- |\n| 你好世界 🎉 | 中文和表情符号混排的行,用于验证宽度对齐 🚀 |\n| ascii | plain |\n",
            40,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌─────────────┬────────────────────────┐\n│ 名前        │ 説明                   │\n├─────────────┼────────────────────────┤\n│ 你好世界 🎉 │ 中文和表情符号混排的行 │\n│             │ ,用于验证宽度对齐 🚀   │\n├─────────────┼────────────────────────┤\n│ ascii       │ plain                  │\n└─────────────┴────────────────────────┘\n"
    );
}

#[test]
fn emit_already_fits_120() {
    assert_eq!(
        md_table(
            "| WP | Owner |\n| --- | --- |\n| WP-3 | analyst |\n",
            120,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────┬─────────┐\n│ WP   │ Owner   │\n├──────┼─────────┤\n│ WP-3 │ analyst │\n└──────┴─────────┘\n"
    );
}

#[test]
fn emit_nine_columns() {
    assert_eq!(
        md_table(
            "| Head0 | Head1 | Head2 | Head3 | Head4 | Head5 | Head6 | Head7 | Head8 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| value-0-longish | value-1-longish | value-2-longish | value-3-longish | value-4-longish | value-5-longish | value-6-longish | value-7-longish | value-8-longish |\n",
            80,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┐\n│ Head0  │ Head1  │ Head2  │ Head3  │ Head4  │ Head5  │ Head6  │ Head7  │ Head8  │\n├────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┼────────┤\n│ value- │ value- │ value- │ value- │ value- │ value- │ value- │ value- │ value- │\n│ 0-long │ 1-long │ 2-long │ 3-long │ 4-long │ 5-long │ 6-long │ 7-long │ 8-long │\n│ ish    │ ish    │ ish    │ ish    │ ish    │ ish    │ ish    │ ish    │ ish    │\n└────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Head0 | Head1 | Head2 | Head3 | Head4 | Head5 | Head6 | Head7 | Head8 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| value-0-longish | value-1-longish | value-2-longish | value-3-longish | value-4-longish | value-5-longish | value-6-longish | value-7-longish | value-8-longish |\n",
            100,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐\n│ Head0    │ Head1    │ Head2    │ Head3    │ Head4    │ Head5    │ Head6    │ Head7    │ Head8    │\n├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤\n│ value-0- │ value-1- │ value-2- │ value-3- │ value-4- │ value-5- │ value-6- │ value-7- │ value-8- │\n│ longish  │ longish  │ longish  │ longish  │ longish  │ longish  │ longish  │ longish  │ longish  │\n└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘\n"
    );
    assert_eq!(
        md_table(
            "| Head0 | Head1 | Head2 | Head3 | Head4 | Head5 | Head6 | Head7 | Head8 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| value-0-longish | value-1-longish | value-2-longish | value-3-longish | value-4-longish | value-5-longish | value-6-longish | value-7-longish | value-8-longish |\n",
            160,
            Tier::Unicode,
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌─────────────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┬─────────────────┬────────────────┬────────────────┬────────────────┐\n│ Head0           │ Head1           │ Head2           │ Head3           │ Head4           │ Head5           │ Head6          │ Head7          │ Head8          │\n├─────────────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┼─────────────────┼────────────────┼────────────────┼────────────────┤\n│ value-0-longish │ value-1-longish │ value-2-longish │ value-3-longish │ value-4-longish │ value-5-longish │ value-6-longis │ value-7-longis │ value-8-longis │\n│                 │                 │                 │                 │                 │                 │ h              │ h              │ h              │\n└─────────────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┴─────────────────┴────────────────┴────────────────┴────────────────┘\n"
    );
}
