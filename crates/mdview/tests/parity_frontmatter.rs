//! The render response's frontmatter facts (WP-3 attempt 3 of `plans/mdview-rust-port.md`):
//! `{parsed, echoRanges}`, what `scripts/revision.ts`'s measurer reads from a `rust:` side.

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
    assert_eq!(
        response["frontmatter"],
        serde_json::json!({"parsed": true, "echoRanges": 0})
    );
}

#[test]
fn a_failed_block_reports_unparsed_and_one_echo_range_below_the_diagnostic() {
    let response = render("---\na: [unterminated\n---\n\nbody\n");
    assert_eq!(
        response["frontmatter"],
        serde_json::json!({"parsed": false, "echoRanges": 1})
    );
    // The echo range (1-based) starts below the diagnostic, which opens the document.
    let echo_start = response["codeRanges"][0][0].as_u64().expect("echo start");
    assert!(echo_start > 1);
    let text = response["text"].as_str().expect("text");
    let lines: Vec<&str> = text.split('\n').collect();
    assert!(lines[0].starts_with("! could not parse frontmatter: "));
    assert_eq!(
        lines[usize::try_from(echo_start - 1).expect("fits")],
        "a: [unterminated"
    );
}
