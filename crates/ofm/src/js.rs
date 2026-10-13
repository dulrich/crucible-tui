//! ECMAScript whitespace primitives.
//!
//! **JS whitespace is not Rust's.** ECMAScript `\s` and `String.prototype.trim` use
//! WhiteSpace + LineTerminator: that set *includes* U+FEFF and *excludes* U+0085, where
//! Rust's `char::is_whitespace` is the reverse on both. Every port of a TS `trim()`/`\s`
//! goes through [`js_trim`], [`is_js_whitespace`] or [`JS_WS_CLASS`] — never `str::trim`.

/// ECMAScript `\s`, as the body of a `regex`-crate character class: `[` + this + `]`.
pub const JS_WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// ECMAScript `\s` membership (WhiteSpace ∪ LineTerminator).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_trim_includes_bom_and_excludes_nel() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
        assert_eq!(js_trim_start("  a "), "a ");
        assert_eq!(js_trim_end("  a "), "  a");
    }
}
