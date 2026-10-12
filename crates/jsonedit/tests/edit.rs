//! The safe-edit loop, driven by a scripted editor (a `sh -c` one-liner that
//! rewrites the buffer) and scripted prompt input. Every test works in its
//! own fresh temp dir.

use jsonedit::edit::{EditEnv, edit, split_shell};
use jsonedit::{Dialect, Indent};
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
        let buffers: Vec<_> = fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("x.jsonedit-{}-", std::process::id()))
            })
            .collect();
        if kept {
            let b = kept_buffer(&err);
            assert!(b.exists() && b.extension().unwrap() == "json", "{err}");
            assert_eq!(
                fs::metadata(&b).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::remove_file(b).unwrap();
        } else {
            assert!(!err.contains("buffer kept"), "{err}");
            let _ = buffers;
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
    let _ = Dialect::Json;
}
