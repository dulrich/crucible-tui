//! The emitter's synthetic-span battery (`tests/table-normalization.test.ts`), rendered.

use super::tests_emit::{glyph_set, grid_of};
use super::*;
use crate::render::{Sgr, Tier};
use crate::width::{NARROW_MEASURE, WIDE_MEASURE};

#[test]
fn span_unwrapped_three_modes() {
    let grid = grid_of(
        &[("head", &[][..])],
        &[&[("alpha beta", &[(0, 5)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m head       \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4malpha\u{1b}[24m\u{1b}[39m beta \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────────┘\u{1b}[39m\n"
    );
    let grid = grid_of(
        &[("head", &[][..])],
        &[&[("alpha beta", &[(0, 5)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Formats
        ),
        "┌────────────┐\n│\u{1b}[1m head       \u{1b}[22m│\n├────────────┤\n│ \u{1b}[4malpha\u{1b}[24m beta │\n└────────────┘\n"
    );
    let grid = grid_of(
        &[("head", &[][..])],
        &[&[("alpha beta", &[(0, 5)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::None
        ),
        "┌────────────┐\n│ head       │\n├────────────┤\n│ alpha beta │\n└────────────┘\n"
    );
}

#[test]
fn span_adjacent() {
    let grid = grid_of(
        &[("head", &[][..])],
        &[&[("abcdef", &[(0, 3), (3, 6)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m head   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mabc\u{1b}[24m\u{1b}[39m\u{1b}[36m\u{1b}[4mdef\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_partial() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("one two three", &[(4, 7)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌───────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h             \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m one \u{1b}[36m\u{1b}[4mtwo\u{1b}[24m\u{1b}[39m three \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_word_wrapped() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("alpha beta gamma", &[(0, 16)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            14,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h          \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4malpha beta\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mgamma\u{1b}[24m\u{1b}[39m      \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_hard_split() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("abcdefghijkl", &[(0, 12)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            10,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h      \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mabcdef\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mghijkl\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_align_right() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("ab", &[(0, 2)][..])][..]],
        &[Align::Right],
    );
    assert_eq!(
        render_grid(
            &grid,
            12,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m  h \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mab\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_align_center() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("ab", &[(0, 2)][..])][..]],
        &[Align::Center],
    );
    assert_eq!(
        render_grid(
            &grid,
            12,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h  \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mab\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_head_span() {
    let grid = grid_of(
        &[("alpha beta", &[(0, 5)][..])],
        &[&[("body", &[][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            40,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m \u{1b}[36m\u{1b}[4malpha\u{1b}[24m\u{1b}[39m beta \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m body       \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_cjk_narrow() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("你好世界", &[(0, 2)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            12,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌──────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4m你好\u{1b}[24m\u{1b}[39m世界 \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_cjk_wide() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("你好世界", &[(0, 2)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(&grid, 12, glyph_set(Tier::Unicode), WIDE_MEASURE, Sgr::Full),
        "\u{1b}[90m┌──────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4m你好\u{1b}[24m\u{1b}[39m世界 \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_ambiguous_narrow() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("—→≥×ab", &[(0, 4)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(&grid, 14, glyph_set(Tier::Ascii), NARROW_MEASURE, Sgr::Full),
        "\u{1b}[90m+--------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m\u{1b}[1m h      \u{1b}[22m\u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+--------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m \u{1b}[36m\u{1b}[4m—→≥×\u{1b}[24m\u{1b}[39mab \u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+--------+\u{1b}[39m\n"
    );
}

#[test]
fn span_ambiguous_wide() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("—→≥×ab", &[(0, 4)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(&grid, 14, glyph_set(Tier::Ascii), WIDE_MEASURE, Sgr::Full),
        "\u{1b}[90m+------------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m\u{1b}[1m h          \u{1b}[22m\u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m \u{1b}[36m\u{1b}[4m—→≥×\u{1b}[24m\u{1b}[39mab \u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------------+\u{1b}[39m\n"
    );
}

#[test]
fn span_family_emoji() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("👩‍👩‍👧‍👦x", &[(0, 11)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            12,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4m👩‍👩‍👧‍👦\u{1b}[24m\u{1b}[39mx \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_ascii_tier() {
    let grid = grid_of(
        &[("head", &[][..])],
        &[&[("alpha beta", &[(0, 5)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(&grid, 40, glyph_set(Tier::Ascii), NARROW_MEASURE, Sgr::Full),
        "\u{1b}[90m+------------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m\u{1b}[1m head       \u{1b}[22m\u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------------+\u{1b}[39m\n\u{1b}[90m|\u{1b}[39m \u{1b}[36m\u{1b}[4malpha\u{1b}[24m\u{1b}[39m beta \u{1b}[90m|\u{1b}[39m\n\u{1b}[90m+------------+\u{1b}[39m\n"
    );
}

#[test]
fn span_two_cols() {
    let grid = grid_of(
        &[("head one", &[][..]), ("head two", &[(0, 4)][..])],
        &[&[
            ("alpha beta gamma delta", &[(0, 10)][..]),
            ("plain", &[][..]),
        ][..]],
        &[Align::Left, Align::Right],
    );
    assert_eq!(
        render_grid(
            &grid,
            20,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Formats
        ),
        "┌─────────┬────────┐\n│\u{1b}[1m head    \u{1b}[22m│\u{1b}[1m   \u{1b}[4mhead\u{1b}[24m \u{1b}[22m│\n│\u{1b}[1m one     \u{1b}[22m│\u{1b}[1m    two \u{1b}[22m│\n├─────────┼────────┤\n│ \u{1b}[4malpha\u{1b}[24m   │  plain │\n│ \u{1b}[4mbeta\u{1b}[24m    │        │\n│ gamma   │        │\n│ delta   │        │\n└─────────┴────────┘\n"
    );
    let grid = grid_of(
        &[("head one", &[][..]), ("head two", &[(0, 4)][..])],
        &[&[
            ("alpha beta gamma delta", &[(0, 10)][..]),
            ("plain", &[][..]),
        ][..]],
        &[Align::Left, Align::Right],
    );
    assert_eq!(
        render_grid(
            &grid,
            30,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Formats
        ),
        "┌─────────────────┬──────────┐\n│\u{1b}[1m head one        \u{1b}[22m│\u{1b}[1m \u{1b}[4mhead\u{1b}[24m two \u{1b}[22m│\n├─────────────────┼──────────┤\n│ \u{1b}[4malpha beta\u{1b}[24m      │    plain │\n│ gamma delta     │          │\n└─────────────────┴──────────┘\n"
    );
    let grid = grid_of(
        &[("head one", &[][..]), ("head two", &[(0, 4)][..])],
        &[&[
            ("alpha beta gamma delta", &[(0, 10)][..]),
            ("plain", &[][..]),
        ][..]],
        &[Align::Left, Align::Right],
    );
    assert_eq!(
        render_grid(
            &grid,
            20,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌─────────\u{1b}[39m\u{1b}[90m┬────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m head    \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m   \u{1b}[36m\u{1b}[4mhead\u{1b}[24m\u{1b}[39m \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m one     \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m    two \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────────\u{1b}[39m\u{1b}[90m┼────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4malpha\u{1b}[24m\u{1b}[39m   \u{1b}[90m│\u{1b}[39m  plain \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mbeta\u{1b}[24m\u{1b}[39m    \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m gamma   \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m delta   \u{1b}[90m│\u{1b}[39m        \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────────\u{1b}[39m\u{1b}[90m┴────────┘\u{1b}[39m\n"
    );
    let grid = grid_of(
        &[("head one", &[][..]), ("head two", &[(0, 4)][..])],
        &[&[
            ("alpha beta gamma delta", &[(0, 10)][..]),
            ("plain", &[][..]),
        ][..]],
        &[Align::Left, Align::Right],
    );
    assert_eq!(
        render_grid(
            &grid,
            30,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌─────────────────\u{1b}[39m\u{1b}[90m┬──────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m head one        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m \u{1b}[36m\u{1b}[4mhead\u{1b}[24m\u{1b}[39m two \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────────────────\u{1b}[39m\u{1b}[90m┼──────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4malpha beta\u{1b}[24m\u{1b}[39m      \u{1b}[90m│\u{1b}[39m    plain \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m gamma delta     \u{1b}[90m│\u{1b}[39m          \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────────────────\u{1b}[39m\u{1b}[90m┴──────────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_unnormalized_degrades() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("a  b", &[(0, 1)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            20,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌──────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h    \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m a b  \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_span_outside() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("abc", &[(50, 60)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            20,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m abc \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_span_empty() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("abc", &[(3, 3)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            20,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m abc \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn span_span_wrapped_mid_surrogate_free() {
    let grid = grid_of(
        &[("h", &[][..])],
        &[&[("🎉 party 🎉 time", &[(3, 8), (9, 16)][..])][..]],
        &[Align::Left],
    );
    assert_eq!(
        render_grid(
            &grid,
            12,
            glyph_set(Tier::Unicode),
            NARROW_MEASURE,
            Sgr::Full
        ),
        "\u{1b}[90m┌──────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m h        \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m 🎉 \u{1b}[36m\u{1b}[4mparty\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4m🎉 time\u{1b}[24m\u{1b}[39m  \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────────┘\u{1b}[39m\n"
    );
}
