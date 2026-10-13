//! The hidden `mdview __parity` subcommand: the JSONL servers the Bun instruments drive
//! (`scripts/revision.ts`'s `rust:` kind; `scripts/lexer-diff.ts` until WP-9, `TS_BASELINE` = `c097c66`). Dispatched only when
//! `args[0] == "__parity"`, and absent from help.
//!
//! - `serve`: one JSON request per line in, one JSON response per line out.
//!   Request `{source, path?, width, tier, ambiguous, policy: {sgr, hyperlinks, tmux}, emoji?,
//!   tokens?}` — `policy` may instead be the string `"env"`, resolved from this process's
//!   environment and stdout (the colour axis); response `{text, codeRanges, frontmatter?: {parsed, diagnostic?, echoRanges}}` or `{error}`.
//! - `lex`: request `{body, tier}`; response `{tokens}` (`crate::lex`, the comrak adapter)
//! - `style-table`: dump the committed SGR table (`style.rs`), one JSON line.
//!
//! **A request never yields a response that could read as a match unless `render` returned
//! output.** Every failure — malformed request, bad options, a render error — is an
//! `{error}` line, which `render-diff` counts as an error and never as a pass.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use crate::render::{Ambiguous, Policy, RenderOptions, Sgr, Tier, render};

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
        // `scripts/gen-hljs-map.ts`'s second input: the syntect set, one JSON line per syntax.
        Some("syntaxes") => {
            let mut out = stdout.lock();
            for syntax in crate::highlight::SYNTAXES.syntaxes() {
                let line = json!({
                    "name": syntax.name,
                    "fileExtensions": syntax.file_extensions,
                    "firstLine": syntax.first_line_match,
                });
                writeln!(out, "{line}").map_err(|e| e.to_string())?;
            }
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

fn parse_emoji(request: &Value) -> Result<Option<bool>, String> {
    match request.get("emoji") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err("bad emoji".into()),
    }
}

/// `policy: "env"` — the policy this server process's own environment and stdout resolve to,
/// with no flag and no config: what `renderDocumentDetailed`'s default policy was at
/// `TS_BASELINE` (`c097c66`), and what the colour axis's four children each measure
/// (`scripts/colour-axis.ts`). The server's stdout is a pipe, so `isTTY` is false.
fn env_policy() -> Policy {
    use crate::colour::{ColourPolicyInput, Env, resolve_colour_policy};
    let env: Env = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect();
    resolve_colour_policy(&ColourPolicyInput {
        flag: None,
        config: None,
        hyperlink_flag: None,
        hyperlink_config: None,
        env: Some(&env),
        is_tty: Some(rustix::termios::isatty(std::io::stdout())),
        platform: Some(std::env::consts::OS),
        warn: None,
    })
}

/// A `serve` request's render options; also the golden replay's, so a malformed record fails.
pub fn parse_options(request: &Value) -> Result<RenderOptions, String> {
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
    if policy.as_str() == Some("env") {
        return Ok(RenderOptions {
            width,
            tier,
            ambiguous,
            policy: env_policy(),
            emoji: parse_emoji(request)?,
            path: None,
            highlight_as: Default::default(),
        });
    }
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
    let emoji = parse_emoji(request)?;
    let path = request
        .get("path")
        .and_then(Value::as_str)
        // `resolve(path)` (`scripts/revision.ts`'s `resolverFor`): absolute against the cwd.
        .map(|p| {
            let cwd = std::env::current_dir()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default();
            crate::wikiresolve::resolve(&cwd, p)
        });
    // `highlightAs`: optional; the TS side's default resolver is an empty map.
    let highlight_as = match request.get("highlightAs") {
        None | Some(Value::Null) => Default::default(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| Ok((k.clone(), v.as_str().ok_or("bad highlightAs")?.to_owned())))
            .collect::<Result<_, String>>()?,
        Some(_) => return Err("bad highlightAs".into()),
    };
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
        highlight_as,
    })
}

/// One `serve` request line in, one response line out.
pub fn handle_render(line: &str) -> String {
    let result = (|| -> Result<String, String> {
        let request: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
        let source = field(&request, "source")?.as_str().ok_or("bad source")?;
        let options = parse_options(&request)?;
        if !matches!(request.get("tokens"), None | Some(Value::Null)) {
            return Err("token input was removed (plans/retire-ts-parity-residue.md WP-2)".into());
        }
        let output = render(source, None, &options).map_err(|e| e.to_string())?;
        let ranges: Vec<[usize; 2]> = output.code_ranges.iter().map(|&(a, b)| [a, b]).collect();
        let mut response = json!({ "text": output.text, "codeRanges": ranges });
        // The frontmatter facts D-A's predicate reads (`scripts/divergences.ts`, `RenderSide`).
        if let Some(fm) = &output.frontmatter {
            let mut facts = json!({ "parsed": fm.parsed });
            if let Some((start, end)) = fm.diagnostic {
                facts["diagnostic"] = json!([start, end]);
            }
            // How many of `codeRanges`' leading entries are frontmatter-echo ranges — what
            // `scripts/revision.ts`'s measurer read from `formatMetaBlockDetailed` before WP-9.
            facts["echoRanges"] = json!(fm.echo_ranges);
            response["frontmatter"] = facts;
        }
        Ok(response.to_string())
    })();
    result.unwrap_or_else(|message| error_line(&message))
}

/// One `lex` request line in, one response line out (`crate::lex::lex`).
pub fn handle_lex(line: &str) -> String {
    let result = (|| -> Result<String, String> {
        let request: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
        let body = field(&request, "body")?.as_str().ok_or("bad body")?;
        let tier = parse_tier(field(&request, "tier")?)?;
        let tokens = crate::lex::lex(body, tier);
        Ok(json!({ "tokens": tokens }).to_string())
    })();
    result.unwrap_or_else(|message| error_line(&message))
}
