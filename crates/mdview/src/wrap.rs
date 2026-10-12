//! ANSI-safe prose wrapping, ported from `src/wrap.ts`.
//!
//! Both split paths consume `ansi::scan`'s span sequence; a word is carried as its spans
//! (never re-flattened and re-scanned), widths are measured on visible text only, and an
//! escape-only run is *carried* to the next visible piece rather than placed as a word.
//! "Whitespace" is ECMAScript `\s` (`text::is_js_whitespace`).

use crate::ansi::{Span, SpanKind, scan};
use crate::text::{is_js_whitespace, split_token};
use crate::width::{Measure, NARROW_MEASURE};

pub use crate::text::graphemes;

#[derive(Default)]
struct Word<'a> {
    spans: Vec<Span<'a>>,
    visible: String,
}

enum Entry<'a> {
    Word(Word<'a>),
    Space,
}

struct Chunk {
    raw: String,
    visible: String,
}

fn raw(word: &Word<'_>) -> String {
    word.spans.iter().map(|s| s.raw).collect()
}

/// `piece.split(/(\s+)/)`: alternating runs of non-whitespace and whitespace.
fn whitespace_runs(text: &str) -> Vec<(bool, &str)> {
    let mut runs = Vec::new();
    let mut start = 0;
    let mut current: Option<bool> = None;
    for (index, c) in text.char_indices() {
        let ws = is_js_whitespace(c);
        if current.is_some_and(|w| w != ws) {
            runs.push((current.unwrap_or(false), &text[start..index]));
            start = index;
        }
        current = Some(ws);
    }
    if let Some(ws) = current {
        runs.push((ws, &text[start..]));
    }
    runs
}

fn tokenize<'a>(spans: &[Span<'a>]) -> Vec<Entry<'a>> {
    let mut entries = Vec::new();
    let mut current = Word::default();
    for span in spans {
        if span.kind != SpanKind::Text {
            current.spans.push(*span);
            continue;
        }
        for (ws, piece) in whitespace_runs(span.raw) {
            if ws {
                if !current.spans.is_empty() {
                    entries.push(Entry::Word(std::mem::take(&mut current)));
                }
                entries.push(Entry::Space);
            } else {
                current.spans.push(Span {
                    kind: SpanKind::Text,
                    raw: piece,
                    width: 0,
                });
                current.visible.push_str(piece);
            }
        }
    }
    if !current.spans.is_empty() {
        entries.push(Entry::Word(current));
    }
    entries
}

fn split_styled_word(word: &Word<'_>, limit: usize, measure: Measure) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut current_visible = String::new();
    let mut current_width = 0;
    let push_chunk =
        |chunks: &mut Vec<Chunk>, current: &mut String, visible: &mut String, width: &mut usize| {
            if !current.is_empty() {
                chunks.push(Chunk {
                    raw: std::mem::take(current),
                    visible: std::mem::take(visible),
                });
            }
            current.clear();
            visible.clear();
            *width = 0;
        };
    for span in &word.spans {
        if span.kind != SpanKind::Text {
            current.push_str(span.raw);
            continue;
        }
        for (index, piece) in split_token(span.raw, limit, measure)
            .into_iter()
            .enumerate()
        {
            let piece_width = measure.width(&piece);
            if index == 0 && current_width > 0 && current_width + piece_width <= limit {
                current.push_str(&piece);
                current_visible.push_str(&piece);
                current_width += piece_width;
                continue;
            }
            push_chunk(
                &mut chunks,
                &mut current,
                &mut current_visible,
                &mut current_width,
            );
            current_visible.push_str(&piece);
            current = piece;
            current_width = piece_width;
        }
    }
    push_chunk(
        &mut chunks,
        &mut current,
        &mut current_visible,
        &mut current_width,
    );
    if chunks.is_empty() {
        chunks.push(Chunk {
            raw: String::new(),
            visible: String::new(),
        });
    }
    chunks
}

struct Filler {
    limit: usize,
    lines: Vec<String>,
    current: String,
    current_width: usize,
    pending_space: bool,
    carried: String,
}

impl Filler {
    fn flush_line(&mut self) {
        self.lines.push(std::mem::take(&mut self.current));
        self.current_width = 0;
        self.pending_space = false;
    }

    fn place(&mut self, piece: &str, piece_width: usize, visible: bool) {
        if !visible {
            self.carried.push_str(piece);
            return;
        }
        let pad = usize::from(self.pending_space && self.current_width > 0);
        let needed = piece_width + pad;
        if self.current_width > 0 && self.current_width + needed > self.limit {
            self.flush_line();
            self.current = std::mem::take(&mut self.carried) + piece;
            self.current_width = piece_width;
        } else {
            if pad == 1 {
                self.current.push(' ');
                self.current_width += 1;
            }
            self.current.push_str(&std::mem::take(&mut self.carried));
            self.current.push_str(piece);
            self.current_width += piece_width;
        }
        self.carried.clear();
        self.pending_space = false;
    }
}

/// Wrap terminal-styled text to `width` display columns without splitting a sequence.
pub fn wrap_ansi(text: &str, width: usize, measure: Measure) -> Vec<String> {
    let limit = width.max(1);
    let scanned = scan(text, NARROW_MEASURE);
    let entries = tokenize(&scanned.spans);
    if entries.is_empty() {
        return vec![String::new()];
    }
    let mut f = Filler {
        limit,
        lines: Vec::new(),
        current: String::new(),
        current_width: 0,
        pending_space: false,
        carried: String::new(),
    };
    for entry in &entries {
        let word = match entry {
            Entry::Space => {
                if f.current_width > 0 {
                    f.pending_space = true;
                }
                continue;
            }
            Entry::Word(word) => word,
        };
        let word_width = measure.width(&word.visible);
        if word_width <= limit {
            f.place(&raw(word), word_width, !word.visible.is_empty());
            continue;
        }
        for chunk in split_styled_word(word, limit, measure) {
            f.place(
                &chunk.raw,
                measure.width(&chunk.visible),
                !chunk.visible.is_empty(),
            );
        }
    }
    if !f.carried.is_empty() {
        let carried = std::mem::take(&mut f.carried);
        f.current.push_str(&carried);
    }
    f.lines.push(f.current);
    f.lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ansi::{link, strip_sequences};
    use crate::width::WIDE_MEASURE;

    const E: &str = "\u{1b}";

    fn w(text: &str, width: usize) -> Vec<String> {
        wrap_ansi(text, width, NARROW_MEASURE)
    }

    #[test]
    fn greedy_fill_on_whitespace() {
        assert_eq!(w("the quick brown fox", 9), vec!["the quick", "brown fox"]);
        assert_eq!(w("", 10), vec![""]);
        assert_eq!(w("   ", 10), vec![""]);
        assert_eq!(w("a  b\tc", 10), vec!["a b c"]);
    }

    #[test]
    fn over_budget_words_are_hard_split_losslessly() {
        assert_eq!(w("abcdefghij", 4), vec!["abcd", "efgh", "ij"]);
        assert_eq!(w("x abcdefghij", 4), vec!["x", "abcd", "efgh", "ij"]);
        assert_eq!(w("漢字漢字漢", 4), vec!["漢字", "漢字", "漢"]);
    }

    #[test]
    fn sgr_is_never_split_and_never_measured() {
        let t = format!("{E}[36mabcdefgh{E}[39m ij");
        let lines = w(&t, 4);
        assert_eq!(
            lines,
            vec![
                format!("{E}[36mabcd"),
                format!("efgh{E}[39m"),
                "ij".to_owned()
            ]
        );
    }

    #[test]
    fn a_hyperlink_label_crossing_the_budget_keeps_both_sequences_whole() {
        let t = link("abcdefghijklmnopqrstuvwxyz", "https://x", false);
        let lines = w(&t, 10);
        assert_eq!(lines.concat(), t);
        assert!(lines[0].starts_with(&format!("{E}]8;;https://x\u{7}abcdefghij")));
        assert_eq!(strip_sequences(&lines[0]), "abcdefghij");
    }

    #[test]
    fn an_escape_only_word_is_carried_not_placed() {
        let t = format!("recorded at {E}[39m");
        assert_eq!(w(&t, 80), vec![format!("recorded at{E}[39m")]);
        let t = format!("aaaa {E}[1m bbbb");
        assert_eq!(w(&t, 4), vec!["aaaa".to_owned(), format!("{E}[1mbbbb")]);
    }

    #[test]
    fn js_whitespace_rules_apply() {
        assert_eq!(w("a\u{FEFF}b", 10), vec!["a b"]);
        assert_eq!(w("a\u{85}b", 10), vec!["a\u{85}b"]);
    }

    #[test]
    fn the_measure_is_threaded() {
        assert_eq!(w("—— ——", 3), vec!["——", "——"]);
        assert_eq!(
            wrap_ansi("—— ——", 3, WIDE_MEASURE),
            vec!["—", "—", "—", "—"]
        );
    }
}
