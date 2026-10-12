//! The immutable per-render layout context, ported from `TS_BASELINE` `src/layout-context.ts`.
//!
//! Every field is fixed at construction except `prefix`, which (as in TS, where the frozen
//! object holds a mutable stack) is interior-mutable: visitors push and pop the columns
//! enclosing blocks still owe. `color` is derived from `sgr` here and nowhere else.

use std::cell::RefCell;
use std::rc::Rc;

use crate::glyphs::GlyphSet;
use crate::lang::FenceLanguageResolver;
use crate::style::SgrMode;
use crate::width::Measure;

/// Where a `[[slug]]` (with an optional `#fragment`) points, if anywhere.
pub type WikiLinkResolver = Rc<dyn Fn(&str, Option<&str>) -> Option<String>>;

/// One owed prefix: its columns, and whether a list pushed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefixEntry {
    pub columns: usize,
    pub list: bool,
}

/// The pending-prefix stack (`createPrefixColumns`).
#[derive(Debug, Default)]
pub struct PrefixColumns {
    entries: RefCell<Vec<PrefixEntry>>,
}

impl PrefixColumns {
    pub fn push(&self, entry: PrefixEntry) {
        self.entries.borrow_mut().push(entry);
    }
    pub fn pop(&self) {
        self.entries.borrow_mut().pop();
    }
    /// Total columns owed.
    pub fn width(&self) -> usize {
        self.entries.borrow().iter().map(|e| e.columns).sum()
    }
    /// How many entries are list entries.
    pub fn list_depth(&self) -> usize {
        self.entries.borrow().iter().filter(|e| e.list).count()
    }
}

/// `LayoutContextInit`.
pub struct LayoutContextInit {
    pub width: usize,
    pub glyphs: &'static GlyphSet,
    pub measure: Measure,
    pub resolve_fence_language: FenceLanguageResolver,
    pub resolve_wiki_link: Option<WikiLinkResolver>,
    pub emoji: bool,
    pub sgr: SgrMode,
    pub hyperlinks: Option<bool>,
    pub tmux: Option<bool>,
}

/// The one per-render value the visitors read.
pub struct LayoutContext {
    pub width: usize,
    pub glyphs: &'static GlyphSet,
    pub measure: Measure,
    pub prefix: PrefixColumns,
    pub resolve_fence_language: FenceLanguageResolver,
    pub resolve_wiki_link: Option<WikiLinkResolver>,
    pub emoji: bool,
    pub sgr: SgrMode,
    pub color: bool,
    pub hyperlinks: bool,
    pub tmux: bool,
}

impl LayoutContext {
    /// `createLayoutContext`: a fresh prefix stack, `color = sgr != none`, flags default off.
    pub fn new(init: LayoutContextInit) -> Self {
        LayoutContext {
            width: init.width,
            glyphs: init.glyphs,
            measure: init.measure,
            prefix: PrefixColumns::default(),
            resolve_fence_language: init.resolve_fence_language,
            resolve_wiki_link: init.resolve_wiki_link,
            emoji: init.emoji,
            sgr: init.sgr,
            color: init.sgr != SgrMode::None,
            hyperlinks: init.hyperlinks.unwrap_or(false),
            tmux: init.tmux.unwrap_or(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::glyphs::UNICODE_GLYPHS;
    use crate::lang::AliasOnlySupport;
    use crate::width::NARROW_MEASURE;

    fn ctx(sgr: SgrMode) -> LayoutContext {
        LayoutContext::new(LayoutContextInit {
            width: 80,
            glyphs: &UNICODE_GLYPHS,
            measure: NARROW_MEASURE,
            resolve_fence_language: FenceLanguageResolver::builtin(Rc::new(AliasOnlySupport)),
            resolve_wiki_link: None,
            emoji: true,
            sgr,
            hyperlinks: None,
            tmux: None,
        })
    }

    #[test]
    fn color_is_derived_and_flags_default_off() {
        assert!(ctx(SgrMode::Formats).color);
        assert!(ctx(SgrMode::Full).color);
        assert!(!ctx(SgrMode::None).color);
        let c = ctx(SgrMode::Full);
        assert!(!c.hyperlinks && !c.tmux);
        assert_eq!(
            c.resolve_fence_language
                .resolve(Some("dataview"))
                .as_deref(),
            Some("sql")
        );
    }

    #[test]
    fn prefix_stack_sums_and_counts() {
        let c = ctx(SgrMode::None);
        assert_eq!(c.prefix.width(), 0);
        c.prefix.push(PrefixEntry {
            columns: 4,
            list: false,
        });
        c.prefix.push(PrefixEntry {
            columns: 2,
            list: true,
        });
        assert_eq!((c.prefix.width(), c.prefix.list_depth()), (6, 1));
        c.prefix.pop();
        assert_eq!((c.prefix.width(), c.prefix.list_depth()), (4, 0));
        c.prefix.pop();
        c.prefix.pop();
        assert_eq!(c.prefix.width(), 0);
    }
}
