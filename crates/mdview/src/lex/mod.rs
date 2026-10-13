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

use crate::glyphs::Tier;
use crate::lists::task_glyph_char;
use crate::text::{is_js_whitespace, js_trim};
use crate::token::{ListItem, TableCell, Token};

mod autolink;
mod blocks;
mod inline;
mod refs;
#[cfg(test)]
mod tests;
mod view;

use autolink::*;
use blocks::*;
use refs::*;
use view::*;

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
    /// The pre-pass's fence phase at the start of each line (see [`Lexer::prepass`]).
    fence: Vec<bool>,
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
        fence: Vec::new(),
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
    (lx.subs, lx.fence) = lx.prepass();
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

    /// The retired `rewriteTaskState` pre-pass, as a per-line substitution table, and its
    /// fence phase at the start of each line (`fence[l]`, for `l` in `1..=nlines + 1`).
    fn prepass(&self) -> (HashMap<usize, Sub>, Vec<bool>) {
        let mut subs = HashMap::new();
        let mut fence = Vec::with_capacity(self.nlines() + 2);
        fence.push(false);
        let mut in_fence = false;
        for l in 1..=self.nlines() {
            fence.push(in_fence);
            let line = &self.src[self.line_start(l)..self.line_end(l)];
            let trimmed = line.trim_start_matches(is_js_whitespace);
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
                Tier::Unicode => task_glyph_char(ch).map(str::to_string),
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
        fence.push(in_fence);
        (subs, fence)
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
}
