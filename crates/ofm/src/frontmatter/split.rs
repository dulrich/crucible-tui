//! `splitFrontmatter`: the fence test and the `(meta, body)` cut (`TS_BASELINE` `src/frontmatter.ts`).

use std::sync::LazyLock;

use regex::Regex;

use crate::js::{JS_WS_CLASS, js_trim};

pub(super) static FIRST_KEY_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[^{JS_WS_CLASS}:#][^:\n]*:(?:[{JS_WS_CLASS}]|$)"
    ))
    .expect("first-key regex compiles")
});

pub(super) fn looks_like_yaml_block(candidate: &str) -> bool {
    candidate
        .split('\n')
        .find(|line| !js_trim(line).is_empty())
        .is_some_and(|line| FIRST_KEY_LINE.is_match(js_trim(line)))
}

pub(super) fn normalize_line_endings(block: &str) -> String {
    let s = block.replace("\r\n", "\n");
    match s.strip_suffix('\r') {
        Some(t) => t.to_owned(),
        None => s,
    }
}

pub(super) fn strip_cr(s: &str) -> &str {
    s.strip_suffix('\r').unwrap_or(s)
}

/// `splitFrontmatter`: `(meta, body)`.
pub fn split_frontmatter(source: &str) -> (Option<String>, &str) {
    let Some(first_newline) = source.find('\n') else {
        return (None, source);
    };
    if strip_cr(&source[..first_newline]) != "---" {
        return (None, source);
    }
    let yaml_start = first_newline + 1;
    let mut line_start = yaml_start;
    while line_start <= source.len() {
        let next_newline = source[line_start..].find('\n').map(|i| i + line_start);
        let line_end = next_newline.unwrap_or(source.len());
        let line = strip_cr(&source[line_start..line_end]);
        if line == "---" {
            let yaml_end = if line_start > yaml_start && source.as_bytes()[line_start - 1] == b'\n'
            {
                line_start - 1
            } else {
                line_start
            };
            let candidate = &source[yaml_start..yaml_end];
            if !looks_like_yaml_block(candidate) {
                break;
            }
            let body = next_newline.map_or("", |n| &source[n + 1..]);
            return (Some(normalize_line_endings(candidate)), body);
        }
        match next_newline {
            None => break,
            Some(n) => line_start = n + 1,
        }
    }
    (None, source)
}
