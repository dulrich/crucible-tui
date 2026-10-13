//! Black-box CLI tests over the built binary (WP-8 of `plans/mdview-rust-port.md`): exit
//! codes, the BrokenPipe rule, the renderer-pending exit, and `highlight-as` on disk. Every
//! run points `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME` at a temp dir.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

fn sandbox(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mdview-cli-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn mdview(dir: &PathBuf, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mdview"))
        .args(args)
        .env_clear()
        .env("HOME", dir)
        .env("XDG_CONFIG_HOME", dir)
        .env("XDG_CACHE_HOME", dir)
        .env("MDVIEW_AMBIGUOUS", "narrow")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn fixture(name: &str) -> String {
    format!("{}/../../tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn help_and_licenses_exit_zero() {
    let d = sandbox("help");
    let out = mdview(&d, &["--help"]);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("usage: mdview <file.md>"));
    let out = mdview(&d, &["--licenses"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(
        out.stdout,
        std::fs::read(format!(
            "{}/../../THIRD-PARTY-LICENSES.txt",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap()
    );
}

#[test]
fn usage_errors_are_one_line_exit_one() {
    let d = sandbox("usage");
    let out = mdview(&d, &["--bogus"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(out.stderr, b"mdview: unknown argument: --bogus\n");
    assert!(out.stdout.is_empty());
    let out = mdview(&d, &["help", "nope"]);
    assert_eq!(out.status.code(), Some(1));
}

#[test]
fn missing_file_reports_node_wording() {
    let d = sandbox("missing");
    let out = mdview(&d, &["/nonexistent-mdview/x.md"]);
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(
        String::from_utf8_lossy(&out.stderr),
        "mdview: cannot read file: /nonexistent-mdview/x.md (No such file or directory (os error 2))\n"
    );
}

#[test]
fn check_renders_the_wide_table_and_exits_zero() {
    let d = sandbox("render");
    let out = mdview(&d, &["--check", "--width", "80", &fixture("wide-table.md")]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!out.stdout.is_empty());
}

#[test]
fn broken_pipe_is_quiet_success() {
    let d = sandbox("pipe");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mdview"))
        .arg("--licenses")
        .env_clear()
        .env("HOME", &d)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn highlight_as_writes_then_updates_config() {
    let d = sandbox("hl");
    let out = mdview(&d, &["highlight-as", "DataView", "javascript"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let path = d.join("mdview/config.json");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        format!(
            "mdview: created config at {} — \"dataview\" now highlights as \"javascript\"\n",
            path.display()
        )
    );
    let out = mdview(&d, &["highlight-as", "tasks", "sql"]);
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("mdview: updated config"));
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "{\n  \"highlightAs\": {\n    \"dataview\": \"javascript\",\n    \"tasks\": \"sql\"\n  }\n}\n"
    );
    let out = mdview(&d, &["highlight-as", "x", "nosuchlang"]);
    assert_eq!(out.status.code(), Some(1));
    let out = mdview(&d, &["highlight-as", "x"]);
    assert!(String::from_utf8_lossy(&out.stderr).contains("got 1"));
}

#[test]
fn probe_report_is_deterministic_when_piped() {
    let d = sandbox("probe");
    let out = mdview(&d, &["probe"]);
    assert_eq!(out.status.code(), Some(0));
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("  decided by       env\n"), "{text}");
    assert!(text.contains("  stdin is a TTY   no\n"));
    let out = mdview(&d, &["probe", "--timeout"]);
    assert_eq!(
        out.stderr,
        b"mdview: probe: --timeout must be a positive number of milliseconds, got: undefined\n"
    );
}
