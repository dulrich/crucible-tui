//! The golden-file loader (WP-1 of `plans/mdview-rust-port.md`): every file under
//! `tests/golden/` is JSONL with a header line recording the TS sha it was captured from.
//! Later work packages replay these records through `mdview::render`; WP-1 only proves the
//! files load and are well-formed.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// One golden file: its header object and its records.
pub struct GoldenFile {
    pub header: Value,
    pub records: Vec<Value>,
}

/// Load one golden JSONL file: line 1 is `{"header": {...}}`, every other line a record.
pub fn load_golden(path: &Path) -> Result<GoldenFile, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut lines = text.lines().filter(|l| !l.is_empty());
    let first = lines
        .next()
        .ok_or_else(|| format!("{}: empty", path.display()))?;
    let header: Value =
        serde_json::from_str(first).map_err(|e| format!("{}: header: {e}", path.display()))?;
    let header = header
        .get("header")
        .cloned()
        .ok_or_else(|| format!("{}: first line is not a header", path.display()))?;
    let records = lines
        .enumerate()
        .map(|(i, l)| {
            serde_json::from_str(l).map_err(|e| format!("{}:{}: {e}", path.display(), i + 2))
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(GoldenFile { header, records })
}

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

#[test]
fn every_golden_file_loads_with_a_ts_sha_header() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(golden_dir())
        .expect("tests/golden exists")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    assert!(
        files.len() >= 2,
        "expected render.jsonl and parity-tables.jsonl, found {files:?}"
    );
    for path in files {
        let golden = load_golden(&path).unwrap_or_else(|e| panic!("{e}"));
        let sha = golden
            .header
            .get("tsSha")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_eq!(
            sha.len(),
            40,
            "{}: header tsSha must be a full git sha",
            path.display()
        );
        assert!(!golden.records.is_empty(), "{}: no records", path.display());
    }
}

#[test]
fn render_records_carry_every_replay_input() {
    let golden = load_golden(&golden_dir().join("render.jsonl")).unwrap_or_else(|e| panic!("{e}"));
    for record in &golden.records {
        for key in [
            "source",
            "width",
            "tier",
            "ambiguous",
            "policy",
            "text",
            "codeRanges",
        ] {
            assert!(record.get(key).is_some(), "render record missing {key}");
        }
    }
}

#[test]
fn a_malformed_golden_line_is_an_error_not_a_skip() {
    let dir = std::env::temp_dir().join(format!("mdview-golden-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("bad.jsonl");
    std::fs::write(&path, "{\"header\":{\"tsSha\":\"x\"}}\n{not json\n").expect("write");
    assert!(load_golden(&path).is_err());
    std::fs::remove_dir_all(&dir).expect("cleanup");
}
