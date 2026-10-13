//! Rendered-bytes wiki-link cases (`tests/wikilink-table.test.ts`), through the whole document render.

use super::tests_emit::doc_render;
use crate::render::Sgr;

#[test]
fn doc_wikilink_boundary_ws() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[ b ]] |\n", Sgr::None, false),
        "┌─────┐\n│ col │\n├─────┤\n│ b   │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[ b ]] |\n", Sgr::Formats, false),
        "┌─────┐\n│\u{1b}[1m col \u{1b}[22m│\n├─────┤\n│ \u{1b}[4mb\u{1b}[24m   │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[ b ]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mb\u{1b}[24m\u{1b}[39m   \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_wrapped_label() {
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| [[abcdefghijklmnopqrstuvwxyz]] | y |\n",
            Sgr::None,
            false
        ),
        "┌────────────────────────────┬───┐\n│ a                          │ y │\n├────────────────────────────┼───┤\n│ abcdefghijklmnopqrstuvwxyz │ y │\n└────────────────────────────┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| [[abcdefghijklmnopqrstuvwxyz]] | y |\n",
            Sgr::Formats,
            false
        ),
        "┌────────────────────────────┬───┐\n│\u{1b}[1m a                          \u{1b}[22m│\u{1b}[1m y \u{1b}[22m│\n├────────────────────────────┼───┤\n│ \u{1b}[4mabcdefghijklmnopqrstuvwxyz\u{1b}[24m │ y │\n└────────────────────────────┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| [[abcdefghijklmnopqrstuvwxyz]] | y |\n",
            Sgr::Full,
            false
        ),
        "\u{1b}[90m┌────────────────────────────\u{1b}[39m\u{1b}[90m┬───┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m a                          \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m y \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├────────────────────────────\u{1b}[39m\u{1b}[90m┼───┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mabcdefghijklmnopqrstuvwxyz\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m y \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└────────────────────────────\u{1b}[39m\u{1b}[90m┴───┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_body_cell() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[wiki-slug]] |\n", Sgr::None, false),
        "┌───────────┐\n│ col       │\n├───────────┤\n│ wiki-slug │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[wiki-slug]] |\n", Sgr::Formats, false),
        "┌───────────┐\n│\u{1b}[1m col       \u{1b}[22m│\n├───────────┤\n│ \u{1b}[4mwiki-slug\u{1b}[24m │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[wiki-slug]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌───────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col       \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mwiki-slug\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_header_cell() {
    assert_eq!(
        doc_render("| [[head-slug]] |\n|---|\n| body |\n", Sgr::None, false),
        "┌───────────┐\n│ head-slug │\n├───────────┤\n│ body      │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render("| [[head-slug]] |\n|---|\n| body |\n", Sgr::Formats, false),
        "┌───────────┐\n│\u{1b}[1m \u{1b}[4mhead-slug\u{1b}[24m \u{1b}[22m│\n├───────────┤\n│ body      │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render("| [[head-slug]] |\n|---|\n| body |\n", Sgr::Full, false),
        "\u{1b}[90m┌───────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m \u{1b}[36m\u{1b}[4mhead-slug\u{1b}[24m\u{1b}[39m \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m body      \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_alignments() {
    assert_eq!(
        doc_render(
            "| L | C | R |\n|:---|:---:|---:|\n| [[a]] | [[b]] | [[c]] |\n",
            Sgr::None,
            false
        ),
        "┌───┬───┬───┐\n│ L │ C │ R │\n├───┼───┼───┤\n│ a │ b │ c │\n└───┴───┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| L | C | R |\n|:---|:---:|---:|\n| [[a]] | [[b]] | [[c]] |\n",
            Sgr::Formats,
            false
        ),
        "┌───┬───┬───┐\n│\u{1b}[1m L \u{1b}[22m│\u{1b}[1m C \u{1b}[22m│\u{1b}[1m R \u{1b}[22m│\n├───┼───┼───┤\n│ \u{1b}[4ma\u{1b}[24m │ \u{1b}[4mb\u{1b}[24m │ \u{1b}[4mc\u{1b}[24m │\n└───┴───┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| L | C | R |\n|:---|:---:|---:|\n| [[a]] | [[b]] | [[c]] |\n",
            Sgr::Full,
            false
        ),
        "\u{1b}[90m┌───\u{1b}[39m\u{1b}[90m┬───\u{1b}[39m\u{1b}[90m┬───┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m L \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m C \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m R \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───\u{1b}[39m\u{1b}[90m┼───\u{1b}[39m\u{1b}[90m┼───┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4ma\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mb\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mc\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───\u{1b}[39m\u{1b}[90m┴───\u{1b}[39m\u{1b}[90m┴───┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_label_beside_prose() {
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| pre [[abcdefghijklmnop]] post | y |\n",
            Sgr::None,
            false
        ),
        "┌───────────────────────────┬───┐\n│ a                         │ y │\n├───────────────────────────┼───┤\n│ pre abcdefghijklmnop post │ y │\n└───────────────────────────┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| pre [[abcdefghijklmnop]] post | y |\n",
            Sgr::Formats,
            false
        ),
        "┌───────────────────────────┬───┐\n│\u{1b}[1m a                         \u{1b}[22m│\u{1b}[1m y \u{1b}[22m│\n├───────────────────────────┼───┤\n│ pre \u{1b}[4mabcdefghijklmnop\u{1b}[24m post │ y │\n└───────────────────────────┴───┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | y |\n|---|---|\n| pre [[abcdefghijklmnop]] post | y |\n",
            Sgr::Full,
            false
        ),
        "\u{1b}[90m┌───────────────────────────\u{1b}[39m\u{1b}[90m┬───┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m a                         \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m y \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────────────────────\u{1b}[39m\u{1b}[90m┼───┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m pre \u{1b}[36m\u{1b}[4mabcdefghijklmnop\u{1b}[24m\u{1b}[39m post \u{1b}[90m│\u{1b}[39m y \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────────────────────\u{1b}[39m\u{1b}[90m┴───┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_edge() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]] x |\n", Sgr::None, false),
        "┌─────┐\n│ col │\n├─────┤\n│ a x │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]] x |\n", Sgr::Formats, false),
        "┌─────┐\n│\u{1b}[1m col \u{1b}[22m│\n├─────┤\n│ \u{1b}[4ma\u{1b}[24m x │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]] x |\n", Sgr::Full, false),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4ma\u{1b}[24m\u{1b}[39m x \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_adjacent() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]][[b]] |\n", Sgr::None, false),
        "┌─────┐\n│ col │\n├─────┤\n│ ab  │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]][[b]] |\n", Sgr::Formats, false),
        "┌─────┐\n│\u{1b}[1m col \u{1b}[22m│\n├─────┤\n│ \u{1b}[4ma\u{1b}[24m\u{1b}[4mb\u{1b}[24m  │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a]][[b]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4ma\u{1b}[24m\u{1b}[39m\u{1b}[36m\u{1b}[4mb\u{1b}[24m\u{1b}[39m  \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_internal_run() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a   b]] |\n", Sgr::None, false),
        "┌─────┐\n│ col │\n├─────┤\n│ a b │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a   b]] |\n", Sgr::Formats, false),
        "┌─────┐\n│\u{1b}[1m col \u{1b}[22m│\n├─────┤\n│ \u{1b}[4ma b\u{1b}[24m │\n└─────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[a   b]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌─────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4ma b\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_entities() {
    assert_eq!(
        doc_render(
            "| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n",
            Sgr::None,
            false
        ),
        "┌───────────┐\n│ col       │\n├───────────┤\n│ a & b <c> │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render(
            "| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n",
            Sgr::Formats,
            false
        ),
        "┌───────────┐\n│\u{1b}[1m col       \u{1b}[22m│\n├───────────┤\n│ a & \u{1b}[4mb\u{1b}[24m <c> │\n└───────────┘\n"
    );
    assert_eq!(
        doc_render(
            "| col |\n|---|\n| a &amp; [[b]] &lt;c&gt; |\n",
            Sgr::Full,
            false
        ),
        "\u{1b}[90m┌───────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col       \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m a & \u{1b}[36m\u{1b}[4mb\u{1b}[24m\u{1b}[39m <c> \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_embed() {
    assert_eq!(
        doc_render("| col |\n|---|\n| ![[note]] |\n", Sgr::None, false),
        "┌─────────────┐\n│ col         │\n├─────────────┤\n│ embed: note │\n└─────────────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| ![[note]] |\n", Sgr::Formats, false),
        "┌─────────────┐\n│\u{1b}[1m col         \u{1b}[22m│\n├─────────────┤\n│ embed: \u{1b}[4mnote\u{1b}[24m │\n└─────────────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| ![[note]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌─────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col         \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m embed: \u{1b}[36m\u{1b}[4mnote\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_escaped_pipe() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[s\\|Alias]] |\n", Sgr::None, false),
        "┌───────┐\n│ col   │\n├───────┤\n│ Alias │\n└───────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[s\\|Alias]] |\n", Sgr::Formats, false),
        "┌───────┐\n│\u{1b}[1m col   \u{1b}[22m│\n├───────┤\n│ \u{1b}[4mAlias\u{1b}[24m │\n└───────┘\n"
    );
    assert_eq!(
        doc_render("| col |\n|---|\n| [[s\\|Alias]] |\n", Sgr::Full, false),
        "\u{1b}[90m┌───────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mAlias\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_unescaped_pipe() {
    assert_eq!(
        doc_render(
            "| a | b |\n|---|---|\n| [[s|Alias]] | y |\n",
            Sgr::None,
            false
        ),
        "┌─────┬─────────┐\n│ a   │ b       │\n├─────┼─────────┤\n│ [[s │ Alias]] │\n└─────┴─────────┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | b |\n|---|---|\n| [[s|Alias]] | y |\n",
            Sgr::Formats,
            false
        ),
        "┌─────┬─────────┐\n│\u{1b}[1m a   \u{1b}[22m│\u{1b}[1m b       \u{1b}[22m│\n├─────┼─────────┤\n│ [[s │ Alias]] │\n└─────┴─────────┘\n"
    );
    assert_eq!(
        doc_render(
            "| a | b |\n|---|---|\n| [[s|Alias]] | y |\n",
            Sgr::Full,
            false
        ),
        "\u{1b}[90m┌─────\u{1b}[39m\u{1b}[90m┬─────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m a   \u{1b}[22m\u{1b}[90m│\u{1b}[39m\u{1b}[1m b       \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├─────\u{1b}[39m\u{1b}[90m┼─────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m [[s \u{1b}[90m│\u{1b}[39m Alias]] \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└─────\u{1b}[39m\u{1b}[90m┴─────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_url_links() {
    assert_eq!(
        doc_render(
            "| col |\n|---|\n| [[https://example.test/path]] |\n",
            Sgr::Full,
            true
        ),
        "\u{1b}[90m┌───────────────────────────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col                       \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├───────────────────────────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mhttps://example.test/path\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└───────────────────────────┘\u{1b}[39m\n"
    );
}

#[test]
fn doc_wikilink_note_links() {
    assert_eq!(
        doc_render("| col |\n|---|\n| [[note]] |\n", Sgr::Full, true),
        "\u{1b}[90m┌──────┐\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m\u{1b}[1m col  \u{1b}[22m\u{1b}[90m│\u{1b}[39m\n\u{1b}[90m├──────┤\u{1b}[39m\n\u{1b}[90m│\u{1b}[39m \u{1b}[36m\u{1b}[4mnote\u{1b}[24m\u{1b}[39m \u{1b}[90m│\u{1b}[39m\n\u{1b}[90m└──────┘\u{1b}[39m\n"
    );
}
