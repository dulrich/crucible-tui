//! The wiki-link grammar (`plans/wiki-link-tokenizer.md`; `\n` is excluded per its D2).

/// A matched wiki-link's parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wiki {
    pub slug: String,
    pub fragment: Option<String>,
    pub alias: Option<String>,
    pub embed: bool,
}

/// `^(!)?\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]+))?\]\]` — the match length and
/// its parts. An empty slug never matches (mdview's lexer recognition).
pub fn match_wikilink(s: &str) -> Option<(usize, Wiki)> {
    match_wikilink_with(s, false)
}

/// [`match_wikilink`], plus — when `allow_empty_target` — the fragment-only forms
/// `[[#heading]]`/`[[#^block]]` with an empty slug and a non-empty fragment (`ofm::parse`).
pub fn match_wikilink_with(s: &str, allow_empty_target: bool) -> Option<(usize, Wiki)> {
    let embed = s.starts_with('!');
    let r = s[usize::from(embed)..].strip_prefix("[[")?;
    let slug = r
        .find(|c| [']', '|', '#', '\n'].contains(&c))
        .unwrap_or(r.len());
    let fragment_only = allow_empty_target
        && slug == 0
        && r.starts_with('#')
        && !r[1..].starts_with([']', '|', '\n']);
    if slug == 0 && !fragment_only {
        return None;
    }
    let mut j = slug;
    let mut fragment = None;
    if r[j..].starts_with('#') {
        j += 1;
        let f = r[j..]
            .find(|c| [']', '|', '\n'].contains(&c))
            .unwrap_or(r.len() - j);
        fragment = Some(r[j..j + f].to_string());
        j += f;
    }
    let mut alias = None;
    if r[j..].starts_with('|') {
        let k = r[j + 1..]
            .find(|c| [']', '\n'].contains(&c))
            .unwrap_or(r.len() - j - 1);
        if k == 0 {
            return None;
        }
        alias = Some(r[j + 1..j + 1 + k].to_string());
        j += 1 + k;
    }
    r[j..].starts_with("]]").then(|| {
        let wiki = Wiki {
            slug: r[..slug].to_string(),
            fragment,
            alias,
            embed,
        };
        (usize::from(embed) + 2 + j + 2, wiki)
    })
}
