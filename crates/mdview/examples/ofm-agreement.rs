//! `ofm::parse` vs mdview's lexer over a directory of notes (WP-2 of
//! `plans/ofm-crate-extraction.md`): span self-check failures, unlisted wiki-link
//! disagreements, per-kind item counts, and `parse` vs `lex` total time. Prints aggregates
//! only — never a path, title or note text — so it can run over a private vault.
//!
//! Usage: `cargo run --release -p mdview --example ofm-agreement -- <dir>`

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mdview::frontmatter::split_frontmatter;
use mdview::glyphs::Tier;
use serde_json::Value;

type Key = (String, Option<String>, Option<String>, bool);

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

fn md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for p in rd.filter_map(|e| e.ok().map(|e| e.path())) {
        if p.is_dir() {
            if !p
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'))
            {
                md_files(&p, out);
            }
        } else if p.extension().is_some_and(|e| e == "md") {
            out.push(p);
        }
    }
}

fn main() {
    let Some(dir) = std::env::args().nth(1) else {
        eprintln!("usage: ofm-agreement <dir>");
        std::process::exit(2);
    };
    let mut files = Vec::new();
    md_files(Path::new(&dir), &mut files);
    files.sort();
    let mut sources = Vec::new();
    let mut unreadable = 0usize;
    for f in &files {
        match std::fs::read_to_string(f) {
            Ok(s) => sources.push(s),
            Err(_) => unreadable += 1,
        }
    }
    let bytes: usize = sources.iter().map(String::len).sum();
    let (mut t_parse, mut t_lex) = (Duration::ZERO, Duration::ZERO);
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let mut span_fail: BTreeMap<String, usize> = BTreeMap::new();
    let (mut unlisted, mut fragment_only, mut lexer_total) = (0i64, 0usize, 0usize);
    for s in &sources {
        let t = Instant::now();
        let note = ofm::parse(s);
        t_parse += t.elapsed();
        let t = Instant::now();
        let (_, body) = split_frontmatter(s);
        let tokens = mdview::lex::lex(body, Tier::Unicode);
        t_lex += t.elapsed();
        for b in ofm::check_spans(s, &note) {
            // The message minus its `a..b` span: the item kind and the failed shape only.
            let class: String = b
                .split(' ')
                .filter(|w| !w.contains(".."))
                .collect::<Vec<_>>()
                .join(" ");
            *span_fail.entry(class).or_default() += 1;
        }
        let inline_tags = note
            .tags
            .iter()
            .filter(|t| matches!(t.source, ofm::TagSource::Inline { .. }))
            .count();
        for (k, n) in [
            ("frontmatter", usize::from(note.frontmatter.is_some())),
            (
                "wikilinks",
                note.wikilinks.iter().filter(|w| !w.embed).count(),
            ),
            ("embeds", note.wikilinks.iter().filter(|w| w.embed).count()),
            (
                "md_links",
                note.md_links.iter().filter(|l| !l.image).count(),
            ),
            (
                "md_images",
                note.md_links.iter().filter(|l| l.image).count(),
            ),
            ("tags_inline", inline_tags),
            ("tags_frontmatter", note.tags.len() - inline_tags),
            ("fm_links", note.fm_links.len()),
            ("footnote_refs", note.footnote_refs.len()),
            ("footnote_defs", note.footnote_defs.len()),
            ("callouts", note.callouts.len()),
            ("block_ids", note.block_ids.len()),
            ("headings", note.headings.len()),
            ("tasks", note.tasks.len()),
        ] {
            *kinds.entry(k).or_default() += n;
        }
        let mut lexed = Vec::new();
        lexer_wikis(&serde_json::to_value(&tokens).expect("tokens"), &mut lexed);
        lexer_total += lexed.len();
        let mut count: BTreeMap<Key, i64> = BTreeMap::new();
        for k in lexed {
            *count.entry(k).or_default() -= 1;
        }
        for w in note.wikilinks {
            if w.target.is_empty() {
                fragment_only += 1;
                continue;
            }
            *count
                .entry((w.target, w.fragment, w.alias, w.embed))
                .or_default() += 1;
        }
        unlisted += count.values().map(|n| n.abs()).sum::<i64>();
    }
    let n = sources.len().max(1) as f64;
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "files: {} ({unreadable} unreadable), {bytes} bytes",
        sources.len()
    );
    println!("span-check failures: {}", span_fail.values().sum::<usize>());
    for (k, c) in &span_fail {
        println!("  {k}: {c}");
    }
    println!("unlisted wiki-link disagreements: {unlisted}");
    println!("allowlisted fragment-only (ofm emits, lexer does not): {fragment_only}");
    println!("lexer wiki-links: {lexer_total}");
    println!("per-kind counts:");
    for (k, c) in &kinds {
        println!("  {k}: {c}");
    }
    println!(
        "ofm::parse total: {:.1} ms ({:.4} ms/file)",
        ms(t_parse),
        ms(t_parse) / n
    );
    println!(
        "split+lex total:  {:.1} ms ({:.4} ms/file)",
        ms(t_lex),
        ms(t_lex) / n
    );
}
