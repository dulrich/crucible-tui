//! Block structure: the gap/`space` accounting, leaf blocks, lists and tables.

use super::*;

impl Lexer<'_> {
    // -- blocks --------------------------------------------------------------

    pub(super) fn start_line(n: N) -> usize {
        n.data().sourcepos.start.line
    }
    pub(super) fn end_line(n: N) -> usize {
        n.data().sourcepos.end.line
    }

    /// The block children of `parent`, with `space` tokens. `from` is the doc offset the
    /// container's content starts at; `until` is `Some(doc end)` when trailing blank lines up
    /// to that offset belong to the container (the document, a non-last list item), `None`
    /// when they are trimmed (a blockquote, the last list item).
    pub(super) fn blocks(
        &mut self,
        parent: N,
        chain: &[Container],
        from: usize,
        until: Option<usize>,
    ) -> Vec<Token> {
        let (tokens, _) = self.blocks_loose(parent, chain, from, until);
        tokens
    }

    pub(super) fn blocks_loose(
        &mut self,
        parent: N,
        chain: &[Container],
        from: usize,
        until: Option<usize>,
    ) -> (Vec<Token>, bool) {
        let mut out: Vec<Token> = Vec::new();
        let mut multi = false;
        let mut prev_end = from;
        let mut prev_consume = Consume::EndOfLine;
        let mut first = true;
        for child in parent.children() {
            if matches!(child.data().value, NodeValue::FrontMatter(_)) {
                continue;
            }
            let start_line = Self::start_line(child);
            let consume = if first {
                Consume::EndOfLine
            } else {
                prev_consume
            };
            for res in self.gap(prev_end, start_line, chain, consume) {
                self.space(&mut out, &res, &mut multi);
            }
            first = false;
            if self.line_of(from) == start_line && from > self.line_start(start_line) {
                self.scope.first_at = Some(from);
            }
            let (tok, end, consume) = self.block(child, chain);
            self.scope.first_at = None;
            out.extend(tok);
            prev_end = end;
            prev_consume = consume;
        }
        if let Some(limit) = until {
            let last_line = self.line_of(limit.min(self.src.len()));
            if limit > prev_end {
                for res in self.gap_to(prev_end, last_line, limit, chain, prev_consume) {
                    self.space(&mut out, &res, &mut multi);
                }
            }
        }
        (out, multi)
    }

    pub(super) fn space(&self, out: &mut Vec<Token>, res: &str, multi: &mut bool) {
        if res.is_empty() {
            return;
        }
        if res.len() == 1 && !out.is_empty() {
            // marked appends a lone newline to the previous token's raw.
            if let Some(Token::Text { raw, .. }) = out.last_mut() {
                raw.push('\n');
            }
            return;
        }
        if res.matches('\n').count() >= 2 {
            *multi = true;
        }
        out.push(Token::Space);
    }

    /// The residual marked sees between a block ending at `from` and a block starting at
    /// line `to_line`, after the first block consumed what its regex consumes. Non-blank
    /// gap lines (link reference definitions) consume their newlines too.
    pub(super) fn gap(
        &self,
        from: usize,
        to_line: usize,
        chain: &[Container],
        consume: Consume,
    ) -> Vec<String> {
        let fl = self.line_of(from);
        if to_line <= fl {
            return Vec::new();
        }
        let head = self.src[from.min(self.line_end(fl))..self.line_end(fl)].to_string();
        // A whole first line that is not a block's tail is a link reference definition: it
        // consumes its `\n+` like any other (marked's `def`, marked.esm.js:993) and leaves no
        // residual of its own — comrak gives a definition no node, so it lands in the gap.
        let (head, consume) = if consume == Consume::EndOfLine
            && from == self.line_start(fl)
            && !head.trim().is_empty()
        {
            (String::new(), Consume::Newlines)
        } else {
            (head, consume)
        };
        let mut parts: Vec<String> = vec![head];
        for l in fl + 1..to_line {
            parts.push(self.line_text(l, chain, true));
        }
        parts.push(String::new());
        Self::residual(&parts, consume, true)
    }

    pub(super) fn gap_to(
        &self,
        from: usize,
        last_line: usize,
        limit: usize,
        chain: &[Container],
        consume: Consume,
    ) -> Vec<String> {
        let fl = self.line_of(from);
        let mut parts: Vec<String> =
            vec![self.src[from.min(self.line_end(fl))..self.line_end(fl)].to_string()];
        for l in fl + 1..=last_line {
            let lv = self.line_view(l, chain, true).0;
            let e = lv.idx(limit);
            parts.push(lv.s[..e].to_string());
        }
        Self::residual(&parts, consume, false)
    }

    /// `parts[0]` is the rest of the block's last line, each later part one following line
    /// (the last one is the next block's line, empty, when `next_block`). A non-blank gap line
    /// is a link reference definition: the residual before it is one segment, and the
    /// definition consumes `\n+` like a heading. Each returned segment is what the space
    /// tokenizer sees, in order.
    pub(super) fn residual(parts: &[String], consume: Consume, next_block: bool) -> Vec<String> {
        let n = parts.len();
        let content_end = if next_block { n.saturating_sub(1) } else { n };
        let mut segs = Vec::new();
        let mut start = 0;
        let mut cons = consume;
        let apply = |s: String, c: Consume| match c {
            Consume::EndOfLine => s,
            Consume::Newlines => s.trim_start_matches('\n').to_string(),
            Consume::BlankLines => {
                if s.trim().is_empty() {
                    String::new()
                } else {
                    s
                }
            }
        };
        for d in 1..content_end {
            if parts[d].trim().is_empty() {
                continue;
            }
            let mut seg = if start == 0 {
                parts[0].clone()
            } else {
                String::new()
            };
            for p in &parts[start + 1..d] {
                seg.push('\n');
                seg.push_str(p);
            }
            seg.push('\n');
            segs.push(apply(seg, cons));
            start = d;
            cons = Consume::Newlines;
        }
        let mut seg = if start == 0 {
            parts[0].clone()
        } else {
            String::new()
        };
        for p in &parts[start + 1..] {
            seg.push('\n');
            seg.push_str(p);
        }
        segs.push(apply(seg, cons));
        segs
    }

    /// One block: its tokens, the doc offset its consumption is measured from, and how much
    /// of what follows marked consumes with it.
    pub(super) fn block(&mut self, n: N, chain: &[Container]) -> (Vec<Token>, usize, Consume) {
        let sp = n.data().sourcepos;
        let l0 = sp.start.line;
        let l1 = sp.end.line.max(l0).min(self.nlines());
        let first = self
            .content_start(l0, chain)
            .0
            .max(self.scope.first_at.unwrap_or(0));
        let eol = self.line_end(l1);
        let value = n.data().value.clone();
        match value {
            NodeValue::Paragraph => {
                let v = self.view_lines(l0, l1, first, chain, true);
                if self.scope.top {
                    let tokens = self.inlines_of(n, &v, 0, v.s.len());
                    (vec![Token::Paragraph { tokens }], eol, Consume::EndOfLine)
                } else {
                    (vec![self.block_text(n, &v)], eol, Consume::EndOfLine)
                }
            }
            NodeValue::Heading(h) => {
                if h.setext {
                    let v = self.view_lines(l0, l1.saturating_sub(1).max(l0), first, chain, true);
                    let tokens = self.inlines_of(n, &v, 0, v.s.len());
                    (
                        vec![Token::Heading {
                            depth: h.level,
                            tokens,
                        }],
                        eol,
                        Consume::Newlines,
                    )
                } else {
                    let v = self.view_lines(l0, l0, first, chain, true);
                    let (a, b) = atx_text(&v.s);
                    let tokens = self.inlines_of(n, &v, a, b);
                    (
                        vec![Token::Heading {
                            depth: h.level,
                            tokens,
                        }],
                        eol,
                        Consume::Newlines,
                    )
                }
            }
            // `hr`'s raw is `rtrim(cap[0], '\n')`, so its newlines are left for `space`.
            // An hr is one line; comrak's sourcepos can run past it at the end of input.
            NodeValue::ThematicBreak => (vec![Token::Hr], self.line_end(l0), Consume::EndOfLine),
            NodeValue::CodeBlock(cb) => {
                if cb.fenced {
                    let line = self.view_lines(l0, l0, first, chain, false).s;
                    let lead = line.len() - line.trim_start_matches(' ').len();
                    let after = &line[lead + cb.fence_length..];
                    let lang = unescape_punct(js_trim(after));
                    let content_last = if cb.closed { l1.saturating_sub(1) } else { l1 };
                    let text = if content_last > l0 {
                        let mut lines = Vec::new();
                        for l in l0 + 1..=content_last {
                            lines.push(self.line_text(l, chain, false));
                        }
                        // An unclosed fence's content runs to the end, minus one final newline.
                        if !cb.closed
                            && lines.last().is_some_and(String::is_empty)
                            && lines.len() > 1
                        {
                            lines.pop();
                        }
                        let lead_ws: String =
                            line.chars().take_while(|c| is_js_whitespace(*c)).collect();
                        indent_compensation(&lead_ws, &line, &lines.join("\n"))
                    } else {
                        String::new()
                    };
                    (
                        vec![Token::Code {
                            lang: Some(lang),
                            text,
                        }],
                        eol,
                        Consume::EndOfLine,
                    )
                } else {
                    let mut lines = Vec::new();
                    for l in l0..=l1 {
                        let lv = self.line_view(l, chain, false).0;
                        let skip = if l == l0 { lv.idx(first) } else { 0 };
                        lines.push(strip_code_indent(&lv.s[skip..]).to_string());
                    }
                    let text = lines.join("\n").trim_end_matches('\n').to_string();
                    (
                        vec![Token::Code { lang: None, text }],
                        eol,
                        Consume::BlankLines,
                    )
                }
            }
            NodeValue::HtmlBlock(hb) => {
                let mut text = self.view_string(l0, l1, first, chain);
                // marked's html regex consumes trailing newlines into the token.
                let (mut extra, consume) = self.html_trailer(l1, chain, hb.block_type);
                // The last list item's content is trimmed at the list's end (marked trims the
                // item's trailing blank lines), so the trailer cannot reach past the clip.
                if self.scope.clip != usize::MAX {
                    let room = self.scope.clip.saturating_sub(self.line_end(l1));
                    extra.truncate(room.min(extra.len()));
                }
                text.push_str(&extra);
                (vec![Token::Html { text }], eol, consume)
            }
            NodeValue::BlockQuote => {
                let mut inner = chain.to_vec();
                inner.push(Container::Quote);
                let from = self.content_start(l0, &inner).0;
                let child = Scope {
                    top: true,
                    cend: self.scope.cend.min(l1),
                    ..self.scope.clone()
                };
                let tokens = self.in_scope(child, |lx| lx.blocks(n, &inner, from, Some(eol)));
                (vec![Token::Blockquote { tokens }], eol, Consume::EndOfLine)
            }
            NodeValue::List(list) => {
                let (tok, end) = self.list(n, chain, list.list_type == ListType::Ordered);
                (vec![tok], end, Consume::EndOfLine)
            }
            NodeValue::Table(t) => {
                let tok = self.table(n, chain, &t.alignments);
                (vec![tok], eol, Consume::Newlines)
            }
            _ => (Vec::new(), eol, Consume::EndOfLine),
        }
    }

    /// What marked's html regex swallows after the block's last line.
    pub(super) fn html_trailer(
        &self,
        l1: usize,
        chain: &[Container],
        block_type: u8,
    ) -> (String, Consume) {
        let mut extra = String::new();
        let last = self.nlines().min(self.scope.cend);
        let mut l = l1 + 1;
        if l > last {
            return (extra, Consume::EndOfLine);
        }
        if block_type >= 6 {
            // `(?:\n[ \t]*)+\n|$`: every whitespace-only line, ending at a newline.
            let mut acc = String::new();
            let mut ok = String::new();
            while l <= last {
                let s = self.line_text(l, chain, true);
                if !s.trim_matches([' ', '\t']).is_empty() {
                    break;
                }
                acc.push('\n');
                acc.push_str(&s);
                if l < last {
                    ok = format!("{acc}\n");
                }
                l += 1;
            }
            // At the end of the document `$` takes everything that is left.
            let ok = if l > last { acc } else { ok };
            let consume = if ok.is_empty() {
                Consume::EndOfLine
            } else {
                Consume::BlankLines
            };
            extra = ok;
            (extra, consume)
        } else {
            // `\n+`: the newline and every directly following empty line's newline.
            while l <= last {
                let s = self.line_text(l, chain, true);
                extra.push('\n');
                if !s.is_empty() || l == last {
                    break;
                }
                l += 1;
            }
            (extra, Consume::Newlines)
        }
    }

    /// A non-top paragraph: marked's block `text` tokens, one per line, merged.
    pub(super) fn block_text(&mut self, n: N, v: &View) -> Token {
        let lines: Vec<&str> = v.s.split('\n').collect();
        let mut raw = String::new();
        let mut text = String::new();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let indented = i > 0 && line.len() - line.trim_start_matches(' ').len() >= 4;
            if i > 0 {
                raw.push_str("\n\n");
                text.push('\n');
            }
            if indented {
                // marked's `code` tokenizer takes the run and merges it into the text.
                let mut j = i;
                let mut raws = Vec::new();
                let mut texts = Vec::new();
                while j < lines.len()
                    && lines[j].len() - lines[j].trim_start_matches(' ').len() >= 4
                {
                    raws.push(lines[j]);
                    texts.push(strip_code_indent(lines[j]));
                    j += 1;
                }
                raw.push_str(&raws.join("\n"));
                text.push_str(&texts.join("\n"));
                i = j;
                continue;
            }
            raw.push_str(line);
            text.push_str(line);
            i += 1;
        }
        let tokens = if text == v.s {
            self.inlines_of(n, v, 0, v.s.len())
        } else {
            // Indented continuation stripped: re-map through a rebuilt view.
            let mut nv = View::default();
            let mut k = 0;
            for (idx, line) in v.s.split('\n').enumerate() {
                if idx > 0 {
                    // The newline keeps its own doc offset: mapped one byte on, it would
                    // share the next line's first offset, and a node starting the line
                    // (`![](…)`) would take the newline into its range.
                    nv.push_str_at("\n", v.offs[k - 1]);
                }
                let skip = if idx > 0 && line.len() - line.trim_start_matches(' ').len() >= 4 {
                    line.len() - strip_code_indent(line).len()
                } else {
                    0
                };
                let sub = v.sub(k + skip, k + line.len());
                nv.s.push_str(&sub.s);
                nv.offs.extend(sub.offs);
                k += line.len() + 1;
            }
            self.inlines_of(n, &nv, 0, nv.s.len())
        };
        Token::Text {
            raw,
            text,
            tokens: Some(tokens),
        }
    }

    pub(super) fn list(&mut self, n: N, chain: &[Container], ordered: bool) -> (Token, usize) {
        let items: Vec<N> = n.children().collect();
        let mut out = Vec::new();
        let mut loose = false;
        let mut ends_blank = false;
        let mut list_end = self.content_start(Self::start_line(n), chain).0;
        for (k, item) in items.iter().enumerate() {
            let l0 = Self::start_line(item);
            let last = k + 1 == items.len();
            let next_line = if last {
                None
            } else {
                Some(Self::start_line(items[k + 1]))
            };
            let item_end_line = match next_line {
                Some(nl) => nl - 1,
                None => Self::end_line(item).max(l0).min(self.nlines()),
            };
            let (p0, _) = self.content_start(l0, chain);
            // raw: the list container's view of the item's lines.
            let mut raw = self.view_string(l0, item_end_line, p0, chain);
            if next_line.is_some() {
                raw.push('\n');
            } else {
                raw.truncate(content_end(&raw));
                // The list ends at the last non-whitespace character of its last item.
                let v = self.view_lines(l0, item_end_line, p0, chain, true);
                let trimmed = content_end(&v.s);
                list_end = if trimmed == 0 {
                    p0
                } else {
                    let off = v.offs[trimmed - 1];
                    let end = off + v.s[..trimmed].chars().last().map_or(1, char::len_utf8);
                    // A pre-pass replacement maps every byte to `sub.start`; ending inside it
                    // means ending after it (the ascii `[\u{1} ]` is one byte longer than `[ ]`).
                    match self.subs.get(&self.line_of(off)) {
                        Some(sub) if sub.start <= off && off < sub.end => end.max(sub.end),
                        _ => end,
                    }
                };
            }
            if !loose {
                if ends_blank {
                    loose = true;
                } else if raw_ends_blank(&raw) {
                    ends_blank = true;
                }
            }
            let indent = Self::item_indent(&self.line_text(l0, chain, false));
            let mut inner = chain.to_vec();
            inner.push(Container::Item { line: l0, indent });
            let (cs, _) = self.content_start(l0, &inner);
            // Task state.
            let line_has_sub = self.subs.contains_key(&l0) && {
                let s = &self.subs[&l0];
                s.start >= cs && s.start <= cs + 1
            };
            let mut task = false;
            let mut checked = None;
            let mut from = cs;
            if let NodeValue::TaskItem(t) = &item.data().value
                && !line_has_sub
            {
                let ch = t.symbol.unwrap_or(' ');
                let rest = &self.src[cs.min(self.line_end(l0))..self.line_end(l0)];
                let gfm = matches!(ch, ' ' | 'x' | 'X');
                let rewritable = task_state_line(&self.src[self.line_start(l0)..self.line_end(l0)])
                    .is_some()
                    && !self.in_prepass_fence(l0);
                if rest.starts_with('[') && !(rewritable && !gfm) {
                    // A real task item: marked strips `[c] +`.
                    let after = 2 + ch.len_utf8();
                    if rest.len() > after && rest.as_bytes()[after] == b' '
                        || rest.len() == after && !gfm
                    {
                        task = true;
                        checked = Some(ch != ' ');
                        let mut q = cs + after;
                        while q < self.line_end(l0) && self.src.as_bytes()[q] == b' ' {
                            q += 1;
                        }
                        from = q;
                    }
                }
            }
            let until = if last {
                None
            } else {
                Some(self.line_start(item_end_line + 1).saturating_sub(1))
            };
            let child = Scope {
                top: false,
                clip: if last {
                    self.scope.clip.min(list_end)
                } else {
                    self.scope.clip
                },
                cend: self.scope.cend.min(item_end_line),
                ..self.scope.clone()
            };
            // The parent's `clip` and `cend` come back here; the lookahead below reads
            // neither (`line_text` is unclipped), so restoring `clip` before it is unchanged.
            let (mut tokens, multi) =
                self.in_scope(child, |lx| lx.item_blocks(item, &inner, from, until, l0));
            self.scope.top = TOP_AFTER_ITEM;
            // A non-last item's content ends without a newline. When its last line is
            // whitespace that survives the item's dedent, directly after a blockquote, marked's
            // blockquote `paragraph` lookahead (` +\n`) cannot fail there, so that whitespace
            // becomes the quote's own trailing `space` instead of the item's.
            if next_line.is_some() && item_end_line > l0 {
                let last_txt = self.line_text(item_end_line, &inner, false);
                let prev = self.line_text(item_end_line - 1, &inner, false);
                if !last_txt.is_empty()
                    && last_txt.trim_matches([' ', '\t']).is_empty()
                    && !prev.trim().is_empty()
                    && matches!(
                        tokens.as_slice(),
                        [.., Token::Blockquote { .. }, Token::Space]
                    )
                {
                    tokens.pop();
                    if let Some(Token::Blockquote { tokens: q }) = tokens.last_mut() {
                        q.push(Token::Space);
                    }
                }
            }
            if multi {
                loose = true;
            }
            out.push(ListItem {
                raw,
                task,
                checked,
                loose: false,
                tokens,
            });
        }
        if loose {
            for it in &mut out {
                it.loose = true;
            }
        }
        (
            Token::List {
                ordered,
                items: out,
            },
            list_end,
        )
    }

    /// The pre-pass's fence phase at the start of line `l`, as `prepass` recorded it.
    pub(super) fn in_prepass_fence(&self, l: usize) -> bool {
        self.fence.get(l).copied().unwrap_or(false)
    }

    /// The item's block children. A task item's paragraph starts after the checkbox.
    pub(super) fn item_blocks(
        &mut self,
        item: N,
        chain: &[Container],
        from: usize,
        until: Option<usize>,
        l0: usize,
    ) -> (Vec<Token>, bool) {
        let (mut tokens, multi) = self.blocks_loose(item, chain, from, until);
        // comrak detaches a task item's paragraph when only the checkbox was on the line; the
        // rewritten line (`- ○ `) still carries text for marked.
        if item.first_child().is_none_or(|c| Self::start_line(c) > l0) {
            let v = self.view_lines(l0, l0, from, chain, true);
            let t = v.s.as_str();
            if !t.trim_matches(is_js_whitespace).is_empty() {
                let text = Token::Text {
                    raw: t.to_string(),
                    text: t.to_string(),
                    tokens: Some(vec![self.text_token(t)]),
                };
                tokens.retain(|t| *t != Token::Space);
                tokens.insert(0, text);
            }
        }
        (tokens, multi)
    }

    /// marked's item indent: marker (with up to 3 leading spaces) plus the spaces after it
    /// (1 when there are more than 4, or the line is blank after the marker).
    pub(super) fn item_indent(line: &str) -> usize {
        let b = line.as_bytes();
        let end = b.len();
        let mut q = 0;
        while q < end && b[q] == b' ' && q < 3 {
            q += 1;
        }
        if q < end && matches!(b[q], b'*' | b'+' | b'-') {
            q += 1;
        } else {
            while q < end && b[q].is_ascii_digit() {
                q += 1;
            }
            if q < end && matches!(b[q], b'.' | b')') {
                q += 1;
            }
        }
        let rest = &line[q..];
        if rest.trim().is_empty() {
            return q + 1;
        }
        let n = rest.len() - rest.trim_start_matches(' ').len();
        let n = if n > 4 { 1 } else { n };
        q + n
    }

    pub(super) fn table(&mut self, n: N, chain: &[Container], aligns: &[TableAlignment]) -> Token {
        let rows: Vec<N> = n.children().collect();
        let align: Vec<Option<crate::text::Align>> = aligns
            .iter()
            .map(|a| match a {
                TableAlignment::Left => Some(crate::text::Align::Left),
                TableAlignment::Right => Some(crate::text::Align::Right),
                TableAlignment::Center => Some(crate::text::Align::Center),
                TableAlignment::None => None,
            })
            .collect();
        let mut header = Vec::new();
        let mut body = Vec::new();
        let count = align.len();
        for (k, row) in rows.iter().enumerate() {
            let l = Self::start_line(row);
            let (a, _) = self.content_start(l, chain);
            let v = self.view_lines(l, l, a, chain, true);
            let cells = split_cells(&v, if k == 0 { None } else { Some(count) });
            let mut out = Vec::new();
            for cv in cells {
                let tokens = self.inlines_in(row, &cv, true);
                out.push(TableCell {
                    text: cv.s.clone(),
                    tokens,
                });
            }
            if k == 0 {
                header = out;
            } else {
                body.push(out);
            }
        }
        Token::Table {
            header,
            rows: body,
            align,
        }
    }
}

/// `^(\s*[-*+]\s+)\[(.)\](\s)` over one line: the byte offset of `[` and the state char.
pub(super) fn task_state_line(line: &str) -> Option<(usize, char)> {
    let mut it = line.char_indices().peekable();
    while let Some(&(_, c)) = it.peek() {
        if is_js_whitespace(c) {
            it.next();
        } else {
            break;
        }
    }
    let (_, bullet) = it.next()?;
    if !matches!(bullet, '-' | '*' | '+') {
        return None;
    }
    let mut gap = 0;
    while let Some(&(_, c)) = it.peek() {
        if is_js_whitespace(c) {
            it.next();
            gap += 1;
        } else {
            break;
        }
    }
    if gap == 0 {
        return None;
    }
    let (bs, open) = it.next()?;
    if open != '[' {
        return None;
    }
    let (_, ch) = it.next()?;
    if ch == '\n' || ch == '\r' || ch == '\u{2028}' || ch == '\u{2029}' || ch.len_utf16() != 1 {
        return None;
    }
    let (_, close) = it.next()?;
    if close != ']' {
        return None;
    }
    let (_, ws) = it.next()?;
    is_js_whitespace(ws).then_some((bs, ch))
}

/// Where a last item's content ends: marked's `trimEnd`, over ASCII whitespace only. A
/// non-ASCII JS-whitespace character (U+00A0, U+3000, …) is content to CommonMark (§2.1
/// counts only spaces and tabs as blank, and §4.8 strips only those from a paragraph), and
/// comrak keeps it in the item's paragraph; trimming it as marked does would drop it from
/// the token stream entirely, since marked re-lexes what it trimmed and Rust does not.
pub(super) fn content_end(s: &str) -> usize {
    s.trim_end_matches(|c: char| c.is_ascii() && is_js_whitespace(c))
        .len()
}

/// `/\n[ \t]*\n[ \t]*$/`.
pub(super) fn raw_ends_blank(raw: &str) -> bool {
    let t = raw.trim_end_matches([' ', '\t']);
    let Some(t) = t.strip_suffix('\n') else {
        return false;
    };
    t.trim_end_matches([' ', '\t']).ends_with('\n')
}

/// `^(?: {1,4}| {0,3}\t)` removed.
pub(super) fn strip_code_indent(s: &str) -> &str {
    let b = s.as_bytes();
    let mut n = 0;
    while n < b.len() && n < 4 && b[n] == b' ' {
        n += 1;
    }
    if n < 4 && n < b.len() && b[n] == b'\t' {
        return &s[n + 1..];
    }
    &s[n..]
}

/// marked's `indentCodeCompensation`.
pub(super) fn indent_compensation(lead: &str, line: &str, text: &str) -> String {
    if lead.is_empty() || !line[lead.len()..].starts_with("```") {
        return text.to_string();
    }
    let n = lead.chars().count();
    text.split('\n')
        .map(|node| {
            let ws: usize = node.chars().take_while(|c| is_js_whitespace(*c)).count();
            if ws == 0 {
                node.to_string()
            } else if ws >= n {
                node.chars().skip(n).collect()
            } else {
                node.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The `[a, b)` range of an ATX heading's text within its line.
pub(super) fn atx_text(line: &str) -> (usize, usize) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i] == b' ' {
        i += 1;
    }
    while i < b.len() && b[i] == b'#' {
        i += 1;
    }
    let content = &line[i..];
    let lead = content.len() - content.trim_start_matches(is_js_whitespace).len();
    let mut a = i + lead;
    let mut e = i + content.trim_end_matches(is_js_whitespace).len();
    if a > e {
        a = e;
    }
    let text = &line[a..e];
    if text.ends_with('#') {
        let trimmed = text.trim_end_matches('#');
        if trimmed.is_empty() || trimmed.ends_with(' ') {
            let t2 = js_trim(trimmed);
            if t2.is_empty() {
                return (a, a);
            }
            let off = trimmed.len() - trimmed.trim_start_matches(is_js_whitespace).len();
            a += off;
            e = a + t2.len();
        }
    }
    (a, e)
}
