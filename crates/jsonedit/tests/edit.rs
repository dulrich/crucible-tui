//! The safe-edit loop, driven by a scripted editor (a `sh -c` one-liner that
//! rewrites the buffer) and scripted prompt input. Every test works in its
//! own fresh temp dir.

use jsonedit::Indent;
use jsonedit::edit::{EditEnv, edit, editor_args, split_shell};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

struct Dir(PathBuf);
impl Dir {
    fn new(tag: &str) -> Dir {
        let p = std::env::temp_dir().join(format!("jsonedit-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    /// The per-test buffer directory (`EditEnv.tmp_dir`), created on demand.
    fn bufs(&self) -> PathBuf {
        let p = self.0.join("bufs");
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn file(&self, name: &str, body: &str) -> PathBuf {
        let p = self.0.join(name);
        fs::write(&p, body).unwrap();
        p
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The buffer directory beside `target`: every test's target sits in its
/// own [`Dir`], so `<dir>/bufs` is that test's alone.
fn bufs_of(target: &Path) -> PathBuf {
    let p = target.parent().unwrap().join("bufs");
    fs::create_dir_all(&p).unwrap();
    p
}

fn buffer_count(dir: &Path) -> usize {
    fs::read_dir(dir).unwrap().count()
}

/// Runs the loop with `script` as the editor (`$1` is the buffer) and
/// `answers` as prompt input. Returns (exit code, stderr).
fn run(
    target: &Path,
    script: &str,
    answers: &str,
    tty: bool,
    indent: Option<Indent>,
) -> (i32, String) {
    let mut env = EditEnv {
        editor: vec!["sh".into(), "-c".into(), script.into(), "sh".into()],
        input: Box::new(std::io::Cursor::new(answers.as_bytes().to_vec())),
        tty,
        tmp_dir: bufs_of(target),
    };
    let mut err = Vec::new();
    let code = edit(target.to_str().unwrap(), None, indent, &mut env, &mut err);
    (code, String::from_utf8(err).unwrap())
}

fn kept_buffer(stderr: &str) -> PathBuf {
    PathBuf::from(stderr.rsplit("buffer kept at ").next().unwrap().trim())
}

const ORIG: &str = "{\n  \"a\": 1,\n  \"b\": 2\n}\n";

#[test]
fn valid_edit_writes_editor_bytes_verbatim() {
    let d = Dir::new("valid");
    let t = d.file("x.json", ORIG);
    // Odd spacing and key order must survive byte for byte.
    let good = d.file("good", "{\n  \"b\" :2,\n  \"a\":   1\n}");
    let (code, err) = run(
        &t,
        &format!("cp '{}' \"$1\"", good.display()),
        "",
        false,
        None,
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(fs::read(&t).unwrap(), fs::read(&good).unwrap());
    assert_eq!(buffer_count(&d.bufs()), 0);
}

#[test]
fn invalid_then_prompt_choices() {
    // (answer, expected code, target rewritten?, buffer kept?)
    for (answer, want, written, kept) in [
        ("e\n", 0, true, false),
        ("x\n", 1, false, false),
        ("a\n", 1, false, true),
        ("", 1, false, true),
    ] {
        let d = Dir::new(&format!("prompt-{}", answer.trim()));
        let t = d.file("x.json", ORIG);
        let bad = d.file("bad", "{\"a\": 1 // c\n}");
        let good = d.file("good", "{\"a\": 3}\n");
        let n = d.0.join("n");
        let script = format!(
            "if [ -f '{n}' ]; then cp '{g}' \"$1\"; else touch '{n}'; cp '{b}' \"$1\"; fi",
            n = n.display(),
            g = good.display(),
            b = bad.display()
        );
        let (code, err) = run(&t, &script, answer, true, None);
        assert_eq!(code, want, "{answer:?}: {err}");
        assert!(err.contains("x.json:1:"), "{err}");
        let body = fs::read_to_string(&t).unwrap();
        assert_eq!(body == "{\"a\": 3}\n", written, "{answer:?}");
        if !written {
            assert_eq!(body, ORIG);
        }
        if kept {
            let b = kept_buffer(&err);
            assert_eq!(b.parent().unwrap(), d.bufs(), "{err}");
            assert_eq!(buffer_count(&d.bufs()), 1, "{err}");
            assert!(b.exists() && b.extension().unwrap() == "json", "{err}");
            assert_eq!(
                fs::metadata(&b).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::remove_file(b).unwrap();
        } else {
            assert!(!err.contains("buffer kept"), "{err}");
            // Invariant 4: removed after a write or an exit.
            assert_eq!(buffer_count(&d.bufs()), 0, "{answer:?}: {err}");
        }
    }
}

#[test]
fn non_tty_failure_exits_one_without_prompting() {
    let d = Dir::new("nontty");
    let t = d.file("x.json", ORIG);
    let (code, err) = run(&t, "printf '{,}' > \"$1\"", "e\n", false, None);
    assert_eq!(code, 1);
    assert!(!err.contains("(e)dit again"), "{err}");
    assert_eq!(fs::read_to_string(&t).unwrap(), ORIG);
    let b = kept_buffer(&err);
    assert_eq!(fs::read_to_string(&b).unwrap(), "{,}");
    fs::remove_file(b).unwrap();
}

#[test]
fn concurrent_change_is_not_overwritten() {
    let d = Dir::new("concurrent");
    let t = d.file("x.json", ORIG);
    let script = format!(
        "printf '{{\"z\": 1}}' > \"$1\"; printf '{{\"other\": 2}}' > '{}'",
        t.display()
    );
    let (code, err) = run(&t, &script, "a\n", true, None);
    assert_eq!(code, 1);
    assert!(err.contains("changed on disk"), "{err}");
    assert_eq!(fs::read_to_string(&t).unwrap(), "{\"other\": 2}");
    fs::remove_file(kept_buffer(&err)).unwrap();
}

#[test]
fn symlink_target_replaced_link_intact_and_mode_kept() {
    let d = Dir::new("symlink");
    let t = d.file("real.json", ORIG);
    fs::set_permissions(&t, fs::Permissions::from_mode(0o640)).unwrap();
    let link = d.0.join("link.json");
    std::os::unix::fs::symlink(&t, &link).unwrap();
    let (code, err) = run(&link, "printf '{\"n\": 1}' > \"$1\"", "", false, None);
    assert_eq!(code, 0, "{err}");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_link(&link).unwrap(), t);
    assert_eq!(fs::read_to_string(&t).unwrap(), "{\"n\": 1}");
    assert_eq!(
        fs::metadata(&t).unwrap().permissions().mode() & 0o777,
        0o640
    );
}

#[test]
fn missing_file_empty_save_creates_nothing() {
    let d = Dir::new("missing");
    let t = d.0.join("new.json");
    let (code, err) = run(&t, "true", "", false, None);
    assert_eq!(code, 0, "{err}");
    assert!(!t.exists());
    let (code, err) = run(&t, "printf '[1]' > \"$1\"", "", false, None);
    assert_eq!(code, 0, "{err}");
    assert_eq!(fs::read_to_string(&t).unwrap(), "[1]");
}

#[test]
fn indent_mismatch_warns_and_offers_write_anyway() {
    let d = Dir::new("indent");
    let new = "{\n  \"a\": 1,\n\t\"b\": 2\n}\n";
    // Too few indented lines to detect; --indent 2 supplies the reference.
    for (tty, answer, want, written) in [
        (false, "", 0, true),
        (true, "w\n", 0, true),
        (true, "x\n", 1, false),
    ] {
        let t = d.file("x.json", ORIG);
        let src = d.file("new", new);
        let (code, err) = run(
            &t,
            &format!("cp '{}' \"$1\"", src.display()),
            answer,
            tty,
            Some(Indent::Spaces(2)),
        );
        assert_eq!(code, want, "{err}");
        assert!(err.contains("warning: line(s) 3 do not match"), "{err}");
        assert_eq!(tty, err.contains("(w)rite anyway"));
        assert_eq!(fs::read_to_string(&t).unwrap() == new, written);
    }
    // Detected-ambiguous + TTY asks once before the editor; blank skips the check.
    let t = d.file(
        "y.json",
        "{\n\t\"a\": {\n    \"b\": 1\n\t},\n  \"c\": 2\n}\n",
    );
    let (code, err) = run(&t, "printf '{\\n\\t \"q\": 1}' > \"$1\"", "\n", true, None);
    assert_eq!(code, 0, "{err}");
    assert!(
        err.contains("ambiguous") && !err.contains("warning"),
        "{err}"
    );
    // Unrecognised input re-prompts; the second answer (4 spaces) is the
    // reference, so the tab line warns and `w` writes it.
    let amb = "{\n\t\"a\": {\n    \"b\": 1\n\t},\n  \"c\": 2\n}\n";
    let t = d.file("y.json", amb);
    let (code, err) = run(
        &t,
        "printf '{\\n\\t \"q\": 1}' > \"$1\"",
        "huh\n4\nw\n",
        true,
        None,
    );
    assert_eq!(code, 0, "{err}");
    assert_eq!(err.matches("ambiguous").count(), 2, "{err}");
    assert!(
        err.contains("warning") && err.contains("(w)rite anyway"),
        "{err}"
    );
    // EOF skips the check, as blank does.
    let t = d.file("z.json", amb);
    let (code, err) = run(&t, "printf '{\\n\\t \"q\": 1}' > \"$1\"", "", true, None);
    assert_eq!(code, 0, "{err}");
    assert!(!err.contains("warning"), "{err}");
}

#[test]
fn editor_failure_aborts_and_editor_value_splits() {
    let d = Dir::new("editorfail");
    let t = d.file("x.json", ORIG);
    let (code, err) = run(&t, "exit 3", "", false, None);
    assert_eq!(code, 1);
    assert_eq!(fs::read_to_string(&t).unwrap(), ORIG);
    fs::remove_file(kept_buffer(&err)).unwrap();
    assert_eq!(split_shell("code --wait").unwrap(), ["code", "--wait"]);
    assert_eq!(
        split_shell(r#"'/opt/my editor/bin' -a "x \"y\"" z\ w"#).unwrap(),
        ["/opt/my editor/bin", "-a", "x \"y\"", "z w"]
    );
    assert!(split_shell("'open").is_err());
}

#[test]
fn editor_args_line_hint_forms() {
    let b = Path::new("/tmp/x.jsonedit-1-0.json");
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let mut ten = vec!["vim"];
    ten.extend(["-c", "set nu"].repeat(5));
    ten.extend(["+1", "+2", "+3", "+4", "+5"]);
    // (editor, hint, expected args after the program)
    let cases: Vec<(Vec<String>, Option<usize>, Vec<&str>)> = vec![
        (s(&["vim"]), None, vec![b.to_str().unwrap()]),
        (
            s(&["vim", "-u", "NONE"]),
            Some(7),
            vec!["-u", "NONE", "+7", b.to_str().unwrap()],
        ),
        (
            s(&["/usr/bin/nano"]),
            Some(2),
            vec!["+2", b.to_str().unwrap()],
        ),
        (
            s(&["emacsclient", "-t"]),
            Some(2),
            vec!["-t", "+2", b.to_str().unwrap()],
        ),
        (s(&["hx"]), Some(4), vec!["/tmp/x.jsonedit-1-0.json:4"]),
        (
            s(&["subl", "-w"]),
            Some(4),
            vec!["-w", "/tmp/x.jsonedit-1-0.json:4"],
        ),
        (
            s(&["code", "--wait"]),
            Some(4),
            vec!["--wait", "--goto", "/tmp/x.jsonedit-1-0.json:4"],
        ),
        (
            s(&["codium", "-w"]),
            Some(4),
            vec!["-w", "--goto", "/tmp/x.jsonedit-1-0.json:4"],
        ),
        // Unknown editors, `--`, and an exhausted vim startup budget get no hint.
        (s(&["ed"]), Some(4), vec![b.to_str().unwrap()]),
        (s(&["vimx"]), Some(4), vec![b.to_str().unwrap()]),
        (s(&["vim", "--"]), Some(4), vec!["--", b.to_str().unwrap()]),
        (
            s(&["code", "--wait", "--"]),
            Some(4),
            vec!["--wait", "--", b.to_str().unwrap()],
        ),
    ];
    for (editor, hint, want) in cases {
        let got = editor_args(&editor, b, hint);
        assert_eq!(got, want, "{editor:?} {hint:?}");
    }
    // A `:` anywhere in the buffer path disables the colon forms only.
    let cb = Path::new("/tmp/a:b/x.json");
    for ed in ["hx", "subl", "code"] {
        assert_eq!(
            editor_args(&s(&[ed]), cb, Some(4)),
            [cb.as_os_str()],
            "{ed}"
        );
    }
    assert_eq!(
        editor_args(&s(&["vim"]), cb, Some(4)),
        ["+4", "/tmp/a:b/x.json"]
    );
    let ten = s(&ten);
    let got = editor_args(&ten, b, Some(7));
    assert_eq!(got.last().unwrap(), b.as_os_str());
    assert!(!got.iter().any(|a| a == "+7"), "{got:?}");
}

/// A fake editor named `vim` in `d`: call N logs its argv and copies
/// `outN` over the buffer (its last argument) and, if present, `sideN`
/// over `target` to simulate a concurrent change.
///
/// `d/vim` is a symlink to `/bin/sh` and the logic is a separate script
/// passed as the first editor argument, so no test ever exec's a file it
/// has just written (that raced a concurrent fork into ETXTBSY). With
/// `sh SCRIPT ARGS...`, `$0` is the script and `$*` is exactly the args
/// after it -- the same `$*` the old exec'd script saw.
fn fake_vim(d: &Dir, target: &Path) -> Vec<String> {
    let script = d.0.join("vim.sh");
    fs::write(
        &script,
        format!(
            "d='{d}'\nn=$(cat \"$d/count\" 2>/dev/null || echo 0); n=$((n+1)); echo $n > \"$d/count\"\n\
             echo \"call $n: $*\" >> \"$d/log\"\nfor b; do :; done\ncp \"$d/out$n\" \"$b\"\n\
             if [ -f \"$d/side$n\" ]; then cp \"$d/side$n\" '{t}'; fi\n",
            d = d.0.display(),
            t = target.display()
        ),
    )
    .unwrap();
    let vim = d.0.join("vim");
    std::os::unix::fs::symlink("/bin/sh", &vim).unwrap();
    vec![
        vim.to_str().unwrap().into(),
        script.to_str().unwrap().into(),
    ]
}

fn run_vim(target: &Path, vim: Vec<String>, answers: &str) -> (i32, String) {
    let mut env = EditEnv {
        editor: vim,
        input: Box::new(std::io::Cursor::new(answers.as_bytes().to_vec())),
        tty: true,
        tmp_dir: bufs_of(target),
    };
    let mut err = Vec::new();
    let code = edit(
        target.to_str().unwrap(),
        None,
        Some(Indent::Spaces(2)),
        &mut env,
        &mut err,
    );
    (code, String::from_utf8(err).unwrap())
}

#[test]
fn reedit_passes_line_hint_and_never_a_stale_one() {
    // Invalid -> e: the retry opens at the first diagnostic's line.
    let d = Dir::new("hint-invalid");
    let t = d.file("x.json", ORIG);
    d.file("out1", "{\n  \"a\": 1,\n  \"b\" 2\n}\n");
    let good = d.file("out2", "{\n  \"a\": 1,\n  \"b\": 3\n}\n");
    let (code, err) = run_vim(&t, fake_vim(&d, &t), "e\n");
    assert_eq!(code, 0, "{err}");
    assert_eq!(fs::read(&t).unwrap(), fs::read(&good).unwrap());
    let log = fs::read_to_string(d.0.join("log")).unwrap();
    let calls: Vec<&str> = log.lines().collect();
    assert_eq!(calls.len(), 2, "{log}");
    assert!(!calls[0].contains(" +"), "{log}");
    assert!(calls[1].starts_with("call 2: +3 /"), "{log}");

    // Indent mismatch -> e (hint = first mismatching line), then a
    // concurrent change -> e (hint cleared), then written.
    let d = Dir::new("hint-indent");
    let t = d.file("x.json", ORIG);
    d.file("out1", "{\n  \"a\": 1,\n\t\"b\": 2\n}\n");
    d.file("out2", "{\n  \"a\": 9\n}\n");
    d.file("side2", "{\"other\": 1}");
    let good = d.file("out3", "{\n  \"a\": 9\n}\n");
    let (code, err) = run_vim(&t, fake_vim(&d, &t), "e\ne\n");
    assert_eq!(code, 0, "{err}");
    assert!(err.contains("changed on disk"), "{err}");
    assert_eq!(fs::read(&t).unwrap(), fs::read(&good).unwrap());
    let log = fs::read_to_string(d.0.join("log")).unwrap();
    let calls: Vec<&str> = log.lines().collect();
    assert_eq!(calls.len(), 3, "{log}");
    assert!(!calls[0].contains(" +"), "{log}");
    assert!(calls[1].starts_with("call 2: +3 /"), "{log}");
    assert!(!calls[2].contains(" +"), "{log}");
}

#[test]
fn buffer_name_has_no_colon() {
    let d = Dir::new("colon");
    let t = d.file("a:b.json", ORIG);
    let (code, err) = run(&t, "printf '{,}' > \"$1\"", "", false, None);
    assert_eq!(code, 1);
    let b = kept_buffer(&err);
    let name = b.file_name().unwrap().to_str().unwrap().to_owned();
    assert!(
        name.starts_with("a_b.jsonedit-") && !name.contains(':'),
        "{name}"
    );
    fs::remove_file(b).unwrap();
}

/// Runs the loop with an editor that copies `new` into the buffer.
fn run_new(d: &Dir, t: &Path, new: &str, answers: &str, tty: bool) -> (i32, String) {
    let src = d.file("new", new);
    let script = format!("cp '{}' \"$1\"", src.display());
    run(t, &script, answers, tty, Some(Indent::Spaces(2)))
}

#[test]
fn fix_reindents_flagged_line_and_writes() {
    let d = Dir::new("fix");
    let t = d.file("x.json", ORIG);
    let new = "{\n  \"a\": {\n     \"z\": 0\n  },\n  \"b\": 2\n}\n";
    let (code, err) = run_new(&d, &t, new, "f\n", true);
    assert_eq!(code, 0, "{err}");
    assert!(err.contains("(f)ix indentation, (w)rite anyway"), "{err}");
    assert!(err.contains("jsonedit: re-indented line(s) 3"), "{err}");
    assert_eq!(
        fs::read_to_string(&t).unwrap(),
        "{\n  \"a\": {\n    \"z\": 0\n  },\n  \"b\": 2\n}\n"
    );
    assert_eq!(buffer_count(&bufs_of(&t)), 0);
}

#[test]
fn fix_then_abort_keeps_partially_fixed_buffer() {
    let d = Dir::new("fixabort");
    let t = d.file("x.jsonc", ORIG);
    let new = "{\n  \"a\": 1,\n   \"x\": 2,\n  /* c\n   d */\n  \"b\": 2\n}\n";
    let (code, err) = run_new(&d, &t, new, "f\na\n", true);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("warning: line(s) 3, 5 do not match"), "{err}");
    assert!(err.contains("re-indented line(s) 3\n"), "{err}");
    assert!(err.contains("warning: line(s) 5 do not match"), "{err}");
    // The second prompt has nothing fixable left.
    assert_eq!(err.matches("(f)ix").count(), 1, "{err}");
    assert_eq!(fs::read_to_string(&t).unwrap(), ORIG);
    assert_eq!(
        fs::read_to_string(kept_buffer(&err)).unwrap(),
        new.replace("   \"x\"", "  \"x\"")
    );
}

#[test]
fn fix_restoring_original_is_no_changes() {
    let d = Dir::new("fixbase");
    let t = d.file("x.json", ORIG);
    let new = ORIG.replace("  \"a\"", "   \"a\"");
    let (code, err) = run_new(&d, &t, &new, "f\n", true);
    assert_eq!(code, 0, "{err}");
    assert!(err.trim_end().ends_with("jsonedit: no changes"), "{err}");
    assert_eq!(fs::read_to_string(&t).unwrap(), ORIG);
    assert_eq!(buffer_count(&bufs_of(&t)), 0);
}

#[test]
fn non_tty_mismatch_writes_verbatim_without_fix() {
    let d = Dir::new("fixnotty");
    let t = d.file("x.json", ORIG);
    let new = ORIG.replace("  \"a\"", "   \"a\"").replace("2\n", "3\n");
    let (code, err) = run_new(&d, &t, &new, "f\n", false);
    assert_eq!(code, 0, "{err}");
    assert!(err.contains("warning: line(s) 2 do not match"), "{err}");
    assert!(
        !err.contains("(f)ix") && !err.contains("re-indented"),
        "{err}"
    );
    assert_eq!(fs::read_to_string(&t).unwrap(), new);
}
