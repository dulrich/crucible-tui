//! The safe-edit loop (WP-3 of `plans/jsonedit.md`; invariants in
//! `crates/jsonedit/AGENTS.md`). Everything process-specific — the editor
//! command, the prompt input, whether stdin is a TTY — is injected through
//! [`EditEnv`] so tests drive the loop without a terminal.

use crate::indent::{self, Detection, Indent};
use crate::validate::{Dialect, validate};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// Process-specific inputs to the loop.
pub struct EditEnv {
    /// The editor argv; the buffer path is appended as the last argument.
    pub editor: Vec<String>,
    /// Prompt answers, one per line.
    pub input: Box<dyn BufRead>,
    /// Whether stdin is interactive; when false the loop never prompts.
    pub tty: bool,
}

impl EditEnv {
    /// The real environment: `$VISUAL`, then `$EDITOR`, then `vi`; stdin.
    pub fn from_process() -> Result<EditEnv, String> {
        use std::io::IsTerminal;
        let value = ["VISUAL", "EDITOR"]
            .iter()
            .filter_map(|k| std::env::var(k).ok())
            .find(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "vi".into());
        let editor = split_shell(&value)?;
        let stdin = std::io::stdin();
        let tty = stdin.is_terminal();
        Ok(EditEnv {
            editor,
            input: Box::new(std::io::BufReader::new(stdin)),
            tty,
        })
    }
}

/// Splits an editor value shell-style: whitespace separates words, single
/// quotes are literal, double quotes allow `\"`, `\\`, `\$` and `` \` ``,
/// and a backslash outside quotes escapes the next character. No expansion.
pub fn split_shell(s: &str) -> Result<Vec<String>, String> {
    let (mut words, mut cur, mut in_word) = (Vec::new(), String::new(), false);
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => return Err("unterminated ' in editor command".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => cur.push(c),
                            Some(c) => {
                                cur.push('\\');
                                cur.push(c);
                            }
                            None => return Err("unterminated \" in editor command".into()),
                        },
                        Some(c) => cur.push(c),
                        None => return Err("unterminated \" in editor command".into()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                if let Some(c) = chars.next() {
                    cur.push(c);
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        words.push(cur);
    }
    if words.is_empty() {
        return Err("empty editor command".into());
    }
    Ok(words)
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn unique() -> String {
    format!(
        "jsonedit-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn create_0600(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// `<tmp>/<stem>.jsonedit-<pid>-<n>[.<ext>]`, mode 0600.
fn make_buffer(target: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let stem = target
        .file_stem()
        .map_or("buffer".into(), |s| s.to_string_lossy().into_owned());
    let mut name = format!("{stem}.{}", unique());
    if let Some(ext) = target.extension() {
        name.push('.');
        name.push_str(&ext.to_string_lossy());
    }
    let path = std::env::temp_dir().join(name);
    let mut f = create_0600(&path)?;
    f.write_all(bytes)?;
    Ok(path)
}

/// Atomic replace: a temp in the target's directory, fsync, original mode
/// (0644 for a new file) and best-effort owner, then `rename`.
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map_or("file".into(), |s| s.to_string_lossy().into_owned());
    let tmp = dir.join(format!(".{name}.{}.tmp", unique()));
    let result = (|| {
        let mut f = create_0600(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        match fs::metadata(target) {
            Ok(meta) => {
                f.set_permissions(fs::Permissions::from_mode(meta.mode() & 0o7777))?;
                // Owner is kept where the process may; EPERM is not a failure.
                let _ = std::os::unix::fs::fchown(&f, Some(meta.uid()), Some(meta.gid()));
            }
            Err(_) => f.set_permissions(fs::Permissions::from_mode(0o644))?,
        }
        drop(f);
        fs::rename(&tmp, target)?;
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn read_target(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Asks until one of `keys` is answered; EOF is `None` (callers treat it as abort).
fn ask(env: &mut EditEnv, err: &mut dyn Write, question: &str, keys: &str) -> Option<char> {
    loop {
        let _ = write!(err, "{question} ");
        let _ = err.flush();
        let mut line = String::new();
        match env.input.read_line(&mut line) {
            Ok(0) | Err(_) => {
                let _ = writeln!(err);
                return None;
            }
            Ok(_) => {}
        }
        let answer = line.trim().to_ascii_lowercase();
        let mut cs = answer.chars();
        if let (Some(c), None) = (cs.next(), cs.next())
            && keys.contains(c)
        {
            return Some(c);
        }
    }
}

fn ask_indent(env: &mut EditEnv, err: &mut dyn Write) -> Option<Indent> {
    let _ = write!(
        err,
        "jsonedit: indent style is ambiguous; enter 'tab', a number of spaces, or nothing to skip the check: "
    );
    let _ = err.flush();
    let mut line = String::new();
    env.input.read_line(&mut line).ok()?;
    Indent::from_name(line.trim())
}

/// Runs the safe-edit loop on `file` and returns the exit code.
pub fn edit(
    file: &str,
    dialect: Option<Dialect>,
    indent: Option<Indent>,
    env: &mut EditEnv,
    err: &mut dyn Write,
) -> i32 {
    let given = Path::new(file);
    // Symlinks are followed: operate on the resolved path.
    let target = match fs::canonicalize(given) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if fs::symlink_metadata(given).is_ok() {
                let _ = writeln!(
                    err,
                    "jsonedit: {file}: dangling symlink; refusing to replace it"
                );
                return 1;
            }
            given.to_path_buf()
        }
        Err(e) => {
            let _ = writeln!(err, "jsonedit: {file}: {e}");
            return 1;
        }
    };
    let mut original = match read_target(&target) {
        Ok(o) => o,
        Err(e) => {
            let _ = writeln!(err, "jsonedit: {file}: {e}");
            return 1;
        }
    };
    let dialect = dialect.unwrap_or_else(|| Dialect::from_path(given));
    let base: Vec<u8> = original.clone().unwrap_or_default();
    let reference = match indent {
        Some(i) => Some(i),
        None => match indent::detect(&base) {
            Detection::Style(i) => Some(i),
            Detection::Ambiguous if env.tty => ask_indent(env, err),
            _ => None,
        },
    };
    let buffer = match make_buffer(&target, &base) {
        Ok(p) => p,
        Err(e) => {
            let _ = writeln!(err, "jsonedit: cannot create editor buffer: {e}");
            return 1;
        }
    };
    let shown = buffer.display().to_string();
    let abort = |err: &mut dyn Write, why: &str| {
        let _ = writeln!(err, "jsonedit: {why}; buffer kept at {shown}");
        1
    };
    let discard = |err: &mut dyn Write, code: i32, why: &str| {
        let _ = fs::remove_file(&buffer);
        if !why.is_empty() {
            let _ = writeln!(err, "jsonedit: {why}");
        }
        code
    };

    loop {
        let status = std::process::Command::new(&env.editor[0])
            .args(&env.editor[1..])
            .arg(&buffer)
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => return abort(err, &format!("editor exited with {s}")),
            Err(e) => return abort(err, &format!("cannot run editor '{}': {e}", env.editor[0])),
        }
        let edited = match fs::read(&buffer) {
            Ok(b) => b,
            Err(e) => return abort(err, &format!("cannot read buffer: {e}")),
        };
        if edited == base {
            let msg = if original.is_none() {
                "no changes; nothing created"
            } else {
                "no changes"
            };
            return discard(err, 0, msg);
        }
        if let Err(diags) = validate(&edited, dialect) {
            for d in &diags {
                let _ = writeln!(err, "{file}:{}:{}: {}", d.line, d.column, d.message);
            }
            if !env.tty {
                return abort(err, "invalid; nothing written");
            }
            match ask(
                env,
                err,
                "(e)dit again, e(x)it without saving, (a)bort keeping the buffer?",
                "exa",
            ) {
                Some('e') => continue,
                Some('x') => return discard(err, 1, "exited without saving"),
                _ => return abort(err, "aborted"),
            }
        }
        if let Some(style) = reference {
            let bad = indent::mismatches(&base, &edited, style);
            if !bad.is_empty() {
                let list: Vec<String> = bad.iter().take(5).map(usize::to_string).collect();
                let more = if bad.len() > 5 { ", ..." } else { "" };
                let _ = writeln!(
                    err,
                    "jsonedit: warning: line(s) {}{more} do not match the file's indent style ({style})",
                    list.join(", ")
                );
                if env.tty {
                    match ask(
                        env,
                        err,
                        "(w)rite anyway, (e)dit again, e(x)it without saving, (a)bort keeping the buffer?",
                        "wexa",
                    ) {
                        Some('w') => {}
                        Some('e') => continue,
                        Some('x') => return discard(err, 1, "exited without saving"),
                        _ => return abort(err, "aborted"),
                    }
                }
            }
        }
        // Concurrent change: the target must still hold what was opened.
        let now = match read_target(&target) {
            Ok(n) => n,
            Err(e) => return abort(err, &format!("cannot re-read {file}: {e}")),
        };
        if now != original {
            let _ = writeln!(
                err,
                "jsonedit: {file} changed on disk while it was being edited"
            );
            if !env.tty {
                return abort(err, "not overwriting");
            }
            match ask(env, err, "(e)dit again, (a)bort keeping the buffer?", "ea") {
                Some('e') => {
                    // The user has been told; the new disk bytes become the baseline.
                    original = now;
                    continue;
                }
                _ => return abort(err, "aborted"),
            }
        }
        if let Err(e) = atomic_write(&target, &edited) {
            return abort(err, &format!("cannot write {file}: {e}"));
        }
        return discard(err, 0, "");
    }
}
