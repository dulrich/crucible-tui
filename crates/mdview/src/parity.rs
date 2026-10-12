//! The hidden `mdview __parity` subcommand: the JSONL servers the Bun instruments drive
//! (`scripts/revision.ts`'s `rust:` kind, `scripts/lexer-diff.ts`). Dispatched only when
//! `args[0] == "__parity"`, and absent from help.
//!
//! - `serve`: one JSON request per line in, one JSON response per line out.
//!   Request `{source, path?, width, tier, ambiguous, policy: {sgr, hyperlinks, tmux}, emoji?,
//!   tokens?}`; response `{text, codeRanges}` or `{error}`.
//! - `lex`: request `{body, tier}`; response `{tokens}` or `{error}` (the adapter is WP-7's,
//!   so today every request errors).
//! - `style-table`: dump the committed SGR table (`style.rs`), one JSON line.
//!
//! **A request never yields a response that could read as a match unless `render` returned
//! output.** Every failure — malformed request, missing feature, unimplemented renderer — is an
//! `{error}` line, which `render-diff` counts as an error and never as a pass.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::render::{Ambiguous, Policy, RenderOptions, Sgr, Tier, render};
use crate::token::Token;

/// Run `__parity <sub>` over stdin/stdout.
pub fn run(args: &[String]) -> Result<i32, String> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    match args.first().map(String::as_str) {
        Some("serve") => {
            serve(stdin.lock(), stdout.lock(), handle_render).map_err(|e| e.to_string())?
        }
        Some("lex") => serve(stdin.lock(), stdout.lock(), handle_lex).map_err(|e| e.to_string())?,
        Some("style-table") => {
            let mut out = stdout.lock();
            writeln!(out, "{}", crate::style::style_table_json()).map_err(|e| e.to_string())?;
        }
        Some(other) => return Err(format!("__parity: unknown subcommand '{other}'")),
        None => return Err("__parity: missing subcommand".into()),
    }
    Ok(0)
}

/// Answer every non-empty input line with exactly one output line, flushing per line so a
/// long-lived client can pipeline request/response pairs.
pub fn serve<R: BufRead, W: Write>(
    input: R,
    mut output: W,
    handler: fn(&str) -> String,
) -> std::io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        output.write_all(handler(&line).as_bytes())?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn error_line(message: &str) -> String {
    json!({ "error": message }).to_string()
}

fn field<'a>(request: &'a Value, name: &str) -> Result<&'a Value, String> {
    request
        .get(name)
        .ok_or_else(|| format!("request is missing \"{name}\""))
}

fn parse_tier(value: &Value) -> Result<Tier, String> {
    match value.as_str() {
        Some("unicode") => Ok(Tier::Unicode),
        Some("ascii") => Ok(Tier::Ascii),
        _ => Err(format!("bad tier {value}")),
    }
}

fn parse_options(request: &Value) -> Result<RenderOptions, String> {
    let width = field(request, "width")?
        .as_u64()
        .and_then(|w| usize::try_from(w).ok())
        .ok_or("bad width")?;
    let tier = parse_tier(field(request, "tier")?)?;
    let ambiguous = match field(request, "ambiguous")?.as_str() {
        Some("narrow") => Ambiguous::Narrow,
        Some("wide") => Ambiguous::Wide,
        _ => return Err("bad ambiguous".into()),
    };
    let policy = field(request, "policy")?;
    let sgr = match field(policy, "sgr")?.as_str() {
        Some("full") => Sgr::Full,
        Some("formats") => Sgr::Formats,
        Some("none") => Sgr::None,
        _ => return Err("bad policy.sgr".into()),
    };
    let flag = |name: &str| -> Result<bool, String> {
        field(policy, name)?
            .as_bool()
            .ok_or_else(|| format!("bad policy.{name}"))
    };
    let emoji = match request.get("emoji") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err("bad emoji".into()),
    };
    let path = request
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(RenderOptions {
        width,
        tier,
        ambiguous,
        policy: Policy {
            sgr,
            hyperlinks: flag("hyperlinks")?,
            tmux: flag("tmux")?,
        },
        emoji,
        path,
    })
}

#[cfg(feature = "parity-tokens")]
fn parse_tokens(value: &Value) -> Result<Vec<Token>, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("bad tokens: {e}"))
}

#[cfg(not(feature = "parity-tokens"))]
fn parse_tokens(_value: &Value) -> Result<Vec<Token>, String> {
    Err("token input requires a build with the parity-tokens feature".into())
}

/// One `serve` request line in, one response line out.
pub fn handle_render(line: &str) -> String {
    let result = (|| -> Result<String, String> {
        let request: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
        let source = field(&request, "source")?.as_str().ok_or("bad source")?;
        let options = parse_options(&request)?;
        let tokens = match request.get("tokens") {
            None | Some(Value::Null) => None,
            Some(value) => Some(parse_tokens(value)?),
        };
        let output = render(source, tokens.as_deref(), &options).map_err(|e| e.to_string())?;
        let ranges: Vec<[usize; 2]> = output.code_ranges.iter().map(|&(a, b)| [a, b]).collect();
        Ok(json!({ "text": output.text, "codeRanges": ranges }).to_string())
    })();
    result.unwrap_or_else(|message| error_line(&message))
}

/// One `lex` request line in, one response line out. The adapter is WP-7's.
pub fn handle_lex(line: &str) -> String {
    let result = (|| -> Result<String, String> {
        let request: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
        field(&request, "body")?.as_str().ok_or("bad body")?;
        parse_tier(field(&request, "tier")?)?;
        Err("unimplemented".into())
    })();
    result.unwrap_or_else(|message| error_line(&message))
}
