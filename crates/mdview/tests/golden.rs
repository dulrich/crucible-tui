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

/// FNV-1a 64 over the source bytes, as 16 hex digits: the allowlist's key. (No hash crate is
/// pinned; this is an identifier, not a security boundary.)
fn source_hash(source: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in source.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// `golden-allowlist.txt`: `<fnv64 source hash> <registry id> <note>`; `#` comments and
/// blank lines ignored.
fn load_allowlist() -> std::collections::HashMap<String, String> {
    let text = std::fs::read_to_string(golden_dir().join("golden-allowlist.txt"))
        .expect("tests/golden/golden-allowlist.txt exists");
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let mut parts = l.splitn(3, ' ');
            let hash = parts.next().unwrap_or_default().to_owned();
            let id = parts.next().unwrap_or_default().to_owned();
            assert!(
                !id.is_empty(),
                "allowlist line names no registry entry: {l}"
            );
            (hash, id)
        })
        .collect()
}

/// D-C (WP-6a): colour-on fenced output is judged with SGR stripped. Same line count; every
/// line outside a code range byte-identical; every line inside one equal once SGR is stripped.
fn dc_equal(want: &str, got: &str, ranges: &[(usize, usize)]) -> bool {
    let (w, g): (Vec<&str>, Vec<&str>) = (want.split('\n').collect(), got.split('\n').collect());
    w.len() == g.len()
        && w.iter().zip(&g).enumerate().all(|(i, (a, b))| {
            a == b
                || (ranges.iter().any(|&(s, e)| (s..=e).contains(&(i + 1)))
                    && mdview::list_lines::strip_ansi(a) == mdview::list_lines::strip_ansi(b))
        })
}

/// WP-3's golden replay: every `render.jsonl` record either matches `text` and `codeRanges`
/// exactly or is allowlisted by source hash
/// against a named registry entry. Nothing is skipped silently.
#[test]
fn golden_render_replay() {
    let golden = load_golden(&golden_dir().join("render.jsonl")).unwrap_or_else(|e| panic!("{e}"));
    let allowlist = load_allowlist();
    let mut matched = 0usize;
    let mut dc_relaxed = 0usize;
    let mut allowlisted = 0usize;
    let mut used = std::collections::HashSet::new();
    let mut failures = Vec::new();
    for record in &golden.records {
        let source = record["source"].as_str().expect("source");
        let options = mdview::parity::parse_options(record)
            .unwrap_or_else(|e| panic!("malformed golden record: {e}: {record}"));
        let hash = source_hash(source);
        match mdview::render::render(source, None, &options) {
            Err(e) => failures.push(format!("{hash} error {e}")),
            Ok(out) => {
                let ranges: Vec<(usize, usize)> =
                    serde_json::from_value(record["codeRanges"].clone()).expect("codeRanges");
                let want = record["text"].as_str().unwrap_or_default();
                if out.text == want && out.code_ranges == ranges {
                    matched += 1;
                } else if options.policy.sgr == mdview::render::Sgr::Full
                    && out.code_ranges == ranges
                    && dc_equal(want, &out.text, &ranges)
                {
                    dc_relaxed += 1;
                } else if allowlist.contains_key(&hash) {
                    allowlisted += 1;
                    used.insert(hash);
                } else {
                    failures.push(format!(
                        "{hash} width={} {:?}\n  want {want:?} {ranges:?}\n  got  {:?} {:?}",
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
        "golden replay: records={} matched={matched} dc-relaxed={dc_relaxed} allowlisted={allowlisted} failed={}",
        golden.records.len(),
        failures.len()
    );
    let stale: Vec<&String> = allowlist.keys().filter(|h| !used.contains(*h)).collect();
    assert!(
        stale.is_empty(),
        "allowlist entries matched nothing: {stale:?}"
    );
    assert!(matched > 0, "golden replay matched 0 records");
    assert!(
        failures.is_empty(),
        "{} record(s) diverge:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
