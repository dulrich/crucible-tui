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

use crate::ansi::strip_sequences;
use crate::blocks;
use crate::context::{CounterGuard, LayoutContext, PrefixEntry};
use crate::inline::HARD_RETURN;
use crate::list_lines::{
    MARKER_SHAPED_LINE, REWRITABLE_MARKER_LINE, continuation_marks, hang, is_guard_shaped_line,
    line_prefix, map_fenced_lines, wrap_after_prefix, wrap_guard_narrow,
};
use crate::lists;
use crate::text::{js_regex, js_trim, js_trim_end, js_trim_start};
use crate::token::{ListItem, Token};
use crate::walk::{self, R, Visitors};
use crate::width::Measure;
use crate::wrap::wrap_ansi;

/// `LIST_INDENT_PER_LEVEL` (`list-layout.ts:90`).
const LIST_INDENT_PER_LEVEL: usize = 4;
/// `BLOCKQUOTE_INDENT_PER_LEVEL` (`list-layout.ts:98`).
const BLOCKQUOTE_INDENT_PER_LEVEL: usize = 4;

/// `HARD_BREAK_TAIL = /(?: {2,}|\\|<br\s*\/?>)$/i` (`list-layout.ts:168`). No `m` flag, so `$`
/// is the end of the whole string.
static HARD_BREAK_TAIL: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"(?i)(?: {2,}|\\|<br\s*/?>)$"));

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
    let visible_before = strip_sequences(before);
    if js_trim(&visible_before).is_empty() || js_trim(&strip_sequences(after)).is_empty() {
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
    map_fenced_lines(body, sentinel, |fence| {
        let line = fence.line;
        if fence.touches_fence() || signed(measure.width(line)) <= budget {
            return line.to_owned();
        }
        let split = line_prefix(line);
        let on_grid = measure
            .width(split.prefix)
            .is_multiple_of(LIST_INDENT_PER_LEVEL);
        let marks = |visible: &str| on_grid && MARKER_SHAPED_LINE.is_match(visible);
        let wrapped = wrap_guard_narrow(
            |width| wrap_after_prefix(split.prefix, split.rest, width, measure),
            budget,
            &marks,
            |_| false,
        );
        hang(split.prefix, &wrapped, measure)
    })
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
        let _depth = CounterGuard::add(&self.inline_depth, 1);
        body()
    }

    /// `ownedList` (`list-layout.ts:436-458`).
    pub fn list<V: Visitors + ?Sized>(&self, host: &V, ordered: bool, items: &[ListItem]) -> R {
        let _prefix = self.layout.prefix.scoped(PrefixEntry {
            columns: LIST_INDENT_PER_LEVEL,
            list: true,
        });
        let depth = self.layout.prefix.list_depth();
        self.list_body(host, ordered, items, depth)
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
        let render = |width: isize| -> Vec<String> {
            segments
                .iter()
                .map(|segment| wrap_ansi(segment, at_least_one(width), measure).join("\n"))
                .collect::<Vec<_>>()
                .join("\n")
                .split('\n')
                .map(str::to_owned)
                .collect()
        };
        let marks = |visible: &str| MARKER_SHAPED_LINE.is_match(visible);
        let guard_lands_on_grid =
            (self.pending_prefix_width() + 1).is_multiple_of(LIST_INDENT_PER_LEVEL);
        let rewritable = |visible: &str| REWRITABLE_MARKER_LINE.is_match(visible);
        let wrapped = wrap_guard_narrow(render, budget, &marks, |narrowed| {
            guard_lands_on_grid && continuation_marks(narrowed, &rewritable)
        });
        Ok(settle(&wrapped.join("\n")))
    }

    /// `ownedParagraph` (`list-layout.ts:752-802`). The inline walk runs once and is reused by
    /// the guard's narrower re-render: it is pure under the raised `inlineDepth`.
    pub fn paragraph<V: Visitors + ?Sized>(&self, host: &V, tokens: &[Token]) -> R {
        self.with_inline(|| {
            let budget = at_least_one(self.raw_budget());
            let inner = walk::parse_inline(host, tokens)?;
            let render = |width: isize| -> Vec<String> {
                blocks::render_paragraph(self.layout, &inner, at_least_one(width))
                    .split('\n')
                    .map(str::to_owned)
                    .collect()
            };
            let lines = wrap_guard_narrow(render, signed(budget), &is_guard_shaped_line, |_| false);
            Ok(lines.join("\n"))
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
        let body = {
            let _prefix = self.layout.prefix.scoped(PrefixEntry {
                columns: BLOCKQUOTE_INDENT_PER_LEVEL,
                list: false,
            });
            let _quote = CounterGuard::add(&self.quote_columns, BLOCKQUOTE_INDENT_PER_LEVEL);
            walk::parse(host, tokens, true)
        };
        Ok(blocks::render_blockquote(self.layout, &body?))
    }
}

#[cfg(test)]
mod tests;
