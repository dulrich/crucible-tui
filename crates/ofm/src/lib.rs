//! Pure Obsidian-Flavored-Markdown parse primitives shared by mdview and an out-of-repo
//! path-dependency consumer (`plans/ofm-crate-extraction.md`). No I/O, no env/argv/TTY reads,
//! no terminal or render dependencies.

mod check;
pub mod frontmatter;
pub mod js;
pub mod note;
mod parse;
pub mod wikilink;

pub use check::check_spans;
pub use note::{
    BlockId, Callout, FmLink, Footnote, Frontmatter, Heading, LinkDest, LinkKind, MdLink, Note,
    Span, Tag, TagSource, Task, WikiLink,
};
pub use parse::parse;

use comrak::Options;

/// mdview's lexer base options, verbatim (Decisions locked 2 of `plans/mdview-rust-port.md`).
pub fn comrak_options() -> Options<'static> {
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
