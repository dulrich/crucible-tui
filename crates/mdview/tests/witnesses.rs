//! The frontmatter defect witnesses (WP-10 of `plans/representative-corpus.md`), ported from
//! `tests/witnesses.test.ts` at WP-9 of `plans/mdview-rust-port.md` (the TypeScript original is
//! `TS_BASELINE` = `c097c66`). Each test is anchored to a real fixture under
//! `tests/fixtures/witnesses/`, and `witness-index.json` names this file as each record's
//! `test_file`: a witness is a fixture *plus* a test that fails if its fix is reverted.

use mdview::frontmatter::{format_meta_block_detailed, split_frontmatter};
use mdview::list_lines::strip_ansi;
use mdview::overflow::find_first_overflow;
use mdview::render::{Ambiguous, Policy, RenderOptions, Sgr, Tier};
use mdview::width::NARROW_MEASURE;

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/../../tests/fixtures/witnesses/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn meta_of(source: &str) -> String {
    split_frontmatter(source)
        .0
        .expect("the fixture has frontmatter")
}

/// `formatMetaBlockDetailed(meta, width)`: narrow ruler, no colour.
fn meta_block(meta: &str, width: usize) -> (String, Vec<(usize, usize)>) {
    let result =
        format_meta_block_detailed(meta, width, NARROW_MEASURE, Sgr::None).expect("formats");
    (
        strip_ansi(&result.text).into_owned(),
        result.verbatim_ranges,
    )
}

/// `renderDocumentDetailed(source, width)`: unicode, narrow, no colour, no hyperlinks.
fn render(source: &str, width: usize) -> mdview::RenderOutput {
    let options = RenderOptions {
        width,
        tier: Tier::Unicode,
        ambiguous: Ambiguous::Narrow,
        policy: Policy {
            sgr: Sgr::None,
            hyperlinks: false,
            tmux: false,
        },
        emoji: None,
        path: None,
        highlight_as: Default::default(),
    };
    mdview::render(source, None, &options).expect("renders")
}

fn cols(line: &str) -> usize {
    NARROW_MEASURE.width(line)
}

fn over_wide(text: &str, width: usize) -> Vec<usize> {
    text.split('\n')
        .enumerate()
        .filter(|(_, line)| cols(line) > width)
        .map(|(i, _)| i + 1)
        .collect()
}

fn covered(line: usize, ranges: &[(usize, usize)]) -> bool {
    ranges
        .iter()
        .any(|&(start, end)| line >= start && line <= end)
}

// --- defect 0: CRLF frontmatter ---------------------------------------------------------------

#[test]
fn defect_0_the_fixture_is_genuinely_crlf_on_disk() {
    assert!(fixture("defect-0-crlf-frontmatter.md").contains("\r\n"));
}

#[test]
fn defect_0_split_normalizes_meta_and_leaves_the_body_untouched() {
    let source = fixture("defect-0-crlf-frontmatter.md");
    let (meta, body) = split_frontmatter(&source);
    let meta = meta.expect("meta");
    assert!(!meta.contains('\r'));
    assert!(body.contains("\r\n"));
}

#[test]
fn defect_0_renders_a_meta_block_not_a_raw_echo_within_width() {
    let (plain, ranges) = meta_block(&meta_of(&fixture("defect-0-crlf-frontmatter.md")), 100);
    assert!(!plain.contains("could not parse"));
    assert!(ranges.is_empty());
    let lines: Vec<&str> = plain.split('\n').collect();
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("name") && l.trim_end().ends_with(": witness-skill"))
    );
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("  version") && l.trim_end().ends_with(": 1.2.1"))
    );
    for line in lines {
        assert!(cols(line) <= 100, "{line}");
    }
}

// --- defect 1: the diagnostic wraps, the excerpt and caret do not -----------------------------

#[test]
fn defect_1_the_fixture_is_a_real_yaml_parse_error() {
    let (plain, _) = meta_block(
        &meta_of(&fixture("defect-1-2-unparseable-frontmatter.md")),
        80,
    );
    let flat = plain.replace('\n', " ");
    assert!(flat.contains("could not parse frontmatter"));
    // The parser's own message text is D-A (`scripts/divergences.ts`, `yaml-diagnostic`): the TS
    // renderer's `yaml` said "Nested mappings are not allowed in compact mappings"; the port's
    // parser reports the same error in its own words.
    assert!(flat.contains("mapping values are not allowed"), "{flat}");
}

#[test]
fn defect_1_the_leading_message_wraps_at_every_width() {
    let meta = meta_of(&fixture("defect-1-2-unparseable-frontmatter.md"));
    for width in [40, 80] {
        let (plain, _) = meta_block(&meta, width);
        let lines: Vec<&str> = plain.split('\n').collect();
        let blank = lines
            .iter()
            .position(|l| l.is_empty())
            .expect("a blank line");
        assert!(blank > 0);
        for line in &lines[..blank] {
            assert!(cols(line) <= width, "{line}");
        }
        assert!(lines[..blank].join(" ").contains("at line 2, column"));
    }
}

#[test]
fn defect_1_the_caret_keeps_its_column_at_every_target() {
    let meta = meta_of(&fixture("defect-1-2-unparseable-frontmatter.md"));
    let caret = |width: usize| -> usize {
        let (plain, _) = meta_block(&meta, width);
        let line = plain
            .split('\n')
            .find(|l| l.trim() == "^")
            .expect("a caret line")
            .to_owned();
        line.find('^').expect("caret")
    };
    assert_eq!(caret(40), caret(80));
    assert_eq!(caret(160), caret(80));
}

// --- defect 2: only the verbatim echo is exempt -----------------------------------------------

#[test]
fn defect_2_the_exempt_range_is_exactly_the_echoed_block() {
    let meta = meta_of(&fixture("defect-1-2-unparseable-frontmatter.md"));
    let (plain, ranges) = meta_block(&meta, 80);
    let lines: Vec<&str> = plain.split('\n').collect();
    assert_eq!(ranges.len(), 1);
    let (start, end) = ranges[0];
    assert_eq!(end, lines.len());
    assert_eq!(lines[start - 1..end].join("\n"), meta.trim_end());
    for line in &lines[..start - 1] {
        assert!(cols(line) <= 80, "{line}");
    }
}

#[test]
fn defect_2_the_render_hands_the_echo_range_to_the_width_check() {
    let output = render(&fixture("defect-1-2-unparseable-frontmatter.md"), 80);
    let wide = over_wide(&output.text, 80);
    assert!(!wide.is_empty());
    for line in wide {
        assert!(
            covered(line, &output.code_ranges),
            "line {line} is over width and not exempt"
        );
    }
    assert!(find_first_overflow(&output.text, 80, &output.code_ranges, NARROW_MEASURE).is_none());
}

#[test]
fn defect_2_a_parsed_over_width_block_parses_cleanly() {
    let (plain, ranges) = meta_block(&meta_of(&fixture("defect-2-success-path-overwide.md")), 80);
    assert!(ranges.is_empty());
    assert!(plain.split('\n').map(cols).max().unwrap_or(0) > 80);
}

#[test]
fn defect_2_a_parsed_over_width_block_is_still_caught() {
    let output = render(&fixture("defect-2-success-path-overwide.md"), 80);
    let wide = over_wide(&output.text, 80);
    assert!(!wide.is_empty());
    for line in wide {
        assert!(
            !covered(line, &output.code_ranges),
            "line {line} must not be exempt"
        );
    }
    assert!(find_first_overflow(&output.text, 80, &output.code_ranges, NARROW_MEASURE).is_some());
}

// --- defect 3: a nested mapping respects the target width -------------------------------------

#[test]
fn defect_3_the_nested_subtree_wraps() {
    let meta = meta_of(&fixture("defect-3-nested-mapping.md"));
    for width in [40, 80] {
        let (plain, ranges) = meta_block(&meta, width);
        assert!(ranges.is_empty());
        assert!(plain.contains("{\"phrases\":"));
        for line in plain.split('\n') {
            assert!(cols(line) <= width, "{line}");
        }
    }
}

#[test]
fn defect_3_the_whole_fixture_has_no_overflow_at_80() {
    let output = render(&fixture("defect-3-nested-mapping.md"), 80);
    assert!(find_first_overflow(&output.text, 80, &output.code_ranges, NARROW_MEASURE).is_none());
}

// --- the synthetic CJK excerpt: un-exempt by design -------------------------------------------

#[test]
fn cjk_excerpt_reaches_150_columns_at_80() {
    let (plain, ranges) = meta_block(&meta_of(&fixture("defect-cjk-excerpt.md")), 80);
    let lines: Vec<&str> = plain.split('\n').collect();
    let start = ranges[0].0;
    let diagnostic = &lines[..start - 1];
    // 152 under the TS renderer's `yaml` excerpt; 150 under the port's (D-A, `yaml-diagnostic`).
    // Either way the excerpt is far past the target and stays un-exempt, which is the witness.
    assert_eq!(diagnostic.iter().map(|l| cols(l)).max(), Some(150));
    assert_eq!(start, diagnostic.len() + 1);
}

#[test]
fn cjk_excerpt_is_still_caught_by_the_gate() {
    let output = render(&fixture("defect-cjk-excerpt.md"), 80);
    let hit = find_first_overflow(&output.text, 80, &output.code_ranges, NARROW_MEASURE)
        .expect("overflow");
    assert!(hit.width > 80);
}

// --- WP-14: inline markup inside a list item ---------------------------------------------------
// Ported from `tests/render-list-layout.test.ts`'s WP-14 witness block at WP-9.

fn render_with(source: &str, width: usize, sgr: Sgr) -> String {
    let options = RenderOptions {
        width,
        tier: Tier::Unicode,
        ambiguous: Ambiguous::Narrow,
        policy: Policy {
            sgr,
            hyperlinks: false,
            tmux: false,
        },
        emoji: None,
        path: None,
        highlight_as: Default::default(),
    };
    mdview::render(source, None, &options)
        .expect("renders")
        .text
}

fn wp14(width: usize) -> String {
    strip_ansi(&render(&fixture("defect-wp14-list-item-inline-markup.md"), width).text).into_owned()
}

#[test]
fn wp14_every_list_item_kind_renders_its_inline_markup_parsed() {
    let rendered = wp14(100);
    assert!(rendered.contains(
        "A paragraph is the control: bold, em, code, label (https://example.com/p) and struck"
    ));
    for marker in [
        "• tight: bold, em, code, label (https://example.com/p) and struck",
        "• loose: bold, em, code, label (https://example.com/p) and struck",
        "1. ordered: bold, em, code, label (https://example.com/p) and struck",
        "◦ nested: bold, em, code, label (https://example.com/p) and struck",
    ] {
        assert!(rendered.contains(marker), "{marker}");
    }
    for line in rendered
        .split('\n')
        .filter(|l| !l.trim().is_empty() && !l.contains("echo "))
    {
        for syntax in ["**", "~~", "](", "`"] {
            assert!(!line.contains(syntax), "{line}");
        }
    }
}

#[test]
fn wp14_a_task_items_checkbox_is_rendered_once() {
    let rendered = wp14(100);
    let open: Vec<&str> = rendered
        .split('\n')
        .filter(|l| l.contains("task open"))
        .collect();
    let done: Vec<&str> = rendered
        .split('\n')
        .filter(|l| l.contains("task done"))
        .collect();
    assert_eq!(open.len(), 1);
    assert_eq!(done.len(), 1);
    assert!(open[0].contains("○ task open: bold and label (https://example.com/p)"));
    assert!(done[0].contains("✓ task done: bold and label (https://example.com/p)"));
    assert_eq!(open[0].matches('○').count(), 1);
    assert_eq!(done[0].matches('✓').count(), 1);
}

#[test]
fn wp14_an_authored_hard_break_still_ends_its_line() {
    for width in [80, 100, 160] {
        let rendered = wp14(width);
        let at = rendered
            .find("this line ends in two spaces\n")
            .expect("hard break ends the line");
        let next = rendered[at..].split('\n').nth(1).unwrap_or("");
        assert!(
            next.trim_start()
                .starts_with("so this one must stay on a line of its own"),
            "{next}"
        );
        assert!(!rendered.contains('\r'));
    }
}

#[test]
fn wp14_an_authored_soft_break_is_still_coalesced() {
    assert!(wp14(160).contains(
        "tight, authored soft break: this line was wrapped by its author and continues here, so the two must coalesce into one logical line"
    ));
}

#[test]
fn wp14_a_fence_nested_in_a_list_item_is_still_verbatim() {
    assert!(wp14(100).contains("echo \"**not bold**\" > /home/example/out.md"));
}

#[test]
fn wp14_no_rendered_line_exceeds_the_target_width() {
    for width in [80, 100, 116, 160, 346] {
        for line in wp14(width).split('\n') {
            assert!(cols(line) <= width, "{width}: {line}");
        }
    }
}

#[test]
fn wp14_under_real_ansi_the_item_is_styled_like_the_paragraph() {
    let source = "Control **bold** and [label](https://example.com/p).\n\n- item **bold** and [label](https://example.com/p).\n";
    let text = render_with(source, 80, Sgr::Full);
    let lines: Vec<&str> = text.split('\n').collect();
    let control = lines
        .iter()
        .find(|l| l.contains("Control"))
        .copied()
        .unwrap_or("");
    let item = lines
        .iter()
        .find(|l| l.contains("item"))
        .copied()
        .unwrap_or("");
    assert!(strip_ansi(control).contains("Control bold and label (https://example.com/p)."));
    assert!(strip_ansi(item).contains("item bold and label (https://example.com/p)."));
    for styled in [control, item] {
        assert_ne!(styled, strip_ansi(styled));
        assert!(styled.contains("\u{1b}[1mbold\u{1b}[22m"), "{styled:?}");
    }
    for line in lines {
        assert!(cols(&strip_ansi(line)) <= 80);
    }
}
