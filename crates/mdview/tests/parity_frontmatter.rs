//! The render response's frontmatter facts (WP-3 attempt 3 of `plans/mdview-rust-port.md`):
//! what D-A's predicate (`scripts/divergences.ts`, `RenderSide.frontmatter`) reads from the
//! Rust side of the R-gate.

use serde_json::Value;

fn render(source: &str) -> Value {
    let request = serde_json::json!({
        "source": source,
        "width": 80,
        "tier": "unicode",
        "ambiguous": "narrow",
        "policy": {"sgr": "none", "hyperlinks": false, "tmux": false},
    });
    serde_json::from_str(&mdview::parity::handle_render(&request.to_string()))
        .expect("response is JSON")
}

#[test]
fn no_frontmatter_means_no_facts() {
    let response = render("plain text\n");
    assert!(response.get("text").is_some());
    assert!(response.get("frontmatter").is_none());
}

#[test]
fn a_parsed_block_reports_parsed_and_no_diagnostic() {
    let response = render("---\na: 1\n---\n\nbody\n");
    assert_eq!(response["frontmatter"], serde_json::json!({"parsed": true}));
}

#[test]
fn a_failed_block_reports_the_diagnostic_span_above_its_echo() {
    let response = render("---\na: [unterminated\n---\n\nbody\n");
    let facts = &response["frontmatter"];
    assert_eq!(facts["parsed"], false);
    let end = facts["diagnostic"][1].as_u64().expect("diagnostic end");
    assert_eq!(facts["diagnostic"][0], 0);
    // The echo range (1-based) starts on the line right after the diagnostic.
    assert_eq!(response["codeRanges"][0][0].as_u64(), Some(end + 1));
    let text = response["text"].as_str().expect("text");
    let lines: Vec<&str> = text.split('\n').collect();
    assert!(lines[0].starts_with("! could not parse frontmatter: "));
    assert_eq!(
        lines[usize::try_from(end).expect("fits")],
        "a: [unterminated"
    );
}
