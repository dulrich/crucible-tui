//! The safe-edit loop (WP-3 of `plans/jsonedit.md`; invariants in
//! `crates/jsonedit/AGENTS.md`). Everything process-specific — the editor
//! command, the prompt input, whether stdin is a TTY — is injected through
//! [`EditEnv`] so tests drive the loop without a terminal.

use crate::indent::{self, Detection, Indent};
use crate::validate::{Dialect, validate};
use std::ffi::OsString;
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
    /// Where the editor buffer is created (`$TMPDIR` for the real process).
    pub tmp_dir: PathBuf,
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
            tmp_dir: std::env::temp_dir(),
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

/// How an editor takes a "open at line N" hint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HintForm {
    /// `+N FILE` — vi, vim, nvim, nano, emacs, emacsclient, micro, kak.
    Plus,
    /// `FILE:N` — Helix, Sublime Text.
    Colon,
    /// `--goto FILE:N` — VS Code, VSCodium.
    Goto,
}

/// The hint form for an editor program, by exact file name; `None` means
/// the editor is not known to accept one and gets no hint.
pub fn hint_form(program: &str) -> Option<HintForm> {
    let name = Path::new(program).file_name()?.to_str()?;
    Some(match name {
        "vi" | "vim" | "nvim" | "nano" | "emacs" | "emacsclient" | "micro" | "kak" => {
            HintForm::Plus
        }
        "hx" | "helix" | "subl" => HintForm::Colon,
        "code" | "codium" => HintForm::Goto,
        _ => return None,
    })
}

/// Vim accepts at most ten `+cmd` / `-c` / `-S` startup arguments combined.
const VIM_STARTUP_LIMIT: usize = 10;

/// The editor's arguments after the program: the user's own, then the
/// buffer, with a line hint when the editor accepts one. The hint is
/// suppressed when the user's arguments contain `--` (everything after it
/// is a file name) or, for vi/vim/nvim, already use the startup-command limit;
/// the `FILE:N` forms are also suppressed when the buffer path contains `:`.
pub fn editor_args(editor: &[String], buffer: &Path, hint: Option<usize>) -> Vec<OsString> {
    let user = &editor[1..];
    let mut args: Vec<OsString> = user.iter().map(OsString::from).collect();
    let colon = |n: usize| {
        let mut a = buffer.as_os_str().to_os_string();
        a.push(format!(":{n}"));
        a
    };
    let vim_full = || {
        matches!(
            Path::new(&editor[0]).file_name().and_then(|n| n.to_str()),
            Some("vi" | "vim" | "nvim")
        ) && user
            .iter()
            .filter(|a| a.starts_with('+') || *a == "-c" || *a == "-S")
            .count()
            >= VIM_STARTUP_LIMIT
    };
    let colon_safe = !buffer.as_os_str().as_encoded_bytes().contains(&b':');
    let form = match hint {
        Some(n) if !user.iter().any(|a| a == "--") => hint_form(&editor[0])
            .filter(|f| *f == HintForm::Plus || colon_safe)
            .map(|f| (f, n)),
        _ => None,
    };
    match form {
        Some((HintForm::Plus, n)) if !vim_full() => {
            args.push(format!("+{n}").into());
            args.push(buffer.into());
        }
        Some((HintForm::Colon, n)) => args.push(colon(n)),
        Some((HintForm::Goto, n)) => {
            args.push("--goto".into());
            args.push(colon(n));
        }
        _ => args.push(buffer.into()),
    }
    args
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
fn make_buffer(dir: &Path, target: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let stem = target
        .file_stem()
        .map_or("buffer".into(), |s| s.to_string_lossy().into_owned());
    let mut name = format!("{stem}.{}", unique());
    if let Some(ext) = target.extension() {
        name.push('.');
        name.push_str(&ext.to_string_lossy());
    }
    // `:` would make an editor's `FILE:N` hint ambiguous; the name is cosmetic.
    let name = name.replace(':', "_");
    let path = dir.join(name);
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

/// One answer to a post-editor prompt.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Choice {
    Fix,
    Write,
    Edit,
    Exit,
    Abort,
}

impl Choice {
    fn key(self) -> char {
        match self {
            Choice::Fix => 'f',
            Choice::Write => 'w',
            Choice::Edit => 'e',
            Choice::Exit => 'x',
            Choice::Abort => 'a',
        }
    }
    fn label(self) -> &'static str {
        match self {
            Choice::Fix => "(f)ix indentation",
            Choice::Write => "(w)rite anyway",
            Choice::Edit => "(e)dit again",
            Choice::Exit => "e(x)it without saving",
            Choice::Abort => "(a)bort keeping the buffer",
        }
    }
}

/// Asks until one of `choices` is answered; EOF is [`Choice::Abort`].
fn ask(env: &mut EditEnv, err: &mut dyn Write, choices: &[Choice]) -> Choice {
    let labels: Vec<&str> = choices.iter().map(|c| c.label()).collect();
    let question = format!("{}?", labels.join(", "));
    loop {
        let _ = write!(err, "{question} ");
        let _ = err.flush();
        let mut line = String::new();
        match env.input.read_line(&mut line) {
            Ok(0) | Err(_) => {
                let _ = writeln!(err);
                return Choice::Abort;
            }
            Ok(_) => {}
        }
        let answer = line.trim().to_ascii_lowercase();
        let mut cs = answer.chars();
        if let (Some(c), None) = (cs.next(), cs.next())
            && let Some(&choice) = choices.iter().find(|ch| ch.key() == c)
        {
            return choice;
        }
    }
}

/// Asks for the reference indent; re-prompts on unrecognised input, and
/// blank input or EOF skips the check.
fn ask_indent(env: &mut EditEnv, err: &mut dyn Write) -> Option<Indent> {
    loop {
        let _ = write!(
            err,
            "jsonedit: indent style is ambiguous; enter 'tab', a number of spaces, or nothing to skip the check: "
        );
        let _ = err.flush();
        let mut line = String::new();
        match env.input.read_line(&mut line) {
            Ok(0) | Err(_) => return None,
            Ok(_) => {}
        }
        let answer = line.trim();
        if answer.is_empty() {
            return None;
        }
        if let Some(i) = Indent::from_name(answer) {
            return Some(i);
        }
    }
}

/// What the review after an editor run decided.
enum Verdict {
    Write,
    /// Replace the buffer with these re-indented bytes and review them again
    /// without relaunching the editor.
    Fix(Vec<u8>),
    /// Re-edit, reopening at this line if known.
    Edit(Option<usize>),
    Exit,
    /// Keep the buffer; the reason is printed.
    Abort(String),
}

impl Verdict {
    fn from_choice(choice: Choice, hint: Option<usize>) -> Verdict {
        match choice {
            Choice::Write => Verdict::Write,
            // Only reached with the fixed bytes in hand (see `Review::run`).
            Choice::Fix => Verdict::Abort("aborted".into()),
            Choice::Edit => Verdict::Edit(hint),
            Choice::Exit => Verdict::Exit,
            Choice::Abort => Verdict::Abort("aborted".into()),
        }
    }
}

/// Up to five line numbers, then `, ...`.
fn line_list(lines: &[usize]) -> String {
    let list: Vec<String> = lines.iter().take(5).map(usize::to_string).collect();
    let more = if lines.len() > 5 { ", ..." } else { "" };
    format!("{}{more}", list.join(", "))
}

/// The fixed inputs the review reads.
struct Review<'a> {
    file: &'a str,
    target: &'a Path,
    dialect: Dialect,
    reference: Option<Indent>,
    base: &'a [u8],
}

impl Review<'_> {
    /// Validation, the indent check and the concurrent-change check, in
    /// order. A concurrent change accepted for re-edit makes disk the new
    /// `original`.
    fn run(
        &self,
        edited: &[u8],
        original: &mut Option<Vec<u8>>,
        env: &mut EditEnv,
        err: &mut dyn Write,
    ) -> Verdict {
        use Choice::{Abort, Edit, Exit, Fix, Write as W};
        let file = self.file;
        if let Err(diags) = validate(edited, self.dialect) {
            for d in &diags {
                let _ = writeln!(err, "{file}:{}:{}: {}", d.line, d.column, d.message);
            }
            if !env.tty {
                return Verdict::Abort("invalid; nothing written".into());
            }
            let choice = ask(env, err, &[Edit, Exit, Abort]);
            return Verdict::from_choice(choice, diags.first().map(|d| d.line));
        }
        if let Some(style) = self.reference {
            let bad = indent::mismatches(self.base, edited, style);
            if !bad.is_empty() {
                let _ = writeln!(
                    err,
                    "jsonedit: warning: line(s) {} do not match the file's indent style ({style})",
                    line_list(&bad)
                );
                if env.tty {
                    let fix = indent::reindent(edited, &bad, style);
                    let choice = if fix.fixed.is_empty() {
                        ask(env, err, &[W, Edit, Exit, Abort])
                    } else {
                        ask(env, err, &[Fix, W, Edit, Exit, Abort])
                    };
                    if choice == Fix {
                        let _ = writeln!(
                            err,
                            "jsonedit: re-indented line(s) {}",
                            line_list(&fix.fixed)
                        );
                        return Verdict::Fix(fix.bytes);
                    }
                    if choice != W {
                        return Verdict::from_choice(choice, bad.first().copied());
                    }
                }
            }
        }
        // Concurrent change: the target must still hold what was opened.
        let now = match read_target(self.target) {
            Ok(n) => n,
            Err(e) => return Verdict::Abort(format!("cannot re-read {file}: {e}")),
        };
        if now != *original {
            let _ = writeln!(
                err,
                "jsonedit: {file} changed on disk while it was being edited"
            );
            if !env.tty {
                return Verdict::Abort("not overwriting".into());
            }
            let choice = ask(env, err, &[Edit, Abort]);
            if choice == Edit {
                // The user has been told; the new disk bytes become the baseline.
                *original = now;
            }
            return Verdict::from_choice(choice, None);
        }
        Verdict::Write
    }
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
    let buffer = match make_buffer(&env.tmp_dir, &target, &base) {
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

    let review = Review {
        file,
        target: &target,
        dialect,
        reference,
        base: &base,
    };

    // Run editor -> read -> unchanged? -> review -> write.
    // Line to reopen at on a re-edit; never set for the first launch.
    let mut hint: Option<usize> = None;
    // Re-indented bytes to review next instead of relaunching the editor.
    let mut fixed: Option<Vec<u8>> = None;
    loop {
        if let Some(bytes) = fixed.take() {
            if let Err(e) = fs::write(&buffer, &bytes) {
                return abort(err, &format!("cannot write buffer: {e}"));
            }
        } else {
            let status = std::process::Command::new(&env.editor[0])
                .args(editor_args(&env.editor, &buffer, hint))
                .status();
            match status {
                Ok(s) if s.success() => {}
                Ok(s) => return abort(err, &format!("editor exited with {s}")),
                Err(e) => {
                    return abort(err, &format!("cannot run editor '{}': {e}", env.editor[0]));
                }
            }
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
        match review.run(&edited, &mut original, env, err) {
            Verdict::Abort(why) => return abort(err, &why),
            Verdict::Exit => return discard(err, 1, "exited without saving"),
            Verdict::Edit(h) => hint = h,
            Verdict::Fix(bytes) => fixed = Some(bytes),
            Verdict::Write => {
                if let Err(e) = atomic_write(&target, &edited) {
                    return abort(err, &format!("cannot write {file}: {e}"));
                }
                return discard(err, 0, "");
            }
        }
    }
}
