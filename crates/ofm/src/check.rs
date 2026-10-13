//! The span self-check (invariant (b) of `plans/ofm-crate-extraction.md` WP-2): every item's
//! span re-reads, from the source alone, as that item.

use crate::note::{LinkKind, Note, Span, TagSource};
use crate::wikilink::match_wikilink_with;

/// Every span in `note` that does not re-read as its item, one message each (empty: all hold).
pub fn check_spans(source: &str, note: &Note) -> Vec<String> {
    let mut bad = Vec::new();
    let slice = |what: &str, span: &Span, bad: &mut Vec<String>| -> Option<String> {
        let s = source.get(span.clone());
        if s.is_none() {
            bad.push(format!(
                "{what} {span:?}: not a char-boundary range of the source"
            ));
        }
        s.map(str::to_string)
    };
    if let Some(fm) = &note.frontmatter
        && let Some(s) = slice("frontmatter", &fm.span, &mut bad)
        && (!s.starts_with("---") || fm.span.end != note.body_offset)
    {
        bad.push(format!("frontmatter {:?}: not the fenced block", fm.span));
    }
    for w in &note.wikilinks {
        let Some(s) = slice("wikilink", &w.span, &mut bad) else {
            continue;
        };
        let s = if w.in_table { s.replace("\\|", "|") } else { s };
        let ok = match_wikilink_with(&s, true).is_some_and(|(len, m)| {
            len == s.len()
                && m.slug == w.target
                && m.fragment == w.fragment
                && m.alias == w.alias
                && m.embed == w.embed
        });
        if !ok {
            bad.push(format!(
                "wikilink {:?}: does not re-match its parts",
                w.span
            ));
        }
    }
    for t in &note.tags {
        if let TagSource::Inline { span } = &t.source
            && let Some(s) = slice("tag", span, &mut bad)
            && s.strip_prefix('#') != Some(t.name.as_str())
        {
            bad.push(format!("tag {span:?}: not `#` + name"));
        }
    }
    for b in &note.block_ids {
        if let Some(s) = slice("block id", &b.span, &mut bad)
            && s.strip_prefix('^') != Some(b.id.as_str())
        {
            bad.push(format!("block id {:?}: not `^` + id", b.span));
        }
    }
    for f in &note.footnote_refs {
        if let Some(s) = slice("footnote ref", &f.span, &mut bad)
            && !s.eq_ignore_ascii_case(&format!("[^{}]", f.label))
        {
            bad.push(format!("footnote ref {:?}: not `[^label]`", f.span));
        }
    }
    for f in &note.footnote_defs {
        if let Some(s) = slice("footnote def", &f.span, &mut bad)
            && !s
                .to_lowercase()
                .starts_with(&format!("[^{}]:", f.label.to_lowercase()))
        {
            bad.push(format!("footnote def {:?}: not `[^label]:`", f.span));
        }
    }
    for l in &note.md_links {
        let Some(s) = slice("md link", &l.span, &mut bad) else {
            continue;
        };
        let ok = match l.kind {
            LinkKind::Bracketed => s.starts_with(if l.image { "![" } else { "[" }),
            LinkKind::Angle => s
                .strip_prefix('<')
                .and_then(|r| r.strip_suffix('>'))
                .is_some_and(|inner| {
                    l.dest_raw == inner || l.dest_raw == format!("mailto:{inner}")
                }),
            LinkKind::Bare => {
                l.dest_raw == s
                    || l.dest_raw == format!("http://{s}")
                    || l.dest_raw == format!("mailto:{s}")
            }
        };
        if !ok {
            bad.push(format!("md link {:?}: not its {:?} shape", l.span, l.kind));
        }
    }
    for c in &note.callouts {
        if let Some(s) = slice("callout", &c.span, &mut bad)
            && !(s.trim_start().starts_with('>') && s.contains("[!"))
        {
            bad.push(format!(
                "callout {:?}: not a `> [!kind]` blockquote",
                c.span
            ));
        }
    }
    for h in &note.headings {
        slice("heading", &h.span, &mut bad);
    }
    for t in &note.tasks {
        if let Some(s) = slice("task", &t.span, &mut bad)
            && !s.contains(&format!("[{}]", t.status))
        {
            bad.push(format!("task {:?}: no `[{}]`", t.span, t.status));
        }
    }
    bad
}
