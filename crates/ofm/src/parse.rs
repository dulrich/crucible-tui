//! `ofm::parse`: one comrak pass over the body plus an AST walk, every item spanned in the
//! original source's bytes (`plans/ofm-crate-extraction.md` WP-2, invariants (a)–(e)).
//!
//! **Coordinates.** comrak parses the body exactly as given except two same-width-or-shifted
//! stand-ins: a NUL becomes U+0001 (comrak would widen it to U+FFFD, 3 bytes), and a leading
//! U+FEFF is cut off and folded into the body offset (comrak strips it). Line starts follow
//! comrak's line endings (`\n`, `\r\n`, lone `\r`), so a CRLF file spans correctly.
//!
//! **Inline items are read from the source, not from comrak's text.** Each inline container
//! (paragraph, heading, table cell, emphasis, link label) is a *view* of the source; comrak's
//! non-text inline nodes (code, HTML, links, escapes, footnote references, …) are only used as
//! exclusion zones, and the gaps between them are tokenized for wiki-links, tags and block
//! ids. This mirrors mdview's lexer (`lex/inline.rs` `inline_seq`): a wiki-link may start in
//! any gap and run on to the container's end. A table cell's view is the cell after the
//! `\|` → `|` unescape, with each byte's source offset kept, because comrak reports a cell's
//! inline sourcepos in that unescaped string's coordinates (mdview `lex/mod.rs` `Scope::cell`).

use std::borrow::Cow;

use comrak::nodes::{AstNode, NodeValue};
use comrak::{Arena, Options, parse_document};

use crate::frontmatter::{JsValue, parse_frontmatter, split_frontmatter};
use crate::note::{
    BlockId, Callout, FmLink, Footnote, Frontmatter, Heading, LinkDest, LinkKind, MdLink, Note,
    Tag, TagSource, Task, WikiLink,
};
use crate::wikilink::{Wiki, match_wikilink_with};

type N<'a> = &'a AstNode<'a>;

/// `ofm::parse`'s comrak options: [`crate::comrak_options`] plus footnotes, definitions left in
/// place (audit E1).
fn options() -> Options<'static> {
    let mut o = crate::comrak_options();
    o.extension.footnotes = true;
    o.parse.leave_footnote_definitions = true;
    o
}

/// Parse `source` (a whole note, frontmatter included). Pure, infallible, deterministic.
pub fn parse(source: &str) -> Note {
    let (meta, body) = split_frontmatter(source);
    let mut off = source.len() - body.len();
    let mut note = Note {
        body_offset: off,
        ..Note::default()
    };
    if let Some(raw) = meta {
        let value = parse_frontmatter(&raw);
        if let Ok(v) = &value {
            frontmatter_items(v, &mut note);
        }
        note.frontmatter = Some(Frontmatter {
            span: 0..off,
            raw,
            value,
        });
    }
    let mut body = body;
    if let Some(rest) = body.strip_prefix('\u{feff}') {
        off += '\u{feff}'.len_utf8();
        body = rest;
    }
    let prepared: Cow<str> = if body.contains('\0') {
        Cow::Owned(body.replace('\0', "\u{1}"))
    } else {
        Cow::Borrowed(body)
    };
    let arena = Arena::new();
    let root = parse_document(&arena, &prepared, &options());
    let mut w = Walk {
        src: &prepared,
        off,
        line_starts: line_starts(&prepared),
        note: &mut note,
        tab_shift: None,
    };
    w.block(root);
    note
}

/// The byte offset of every line start, by comrak's line endings.
fn line_starts(s: &str) -> Vec<usize> {
    let b = s.as_bytes();
    let mut v = vec![0];
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\n' => v.push(i + 1),
            b'\r' if b.get(i + 1) != Some(&b'\n') => v.push(i + 1),
            _ => {}
        }
        i += 1;
    }
    v
}

fn frontmatter_items(v: &JsValue, note: &mut Note) {
    let JsValue::Obj(obj) = v else {
        return;
    };
    for (key, value) in obj.entries() {
        if key == "tags" {
            let mut push = |t: &str| {
                let name = t.trim().trim_start_matches('#');
                if is_tag_name(name) {
                    note.tags.push(Tag {
                        name: name.to_string(),
                        source: TagSource::Frontmatter,
                    });
                }
            };
            match value {
                JsValue::Str(s) => s
                    .split(|c: char| c == ',' || c.is_whitespace())
                    .for_each(&mut push),
                JsValue::Arr(items) => items.iter().for_each(|i| {
                    if let JsValue::Str(s) = i {
                        push(s);
                    }
                }),
                _ => {}
            }
        }
        let mut link = |s: &str| {
            let s = s.trim();
            if let Some((len, w)) = match_wikilink_with(s, true)
                && len == s.len()
            {
                note.fm_links.push(FmLink {
                    key: key.to_string(),
                    target: w.slug,
                    fragment: w.fragment,
                    alias: w.alias,
                    embed: w.embed,
                });
            }
        };
        match value {
            JsValue::Str(s) => link(s),
            JsValue::Arr(items) => items.iter().for_each(|i| {
                if let JsValue::Str(s) = i {
                    link(s);
                }
            }),
            _ => {}
        }
    }
}

/// A tag-name character (Obsidian: letters, digits, `_`, `-`, `/`, and non-ASCII non-space,
/// non-punctuation characters such as emoji).
fn is_tag_char(c: char) -> bool {
    if c.is_ascii() {
        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/')
    } else {
        !c.is_whitespace()
            && !matches!(c, '\u{2000}'..='\u{206f}' | '\u{3000}'..='\u{303f}' | '\u{ff01}'..='\u{ff0f}' | '\u{feff}')
    }
}

/// Obsidian's tag grammar: tag characters, at least one of them not a digit.
fn is_tag_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(is_tag_char) && !name.chars().all(|c| c.is_ascii_digit())
}

fn is_block_id_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-'
}

/// A source view: `s[i]` sits at body offset `doc(i)`.
struct View<'a> {
    s: Cow<'a, str>,
    /// comrak reports this view's inline sourcepos as `base + index`.
    base: usize,
    /// Per-byte body offsets, for an unescaped table cell; identity (`base + i`) otherwise.
    offs: Option<Vec<usize>>,
}

impl View<'_> {
    fn doc(&self, i: usize) -> usize {
        match &self.offs {
            None => self.base + i,
            Some(o) => match o.get(i) {
                Some(&d) => d,
                None => o.last().map_or(self.base, |l| l + 1) + (i - o.len()),
            },
        }
    }
    fn in_table(&self) -> bool {
        self.offs.is_some()
    }
}

struct Walk<'s, 'n> {
    src: &'s str,
    off: usize,
    line_starts: Vec<usize>,
    note: &'n mut Note,
    /// The lazy-tab shift learned for one line (see `lazy_tab_shift`).
    tab_shift: Option<(usize, usize)>,
}

impl<'s> Walk<'s, '_> {
    fn pos(&self, line: usize, col: usize) -> usize {
        let ls = self
            .line_starts
            .get(line.saturating_sub(1))
            .copied()
            .unwrap_or(self.src.len());
        (ls + col.saturating_sub(1)).min(self.src.len())
    }

    /// A node's `[start, end)` in comrak's reported body coordinates.
    fn reported(&self, n: N) -> (usize, usize) {
        let sp = n.data().sourcepos;
        let s = self.pos(sp.start.line, sp.start.column);
        let e = (self.pos(sp.end.line, sp.end.column) + 1).min(self.src.len());
        (s, e.max(s))
    }

    /// A block node's body range, on char boundaries.
    fn block_range(&self, n: N) -> (usize, usize) {
        let (mut s, mut e) = self.reported(n);
        while s > 0 && !self.src.is_char_boundary(s) {
            s -= 1;
        }
        while e < self.src.len() && !self.src.is_char_boundary(e) {
            e += 1;
        }
        (s, e)
    }

    fn span(&self, a: usize, b: usize) -> std::ops::Range<usize> {
        self.off + a..self.off + b
    }

    fn block(&mut self, n: N) {
        let value = n.data().value.clone();
        match value {
            NodeValue::Paragraph => {
                let (s, e) = self.block_range(n);
                let v = View {
                    s: Cow::Borrowed(&self.src[s..e]),
                    base: s,
                    offs: None,
                };
                let len = v.s.len();
                self.inline_seq(n, &v, 0, len, true);
            }
            NodeValue::Heading(h) => {
                let (s, e) = self.block_range(n);
                let text = heading_text(&self.src[s..e], h.setext);
                self.note.headings.push(Heading {
                    level: h.level,
                    text,
                    span: self.span(s, e),
                });
                let v = View {
                    s: Cow::Borrowed(&self.src[s..e]),
                    base: s,
                    offs: None,
                };
                let len = v.s.len();
                self.inline_seq(n, &v, 0, len, false);
            }
            NodeValue::TableCell => {
                let (s, e) = self.block_range(n);
                let raw = &self.src[s..e];
                let mut st = String::with_capacity(raw.len());
                let mut offs = Vec::with_capacity(raw.len());
                let b = raw.as_bytes();
                let mut k = 0;
                while k < b.len() {
                    if b[k] == b'\\' && b.get(k + 1) == Some(&b'|') {
                        k += 1;
                        continue;
                    }
                    let ch = raw[k..].chars().next().map_or(1, char::len_utf8);
                    st.push_str(&raw[k..k + ch]);
                    offs.extend((0..ch).map(|j| s + k + j));
                    k += ch;
                }
                let v = View {
                    s: Cow::Owned(st),
                    base: s,
                    offs: Some(offs),
                };
                let len = v.s.len();
                self.inline_seq(n, &v, 0, len, false);
            }
            NodeValue::BlockQuote => {
                self.callout(n);
                self.children(n);
            }
            NodeValue::TaskItem(t) => {
                let (s, e) = self.block_range(n);
                let text = n
                    .children()
                    .find(|c| matches!(c.data().value, NodeValue::Paragraph))
                    .map(|p| {
                        let (ps, pe) = self.block_range(p);
                        let line = &self.src[ps..pe];
                        line.split(['\n', '\r'])
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string()
                    })
                    .unwrap_or_default();
                self.note.tasks.push(Task {
                    status: t.symbol.unwrap_or(' '),
                    text,
                    span: self.span(s, e),
                });
                self.children(n);
            }
            NodeValue::FootnoteDefinition(f) => {
                let (s, e) = self.block_range(n);
                self.note.footnote_defs.push(Footnote {
                    label: f.name.clone(),
                    span: self.span(s, e),
                });
                self.children(n);
            }
            NodeValue::CodeBlock(_) | NodeValue::HtmlBlock(_) | NodeValue::FrontMatter(_) => {}
            _ => self.children(n),
        }
    }

    fn children(&mut self, n: N) {
        for c in n.children() {
            self.block(c);
        }
    }

    fn callout(&mut self, n: N) {
        let Some(p) = n.first_child() else {
            return;
        };
        if !matches!(p.data().value, NodeValue::Paragraph) {
            return;
        }
        let (ps, pe) = self.block_range(p);
        let first = self.src[ps..pe].split(['\n', '\r']).next().unwrap_or("");
        let Some(rest) = first.trim_start().strip_prefix("[!") else {
            return;
        };
        let Some(close) = rest.find(']') else {
            return;
        };
        let kind = &rest[..close];
        if kind.is_empty() || kind.contains(char::is_whitespace) {
            return;
        }
        let mut after = &rest[close + 1..];
        let fold = match after.chars().next() {
            Some(c @ ('+' | '-')) => {
                after = &after[1..];
                Some(c)
            }
            _ => None,
        };
        let (s, e) = self.block_range(n);
        self.note.callouts.push(Callout {
            kind: kind.to_lowercase(),
            fold,
            title: after.trim().to_string(),
            span: self.span(s, e),
        });
    }

    /// The inline nodes under `parent` over `v[a..b)`: the non-text ones are exclusion zones
    /// (recursed into where they hold text); the gaps are tokenized.
    fn inline_seq(&mut self, parent: N, v: &View, a: usize, b: usize, block_ids: bool) {
        let mut nodes: Vec<(N, usize, usize)> = Vec::new();
        for k in parent.children() {
            if matches!(
                k.data().value,
                NodeValue::Text(_)
                    | NodeValue::SoftBreak
                    | NodeValue::LineBreak
                    | NodeValue::WikiLink(_)
            ) {
                continue;
            }
            let (mut rs, mut re) = self.reported(k);
            if !v.in_table() {
                let shift = self.lazy_tab_shift(k, rs, re);
                (rs, re) = (rs - shift, re - shift);
            }
            let s = rs.saturating_sub(v.base).clamp(a, b);
            let e = re.saturating_sub(v.base).clamp(s, b);
            if matches!(k.data().value, NodeValue::Escaped)
                && v.in_table()
                && v.s.as_bytes().get(s) == Some(&b'|')
            {
                continue;
            }
            nodes.push((k, s, e));
        }
        let mut pos = a;
        let mut i = 0;
        loop {
            while i < nodes.len() && nodes[i].1 < pos {
                i += 1;
            }
            let limit = nodes.get(i).map_or(b, |n| n.1);
            pos = self.gap(v, pos, limit, b, block_ids);
            if pos > limit {
                continue;
            }
            let Some(&(k, s, e)) = nodes.get(i) else {
                break;
            };
            i += 1;
            self.inline_node(k, v, s, e);
            pos = e.max(pos);
        }
    }

    /// comrak pads a lazy line whose container indent stopped inside an expanded tab, so the
    /// inline sourcepos after that tab runs up to 3 bytes late (mdview `lex/inline.rs`
    /// `pad_fix`). Rather than replay the container chain, re-anchor: a node on a line with a
    /// tab before it whose source does not read as that node is moved back by the first shift
    /// (1–3) that makes it read right; the shift is remembered for the rest of the line.
    fn lazy_tab_shift(&mut self, k: N, rs: usize, re: usize) -> usize {
        let line = self.line_starts.partition_point(|&l| l <= rs);
        let ls = self.line_starts[line - 1];
        if !self.src.as_bytes()[ls..rs].contains(&b'\t') {
            return 0;
        }
        if let Some(&(l, sh)) = self.tab_shift.as_ref()
            && l == line
        {
            return sh.min(rs - ls);
        }
        let Some(ok) = anchor(&k.data().value) else {
            return 0;
        };
        if ok(&self.src[rs..re]) {
            return 0;
        }
        for sh in 1..=3usize.min(rs - ls) {
            if let Some(t) = self.src.get(rs - sh..re - sh)
                && ok(t)
            {
                self.tab_shift = Some((line, sh));
                return sh;
            }
        }
        0
    }

    /// Tokenize gap `v[from..limit)`: a wiki-link (which may run on to `end`), a tag, a block
    /// id. Returns where the scan stopped: `limit`, or past a wiki-link that ran beyond it.
    fn gap(&mut self, v: &View, from: usize, limit: usize, end: usize, block_ids: bool) -> usize {
        let t = v.s.as_ref();
        let bytes = t.as_bytes();
        let mut p = from;
        while p < limit {
            match bytes[p] {
                b'!' | b'[' => {
                    if let Some((len, w)) = match_wikilink_with(&t[p..end], true) {
                        self.push_wiki(v, p, p + len, w);
                        p += len;
                        if p > limit {
                            return p;
                        }
                        continue;
                    }
                }
                b'#' if p == 0 || t[..p].chars().next_back().is_some_and(char::is_whitespace) => {
                    let n = t[p + 1..limit]
                        .find(|c: char| !is_tag_char(c))
                        .unwrap_or(limit - p - 1);
                    let name = &t[p + 1..p + 1 + n];
                    if is_tag_name(name) {
                        let span = self.span(v.doc(p), v.doc(p + 1 + n));
                        self.note.tags.push(Tag {
                            name: name.to_string(),
                            source: TagSource::Inline { span },
                        });
                        p += 1 + n;
                        continue;
                    }
                }
                b'^' if block_ids
                    && (p == 0 || t[..p].chars().next_back().is_some_and(char::is_whitespace)) =>
                {
                    let n = bytes[p + 1..limit]
                        .iter()
                        .take_while(|&&c| is_block_id_char(c))
                        .count();
                    if n > 0 && t[p + 1 + n..].trim().is_empty() && limit == end {
                        let span = self.span(v.doc(p), v.doc(p + 1 + n));
                        self.note.block_ids.push(BlockId {
                            id: t[p + 1..p + 1 + n].to_string(),
                            span,
                        });
                        p += 1 + n;
                        continue;
                    }
                }
                _ => {}
            }
            p += t[p..].chars().next().map_or(1, char::len_utf8);
        }
        limit
    }

    fn push_wiki(&mut self, v: &View, s: usize, e: usize, w: Wiki) {
        let span = self.span(v.doc(s), v.doc(e - 1) + 1);
        self.note.wikilinks.push(WikiLink {
            target: w.slug,
            fragment: w.fragment,
            alias: w.alias,
            embed: w.embed,
            in_table: v.in_table(),
            span,
        });
    }

    fn inline_node(&mut self, k: N, v: &View, s: usize, e: usize) {
        let raw = &v.s[s..e];
        match &k.data().value {
            NodeValue::Emph | NodeValue::Strong | NodeValue::Strikethrough => {
                let d = match &k.data().value {
                    NodeValue::Strong => 2,
                    NodeValue::Emph => 1,
                    _ => raw.len() - raw.trim_start_matches('~').len(),
                };
                if raw.len() >= 2 * d {
                    self.inline_seq(k, v, s + d, e - d, false);
                }
            }
            NodeValue::Link(link) | NodeValue::Image(link) => {
                let image = matches!(k.data().value, NodeValue::Image(_));
                let kind = if raw.starts_with('[') || raw.starts_with("![") {
                    LinkKind::Bracketed
                } else if raw.starts_with('<') && raw.ends_with('>') {
                    LinkKind::Angle
                } else {
                    LinkKind::Bare
                };
                self.note.md_links.push(MdLink {
                    image,
                    kind,
                    dest_raw: link.url.clone(),
                    dest: classify(&link.url),
                    span: self.span(v.doc(s), v.doc(e.max(s + 1) - 1) + 1),
                });
                if !image
                    && kind == LinkKind::Bracketed
                    && let Some(le) = label_end(raw)
                {
                    self.inline_seq(k, v, s + 1, s + le, false);
                }
            }
            NodeValue::FootnoteReference(f) => {
                self.note.footnote_refs.push(Footnote {
                    label: f.name.clone(),
                    span: self.span(v.doc(s), v.doc(e.max(s + 1) - 1) + 1),
                });
            }
            _ => {}
        }
    }
}

type Anchor = Box<dyn Fn(&str) -> bool>;

/// How a node's own source must read, for re-anchoring (`Walk::lazy_tab_shift`).
fn anchor(v: &NodeValue) -> Option<Anchor> {
    Some(match v {
        NodeValue::Code(_) => Box::new(|t: &str| t.starts_with('`') && t.ends_with('`')),
        NodeValue::HtmlInline(lit) => {
            let lit = lit.clone();
            Box::new(move |t: &str| t == lit)
        }
        NodeValue::Escaped => Box::new(|t: &str| t.starts_with('\\')),
        NodeValue::FootnoteReference(_) => Box::new(|t: &str| t.starts_with("[^")),
        NodeValue::Image(_) => Box::new(|t: &str| t.starts_with("![")),
        NodeValue::Link(l) => {
            let url = l.url.clone();
            Box::new(move |t: &str| {
                t.starts_with('[')
                    || (t.starts_with('<') && t.ends_with('>'))
                    || url == t
                    || url.strip_prefix("http://") == Some(t)
                    || url.strip_prefix("mailto:") == Some(t)
            })
        }
        _ => return None,
    })
}

/// The index of the `]` closing a bracketed link label `raw` (`[` at 0).
fn label_end(raw: &str) -> Option<usize> {
    let b = raw.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'[' => depth += 1,
            b']' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn heading_text(raw: &str, setext: bool) -> String {
    if setext {
        let mut lines: Vec<&str> = raw.lines().collect();
        lines.pop();
        return lines.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ");
    }
    let t = raw.trim().trim_start_matches('#');
    let t = t.trim_end();
    let stripped = t.trim_end_matches('#');
    let t = if stripped.len() < t.len() && (stripped.is_empty() || stripped.ends_with([' ', '\t']))
    {
        stripped
    } else {
        t
    };
    t.trim().to_string()
}

/// External (a URI scheme or `//`) vs local (percent-decoded path, `#fragment` split off).
fn classify(url: &str) -> LinkDest {
    let scheme = url.find(':').map(|i| &url[..i]).is_some_and(|sch| {
        sch.len() > 1
            && sch.starts_with(|c: char| c.is_ascii_alphabetic())
            && sch
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    if scheme || url.starts_with("//") {
        return LinkDest::External(url.to_string());
    }
    let (path, fragment) = match url.split_once('#') {
        Some((p, f)) => (p, Some(percent_decode(f))),
        None => (url, None),
    };
    LinkDest::Local {
        path: percent_decode(path),
        fragment,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|c| (*c as char).to_digit(16)),
                b.get(i + 2).and_then(|c| (*c as char).to_digit(16)),
            )
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check_spans;

    fn ok(src: &str) -> Note {
        let n = parse(src);
        assert_eq!(check_spans(src, &n), Vec::<String>::new(), "{src:?}");
        n
    }

    fn texts(src: &str, spans: impl Iterator<Item = std::ops::Range<usize>>) -> Vec<&str> {
        spans.map(|s| &src[s]).collect()
    }

    #[test]
    fn wikilinks_embeds_and_fragment_only() {
        let src = "a [[n]] ![[i.png|x]] [[p#h|A]] [[#h]] [[#^b]] `[[c]]` <span>[[h]]</span>\n";
        let n = ok(src);
        assert_eq!(
            texts(src, n.wikilinks.iter().map(|w| w.span.clone())),
            [
                "[[n]]",
                "![[i.png|x]]",
                "[[p#h|A]]",
                "[[#h]]",
                "[[#^b]]",
                "[[h]]"
            ]
        );
        assert!(n.wikilinks[1].embed);
        assert_eq!(n.wikilinks[2].fragment.as_deref(), Some("h"));
        assert_eq!(n.wikilinks[3].target, "");
        assert_eq!(n.wikilinks[4].fragment.as_deref(), Some("^b"));
    }

    #[test]
    fn md_links_classify_and_span() {
        let src = "[a](my%20note.md#Sec) ![i](p.png) <https://x.y> www.z.com u@v.com [r](https://e.f) [q][d]\n\n[d]: other.md\n";
        let n = ok(src);
        let kinds: Vec<_> = n.md_links.iter().map(|l| (l.image, l.kind)).collect();
        assert_eq!(
            kinds,
            [
                (false, LinkKind::Bracketed),
                (true, LinkKind::Bracketed),
                (false, LinkKind::Angle),
                (false, LinkKind::Bare),
                (false, LinkKind::Bare),
                (false, LinkKind::Bracketed),
                (false, LinkKind::Bracketed),
            ]
        );
        assert_eq!(
            n.md_links[0].dest,
            LinkDest::Local {
                path: "my note.md".into(),
                fragment: Some("Sec".into())
            }
        );
        assert_eq!(n.md_links[5].dest, LinkDest::External("https://e.f".into()));
        assert_eq!(&src[n.md_links[6].span.clone()], "[q][d]");
    }

    #[test]
    fn tags_follow_obsidian_grammar_and_skip_code_and_urls() {
        let src = "#top x #a/b-c_d #2024 #y2024 a#no `#code` [l](#frag) https://h.i/#u \\#esc #ü\n\n# Heading #inh\n";
        let n = ok(src);
        let names: Vec<_> = n.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["top", "a/b-c_d", "y2024", "ü", "inh"]);
    }

    #[test]
    fn frontmatter_offsets_tags_and_links() {
        let src = "---\ntags: [a, '#b']\nup: \"[[Parent#H|P]]\"\nrel:\n  - \"[[x]]\"\n  - text\n---\nbody [[y]] #c\n";
        let n = ok(src);
        let fm = n.frontmatter.as_ref().expect("fm");
        assert_eq!(fm.span.end, n.body_offset);
        assert!(src[fm.span.clone()].ends_with("---\n"));
        assert_eq!(&src[n.wikilinks[0].span.clone()], "[[y]]");
        let names: Vec<_> = n.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["a", "b", "c"]);
        assert_eq!(n.tags[0].source, TagSource::Frontmatter);
        let links: Vec<_> = n
            .fm_links
            .iter()
            .map(|l| (l.key.as_str(), l.target.as_str()))
            .collect();
        assert_eq!(links, [("up", "Parent"), ("rel", "x")]);
        assert_eq!(n.fm_links[0].alias.as_deref(), Some("P"));
        let n = ok("---\ntags: one, two three\n---\n");
        assert_eq!(n.tags.len(), 3);
    }

    #[test]
    fn crlf_nul_and_bom_keep_offsets() {
        let src = "---\r\na: 1\r\n---\r\nline [[a]]\r\nnext\0 [[b]] #t\r\n\r\n> x\0\0 [[c]]\r\n";
        let n = ok(src);
        assert_eq!(
            texts(src, n.wikilinks.iter().map(|w| w.span.clone())),
            ["[[a]]", "[[b]]", "[[c]]"]
        );
        assert_eq!(n.tags.len(), 1);
        let src = "\u{feff}# H [[a]]\n";
        let n = ok(src);
        assert_eq!(n.headings.len(), 1);
        assert_eq!(&src[n.wikilinks[0].span.clone()], "[[a]]");
        let src = "a\rb [[c]]\r";
        assert_eq!(&src[ok(src).wikilinks[0].span.clone()], "[[c]]");
    }

    #[test]
    fn table_cells_unescape_pipes_but_span_the_source() {
        let src = "| h | k |\n|---|---|\n| `a \\| b` [[s\\|Alias]] | x \\| [[t]] #tg |\n";
        let n = ok(src);
        assert_eq!(
            texts(src, n.wikilinks.iter().map(|w| w.span.clone())),
            ["[[s\\|Alias]]", "[[t]]"]
        );
        assert_eq!(n.wikilinks[0].target, "s");
        assert_eq!(n.wikilinks[0].alias.as_deref(), Some("Alias"));
        assert!(n.wikilinks[0].in_table);
        assert_eq!(n.tags[0].name, "tg");
    }

    #[test]
    fn lazy_lines_ending_in_a_tab_keep_spans() {
        // comrak pads a lazy line whose item indent stopped inside the tab: without the
        // re-anchor these first four misplace their links (`lazy_tab_shift`).
        for src in [
            "- a\n  > b\n\tc https://x.y [[w]]\t\n",
            "- a\n  > b\n\tc <https://x.y> `k` [[w]]\t\n",
            " - a\n   > b\n\tc www.x.y [[w]]\n",
            "1. a\n   > b\n\tc https://x.y [l](u) [[w]]\t\n",
            "- > a\n\t> b <https://x.y> `c` [[d]]\t\n",
            "-\tquote\n>\tlazy https://x.y/z [[w]]\t\n",
            "  - a\n\t\tb www.e.com [[w]] [^1]\t\n\n[^1]: n\n",
        ] {
            let n = ok(src);
            assert!(!n.wikilinks.is_empty() && !n.md_links.is_empty(), "{src:?}");
        }
    }

    #[test]
    fn footnotes_callouts_block_ids_headings_tasks() {
        let src = "# One\n\nSee[^n] and ^not-id here.\n\nPara end ^blk-1\n\n> [!NOTE]- Folded *t*\n> body\n\n- [ ] open\n- [x] done\n- [>] moved ^tid\n\nSet\n===\n\n[^n]: The note.\n";
        let n = ok(src);
        assert_eq!(n.footnote_refs[0].label, "n");
        assert_eq!(&src[n.footnote_refs[0].span.clone()], "[^n]");
        assert!(src[n.footnote_defs[0].span.clone()].starts_with("[^n]:"));
        let ids: Vec<_> = n.block_ids.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, ["blk-1", "tid"]);
        let c = &n.callouts[0];
        assert_eq!(
            (c.kind.as_str(), c.fold, c.title.as_str()),
            ("note", Some('-'), "Folded *t*")
        );
        let h: Vec<_> = n
            .headings
            .iter()
            .map(|h| (h.level, h.text.as_str()))
            .collect();
        assert_eq!(h, [(1, "One"), (1, "Set")]);
        let t: Vec<_> = n
            .tasks
            .iter()
            .map(|t| (t.status, t.text.as_str()))
            .collect();
        assert_eq!(t, [(' ', "open"), ('x', "done"), ('>', "moved ^tid")]);
    }

    #[test]
    fn code_and_html_blocks_hold_no_items() {
        let n = ok("```\n[[a]] #t\n```\n\n<div>\n[[b]]\n</div>\n\n    [[c]]\n");
        assert!(n.wikilinks.is_empty() && n.tags.is_empty());
    }

    #[test]
    fn empty_target_is_only_behind_the_switch() {
        use crate::wikilink::match_wikilink;
        assert!(match_wikilink("[[#h]]").is_none());
        assert!(match_wikilink_with("[[#h]]", true).is_some());
        assert!(match_wikilink_with("[[#]]", true).is_none());
        assert!(match_wikilink_with("[[|a]]", true).is_none());
    }
}
