//! The view: a container-stripped string with a document offset per byte.

use super::*;

#[derive(Debug, Clone, Default)]
pub(super) struct View {
    pub(super) s: String,
    pub(super) offs: Vec<usize>,
}

impl View {
    pub(super) fn push_doc(&mut self, src: &str, a: usize, b: usize) {
        for (i, ch) in src[a..b].char_indices() {
            for _ in 0..ch.len_utf8() {
                self.offs.push(a + i);
            }
            self.s.push(ch);
        }
    }
    pub(super) fn push_str_at(&mut self, text: &str, off: usize) {
        self.s.push_str(text);
        self.offs.extend(std::iter::repeat_n(off, text.len()));
    }
    /// The first view index whose document offset is `>= doc`.
    pub(super) fn idx(&self, doc: usize) -> usize {
        self.offs.partition_point(|&o| o < doc)
    }
    pub(super) fn sub(&self, a: usize, b: usize) -> View {
        View {
            s: self.s[a..b].to_string(),
            offs: self.offs[a..b].to_vec(),
        }
    }
}

/// `\X` → `X` for every `X` in `chars`, keeping document offsets.
pub(super) fn unescape_view(v: &View, chars: &[u8]) -> View {
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
pub(super) fn split_cells(v: &View, count: Option<usize>) -> Vec<View> {
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
            let lead = cell.len() - cell.trim_start_matches(is_js_whitespace).len();
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
