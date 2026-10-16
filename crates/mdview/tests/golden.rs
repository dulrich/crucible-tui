//! The golden files: `tests/golden/render.jsonl` is a Rust-renderer snapshot (re-baselined by
//! WP-1 of `plans/rust-port-stage-3.md`), JSONL with a provenance header line. The replay is
//! exact; `regenerate_render_golden` (ignored by default) is the only way to re-capture it.

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
fn the_golden_set_is_render_jsonl_with_a_rust_provenance_header() {
    let mut files: Vec<PathBuf> = std::fs::read_dir(golden_dir())
        .expect("tests/golden exists")
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![golden_dir().join("render.jsonl")],
        "the golden set is exactly render.jsonl"
    );
    let golden = load_golden(&files[0]).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        golden.header["engine"], "rust",
        "header engine must be rust"
    );
    let sha = golden.header["capturedAt"].as_str().unwrap_or("");
    assert!(
        sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
        "header capturedAt must be a full git sha, got {sha:?}"
    );
    assert_eq!(
        golden.header["records"].as_u64(),
        Some(golden.records.len() as u64),
        "header records must equal the record count"
    );
    assert!(
        golden.header["protocol"].is_string(),
        "header protocol missing"
    );
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
    std::fs::write(&path, "{\"header\":{\"engine\":\"rust\"}}\n{not json\n").expect("write");
    assert!(load_golden(&path).is_err());
    std::fs::remove_dir_all(&dir).expect("cleanup");
}

/// The golden replay: every `render.jsonl` record must match `text` and `codeRanges` exactly.
/// No relaxation, no allowlist, nothing skipped.
#[test]
fn golden_render_replay() {
    let golden = load_golden(&golden_dir().join("render.jsonl")).unwrap_or_else(|e| panic!("{e}"));
    let mut matched = 0usize;
    let mut failures = Vec::new();
    for (i, record) in golden.records.iter().enumerate() {
        let source = record["source"].as_str().expect("source");
        let options = mdview::parity::parse_options(record)
            .unwrap_or_else(|e| panic!("malformed golden record: {e}: {record}"));
        let line = i + 2;
        match mdview::render::render(source, &options) {
            Err(e) => failures.push(format!("line {line} error {e}")),
            Ok(out) => {
                let ranges: Vec<(usize, usize)> =
                    serde_json::from_value(record["codeRanges"].clone()).expect("codeRanges");
                let want = record["text"].as_str().unwrap_or_default();
                if out.text == want && out.code_ranges == ranges {
                    matched += 1;
                } else {
                    failures.push(format!(
                        "line {line} width={} {:?}\n  want {want:?} {ranges:?}\n  got  {:?} {:?}",
                        options.width,
                        source.chars().take(160).collect::<String>(),
                        out.text,
                        out.code_ranges
                    ));
                }
            }
        }
    }
    println!(
        "golden replay: records={} matched={matched} failed={}",
        golden.records.len(),
        failures.len()
    );
    assert!(matched > 0, "golden replay matched 0 records");
    assert!(
        failures.is_empty(),
        "{} record(s) diverge:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Re-capture `render.jsonl` from the current renderer. Never runs under default `cargo test`;
/// run it deliberately (see `tests/golden/README.md`) -- a re-capture is a reviewed behaviour
/// change. Each record's `source` and option fields are kept byte-for-byte (the line prefix up
/// to `,"text":`); only `text` and `codeRanges` are re-rendered. The header records the commit
/// the tree was captured at.
#[test]
#[ignore = "rewrites tests/golden/render.jsonl; run deliberately"]
fn regenerate_render_golden() {
    let path = golden_dir().join("render.jsonl");
    let old = std::fs::read_to_string(&path).expect("render.jsonl");
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("git rev-parse");
    let sha = String::from_utf8(sha.stdout)
        .expect("utf8")
        .trim()
        .to_owned();
    assert_eq!(sha.len(), 40, "git rev-parse HEAD gave {sha:?}");
    let mut body = String::new();
    let mut count = 0usize;
    for line in old.lines().skip(1).filter(|l| !l.is_empty()) {
        let record: Value = serde_json::from_str(line).expect("record");
        let source = record["source"].as_str().expect("source");
        let options = mdview::parity::parse_options(&record).expect("options");
        let out = mdview::render::render(source, &options).expect("render");
        let cut = line.find(",\"text\":").expect("record has text");
        body.push_str(&line[..cut]);
        body.push_str(",\"text\":");
        body.push_str(&serde_json::to_string(&out.text).expect("text"));
        body.push_str(",\"codeRanges\":");
        body.push_str(&serde_json::to_string(&out.code_ranges).expect("ranges"));
        body.push_str("}\n");
        count += 1;
    }
    let header = serde_json::json!({"header": {
        "kind": "render",
        "engine": "rust",
        "capturedAt": sha,
        "records": count,
        "protocol": "one record per line: {source, width, tier, ambiguous, emoji, policy, text, codeRanges}; text and codeRanges are mdview::render::render output"
    }});
    std::fs::write(&path, format!("{header}\n{body}")).expect("write render.jsonl");
    println!("regenerated {count} records at {sha}");
}
