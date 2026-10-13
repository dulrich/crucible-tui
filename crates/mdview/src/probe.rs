//! The East Asian Ambiguous width probe and its cache, ported from `TS_BASELINE` `src/width.ts`
//! (the measurement half is `width.rs`).
//!
//! - the DSR request `ESC [ 6 n` (`width.ts:494`), the reply grammar and its printable echo;
//! - the screen clean-up `ESC [ <col> G ESC [ K` after the test glyph (`width.ts:610`);
//! - raw-mode restore on every exit path (`width.ts:644-648`) — here a `Drop` guard;
//! - the cache path `$XDG_CACHE_HOME/mdview/ambiguous-width.json` (`width.ts:218`) and the
//!   over-specified terminal identity key (`width.ts:280`);
//! - the resolution order: `MDVIEW_AMBIGUOUS` → cache → live probe → narrow.
//!
//! The terminal is behind [`ProbeTerminal`] so the logic is testable without a TTY;
//! [`RealTerminal`] drives fds 0/1 through rustix termios. Raw mode mirrors libuv's
//! `UV_TTY_MODE_RAW` (rustix `make_raw`, with output post-processing left on), and reads
//! poll with `VMIN=0, VTIME=1`.
//!
//! **Deviation, recorded:** TS also installs SIGINT/SIGTERM/SIGHUP handlers that restore the
//! mode and exit 130/143/129. Raw mode clears `ISIG`, so Ctrl-C arrives as a `0x03` byte the
//! reader already aborts on; SIGTERM/SIGHUP during the ≤400 ms probe are not trapped here.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{Map, Value};

use crate::colour::Env;
use crate::width::{Ambiguous, Measure, NARROW_MEASURE, measure_for, parse_ambiguous_width};

/// The test glyph: EM DASH, East Asian Ambiguous.
pub const PROBE_GLYPH: &str = "—";
/// Per-query timeout.
pub const PROBE_TIMEOUT_MS: u64 = 200;
const CACHE_VERSION: i64 = 1;

/// `path.join` + `path.normalize` (POSIX): collapse `.`/`..`/duplicate separators.
fn node_join(parts: &[&str]) -> PathBuf {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    let absolute = joined.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for c in Path::new(&joined).components() {
        match c {
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
            Component::ParentDir => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            Component::Normal(s) => out.push(s.to_str().unwrap_or("")),
        }
    }
    let body = out.join("/");
    PathBuf::from(match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".to_owned(),
        (false, false) => body,
    })
}

fn home_dir() -> String {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// `resolveAmbiguousCachePath(env)`; like TS, `homedir()` reads the process, not `env`.
pub fn resolve_ambiguous_cache_path(env: &Env) -> PathBuf {
    let cache_home = match env.get("XDG_CACHE_HOME") {
        Some(x) if !x.is_empty() => x.clone(),
        _ => node_join(&[&home_dir(), ".cache"])
            .to_string_lossy()
            .into_owned(),
    };
    node_join(&[&cache_home, "mdview", "ambiguous-width.json"])
}

fn get<'a>(env: &'a Env, k: &str) -> Option<&'a str> {
    env.get(k).map(String::as_str)
}
fn truthy<'a>(env: &'a Env, k: &str) -> Option<&'a str> {
    get(env, k).filter(|v| !v.is_empty())
}

fn detect_multiplexer(env: &Env) -> &'static str {
    let term = get(env, "TERM").unwrap_or("");
    if truthy(env, "STY").is_some() && term.starts_with("screen") {
        return "screen";
    }
    if truthy(env, "TMUX").is_some() {
        return "tmux";
    }
    if truthy(env, "ZELLIJ").is_some() || truthy(env, "ZELLIJ_SESSION_NAME").is_some() {
        return "zellij";
    }
    if truthy(env, "STY").is_some() {
        return "screen";
    }
    "none"
}

/// `terminalIdentity(env)`: the over-specified cache key.
pub fn terminal_identity(env: &Env) -> String {
    let locale = truthy(env, "LC_ALL")
        .or_else(|| truthy(env, "LC_CTYPE"))
        .or_else(|| truthy(env, "LANG"))
        .unwrap_or("");
    [
        format!("term={}", get(env, "TERM").unwrap_or("")),
        format!("program={}", get(env, "TERM_PROGRAM").unwrap_or("")),
        format!("colorterm={}", get(env, "COLORTERM").unwrap_or("")),
        format!("vte={}", get(env, "VTE_VERSION").unwrap_or("")),
        format!("mux={}", detect_multiplexer(env)),
        format!("locale={locale}"),
    ]
    .join("|")
}

/// A cached answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedAnswer {
    pub ambiguous: Ambiguous,
    pub probed_at: String,
}

fn ambiguous_str(a: Ambiguous) -> &'static str {
    match a {
        Ambiguous::Narrow => "narrow",
        Ambiguous::Wide => "wide",
    }
}

/// `readCachedAmbiguousWidth`: any failure is a miss.
pub fn read_cached_ambiguous_width(identity: &str, path: &Path) -> Option<CachedAnswer> {
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    let file = parsed.as_object()?;
    if file.get("version").and_then(Value::as_f64) != Some(CACHE_VERSION as f64) {
        return None;
    }
    let entry = file
        .get("entries")?
        .as_object()?
        .get(identity)?
        .as_object()?;
    let ambiguous = parse_ambiguous_width(entry.get("ambiguous").and_then(Value::as_str))?;
    let probed_at = entry
        .get("probedAt")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    Some(CachedAnswer {
        ambiguous,
        probed_at,
    })
}

/// `new Date().toISOString()`.
pub fn iso_now() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_millis(ms)
}

fn iso_from_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// `writeCachedAmbiguousWidth`: merge one entry, write atomically; `false` on any I/O failure.
pub fn write_cached_ambiguous_width(identity: &str, ambiguous: Ambiguous, path: &Path) -> bool {
    let mut entries = Map::new();
    if let Ok(raw) = std::fs::read_to_string(path)
        && let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&raw)
        && parsed.get("version").and_then(Value::as_f64) == Some(CACHE_VERSION as f64)
        && let Some(Value::Object(existing)) = parsed.get("entries")
    {
        entries = existing.clone();
    }
    entries.insert(
        identity.to_owned(),
        serde_json::json!({ "ambiguous": ambiguous_str(ambiguous), "probedAt": iso_now() }),
    );
    let mut file = Map::new();
    file.insert("version".to_owned(), Value::from(CACHE_VERSION));
    file.insert("entries".to_owned(), Value::Object(entries));
    let Ok(text) = serde_json::to_string_pretty(&Value::Object(file)) else {
        return false;
    };
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let attempt = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let temp = dir.join(format!(
            ".ambiguous-width.json.tmp-{}-{stamp}",
            std::process::id()
        ));
        std::fs::write(&temp, format!("{text}\n"))?;
        std::fs::rename(&temp, path)
    };
    attempt().is_ok()
}

/// One probe's full report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeReport {
    pub ambiguous: Option<Ambiguous>,
    pub detail: String,
    pub reply: Option<String>,
    pub columns: Option<(u32, u32)>,
    pub glyph_columns: Option<i64>,
    pub elapsed_ms: u64,
}

/// The terminal a probe talks to.
pub trait ProbeTerminal {
    fn stdin_is_tty(&self) -> bool;
    fn stdout_is_tty(&self) -> bool;
    /// Whether stdin has a raw mode at all.
    fn supports_raw(&self) -> bool {
        true
    }
    /// `true`: enter raw mode; `false`: restore the mode found on entry.
    fn set_raw(&mut self, raw: bool) -> Result<(), String>;
    /// The next bytes available before `deadline`, or `None` on timeout.
    fn read_chunk(&mut self, deadline: Instant) -> Option<Vec<u8>>;
    fn write(&mut self, text: &str);
    fn columns(&self) -> Option<u32>;
}

static DSR_REPLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[([0-9]+);([0-9]+)R").expect("DSR regex"));

/// The reply made safe to print: ESC as `\e`, other C0 controls as `\xNN`.
pub fn printable(reply: &str) -> String {
    let mut out = String::new();
    for c in reply.chars() {
        match c {
            '\u{1b}' => out.push_str("\\e"),
            '\u{0}'..='\u{1f}' => out.push_str(&format!("\\x{:02x}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

struct Cursor {
    row: u32,
    column: u32,
    raw: String,
}

fn query_cursor(term: &mut dyn ProbeTerminal, timeout: Duration) -> Option<Cursor> {
    let deadline = Instant::now() + timeout;
    term.write("\u{1b}[6n");
    let mut buffered = String::new();
    loop {
        let chunk = term.read_chunk(deadline)?;
        // latin1, as `Buffer.toString("latin1")`.
        buffered.extend(chunk.iter().map(|&b| char::from(b)));
        if buffered.contains('\u{3}') {
            return None;
        }
        if let Some(m) = DSR_REPLY.captures(&buffered) {
            let num = |i: usize| {
                m.get(i)
                    .and_then(|g| g.as_str().parse::<f64>().ok())
                    .unwrap_or(f64::NAN)
            };
            return Some(Cursor {
                row: num(1) as u32,
                column: num(2) as u32,
                raw: buffered.clone(),
            });
        }
        if Instant::now() >= deadline {
            return None;
        }
    }
}

/// `probeAmbiguousWidth`: write the glyph between two cursor queries and read the difference.
pub fn probe_ambiguous_width(term: &mut dyn ProbeTerminal, timeout_ms: u64) -> ProbeReport {
    let started = Instant::now();
    let elapsed = |s: Instant| s.elapsed().as_millis() as u64;
    let fail = |detail: String, reply: Option<String>| ProbeReport {
        ambiguous: None,
        detail,
        reply,
        columns: None,
        glyph_columns: None,
        elapsed_ms: elapsed(started),
    };
    let (i, o) = (term.stdin_is_tty(), term.stdout_is_tty());
    if !i || !o {
        let is = |t: bool| if t { "a TTY" } else { "not a TTY" };
        return fail(
            format!(
                "not probing: stdin is {} and stdout is {} — a DSR probe needs both",
                is(i),
                is(o)
            ),
            None,
        );
    }
    if !term.supports_raw() {
        return fail(
            "not probing: this stdin has no raw mode, so a DSR reply could not be read back".into(),
            None,
        );
    }
    let timeout = Duration::from_millis(timeout_ms);
    let result = (|| -> Result<(Cursor, Cursor), (String, Option<String>)> {
        term.set_raw(true)
            .map_err(|e| (format!("probe failed: {e}"), None))?;
        let Some(before) = query_cursor(term, timeout) else {
            return Err((
                format!("no DSR reply within {timeout_ms}ms — the terminal did not answer \\e[6n"),
                None,
            ));
        };
        if let Some(columns) = term.columns()
            && columns > 0
            && before.column + 2 > columns
        {
            return Err((
                format!(
                    "inconclusive: the cursor is at column {} of {columns}, too close to the right margin for the test glyph to be measured without wrapping — re-run at the start of a line",
                    before.column
                ),
                Some(printable(&before.raw)),
            ));
        }
        term.write(PROBE_GLYPH);
        let after = query_cursor(term, timeout);
        term.write(&format!("\u{1b}[{}G\u{1b}[K", before.column));
        let Some(after) = after else {
            return Err((
                format!("no DSR reply within {timeout_ms}ms after writing the test glyph"),
                Some(printable(&before.raw)),
            ));
        };
        if after.row != before.row {
            return Err((
                format!(
                    "inconclusive: writing the test glyph moved the cursor from row {} to row {}, so the column difference is not a width",
                    before.row, after.row
                ),
                Some(printable(&after.raw)),
            ));
        }
        Ok((before, after))
    })();
    // Restore on every path, success or failure (`width.ts:644-648`); a failed restore is
    // swallowed there too.
    let _ = term.set_raw(false);
    let (before, after) = match result {
        Ok(pair) => pair,
        Err((detail, reply)) => return fail(detail, reply),
    };
    let glyph_columns = i64::from(after.column) - i64::from(before.column);
    let (ambiguous, detail) = match glyph_columns {
        1 => (
            Some(Ambiguous::Narrow),
            format!("the terminal rendered {PROBE_GLYPH} in 1 column"),
        ),
        2 => (
            Some(Ambiguous::Wide),
            format!("the terminal rendered {PROBE_GLYPH} in 2 columns"),
        ),
        n => (
            None,
            format!(
                "inconclusive: the terminal reported {n} columns for {PROBE_GLYPH}, which is neither 1 nor 2"
            ),
        ),
    };
    ProbeReport {
        ambiguous,
        detail,
        reply: Some(printable(&after.raw)),
        columns: Some((before.column, after.column)),
        glyph_columns: Some(glyph_columns),
        elapsed_ms: elapsed(started),
    }
}

/// fds 0 and 1, through rustix termios. Restores the entry mode on drop.
pub struct RealTerminal {
    saved: Option<rustix::termios::Termios>,
}

impl RealTerminal {
    pub fn new() -> Self {
        RealTerminal { saved: None }
    }
}

impl Default for RealTerminal {
    fn default() -> Self {
        Self::new()
    }
}

impl ProbeTerminal for RealTerminal {
    fn stdin_is_tty(&self) -> bool {
        rustix::termios::isatty(std::io::stdin())
    }
    fn stdout_is_tty(&self) -> bool {
        rustix::termios::isatty(std::io::stdout())
    }
    fn set_raw(&mut self, raw: bool) -> Result<(), String> {
        use rustix::termios::{
            OptionalActions, OutputModes, SpecialCodeIndex, tcgetattr, tcsetattr,
        };
        let stdin = std::io::stdin();
        if raw {
            let original = tcgetattr(&stdin).map_err(|e| e.to_string())?;
            let mut t = original.clone();
            t.make_raw();
            t.output_modes |= OutputModes::OPOST | OutputModes::ONLCR;
            t.special_codes[SpecialCodeIndex::VMIN] = 0;
            t.special_codes[SpecialCodeIndex::VTIME] = 1;
            tcsetattr(&stdin, OptionalActions::Now, &t).map_err(|e| e.to_string())?;
            self.saved = Some(original);
        } else if let Some(original) = self.saved.take() {
            tcsetattr(&stdin, OptionalActions::Now, &original).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn read_chunk(&mut self, deadline: Instant) -> Option<Vec<u8>> {
        let mut buf = [0u8; 256];
        while Instant::now() < deadline {
            match rustix::io::read(std::io::stdin(), &mut buf) {
                Ok(0) => continue,
                Ok(n) => return Some(buf[..n].to_vec()),
                Err(rustix::io::Errno::INTR | rustix::io::Errno::AGAIN) => continue,
                Err(_) => return None,
            }
        }
        None
    }
    fn write(&mut self, text: &str) {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    fn columns(&self) -> Option<u32> {
        rustix::termios::tcgetwinsize(std::io::stdout())
            .ok()
            .map(|w| u32::from(w.ws_col))
    }
}

impl Drop for RealTerminal {
    fn drop(&mut self) {
        let _ = self.set_raw(false);
    }
}

/// Where a resolved answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmbiguousSource {
    Env,
    Cache,
    Probe,
    Default,
}

/// `resolveAmbiguousWidth`'s result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AmbiguousResolution {
    pub ambiguous: Ambiguous,
    pub measure: Measure,
    pub source: AmbiguousSource,
    pub detail: String,
    pub identity: String,
    pub cache_path: PathBuf,
    pub probe: Option<ProbeReport>,
}

/// `ResolveAmbiguousOptions`.
#[derive(Default)]
pub struct ResolveAmbiguousOptions<'a> {
    /// `None`: the process environment (the TS default, `process.env`).
    pub env: Option<&'a Env>,
    pub allow_probe: bool,
    pub refresh: bool,
    pub no_cache: bool,
    pub terminal: Option<&'a mut dyn ProbeTerminal>,
    pub timeout_ms: Option<u64>,
    pub cache_path: Option<PathBuf>,
}

/// Resolution order: `MDVIEW_AMBIGUOUS` → cache (unless refresh) → live probe → narrow.
pub fn resolve_ambiguous_width(options: ResolveAmbiguousOptions<'_>) -> AmbiguousResolution {
    let process_env: Env;
    let env = match options.env {
        Some(e) => e,
        None => {
            process_env = std::env::vars().collect::<HashMap<_, _>>();
            &process_env
        }
    };
    let identity = terminal_identity(env);
    let cache_path = options
        .cache_path
        .unwrap_or_else(|| resolve_ambiguous_cache_path(env));
    let make = |ambiguous: Ambiguous, source, detail: String, probe| AmbiguousResolution {
        ambiguous,
        measure: measure_for(ambiguous),
        source,
        detail,
        identity: identity.clone(),
        cache_path: cache_path.clone(),
        probe,
    };
    if let Some(from_env) = parse_ambiguous_width(env.get("MDVIEW_AMBIGUOUS").map(String::as_str)) {
        return make(
            from_env,
            AmbiguousSource::Env,
            format!(
                "MDVIEW_AMBIGUOUS={} in the environment overrides everything else",
                ambiguous_str(from_env)
            ),
            None,
        );
    }
    if !options.refresh
        && let Some(cached) = read_cached_ambiguous_width(&identity, &cache_path)
    {
        return make(
            cached.ambiguous,
            AmbiguousSource::Cache,
            format!(
                "cached answer for this terminal identity, probed {}",
                cached.probed_at
            ),
            None,
        );
    }
    if options.allow_probe {
        let mut real = RealTerminal::new();
        let term: &mut dyn ProbeTerminal = match options.terminal {
            Some(t) => t,
            None => &mut real,
        };
        let report = probe_ambiguous_width(term, options.timeout_ms.unwrap_or(PROBE_TIMEOUT_MS));
        if let Some(found) = report.ambiguous {
            if !options.no_cache {
                write_cached_ambiguous_width(&identity, found, &cache_path);
            }
            let detail = report.detail.clone();
            return make(found, AmbiguousSource::Probe, detail, Some(report));
        }
        let detail = format!("{}; falling back to narrow", report.detail);
        let mut r = make(
            Ambiguous::Narrow,
            AmbiguousSource::Default,
            detail,
            Some(report),
        );
        r.measure = NARROW_MEASURE;
        return r;
    }
    make(
        Ambiguous::Narrow,
        AmbiguousSource::Default,
        "no override, no cached answer, and no live probe (a probe needs both stdin and stdout to be TTYs, and never runs under --check or the sweep) — narrow is what Unicode TR11 recommends when the context cannot be established".into(),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    /// A scripted terminal: each cursor query is answered by the next reply.
    struct Fake {
        tty: (bool, bool),
        replies: VecDeque<Option<String>>,
        written: Vec<String>,
        raw: Vec<bool>,
        columns: Option<u32>,
        pending: Option<Vec<u8>>,
    }

    impl Fake {
        fn new(replies: &[Option<&str>]) -> Self {
            Fake {
                tty: (true, true),
                replies: replies.iter().map(|r| r.map(str::to_owned)).collect(),
                written: Vec::new(),
                raw: Vec::new(),
                columns: Some(80),
                pending: None,
            }
        }
    }

    impl ProbeTerminal for Fake {
        fn stdin_is_tty(&self) -> bool {
            self.tty.0
        }
        fn stdout_is_tty(&self) -> bool {
            self.tty.1
        }
        fn set_raw(&mut self, raw: bool) -> Result<(), String> {
            self.raw.push(raw);
            Ok(())
        }
        fn read_chunk(&mut self, _deadline: Instant) -> Option<Vec<u8>> {
            self.pending.take()
        }
        fn write(&mut self, text: &str) {
            if text == "\u{1b}[6n" {
                self.pending = self.replies.pop_front().flatten().map(String::into_bytes);
            }
            self.written.push(text.to_owned());
        }
        fn columns(&self) -> Option<u32> {
            self.columns
        }
    }

    #[test]
    fn narrow_and_wide_terminals() {
        let mut f = Fake::new(&[Some("\u{1b}[5;1R"), Some("\u{1b}[5;2R")]);
        let r = probe_ambiguous_width(&mut f, 50);
        assert_eq!(r.ambiguous, Some(Ambiguous::Narrow));
        assert_eq!(r.columns, Some((1, 2)));
        assert_eq!(r.reply.as_deref(), Some("\\e[5;2R"));
        assert_eq!(
            f.written,
            vec!["\u{1b}[6n", "—", "\u{1b}[6n", "\u{1b}[1G\u{1b}[K"]
        );
        assert_eq!(f.raw, vec![true, false]);
        let mut f = Fake::new(&[Some("\u{1b}[5;1R"), Some("\u{1b}[5;3R")]);
        assert_eq!(
            probe_ambiguous_width(&mut f, 50).ambiguous,
            Some(Ambiguous::Wide)
        );
        let mut f = Fake::new(&[Some("\u{1b}[5;1R"), Some("\u{1b}[5;5R")]);
        let r = probe_ambiguous_width(&mut f, 50);
        assert_eq!(r.ambiguous, None);
        assert!(r.detail.contains("reported 4 columns"));
    }

    #[test]
    fn failure_paths_restore_raw_mode() {
        let mut f = Fake::new(&[None]);
        let r = probe_ambiguous_width(&mut f, 50);
        assert_eq!(
            r.detail,
            "no DSR reply within 50ms — the terminal did not answer \\e[6n"
        );
        assert_eq!(f.raw, vec![true, false]);
        let mut f = Fake::new(&[Some("\u{1b}[5;79R")]);
        assert!(
            probe_ambiguous_width(&mut f, 50)
                .detail
                .starts_with("inconclusive: the cursor is at column 79 of 80")
        );
        let mut f = Fake::new(&[Some("\u{1b}[5;1R"), Some("\u{1b}[6;2R")]);
        assert!(
            probe_ambiguous_width(&mut f, 50)
                .detail
                .contains("from row 5 to row 6")
        );
        let mut f = Fake::new(&[Some("\u{3}")]);
        assert_eq!(probe_ambiguous_width(&mut f, 50).ambiguous, None);
        let mut f = Fake::new(&[Some("\u{1b}[5;1R"), None]);
        let r = probe_ambiguous_width(&mut f, 50);
        assert!(r.detail.contains("after writing the test glyph"));
        assert_eq!(
            f.written.last().map(String::as_str),
            Some("\u{1b}[1G\u{1b}[K")
        );
    }

    #[test]
    fn not_a_tty_never_touches_the_terminal() {
        let mut f = Fake::new(&[]);
        f.tty = (true, false);
        let r = probe_ambiguous_width(&mut f, 50);
        assert_eq!(
            r.detail,
            "not probing: stdin is a TTY and stdout is not a TTY — a DSR probe needs both"
        );
        assert!(f.written.is_empty() && f.raw.is_empty());
    }

    #[test]
    fn identity_and_cache_path() {
        let e = env(&[
            ("TERM", "screen"),
            ("STY", "1"),
            ("TMUX", "x"),
            ("LC_ALL", ""),
            ("LANG", "en_US.UTF-8"),
        ]);
        assert_eq!(
            terminal_identity(&e),
            "term=screen|program=|colorterm=|vte=|mux=screen|locale=en_US.UTF-8"
        );
        assert_eq!(
            terminal_identity(&env(&[("ZELLIJ", "0")])),
            "term=|program=|colorterm=|vte=|mux=zellij|locale="
        );
        assert_eq!(
            resolve_ambiguous_cache_path(&env(&[("XDG_CACHE_HOME", "/tmp/x/../c/")])),
            PathBuf::from("/tmp/c/mdview/ambiguous-width.json")
        );
    }

    #[test]
    fn printable_escapes_controls() {
        assert_eq!(printable("\u{1b}[1;2R\r"), "\\e[1;2R\\x0d");
    }

    #[test]
    fn iso_format_matches_to_iso_string() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_millis(1_791_000_000_123),
            "2026-10-03T04:00:00.123Z"
        );
    }

    #[test]
    fn cache_round_trip_and_resolution_order() {
        let dir = std::env::temp_dir().join(format!("mdview-probe-test-{}", std::process::id()));
        let path = dir.join("nested").join("ambiguous-width.json");
        assert_eq!(read_cached_ambiguous_width("id", &path), None);
        assert!(write_cached_ambiguous_width("id", Ambiguous::Wide, &path));
        assert!(write_cached_ambiguous_width(
            "other",
            Ambiguous::Narrow,
            &path
        ));
        assert_eq!(
            read_cached_ambiguous_width("id", &path).map(|c| c.ambiguous),
            Some(Ambiguous::Wide)
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("{\n  \"version\": 1,\n  \"entries\": {\n    \"id\": {"),
            "{text}"
        );
        assert!(text.ends_with("}\n"));

        let e = env(&[]);
        let id = terminal_identity(&e);
        write_cached_ambiguous_width(&id, Ambiguous::Wide, &path);
        let r = resolve_ambiguous_width(ResolveAmbiguousOptions {
            env: Some(&e),
            cache_path: Some(path.clone()),
            ..Default::default()
        });
        assert_eq!(
            (r.source, r.ambiguous),
            (AmbiguousSource::Cache, Ambiguous::Wide)
        );
        let ov = env(&[("MDVIEW_AMBIGUOUS", "narrow")]);
        let r = resolve_ambiguous_width(ResolveAmbiguousOptions {
            env: Some(&ov),
            cache_path: Some(path.clone()),
            ..Default::default()
        });
        assert_eq!(r.source, AmbiguousSource::Env);
        let mut fake = Fake::new(&[None]);
        let r = resolve_ambiguous_width(ResolveAmbiguousOptions {
            env: Some(&e),
            cache_path: Some(path.clone()),
            refresh: true,
            allow_probe: true,
            terminal: Some(&mut fake),
            timeout_ms: Some(10),
            ..Default::default()
        });
        assert_eq!(
            (r.source, r.ambiguous),
            (AmbiguousSource::Default, Ambiguous::Narrow)
        );
        assert!(r.detail.ends_with("; falling back to narrow"));
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(read_cached_ambiguous_width("id", &path), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
