//! The comrak tree to marked-shaped token adapter (WP-7 of `plans/mdview-rust-port.md`).
//!
//! `lex(body, tier)` is a pure function producing exactly the census tokens
//! (`crate::token::Token`) that `TS_BASELINE` `src/render.ts`'s `lexBody` produces, modulo the registered
//! divergences (`scripts/divergences.ts`). comrak decides **structure** — which blocks exist,
//! where they start and end, and which inline nodes exist — and every string field is rebuilt
//! from the **source**, through comrak's sourcepos, the way marked would have sliced it:
//!
//! - **The view.** marked lexes a container's content as a string with its own prefixes
//!   removed (`> ` for a blockquote, the item indent for a list item; a lazy line is kept
//!   whole). [`View`] is that string, with a document byte offset per byte, so a comrak node's
//!   sourcepos maps onto it. Text tokens are the gaps between structural inline nodes, so
//!   `raw`/`text` are marked's source slices, never comrak's resolved literals.
//! - **Normalization.** `\r\n|\r` → `\n` (marked's `lex`), code points 0 and 1 stripped
//!   (`preprocessBody`).
//! - **Task items (D-B).** The retired pre-pass (`rewriteTaskState`) is reproduced at token
//!   level as a substitution on the view: the lines it would have rewritten carry the glyph
//!   (Unicode tier) or the `[<U+0001>c]` literal (ASCII tier). Code blocks are verbatim (D-B's
//!   fence repair), and task items the pre-pass never reached (blockquote, ordered list, a
//!   line in its fence phase) become real task items.
//! - **`space` tokens** come from the gap between two blocks, after each block type consumes
//!   what marked's regex for it consumes.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{Arena, Options, ResolvedReference, parse_document};

use crate::render::Tier;
use crate::token::{ListItem, TableCell, Token};

/// `TS_BASELINE` `src/lists.ts`'s `TASK_GLYPHS`, the Unicode tier's task-state table.
const TASK_GLYPHS: &[(char, &str)] = &[
    (' ', "○"),
    ('x', "✓"),
    ('X', "✓"),
    ('/', "◐"),
    ('-', "✗"),
    ('>', "➤"),
    ('<', "◷"),
    ('?', "?"),
    ('!', "!"),
    ('*', "★"),
    ('"', "❝"),
    ('l', "📍"),
    ('b', "🔖"),
    ('i', "ℹ"),
    ('S', "🐖"),
    ('I', "💡"),
    ('p', "👍"),
    ('c', "👎"),
    ('f', "🔥"),
    ('k', "🔑"),
    ('w', "🏆"),
    ('u', "⬆"),
    ('d', "⬇"),
];

/// A three-byte letter standing in for a leading U+FEFF in the string comrak parses.
const BOM_STAND_IN: char = '\u{4e00}';

/// `\r\n|\r` → `\n`, then code points 0 and 1 removed.
pub fn normalize(body: &str) -> String {
    body.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|&c| c != '\u{0}' && c != '\u{1}')
        .collect()
}

/// JS `\s` (ECMAScript WhiteSpace + LineTerminator).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// marked's `escape(html)` without `encode`: an `&` that already starts an entity is kept.
pub fn escape_no_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for (i, c) in s.char_indices() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '&' if !starts_entity(&s[i + 1..]) => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
    out
}

/// `(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);` at the start of `s`.
fn starts_entity(s: &str) -> bool {
    let b = s.as_bytes();
    let run = |from: usize, pred: &dyn Fn(u8) -> bool, max: usize| {
        let mut n = 0;
        while from + n < b.len() && n < max && pred(b[from + n]) {
            n += 1;
        }
        n
    };
    if b.first() == Some(&b'#') {
        if matches!(b.get(1), Some(b'x' | b'X')) {
            let n = run(2, &|c| c.is_ascii_hexdigit(), 6);
            if n > 0 && b.get(2 + n) == Some(&b';') {
                return true;
            }
        }
        let n = run(1, &|c| c.is_ascii_digit(), 7);
        return n > 0 && b.get(1 + n) == Some(&b';');
    }
    let n = run(0, &|c| c.is_ascii_alphanumeric() || c == b'_', usize::MAX);
    n > 0 && b.get(n) == Some(&b';')
}

/// marked's `escape(html, true)`.
fn escape_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// marked's `anyPunctuation` unescape: `\` before an ASCII punctuation character is dropped.
fn unescape_punct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&n) = chars.peek()
            && (n.is_ascii_punctuation())
        {
            out.push(n);
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// The view: a container-stripped string with a document offset per byte
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct View {
    s: String,
    offs: Vec<usize>,
}

impl View {
    fn push_doc(&mut self, src: &str, a: usize, b: usize) {
        for (i, ch) in src[a..b].char_indices() {
            for _ in 0..ch.len_utf8() {
                self.offs.push(a + i);
            }
            self.s.push(ch);
        }
    }
    fn push_str_at(&mut self, text: &str, off: usize) {
        self.s.push_str(text);
        self.offs.extend(std::iter::repeat_n(off, text.len()));
    }
    /// The first view index whose document offset is `>= doc`.
    fn idx(&self, doc: usize) -> usize {
        self.offs.partition_point(|&o| o < doc)
    }
    fn sub(&self, a: usize, b: usize) -> View {
        View {
            s: self.s[a..b].to_string(),
            offs: self.offs[a..b].to_vec(),
        }
    }
}

/// One rewrite the retired pre-pass would have made on one document line.
#[derive(Debug, Clone)]
struct Sub {
    start: usize,
    end: usize,
    rep: String,
}

#[derive(Debug, Clone, Copy)]
enum Container {
    Quote,
    Item { line: usize, indent: usize },
}

/// How much of the source after a block marked's regex for that block consumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Consume {
    /// Up to the end of the last line, not its newline.
    EndOfLine,
    /// The last line's newline and every directly following newline.
    Newlines,
    /// Every following whitespace-only line.
    BlankLines,
}

type N<'a> = &'a AstNode<'a>;

struct Lexer<'s> {
    src: &'s str,
    line_starts: Vec<usize>,
    subs: HashMap<usize, Sub>,
    tier: Tier,
    in_link: bool,
    in_raw: bool,
    top: bool,
    /// The doc offset the current container's first block starts at (a list item's text
    /// after its marker and checkbox).
    first_at: Option<usize>,
    /// marked trims the last list item's text: nothing at or after this doc offset is seen.
    clip: usize,
    /// The last source line of the innermost container (blockquote or list item): marked
    /// lexes a container's content as its own string, so nothing past it is visible.
    cend: usize,
    /// Inside a table cell: the cell's first doc offset as comrak reports it, and the doc
    /// offset of every byte of the unescaped cell string. comrak unescapes `\\|` before
    /// parsing a cell and reports its inline sourcepos in the unescaped string's coordinates,
    /// so a reported offset is `base + index`, and `offs[index]` is the real one.
    cell: Option<(usize, Vec<usize>)>,
    /// Lazy lines whose container prefix ended inside a tab, by line: the tab's doc offset and
    /// the virtual spaces left of it. comrak's lazy paragraph continuation (`add_line`, reached
    /// without the non-lazy path's advance to the first non-space) pads those spaces into the
    /// paragraph content but records the line offset *after* the tab, so every inline sourcepos
    /// on the line reads that many bytes late.
    tab_pad: RefCell<HashMap<usize, (usize, usize)>>,
}

/// Options per Decisions locked 2.
fn options() -> Options<'static> {
    let mut o = Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.extension.wikilinks_title_after_pipe = true;
    o.parse.relaxed_tasklist_matching = true;
    o.parse.escaped_char_spans = true;
    o
}

/// A reference label's lookup key: comrak's normalization (trim, collapse whitespace, case
/// fold), approximated with Unicode lowercase.
fn fold_label(l: &str) -> String {
    l.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Every link reference definition comrak recognised in `src`: the def-shaped lines no leaf
/// block covers (comrak consumes definitions into its private refmap, so they are the lines
/// between leaves), resolved by comrak itself in a probe document that uses each label once.
fn reference_definitions<'a>(
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

/// Lex a body (frontmatter already split off) at a glyph tier.
pub fn lex(body: &str, tier: Tier) -> Vec<Token> {
    let src = normalize(body);
    // D-D: marked reads a leading U+FEFF as paragraph content (it is not a block-start
    // character), while comrak strips it. Hand comrak a same-width ordinary letter in its
    // place, so it builds marked's tree; every token reads its text from `src`, never from
    // the parse string, so the BOM itself comes back out.
    let mut parsed = match src.strip_prefix('\u{feff}') {
        Some(rest) => format!("{BOM_STAND_IN}{rest}"),
        None => src.clone(),
    };
    // comrak leaves a link reference definition on a last line without a newline as paragraph
    // text; CommonMark §4.7 (and marked's `def`, `(?:\n+|$)`, marked.esm.js:993) end one at
    // the end of the document too. A trailing newline moves no byte comrak reports.
    if !parsed.is_empty() && !parsed.ends_with('\n') {
        parsed.push('\n');
    }
    let arena = Arena::new();
    let mut root = parse_document(&arena, &parsed, &options());
    let refs = reference_definitions(root, &parsed);
    if !refs.is_empty() {
        // comrak caps the bytes of resolved references at min(input size, 100000) (a
        // quadratic-expansion guard cmark also has; no CommonMark rule). marked has no cap,
        // so every reference past it would stay unresolved: resolve the overflow from the
        // document's own definitions, as comrak itself parsed them.
        let mut o = options();
        let map = Arc::new(refs);
        o.parse.broken_link_callback =
            Some(Arc::new(move |r: comrak::options::BrokenLinkReference| {
                map.get(&fold_label(r.normalized)).cloned()
            }));
        root = parse_document(&arena, &parsed, &o);
    }
    let mut line_starts = vec![0];
    for (i, b) in src.bytes().enumerate() {
        if b == b'\n' {
            line_starts.push(i + 1);
        }
    }
    let mut lx = Lexer {
        src: &src,
        line_starts,
        subs: HashMap::new(),
        tier,
        in_link: false,
        in_raw: false,
        top: true,
        first_at: None,
        clip: usize::MAX,
        cend: usize::MAX,
        cell: None,
        tab_pad: RefCell::new(HashMap::new()),
    };
    lx.subs = lx.prepass();
    let end = src.len();
    lx.blocks(root, &[], 0, Some(end))
}

impl<'s> Lexer<'s> {
    // -- lines ---------------------------------------------------------------

    fn nlines(&self) -> usize {
        self.line_starts.len()
    }
    fn line_start(&self, l: usize) -> usize {
        self.line_starts[l - 1]
    }
    fn line_end(&self, l: usize) -> usize {
        if l < self.nlines() {
            self.line_starts[l] - 1
        } else {
            self.src.len()
        }
    }
    fn line_of(&self, off: usize) -> usize {
        self.line_starts.partition_point(|&s| s <= off)
    }

    /// The retired `rewriteTaskState` pre-pass, as a per-line substitution table.
    fn prepass(&self) -> HashMap<usize, Sub> {
        let mut subs = HashMap::new();
        let mut in_fence = false;
        for l in 1..=self.nlines() {
            let line = &self.src[self.line_start(l)..self.line_end(l)];
            let trimmed = line.trim_start_matches(js_space);
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            let Some((bs, ch)) = task_state_line(line) else {
                continue;
            };
            let rep = match self.tier {
                Tier::Unicode => TASK_GLYPHS
                    .iter()
                    .find(|(c, _)| *c == ch)
                    .map(|(_, g)| (*g).to_string()),
                Tier::Ascii => matches!(ch, ' ' | 'x' | 'X').then(|| format!("[\u{1}{ch}]")),
            };
            if let Some(rep) = rep {
                let start = self.line_start(l) + bs;
                subs.insert(
                    l,
                    Sub {
                        start,
                        end: start + 2 + ch.len_utf8(),
                        rep,
                    },
                );
            }
        }
        subs
    }

    /// Line `l` as marked sees it under a container chain: a blockquote strips
    /// ` {0,3}>[ \t]?`; a list item strips its indent — on a continuation line after
    /// expanding every tab to four spaces (`nextLine.replace(/\t/g, '    ')`) — and a line
    /// that cannot be stripped is lazy and kept whole from there on.
    fn line_view(&self, l: usize, chain: &[Container], subs: bool) -> (View, bool) {
        let mut full = View::default();
        self.push(&mut full, self.line_start(l), self.line_end(l), subs);
        let mut cur: Vec<(char, usize)> = full
            .s
            .char_indices()
            .map(|(i, c)| (c, full.offs[i]))
            .collect();
        let build = |cur: &[(char, usize)]| {
            let mut v = View::default();
            for &(c, o) in cur {
                v.s.push(c);
                v.offs.extend(std::iter::repeat_n(o, c.len_utf8()));
            }
            v
        };
        for c in chain {
            match *c {
                Container::Quote => {
                    let mut q = 0;
                    while q < cur.len() && q < 3 && cur[q].0 == ' ' {
                        q += 1;
                    }
                    if q < cur.len() && cur[q].0 == '>' {
                        q += 1;
                        if q < cur.len() && (cur[q].0 == ' ' || cur[q].0 == '\t') {
                            q += 1;
                        }
                        cur.drain(..q);
                    } else {
                        // An item's indent that stopped inside an expanded tab leaves that
                        // tab's remaining spaces at the front of a lazy line.
                        if let Some(&(' ', o)) = cur.first()
                            && self.src.as_bytes().get(o) == Some(&b'\t')
                        {
                            let pad = cur.iter().take_while(|&&(c, x)| c == ' ' && x == o).count();
                            if pad < 4 {
                                self.tab_pad.borrow_mut().insert(l, (o, pad));
                            }
                        }
                        return (build(&cur), true);
                    }
                }
                Container::Item { line, indent } => {
                    if l == line {
                        let k = indent.min(cur.len());
                        let after_marker = k > 0 && cur[k - 1].0 != ' ';
                        cur.drain(..k);
                        // marked expands the tabs that open the text right after the marker to
                        // three spaces each (`replace(/^\t+/, …)`, marked.esm.js:417); its indent
                        // search stops at a tab, so they stay in the item's text.
                        let tabs = if after_marker {
                            cur.iter().take_while(|(c, _)| *c == '\t').count()
                        } else {
                            0
                        };
                        if tabs > 0 {
                            let lead: Vec<(char, usize)> = cur[..tabs]
                                .iter()
                                .flat_map(|&(_, o)| [(' ', o); 3])
                                .collect();
                            cur.splice(..tabs, lead);
                        }
                    } else {
                        let exp: Vec<(char, usize)> = cur
                            .iter()
                            .flat_map(|&(c, o)| {
                                if c == '\t' {
                                    vec![(' ', o); 4]
                                } else {
                                    vec![(c, o)]
                                }
                            })
                            .collect();
                        // §2.1: only spaces and tabs make a line blank; a U+00A0 line is
                        // content (lazy), which is how comrak placed it.
                        let blank = cur.iter().all(|(c, _)| matches!(c, ' ' | '\t' | '\n'));
                        let lead = exp.iter().take_while(|(c, _)| *c == ' ').count();
                        if blank || lead >= indent {
                            cur = exp;
                            let k = indent.min(cur.len());
                            cur.drain(..k);
                        } else {
                            return (build(&cur), true);
                        }
                    }
                }
            }
        }
        (build(&cur), false)
    }

    fn line_text(&self, l: usize, chain: &[Container], subs: bool) -> String {
        self.line_view(l, chain, subs).0.s
    }

    /// The doc offset line `l`'s view starts at under a chain, and whether it is lazy.
    fn content_start(&self, l: usize, chain: &[Container]) -> (usize, bool) {
        let (v, lazy) = self.line_view(l, chain, false);
        (v.offs.first().copied().unwrap_or(self.line_end(l)), lazy)
    }

    /// Append doc `[a, b)` to a view, applying the pre-pass substitution when `subs`.
    fn push(&self, v: &mut View, a: usize, b: usize, subs: bool) {
        if subs {
            let l = self.line_of(a);
            if let Some(sub) = self.subs.get(&l)
                && sub.start >= a
                && sub.end <= b
            {
                v.push_doc(self.src, a, sub.start);
                v.push_str_at(&sub.rep, sub.start);
                v.push_doc(self.src, sub.end, b);
                return;
            }
        }
        v.push_doc(self.src, a, b);
    }

    /// The view of lines `l0..=l1`, the first starting at `first` (a doc offset).
    fn view_lines(
        &self,
        l0: usize,
        l1: usize,
        first: usize,
        chain: &[Container],
        subs: bool,
    ) -> View {
        let mut v = View::default();
        for l in l0..=l1 {
            if l > l0 {
                v.push_str_at("\n", self.line_start(l) - 1);
            }
            let (lv, _) = self.line_view(l, chain, subs);
            let skip = if l == l0 { lv.idx(first) } else { 0 };
            v.s.push_str(&lv.s[skip..]);
            v.offs.extend_from_slice(&lv.offs[skip..]);
        }
        let keep = v.offs.partition_point(|&o| o < self.clip);
        v.s.truncate(keep);
        v.offs.truncate(keep);
        v
    }

    fn view_string(&self, l0: usize, l1: usize, first: usize, chain: &[Container]) -> String {
        self.view_lines(l0, l1, first, chain, true).s
    }

    // -- blocks --------------------------------------------------------------

    fn start_line(n: N) -> usize {
        n.data().sourcepos.start.line
    }
    fn end_line(n: N) -> usize {
        n.data().sourcepos.end.line
    }

    /// The block children of `parent`, with `space` tokens. `from` is the doc offset the
    /// container's content starts at; `until` is `Some(doc end)` when trailing blank lines up
    /// to that offset belong to the container (the document, a non-last list item), `None`
    /// when they are trimmed (a blockquote, the last list item).
    fn blocks(
        &mut self,
        parent: N,
        chain: &[Container],
        from: usize,
        until: Option<usize>,
    ) -> Vec<Token> {
        let (tokens, _) = self.blocks_loose(parent, chain, from, until);
        tokens
    }

    fn blocks_loose(
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
                self.first_at = Some(from);
            }
            let (tok, end, consume) = self.block(child, chain);
            self.first_at = None;
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

    fn space(&self, out: &mut Vec<Token>, res: &str, multi: &mut bool) {
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
    fn gap(
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

    fn gap_to(
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
    fn residual(parts: &[String], consume: Consume, next_block: bool) -> Vec<String> {
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
    fn block(&mut self, n: N, chain: &[Container]) -> (Vec<Token>, usize, Consume) {
        let sp = n.data().sourcepos;
        let l0 = sp.start.line;
        let l1 = sp.end.line.max(l0).min(self.nlines());
        let first = self
            .content_start(l0, chain)
            .0
            .max(self.first_at.unwrap_or(0));
        let eol = self.line_end(l1);
        let value = n.data().value.clone();
        match value {
            NodeValue::Paragraph => {
                let v = self.view_lines(l0, l1, first, chain, true);
                if self.top {
                    let tokens = self.inlines_of(n, &v, 0, v.s.len());
                    (vec![Token::Paragraph { tokens }], eol, Consume::EndOfLine)
                } else {
                    (
                        vec![self.block_text(n, l0, l1, first, chain, &v)],
                        eol,
                        Consume::EndOfLine,
                    )
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
                        let lead_ws: String = line.chars().take_while(|c| js_space(*c)).collect();
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
                if self.clip != usize::MAX {
                    let room = self.clip.saturating_sub(self.line_end(l1));
                    extra.truncate(room.min(extra.len()));
                }
                text.push_str(&extra);
                (vec![Token::Html { text }], eol, consume)
            }
            NodeValue::BlockQuote => {
                let mut inner = chain.to_vec();
                inner.push(Container::Quote);
                let from = self.content_start(l0, &inner).0;
                let saved = self.top;
                let saved_cend = self.cend;
                self.top = true;
                self.cend = self.cend.min(l1);
                let tokens = self.blocks(n, &inner, from, Some(eol));
                self.top = saved;
                self.cend = saved_cend;
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
    fn html_trailer(&self, l1: usize, chain: &[Container], block_type: u8) -> (String, Consume) {
        let mut extra = String::new();
        let last = self.nlines().min(self.cend);
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
    fn block_text(
        &mut self,
        n: N,
        l0: usize,
        l1: usize,
        first: usize,
        chain: &[Container],
        v: &View,
    ) -> Token {
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
        let _ = (l0, l1, first, chain);
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

    fn list(&mut self, n: N, chain: &[Container], ordered: bool) -> (Token, usize) {
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
                s.start >= cs.saturating_sub(0) && s.start <= cs + 1
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
            self.top = false;
            let saved_clip = self.clip;
            if last {
                self.clip = self.clip.min(list_end);
            }
            let saved_cend = self.cend;
            self.cend = self.cend.min(item_end_line);
            let (mut tokens, multi) = self.item_blocks(item, &inner, from, until, l0);
            self.cend = saved_cend;
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
            self.clip = saved_clip;
            self.top = true;
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

    fn in_prepass_fence(&self, l: usize) -> bool {
        let mut in_fence = false;
        for k in 1..l {
            let line = &self.src[self.line_start(k)..self.line_end(k)];
            let t = line.trim_start_matches(js_space);
            if t.starts_with("```") || t.starts_with("~~~") {
                in_fence = !in_fence;
            }
        }
        in_fence
    }

    /// The item's block children. A task item's paragraph starts after the checkbox.
    fn item_blocks(
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
            if !t.trim_matches(js_space).is_empty() {
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
    fn item_indent(line: &str) -> usize {
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

    fn table(&mut self, n: N, chain: &[Container], aligns: &[TableAlignment]) -> Token {
        let rows: Vec<N> = n.children().collect();
        let align: Vec<Option<String>> = aligns
            .iter()
            .map(|a| match a {
                TableAlignment::Left => Some("left".to_string()),
                TableAlignment::Right => Some("right".to_string()),
                TableAlignment::Center => Some("center".to_string()),
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

    // -- inlines -------------------------------------------------------------

    /// Inline tokens for a block node whose content is `v[a..b]`.
    fn inlines_of(&mut self, n: N, v: &View, a: usize, b: usize) -> Vec<Token> {
        let sub = v.sub(a, b);
        let kids: Vec<N> = n.children().collect();
        self.inline_seq(&kids, &sub, 0, sub.s.len(), &[])
    }

    /// Inline tokens for the nodes of a table row that fall inside one cell view.
    fn inlines_in(&mut self, row: N, cv: &View, in_table: bool) -> Vec<Token> {
        let saved = self.cell.take();
        if in_table {
            self.cell = cv.offs.first().map(|&f| (f, cv.offs.clone()));
        }
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
        let out = self.inline_seq(&kids, cv, 0, cv.s.len(), if in_table { b"|" } else { &[] });
        self.cell = saved;
        out
    }

    /// A doc offset comrak reported inside a table cell, mapped back to the source.
    fn uncell(&self, d: usize) -> usize {
        let Some((base, offs)) = &self.cell else {
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
    fn pad_fix(&self, l: usize, d: usize) -> usize {
        match self.tab_pad.borrow().get(&l) {
            Some(&(tab, pad)) if d > tab => d.saturating_sub(pad).max(tab + 1),
            _ => d,
        }
    }

    /// The doc byte range `[start, end)` of a node.
    fn node_range(&self, n: N) -> (usize, usize) {
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

    fn text_token(&self, s: &str) -> Token {
        Token::Text {
            raw: s.to_string(),
            text: if self.in_raw {
                s.to_string()
            } else {
                escape_no_encode(s)
            },
            tokens: None,
        }
    }

    fn push_text(&self, out: &mut Vec<Token>, s: &str) {
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
            text.push_str(&if self.in_raw {
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
    fn inline_seq(&mut self, kids: &[N], v: &View, a: usize, b: usize, skip: &[u8]) -> Vec<Token> {
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
                && wiki.is_none_or(|(ws, _)| cs < ws)
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
            if let Some((ws, we)) = wiki {
                self.push_gap(&mut out, &v.s, pos, ws, &mut depth);
                let raw = v.s[ws..we].to_string();
                out.push(self.wiki_token(&raw));
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
    fn push_gap(&self, out: &mut Vec<Token>, t: &str, a: usize, b: usize, depth: &mut usize) {
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
                b':' if *depth > 0 && !self.in_link => gfm_url(t, pos, i, b),
                b'w' if *depth > 0 && !self.in_link => gfm_www(t, i, b),
                b'@' if run_brackets <= 0 && !self.in_link => gfm_email(t, pos.max(run), i, b)
                    .filter(|&(_, e)| !bytes[e - 1].is_ascii_alphabetic()),
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

    fn wiki_token(&mut self, raw: &str) -> Token {
        let w = parse_wikilink(raw).unwrap_or(Wiki {
            slug: String::new(),
            fragment: None,
            alias: None,
            embed: false,
        });
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

    fn inline_node(
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
                if !self.in_link && lower.starts_with("<a ") {
                    self.in_link = true;
                } else if self.in_link && lower.starts_with("</a>") {
                    self.in_link = false;
                }
                let raw_tag = |p: &str| {
                    ["pre", "code", "kbd", "script"].iter().any(|t| {
                        lower
                            .strip_prefix(p)
                            .and_then(|r| r.strip_prefix(t))
                            .is_some_and(|r| r.starts_with(|c: char| c == '>' || c.is_whitespace()))
                    })
                };
                if !self.in_raw && raw_tag("<") {
                    self.in_raw = true;
                } else if self.in_raw && raw_tag("</") {
                    self.in_raw = false;
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
                    if self.in_link {
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
                self.in_link = true;
                let lv = unescape_view(&v.sub(s + 1, s + label_end), b"[]");
                let tokens = self.inline_seq(&kids, &lv, 0, lv.s.len(), b"[]");
                self.in_link = false;
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

/// A GFM extended autolink token (url, `www.` or email), as marked's `url` tokenizer builds it.
fn autolink_token(raw: &str) -> Token {
    let text = escape_no_encode(raw);
    let href = if raw.starts_with("www.") {
        format!("http://{raw}")
    } else if raw.contains('@')
        && !raw.contains("://")
        && !raw.starts_with("mailto:")
        && !raw.starts_with("xmpp:")
    {
        format!("mailto:{text}")
    } else {
        raw.to_string()
    };
    Token::Link {
        href,
        text: text.clone(),
        tokens: vec![Token::Text {
            raw: text.clone(),
            text,
            tokens: None,
        }],
    }
}

/// comrak's `ctype::isspace`.
fn c_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// comrak's `is_valid_hostchar` (not whitespace, punctuation or symbol). comrak asks
/// `finl_unicode`'s general categories; this crate does not depend on it, so outside ASCII
/// the punctuation/symbol blocks are listed instead (Latin-1, General Punctuation through
/// the symbol blocks, CJK and fullwidth punctuation). Where it could differ is only where a
/// domain ends, which decides nothing but the underscore check.
fn host_char(c: char) -> bool {
    if c.is_whitespace() {
        return false;
    }
    if c.is_ascii() {
        return !c.is_ascii_punctuation();
    }
    !matches!(c as u32, 0xA1..=0xBF | 0xD7 | 0xF7 | 0x2010..=0x2BFF | 0x3000..=0x303F
        | 0xFF01..=0xFF0F | 0xFF1A..=0xFF20 | 0xFF3B..=0xFF40 | 0xFF5B..=0xFF65)
}

/// comrak 0.56's `check_domain` over `scan_domain`.
fn gfm_domain(d: &str, allow_short: bool) -> Option<usize> {
    let (mut end, mut dots, mut us, mut prev_us) = (0, 0, 0, 0);
    for (i, c) in d.char_indices() {
        match c {
            '\\' if i + 1 < d.len() => {}
            '_' => us += 1,
            '.' => {
                prev_us = us;
                us = 0;
                dots += 1;
            }
            c if host_char(c) || c == '-' => {}
            _ => {
                end = i;
                break;
            }
        }
        end = i + c.len_utf8();
    }
    if dots > 10 {
        return Some(end);
    }
    if us > 0 || prev_us > 0 {
        return None;
    }
    (allow_short || dots > 0).then_some(end)
}

/// comrak 0.56's non-relaxed `autolink_delim`, less its U+2069 trim
/// (marked keeps that character; see `inline_seq`).
fn gfm_delim(d: &[u8], mut end: usize) -> usize {
    let (mut open, mut close) = (0, 0);
    for (i, &c) in d.iter().enumerate().take(end) {
        match c {
            b'<' => {
                end = i;
                break;
            }
            b'(' => open += 1,
            b')' => close += 1,
            _ => {}
        }
    }
    while end > 0 {
        let c = d[end - 1];
        if b"?!.,:*_~'\"".contains(&c) {
            end -= 1;
        } else if c == b';' {
            let mut n = end.saturating_sub(2);
            while n > 0 && d[n].is_ascii_alphabetic() {
                n -= 1;
            }
            if n + 2 < end && d[n] == b'&' {
                end = n;
            } else {
                end -= 1;
            }
        } else if c == b')' {
            if close <= open {
                break;
            }
            close -= 1;
            end -= 1;
        } else {
            break;
        }
    }
    end
}

/// comrak's `url_match` at the `:` at `i` of `t`, not rewinding before `lo` nor reading past
/// `hi`: the range of the link in `t`.
fn gfm_url(t: &str, lo: usize, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    if hi - i < 4 || b[i + 1] != b'/' || b[i + 2] != b'/' {
        return None;
    }
    let mut r = 0;
    while r < i - lo && b[i - r - 1].is_ascii_alphabetic() {
        r += 1;
    }
    let scheme = &t[i - r..i];
    if !["http", "https", "ftp"]
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
    {
        return None;
    }
    if !t[i + 3..hi].chars().next().is_some_and(host_char) {
        return None;
    }
    let mut end = gfm_domain(&t[i + 3..hi], true)? + 3;
    while i + end < hi && !c_space(b[i + end]) {
        end += 1;
    }
    let end = gfm_delim(&b[i..hi], end);
    Some((i - r, i + end))
}

/// comrak's `www_match` at `i` of `t`, not reading past `hi`.
fn gfm_www(t: &str, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    if i > 0 && !c_space(b[i - 1]) && !b"*_~([".contains(&b[i - 1]) {
        return None;
    }
    if !t[i..hi].starts_with("www.") {
        return None;
    }
    let mut end = gfm_domain(&t[i + 4..hi], false)? + 4;
    while i + end < hi && !c_space(b[i + end]) {
        end += 1;
    }
    let end = gfm_delim(&b[i..hi], end);
    (end > 0).then_some((i, i + end))
}

/// comrak's `email_match` at the `@` at `i` of `t` (no `mailto:`/`xmpp:` prefix), not
/// rewinding before `lo` nor reading past `hi`, with GFM's own last-character rule (not `-`
/// or `_`) in place of comrak's alphabetic-only one.
fn gfm_email(t: &str, lo: usize, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    let ok = |c: u8| c.is_ascii_alphanumeric() || b".+-_".contains(&c);
    let mut r = 0;
    while r < i - lo && ok(b[i - r - 1]) {
        r += 1;
    }
    if r == 0 || (i - r > 0 && b[i - r - 1] == b':') {
        return None;
    }
    let (mut end, mut np) = (1, 0);
    while end < hi - i {
        let c = b[i + end];
        if c == b'@' {
            return None;
        } else if c == b'.' && end + 1 < hi - i && b[i + end + 1].is_ascii_alphanumeric() {
            np += 1;
        } else if !c.is_ascii_alphanumeric() && c != b'-' && c != b'_' {
            break;
        }
        end += 1;
    }
    let last = b[i + end - 1];
    if end < 2 || np == 0 || !(last.is_ascii_alphanumeric() || last == b'.') {
        return None;
    }
    let end = gfm_delim(&b[i..hi], end);
    (end > 0).then_some((i - r, i + end))
}

enum Inline {
    One(Token),
    Text(String),
}

/// The first wiki-link match starting in `v[from..limit)` (it may run on to `end`), by
/// `TS_BASELINE` `src/wikilink.ts`'s `WIKI_LINK_TOKENIZER`.
fn find_wiki(s: &str, from: usize, limit: usize, end: usize) -> Option<(usize, usize)> {
    let b = s.as_bytes();
    let mut p = from;
    while p < limit {
        if (b[p] == b'!' || b[p] == b'[')
            && let Some(len) = wiki_match(&s[p..end])
        {
            return Some((p, p + len));
        }
        p += 1;
    }
    None
}

/// `^(!)?\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]+))?\]\]` — the match length.
fn wiki_match(s: &str) -> Option<usize> {
    let mut i = usize::from(s.starts_with('!'));
    let r = s[i..].strip_prefix("[[")?;
    i += 2;
    let slug = r
        .find(|c| [']', '|', '#', '\n'].contains(&c))
        .unwrap_or(r.len());
    if slug == 0 {
        return None;
    }
    let mut j = slug;
    if r[j..].starts_with('#') {
        j += 1;
        j += r[j..]
            .find(|c| [']', '|', '\n'].contains(&c))
            .unwrap_or(r.len() - j);
    }
    if r[j..].starts_with('|') {
        let k = r[j + 1..]
            .find(|c| [']', '\n'].contains(&c))
            .unwrap_or(r.len() - j - 1);
        if k == 0 {
            return None;
        }
        j += 1 + k;
    }
    r[j..].starts_with("]]").then_some(i + j + 2)
}

/// Lex a standalone inline string (a wiki-link label) the way `inlineTokens` would.
fn lex_inline_string(s: &str, outer: &Lexer) -> Vec<Token> {
    let arena = Arena::new();
    let root = parse_document(&arena, s, &options());
    let mut line_starts = vec![0];
    for (i, b) in s.bytes().enumerate() {
        if b == b'\n' {
            line_starts.push(i + 1);
        }
    }
    let mut lx = Lexer {
        src: s,
        line_starts,
        subs: HashMap::new(),
        tier: outer.tier,
        in_link: outer.in_link,
        in_raw: outer.in_raw,
        top: true,
        first_at: None,
        clip: usize::MAX,
        cend: usize::MAX,
        cell: None,
        tab_pad: RefCell::new(HashMap::new()),
    };
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

struct Wiki {
    slug: String,
    fragment: Option<String>,
    alias: Option<String>,
    embed: bool,
}

/// `TS_BASELINE` `src/wikilink.ts`'s `WIKI_LINK_TOKENIZER` over a whole raw match.
fn parse_wikilink(raw: &str) -> Option<Wiki> {
    let (embed, rest) = match raw.strip_prefix('!') {
        Some(r) => (true, r),
        None => (false, raw),
    };
    let inner = rest.strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.contains(']') || inner.contains('\n') {
        return None;
    }
    let (head, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], Some(inner[i + 1..].to_string())),
        None => (inner, None),
    };
    if alias.as_deref() == Some("") {
        return None;
    }
    let (slug, fragment) = match head.find('#') {
        Some(i) => (&head[..i], Some(head[i + 1..].to_string())),
        None => (head, None),
    };
    if slug.is_empty() {
        return None;
    }
    Some(Wiki {
        slug: slug.to_string(),
        fragment,
        alias,
        embed,
    })
}

/// `^(\s*[-*+]\s+)\[(.)\](\s)` over one line: the byte offset of `[` and the state char.
fn task_state_line(line: &str) -> Option<(usize, char)> {
    let mut it = line.char_indices().peekable();
    while let Some(&(_, c)) = it.peek() {
        if js_space(c) {
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
        if js_space(c) {
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
    js_space(ws).then_some((bs, ch))
}

/// Where a last item's content ends: marked's `trimEnd`, over ASCII whitespace only. A
/// non-ASCII JS-whitespace character (U+00A0, U+3000, …) is content to CommonMark (§2.1
/// counts only spaces and tabs as blank, and §4.8 strips only those from a paragraph), and
/// comrak keeps it in the item's paragraph; trimming it as marked does would drop it from
/// the token stream entirely, since marked re-lexes what it trimmed and Rust does not.
fn content_end(s: &str) -> usize {
    s.trim_end_matches(|c: char| c.is_ascii() && js_space(c))
        .len()
}

/// `/\n[ \t]*\n[ \t]*$/`.
fn raw_ends_blank(raw: &str) -> bool {
    let t = raw.trim_end_matches([' ', '\t']);
    let Some(t) = t.strip_suffix('\n') else {
        return false;
    };
    t.trim_end_matches([' ', '\t']).ends_with('\n')
}

/// `^(?: {1,4}| {0,3}\t)` removed.
fn strip_code_indent(s: &str) -> &str {
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
fn indent_compensation(lead: &str, line: &str, text: &str) -> String {
    if lead.is_empty() || !line[lead.len()..].starts_with("```") {
        return text.to_string();
    }
    let n = lead.chars().count();
    text.split('\n')
        .map(|node| {
            let ws: usize = node.chars().take_while(|c| js_space(*c)).count();
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
fn atx_text(line: &str) -> (usize, usize) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && b[i] == b' ' {
        i += 1;
    }
    while i < b.len() && b[i] == b'#' {
        i += 1;
    }
    let content = &line[i..];
    let lead = content.len() - content.trim_start_matches(js_space).len();
    let mut a = i + lead;
    let mut e = i + content.trim_end_matches(js_space).len();
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
            let off = trimmed.len() - trimmed.trim_start_matches(js_space).len();
            a += off;
            e = a + t2.len();
        }
    }
    (a, e)
}

/// An inline link's `(href, title)`.
type LinkDest = (String, Option<String>);

/// The end of a link label (index of its `]`) and, for an inline link, its destination.
fn parse_link(raw: &str) -> Option<(usize, Option<LinkDest>)> {
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
    let inner = rest[1..rest.len() - 1].trim_start_matches(js_space);
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
fn codespan_token(raw: &str) -> Option<Token> {
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
fn find_gap_code_span(v: &str, from: usize, limit: usize) -> Option<(usize, usize)> {
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
fn code_span_end(v: &str, s: usize, b: usize) -> Option<usize> {
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

/// `\X` → `X` for every `X` in `chars`, keeping document offsets.
fn unescape_view(v: &View, chars: &[u8]) -> View {
    let mut nv = View::default();
    let sb = v.s.as_bytes();
    let mut k = 0;
    while k < sb.len() {
        if sb[k] == b'\\' && sb.get(k + 1).is_some_and(|c| chars.contains(c)) {
            k += 1;
            continue;
        }
        let ch = v.s[k..].chars().next().map_or(1, char::len_utf8);
        nv.s.push_str(&v.s[k..k + ch]);
        nv.offs.extend_from_slice(&v.offs[k..k + ch]);
        k += ch;
    }
    nv
}

/// marked's `splitCells` over a row view, keeping document offsets.
fn split_cells(v: &View, count: Option<usize>) -> Vec<View> {
    let b = v.s.as_bytes();
    let mut cells: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    for i in 0..b.len() {
        if b[i] == b'|' {
            let mut back = 0;
            while back < i && b[i - 1 - back] == b'\\' {
                back += 1;
            }
            if back % 2 == 0 {
                cells.push((start, i));
                start = i + 1;
            }
        }
    }
    cells.push((start, b.len()));
    let blank = |c: &(usize, usize)| v.s[c.0..c.1].trim().is_empty();
    if cells.first().is_some_and(blank) {
        cells.remove(0);
    }
    if cells.last().is_some_and(blank) {
        cells.pop();
    }
    let mut out: Vec<View> = cells
        .into_iter()
        .map(|(a, e)| {
            let cell = &v.s[a..e];
            let lead = cell.len() - cell.trim_start_matches(js_space).len();
            let t = js_trim(cell).len();
            let sub = v.sub(a + lead, a + lead + t);
            unescape_view(&sub, b"|")
        })
        .collect();
    if let Some(n) = count {
        out.truncate(n);
        while out.len() < n {
            out.push(View::default());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(raw: &str) -> Token {
        Token::Text {
            raw: raw.into(),
            text: escape_no_encode(raw),
            tokens: None,
        }
    }

    #[test]
    fn normalizes_line_endings_and_sentinels() {
        assert_eq!(normalize("a\r\nb\rc\u{0}d\u{1}e"), "a\nb\ncde");
    }

    #[test]
    fn escape_keeps_entities() {
        assert_eq!(
            escape_no_encode("a & b &amp; <c> \"q\" it's"),
            "a &amp; b &amp; &lt;c&gt; &quot;q&quot; it&#39;s"
        );
        assert_eq!(escape_encode("&amp;"), "&amp;amp;");
    }

    #[test]
    fn paragraph_keeps_marked_text_and_breaks() {
        let t = lex("a & b\n   cont  \nx", Tier::Unicode);
        assert_eq!(
            t,
            vec![Token::Paragraph {
                tokens: vec![text("a & b\n   cont"), Token::Br, text("x")]
            }]
        );
    }

    #[test]
    fn leading_bom_stays_paragraph_content_as_in_marked() {
        // D-D: marked sees the BOM as text, so a following html line is inline html.
        let t = lex("\u{feff}<img src=\"x\"/>\n\nText.\n", Tier::Unicode);
        assert_eq!(
            t,
            vec![
                Token::Paragraph {
                    tokens: vec![
                        text("\u{feff}"),
                        Token::Html {
                            text: "<img src=\"x\"/>".into()
                        }
                    ]
                },
                Token::Space,
                Token::Paragraph {
                    tokens: vec![text("Text.")]
                },
            ]
        );
        let h = lex("\u{feff}# T\n", Tier::Unicode);
        assert!(matches!(&h[0], Token::Paragraph { .. }), "{h:?}");
    }

    #[test]
    fn html_trailer_stops_at_its_container() {
        let html = |t: &[Token]| -> Vec<String> {
            fn walk(t: &[Token], out: &mut Vec<String>) {
                for x in t {
                    match x {
                        Token::Html { text } => out.push(text.clone()),
                        Token::Blockquote { tokens } => walk(tokens, out),
                        Token::List { items, .. } => {
                            for i in items {
                                walk(&i.tokens, out);
                            }
                        }
                        _ => {}
                    }
                }
            }
            let mut out = Vec::new();
            walk(t, &mut out);
            out
        };
        let t = lex("- a\n\n  </details>\n\n- b\n", Tier::Unicode);
        assert_eq!(html(&t), vec!["</details>\n"]);
        let t = lex("> a\n>\n> </details>\n\nz\n", Tier::Unicode);
        assert_eq!(html(&t), vec!["</details>"]);
        let t = lex("- a\n\n  </details>\n\n\n- b\n", Tier::Unicode);
        assert_eq!(html(&t), vec!["</details>\n\n"]);
    }

    #[test]
    fn code_span_past_comraks_backtick_cache_is_recognised() {
        let t = lex("x `` y `a` z `b`.\n", Tier::Unicode);
        let Token::Paragraph { tokens } = &t[0] else {
            panic!("{t:?}")
        };
        let spans = tokens
            .iter()
            .filter(|x| matches!(x, Token::Codespan { .. }))
            .count();
        assert_eq!(spans, 2, "{tokens:?}");
        let t = lex("x \\`a` b\n", Tier::Unicode);
        let Token::Paragraph { tokens } = &t[0] else {
            panic!("{t:?}")
        };
        assert!(!tokens.iter().any(|x| matches!(x, Token::Codespan { .. })));
    }

    #[test]
    fn indented_blank_after_quote_in_item_is_the_quotes_space() {
        let t = lex("- a\n\n  > q\n    \n- b\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!("{t:?}")
        };
        let Some(Token::Blockquote { tokens }) = items[0].tokens.last() else {
            panic!("{:?}", items[0].tokens)
        };
        assert_eq!(tokens.last(), Some(&Token::Space));
        let t = lex("- a\n\n  > q\n  \n- b\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!("{t:?}")
        };
        let Some(Token::Blockquote { tokens }) = items[0].tokens.last() else {
            panic!("{:?}", items[0].tokens)
        };
        assert_ne!(
            tokens.last(),
            Some(&Token::Space),
            "a dedented-empty line is no space"
        );
    }

    #[test]
    fn crlf_body_lexes_like_lf() {
        assert_eq!(
            lex("a\r\nb\r\n", Tier::Unicode),
            lex("a\nb\n", Tier::Unicode)
        );
    }

    #[test]
    fn space_tokens_follow_marked_consumption() {
        let t = lex("a\n\nb\n", Tier::Unicode);
        assert_eq!(t.len(), 3);
        assert_eq!(t[1], Token::Space);
        let t = lex("# h\n\nb", Tier::Unicode);
        assert_eq!(t.len(), 2, "a heading consumes its newlines");
        let t = lex("a\n\n", Tier::Unicode);
        assert_eq!(t.last(), Some(&Token::Space));
    }

    #[test]
    fn list_item_raw_is_rebuilt_from_source() {
        let t = lex("- a\n  b\n- c\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!("{t:?}")
        };
        assert_eq!(items[0].raw, "- a\n  b\n");
        assert_eq!(items[1].raw, "- c");
        let Token::Text { raw, text, .. } = &items[0].tokens[0] else {
            panic!()
        };
        assert_eq!(raw, "a\n\nb");
        assert_eq!(text, "a\nb");
    }

    #[test]
    fn loose_list_from_blank_line_between_items() {
        let t = lex("- a\n\n- b\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!()
        };
        assert!(items.iter().all(|i| i.loose));
    }

    #[test]
    fn unicode_task_item_carries_the_glyph() {
        let t = lex("- [x] done\n- [/] half\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!()
        };
        assert!(!items[0].task);
        assert_eq!(items[0].raw, "- ✓ done\n");
        let Token::Text { text, .. } = &items[1].tokens[0] else {
            panic!()
        };
        assert_eq!(text, "◐ half");
    }

    #[test]
    fn ascii_task_item_keeps_the_sentinel_literal() {
        let t = lex("- [ ] todo\n- [/] half\n", Tier::Ascii);
        let Token::List { items, .. } = &t[0] else {
            panic!()
        };
        let Token::Text { text, .. } = &items[0].tokens[0] else {
            panic!()
        };
        assert_eq!(text, "[\u{1} ] todo");
        let Token::Text { text, .. } = &items[1].tokens[0] else {
            panic!()
        };
        assert_eq!(text, "[/] half");
        assert!(!items[1].task);
    }

    #[test]
    fn ascii_sentinel_at_nested_list_end_leaves_no_space() {
        // `[\u{1} ]` is one byte longer than `[ ]`; a nested list ending on it (with a trailing
        // space) must end after the substitution, or the residual ` ] ` reads as a `space`.
        let t = lex("- a:\n  - b\n  - [ ] \n- c\n", Tier::Ascii);
        let Token::List { items, .. } = &t[0] else {
            panic!()
        };
        assert!(matches!(
            items[0].tokens.as_slice(),
            [Token::Text { .. }, Token::List { .. }]
        ));
    }

    #[test]
    fn ordered_and_quoted_task_items_are_real_tasks() {
        let t = lex("1. [x] a\n", Tier::Unicode);
        let Token::List { items, .. } = &t[0] else {
            panic!()
        };
        assert!(items[0].task);
        assert_eq!(items[0].checked, Some(true));
        let t = lex("> - [/] b\n", Tier::Unicode);
        let Token::Blockquote { tokens } = &t[0] else {
            panic!()
        };
        let Token::List { items, .. } = &tokens[0] else {
            panic!()
        };
        assert!(items[0].task);
    }

    #[test]
    fn task_line_inside_fence_is_verbatim() {
        let t = lex("```\n- [ ] x\n```\n", Tier::Unicode);
        assert_eq!(
            t[0],
            Token::Code {
                lang: Some(String::new()),
                text: "- [ ] x".into()
            }
        );
    }

    #[test]
    fn wikilink_embed_fragment_alias() {
        let t = lex("see ![[note#sec|An *alias*]] end", Tier::Unicode);
        let Token::Paragraph { tokens } = &t[0] else {
            panic!()
        };
        assert_eq!(tokens[0], text("see "));
        let Token::Wikilink {
            slug,
            fragment,
            embed,
            alias,
            tokens: label,
        } = &tokens[1]
        else {
            panic!("{tokens:?}")
        };
        assert_eq!(slug, "note");
        assert_eq!(fragment.as_deref(), Some("sec"));
        assert!(*embed);
        assert_eq!(alias.as_deref(), Some("An *alias*"));
        assert!(matches!(label[1], Token::Em { .. }));
    }

    #[test]
    fn wikilink_label_defaults_to_slug() {
        let t = lex("[[a b]]", Tier::Unicode);
        let Token::Paragraph { tokens } = &t[0] else {
            panic!()
        };
        let Token::Wikilink {
            tokens: label,
            alias,
            ..
        } = &tokens[0]
        else {
            panic!()
        };
        assert_eq!(alias, &None);
        assert_eq!(label, &vec![text("a b")]);
    }

    #[test]
    fn inline_forms() {
        let t = lex(
            "*e* **s** `c&d` [l](h) ![i](s \"t\") ~~d~~ \\* <b>",
            Tier::Unicode,
        );
        let Token::Paragraph { tokens } = &t[0] else {
            panic!()
        };
        let kinds: Vec<&str> = tokens
            .iter()
            .map(|t| match t {
                Token::Em { .. } => "em",
                Token::Strong { .. } => "strong",
                Token::Codespan { .. } => "codespan",
                Token::Link { .. } => "link",
                Token::Image { .. } => "image",
                Token::Del { .. } => "del",
                Token::Escape { .. } => "escape",
                Token::Html { .. } => "html",
                Token::Text { .. } => "text",
                _ => "other",
            })
            .filter(|k| *k != "text")
            .collect();
        assert_eq!(
            kinds,
            [
                "em", "strong", "codespan", "link", "image", "del", "escape", "html"
            ]
        );
        assert!(tokens.contains(&Token::Codespan {
            text: "c&amp;d".into()
        }));
        assert!(tokens.contains(&Token::Image {
            href: "s".into(),
            title: Some("t".into()),
            text: "i".into()
        }));
    }

    #[test]
    fn table_cells_split_like_marked() {
        let t = lex("| a | b \\| c |\n|---|:-:|\n| 1 |\n", Tier::Unicode);
        let Token::Table {
            header,
            rows,
            align,
        } = &t[0]
        else {
            panic!("{t:?}")
        };
        assert_eq!(header[1].text, "b | c");
        assert_eq!(align, &vec![None, Some("center".to_string())]);
        assert_eq!(rows[0][1].text, "");
    }

    #[test]
    fn table_cell_spans_after_an_escaped_pipe_keep_their_place() {
        let t = lex("| h |\n|---|\n| `a \\| b` then `c` |\n", Tier::Unicode);
        let Token::Table { rows, .. } = &t[0] else {
            panic!("{t:?}")
        };
        let kinds: Vec<String> = rows[0][0]
            .tokens
            .iter()
            .map(|k| match k {
                Token::Codespan { text } => format!("code:{text}"),
                Token::Text { raw, .. } => format!("text:{raw}"),
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(kinds, ["code:a | b", "text: then ", "code:c"]);
    }

    #[test]
    fn references_resolve_past_comraks_expansion_cap() {
        // Far more resolved-reference bytes than the input is long: comrak alone stops
        // resolving once the cap is spent; marked resolves every one.
        let url = format!("https://example.test/{}", "x".repeat(200));
        let body = format!("{}\n\n[r]: {url}\n", "[a][r] ".repeat(40));
        let t = lex(&body, Tier::Unicode);
        let Token::Paragraph { tokens } = &t[0] else {
            panic!("{t:?}")
        };
        let links = tokens
            .iter()
            .filter(|k| matches!(k, Token::Link { href, .. } if *href == url))
            .count();
        assert_eq!(links, 40);
    }

    #[test]
    fn final_hr_leaves_its_blank_lines_to_a_space() {
        let t = lex("a\n\n---\n\n", Tier::Unicode);
        assert!(
            matches!(t.as_slice(), [_, Token::Space, Token::Hr, Token::Space]),
            "{t:?}"
        );
    }

    #[test]
    fn task_state_line_matches_the_prepass_regex() {
        assert_eq!(task_state_line("  - [x] a"), Some((4, 'x')));
        assert_eq!(task_state_line("- [x]a"), None);
        assert_eq!(task_state_line("1. [x] a"), None);
        assert_eq!(task_state_line("> - [x] a"), None);
    }

    #[test]
    fn heading_trailing_hashes() {
        assert_eq!(atx_text("# a #"), (2, 3));
        assert_eq!(atx_text("# a#"), (2, 4));
    }

    fn json(body: &str) -> String {
        serde_json::to_string(&lex(body, Tier::Unicode)).unwrap()
    }

    #[test]
    fn autolink_keeps_a_trailing_pop_directional_isolate_like_marked() {
        let j = json("see \u{2068}https://a.io/x\u{2069}\nnext\n");
        assert!(j.contains("\"href\":\"https://a.io/x\u{2069}\""), "{j}");
        assert!(j.contains("\"raw\":\"\\nnext\""), "{j}");
    }

    #[test]
    fn tab_after_an_item_marker_is_three_spaces_like_marked() {
        let j = json("1.\t**b**: c\n");
        assert!(j.contains("\"raw\":\"   **b**: c\""), "{j}");
        // A tab after a space keeps its place (marked's `^\t+` does not match).
        let j = json("- \tx\n");
        assert!(!j.contains("\"   x"), "{j}");
    }

    #[test]
    fn escaped_bracket_in_emphasis_inside_a_link_label_is_unescaped() {
        let j = json("[**x\\[y\\]**](https://a.io/)\n");
        assert!(j.contains("\"text\":\"x[y]\""), "{j}");
        assert!(!j.contains("\"escape\""), "{j}");
    }

    #[test]
    fn url_autolink_inside_an_open_bracket_is_linked_like_marked() {
        let j = json("See: [https://a.io/x]\n");
        assert!(j.contains("\"href\":\"https://a.io/x]\""), "{j}");
        assert!(j.contains("\"raw\":\"See: [\""), "{j}");
        let j = json("Go [www.a.io/x]\n");
        assert!(j.contains("\"href\":\"http://www.a.io/x]\""), "{j}");
        // Outside a bracket nothing changes: comrak's own autolink stands.
        let j = json("See: https://a.io/x.\n");
        assert!(j.contains("\"href\":\"https://a.io/x\""), "{j}");
        // An underscored host stays text (GFM §6.9), bracket or not.
        let j = json("See [https://a_b/c]\n");
        assert!(!j.contains("\"link\""), "{j}");
    }

    #[test]
    fn email_autolink_ending_in_a_digit_is_linked_like_marked() {
        let j = json("pkg: name@1.2.3's notes\n");
        assert!(j.contains("\"href\":\"mailto:name@1.2.3\""), "{j}");
        assert!(j.contains("\"raw\":\"'s notes\""), "{j}");
        // A trailing `-`/`_` still is not part of an address.
        let j = json("a@b.c_ d\n");
        assert!(!j.contains("\"link\""), "{j}");
    }

    #[test]
    fn lazy_quote_line_after_a_partly_consumed_tab_keeps_its_offsets() {
        let j = json("- > a\n\tb [x](https://a.io/p/)\n");
        assert!(j.contains("\"raw\":\"a\\n  b \""), "{j}");
        assert!(
            j.contains("\"href\":\"https://a.io/p/\",\"text\":\"x\""),
            "{j}"
        );
        assert!(!j.contains("\"raw\":\")\""), "{j}");
        let j = json("1. > a\n\t https://a.io/p  \n\tb\n");
        assert!(j.contains("\"href\":\"https://a.io/p\""), "{j}");
    }

    #[test]
    fn leading_definition_consumes_its_newlines_like_marked() {
        assert!(!json("[a]: /u \"t\"\n<p>\n").starts_with("[{\"type\":\"space\""));
        assert!(!json("[a]: /u\n\n\nx\n").starts_with("[{\"type\":\"space\""));
    }

    #[test]
    fn definition_on_an_unterminated_last_line_is_a_definition() {
        let j = json("p\n\n[a]: <https://a.io/b+c=>");
        assert!(!j.contains("\"link\""), "{j}");
    }

    #[test]
    fn nbsp_line_after_a_nested_item_is_kept_as_content() {
        let j = json("- a.\n\n  - b.\n\u{a0}\n\nc\n");
        assert!(j.contains("\"text\":\"b.\\n\u{a0}\""), "{j}");
        let j = json("- a.\n\n  - b.\n\u{a0}\n");
        assert!(j.contains("\"text\":\"b.\\n\u{a0}\""), "{j}");
        // A trailing U+00A0 on the last item's last line stays in its text (comrak's reading).
        let j = json("- a.\u{a0}\n   \n    - b.\u{a0}\n       \n- d\n");
        assert!(j.contains("\"text\":\"b.\u{a0}\""), "{j}");
        assert!(json("- a\u{a0}\n").contains("\"text\":\"a\u{a0}\""));
    }

    #[test]
    fn lazy_image_line_after_an_indented_continuation_is_an_image() {
        let j = json("- a\n\t\t- b\n![](p.png)\n\nc\n");
        assert!(j.contains("\"type\":\"image\""), "{j}");
        let j = json("- a\n      - b\n[x](p.png)\n");
        assert!(j.contains("\"href\":\"p.png\""), "{j}");
    }
}
