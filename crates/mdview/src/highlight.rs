//! The syntax colorizer, ported from `TS_BASELINE` `src/highlight.ts` (WP-6a of `plans/mdview-rust-port.md`)
//! over syntect + two-face in place of highlight.js 10.7.3.
//!
//! **D-C governs this module.** The two engines tokenize differently, so colour-on fence output
//! is judged with SGR stripped; the visible text must still be exactly what the TS path
//! produces. What the TS path does to the *text* is therefore transcribed exactly, and only the
//! span choice differs:
//!
//! - `decodeEntities` (`highlight.ts:139-165`): highlight.js escapes the source and the
//!   colorizer decodes its own five entities, so entities are an identity on the text. What is
//!   not an identity is the HTML parser's input normalization the TS colorizer reproduces:
//!   `\r\n` and a lone `\r` become `\n` (`CR_PATTERN`, `highlight.ts:139`) and a NUL is dropped
//!   (`NUL_PATTERN`, `highlight.ts:157`). [`normalize_text`] is those two passes.
//! - **Both call branches** (`highlight.ts:263`): a truthy language takes `hljs.highlight`, an
//!   absent or empty one `highlightAuto`. syntect has no auto-detection; the auto branch here
//!   tries `find_syntax_by_first_line` (shebangs, mode lines) and is plain otherwise.
//! - The theme is [`THEME`], keyed by the retired highlight.js vocabulary (`highlight.ts:89`);
//!   syntect scopes reach a key through [`SCOPE_MAP`]. Every escape is written by
//!   `style.rs`'s `apply_style_chain`, so every generated SGR is in the committed table.
//! - **Nesting**: TS applies innermost-first and lets the parent wrap the styled child. Here a
//!   token takes the chain of the innermost scope on its stack that maps to a key with a
//!   non-null chain. That changes SGR only (D-C).
//! - Newlines are emitted outside any span, so a styled run never straddles a line.
//!
//! The syntax set loads lazily, once per process ([`SYNTAXES`]), on the first fence that needs
//! it; a fence resolved to `plaintext` never loads it. The set is two-face's plus the grammars
//! vendored under `crates/mdview/syntaxes/` (PowerShell), precompiled by `build.rs`.

use std::sync::LazyLock;

use syntect::easy::ScopeRangeIterator;
use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

use crate::style::{Sgr, StyleName, apply_style_chain};

use StyleName::{Blue, Bold, Cyan, Dim, Gray, Green, Italic, Red, Underline, Yellow};

/// The theme, total over the retired `cli-highlight` key vocabulary (`highlight.ts:89-132`).
/// An empty chain is the retired `plain` (`null` in TS).
pub const THEME: &[(&str, &[StyleName])] = &[
    ("keyword", &[Blue]),
    ("built_in", &[Cyan]),
    ("type", &[Cyan, Dim]),
    ("literal", &[Blue]),
    ("number", &[Green]),
    ("regexp", &[Red]),
    ("string", &[Red]),
    ("subst", &[]),
    ("symbol", &[]),
    ("class", &[Blue]),
    ("function", &[Yellow]),
    ("title", &[]),
    ("params", &[]),
    ("comment", &[Green]),
    ("doctag", &[Green]),
    ("meta", &[Gray]),
    ("meta-keyword", &[]),
    ("meta-string", &[]),
    ("section", &[]),
    ("tag", &[Gray]),
    ("name", &[Blue]),
    ("builtin-name", &[]),
    ("attr", &[Cyan]),
    ("attribute", &[]),
    ("variable", &[]),
    ("bullet", &[]),
    ("code", &[]),
    ("emphasis", &[Italic]),
    ("strong", &[Bold]),
    ("formula", &[]),
    ("link", &[Underline]),
    ("quote", &[]),
    ("selector-tag", &[]),
    ("selector-id", &[]),
    ("selector-class", &[]),
    ("selector-attr", &[]),
    ("selector-pseudo", &[]),
    ("template-tag", &[]),
    ("template-variable", &[]),
    ("addition", &[Green]),
    ("deletion", &[Red]),
    ("default", &[]),
];

/// syntect scope prefix → theme key, first match wins (so the more specific prefix comes
/// first). A prefix matches a scope when it equals it or is followed by `.`. The source of each
/// row is the Sublime/TextMate scope-naming convention against highlight.js's class names for
/// the same construct.
pub const SCOPE_MAP: &[(&str, &str)] = &[
    ("comment", "comment"),
    ("string.regexp", "regexp"),
    ("string", "string"),
    ("constant.numeric", "number"),
    ("constant.language", "literal"),
    ("constant.other.symbol", "symbol"),
    ("constant.character.escape", "subst"),
    ("keyword.operator", "default"),
    ("keyword", "keyword"),
    ("storage.type.primitive", "type"),
    ("storage", "keyword"),
    ("support.type", "type"),
    ("support.class", "type"),
    ("support.function", "built_in"),
    ("support.constant", "built_in"),
    ("entity.name.function", "function"),
    ("entity.name.class", "class"),
    ("entity.name.type", "class"),
    ("entity.name.tag", "name"),
    ("entity.other.attribute-name", "attr"),
    ("entity.name.section", "section"),
    ("meta.preprocessor", "meta"),
    ("meta.annotation", "meta"),
    ("meta.tag", "tag"),
    ("variable", "variable"),
    ("markup.inserted", "addition"),
    ("markup.deleted", "deletion"),
    ("markup.italic", "emphasis"),
    ("markup.bold", "strong"),
    ("markup.underline.link", "link"),
    ("markup.heading", "section"),
    ("markup.quote", "quote"),
    ("markup.raw", "code"),
    ("markup.list", "bullet"),
];

/// two-face's extended grammar set (newline variant) plus the vendored grammars under
/// `crates/mdview/syntaxes/` (PowerShell), dumped by `build.rs`; loaded once per process on
/// first use.
pub static SYNTAXES: LazyLock<SyntaxSet> = LazyLock::new(|| {
    syntect::dumps::from_uncompressed_data(include_bytes!(concat!(
        env!("OUT_DIR"),
        "/syntaxes.bin"
    )))
    .expect("build.rs wrote a valid syntax dump")
});

fn theme_chain(key: &str) -> &'static [StyleName] {
    THEME
        .iter()
        .find(|(k, _)| *k == key)
        .map_or(&[], |(_, chain)| chain)
}

fn scope_key(scope: &str) -> Option<&'static str> {
    SCOPE_MAP.iter().find_map(|(prefix, key)| {
        let hit = scope == *prefix
            || (scope.starts_with(prefix) && scope.as_bytes().get(prefix.len()) == Some(&b'.'));
        hit.then_some(*key)
    })
}

/// The key and chain for a token: the innermost scope that maps to a key, empty if none does.
fn chain_for(stack: &ScopeStack) -> (Option<&'static str>, &'static [StyleName]) {
    for scope in stack.as_slice().iter().rev() {
        if let Some(key) = scope_key(&scope.build_string()) {
            return (Some(key), theme_chain(key));
        }
    }
    (None, &[])
}

/// `decodeEntities`' effect on the text: `\r\n?` → `\n`, then NUL dropped.
pub fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\u{0}', "")
}

fn plaintext(language: &str) -> bool {
    matches!(language, "plaintext" | "text" | "txt")
}

include!("hljs_map.rs");

/// The one fence-language lookup both consumers share (the renderer's resolver through
/// [`supports_language`]/`pick_runs`, and `mdview highlight-as`'s validator): syntect's own
/// token lookup first, then the generated highlight.js-name table ([`HLJS_TO_SYNTECT`]).
/// `name` is already lower-cased.
fn find_syntax(name: &str) -> Option<&'static syntect::parsing::SyntaxReference> {
    SYNTAXES.find_syntax_by_token(name).or_else(|| {
        HLJS_TO_SYNTECT
            .iter()
            .find(|(k, _)| *k == name)
            .and_then(|(_, target)| SYNTAXES.find_syntax_by_name(target))
    })
}

/// `supportsLanguage`: highlight.js's `getLanguage` lower-cases, so this does too; the
/// `plaintext` grammar (and its `text`/`txt` aliases) is always known, as it was to hljs.
pub fn supports_language(name: &str) -> bool {
    let lower = name.to_lowercase();
    plaintext(&lower) || (!lower.is_empty() && find_syntax(&lower).is_some())
}

/// The auto branch's candidates (`highlightAuto` tries every registered grammar; syntect has
/// no relevance score, so this is a bounded list of the corpus's common fence languages).
const AUTO_CANDIDATES: &[&str] = &[
    "bash",
    "python",
    "javascript",
    "typescript",
    "json",
    "yaml",
    "sql",
    "rust",
    "go",
    "c",
    "java",
    "html",
    "css",
];

/// Keys that count toward an auto-detection score — the analogue of hljs relevance: a
/// grammar earns a point for each run it recognises as one of these.
const SCORING_KEYS: &[&str] = &[
    "keyword", "built_in", "literal", "number", "function", "type", "class", "string", "comment",
    "name", "attr", "tag",
];

type Run = (&'static [StyleName], String);

/// Tokenize `text` with `syntax` into styled runs (adjacent same-chain ranges coalesced,
/// newlines kept as text). A grammar error turns the rest of the fence into one plain run.
fn runs(syntax: &SyntaxReference, text: &str) -> (Vec<Run>, usize) {
    let mut out: Vec<Run> = Vec::new();
    let mut score = 0usize;
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut broken = false;
    let push = |chain: &'static [StyleName], piece: &str, out: &mut Vec<Run>| match out.last_mut() {
        Some((c, t)) if *c == chain => t.push_str(piece),
        _ => out.push((chain, piece.to_owned())),
    };
    for line in LinesWithEndings::from(text) {
        if broken {
            push(&[], line, &mut out);
            continue;
        }
        let Ok(ops) = state.parse_line(line, &SYNTAXES) else {
            broken = true;
            push(&[], line, &mut out);
            continue;
        };
        for (range, op) in ScopeRangeIterator::new(&ops, line) {
            if stack.apply(op).is_err() {
                stack = ScopeStack::new();
            }
            if range.is_empty() {
                continue;
            }
            let (key, chain) = chain_for(&stack);
            if key.is_some_and(|k| SCORING_KEYS.contains(&k))
                && !line[range.clone()].trim().is_empty()
            {
                score += 1;
            }
            push(chain, &line[range], &mut out);
        }
    }
    (out, score)
}

/// The runs a call produces, or `None` for plain text: the named grammar, or for the auto
/// branch a first-line match, else the best-scoring candidate with a non-zero score.
fn pick_runs(code: &str, language: Option<&str>) -> Option<Vec<Run>> {
    if let Some(l) = language.filter(|l| !l.is_empty()) {
        let lower = l.to_lowercase();
        if plaintext(&lower) {
            return None;
        }
        return find_syntax(&lower).map(|syntax| runs(syntax, code).0);
    }
    let first = code.lines().next().unwrap_or("");
    if let Some(syntax) = SYNTAXES.find_syntax_by_first_line(first) {
        return Some(runs(syntax, code).0);
    }
    let mut best: Option<(usize, Vec<Run>)> = None;
    for name in AUTO_CANDIDATES {
        let Some(syntax) = SYNTAXES.find_syntax_by_token(name) else {
            continue;
        };
        let (r, score) = runs(syntax, code);
        if score > 0 && best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, r));
        }
    }
    best.map(|(_, r)| r)
}

fn push_styled(out: &mut String, sgr: Sgr, chain: &[StyleName], text: &str) {
    for (i, part) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        if part.is_empty() {
            continue;
        }
        if chain.is_empty() {
            out.push_str(part);
        } else {
            out.push_str(&apply_style_chain(sgr, chain, part));
        }
    }
}

/// `highlightToAnsi(ctx, code, language)`. Never fails: a grammar error degrades the rest of
/// the fence to plain text rather than throwing (the TS `catch` path is unreachable here,
/// because `resolveFenceLanguage` only hands over a supported name or `plaintext`).
pub fn highlight_to_ansi(sgr: Sgr, code: &str, language: Option<&str>) -> String {
    let text = normalize_text(code);
    let Some(runs) = pick_runs(&text, language) else {
        return text;
    };
    let mut out = String::with_capacity(text.len() * 2);
    for (chain, piece) in &runs {
        push_styled(&mut out, sgr, chain, piece);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::list_lines::strip_ansi;

    #[test]
    fn theme_is_total_over_the_retired_vocabulary() {
        assert_eq!(THEME.len(), 42);
        for (_, key) in SCOPE_MAP {
            assert!(THEME.iter().any(|(k, _)| k == key), "{key}");
        }
    }

    #[test]
    fn text_survives_stripping() {
        for (code, lang) in [
            ("fn main() { let x = \"a&b<c>\"; }\n// c", Some("rust")),
            ("def f(x):\n    return 1  # c\n", Some("python")),
            ("SELECT * FROM t WHERE a = 'x';", Some("sql")),
            ("#!/bin/sh\necho hi", None),
            ("x", Some("")),
            ("plain", Some("plaintext")),
        ] {
            let out = highlight_to_ansi(Sgr::Full, code, lang);
            assert_eq!(strip_ansi(&out), code, "{lang:?}");
        }
    }

    #[test]
    fn colour_is_applied_for_a_known_language() {
        let out = highlight_to_ansi(Sgr::Full, "let x = 1; // hi", Some("javascript"));
        assert!(out.contains("\u{1b}[34m"), "{out:?}");
        assert!(out.contains("\u{1b}[32m"), "{out:?}");
    }

    #[test]
    fn vendored_powershell_grammar_highlights() {
        let code = "# greet\n$Name = 'World'\nWrite-Host \"Hello, $Name\"";
        for lang in ["powershell", "ps", "ps1"] {
            let out = highlight_to_ansi(Sgr::Full, code, Some(lang));
            assert!(out.contains('\u{1b}'), "{lang}: {out:?}");
            assert_eq!(crate::list_lines::strip_ansi(&out), code, "{lang}");
        }
    }

    #[test]
    fn plaintext_and_off_are_plain() {
        assert_eq!(
            highlight_to_ansi(Sgr::Full, "let x", Some("plaintext")),
            "let x"
        );
        assert_eq!(
            highlight_to_ansi(Sgr::None, "let x = 1;", Some("rust")),
            "let x = 1;"
        );
    }

    #[test]
    fn carriage_returns_normalize_and_nul_drops() {
        assert_eq!(normalize_text("a\r\nb\rc\u{0}d"), "a\nb\ncd");
        assert_eq!(
            strip_ansi(&highlight_to_ansi(Sgr::Full, "a\r\nb", Some("rust"))),
            "a\nb"
        );
    }

    #[test]
    fn no_span_straddles_a_newline() {
        let out = highlight_to_ansi(Sgr::Full, "/* a\nb */", Some("c"));
        for line in out.split('\n') {
            assert!(!line.ends_with('\u{1b}'));
        }
        assert_eq!(strip_ansi(&out), "/* a\nb */");
    }

    #[test]
    fn supports_language_matches_known_grammars() {
        for l in [
            "rust",
            "Python",
            "js",
            "javascript",
            "sql",
            "plaintext",
            "text",
        ] {
            assert!(supports_language(l), "{l}");
        }
        assert!(!supports_language("no-such-language"));
        assert!(!supports_language(""));
    }

    #[test]
    fn scope_prefixes_match_on_atom_boundaries() {
        assert_eq!(scope_key("string.quoted.double"), Some("string"));
        assert_eq!(scope_key("stringy"), None);
        assert_eq!(scope_key("keyword.operator.arith"), Some("default"));
        assert_eq!(scope_key("keyword.control"), Some("keyword"));
    }
}
