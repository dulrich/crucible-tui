//! The `__parity table-alloc` protocol (WP-5a of `plans/mdview-rust-port.md`): the Rust side
//! of `scripts/table-alloc-diff.ts`. Token input needs the `parity-tokens` feature; without it
//! the mode must answer `{error}`, never a response that could read as a match.

use serde_json::{Value, json};

fn cell(text: &str) -> Value {
    json!({ "text": text, "tokens": [{ "type": "text", "raw": text, "text": text }] })
}

fn ask(request: &Value) -> Value {
    serde_json::from_str(&mdview::parity::handle_table_alloc(&request.to_string()))
        .expect("response is JSON")
}

fn request(width: u64) -> Value {
    json!({
        "table": {
            "type": "table",
            "header": [cell("WP"), cell("Description")],
            "rows": [[cell("A1"), cell(&"x".repeat(200))], [cell("  b   c ")]],
            "align": [null, "right"],
        },
        "width": width,
        "tier": "unicode",
        "ambiguous": "narrow",
    })
}

#[test]
fn malformed_requests_are_errors() {
    assert!(ask(&json!({})).get("error").is_some());
    let mut bad = request(80);
    bad["ambiguous"] = json!("medium");
    assert!(ask(&bad).get("error").is_some());
    let mut bad = request(80);
    bad["tier"] = json!("emoji");
    assert!(ask(&bad).get("error").is_some());
}

#[cfg(feature = "parity-tokens")]
#[test]
fn allocates_a_table() {
    let response = ask(&request(80));
    assert_eq!(response["natural"], json!([3, 200]));
    assert_eq!(response["widths"], json!([3, 70]));
    assert_eq!(response["totalWidth"], json!(80));
    assert_eq!(response["fits"], json!(true));
    assert_eq!(response["grid"]["columnCount"], json!(2));
    assert_eq!(response["grid"]["aligns"], json!(["left", "right"]));
    assert_eq!(
        response["grid"]["rows"][1],
        json!([{ "text": "b c", "spans": [] }, { "text": "", "spans": [] }])
    );
}

#[cfg(feature = "parity-tokens")]
#[test]
fn a_non_table_token_is_an_error() {
    let mut req = request(80);
    req["table"] = json!({ "type": "hr" });
    assert!(ask(&req).get("error").is_some());
}

#[cfg(not(feature = "parity-tokens"))]
#[test]
fn without_the_feature_token_input_is_an_error() {
    assert!(ask(&request(80)).get("error").is_some());
}
