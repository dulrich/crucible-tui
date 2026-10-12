//! The committed SGR style table and emitter, ported from `TS_BASELINE` `src/style.ts`.
//!
//! `STYLE_TABLE` is exactly the `[open, close]` pairs this renderer may emit; `STYLE_CLASSES`
//! classifies each as hue, format or control; [`emits_under`] is the whole mode rule.
//! [`apply_style`] reproduces `chalk`'s `applyStyle` (nested close/reopen and line-break
//! encasing) over the *filtered* chain; [`style_span`] is the plain wrap frontmatter needs
//! (and deliberately has no empty-string guard).
//!
//! TS memoizes `filterChain` in a `WeakMap`; the memo is a pure-function cache with no
//! observable effect and is not reproduced. This module and `ansi.rs` are the only writers
//! of escape bytes in the crate.

use std::rc::Rc;

pub use crate::render::Sgr as SgrMode;

/// A committed style name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StyleName {
    Reset,
    Bold,
    Dim,
    Italic,
    Underline,
    Strikethrough,
    Red,
    Green,
    Yellow,
    Blue,
    Magenta,
    Cyan,
    Gray,
}

/// What kind of thing a committed style is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StyleClass {
    Hue,
    Format,
    Control,
}

/// One style's escape pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StyleCode {
    pub open: &'static str,
    pub close: &'static str,
}

/// The committed table, in `TS_BASELINE` `src/style.ts`'s declaration order.
pub const STYLE_TABLE: &[(StyleName, &str, StyleCode, StyleClass)] = &[
    (
        StyleName::Reset,
        "reset",
        code("\u{1b}[0m", "\u{1b}[0m"),
        StyleClass::Control,
    ),
    (
        StyleName::Bold,
        "bold",
        code("\u{1b}[1m", "\u{1b}[22m"),
        StyleClass::Format,
    ),
    (
        StyleName::Dim,
        "dim",
        code("\u{1b}[2m", "\u{1b}[22m"),
        StyleClass::Format,
    ),
    (
        StyleName::Italic,
        "italic",
        code("\u{1b}[3m", "\u{1b}[23m"),
        StyleClass::Format,
    ),
    (
        StyleName::Underline,
        "underline",
        code("\u{1b}[4m", "\u{1b}[24m"),
        StyleClass::Format,
    ),
    (
        StyleName::Strikethrough,
        "strikethrough",
        code("\u{1b}[9m", "\u{1b}[29m"),
        StyleClass::Format,
    ),
    (
        StyleName::Red,
        "red",
        code("\u{1b}[31m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Green,
        "green",
        code("\u{1b}[32m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Yellow,
        "yellow",
        code("\u{1b}[33m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Blue,
        "blue",
        code("\u{1b}[34m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Magenta,
        "magenta",
        code("\u{1b}[35m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Cyan,
        "cyan",
        code("\u{1b}[36m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
    (
        StyleName::Gray,
        "gray",
        code("\u{1b}[90m", "\u{1b}[39m"),
        StyleClass::Hue,
    ),
];

const fn code(open: &'static str, close: &'static str) -> StyleCode {
    StyleCode { open, close }
}

fn entry(name: StyleName) -> &'static (StyleName, &'static str, StyleCode, StyleClass) {
    STYLE_TABLE
        .iter()
        .find(|e| e.0 == name)
        .expect("every StyleName is in STYLE_TABLE")
}

impl StyleName {
    pub fn code(self) -> StyleCode {
        entry(self).2
    }
    pub fn class(self) -> StyleClass {
        entry(self).3
    }
    pub fn as_str(self) -> &'static str {
        entry(self).1
    }
}

/// The committed table as `__parity style-table` prints it: `{name: {open, close, formats}}` in
/// declaration order, where `formats` is `emits_under(name, Formats)` (the colour axis reads both).
pub fn style_table_json() -> String {
    let mut map = serde_json::Map::new();
    for (style, name, c, _) in STYLE_TABLE {
        map.insert(
            (*name).to_owned(),
            serde_json::json!({
                "open": c.open,
                "close": c.close,
                // `emitsUnder(name, "formats")` — the colour axis's G3 `formats` arm.
                "formats": emits_under(*style, SgrMode::Formats),
            }),
        );
    }
    serde_json::Value::Object(map).to_string()
}

/// Whether one committed style emits at all under one mode.
pub fn emits_under(name: StyleName, sgr: SgrMode) -> bool {
    match sgr {
        SgrMode::None => false,
        SgrMode::Full => true,
        SgrMode::Formats => name.class() != StyleClass::Hue,
    }
}

/// One link in a style chain, built as `chalk`'s `createStyler` builds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Styler {
    pub name: StyleName,
    pub open: &'static str,
    pub close: &'static str,
    pub open_all: String,
    pub close_all: String,
    pub parent: Option<Rc<Styler>>,
}

/// `createStyler(name, parent)`.
pub fn create_styler(name: StyleName, parent: Option<Rc<Styler>>) -> Rc<Styler> {
    let c = name.code();
    let (open_all, close_all) = match &parent {
        None => (c.open.to_owned(), c.close.to_owned()),
        Some(p) => (
            format!("{}{}", p.open_all, c.open),
            format!("{}{}", c.close, p.close_all),
        ),
    };
    Rc::new(Styler {
        name,
        open: c.open,
        close: c.close,
        open_all,
        close_all,
        parent,
    })
}

/// Build a chain from names, outermost first.
pub fn chain(names: &[StyleName]) -> Option<Rc<Styler>> {
    let mut built = None;
    for &name in names {
        built = Some(create_styler(name, built));
    }
    built
}

/// The chain a mode actually emits (`None`: emits nothing).
fn filter_chain(chain_in: &Rc<Styler>, sgr: SgrMode) -> Option<Rc<Styler>> {
    match sgr {
        SgrMode::None => None,
        SgrMode::Full => Some(Rc::clone(chain_in)),
        SgrMode::Formats => {
            let mut names = Vec::new();
            let mut link = Some(chain_in);
            while let Some(l) = link {
                names.push(l.name);
                link = l.parent.as_ref();
            }
            names.reverse();
            let kept: Vec<StyleName> = names.into_iter().filter(|&n| emits_under(n, sgr)).collect();
            chain(&kept)
        }
    }
}

/// `chalk`'s `stringReplaceAll`: re-emit the substring *and* the replacer after it.
fn string_replace_all(string: &str, substring: &str, replacer: &str) -> String {
    let Some(mut index) = string.find(substring) else {
        return string.to_owned();
    };
    let mut end = 0;
    let mut out = String::new();
    loop {
        out.push_str(&string[end..index]);
        out.push_str(substring);
        out.push_str(replacer);
        end = index + substring.len();
        match string[end..].find(substring) {
            Some(next) => index = end + next,
            None => break,
        }
    }
    out.push_str(&string[end..]);
    out
}

/// `chalk`'s `stringEncaseCRLFWithFirstIndex`.
fn string_encase_crlf_with_first_index(
    string: &str,
    prefix: &str,
    postfix: &str,
    first: usize,
) -> String {
    let bytes = string.as_bytes();
    let mut index = first;
    let mut end = 0;
    let mut out = String::new();
    loop {
        let got_cr = index > 0 && bytes[index - 1] == b'\r';
        out.push_str(&string[end..if got_cr { index - 1 } else { index }]);
        out.push_str(prefix);
        out.push_str(if got_cr { "\r\n" } else { "\n" });
        out.push_str(postfix);
        end = index + 1;
        match string[end..].find('\n') {
            Some(next) => index = end + next,
            None => break,
        }
    }
    out.push_str(&string[end..]);
    out
}

/// Apply a style chain, reproducing `chalk`'s `applyStyle` exactly, over the filtered chain.
pub fn apply_style(sgr: SgrMode, chain_in: &Rc<Styler>, input: &str) -> String {
    if sgr == SgrMode::None || input.is_empty() {
        return input.to_owned();
    }
    let Some(filtered) = filter_chain(chain_in, sgr) else {
        return input.to_owned();
    };
    let mut string = input.to_owned();
    if string.contains('\u{1b}') {
        let mut styler = Some(&filtered);
        while let Some(s) = styler {
            string = string_replace_all(&string, s.close, s.open);
            styler = s.parent.as_ref();
        }
    }
    if let Some(lf) = string.find('\n') {
        string = string_encase_crlf_with_first_index(
            &string,
            &filtered.close_all,
            &filtered.open_all,
            lf,
        );
    }
    format!("{}{string}{}", filtered.open_all, filtered.close_all)
}

/// `applyStyleChain`: fold names into a chain, then `apply_style`.
pub fn apply_style_chain(sgr: SgrMode, styles: &[StyleName], input: &str) -> String {
    match chain(styles) {
        None => input.to_owned(),
        Some(c) => apply_style(sgr, &c, input),
    }
}

/// The plain wrap: open, text, close. No empty-string guard, on purpose.
pub fn style_span(sgr: SgrMode, chain_in: &Rc<Styler>, input: &str) -> String {
    if sgr == SgrMode::None {
        return input.to_owned();
    }
    match filter_chain(chain_in, sgr) {
        None => input.to_owned(),
        Some(f) => format!("{}{input}{}", f.open_all, f.close_all),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use StyleName::*;

    const E: &str = "\u{1b}";

    #[test]
    fn the_table_is_base_palette_only() {
        for (_, name, c, class) in STYLE_TABLE {
            for seq in [c.open, c.close] {
                let params = seq
                    .strip_prefix("\u{1b}[")
                    .and_then(|s| s.strip_suffix('m'))
                    .expect(name);
                let p: u32 = params.parse().expect(name);
                assert!(p != 38 && p != 48, "{name}");
                if *class == StyleClass::Hue && seq == c.open {
                    assert!((30..=37).contains(&p) || (90..=97).contains(&p), "{name}");
                }
            }
        }
        assert_eq!(STYLE_TABLE.len(), 13);
    }

    #[test]
    fn emits_under_is_the_mode_rule() {
        assert!(!emits_under(Bold, SgrMode::None));
        assert!(emits_under(Red, SgrMode::Full));
        assert!(!emits_under(Red, SgrMode::Formats));
        assert!(emits_under(Dim, SgrMode::Formats));
        assert!(emits_under(Reset, SgrMode::Formats));
    }

    #[test]
    fn chains_accumulate_like_chalk() {
        let c = chain(&[Dim, Gray, Strikethrough]).unwrap();
        assert_eq!(c.open_all, format!("{E}[2m{E}[90m{E}[9m"));
        assert_eq!(c.close_all, format!("{E}[29m{E}[39m{E}[22m"));
    }

    #[test]
    fn apply_style_reopens_after_a_nested_close() {
        let blue = chain(&[Blue]).unwrap();
        let inner = format!("{E}[34m{E}[4mhref{E}[24m{E}[39m");
        assert_eq!(
            apply_style(SgrMode::Full, &blue, &inner),
            format!("{E}[34m{E}[34m{E}[4mhref{E}[24m{E}[39m{E}[34m{E}[39m")
        );
    }

    #[test]
    fn apply_style_encases_line_breaks() {
        let bold = chain(&[Bold]).unwrap();
        assert_eq!(
            apply_style(SgrMode::Full, &bold, "a\nb"),
            format!("{E}[1ma{E}[22m\n{E}[1mb{E}[22m")
        );
        assert_eq!(
            apply_style(SgrMode::Full, &bold, "a\r\nb"),
            format!("{E}[1ma{E}[22m\r\n{E}[1mb{E}[22m")
        );
        assert_eq!(
            apply_style(SgrMode::Full, &bold, "\nb"),
            format!("{E}[1m{E}[22m\n{E}[1mb{E}[22m")
        );
    }

    #[test]
    fn apply_style_guards_and_filters() {
        let bold = chain(&[Bold]).unwrap();
        assert_eq!(apply_style(SgrMode::Full, &bold, ""), "");
        assert_eq!(apply_style(SgrMode::None, &bold, "x"), "x");
        let cyan = chain(&[Cyan]).unwrap();
        assert_eq!(apply_style(SgrMode::Formats, &cyan, "x"), "x");
        assert_eq!(
            apply_style_chain(SgrMode::Formats, &[Cyan, Underline], "x"),
            format!("{E}[4mx{E}[24m")
        );
        assert_eq!(apply_style_chain(SgrMode::Full, &[], "x"), "x");
        // Under formats the encasing re-opens only the surviving links.
        let yb = chain(&[Yellow, Bold]).unwrap();
        assert_eq!(
            apply_style(SgrMode::Formats, &yb, "a\nb"),
            format!("{E}[1ma{E}[22m\n{E}[1mb{E}[22m")
        );
    }

    #[test]
    fn style_span_is_a_plain_wrap_with_no_empty_guard() {
        let dim = chain(&[Dim]).unwrap();
        assert_eq!(
            style_span(SgrMode::Full, &dim, ""),
            format!("{E}[2m{E}[22m")
        );
        assert_eq!(
            style_span(SgrMode::Formats, &dim, "a\nb"),
            format!("{E}[2ma\nb{E}[22m")
        );
        assert_eq!(style_span(SgrMode::None, &dim, "a"), "a");
        assert_eq!(
            style_span(SgrMode::Formats, &chain(&[Gray]).unwrap(), "a"),
            "a"
        );
    }

    #[test]
    fn style_table_json_has_declaration_order() {
        let j = style_table_json();
        assert!(j.starts_with("{\"reset\":{\"open\":\"\\u001b[0m\""), "{j}");
        assert!(j.find("\"gray\"").unwrap() > j.find("\"cyan\"").unwrap());
    }
}
