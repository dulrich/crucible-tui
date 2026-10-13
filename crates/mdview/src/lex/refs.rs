//! Link reference definitions: the labels comrak consumed into its private refmap.

use super::*;

/// A reference label's lookup key: comrak's normalization (trim, collapse whitespace, case
/// fold), approximated with Unicode lowercase.
pub(super) fn fold_label(l: &str) -> String {
    l.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Every link reference definition comrak recognised in `src`: the def-shaped lines no leaf
/// block covers (comrak consumes definitions into its private refmap, so they are the lines
/// between leaves), resolved by comrak itself in a probe document that uses each label once.
pub(super) fn reference_definitions<'a>(
    root: &'a AstNode<'a>,
    src: &str,
) -> HashMap<String, ResolvedReference> {
    let lines: Vec<&str> = src.split('\n').collect();
    let mut covered = vec![false; lines.len() + 1];
    for n in root.descendants() {
        let leaf = matches!(
            n.data().value,
            NodeValue::Paragraph
                | NodeValue::Heading(_)
                | NodeValue::CodeBlock(_)
                | NodeValue::HtmlBlock(_)
                | NodeValue::Table(_)
                | NodeValue::ThematicBreak
        );
        if leaf {
            let sp = n.data().sourcepos;
            let end = sp.end.line.min(lines.len());
            if sp.start.line <= end {
                covered[sp.start.line..=end].fill(true);
            }
        }
    }
    let mut defs = String::new();
    let mut labels: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if covered[i + 1] {
            continue;
        }
        let t = line.trim_start_matches([' ', '\t', '>']);
        let Some(rest) = t.strip_prefix('[') else {
            continue;
        };
        let Some(close) = rest.find("]:") else {
            continue;
        };
        let label = &rest[..close];
        if label.trim().is_empty() || label.contains('[') {
            continue;
        }
        defs.push_str(t);
        defs.push('\n');
        labels.push(label.to_string());
    }
    let mut out = HashMap::new();
    if labels.is_empty() {
        return out;
    }
    // Each probe is its own paragraph, on line `first + 2k` (1-based).
    let first = defs.matches('\n').count() + 2;
    let mut probe = defs;
    for l in &labels {
        probe.push_str("\n[");
        probe.push_str(l);
        probe.push_str("]\n");
    }
    let arena = Arena::new();
    let proot = parse_document(&arena, &probe, &options());
    for n in proot.descendants() {
        if let NodeValue::Link(link) = &n.data().value {
            let line = n.data().sourcepos.start.line;
            if line < first || !(line - first).is_multiple_of(2) {
                continue;
            }
            if let Some(l) = labels.get((line - first) / 2) {
                out.entry(fold_label(l))
                    .or_insert_with(|| ResolvedReference {
                        url: link.url.clone(),
                        title: link.title.clone(),
                    });
            }
        }
    }
    out
}
