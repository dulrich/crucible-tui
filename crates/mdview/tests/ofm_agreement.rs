//! The `ofm::parse` agreement differential (WP-2 of `plans/ofm-crate-extraction.md`): over every
//! golden `source` and every `tests/fixtures/**/*.md`, the multiset of wiki-links mdview's lexer
//! emits equals `ofm::parse`'s apart from the listed disagreement classes, and every `ofm` span
//! self-verifies (`ofm::check_spans`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use mdview::frontmatter::split_frontmatter;
use mdview::glyphs::Tier;
use serde_json::Value;

/// `(target, fragment, alias, embed)`.
type Key = (String, Option<String>, Option<String>, bool);

/// The allowlisted disagreement classes, each with its reason. Anything else fails.
///
/// - **fragment-only** (ofm emits, lexer does not): `[[#heading]]`/`[[#^block]]` link to the
///   note itself in Obsidian (invariant (e)); mdview's lexer keeps its empty-slug refusal so its
///   rendering stays byte-identical.
fn allowlisted(k: &Key) -> Option<&'static str> {
    k.0.is_empty().then_some("fragment-only")
}

fn lexer_wikis(v: &Value, out: &mut Vec<Key>) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| lexer_wikis(x, out)),
        Value::Object(o) => {
            if o.get("type").and_then(Value::as_str) == Some("wikilink") {
                let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_string);
                out.push((
                    s("slug").unwrap_or_default(),
                    s("fragment"),
                    s("alias"),
                    o.get("embed").and_then(Value::as_bool).unwrap_or(false),
                ));
                return;
            }
            o.values().for_each(|x| lexer_wikis(x, out));
        }
        _ => {}
    }
}

/// The unlisted disagreements and span-check failures for one source, and its wiki-link count.
fn check(source: &str) -> (Vec<String>, usize) {
    let note = ofm::parse(source);
    let mut bad = ofm::check_spans(source, &note);
    let (_, body) = split_frontmatter(source);
    let tokens = serde_json::to_value(mdview::lex::lex(body, Tier::Unicode)).expect("tokens");
    let mut lexed = Vec::new();
    lexer_wikis(&tokens, &mut lexed);
    let n_wikis = note.wikilinks.len();
    let mut count: BTreeMap<Key, i64> = BTreeMap::new();
    for k in lexed {
        *count.entry(k).or_default() -= 1;
    }
    for w in note.wikilinks {
        let k = (w.target, w.fragment, w.alias, w.embed);
        if allowlisted(&k).is_none() {
            *count.entry(k).or_default() += 1;
        }
    }
    for (k, n) in count {
        if n != 0 {
            bad.push(format!("wikilink {k:?}: ofm minus lexer = {n}"));
        }
    }
    (bad, n_wikis)
}

fn md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            md_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

#[test]
fn ofm_agrees_with_the_lexer_and_spans_self_verify() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let golden =
        std::fs::read_to_string(manifest.join("tests/golden/render.jsonl")).expect("golden");
    let mut sources: Vec<(String, String)> = Vec::new();
    for (i, line) in golden.lines().enumerate().skip(1) {
        let v: Value = serde_json::from_str(line).expect("record");
        if let Some(s) = v.get("source").and_then(Value::as_str) {
            sources.push((format!("render.jsonl:{}", i + 1), s.to_string()));
        }
    }
    let mut files = Vec::new();
    md_files(&manifest.join("../../tests/fixtures"), &mut files);
    assert!(!files.is_empty(), "no fixtures found");
    for f in files {
        let s = std::fs::read_to_string(&f).expect("fixture");
        sources.push((f.display().to_string(), s));
    }
    let mut failures = Vec::new();
    let mut wikis = 0;
    for (name, s) in &sources {
        let (bad, n) = check(s);
        wikis += n;
        for b in bad {
            failures.push(format!("{name}: {b}\n  source: {s:?}"));
        }
    }
    // The corpus is not vacuous (191 wiki-links at WP-2).
    assert!(
        wikis > 150,
        "only {wikis} wiki-links over {} sources",
        sources.len()
    );
    assert!(
        failures.is_empty(),
        "{} failures over {} sources:\n{}",
        failures.len(),
        sources.len(),
        failures.join("\n")
    );
}
