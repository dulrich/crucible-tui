//! Where a `[[slug]]` points — vault-root discovery, the lazy file index, D2's resolution
//! order and the `file://` URI — ported from `src/wikiresolve.ts` (WP-8 of
//! `plans/mdview-rust-port.md`; no other WP names this module, and `cli.rs` is its only
//! builder, as `src/cli.ts` is in TS).
//!
//! Pure over an injected [`WikiFs`], so tests build trees in memory and the renderer reads no
//! filesystem (D6). Paths are JS-style strings joined with Node's posix `join` semantics.
//! The tiebreak compares **UTF-16 code units** (`a < b` in JS, `wikiresolve.ts:228-232`), not
//! Rust's byte/scalar order — the two disagree above the BMP against U+E000..U+FFFF.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// `WikiEntry`: one listing entry, `rel_path` joined with `/`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiEntry {
    pub rel_path: String,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

/// `WikiFs`: the two filesystem questions the resolver asks.
pub trait WikiFs {
    fn exists(&self, path: &str) -> bool;
    fn list(&self, root: &str) -> Vec<WikiEntry>;
}

/// Node's `path.posix.normalize`.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut joined = out.join("/");
    if joined.is_empty() && !absolute {
        joined.push('.');
    }
    if trailing && !joined.is_empty() && !(absolute && out.is_empty()) {
        joined.push('/');
    }
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Node's `path.posix.join(a, b)`.
pub fn join(a: &str, b: &str) -> String {
    let parts: Vec<&str> = [a, b].into_iter().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return ".".into();
    }
    normalize(&parts.join("/"))
}

/// Node's `path.posix.dirname`.
pub fn dirname(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        None => ".".into(),
        Some(i) => {
            let head = trimmed[..i].trim_end_matches('/');
            if head.is_empty() {
                "/".into()
            } else {
                head.into()
            }
        }
    }
}

/// Node's `path.resolve(path)` against `cwd` (trailing slash dropped).
pub fn resolve(cwd: &str, path: &str) -> String {
    let joined = if path.starts_with('/') {
        normalize(path)
    } else {
        normalize(&format!("{cwd}/{path}"))
    };
    if joined.len() > 1 {
        joined.trim_end_matches('/').to_owned()
    } else {
        joined
    }
}

fn is_excluded_dir_name(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

/// The real filesystem: `existsSync` and the stack-ordered recursive listing.
#[derive(Debug, Clone, Copy, Default)]
pub struct RealFs;

impl WikiFs for RealFs {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn list(&self, root: &str) -> Vec<WikiEntry> {
        let mut entries = Vec::new();
        let mut stack: Vec<Vec<String>> = vec![Vec::new()];
        while let Some(segments) = stack.pop() {
            let absolute_dir = if segments.is_empty() {
                root.to_owned()
            } else {
                join(root, &segments.join("/"))
            };
            let Ok(dirents) = std::fs::read_dir(&absolute_dir) else {
                continue;
            };
            for dirent in dirents.flatten() {
                let name = dirent.file_name().to_string_lossy().into_owned();
                let Ok(ft) = dirent.file_type() else { continue };
                let is_symbolic_link = ft.is_symlink();
                let is_directory = if is_symbolic_link {
                    std::fs::metadata(dirent.path()).is_ok_and(|m| m.is_dir())
                } else {
                    ft.is_dir()
                };
                let mut child = segments.clone();
                child.push(name.clone());
                entries.push(WikiEntry {
                    rel_path: child.join("/"),
                    is_directory,
                    is_symbolic_link,
                });
                if is_directory && !is_symbolic_link && !is_excluded_dir_name(&name) {
                    stack.push(child);
                }
            }
        }
        entries
    }
}

/// `findVaultRoot`: nearest ancestor holding `.obsidian` or `.git`, else the file's own dir.
pub fn find_vault_root(file_path: &str, fs: &dyn WikiFs) -> String {
    let start = dirname(file_path);
    let mut dir = start.clone();
    loop {
        if fs.exists(&join(&dir, ".obsidian")) || fs.exists(&join(&dir, ".git")) {
            return dir;
        }
        let parent = dirname(&dir);
        if parent == dir {
            return start;
        }
        dir = parent;
    }
}

#[derive(Debug, Default)]
struct SlugTier {
    by_rel_path: HashMap<String, String>,
    by_basename: HashMap<String, Vec<String>>,
}

/// `WikiIndex`.
#[derive(Debug)]
pub struct WikiIndex {
    pub root: String,
    exact: SlugTier,
    case_insensitive: SlugTier,
}

fn last_path_segment(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

/// `buildWikiIndex`.
pub fn build_wiki_index(root: &str, fs: &dyn WikiFs) -> WikiIndex {
    let mut exact = SlugTier::default();
    let mut ci = SlugTier::default();
    for entry in fs.list(root) {
        if entry.is_directory {
            continue;
        }
        let rel = entry.rel_path;
        exact
            .by_rel_path
            .entry(rel.clone())
            .or_insert_with(|| rel.clone());
        ci.by_rel_path
            .entry(rel.to_lowercase())
            .or_insert_with(|| rel.clone());
        let base = last_path_segment(&rel);
        exact
            .by_basename
            .entry(base.to_owned())
            .or_default()
            .push(rel.clone());
        ci.by_basename
            .entry(base.to_lowercase())
            .or_default()
            .push(rel.clone());
    }
    WikiIndex {
        root: root.to_owned(),
        exact,
        case_insensitive: ci,
    }
}

/// JS `a < b`: UTF-16 code-unit order.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `compareCandidates`: fewer path segments, then UTF-16 lexicographic.
fn compare_candidates(a: &str, b: &str) -> std::cmp::Ordering {
    let seg = |s: &str| s.split('/').count();
    seg(a).cmp(&seg(b)).then_with(|| utf16_cmp(a, b))
}

fn resolve_in_tier(tier: &SlugTier, slug: &str, fold: fn(&str) -> String) -> Option<String> {
    for candidate in [fold(slug), fold(&format!("{slug}.md"))] {
        if let Some(hit) = tier.by_rel_path.get(&candidate) {
            return Some(hit.clone());
        }
    }
    let last = last_path_segment(slug);
    let mut seen = HashSet::new();
    let mut matches: Vec<&String> = Vec::new();
    for candidate in [fold(last), fold(&format!("{last}.md"))] {
        if let Some(bucket) = tier.by_basename.get(&candidate) {
            for rel in bucket {
                if seen.insert(rel.as_str()) {
                    matches.push(rel);
                }
            }
        }
    }
    let mut best = *matches.first()?;
    for candidate in &matches[1..] {
        if compare_candidates(candidate, best).is_lt() {
            best = candidate;
        }
    }
    Some(best.clone())
}

/// `resolveWikiSlug`: absolute and `..`-carrying slugs never resolve.
pub fn resolve_wiki_slug(index: &WikiIndex, raw_slug: &str) -> Option<String> {
    let slug = crate::text::js_trim(raw_slug);
    if slug.is_empty() || slug.starts_with('/') || slug.split('/').any(|s| s == "..") {
        return None;
    }
    resolve_in_tier(&index.exact, slug, str::to_owned)
        .or_else(|| resolve_in_tier(&index.case_insensitive, slug, str::to_lowercase))
        .map(|rel| join(&index.root, &rel))
}

fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~') {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

/// `fileUri(absPath, fragment)`.
pub fn file_uri(abs_path: &str, fragment: Option<&str>) -> String {
    let encoded: Vec<String> = abs_path.split('/').map(percent_encode).collect();
    let base = format!("file://{}", encoded.join("/"));
    match fragment {
        None => base,
        Some(f) => format!("{base}#{}", percent_encode(f)),
    }
}

/// `createWikiLinkResolver`: the root is found and the index built on the first call.
pub struct WikiLinkResolver<F: WikiFs> {
    file_path: String,
    fs: F,
    index: RefCell<Option<WikiIndex>>,
}

impl<F: WikiFs> WikiLinkResolver<F> {
    pub fn new(file_path: &str, fs: F) -> Self {
        WikiLinkResolver {
            file_path: file_path.to_owned(),
            fs,
            index: RefCell::new(None),
        }
    }

    pub fn resolve(&self, slug: &str, fragment: Option<&str>) -> Option<String> {
        let mut index = self.index.borrow_mut();
        let index = index.get_or_insert_with(|| {
            let root = find_vault_root(&self.file_path, &self.fs);
            build_wiki_index(&root, &self.fs)
        });
        resolve_wiki_slug(index, slug).map(|abs| file_uri(&abs, fragment))
    }
}

impl<F: WikiFs + 'static> WikiLinkResolver<F> {
    /// The `LayoutContext` shape (`context::WikiLinkResolver`), for WP-6's wiring.
    pub fn into_context(self) -> crate::context::WikiLinkResolver {
        std::rc::Rc::new(move |slug: &str, fragment: Option<&str>| self.resolve(slug, fragment))
    }
}

/// `createWikiLinkResolver(filePath)` over the real filesystem.
pub fn create_wiki_link_resolver(file_path: &str) -> WikiLinkResolver<RealFs> {
    WikiLinkResolver::new(file_path, RealFs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct MemFs {
        markers: Vec<&'static str>,
        files: Vec<&'static str>,
        lists: Cell<usize>,
    }

    impl WikiFs for MemFs {
        fn exists(&self, path: &str) -> bool {
            self.markers.contains(&path)
        }
        fn list(&self, _root: &str) -> Vec<WikiEntry> {
            self.lists.set(self.lists.get() + 1);
            self.files
                .iter()
                .map(|f| WikiEntry {
                    rel_path: (*f).into(),
                    is_directory: f.ends_with('/'),
                    is_symbolic_link: false,
                })
                .collect()
        }
    }

    fn mem(markers: Vec<&'static str>, files: Vec<&'static str>) -> MemFs {
        MemFs {
            markers,
            files,
            lists: Cell::new(0),
        }
    }

    #[test]
    fn posix_path_helpers_match_node() {
        assert_eq!(dirname("/a/b"), "/a");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("/"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(join("/v", "src/../y.md"), "/v/y.md");
        assert_eq!(join("/", ".git"), "/.git");
        assert_eq!(normalize("a/../.."), "..");
        assert_eq!(resolve("/cwd", "docs/../n.md"), "/cwd/n.md");
        assert_eq!(resolve("/cwd", "/abs/dir/"), "/abs/dir");
    }

    #[test]
    fn vault_root_is_nearest_marker_else_own_dir() {
        let fs = mem(vec!["/v/.obsidian"], vec![]);
        assert_eq!(find_vault_root("/v/a/b/n.md", &fs), "/v");
        let fs = mem(vec!["/v/a/.git", "/v/.obsidian"], vec![]);
        assert_eq!(find_vault_root("/v/a/b/n.md", &fs), "/v/a");
        let fs = mem(vec![], vec![]);
        assert_eq!(find_vault_root("/v/a/n.md", &fs), "/v/a");
    }

    #[test]
    fn resolution_order_exact_path_then_basename_then_case_insensitive() {
        let fs = mem(
            vec!["/v/.git"],
            vec![
                "dir/",
                "src/note.md",
                "tests/c/note.md",
                "note",
                "Up.md",
                "docs/Mixed.md",
            ],
        );
        let idx = build_wiki_index("/v", &fs);
        assert_eq!(
            resolve_wiki_slug(&idx, "src/note").as_deref(),
            Some("/v/src/note.md")
        );
        assert_eq!(resolve_wiki_slug(&idx, "note").as_deref(), Some("/v/note"));
        assert_eq!(
            resolve_wiki_slug(&idx, "c/note").as_deref(),
            Some("/v/note")
        );
        assert_eq!(
            resolve_wiki_slug(&idx, "tests/note.md").as_deref(),
            Some("/v/src/note.md")
        );
        assert_eq!(resolve_wiki_slug(&idx, " up ").as_deref(), Some("/v/Up.md"));
        assert_eq!(
            resolve_wiki_slug(&idx, "MIXED").as_deref(),
            Some("/v/docs/Mixed.md")
        );
        assert_eq!(resolve_wiki_slug(&idx, "dir"), None);
        for bad in ["", "/etc/passwd", "../note", "a/../note", "missing"] {
            assert_eq!(resolve_wiki_slug(&idx, bad), None, "{bad}");
        }
    }

    #[test]
    fn tiebreak_is_fewest_segments_then_utf16_order() {
        // U+FF5E sorts *after* U+1F600 by scalar value but *before* it in UTF-16 (D83D...).
        let fs = mem(
            vec![],
            vec!["z/\u{1F600}/t.md", "z/\u{FF5E}/t.md", "docs/r/s/t.md"],
        );
        let idx = build_wiki_index("/v", &fs);
        assert_eq!(
            resolve_wiki_slug(&idx, "t").as_deref(),
            Some("/v/z/\u{1F600}/t.md")
        );
        assert_eq!(
            utf16_cmp("\u{FF5E}", "\u{1F600}"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn file_uri_percent_encodes_per_segment_and_fragment() {
        assert_eq!(
            file_uri("/v/a b/é.md", Some("Sec #1")),
            "file:///v/a%20b/%C3%A9.md#Sec%20%231"
        );
        assert_eq!(file_uri("/v/x~_-.md", None), "file:///v/x~_-.md");
    }

    #[test]
    fn resolver_is_lazy_and_indexes_once() {
        let r = WikiLinkResolver::new("/v/n.md", mem(vec!["/v/.obsidian"], vec!["t.md"]));
        assert_eq!(r.fs.lists.get(), 0);
        assert_eq!(
            r.resolve("t", Some("h")).as_deref(),
            Some("file:///v/t.md#h")
        );
        assert_eq!(r.resolve("u", None), None);
        assert_eq!(r.fs.lists.get(), 1);
    }

    #[test]
    fn real_fs_lists_and_skips_dot_and_node_modules() {
        let root = std::env::temp_dir().join(format!("mdview-wiki-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["src", ".hidden", "node_modules"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        for f in ["src/n.md", ".hidden/h.md", "node_modules/m.md", "top.md"] {
            std::fs::write(root.join(f), "").unwrap();
        }
        let mut rels: Vec<String> = RealFs
            .list(root.to_str().unwrap())
            .into_iter()
            .map(|e| e.rel_path)
            .collect();
        rels.sort();
        assert_eq!(
            rels,
            vec![".hidden", "node_modules", "src", "src/n.md", "top.md"]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
