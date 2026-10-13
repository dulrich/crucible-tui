//! Rendered-line primitives shared by render and the detectors, ported from
//! `TS_BASELINE` `src/list-lines.ts`: the marker regexes and `track_list_line`, plus the fence walk,
//! the hanging-indent wrap and the marker guard every list pass shares.
//!
//! Every TS `\s`/`\S` here is ECMAScript whitespace (`text::js_regex`), and `\d` is ASCII.

use std::sync::LazyLock;

use regex::Regex;

use crate::ansi::strip_sequences;
use crate::text::{js_regex as js, js_trim, js_trim_start};
use crate::width::Measure;
use crate::wrap::wrap_ansi;

/// One line of a fence-aware walk: the line, whether it started inside a fenced block, and
/// whether it carries a sentinel (opens or closes one). A pass that rewrites whole lines must
/// skip [`FenceLine::touches_fence`]; a pass that only rewrites a leading marker needs only
/// `started_inside` (`crates/mdview/AGENTS.md`, "Why a sentinel walk exists at all").
#[derive(Debug, Clone, Copy)]
pub struct FenceLine<'a> {
    pub line: &'a str,
    pub started_inside: bool,
    pub carries_sentinel: bool,
}

impl FenceLine<'_> {
    /// Started inside a fence, or opens/closes one on this line.
    pub fn touches_fence(&self) -> bool {
        self.started_inside || self.carries_sentinel
    }
}

/// The per-line sentinel walk every pass over rendered output shares: each sentinel occurrence
/// flips the inside-a-fence state.
#[derive(Debug, Clone, Copy)]
pub struct FenceWalk {
    sentinel: char,
    inside: bool,
}

impl FenceWalk {
    pub fn new(sentinel: char) -> Self {
        FenceWalk {
            sentinel,
            inside: false,
        }
    }

    /// Advance over one line.
    pub fn step<'a>(&mut self, line: &'a str) -> FenceLine<'a> {
        let started_inside = self.inside;
        let mut carries_sentinel = false;
        for ch in line.chars() {
            if ch == self.sentinel {
                self.inside = !self.inside;
                carries_sentinel = true;
            }
        }
        FenceLine {
            line,
            started_inside,
            carries_sentinel,
        }
    }
}

/// `text.split("\n").map(f).join("\n")`.
pub fn map_lines(text: &str, f: impl FnMut(&str) -> String) -> String {
    text.split('\n').map(f).collect::<Vec<_>>().join("\n")
}

/// [`map_lines`] under a [`FenceWalk`]: `f` sees each line with its fence state.
pub fn map_fenced_lines(
    text: &str,
    sentinel: char,
    mut f: impl FnMut(FenceLine<'_>) -> String,
) -> String {
    let mut walk = FenceWalk::new(sentinel);
    map_lines(text, |line| f(walk.step(line)))
}

/// `LIST_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/` (`list-layout.ts:253`; `blocks.ts`'s HTML wrap
/// spells the same regex): a line's indent and optional marker. It always matches.
static LIST_LINE_PREFIX: LazyLock<Regex> = LazyLock::new(|| js(r"^(\s*)((?:\*|\d+\.)\s)?"));

/// A rendered line split at [`LIST_LINE_PREFIX`]: `prefix` is `indent` + the marker, and
/// `rest` is everything after it.
pub struct LinePrefix<'a> {
    pub indent: &'a str,
    pub prefix: &'a str,
    pub rest: &'a str,
}

/// Split `line` at its indent-and-marker prefix.
pub fn line_prefix(line: &str) -> LinePrefix<'_> {
    let caps = LIST_LINE_PREFIX.captures(line);
    let indent = caps
        .as_ref()
        .and_then(|c| c.get(1))
        .map_or("", |m| m.as_str());
    let end = caps.as_ref().and_then(|c| c.get(0)).map_or(0, |m| m.end());
    LinePrefix {
        indent,
        prefix: &line[..end],
        rest: &line[end..],
    }
}

/// The hanging-indent join: the first line after `prefix`, every later one after as many
/// spaces as `prefix` is wide.
pub fn hang(prefix: &str, lines: &[String], measure: Measure) -> String {
    let continuation = " ".repeat(measure.width(prefix));
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            if i == 0 {
                format!("{prefix}{line}")
            } else {
                format!("{continuation}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `rest` wrapped at `width - width(prefix)` (at least 1), unjoined.
pub fn wrap_after_prefix(prefix: &str, rest: &str, width: isize, measure: Measure) -> Vec<String> {
    let available = width - isize::try_from(measure.width(prefix)).unwrap_or(isize::MAX);
    wrap_ansi(
        rest,
        usize::try_from(available.max(1)).unwrap_or(1),
        measure,
    )
}

/// Whether any line after the first is marker-shaped, asked of its visible text.
pub fn continuation_marks(lines: &[String], marks: &dyn Fn(&str) -> bool) -> bool {
    lines
        .iter()
        .skip(1)
        .any(|line| marks(&strip_sequences(line)))
}

/// Prefix `guard` onto every line after the first whose visible text is marker-shaped.
pub fn guard_continuations(
    lines: Vec<String>,
    guard: &str,
    marks: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| {
            if i > 0 && marks(&strip_sequences(&line)) {
                format!("{guard}{line}")
            } else {
                line
            }
        })
        .collect()
}

/// The marker guard, wrap → guard → narrow: render at `width`; if a continuation line would
/// read as a list marker, render one column narrower and prefix each such line with a space.
/// `escalate` sees that narrowed render and may ask for two columns and a two-space guard
/// instead (`ListTextLayout::text`'s on-grid `* ` case); every other caller passes `|_| false`.
pub fn wrap_guard_narrow(
    render: impl Fn(isize) -> Vec<String>,
    width: isize,
    marks: &dyn Fn(&str) -> bool,
    escalate: impl Fn(&[String]) -> bool,
) -> Vec<String> {
    let lines = render(width);
    if !continuation_marks(&lines, marks) {
        return lines;
    }
    let narrowed = render(width - 1);
    if escalate(&narrowed) {
        return guard_continuations(render(width - 2), "  ", marks);
    }
    guard_continuations(narrowed, " ", marks)
}

/// `/^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s/`
pub static LIST_BULLET: LazyLock<Regex> = LazyLock::new(|| js(r"^\s{2,}(?:[•*\-◦‣+]|\d+\.)\s"));
static LIST_MARKER_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| js(r"^(\s{2,}(?:[•*\-◦‣+]|\d+\.)\s+)"));
/// `/^(?:\*|\d+\.)/`
pub static MARKER_SHAPED_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^(?:\*|\d+\.)"));
/// `/^\*\s/`
pub static REWRITABLE_MARKER_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^\*\s"));
/// `/^(?:[•*\-◦‣+]|\d+\.)\s/`
pub static COLUMN_ZERO_MARKER: LazyLock<Regex> =
    LazyLock::new(|| js(r"^(?:[\x{2022}*\-\x{25e6}\x{2023}+]|\d+\.)\s"));
static INDENTED_LINE: LazyLock<Regex> = LazyLock::new(|| js(r"^\s{2,}\S"));

/// `isGuardShapedLine`.
pub fn is_guard_shaped_line(text: &str) -> bool {
    MARKER_SHAPED_LINE.is_match(text) || COLUMN_ZERO_MARKER.is_match(text)
}

/// `isIndentedLine`: two or more leading whitespace, then a non-whitespace.
pub fn is_indented_line(line: &str) -> bool {
    INDENTED_LINE.is_match(line)
}

/// One open list item: its marker column and its text column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenListItem {
    pub marker_column: usize,
    pub text_column: usize,
}

/// `trackListLine`: update `open` for one rendered line; return the item a continuation
/// line belongs to, or `None` for a marker line, a blank line or a column-0 line.
pub fn track_list_line(
    line: &str,
    open: &mut Vec<OpenListItem>,
    measure: Measure,
) -> Option<OpenListItem> {
    if js_trim(line).is_empty() {
        return None;
    }
    if let Some(caps) = LIST_MARKER_PREFIX.captures(line) {
        let prefix = caps.get(1).map_or("", |m| m.as_str());
        let lead = prefix.len() - js_trim_start(prefix).len();
        let marker_column = measure.width(&prefix[..lead]);
        let text_column = measure.width(prefix);
        while open
            .last()
            .is_some_and(|top| top.marker_column >= marker_column)
        {
            open.pop();
        }
        open.push(OpenListItem {
            marker_column,
            text_column,
        });
        return None;
    }
    if !is_indented_line(line) {
        open.clear();
        return None;
    }
    open.last().copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::NARROW_MEASURE;

    #[test]
    fn marker_regexes() {
        assert!(LIST_BULLET.is_match("  • item"));
        assert!(LIST_BULLET.is_match("    12. item"));
        assert!(!LIST_BULLET.is_match(" • item"));
        assert!(LIST_BULLET.is_match("\u{3000}\u{FEFF}- x"));
        assert!(!LIST_BULLET.is_match("  \u{85}- x"));
        assert!(is_guard_shaped_line("* x"));
        assert!(is_guard_shaped_line("3."));
        assert!(is_guard_shaped_line("◦ x"));
        assert!(!is_guard_shaped_line("-x"));
        assert!(is_guard_shaped_line("- x"));
        assert!(REWRITABLE_MARKER_LINE.is_match("* a"));
        assert!(!COLUMN_ZERO_MARKER.is_match("１. x"));
        assert!(is_indented_line("  x"));
        assert!(!is_indented_line("   "));
    }

    #[test]
    fn track_list_line_follows_nesting() {
        let mut open = Vec::new();
        let m = NARROW_MEASURE;
        assert_eq!(track_list_line("  • outer", &mut open, m), None);
        assert_eq!(
            open,
            vec![OpenListItem {
                marker_column: 2,
                text_column: 4
            }]
        );
        assert_eq!(track_list_line("      ◦ inner", &mut open, m), None);
        assert_eq!(open.len(), 2);
        assert_eq!(
            track_list_line("        cont", &mut open, m),
            Some(OpenListItem {
                marker_column: 6,
                text_column: 8
            })
        );
        assert_eq!(track_list_line("   ", &mut open, m), None);
        assert_eq!(open.len(), 2);
        assert_eq!(track_list_line("  • next", &mut open, m), None);
        assert_eq!(open.len(), 1);
        assert_eq!(track_list_line("prose", &mut open, m), None);
        assert!(open.is_empty());
        assert_eq!(track_list_line("    stray", &mut open, m), None);
    }

    #[test]
    fn strip_sequences_removes_every_sequence_kind() {
        let t = crate::ansi::link("x", "u", true);
        assert_eq!(strip_sequences(&format!("\u{1b}[1m{t}\u{1b}[22m")), "x");
    }
}
