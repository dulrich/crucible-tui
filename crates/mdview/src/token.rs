//! marked-shaped tokens — the walk's input, and the schema the L-gate normalizes both sides to.
//!
//! **Exactly the census fields** (WP-1 of `plans/mdview-rust-port.md`, step 0): for each of the
//! 19 token types `TS_BASELINE` `src/walk.ts` dispatches, the fields some renderer module reads, plus `raw`
//! on `del` (the `single-tilde-del` divergence predicate reads it). Nothing else is carried, so
//! the adapter (`lex/`, WP-7) produces nothing the renderer cannot see and the TS dumper
//! (`scripts/lexer-diff.ts`, deleted at WP-9; `TS_BASELINE` = `c097c66`) serialized the same shape. `tokens` on a `text` token is an
//! `Option` because its *presence* is load-bearing: `TS_BASELINE` `src/list-layout.ts`'s tight-item test
//! reads whether the key exists to tell a block text token from an inline one.
//!
//! Only `Serialize` is derived (`mdview __parity lex` dumps adapter tokens); nothing deserializes
//! tokens since token injection was removed (WP-2 of `plans/retire-ts-parity-residue.md`).

use serde::Serialize;

use crate::text::Align;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Token {
    Space,
    Hr,
    Heading {
        depth: u8,
        tokens: Vec<Token>,
    },
    Code {
        lang: Option<String>,
        text: String,
    },
    Table {
        header: Vec<TableCell>,
        rows: Vec<Vec<TableCell>>,
        align: Vec<Option<Align>>,
    },
    Blockquote {
        tokens: Vec<Token>,
    },
    List {
        ordered: bool,
        items: Vec<ListItem>,
    },
    Html {
        text: String,
    },
    Paragraph {
        tokens: Vec<Token>,
    },
    Text {
        raw: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens: Option<Vec<Token>>,
    },
    Escape {
        text: String,
    },
    Link {
        href: String,
        text: String,
        tokens: Vec<Token>,
    },
    Image {
        href: String,
        title: Option<String>,
        text: String,
    },
    Strong {
        text: String,
        tokens: Vec<Token>,
    },
    Em {
        text: String,
        tokens: Vec<Token>,
    },
    Codespan {
        text: String,
    },
    Br,
    Del {
        raw: String,
        text: String,
        tokens: Vec<Token>,
    },
    Wikilink {
        slug: String,
        fragment: Option<String>,
        embed: bool,
        alias: Option<String>,
        tokens: Vec<Token>,
    },
}

/// A table header or body cell (`TS_BASELINE` `src/table.ts` reads `text` and flattens `tokens`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableCell {
    pub text: String,
    pub tokens: Vec<Token>,
}

/// A list item (`TS_BASELINE` `src/lists.ts`): `raw` feeds `RAW_TASK_STATE`, and only `loose` is read for
/// spacing — never comrak's `tight`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListItem {
    pub raw: String,
    pub task: bool,
    pub checked: Option<bool>,
    pub loose: bool,
    pub tokens: Vec<Token>,
}
