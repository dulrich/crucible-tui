//! Indent-style detection and checking (invariant 10 of `plans/jsonedit.md`
//! WP-3). Pure functions over bytes; nothing here ever rewrites a byte.
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

#[cfg(test)]
mod tests {
    use super::*;

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
