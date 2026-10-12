//! The `__parity` stub protocol (WP-1 of `plans/mdview-rust-port.md`): a request in yields
//! exactly one response line out, and the stub renderer can never produce a response that
//! reads as a match.

use serde_json::Value;

const REQUEST: &str = r##"{"source":"# hi\n","width":80,"tier":"unicode","ambiguous":"narrow","policy":{"sgr":"none","hyperlinks":false,"tmux":false}}"##;

fn parse(line: &str) -> Value {
    serde_json::from_str(line).expect("response is JSON")
}

#[test]
fn a_well_formed_render_request_gets_an_unimplemented_error_never_text() {
    let response = parse(&mdview::parity::handle_render(REQUEST));
    assert_eq!(response["error"], "unimplemented");
    assert!(response.get("text").is_none());
}

#[test]
fn a_malformed_request_is_an_error_response_not_a_crash() {
    let response = parse(&mdview::parity::handle_render("{\"source\": 3}"));
    assert!(response["error"].as_str().is_some_and(|e| !e.is_empty()));
}

#[test]
fn serve_answers_each_line_once_and_skips_blank_lines() {
    let input = format!("{REQUEST}\n\n{REQUEST}\n");
    let mut out = Vec::new();
    mdview::parity::serve(input.as_bytes(), &mut out, mdview::parity::handle_render)
        .expect("serve");
    let text = String::from_utf8(out).expect("utf8");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|l| parse(l)["error"] == "unimplemented"));
}

#[test]
fn the_lexer_answers_with_census_tokens() {
    let response = parse(&mdview::parity::handle_lex(
        "{\"body\":\"x\",\"tier\":\"ascii\"}",
    ));
    assert_eq!(response["tokens"][0]["type"], "paragraph");
    assert_eq!(response["tokens"][0]["tokens"][0]["raw"], "x");
    let bad = parse(&mdview::parity::handle_lex(
        "{\"body\":\"x\",\"tier\":\"nope\"}",
    ));
    assert!(bad["error"].is_string());
}

#[test]
fn only_the_parity_subcommand_reaches_the_server() {
    assert!(mdview::run(&["__parity".into(), "nope".into()]).is_err());
    assert!(mdview::run(&["file.md".into()]).is_err());
}
