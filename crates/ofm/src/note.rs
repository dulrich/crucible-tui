//! The item set [`crate::parse`] returns (`plans/ofm-crate-extraction.md`, Public Interfaces).
//!
//! Every `span` is a byte range into the `source` handed to `parse` — the whole file, frontmatter
//! included — and slices it on char boundaries.

use std::ops::Range;

use crate::frontmatter::JsValue;

/// A byte range into the source `parse` was given.
pub type Span = Range<usize>;

/// One parsed note.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Note {
    pub frontmatter: Option<Frontmatter>,
    /// The byte offset the body starts at (0 without frontmatter).
    pub body_offset: usize,
    pub wikilinks: Vec<WikiLink>,
    pub md_links: Vec<MdLink>,
    pub tags: Vec<Tag>,
    pub fm_links: Vec<FmLink>,
    pub footnote_refs: Vec<Footnote>,
    pub footnote_defs: Vec<Footnote>,
    pub callouts: Vec<Callout>,
    pub block_ids: Vec<BlockId>,
    pub headings: Vec<Heading>,
    pub tasks: Vec<Task>,
}

/// The YAML frontmatter block.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    /// Both `---` fences inclusive, through the closing fence's line ending.
    pub span: Span,
    /// The YAML between the fences, line endings normalized to `\n`.
    pub raw: String,
    pub value: Result<JsValue, String>,
}

/// A body wiki-link or embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// Empty for a fragment-only link (`[[#h]]`, `[[#^id]]`): the note itself.
    pub target: String,
    pub fragment: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
    /// Inside a GFM table cell: the parts were read after the cell's `\|` → `|` unescape.
    pub in_table: bool,
    /// Including the leading `!` of an embed.
    pub span: Span,
}

/// The shape of a markdown link's source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `[label](dest)`, `[label][ref]`, `![alt](dest)`: the span starts with `[` or `![`.
    Bracketed,
    /// `<dest>`: the span is the destination in angle brackets.
    Angle,
    /// A GFM extended autolink: the span is the bare destination text.
    Bare,
}

/// A link destination, resolver-agnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkDest {
    /// Has a URI scheme (`https:`, `mailto:`, `obsidian:`, …) or is protocol-relative.
    External(String),
    /// A vault-relative or note-relative path, percent-decoded, its `#fragment` split off.
    Local {
        path: String,
        fragment: Option<String>,
    },
}

/// A markdown link or image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdLink {
    pub image: bool,
    pub kind: LinkKind,
    /// The destination as CommonMark reads it (escapes and entities resolved, not
    /// percent-decoded).
    pub dest_raw: String,
    pub dest: LinkDest,
    pub span: Span,
}

/// Where a tag was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagSource {
    Frontmatter,
    /// The span is `#` plus the name.
    Inline {
        span: Span,
    },
}

/// A tag (`name` has no `#`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    pub source: TagSource,
}

/// A whole-value `[[…]]` frontmatter property (no per-value span: search `Frontmatter.span`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FmLink {
    pub key: String,
    pub target: String,
    pub fragment: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
}

/// A footnote reference (`[^label]`) or definition (`[^label]: …`, the whole block).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Footnote {
    pub label: String,
    pub span: Span,
}

/// An Obsidian callout: a blockquote opening `[!kind]±title`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callout {
    /// Lowercased.
    pub kind: String,
    pub fold: Option<char>,
    pub title: String,
    /// The blockquote.
    pub span: Span,
}

/// A block id: the span is `^` plus the id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockId {
    pub id: String,
    pub span: Span,
}

/// An ATX or setext heading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heading {
    pub level: u8,
    /// The heading's source text, markers and closing sequence trimmed.
    pub text: String,
    pub span: Span,
}

/// A task list item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    /// The char between the brackets (`' '`, `x`, or any non-standard status such as `>`).
    pub status: char,
    /// The first line of the item's text after the checkbox, trimmed.
    pub text: String,
    /// The list item.
    pub span: Span,
}
