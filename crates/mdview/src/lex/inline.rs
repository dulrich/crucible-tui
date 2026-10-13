//! Inline sequences: gaps between structural nodes, wiki-links, links and code spans.

use super::*;

impl Lexer<'_> {
    // -- inlines -------------------------------------------------------------

    /// Inline tokens for a block node whose content is `v[a..b]`.
    pub(super) fn inlines_of(&mut self, n: N, v: &View, a: usize, b: usize) -> Vec<Token> {
        let sub = v.sub(a, b);
        let kids: Vec<N> = n.children().collect();
        self.inline_seq(&kids, &sub, 0, sub.s.len(), &[])
    }

    /// Inline tokens for the nodes of a table row that fall inside one cell view.
    pub(super) fn inlines_in(&mut self, row: N, cv: &View, in_table: bool) -> Vec<Token> {
        let child = Scope {
            cell: if in_table {
                cv.offs.first().map(|&f| (f, cv.offs.clone()))
            } else {
                None
            },
            ..self.scope.clone()
        };
        self.in_scope(child, |lx| lx.cell_inlines(row, cv, in_table))
    }

    /// [`Lexer::inlines_in`]'s body, run inside the cell's scope.
    fn cell_inlines(&mut self, row: N, cv: &View, in_table: bool) -> Vec<Token> {
        let mut kids = Vec::new();
        if let (Some(&first), Some(&last)) = (cv.offs.first(), cv.offs.last()) {
            for cell in row.children() {
                for k in cell.children() {
                    let (s, e) = self.node_range(k);
                    if s >= first && e <= last + 1 {
                        kids.push(k);
                    }
                }
            }
        }
        self.inline_seq(&kids, cv, 0, cv.s.len(), if in_table { b"|" } else { &[] })
    }

    /// A doc offset comrak reported inside a table cell, mapped back to the source.
    pub(super) fn uncell(&self, d: usize) -> usize {
        let Some((base, offs)) = &self.scope.cell else {
            return d;
        };
        let (Some(&last), true) = (offs.last(), d >= *base) else {
            return d;
        };
        match offs.get(d - base) {
            Some(&o) => o,
            None => d + (last + 1) - (base + offs.len()),
        }
    }

    /// Undo comrak's lazy-line tab padding (see `tab_pad`) for a doc offset on line `l`.
    pub(super) fn pad_fix(&self, l: usize, d: usize) -> usize {
        match self.tab_pad.borrow().get(&l) {
            Some(&(tab, pad)) if d > tab => d.saturating_sub(pad).max(tab + 1),
            _ => d,
        }
    }

    /// The doc byte range `[start, end)` of a node.
    pub(super) fn node_range(&self, n: N) -> (usize, usize) {
        let sp = n.data().sourcepos;
        let at = |line: usize, col: usize| {
            let d = self.line_start(line) + col.saturating_sub(1);
            self.pad_fix(line, d).min(self.src.len())
        };
        let s = at(sp.start.line, sp.start.column);
        let e = at(sp.end.line, sp.end.column);
        let (s, e) = (self.uncell(s), self.uncell(e));
        let mut s = s;
        while s > 0 && !self.src.is_char_boundary(s) {
            s -= 1;
        }
        let mut e = (e + 1).min(self.src.len());
        while e < self.src.len() && !self.src.is_char_boundary(e) {
            e += 1;
        }
        (s, e.max(s))
    }

    pub(super) fn text_token(&self, s: &str) -> Token {
        Token::Text {
            raw: s.to_string(),
            text: if self.scope.in_raw {
                s.to_string()
            } else {
                escape_no_encode(s)
            },
            tokens: None,
        }
    }

    pub(super) fn push_text(&self, out: &mut Vec<Token>, s: &str) {
        if s.is_empty() {
            return;
        }
        if let Some(Token::Text {
            raw,
            text,
            tokens: None,
        }) = out.last_mut()
        {
            raw.push_str(s);
            text.push_str(&if self.scope.in_raw {
                s.to_string()
            } else {
                escape_no_encode(s)
            });
            return;
        }
        out.push(self.text_token(s));
    }

    /// The structural nodes in `kids` over `v[a..b]`; the gaps between them are text, and a
    /// wiki-link (marked's first inline extension) wins at any gap position it matches at.
    pub(super) fn inline_seq(
        &mut self,
        kids: &[N],
        v: &View,
        a: usize,
        b: usize,
        skip: &[u8],
    ) -> Vec<Token> {
        let mut nodes: Vec<(N, usize, usize)> = Vec::new();
        for &k in kids {
            match &k.data().value {
                NodeValue::Text(_) | NodeValue::SoftBreak | NodeValue::WikiLink(_) => continue,
                NodeValue::Escaped if !skip.is_empty() => {
                    // `\|` in a cell (splitCells) or `\[`/`\]` in a link label (outputLink)
                    // was unescaped before marked lexed the inline content.
                    let (s, _) = self.node_range(k);
                    if self
                        .src
                        .as_bytes()
                        .get(s + 1)
                        .is_some_and(|c| skip.contains(c))
                    {
                        continue;
                    }
                }
                _ => {}
            }
            let (ds, de) = self.node_range(k);
            let s = v.idx(ds).max(a).min(b);
            let mut e = v.idx(de).max(s).min(b);
            if matches!(k.data().value, NodeValue::Code(_)) {
                // comrak's sourcepos drifts inside table cells after an escaped pipe; the
                // span ends at the closing backtick run, which the view itself shows.
                e = code_span_end(&v.s, s, b).unwrap_or(e);
            }
            nodes.push((k, s, e));
        }
        let mut out = Vec::new();
        let mut pos = a;
        let mut i = 0;
        // comrak's open-bracket count over this sequence's text (`Subject::brackets`).
        let mut depth = 0usize;
        loop {
            while i < nodes.len() && nodes[i].1 < pos {
                i += 1;
            }
            let limit = nodes.get(i).map_or(b, |n| n.1);
            let wiki = find_wiki(&v.s, pos, limit, b);
            if let Some((cs, ce)) = find_gap_code_span(&v.s, pos, limit)
                && wiki.as_ref().is_none_or(|(ws, _, _)| cs < *ws)
            {
                // comrak's closing-backtick cache (`scan_to_closing_backtick`) records the
                // *latest* run of each length it scanned past, so a later search for a run it
                // already passed fails and leaves a valid code span (§6.3) as text.
                self.push_gap(&mut out, &v.s, pos, cs, &mut depth);
                if let Some(t) = codespan_token(&v.s[cs..ce]) {
                    out.push(t);
                }
                pos = ce;
                continue;
            }
            if let Some((ws, we, w)) = wiki {
                self.push_gap(&mut out, &v.s, pos, ws, &mut depth);
                out.push(self.wiki_token(w));
                pos = we;
                continue;
            }
            let Some(&(k, s, e)) = nodes.get(i) else {
                break;
            };
            i += 1;
            let value = k.data().value.clone();
            if matches!(value, NodeValue::LineBreak) {
                // The break is the newline ending its line, with its spaces or `\`.
                let from = s.max(pos);
                let Some(nl) = v.s[from..b].find('\n').map(|j| from + j) else {
                    continue;
                };
                let line = &v.s[pos..nl];
                let cut = if let Some(stripped) = line.strip_suffix('\\') {
                    stripped.len()
                } else {
                    line.trim_end_matches(' ').len()
                };
                self.push_gap(&mut out, &v.s, pos, pos + cut, &mut depth);
                out.push(Token::Br);
                pos = nl + 1;
                continue;
            }
            // comrak's `autolink_delim` trims a trailing U+2069 (pop directional isolate) from
            // a GFM extended autolink; marked's `url` rule (`[^\s<]*`, marked.esm.js:1225)
            // keeps it, and `_backpedal` (:1228) only trims ASCII punctuation — and so does the
            // GFM spec's §6.9 (not whitespace, not trailing punctuation). Give it back.
            let e = if matches!(value, NodeValue::Link(_))
                && !v.s[s..e].starts_with(['[', '<'])
                && v.s[e..b].starts_with('\u{2069}')
            {
                e + '\u{2069}'.len_utf8()
            } else {
                e
            };
            self.push_gap(&mut out, &v.s, pos, s, &mut depth);
            let raw = v.s[s..e].to_string();
            match self.inline_node(k, &value, v, s, e, skip) {
                Some(Inline::One(t)) => out.push(t),
                Some(Inline::Text(t)) => self.push_text(&mut out, &t),
                None => self.push_text(&mut out, &raw),
            }
            pos = e;
        }
        if pos < b {
            self.push_gap(&mut out, &v.s, pos, b, &mut depth);
        }
        out
    }

    /// Gap text `t[a..b]` — text comrak left unlinked — with the extended autolinks marked
    /// finds there and comrak does not:
    /// - a URL or `www.` autolink while a `[` is open: comrak refuses every autolink inside an
    ///   open bracket (comrak 0.56's `handle_autolink_with`); neither marked's `url`
    ///   rule (marked.esm.js:1225) nor GFM §6.9 knows about brackets;
    /// - an email autolink whose domain ends in a digit: comrak's `email_match` demands an
    ///   alphabetic last character; GFM §6.9 only forbids `-`
    ///   and `_` there, and marked's email rule ends in `[a-zA-Z0-9]` (marked.esm.js:1225).
    ///
    /// Everything else is comrak's own matcher, transcribed.
    pub(super) fn push_gap(
        &self,
        out: &mut Vec<Token>,
        t: &str,
        a: usize,
        b: usize,
        depth: &mut usize,
    ) {
        let bytes = t.as_bytes();
        let (mut pos, mut i, mut run, mut run_brackets) = (a, a, a, 0i64);
        while i < b {
            let found = match bytes[i] {
                b'\n' => {
                    run = i + 1;
                    run_brackets = 0;
                    None
                }
                b'[' => {
                    *depth += 1;
                    run_brackets += 1;
                    None
                }
                b']' => {
                    *depth = depth.saturating_sub(1);
                    run_brackets -= 1;
                    None
                }
                b':' if *depth > 0 && !self.scope.in_link => gfm_url(t, pos, i, b),
                b'w' if *depth > 0 && !self.scope.in_link => gfm_www(t, i, b),
                b'@' if run_brackets <= 0 && !self.scope.in_link => {
                    gfm_email(t, pos.max(run), i, b)
                        .filter(|&(_, e)| !bytes[e - 1].is_ascii_alphabetic())
                }
                _ => None,
            };
            if let Some((ls, le)) = found {
                self.push_text(out, &t[pos..ls]);
                out.push(autolink_token(&t[ls..le]));
                pos = le;
                i = le;
                continue;
            }
            i += 1;
        }
        self.push_text(out, &t[pos..b]);
    }

    pub(super) fn wiki_token(&mut self, w: Wiki) -> Token {
        let label = w.alias.clone().unwrap_or_else(|| w.slug.clone());
        let tokens = lex_inline_string(&label, self);
        Token::Wikilink {
            slug: w.slug,
            fragment: w.fragment,
            embed: w.embed,
            alias: w.alias,
            tokens,
        }
    }

    pub(super) fn inline_node(
        &mut self,
        k: N,
        value: &NodeValue,
        v: &View,
        s: usize,
        e: usize,
        skip: &[u8],
    ) -> Option<Inline> {
        let raw = &v.s[s..e];
        let kids: Vec<N> = k.children().collect();
        // marked unescapes `\[`/`\]` in the whole link label before lexing it
        // (`outputLink`, marked.esm.js:185), so an escape nested in emphasis inside the label
        // is gone too: emphasis in a label inherits the label's skip set.
        let nested: &[u8] = if skip.contains(&b'[') { b"[]" } else { &[] };
        match value {
            NodeValue::Emph | NodeValue::Strong => {
                let d = if matches!(value, NodeValue::Strong) {
                    2
                } else {
                    1
                };
                if raw.len() < 2 * d {
                    return None;
                }
                let text = raw[d..raw.len() - d].to_string();
                let tokens = self.inline_seq(&kids, v, s + d, e - d, nested);
                Some(Inline::One(if d == 2 {
                    Token::Strong { text, tokens }
                } else {
                    Token::Em { text, tokens }
                }))
            }
            NodeValue::Strikethrough => {
                let d = raw.len() - raw.trim_start_matches('~').len();
                if d == 0 || raw.len() < 2 * d {
                    return None;
                }
                let text = raw[d..raw.len() - d].to_string();
                let tokens = self.inline_seq(&kids, v, s + d, e - d, nested);
                Some(Inline::One(Token::Del {
                    raw: raw.to_string(),
                    text,
                    tokens,
                }))
            }
            NodeValue::Code(_) => codespan_token(raw).map(Inline::One),
            NodeValue::HtmlInline(_) => {
                let lower = raw.to_ascii_lowercase();
                if !self.scope.in_link && lower.starts_with("<a ") {
                    self.scope.in_link = true;
                } else if self.scope.in_link && lower.starts_with("</a>") {
                    self.scope.in_link = false;
                }
                let raw_tag = |p: &str| {
                    ["pre", "code", "kbd", "script"].iter().any(|t| {
                        lower
                            .strip_prefix(p)
                            .and_then(|r| r.strip_prefix(t))
                            .is_some_and(|r| r.starts_with(|c: char| c == '>' || c.is_whitespace()))
                    })
                };
                if !self.scope.in_raw && raw_tag("<") {
                    self.scope.in_raw = true;
                } else if self.scope.in_raw && raw_tag("</") {
                    self.scope.in_raw = false;
                }
                Some(Inline::One(Token::Html {
                    text: raw.to_string(),
                }))
            }
            NodeValue::Escaped => {
                let c = raw.strip_prefix('\\').unwrap_or(raw);
                Some(Inline::One(Token::Escape {
                    text: escape_no_encode(c),
                }))
            }
            NodeValue::Link(link) => {
                if raw.starts_with('<') && raw.ends_with('>') && !raw.starts_with("<[") {
                    let inner = &raw[1..raw.len() - 1];
                    let text = escape_no_encode(inner);
                    let href = if inner.contains('@') && !inner.contains(':') {
                        format!("mailto:{text}")
                    } else {
                        text.clone()
                    };
                    return Some(Inline::One(Token::Link {
                        href,
                        text: text.clone(),
                        tokens: vec![Token::Text {
                            raw: text.clone(),
                            text,
                            tokens: None,
                        }],
                    }));
                }
                if !raw.starts_with('[') {
                    // GFM extended autolink.
                    if self.scope.in_link {
                        return Some(Inline::Text(raw.to_string()));
                    }
                    return Some(Inline::One(autolink_token(raw)));
                }
                let (label_end, dest) = parse_link(raw)?;
                let label = &raw[1..label_end];
                let text = label.replace("\\[", "[").replace("\\]", "]");
                let href = match dest {
                    Some((h, _)) => h,
                    None => link.url.clone(),
                };
                self.scope.in_link = true;
                let lv = unescape_view(&v.sub(s + 1, s + label_end), b"[]");
                let tokens = self.inline_seq(&kids, &lv, 0, lv.s.len(), b"[]");
                self.scope.in_link = false;
                Some(Inline::One(Token::Link { href, text, tokens }))
            }
            NodeValue::Image(link) => {
                let body = raw.strip_prefix('!')?;
                let (label_end, dest) = parse_link(body)?;
                let label = &body[1..label_end];
                let text = escape_no_encode(&label.replace("\\[", "[").replace("\\]", "]"));
                let (href, title) = match dest {
                    Some((h, t)) => (h, t),
                    None => (
                        link.url.clone(),
                        if link.title.is_empty() {
                            None
                        } else {
                            Some(link.title.clone())
                        },
                    ),
                };
                let title = title
                    .filter(|t| !t.is_empty())
                    .map(|t| escape_no_encode(&t));
                Some(Inline::One(Token::Image { href, title, text }))
            }
            _ => None,
        }
    }
}

pub(super) enum Inline {
    One(Token),
    Text(String),
}

/// The first wiki-link match starting in `v[from..limit)` (it may run on to `end`), by
/// `TS_BASELINE` `src/wikilink.ts`'s `WIKI_LINK_TOKENIZER`: its start, its end, and its parts.
pub(super) fn find_wiki(
    s: &str,
    from: usize,
    limit: usize,
    end: usize,
) -> Option<(usize, usize, Wiki)> {
    let b = s.as_bytes();
    let mut p = from;
    while p < limit {
        if (b[p] == b'!' || b[p] == b'[')
            && let Some((len, w)) = match_wikilink(&s[p..end])
        {
            return Some((p, p + len, w));
        }
        p += 1;
    }
    None
}

/// Lex a standalone inline string (a wiki-link label) the way `inlineTokens` would.
pub(super) fn lex_inline_string(s: &str, outer: &Lexer) -> Vec<Token> {
    let arena = Arena::new();
    let root = parse_document(&arena, s, &ofm::comrak_options());
    let scope = Scope {
        in_link: outer.scope.in_link,
        in_raw: outer.scope.in_raw,
        ..Scope::root()
    };
    let mut lx = Lexer::new(s, outer.tier, scope);
    // Only the fence phase: a label is never rewritten by the pre-pass.
    lx.fence = lx.prepass().1;
    let mut v = View::default();
    v.push_doc(s, 0, s.len());
    match root.first_child() {
        Some(p) if matches!(p.data().value, NodeValue::Paragraph) && p.next_sibling().is_none() => {
            let kids: Vec<N> = p.children().collect();
            lx.inline_seq(&kids, &v, 0, s.len(), &[])
        }
        _ => {
            let mut out = Vec::new();
            lx.push_text(&mut out, s);
            out
        }
    }
}

/// An inline link's `(href, title)`.
pub(super) type LinkDest = (String, Option<String>);

/// The end of a link label (index of its `]`) and, for an inline link, its destination.
pub(super) fn parse_link(raw: &str) -> Option<(usize, Option<LinkDest>)> {
    let b = raw.as_bytes();
    if b.first() != Some(&b'[') {
        return None;
    }
    let mut depth = 0i32;
    let mut i = 1;
    let mut end = None;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'`' => {
                // A code span inside a label hides its brackets.
                let n = raw[i..].len() - raw[i..].trim_start_matches('`').len();
                let fence = &raw[i..i + n];
                if let Some(close) = raw[i + n..].find(fence) {
                    i += n + close + n;
                    continue;
                }
                i += n;
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                if depth == 0 {
                    end = Some(i);
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    let end = end?;
    let rest = &raw[end + 1..];
    if !(rest.starts_with('(') && rest.ends_with(')')) {
        return Some((end, None));
    }
    let inner = rest[1..rest.len() - 1].trim_start_matches(is_js_whitespace);
    let (href, after) = if let Some(r) = inner.strip_prefix('<') {
        let close = r.find('>').unwrap_or(r.len());
        (r[..close].to_string(), &r[(close + 1).min(r.len())..])
    } else {
        let mut depth = 0i32;
        let mut k = 0;
        let ib = inner.as_bytes();
        while k < ib.len() {
            let c = ib[k];
            if c == b'\\' {
                k += 2;
                continue;
            }
            if c == b'(' {
                depth += 1;
            } else if c == b')' {
                if depth == 0 {
                    break;
                }
                depth -= 1;
            } else if c == b' ' || c == b'\t' || c == b'\n' {
                break;
            }
            k += 1;
        }
        let k = k.min(ib.len());
        (inner[..k].to_string(), &inner[k..])
    };
    let after = js_trim(after);
    let title = if after.len() >= 2 {
        Some(unescape_punct(&after[1..after.len() - 1]))
    } else {
        None
    };
    Some((end, Some((unescape_punct(js_trim(&href)), title))))
}

/// A code span's token from its raw source (§6.3: newlines become spaces, and one space is
/// stripped from each end when both ends have one and the content is not all spaces).
pub(super) fn codespan_token(raw: &str) -> Option<Token> {
    let n = raw.len() - raw.trim_start_matches('`').len();
    if raw.len() < 2 * n {
        return None;
    }
    let mut text = raw[n..raw.len() - n].replace('\n', " ");
    if text.bytes().any(|c| c != b' ')
        && text.starts_with(' ')
        && text.ends_with(' ')
        && text.len() >= 2
    {
        text = text[1..text.len() - 1].to_string();
    }
    Some(Token::Codespan {
        text: escape_encode(&text),
    })
}

/// The first complete code span inside plain text `v[from..limit]`: an unescaped backtick
/// run with a later run of equal length before `limit`.
pub(super) fn find_gap_code_span(v: &str, from: usize, limit: usize) -> Option<(usize, usize)> {
    let t = v.as_bytes();
    let mut i = from;
    while i < limit {
        if t[i] != b'`' {
            i += 1;
            continue;
        }
        let run = v[i..limit].len() - v[i..limit].trim_start_matches('`').len();
        let slashes = v[from..i].len() - v[from..i].trim_end_matches('\\').len();
        if slashes.is_multiple_of(2)
            && let Some(e) = code_span_end(&v[..limit], i, limit)
        {
            return Some((i, e));
        }
        i += run;
    }
    None
}

/// The end of the code span opening at `v[s..]`: the next backtick run of the same length.
pub(super) fn code_span_end(v: &str, s: usize, b: usize) -> Option<usize> {
    let t = &v[s..b];
    let n = t.len() - t.trim_start_matches('`').len();
    if n == 0 {
        return None;
    }
    let mut i = n;
    let tb = t.as_bytes();
    while i < tb.len() {
        if tb[i] == b'`' {
            let run = t[i..].len() - t[i..].trim_start_matches('`').len();
            if run == n {
                return Some(s + i + run);
            }
            i += run;
        } else {
            i += 1;
        }
    }
    None
}
