//! GFM extended autolinks (url, `www.`, email), as marked's `url` tokenizer finds them.

use super::*;

/// A GFM extended autolink token (url, `www.` or email), as marked's `url` tokenizer builds it.
pub(super) fn autolink_token(raw: &str) -> Token {
    let text = escape_no_encode(raw);
    let href = if raw.starts_with("www.") {
        format!("http://{raw}")
    } else if raw.contains('@')
        && !raw.contains("://")
        && !raw.starts_with("mailto:")
        && !raw.starts_with("xmpp:")
    {
        format!("mailto:{text}")
    } else {
        raw.to_string()
    };
    Token::Link {
        href,
        text: text.clone(),
        tokens: vec![Token::Text {
            raw: text.clone(),
            text,
            tokens: None,
        }],
    }
}

/// comrak's `ctype::isspace`.
pub(super) fn c_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// comrak's `is_valid_hostchar` (not whitespace, punctuation or symbol). comrak asks
/// `finl_unicode`'s general categories; this crate does not depend on it, so outside ASCII
/// the punctuation/symbol blocks are listed instead (Latin-1, General Punctuation through
/// the symbol blocks, CJK and fullwidth punctuation). Where it could differ is only where a
/// domain ends, which decides nothing but the underscore check.
pub(super) fn host_char(c: char) -> bool {
    if c.is_whitespace() {
        return false;
    }
    if c.is_ascii() {
        return !c.is_ascii_punctuation();
    }
    !matches!(c as u32, 0xA1..=0xBF | 0xD7 | 0xF7 | 0x2010..=0x2BFF | 0x3000..=0x303F
        | 0xFF01..=0xFF0F | 0xFF1A..=0xFF20 | 0xFF3B..=0xFF40 | 0xFF5B..=0xFF65)
}

/// comrak 0.56's `check_domain` over `scan_domain`.
pub(super) fn gfm_domain(d: &str, allow_short: bool) -> Option<usize> {
    let (mut end, mut dots, mut us, mut prev_us) = (0, 0, 0, 0);
    for (i, c) in d.char_indices() {
        match c {
            '\\' if i + 1 < d.len() => {}
            '_' => us += 1,
            '.' => {
                prev_us = us;
                us = 0;
                dots += 1;
            }
            c if host_char(c) || c == '-' => {}
            _ => {
                end = i;
                break;
            }
        }
        end = i + c.len_utf8();
    }
    if dots > 10 {
        return Some(end);
    }
    if us > 0 || prev_us > 0 {
        return None;
    }
    (allow_short || dots > 0).then_some(end)
}

/// comrak 0.56's non-relaxed `autolink_delim`, less its U+2069 trim
/// (marked keeps that character; see `inline_seq`).
pub(super) fn gfm_delim(d: &[u8], mut end: usize) -> usize {
    let (mut open, mut close) = (0, 0);
    for (i, &c) in d.iter().enumerate().take(end) {
        match c {
            b'<' => {
                end = i;
                break;
            }
            b'(' => open += 1,
            b')' => close += 1,
            _ => {}
        }
    }
    while end > 0 {
        let c = d[end - 1];
        if b"?!.,:*_~'\"".contains(&c) {
            end -= 1;
        } else if c == b';' {
            let mut n = end.saturating_sub(2);
            while n > 0 && d[n].is_ascii_alphabetic() {
                n -= 1;
            }
            if n + 2 < end && d[n] == b'&' {
                end = n;
            } else {
                end -= 1;
            }
        } else if c == b')' {
            if close <= open {
                break;
            }
            close -= 1;
            end -= 1;
        } else {
            break;
        }
    }
    end
}

/// comrak's `url_match` at the `:` at `i` of `t`, not rewinding before `lo` nor reading past
/// `hi`: the range of the link in `t`.
pub(super) fn gfm_url(t: &str, lo: usize, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    if hi - i < 4 || b[i + 1] != b'/' || b[i + 2] != b'/' {
        return None;
    }
    let mut r = 0;
    while r < i - lo && b[i - r - 1].is_ascii_alphabetic() {
        r += 1;
    }
    let scheme = &t[i - r..i];
    if !["http", "https", "ftp"]
        .iter()
        .any(|s| scheme.eq_ignore_ascii_case(s))
    {
        return None;
    }
    if !t[i + 3..hi].chars().next().is_some_and(host_char) {
        return None;
    }
    let mut end = gfm_domain(&t[i + 3..hi], true)? + 3;
    while i + end < hi && !c_space(b[i + end]) {
        end += 1;
    }
    let end = gfm_delim(&b[i..hi], end);
    Some((i - r, i + end))
}

/// comrak's `www_match` at `i` of `t`, not reading past `hi`.
pub(super) fn gfm_www(t: &str, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    if i > 0 && !c_space(b[i - 1]) && !b"*_~([".contains(&b[i - 1]) {
        return None;
    }
    if !t[i..hi].starts_with("www.") {
        return None;
    }
    let mut end = gfm_domain(&t[i + 4..hi], false)? + 4;
    while i + end < hi && !c_space(b[i + end]) {
        end += 1;
    }
    let end = gfm_delim(&b[i..hi], end);
    (end > 0).then_some((i, i + end))
}

/// comrak's `email_match` at the `@` at `i` of `t` (no `mailto:`/`xmpp:` prefix), not
/// rewinding before `lo` nor reading past `hi`, with GFM's own last-character rule (not `-`
/// or `_`) in place of comrak's alphabetic-only one.
pub(super) fn gfm_email(t: &str, lo: usize, i: usize, hi: usize) -> Option<(usize, usize)> {
    let b = t.as_bytes();
    let ok = |c: u8| c.is_ascii_alphanumeric() || b".+-_".contains(&c);
    let mut r = 0;
    while r < i - lo && ok(b[i - r - 1]) {
        r += 1;
    }
    if r == 0 || (i - r > 0 && b[i - r - 1] == b':') {
        return None;
    }
    let (mut end, mut np) = (1, 0);
    while end < hi - i {
        let c = b[i + end];
        if c == b'@' {
            return None;
        } else if c == b'.' && end + 1 < hi - i && b[i + end + 1].is_ascii_alphanumeric() {
            np += 1;
        } else if !c.is_ascii_alphanumeric() && c != b'-' && c != b'_' {
            break;
        }
        end += 1;
    }
    let last = b[i + end - 1];
    if end < 2 || np == 0 || !(last.is_ascii_alphanumeric() || last == b'.') {
        return None;
    }
    let end = gfm_delim(&b[i..hi], end);
    (end > 0).then_some((i - r, i + end))
}
