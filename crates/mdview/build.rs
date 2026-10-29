//! Builds the syntax set the highlighter loads: two-face's extended set (newline variant) plus
//! every vendored `.sublime-syntax` under `syntaxes/`, dumped to `$OUT_DIR/syntaxes.bin`.
//! Reads only `syntaxes/`, writes only `OUT_DIR`, never touches the network.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use syntect::parsing::SyntaxDefinition;

fn main() {
    emit_build_id();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("syntaxes");
    println!("cargo:rerun-if-changed={}", dir.display());

    let mut grammars: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("read syntaxes/")
        .map(|e| e.expect("read syntaxes/ entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "sublime-syntax"))
        .collect();
    grammars.sort();

    let mut builder = two_face::syntax::extra_newlines().into_builder();
    for path in &grammars {
        println!("cargo:rerun-if-changed={}", path.display());
        let src = std::fs::read_to_string(path).expect("read grammar");
        let name = path.file_stem().and_then(|s| s.to_str());
        let def = SyntaxDefinition::load_from_str(&src, true, name)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        builder.add(def);
    }
    let set = builder.build();

    // Uncompressed, as two-face ships its own set: each syntax's lazy contexts are already
    // compressed inside the dump, and an outer zlib pass cost ~13 ms per colour-on fenced render.
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("syntaxes.bin");
    syntect::dumps::dump_to_uncompressed_file(&set, out).expect("write syntaxes.bin");
}

// Fleet build-id helper, merged from the fleet build-id.rs template
// (`fn main` renamed `emit_build_id`; the shared `use std::path` line is the one above).
fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

#[rustfmt::skip]
fn build_id(dir: &Path) -> String {
    let dir = match std::fs::canonicalize(dir) {
        Ok(d) => d,
        Err(_) => return "unknown".into(),
    };
    let top = match git(&dir, &["rev-parse", "--show-toplevel"]) {
        Some(t) if !t.trim().is_empty() => PathBuf::from(t.trim()),
        _ => return "unknown".into(),
    };
    let mut tool = top.clone();
    let mut d: &Path = &dir;
    while d.starts_with(&top) {
        if std::fs::symlink_metadata(d.join("AGENTS.md")).is_ok() {
            tool = d.to_path_buf();
            break;
        }
        match d.parent() {
            Some(p) if d != top => d = p,
            _ => break,
        }
    }
    let tool_s = tool.to_string_lossy().into_owned();
    let sha = git(&top, &["log", "-1", "--format=%H", "--", &tool_s]).map(|s| s.trim().to_string()).unwrap_or_default();
    if sha.is_empty() {
        return "unknown".into();
    }
    let dirty = git(&top, &["status", "--porcelain", "--untracked-files=no", "--", &tool_s]).is_some_and(|s| !s.trim().is_empty());
    if dirty { format!("{sha}-dirty") } else { sha }
}

#[rustfmt::skip]
fn emit_build_id() {
    println!("cargo:rerun-if-env-changed=GIT_SHA");
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    for p in ["HEAD", "index"] {
        if let Some(gp) = git(&manifest, &["rev-parse", "--path-format=absolute", "--git-path", p]) {
            println!("cargo:rerun-if-changed={}", gp.trim());
        }
    }
    let id = match std::env::var("GIT_SHA") {
        Ok(s) if !s.is_empty() => s,
        _ => build_id(&manifest),
    };
    println!("cargo:rustc-env=FLEET_BUILD_ID={id}");
}
