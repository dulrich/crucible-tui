//! The list/text layout state machine, ported from `TS_BASELINE` `src/list-layout.ts` (WP-4a of
//! `plans/mdview-rust-port.md`): the five visitors that share one render's layout state —
//! `list`, `text`, `paragraph`, `heading` and `blockquote` — and the module-level helpers only
//! they call (`isHardBoundary`, `coalesceTightItemLines`, `currentListBudget`,
//! `rewrapListBody`, `marksVisible`).
//!
//! The state is two counters (`inlineDepth`, `quoteColumns`) and the prefix stack, which lives
//! on the `LayoutContext`. One `ListTextLayout` is built per render (`createListTextLayout`);
//! `render.rs`'s renderer object delegates its five visitors here, handing itself in as the
//! host whose walk the visitors re-enter (TS: `this.parser`).
//!
//! Composition (`renderList`, `substituteBullets`) is `lists.rs`'s (WP-4b); the two one-line
//! seams below call it.
//!
//! The *why* behind every rule here is the TS module's own comments and
//! `docs/agents/list-pipeline.md`; this file cites `list-layout.ts:NNN` for each.

use std::cell::Cell;
use std::sync::LazyLock;

use regex::Regex;

use crate::blocks;
use crate::context::{LayoutContext, PrefixEntry};
use crate::inline::HARD_RETURN;
use crate::list_lines::{
    MARKER_SHAPED_LINE, REWRITABLE_MARKER_LINE, is_guard_shaped_line, strip_ansi,
};
use crate::lists;
use crate::text::{JS_WS_CLASS, js_trim, js_trim_end, js_trim_start};
use crate::token::{ListItem, Token};
use crate::walk::{self, R, Visitors};
use crate::width::Measure;
use crate::wrap::wrap_ansi;

/// `LIST_INDENT_PER_LEVEL` (`list-layout.ts:90`).
const LIST_INDENT_PER_LEVEL: usize = 4;
/// `BLOCKQUOTE_INDENT_PER_LEVEL` (`list-layout.ts:98`).
const BLOCKQUOTE_INDENT_PER_LEVEL: usize = 4;

fn js_regex(pattern: &str) -> Regex {
    let ws = format!("[{JS_WS_CLASS}]");
    Regex::new(&pattern.replace(r"\s", &ws)).expect("list-layout regex compiles")
}

/// `HARD_BREAK_TAIL = /(?: {2,}|\\|<br\s*\/?>)$/i` (`list-layout.ts:168`). No `m` flag, so `$`
/// is the end of the whole string.
static HARD_BREAK_TAIL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)(?: {2,}|\\|<br\s*/?>)$"));

/// `LIST_LINE_PREFIX = /^(\s*)((?:\*|\d+\.)\s)?/` (`list-layout.ts:253`). It always matches.
static LIST_LINE_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^(\s*)((?:\*|[0-9]+\.)\s)?"));

/// `marksVisible` (`list-layout.ts:118`): the marker-shape question asked of the visible text.
fn marks_visible(pattern: &Regex, line: &str) -> bool {
    pattern.is_match(&strip_ansi(line))
}

/// `Math.max(1, n)` over a signed column count, as the `usize` the wrap takes.
fn at_least_one(n: isize) -> usize {
    usize::try_from(n.max(1)).unwrap_or(1)
}

fn signed(n: usize) -> isize {
    isize::try_from(n).unwrap_or(isize::MAX)
}

/// `isHardBoundary` (`list-layout.ts:184-189`): blank on either side (visible text), a
/// `HARD_RETURN` in either raw line, or a hard-break tail on the visible `before`.
pub fn is_hard_boundary(before: &str, after: &str) -> bool {
    let visible_before = strip_ansi(before);
    if js_trim(&visible_before).is_empty() || js_trim(&strip_ansi(after)).is_empty() {
        return true;
    }
    if before.contains(HARD_RETURN) || after.contains(HARD_RETURN) {
        return true;
    }
    HARD_BREAK_TAIL.is_match(&visible_before)
}

/// `coalesceTightItemLines` (`list-layout.ts:205-226`): join soft-wrapped lines into one per
/// hard-break-delimited segment; `coalesced` says whether any join happened.
pub fn coalesce_tight_item_lines(text: &str) -> (Vec<String>, bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut segments = Vec::new();
    let mut current = lines[0].to_owned();
    let mut coalesced = false;
    for pair in lines.windows(2) {
        let (before, after) = (pair[0], pair[1]);
        if is_hard_boundary(before, after) {
            segments.push(std::mem::replace(&mut current, after.to_owned()));
            continue;
        }
        let left = js_trim_end(&current);
        let right = js_trim_start(after);
        current = if left.is_empty() {
            right.to_owned()
        } else if right.is_empty() {
            left.to_owned()
        } else {
            format!("{left} {right}")
        };
        coalesced = true;
    }
    segments.push(current);
    (segments, coalesced)
}

/// `currentListBudget` (`list-layout.ts:244-246`): `max(1, target - 4·(depth-1) - quote)`.
pub fn current_list_budget(depth: usize, target_width: usize, quote_columns: usize) -> usize {
    at_least_one(signed(target_width) - 4 * (signed(depth) - 1) - signed(quote_columns))
}

/// `rewrapListBody` (`list-layout.ts:301-349`): wrap the composed body's over-budget lines,
/// sparing any line that starts inside a fence or carries a sentinel, and guarding an on-grid
/// continuation that would read as a marker.
pub fn rewrap_list_body(
    body: &str,
    depth: usize,
    target_width: usize,
    quote_columns: usize,
    measure: Measure,
    sentinel: char,
) -> String {
    let budget = signed(current_list_budget(depth, target_width, quote_columns));
    let mut inside_code = false;
    body.split('\n')
        .map(|line| {
            let started_inside_code = inside_code;
            let mut carries_sentinel = false;
            for ch in line.chars() {
                if ch == sentinel {
                    inside_code = !inside_code;
                    carries_sentinel = true;
                }
            }
            if started_inside_code || carries_sentinel {
                return line.to_owned();
            }
            if signed(measure.width(line)) <= budget {
                return line.to_owned();
            }

            let caps = LIST_LINE_PREFIX.captures(line);
            let prefix: String = caps.as_ref().map_or(String::new(), |c| {
                format!(
                    "{}{}",
                    c.get(1).map_or("", |m| m.as_str()),
                    c.get(2).map_or("", |m| m.as_str())
                )
            });
            let prefix_width = measure.width(&prefix);
            let rest = &line[prefix.len()..];
            let continuation_prefix = " ".repeat(prefix_width);

            let wrap_at = |width: isize| wrap_ansi(rest, at_least_one(width), measure);
            let on_grid = prefix_width.is_multiple_of(LIST_INDENT_PER_LEVEL);
            let collides = |lines: &[String]| {
                on_grid
                    && lines
                        .iter()
                        .skip(1)
                        .any(|l| marks_visible(&MARKER_SHAPED_LINE, l))
            };

            let mut wrapped = wrap_at(budget - signed(prefix_width));
            let guarded = collides(&wrapped);
            if guarded {
                wrapped = wrap_at(budget - signed(prefix_width) - 1);
            }

            wrapped
                .iter()
                .enumerate()
                .map(|(index, wrapped_line)| {
                    if index == 0 {
                        return format!("{prefix}{wrapped_line}");
                    }
                    let space = if guarded && marks_visible(&MARKER_SHAPED_LINE, wrapped_line) {
                        " "
                    } else {
                        ""
                    };
                    format!("{continuation_prefix}{space}{wrapped_line}")
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The per-render layout state and its five visitors (`ListTextLayout`).
pub struct ListTextLayout<'a> {
    layout: &'a LayoutContext,
    sentinel: char,
    /// `inlineDepth` (`list-layout.ts:409`): non-zero while an inline-dispatching visitor runs.
    inline_depth: Cell<usize>,
    /// `quoteColumns` (`list-layout.ts:417`): enclosing blockquote columns alone.
    quote_columns: Cell<usize>,
}

/// `createListTextLayout(layout, sentinel)` (`list-layout.ts:372`): a fresh state per render.
pub fn create_list_text_layout(layout: &LayoutContext, sentinel: char) -> ListTextLayout<'_> {
    ListTextLayout {
        layout,
        sentinel,
        inline_depth: Cell::new(0),
        quote_columns: Cell::new(0),
    }
}

impl ListTextLayout<'_> {
    /// The current `(inlineDepth, quoteColumns)`, for tests of the per-render invariant.
    pub fn counters(&self) -> (usize, usize) {
        (self.inline_depth.get(), self.quote_columns.get())
    }

    /// `pendingPrefixWidth()`.
    fn pending_prefix_width(&self) -> usize {
        self.layout.prefix.width()
    }

    /// `targetWidth - pendingPrefixWidth()`, signed, before `Math.max(1, …)`.
    fn raw_budget(&self) -> isize {
        signed(self.layout.width) - signed(self.pending_prefix_width())
    }

    /// Run `body` with `inlineDepth` raised, lowering it on every path (`try`/`finally`).
    fn with_inline<T>(&self, body: impl FnOnce() -> T) -> T {
        self.inline_depth.set(self.inline_depth.get() + 1);
        let out = body();
        self.inline_depth.set(self.inline_depth.get() - 1);
        out
    }

    /// `ownedList` (`list-layout.ts:436-458`).
    pub fn list<V: Visitors + ?Sized>(&self, host: &V, ordered: bool, items: &[ListItem]) -> R {
        self.layout.prefix.push(PrefixEntry {
            columns: LIST_INDENT_PER_LEVEL,
            list: true,
        });
        let depth = self.layout.prefix.list_depth();
        let out = self.list_body(host, ordered, items, depth);
        self.layout.prefix.pop();
        out
    }

    fn list_body<V: Visitors + ?Sized>(
        &self,
        host: &V,
        ordered: bool,
        items: &[ListItem],
        depth: usize,
    ) -> R {
        let parse = |tokens: &[Token], top: bool| walk::parse(host, tokens, top);
        let result = lists::render_list(self.layout, ordered, items, &parse, self.sentinel)?;
        let rewrapped = rewrap_list_body(
            &result,
            depth,
            self.layout.width,
            self.quote_columns.get(),
            self.layout.measure,
            self.sentinel,
        );
        Ok(if depth == 1 {
            lists::substitute_bullets(&rewrapped, self.layout.glyphs, self.sentinel)
        } else {
            rewrapped
        })
    }

    /// `wrappedText` (`list-layout.ts:500-729`): a block or inline `text`/`escape` token. `raw`
    /// is `renderInlineText(token)`, i.e. `token.text`; `tokens` is the token's own `tokens`
    /// key, whose presence (condition 3) marks a tight item's block text token.
    pub fn text<V: Visitors + ?Sized>(&self, host: &V, raw: &str, tokens: Option<&[Token]>) -> R {
        if self.layout.prefix.list_depth() == 0 || self.inline_depth.get() > 0 {
            return Ok(raw.to_owned());
        }
        let Some(inline_tokens) = tokens else {
            return Ok(raw.to_owned());
        };
        if raw.contains(self.sentinel) {
            return Ok(raw.to_owned());
        }

        let parsed = self.with_inline(|| walk::parse_inline(host, inline_tokens))?;
        if parsed.contains(self.sentinel) {
            return Ok(raw.to_owned());
        }

        let result = parsed.replace(HARD_RETURN, &format!("{HARD_RETURN}\n"));
        let settle = |text: &str| text.replace(HARD_RETURN, "");

        let (segments, coalesced) = if result.contains('\n') {
            coalesce_tight_item_lines(&result)
        } else {
            (vec![result.clone()], false)
        };
        if !coalesced {
            return Ok(settle(&result));
        }

        let budget = self.raw_budget().max(1);
        let measure = self.layout.measure;
        let wrap_at = |width: isize| {
            segments
                .iter()
                .map(|segment| wrap_ansi(segment, at_least_one(width), measure).join("\n"))
                .collect::<Vec<_>>()
                .join("\n")
        };

        let wrapped = wrap_at(budget);
        let collides = |text: &str| {
            text.split('\n')
                .skip(1)
                .any(|line| marks_visible(&MARKER_SHAPED_LINE, line))
        };
        if !collides(&wrapped) {
            return Ok(settle(&wrapped));
        }

        let guard_lands_on_grid =
            (self.pending_prefix_width() + 1).is_multiple_of(LIST_INDENT_PER_LEVEL);
        let rewritable = |text: &str| {
            text.split('\n')
                .skip(1)
                .any(|line| marks_visible(&REWRITABLE_MARKER_LINE, line))
        };
        let guarded = |text: &str, guard: &str| {
            text.split('\n')
                .enumerate()
                .map(|(index, line)| {
                    if index > 0 && marks_visible(&MARKER_SHAPED_LINE, line) {
                        format!("{guard}{line}")
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        };

        let narrowed = wrap_at(budget - 1);
        if !guard_lands_on_grid || !rewritable(&narrowed) {
            return Ok(settle(&guarded(&narrowed, " ")));
        }
        Ok(settle(&guarded(&wrap_at(budget - 2), "  ")))
    }

    /// `ownedParagraph` (`list-layout.ts:752-802`). The inline walk runs once and is reused by
    /// the guard's narrower re-render: it is pure under the raised `inlineDepth`.
    pub fn paragraph<V: Visitors + ?Sized>(&self, host: &V, tokens: &[Token]) -> R {
        self.with_inline(|| {
            let budget = at_least_one(self.raw_budget());
            let inner = walk::parse_inline(host, tokens)?;
            let result = blocks::render_paragraph(self.layout, &inner, budget);
            let marker = |line: &str| is_guard_shaped_line(&strip_ansi(line));
            if !result.split('\n').skip(1).any(marker) {
                return Ok(result);
            }
            Ok(
                blocks::render_paragraph(self.layout, &inner, at_least_one(signed(budget) - 1))
                    .split('\n')
                    .enumerate()
                    .map(|(i, line)| {
                        if i > 0 && marker(line) {
                            format!(" {line}")
                        } else {
                            line.to_owned()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })
    }

    /// `ownedHeading` (`list-layout.ts:804-815`).
    pub fn heading<V: Visitors + ?Sized>(&self, host: &V, depth: u8, tokens: &[Token]) -> R {
        self.with_inline(|| {
            let budget = at_least_one(self.raw_budget());
            let inner = walk::parse_inline(host, tokens)?;
            Ok(blocks::render_heading(self.layout, depth, &inner, budget))
        })
    }

    /// `ownedBlockquote` (`list-layout.ts:817-833`): four columns pushed, and counted in
    /// `quoteColumns`, for the duration of the children's render.
    pub fn blockquote<V: Visitors + ?Sized>(&self, host: &V, tokens: &[Token]) -> R {
        self.layout.prefix.push(PrefixEntry {
            columns: BLOCKQUOTE_INDENT_PER_LEVEL,
            list: false,
        });
        self.quote_columns
            .set(self.quote_columns.get() + BLOCKQUOTE_INDENT_PER_LEVEL);
        let body = walk::parse(host, tokens, true);
        self.quote_columns
            .set(self.quote_columns.get() - BLOCKQUOTE_INDENT_PER_LEVEL);
        self.layout.prefix.pop();
        Ok(blocks::render_blockquote(self.layout, &body?))
    }
}

#[cfg(test)]
mod tests {
    //! Expected values are the TS module's own output: `rewrapListBody`, `isHardBoundary`,
    //! `coalesceTightItemLines` and `currentListBudget` called directly, and
    //! `createListTextLayout(...).text` called with a `parseInline` that joins its tokens'
    //! text (`br` → `HARD_RETURN`), which is what this crate's renderer does for plain text
    //! and `br` tokens under an inline walk.
    use crate::width::NARROW_MEASURE;

    use super::*;
    use crate::context::{LayoutContextInit, test_init};
    use crate::render::{RenderOptions, Renderer, SENTINEL, Sgr, render};

    const S: char = SENTINEL;

    fn ctx(width: usize) -> LayoutContext {
        LayoutContext::new(LayoutContextInit {
            emoji: false,
            ..test_init(width, Sgr::None)
        })
    }

    fn push(c: &LayoutContext, columns: usize, list: bool) {
        c.prefix.push(PrefixEntry { columns, list });
    }

    fn t(s: &str) -> Token {
        Token::Text {
            raw: s.into(),
            text: s.into(),
            tokens: None,
        }
    }

    /// `wrappedText` over a context with `prefixes` pushed, as the oracle calls it.
    fn text_case(
        width: usize,
        prefixes: &[(usize, bool)],
        raw: &str,
        tokens: Option<&[Token]>,
    ) -> String {
        let c = ctx(width);
        for &(columns, list) in prefixes {
            push(&c, columns, list);
        }
        let r = Renderer::new(&c);
        let out = r.list_text.text(&r, raw, tokens).expect("text renders");
        assert_eq!(r.list_text.counters(), (0, 0), "inlineDepth balances");
        out
    }

    const ITEM: &[(usize, bool)] = &[(4, true), (2, false)];

    #[test]
    fn is_hard_boundary_asks_the_visible_text() {
        let cases: &[(&str, &str, bool)] = &[
            ("a", "", true),
            ("", "b", true),
            ("  ", "b", true),
            ("\u{1b}[31m\u{1b}[39m", "b", true),
            ("a", "\u{1b}[1m \u{1b}[22m", true),
            ("a\r", "b", true),
            ("a", "\rb", true),
            ("a  ", "b", true),
            ("a ", "b", false),
            ("a\\", "b", true),
            ("a<br>", "b", true),
            ("a<BR />", "b", true),
            ("a<br/>", "b", true),
            ("a\u{1b}[33m<br />\u{1b}[39m", "b", true),
            ("a<br x>", "b", false),
            ("a", "b", false),
            ("a\u{3000}", "b", false),
        ];
        for &(before, after, want) in cases {
            assert_eq!(
                is_hard_boundary(before, after),
                want,
                "{before:?} / {after:?}"
            );
        }
    }

    #[test]
    fn coalesce_joins_soft_breaks_and_keeps_hard_ones() {
        let cases: &[(&str, &[&str], bool)] = &[
            ("a", &["a"], false),
            ("a\nb", &["a b"], true),
            ("a \n  b", &["a b"], true),
            ("a\n\nb", &["a", "", "b"], false),
            ("a  \nb", &["a  ", "b"], false),
            ("a\nb\nc  \nd\ne", &["a b c  ", "d e"], true),
            ("\nb", &["", "b"], false),
            ("a\n", &["a", ""], false),
            ("x\u{a0}\n\u{3000}y", &["x y"], true),
            ("a\r\nb\nc", &["a\r", "b c"], true),
        ];
        for &(text, segments, coalesced) in cases {
            let (got, flag) = coalesce_tight_item_lines(text);
            let want: Vec<String> = segments.iter().map(|s| (*s).to_owned()).collect();
            assert_eq!((got, flag), (want, coalesced), "{text:?}");
        }
    }

    #[test]
    fn list_budget_counts_ancestor_levels_and_quotes_only() {
        assert_eq!(current_list_budget(1, 80, 0), 80);
        assert_eq!(current_list_budget(3, 80, 4), 68);
        assert_eq!(current_list_budget(30, 10, 0), 1);
        assert_eq!(current_list_budget(2, 4, 8), 1);
    }

    #[test]
    fn rewrap_list_body_matches_the_reference() {
        let s = S;
        let cases: Vec<(String, usize, usize, usize, String)> = vec![
            ("    * short".into(), 1, 80, 0, "    * short".into()),
            (
                "    * alpha beta gamma delta epsilon zeta eta theta".into(),
                1,
                20,
                0,
                "    * alpha beta\n      gamma delta\n      epsilon zeta\n      eta theta".into(),
            ),
            (
                "    12. alpha beta gamma delta epsilon zeta eta theta".into(),
                1,
                20,
                0,
                "    12. alpha beta\n        gamma delta\n        epsilon zeta\n        eta theta"
                    .into(),
            ),
            (
                "        continuation alpha beta gamma delta epsilon".into(),
                2,
                24,
                0,
                "        continuation\n        alpha beta\n        gamma delta\n        epsilon"
                    .into(),
            ),
            (
                "    * alpha beta gamma delta epsilon zeta eta theta".into(),
                1,
                24,
                4,
                "    * alpha beta\n      gamma delta\n      epsilon zeta\n      eta theta".into(),
            ),
            (
                format!("    * {s}alpha beta gamma delta epsilon zeta eta theta"),
                1,
                20,
                0,
                format!("    * {s}alpha beta gamma delta epsilon zeta eta theta"),
            ),
            (
                format!(
                    "    * a\n{s}    alpha beta gamma delta epsilon zeta eta theta\nmore inside fence alpha beta gamma delta{s}\n    * after alpha beta gamma delta epsilon zeta"
                ),
                1,
                20,
                0,
                format!(
                    "    * a\n{s}    alpha beta gamma delta epsilon zeta eta theta\nmore inside fence alpha beta gamma delta{s}\n    * after alpha\n      beta gamma\n      delta epsilon\n      zeta"
                ),
            ),
            (
                "    * aaaa * bbbb cccc dddd".into(),
                1,
                13,
                0,
                "    * aaaa *\n      bbbb\n      cccc\n      dddd".into(),
            ),
            (
                "    * aaaaa 12. bbbb cccc".into(),
                1,
                14,
                0,
                "    * aaaaa\n      12. bbbb\n      cccc".into(),
            ),
            (
                "    1. aaaa * bbbb cccc dddd".into(),
                1,
                13,
                0,
                "    1. aaaa *\n       bbbb\n       cccc\n       dddd".into(),
            ),
            (
                "    * supercalifragilisticexpialidocious".into(),
                1,
                12,
                0,
                "    * superc\n      alifra\n      gilist\n      icexpi\n      alidoc\n      ious"
                    .into(),
            ),
            (
                "    * \u{1b}[1malpha beta\u{1b}[22m gamma delta".into(),
                1,
                16,
                0,
                "    * \u{1b}[1malpha beta\u{1b}[22m\n      gamma\n      delta".into(),
            ),
            (
                "  \u{3000}* wide space alpha beta gamma".into(),
                1,
                14,
                0,
                "  \u{3000}* wide\n      space\n      alpha\n      beta\n      gamma".into(),
            ),
        ];
        for (body, depth, width, quote, want) in cases {
            assert_eq!(
                rewrap_list_body(&body, depth, width, quote, NARROW_MEASURE, S),
                want,
                "{body:?} @ {width}"
            );
        }
    }

    #[test]
    fn rewrap_list_body_guards_on_grid_continuations_like_the_reference() {
        let bodies = [
            "    12. aaaa * bbbb cccc 3. dd",
            "        aaaa * bbbb 12. cccc * dd ee",
            "    * aaaa * bbbb cccc",
        ];
        let table: &[(usize, usize, &str)] = &[
            (
                0,
                9,
                "    12. a\n        a\n        a\n        a\n         *\n        b\n        b\n        b\n        b\n        c\n        c\n        c\n        c\n        3\n        .\n        d\n        d",
            ),
            (
                0,
                10,
                "    12. a\n        a\n        a\n        a\n         *\n        b\n        b\n        b\n        b\n        c\n        c\n        c\n        c\n        3\n        .\n        d\n        d",
            ),
            (
                0,
                11,
                "    12. aa\n        aa\n         *\n        bb\n        bb\n        cc\n        cc\n         3.\n        dd",
            ),
            (
                0,
                12,
                "    12. aaa\n        a *\n        bbb\n        b\n        ccc\n        c\n         3.\n        dd",
            ),
            (
                0,
                13,
                "    12. aaaa\n         *\n        bbbb\n        cccc\n         3.\n        dd",
            ),
            (
                0,
                14,
                "    12. aaaa\n         *\n        bbbb\n        cccc\n         3. dd",
            ),
            (
                0,
                15,
                "    12. aaaa *\n        bbbb\n        cccc 3.\n        dd",
            ),
            (
                0,
                16,
                "    12. aaaa *\n        bbbb\n        cccc 3.\n        dd",
            ),
            (
                1,
                9,
                "        a\n        a\n        a\n        a\n         *\n        b\n        b\n        b\n        b\n        1\n        2\n        .\n        c\n        c\n        c\n        c\n         *\n        d\n        d\n        e\n        e",
            ),
            (
                1,
                10,
                "        a\n        a\n        a\n        a\n         *\n        b\n        b\n        b\n        b\n        1\n        2\n        .\n        c\n        c\n        c\n        c\n         *\n        d\n        d\n        e\n        e",
            ),
            (
                1,
                11,
                "        aa\n        aa\n         *\n        bb\n        bb\n        12\n        .\n        cc\n        cc\n         *\n        dd\n        ee",
            ),
            (
                1,
                12,
                "        aaa\n        a *\n        bbb\n        b\n         12.\n        ccc\n        c *\n        dd\n        ee",
            ),
            (
                1,
                13,
                "        aaaa\n         *\n        bbbb\n         12.\n        cccc\n         * dd\n        ee",
            ),
            (
                1,
                14,
                "        aaaa\n         *\n        bbbb\n         12.\n        cccc\n         * dd\n        ee",
            ),
            (
                1,
                15,
                "        aaaa *\n        bbbb\n         12.\n        cccc *\n        dd ee",
            ),
            (
                1,
                16,
                "        aaaa *\n        bbbb 12.\n        cccc *\n        dd ee",
            ),
            (
                2,
                9,
                "    * aaa\n      a *\n      bbb\n      b\n      ccc\n      c",
            ),
            (2, 10, "    * aaaa\n      *\n      bbbb\n      cccc"),
            (2, 11, "    * aaaa\n      *\n      bbbb\n      cccc"),
            (2, 12, "    * aaaa *\n      bbbb\n      cccc"),
            (2, 13, "    * aaaa *\n      bbbb\n      cccc"),
            (2, 14, "    * aaaa *\n      bbbb\n      cccc"),
            (2, 15, "    * aaaa *\n      bbbb cccc"),
            (2, 16, "    * aaaa *\n      bbbb cccc"),
        ];
        for &(body, width, want) in table {
            assert_eq!(
                rewrap_list_body(bodies[body], 1, width, 0, NARROW_MEASURE, S),
                want,
                "body {body} @ {width}"
            );
        }
    }

    #[test]
    fn text_takes_the_raw_path_outside_a_tight_item_position() {
        let parsed = [t("a b")];
        // Condition 1: no list open.
        assert_eq!(text_case(20, &[], "a **b**", Some(&parsed)), "a **b**");
        // Condition 3: no `tokens` key.
        assert_eq!(text_case(20, ITEM, "a **b**", None), "a **b**");
        // A body carrying a code sentinel, before and after parsing.
        assert_eq!(text_case(20, ITEM, "a\u{0}b", Some(&parsed)), "a\u{0}b");
        assert_eq!(text_case(20, ITEM, "src", Some(&[t("par\u{0}sed")])), "src");
        // Condition 2: inside an inline-dispatching visitor.
        let c = ctx(20);
        push(&c, 4, true);
        let r = Renderer::new(&c);
        let out = r
            .list_text
            .with_inline(|| r.list_text.text(&r, "raw", Some(&parsed)));
        assert_eq!(out.unwrap(), "raw");
    }

    #[test]
    fn text_parses_a_tight_item_and_settles_hard_returns() {
        assert_eq!(text_case(20, ITEM, "src", Some(&[t("parsed")])), "parsed");
        assert_eq!(
            text_case(20, ITEM, "src", Some(&[t("one"), Token::Br, t("\ntwo")])),
            "one\n\ntwo"
        );
        assert_eq!(
            text_case(
                20,
                ITEM,
                "src",
                Some(&[t("alpha beta\ngamma delta epsilon zeta eta")])
            ),
            "alpha beta\ngamma delta\nepsilon zeta\neta"
        );
        assert_eq!(
            text_case(
                20,
                ITEM,
                "src",
                Some(&[t("first  "), Token::Br, t("\nsecond\nthird")])
            ),
            "first\n\nsecond third"
        );
        assert_eq!(
            text_case(3, ITEM, "src", Some(&[t("ab cd\nef")])),
            "a\nb\nc\nd\ne\nf"
        );
    }

    #[test]
    fn text_guards_marker_shaped_continuations_like_the_reference() {
        assert_eq!(
            text_case(16, ITEM, "src", Some(&[t("aaaa bbbb\n* cccc dddd eeee")])),
            "aaaa bbbb\n * cccc\ndddd eeee"
        );
        let one_digit = &[(4, true), (3, false)];
        assert_eq!(
            text_case(
                14,
                one_digit,
                "src",
                Some(&[t("aaa bbb\n* c dddd eeee ffff")])
            ),
            "aaa\nbbb *\nc dddd\neeee\nffff"
        );
        assert_eq!(
            text_case(
                14,
                one_digit,
                "src",
                Some(&[t("aaa bbb\n12. c dddd eeee ffff")])
            ),
            "aaa\nbbb\n 12. c\ndddd\neeee\nffff"
        );
        assert_eq!(
            text_case(
                14,
                one_digit,
                "src",
                Some(&[t("aaa bbb\n*x c dddd eeee ffff")])
            ),
            "aaa\nbbb *x\nc dddd\neeee\nffff"
        );
    }

    #[test]
    fn text_guard_sweep_matches_the_reference() {
        let sources = [
            "aaa bbb\n* c dddd * e ffff",
            "aaaa bbbb\n12. cccc * d eeee",
            "a *x\nb * c 1. d",
        ];
        let table: &[(usize, usize, usize, &str)] = &[
            (
                0,
                2,
                8,
                "a\na\na\nb\nb\nb\n *\nc\nd\nd\nd\nd\n *\ne\nf\nf\nf\nf",
            ),
            (0, 2, 9, "aa\na\nbb\nb\n *\nc\ndd\ndd\n *\ne\nff\nff"),
            (0, 2, 10, "aaa\nbbb\n * c\nddd\nd *\ne\nfff\nf"),
            (0, 2, 11, "aaa\nbbb\n * c\ndddd\n * e\nffff"),
            (0, 2, 12, "aaa\nbbb *\nc\ndddd\n * e\nffff"),
            (0, 2, 13, "aaa\nbbb *\nc dddd\n * e\nffff"),
            (0, 2, 14, "aaa bbb\n * c\ndddd *\ne ffff"),
            (0, 2, 15, "aaa bbb *\nc dddd *\ne ffff"),
            (0, 2, 16, "aaa bbb *\nc dddd * e\nffff"),
            (
                0,
                3,
                8,
                "a\na\na\nb\nb\nb\n *\nc\nd\nd\nd\nd\n *\ne\nf\nf\nf\nf",
            ),
            (
                0,
                3,
                9,
                "a\na\na\nb\nb\nb\n *\nc\nd\nd\nd\nd\n *\ne\nf\nf\nf\nf",
            ),
            (0, 3, 10, "aa\na\nbb\nb\n *\nc\ndd\ndd\n *\ne\nff\nff"),
            (0, 3, 11, "aa\na\nbb\nb\n  *\nc\ndd\ndd\n  *\ne\nff\nff"),
            (0, 3, 12, "aaa\nbbb\n  * c\nddd\nd *\ne\nfff\nf"),
            (0, 3, 13, "aaa\nbbb\n  * c\ndddd\n  * e\nffff"),
            (0, 3, 14, "aaa\nbbb *\nc\ndddd\n  * e\nffff"),
            (0, 3, 15, "aaa\nbbb *\nc dddd\n  * e\nffff"),
            (0, 3, 16, "aaa bbb *\nc dddd *\ne ffff"),
            (
                1,
                2,
                8,
                "a\na\na\na\nb\nb\nb\nb\n1\n2\n.\nc\nc\nc\nc\n *\nd\ne\ne\ne\ne",
            ),
            (1, 2, 9, "aa\naa\nbb\nbb\n12\n.\ncc\ncc\n *\nd\nee\nee"),
            (1, 2, 10, "aaa\na\nbbb\nb\n 12.\nccc\nc *\nd\neee\ne"),
            (1, 2, 11, "aaaa\nbbbb\n 12.\ncccc\n * d\neeee"),
            (1, 2, 12, "aaaa\nbbbb\n 12.\ncccc\n * d\neeee"),
            (1, 2, 13, "aaaa\nbbbb\n 12.\ncccc *\nd eeee"),
            (1, 2, 14, "aaaa\nbbbb 12.\ncccc * d\neeee"),
            (1, 2, 15, "aaaa\nbbbb 12.\ncccc * d\neeee"),
            (1, 2, 16, "aaaa bbbb\n 12. cccc\n * d eeee"),
            (
                1,
                3,
                8,
                "a\na\na\na\nb\nb\nb\nb\n1\n2\n.\nc\nc\nc\nc\n *\nd\ne\ne\ne\ne",
            ),
            (
                1,
                3,
                9,
                "a\na\na\na\nb\nb\nb\nb\n1\n2\n.\nc\nc\nc\nc\n *\nd\ne\ne\ne\ne",
            ),
            (1, 3, 10, "aa\naa\nbb\nbb\n12\n.\ncc\ncc\n *\nd\nee\nee"),
            (1, 3, 11, "aaa\na\nbbb\nb\n 12.\nccc\nc *\nd\neee\ne"),
            (1, 3, 12, "aaa\na\nbbb\nb\n  12.\nccc\nc *\nd\neee\ne"),
            (1, 3, 13, "aaaa\nbbbb\n  12.\ncccc\n  * d\neeee"),
            (1, 3, 14, "aaaa\nbbbb\n 12.\ncccc *\nd eeee"),
            (1, 3, 15, "aaaa\nbbbb 12.\ncccc * d\neeee"),
            (1, 3, 16, "aaaa\nbbbb 12.\ncccc * d\neeee"),
            (2, 2, 8, "a\n *\nx\nb\n *\nc\n1\n.\nd"),
            (2, 2, 9, "a\n *x\nb\n *\nc\n 1.\nd"),
            (2, 2, 10, "a *x\nb *\nc 1.\nd"),
            (2, 2, 11, "a *x\nb *\nc 1.\nd"),
            (2, 2, 12, "a *x\nb * c\n 1. d"),
            (2, 2, 13, "a *x b\n * c 1.\nd"),
            (2, 2, 14, "a *x b *\nc 1. d"),
            (2, 2, 15, "a *x b *\nc 1. d"),
            (2, 2, 16, "a *x b *\nc 1. d"),
            (2, 3, 8, "a\n *\nx\nb\n *\nc\n1\n.\nd"),
            (2, 3, 9, "a\n *\nx\nb\n *\nc\n1\n.\nd"),
            (2, 3, 10, "a\n *x\nb\n *\nc\n 1.\nd"),
            (2, 3, 11, "a *x\nb *\nc 1.\nd"),
            (2, 3, 12, "a *x\nb *\nc 1.\nd"),
            (2, 3, 13, "a *x\nb * c\n 1. d"),
            (2, 3, 14, "a *x\nb * c\n  1. d"),
            (2, 3, 15, "a *x b *\nc 1. d"),
            (2, 3, 16, "a *x b *\nc 1. d"),
        ];
        for &(source, marker, width, want) in table {
            let tokens = [t(sources[source])];
            assert_eq!(
                text_case(width, &[(4, true), (marker, false)], "r", Some(&tokens)),
                want,
                "source {source}, marker {marker} @ {width}"
            );
        }
    }

    fn doc(source: &str, width: usize) -> String {
        let options = RenderOptions::plain(width);
        render(source, None, &options).expect("renders").text
    }

    #[test]
    fn paragraph_heading_and_blockquote_match_the_reference() {
        assert_eq!(doc("aaaa * b", 6), "aaaa *\nb\n\n");
        assert_eq!(doc("aaa 12. bbb ccc", 8), "aaa 12.\nbbb ccc\n\n");
        assert_eq!(
            doc(
                "# Heading with words\n\n> quoted paragraph * here and more words\n",
                12
            ),
            "# Heading\nwith words\n\n    quoted\n    paragrap\n    h * here\n    and more\n    words\n\n"
        );
        assert_eq!(
            doc(
                "> # quoted heading words\n>\n> > nested quote paragraph * star here\n",
                14
            ),
            "    # quoted\n    heading\n    words\n    \n        nested\n        quote\n        paragr\n        aph *\n        star\n        here\n\n"
        );
    }

    #[test]
    fn supplies_the_five_visitors_as_a_fresh_state_per_render() {
        let c = ctx(80);
        let first = create_list_text_layout(&c, S);
        let second = create_list_text_layout(&c, S);
        first.inline_depth.set(3);
        first.quote_columns.set(8);
        assert_eq!(second.counters(), (0, 0));
        assert_eq!(Renderer::new(&c).list_text.counters(), (0, 0));
    }

    #[test]
    fn a_failing_list_leaves_no_residue() {
        use crate::render::RenderError;
        let c = ctx(40);
        let r = Renderer::new(&c);
        // An inline-only token at block level makes the item's walk fail (WP-4b: the list seam
        // is open, so the error path is reached through composition).
        let items = vec![crate::token::ListItem {
            raw: "- x".into(),
            task: false,
            checked: None,
            loose: false,
            tokens: vec![Token::Br],
        }];
        let list = Token::List {
            ordered: false,
            items: items.clone(),
        };
        assert_eq!(
            r.list_text.list(&r, false, &items),
            Err(RenderError::UnknownToken("br"))
        );
        assert_eq!((c.prefix.width(), c.prefix.list_depth()), (0, 0));
        // Inside a blockquote: the quote's push and `quoteColumns` unwind on the error path too.
        let quoted = [list.clone()];
        assert_eq!(
            r.list_text.blockquote(&r, &quoted),
            Err(RenderError::UnknownToken("br"))
        );
        assert_eq!(r.list_text.counters(), (0, 0));
        assert_eq!(c.prefix.width(), 0);
        // A paragraph, a heading and a blockquote each leave the counters where they found them.
        let para = [t("words")];
        r.list_text.paragraph(&r, &para).unwrap();
        r.list_text.heading(&r, 2, &para).unwrap();
        r.list_text
            .blockquote(
                &r,
                &[Token::Paragraph {
                    tokens: para.to_vec(),
                }],
            )
            .unwrap();
        assert_eq!(r.list_text.counters(), (0, 0));
        assert_eq!(c.prefix.width(), 0);
    }

    #[test]
    fn a_blockquote_owes_its_columns_for_the_duration_of_its_children() {
        // The quoted paragraph wraps at 12 - 4 = 8 columns, then is indented by four.
        assert_eq!(
            doc("> aaaa bbbb cccc\n", 12),
            "    aaaa\n    bbbb\n    cccc\n\n"
        );
        // ...and a document rendered after it is not narrowed (the state is per render).
        assert_eq!(doc("aaaa bbbb cccc\n", 12), "aaaa bbbb\ncccc\n\n");
    }
}
