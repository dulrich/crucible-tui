//! Indent-style detection and checking (invariant 10 of `plans/jsonedit.md`
//! WP-3). Pure functions over bytes; only [`reindent`] produces new bytes,
//! and only when the user picks `(f)ix indentation`.
//!
//! Threshold: a file needs at least [`MIN_INDENTED`] indented, non-blank
//! lines to be judged at all (fewer → [`Detection::TooFew`]: no reference
//! style, no prompt). A style is dominant when at least [`DOMINANCE`] of the
//! indented lines agree with it: all-tab lines for `Tab`; for `Spaces(n)`,
//! all-space lines whose width is a multiple of `n`, where `n` is the
//! narrowest all-space indent in the file. Anything else is
//! [`Detection::Ambiguous`].

/// The reference indent unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Indent {
    Tab,
    Spaces(usize),
}

impl Indent {
    /// Parses an `--indent` value: `tab` or a positive space count.
    pub fn from_name(s: &str) -> Option<Indent> {
        match s {
            "tab" | "t" => Some(Indent::Tab),
            _ => s.parse().ok().filter(|n| *n > 0).map(Indent::Spaces),
        }
    }

    /// Whether `line`'s leading whitespace fits this style.
    pub fn fits(self, line: &str) -> bool {
        let lead: &str = &line[..line.len() - line.trim_start_matches([' ', '\t']).len()];
        if lead.len() == line.len() {
            return true; // blank or whitespace-only: not judged
        }
        match self {
            Indent::Tab => lead.bytes().all(|b| b == b'\t'),
            Indent::Spaces(n) => lead.bytes().all(|b| b == b' ') && lead.len().is_multiple_of(n),
        }
    }
}

impl std::fmt::Display for Indent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Indent::Tab => write!(f, "tabs"),
            Indent::Spaces(n) => write!(f, "{n} spaces"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detection {
    Style(Indent),
    Ambiguous,
    TooFew,
}

/// Fewest indented lines a file needs before its style is judged.
pub const MIN_INDENTED: usize = 3;
/// Share of indented lines (as a fraction) that must agree for dominance.
pub const DOMINANCE: f64 = 0.8;

/// Detects the dominant indent unit of `bytes` (lossy UTF-8 is fine: only
/// leading ASCII whitespace is inspected).
pub fn detect(bytes: &[u8]) -> Detection {
    let text = String::from_utf8_lossy(bytes);
    let (mut tabs, mut spaces, mut total) = (0usize, Vec::new(), 0usize);
    for line in text.lines() {
        let rest = line.trim_start_matches([' ', '\t']);
        let lead = &line[..line.len() - rest.len()];
        if lead.is_empty() || rest.is_empty() {
            continue;
        }
        total += 1;
        if lead.bytes().all(|b| b == b'\t') {
            tabs += 1;
        } else if lead.bytes().all(|b| b == b' ') {
            spaces.push(lead.len());
        }
    }
    if total < MIN_INDENTED {
        return Detection::TooFew;
    }
    let dominant = |n: usize| n as f64 >= DOMINANCE * total as f64;
    if dominant(tabs) {
        return Detection::Style(Indent::Tab);
    }
    if let Some(&unit) = spaces.iter().min()
        && dominant(spaces.iter().filter(|w| w.is_multiple_of(unit)).count())
    {
        return Detection::Style(Indent::Spaces(unit));
    }
    Detection::Ambiguous
}

/// 1-based numbers of lines in `new` that are not lines of `old` (a simple
/// line-set diff) and whose leading whitespace does not fit `style`.
pub fn mismatches(old: &[u8], new: &[u8], style: Indent) -> Vec<usize> {
    let old = String::from_utf8_lossy(old);
    let seen: std::collections::HashSet<&str> = old.lines().collect();
    let new = String::from_utf8_lossy(new);
    new.lines()
        .enumerate()
        .filter(|(_, l)| !seen.contains(l) && !style.fits(l))
        .map(|(i, _)| i + 1)
        .collect()
}

/// The result of [`reindent`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reindented {
    pub bytes: Vec<u8>,
    /// 1-based lines whose leading whitespace was set to the structural indent.
    pub fixed: Vec<usize>,
    /// 1-based lines left untouched: they start inside a comment or string.
    pub unfixable: Vec<usize>,
}

/// Re-indents the 1-based `lines` of `bytes` (already validated) to their
/// structural depth in `style` units. Only the leading spaces/tabs of those
/// lines change; line endings and every other byte are kept. Depth is the
/// count of `[`/`{` open before the line, outside strings (`"` and `'`) and
/// comments (`//`, `/* */`); a line starting with `]`/`}` dedents one level.
/// A line that starts inside a block comment or a string continuation is
/// reported unfixable and left alone.
pub fn reindent(bytes: &[u8], lines: &[usize], style: Indent) -> Reindented {
    #[derive(Clone, Copy, PartialEq)]
    enum St {
        Code,
        Str(u8),
        Line,
        Block,
    }
    let wanted: std::collections::HashSet<usize> = lines.iter().copied().collect();
    let mut out = Reindented {
        bytes: Vec::with_capacity(bytes.len()),
        fixed: Vec::new(),
        unfixable: Vec::new(),
    };
    let (mut st, mut depth, mut esc) = (St::Code, 0usize, false);
    let mut no = 0usize;
    let mut start = 0usize;
    while start < bytes.len() {
        no += 1;
        let end = bytes[start..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(bytes.len(), |i| start + i + 1);
        let line = &bytes[start..end];
        let bom = if no == 1 && line.starts_with(b"\xEF\xBB\xBF") {
            3
        } else {
            0
        };
        if wanted.contains(&no) {
            if matches!(st, St::Code) {
                let body = &line[bom..];
                let ws = body
                    .iter()
                    .take_while(|&&b| b == b' ' || b == b'\t')
                    .count();
                let d = match body.get(ws) {
                    Some(b']' | b'}') => depth.saturating_sub(1),
                    _ => depth,
                };
                out.bytes.extend_from_slice(&line[..bom]);
                match style {
                    Indent::Tab => out.bytes.extend(std::iter::repeat_n(b'\t', d)),
                    Indent::Spaces(n) => out.bytes.extend(std::iter::repeat_n(b' ', d * n)),
                }
                out.bytes.extend_from_slice(&body[ws..]);
                out.fixed.push(no);
            } else {
                out.bytes.extend_from_slice(line);
                out.unfixable.push(no);
            }
        } else {
            out.bytes.extend_from_slice(line);
        }
        // Advance the scanner over this line.
        let mut i = 0;
        while i < line.len() {
            let b = line[i];
            match st {
                St::Code => match b {
                    b'"' | b'\'' => st = St::Str(b),
                    b'/' if line.get(i + 1) == Some(&b'/') => {
                        st = St::Line;
                        i += 1;
                    }
                    b'/' if line.get(i + 1) == Some(&b'*') => {
                        st = St::Block;
                        i += 1;
                    }
                    b'[' | b'{' => depth += 1,
                    b']' | b'}' => depth = depth.saturating_sub(1),
                    _ => {}
                },
                St::Str(q) => {
                    if esc {
                        esc = false;
                    } else if b == b'\\' {
                        esc = true;
                    } else if b == q {
                        st = St::Code;
                    }
                }
                St::Line => {
                    if b == b'\n' {
                        st = St::Code;
                    }
                }
                St::Block => {
                    if b == b'*' && line.get(i + 1) == Some(&b'/') {
                        st = St::Code;
                        i += 1;
                    }
                }
            }
            i += 1;
        }
        start = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::validate::{Dialect, validate};

    /// Re-indents every line of `src` and checks it validates in `dialect`.
    fn fix(src: &str, lines: &[usize], style: Indent, dialect: Dialect) -> Reindented {
        assert!(validate(src.as_bytes(), dialect).is_ok(), "{src:?}");
        let r = reindent(src.as_bytes(), lines, style);
        assert!(validate(&r.bytes, dialect).is_ok(), "{:?}", r.bytes);
        r
    }

    fn text(r: &Reindented) -> &str {
        std::str::from_utf8(&r.bytes).unwrap()
    }

    #[test]
    fn reindent_by_structural_depth() {
        let s2 = Indent::Spaces(2);
        // Nested objects/arrays and closing-bracket dedent.
        let src = "{\n \"a\": {\n\"b\": [\n      1,\n   2\n  ]\n     },\n\t\"c\": 3\n}\n";
        let r = fix(src, &[2, 3, 4, 5, 6, 7, 8], s2, Dialect::Json);
        assert_eq!(
            text(&r),
            "{\n  \"a\": {\n    \"b\": [\n      1,\n      2\n    ]\n  },\n  \"c\": 3\n}\n"
        );
        assert_eq!(r.fixed, vec![2, 3, 4, 5, 6, 7, 8]);
        assert!(r.unfixable.is_empty());
        // Only listed lines change.
        let r = fix(src, &[3], s2, Dialect::Json);
        assert_eq!(text(&r), src.replacen("\n\"b\"", "\n    \"b\"", 1));
        // Tab style; CRLF kept.
        let src = "{\r\n   \"a\": [\r\n 1\r\n]\r\n}\r\n";
        let r = fix(src, &[2, 3, 4], Indent::Tab, Dialect::Json);
        assert_eq!(text(&r), "{\r\n\t\"a\": [\r\n\t\t1\r\n\t]\r\n}\r\n");
        // BOM on line 1 does not break the scan.
        let src = "\u{feff}{\n   \"a\": 1\n}\n";
        let r = fix(src, &[2], s2, Dialect::Json);
        assert_eq!(text(&r), "\u{feff}{\n  \"a\": 1\n}\n");
    }

    #[test]
    fn reindent_skips_strings_and_comments() {
        let s2 = Indent::Spaces(2);
        // Brackets and comment-looking text inside strings; escaped quote and
        // backslash parity.
        let src =
            "{\n \"u\": \"http://x/*[{\",\n \"q\": \"a\\\"[\",\n \"b\": \"\\\\\",\n \"c\": 1\n}\n";
        let r = fix(src, &[2, 3, 4, 5], s2, Dialect::Json);
        assert_eq!(text(&r), src.replace("\n \"", "\n  \""));
        // Brackets inside `//` and `/* */` comments; a line inside a block
        // comment is unfixable and untouched.
        let src = "{\n // [ {\n /* { [\n   still comment ] */\n \"a\": 1\n}\n";
        let r = fix(src, &[2, 3, 4, 5], s2, Dialect::Jsonc);
        assert_eq!(
            text(&r),
            "{\n  // [ {\n  /* { [\n   still comment ] */\n  \"a\": 1\n}\n"
        );
        assert_eq!((r.fixed, r.unfixable), (vec![2, 3, 5], vec![4]));
        // JSON5: single-quoted string with brackets, unquoted and numeric
        // keys, and a line continuation (its contents byte-identical).
        let src = "{\n a: '[{',\n 1: 2,\n s: 'one \\\n   two [',\n b: [\n 3]\n}\n";
        let r = fix(src, &[2, 3, 4, 5, 6, 7], s2, Dialect::Json5);
        assert_eq!(
            text(&r),
            "{\n  a: '[{',\n  1: 2,\n  s: 'one \\\n   two [',\n  b: [\n    3]\n}\n"
        );
        assert_eq!(r.unfixable, vec![5]);
    }

    #[test]
    fn detects_styles() {
        let cases: &[(&str, Detection)] = &[
            (
                "{\n\t\"a\": {\n\t\t\"b\": 1\n\t},\n\t\"c\": 2\n}\n",
                Detection::Style(Indent::Tab),
            ),
            (
                "{\n  \"a\": {\n    \"b\": 1\n  },\n  \"c\": 2\n}\n",
                Detection::Style(Indent::Spaces(2)),
            ),
            (
                "{\n    \"a\": {\n        \"b\": 1\n    },\n    \"c\": 2\n}\n",
                Detection::Style(Indent::Spaces(4)),
            ),
            (
                "{\n\t\"a\": {\n    \"b\": 1\n\t},\n  \"c\": 2\n}\n",
                Detection::Ambiguous,
            ),
            ("{\n  \"a\": 1\n}\n", Detection::TooFew),
            ("{}", Detection::TooFew),
        ];
        for (src, want) in cases {
            assert_eq!(detect(src.as_bytes()), *want, "{src:?}");
        }
    }

    #[test]
    fn flags_only_changed_mismatched_lines() {
        let old = b"{\n  \"a\": 1,\n   \"odd\": 0\n}\n";
        let new = b"{\n  \"a\": 1,\n   \"odd\": 0,\n\t\"b\": 2,\n    \"c\": 3\n}\n";
        // line 3 changed (comma) and is 3 spaces; line 4 is a tab; line 5 fits.
        assert_eq!(mismatches(old, new, Indent::Spaces(2)), vec![3, 4]);
        assert_eq!(Indent::from_name("tab"), Some(Indent::Tab));
        assert_eq!(Indent::from_name("4"), Some(Indent::Spaces(4)));
        assert_eq!(Indent::from_name("0"), None);
    }
}
