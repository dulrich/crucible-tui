//! The XDG config load, the `color`/`hyperlinks` directives and the `highlight-as` write
//! path, ported behaviourally from `TS_BASELINE` `src/config.ts` (WP-8 of `plans/mdview-rust-port.md`).
//!
//! Reading is lenient, writing refuses (`crates/mdview/AGENTS.md`, "Command-line surface"): a malformed
//! file degrades to defaults with one stderr notice, a bad entry is dropped individually, but
//! `highlight-as` refuses to write into a file it cannot parse.
//!
//! Two JS behaviours are reproduced deliberately, because they decide bytes:
//! - **property order** (`Object.entries`/`JSON.stringify`): array-index keys first, ascending,
//!   then every other key in insertion order — `js_key_order`;
//! - **`JSON.stringify(v, null, 2)`**: numbers through `ryu-js` (`1.0` prints `1`), the JS
//!   string escape set, `[]`/`{}` for empty containers — `js_stringify`.
//!
//! One residual, named: a `JSON.parse` failure message is JavaScriptCore's own wording in TS
//! and serde_json's here, so the *text* of "ignoring malformed config … : <reason>" and of
//! "existing file is not valid JSON (<reason>)" differs; every other message is identical.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::colour::{ColourDirective, Env, parse_colour_directive};
use crate::fsutil::{home_dir, write_atomic};

/// `MdviewConfig`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MdviewConfig {
    /// Read leniently and otherwise ignored by the viewer (the sweep's manifest pointer).
    pub corpus_manifest: Option<String>,
    pub highlight_as: Option<BTreeMap<String, String>>,
    pub emoji: Option<bool>,
    pub color: Option<ColourDirective>,
    pub hyperlinks: Option<ColourDirective>,
}

/// `resolveConfigPath()`: `$XDG_CONFIG_HOME/mdview/config.json`, else `~/.config/...`.
pub fn resolve_config_path(env: &Env) -> PathBuf {
    let config_home = match env.get("XDG_CONFIG_HOME") {
        Some(x) if !x.is_empty() => PathBuf::from(x),
        _ => Path::new(&home_dir(env)).join(".config"),
    };
    config_home.join("mdview").join("config.json")
}

/// Whether `key` is a JS array index (canonical decimal, `< 2^32 - 1`).
fn is_array_index(key: &str) -> bool {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) {
        return false;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

/// JS own-property order: array-index keys ascending, then the rest in insertion order.
pub fn js_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indices: Vec<(&String, &Value)> =
        map.iter().filter(|(k, _)| is_array_index(k)).collect();
    indices.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));
    indices.extend(map.iter().filter(|(k, _)| !is_array_index(k)));
    indices
}

/// `JSON.stringify(string)`.
pub fn js_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn js_number(n: &serde_json::Number) -> String {
    let f = n.as_f64().unwrap_or(f64::NAN);
    if !f.is_finite() {
        return "null".into();
    }
    ryu_js::Buffer::new().format(f).to_owned()
}

fn stringify_into(value: &Value, indent: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => out.push_str(&js_quote(s)),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&" ".repeat(indent + 2));
                stringify_into(item, indent + 2, out);
            }
            out.push('\n');
            out.push_str(&" ".repeat(indent));
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (k, v)) in js_key_order(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('\n');
                out.push_str(&" ".repeat(indent + 2));
                out.push_str(&js_quote(k));
                out.push_str(": ");
                stringify_into(v, indent + 2, out);
            }
            out.push('\n');
            out.push_str(&" ".repeat(indent));
            out.push('}');
        }
    }
}

/// `JSON.stringify(value, null, 2)`.
pub fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    stringify_into(value, 0, &mut out);
    out
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn validate_highlight_as(
    value: &Value,
    path: &str,
    warn: &mut dyn FnMut(&str),
) -> Option<BTreeMap<String, String>> {
    let Value::Object(map) = value else {
        warn(&format!(
            "mdview: ignoring malformed \"highlightAs\" at {path}: expected an object mapping fence language to highlighter language"
        ));
        return None;
    };
    let mut valid = BTreeMap::new();
    let mut bad: Vec<String> = Vec::new();
    for (key, entry) in js_key_order(map) {
        match entry {
            Value::String(s)
                if !crate::text::js_trim(s).is_empty() && !crate::text::js_trim(key).is_empty() =>
            {
                valid.insert(
                    crate::text::js_trim(key).to_lowercase(),
                    crate::text::js_trim(s).to_lowercase(),
                );
            }
            _ => bad.push(js_quote(key)),
        }
    }
    if !bad.is_empty() {
        warn(&format!(
            "mdview: ignoring malformed \"highlightAs\" entries at {path}: non-string or empty value(s) for {}",
            bad.join(", ")
        ));
    }
    (!valid.is_empty()).then_some(valid)
}

/// `loadConfig(path)`. `warn` receives each notice without its trailing newline.
pub fn load_config(path: &Path, warn: &mut dyn FnMut(&str)) -> MdviewConfig {
    let Some(raw) = read_text(path) else {
        return MdviewConfig::default();
    };
    let shown = path.to_string_lossy().into_owned();
    let record = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            warn(&format!(
                "mdview: ignoring malformed config at {shown}: expected a JSON object"
            ));
            return MdviewConfig::default();
        }
        Err(e) => {
            warn(&format!(
                "mdview: ignoring malformed config at {shown}: {e}"
            ));
            return MdviewConfig::default();
        }
    };
    let mut config = MdviewConfig::default();
    if let Some(Value::String(m)) = record.get("corpusManifest")
        && !m.is_empty()
    {
        config.corpus_manifest = Some(m.clone());
    }
    if let Some(h) = record.get("highlightAs") {
        config.highlight_as = validate_highlight_as(h, &shown, warn);
    }
    if let Some(e) = record.get("emoji") {
        match e {
            Value::Bool(b) => config.emoji = Some(*b),
            _ => warn(&format!(
                "mdview: ignoring malformed \"emoji\" at {shown}: expected a boolean"
            )),
        }
    }
    for (key, slot) in [
        ("color", &mut config.color),
        ("hyperlinks", &mut config.hyperlinks),
    ] {
        if let Some(v) = record.get(key) {
            let parsed = match v {
                Value::String(s) => parse_colour_directive(Some(s)),
                _ => None,
            };
            match parsed {
                Some(d) => *slot = Some(d),
                None => warn(&format!(
                    "mdview: ignoring malformed \"{key}\" at {shown}: expected auto, always or never"
                )),
            }
        }
    }
    config
}

/// `WriteHighlightAliasResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteHighlightAliasResult {
    pub path: PathBuf,
    pub created: bool,
}

/// JS `typeof` for a parsed JSON value (`null` is `"object"`, as in JS).
fn js_typeof(v: &Value) -> &'static str {
    match v {
        Value::Null | Value::Object(_) | Value::Array(_) => "object",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
    }
}

/// `writeHighlightAlias(fence, language, path)`: atomic, touching only `highlightAs[fence]`.
pub fn write_highlight_alias(
    fence: &str,
    language: &str,
    path: &Path,
) -> Result<WriteHighlightAliasResult, String> {
    let normalized_fence = crate::text::js_trim(fence).to_lowercase();
    let normalized_language = crate::text::js_trim(language).to_lowercase();
    if normalized_fence.is_empty() {
        return Err("highlight-as: <fence> must not be empty".into());
    }
    if normalized_language.is_empty() {
        return Err("highlight-as: <language> must not be empty".into());
    }
    let shown = path.to_string_lossy().into_owned();
    let existing = read_text(path);
    let mut raw: Map<String, Value> = Map::new();
    if let Some(text) = &existing {
        let parsed: Value = serde_json::from_str(text).map_err(|e| {
            format!(
                "refusing to update config at {shown}: existing file is not valid JSON ({e}). Fix or remove it, then re-run `mdview highlight-as`."
            )
        })?;
        match parsed {
            Value::Object(map) => raw = map,
            other => {
                let found = if other.is_array() {
                    "an array"
                } else {
                    js_typeof(&other)
                };
                return Err(format!(
                    "refusing to update config at {shown}: expected a JSON object at the top level, found {found}."
                ));
            }
        }
    }
    let mut highlight_as = Map::new();
    if let Some(Value::Object(existing_map)) = raw.get("highlightAs") {
        for (k, v) in js_key_order(existing_map) {
            if v.is_string() {
                highlight_as.insert(k.clone(), v.clone());
            }
        }
    }
    highlight_as.insert(normalized_fence, Value::String(normalized_language));
    // `{ ...raw, highlightAs }`: an existing key keeps its position, a new one is appended.
    raw.insert("highlightAs".into(), Value::Object(highlight_as));
    let serialized = format!("{}\n", js_stringify(&Value::Object(raw)));

    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    write_atomic(path, serialized.as_bytes()).map_err(|e| e.to_string())?;
    Ok(WriteHighlightAliasResult {
        path: path.to_path_buf(),
        created: existing.is_none(),
    })
}

/// Where the corpus manifest came from (`ManifestSource`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestSource {
    Env,
    Config,
    Bundled,
}

/// `resolveCorpusManifestPath`; the bundled default is relative to the repository root.
pub fn resolve_corpus_manifest_path(config: &MdviewConfig, env: &Env) -> (String, ManifestSource) {
    if let Some(e) = env.get("MDVIEW_CORPUS_MANIFEST")
        && !e.is_empty()
    {
        return (e.clone(), ManifestSource::Env);
    }
    if let Some(c) = &config.corpus_manifest
        && !c.is_empty()
    {
        return (c.clone(), ManifestSource::Config);
    }
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../corpus/default-manifest.json"
        )
        .into(),
        ManifestSource::Bundled,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mdview-config-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("mdview").join("config.json")
    }

    fn load(text: &str, name: &str) -> (MdviewConfig, Vec<String>) {
        let p = tmp(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        let mut w = Vec::new();
        let c = load_config(&p, &mut |m| w.push(m.to_owned()));
        (c, w)
    }

    #[test]
    fn config_path_prefers_xdg_and_ignores_empty() {
        let mut env = Env::new();
        env.insert("XDG_CONFIG_HOME".into(), "/home/example/xdg".into());
        assert_eq!(
            resolve_config_path(&env),
            PathBuf::from("/home/example/xdg/mdview/config.json")
        );
        env.insert("XDG_CONFIG_HOME".into(), String::new());
        assert!(resolve_config_path(&env).ends_with(".config/mdview/config.json"));
    }

    #[test]
    fn missing_file_is_silent_defaults() {
        let p = tmp("missing");
        let mut w = Vec::new();
        assert_eq!(
            load_config(&p, &mut |m| w.push(m.to_owned())),
            MdviewConfig::default()
        );
        assert!(w.is_empty());
    }

    #[test]
    fn valid_keys_load_and_normalize() {
        let (c, w) = load(
            r#"{"highlightAs":{" Tasks ":" Python "},"emoji":false,"color":"never","hyperlinks":"always","corpusManifest":"m.json"}"#,
            "valid",
        );
        assert!(w.is_empty());
        assert_eq!(
            c.highlight_as.unwrap().get("tasks").map(String::as_str),
            Some("python")
        );
        assert_eq!(c.emoji, Some(false));
        assert_eq!(c.color, Some(ColourDirective::Never));
        assert_eq!(c.hyperlinks, Some(ColourDirective::Always));
        assert_eq!(c.corpus_manifest.as_deref(), Some("m.json"));
    }

    #[test]
    fn bad_entries_are_dropped_individually_in_js_key_order() {
        let (c, w) = load(
            r#"{"highlightAs":{"b":1,"a":"sql","2":"","1":" "},"emoji":"yes","color":3}"#,
            "bad",
        );
        assert_eq!(c.highlight_as.unwrap().len(), 1);
        assert!(
            w[0].ends_with(r#"non-string or empty value(s) for "1", "2", "b""#),
            "{w:?}"
        );
        assert!(w[1].contains("\"emoji\"") && w[1].ends_with("expected a boolean"));
        assert!(w[2].contains("\"color\"") && w[2].ends_with("expected auto, always or never"));
    }

    #[test]
    fn non_object_degrades_with_notice() {
        let (c, w) = load("[1]", "array");
        assert_eq!(c, MdviewConfig::default());
        assert!(w[0].ends_with(": expected a JSON object"));
        let (_, w) = load(r#"{"highlightAs":"x"}"#, "hlstring");
        assert!(w[0].contains("expected an object mapping fence language"));
    }

    #[test]
    fn stringify_matches_js() {
        let v = json!({"b": 1.0, "10": [], "a": {}, "2": [1.5, null, true, "q\"\u{1}\n"]});
        assert_eq!(
            js_stringify(&v),
            "{\n  \"2\": [\n    1.5,\n    null,\n    true,\n    \"q\\\"\\u0001\\n\"\n  ],\n  \"10\": [],\n  \"b\": 1,\n  \"a\": {}\n}"
        );
    }

    #[test]
    fn write_creates_then_updates_preserving_other_keys() {
        let p = tmp("write");
        let r = write_highlight_alias(" DataViewJS ", "JavaScript", &p).unwrap();
        assert!(r.created);
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "{\n  \"highlightAs\": {\n    \"dataviewjs\": \"javascript\"\n  }\n}\n"
        );
        std::fs::write(
            &p,
            r#"{"emoji":true,"highlightAs":{"x":1,"dataviewjs":"sql"},"z":2.0}"#,
        )
        .unwrap();
        let r = write_highlight_alias("tasks", "sql", &p).unwrap();
        assert!(!r.created);
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "{\n  \"emoji\": true,\n  \"highlightAs\": {\n    \"dataviewjs\": \"sql\",\n    \"tasks\": \"sql\"\n  },\n  \"z\": 2\n}\n"
        );
    }

    #[test]
    fn write_refuses_unparseable_and_non_objects() {
        let p = tmp("refuse");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{nope").unwrap();
        let e = write_highlight_alias("a", "sql", &p).unwrap_err();
        assert!(e.starts_with("refusing to update config at ") && e.contains("not valid JSON"));
        for (text, found) in [
            ("[]", "an array"),
            ("null", "object"),
            ("3", "number"),
            ("\"s\"", "string"),
        ] {
            std::fs::write(&p, text).unwrap();
            let e = write_highlight_alias("a", "sql", &p).unwrap_err();
            assert!(e.ends_with(&format!("found {found}.")), "{e}");
        }
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "\"s\"");
        assert_eq!(
            write_highlight_alias("  ", "sql", &p).unwrap_err(),
            "highlight-as: <fence> must not be empty"
        );
    }

    #[test]
    fn manifest_precedence() {
        let mut env = Env::new();
        let mut c = MdviewConfig::default();
        assert_eq!(
            resolve_corpus_manifest_path(&c, &env).1,
            ManifestSource::Bundled
        );
        c.corpus_manifest = Some("c.json".into());
        assert_eq!(
            resolve_corpus_manifest_path(&c, &env).1,
            ManifestSource::Config
        );
        env.insert("MDVIEW_CORPUS_MANIFEST".into(), "e.json".into());
        assert_eq!(
            resolve_corpus_manifest_path(&c, &env),
            ("e.json".into(), ManifestSource::Env)
        );
    }
}
