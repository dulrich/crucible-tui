//! YAML frontmatter split and metadata block, ported from `src/frontmatter.ts`.
//!
//! WP-3 of `plans/mdview-rust-port.md`. The YAML is read with yaml-rust2's **event-level**
//! `Parser`, and the value `yaml@2.9.0`'s `parse` would hand `src/frontmatter.ts` is rebuilt here
//! as a [`JsValue`]: the core-schema plain-scalar resolution (`node_modules/yaml/dist/schema/core/`,
//! `node_modules/yaml/dist/schema/common/null.js`), `uniqueKeys`' duplicate test (`node_modules/yaml/dist/compose/util-map-includes.js`), the JS
//! object key (`node_modules/yaml/dist/nodes/addPairToJSMap.js`'s `stringifyKey`) and `Object.keys` order (integer-like
//! keys ascending first). Formatting then follows `src/frontmatter.ts` line by line, with
//! ECMAScript `String(number)` and `JSON.stringify` transcribed below.
//!
//! The one allowed difference is D-A: a failed parse's diagnostic text is yaml-rust2's message,
//! not `yaml`'s. Whether a block parses, the echo and the verbatim range bookkeeping are exact.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

use crate::render::RenderError;
use crate::style::{SgrMode, StyleName, create_styler, style_span};
use crate::text::{JS_WS_CLASS, js_trim, js_trim_end, utf16_len};
use crate::width::Measure;

static FIRST_KEY_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[^{JS_WS_CLASS}:#][^:\n]*:(?:[{JS_WS_CLASS}]|$)"
    ))
    .expect("first-key regex compiles")
});

fn looks_like_yaml_block(candidate: &str) -> bool {
    candidate
        .split('\n')
        .find(|line| !js_trim(line).is_empty())
        .is_some_and(|line| FIRST_KEY_LINE.is_match(js_trim(line)))
}

fn normalize_line_endings(block: &str) -> String {
    let s = block.replace("\r\n", "\n");
    match s.strip_suffix('\r') {
        Some(t) => t.to_owned(),
        None => s,
    }
}

fn strip_cr(s: &str) -> &str {
    s.strip_suffix('\r').unwrap_or(s)
}

/// `splitFrontmatter`: `(meta, body)`.
pub fn split_frontmatter(source: &str) -> (Option<String>, &str) {
    let Some(first_newline) = source.find('\n') else {
        return (None, source);
    };
    if strip_cr(&source[..first_newline]) != "---" {
        return (None, source);
    }
    let yaml_start = first_newline + 1;
    let mut line_start = yaml_start;
    while line_start <= source.len() {
        let next_newline = source[line_start..].find('\n').map(|i| i + line_start);
        let line_end = next_newline.unwrap_or(source.len());
        let line = strip_cr(&source[line_start..line_end]);
        if line == "---" {
            let yaml_end = if line_start > yaml_start && source.as_bytes()[line_start - 1] == b'\n'
            {
                line_start - 1
            } else {
                line_start
            };
            let candidate = &source[yaml_start..yaml_end];
            if !looks_like_yaml_block(candidate) {
                break;
            }
            let body = next_newline.map_or("", |n| &source[n + 1..]);
            return (Some(normalize_line_endings(candidate)), body);
        }
        match next_newline {
            None => break,
            Some(n) => line_start = n + 1,
        }
    }
    (None, source)
}

/// `MetaBlockResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaBlockResult {
    pub text: String,
    pub verbatim_ranges: Vec<(usize, usize)>,
}

// ---------------------------------------------------------------------------------------------
// The JS value `yaml`'s `parse` returns, and the ECMAScript conversions the formatter applies.
// ---------------------------------------------------------------------------------------------

/// A JS value as `yaml@2.9.0`'s `toJS` builds it under the core schema (no `Date`: the core
/// schema leaves timestamps as strings).
#[derive(Debug, Clone, PartialEq)]
pub enum JsValue {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<JsValue>),
    Obj(JsObject),
}

/// A plain JS object: insertion-ordered own keys; a repeated key overwrites in place.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JsObject {
    entries: Vec<(String, JsValue)>,
}

/// An array-index key in ECMAScript's sense (canonical, below 2^32 - 1).
fn is_array_index(key: &str) -> bool {
    if key == "0" {
        return true;
    }
    let bytes = key.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 10
        || bytes[0] == b'0'
        || !bytes.iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

impl JsObject {
    fn set(&mut self, key: String, value: JsValue) {
        if let Some(slot) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    /// `Object.entries` order: integer-like keys ascending, then the rest in insertion order.
    pub fn entries(&self) -> Vec<(&str, &JsValue)> {
        let mut ints: Vec<(u64, &str, &JsValue)> = Vec::new();
        let mut rest = Vec::new();
        for (k, v) in &self.entries {
            if is_array_index(k) {
                ints.push((k.parse().unwrap_or(0), k, v));
            } else {
                rest.push((k.as_str(), v));
            }
        }
        ints.sort_by_key(|e| e.0);
        ints.into_iter()
            .map(|(_, k, v)| (k, v))
            .chain(rest)
            .collect()
    }
}

/// ECMAScript `Number::toString` (radix 10), i.e. `String(number)` (`frontmatter.ts:148`),
/// through the pinned `ryu-js` (`-0` → `"0"`, `NaN`, `Infinity`, `1e+21`, `1e-7`).
pub fn js_number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_owned()
}

/// `JSON.stringify` of a string (`QuoteJSONString`).
fn json_quote(s: &str, out: &mut String) {
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
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(value)` with no replacer and no indent (`frontmatter.ts:149`, `:239`).
pub fn json_stringify(value: &JsValue) -> String {
    let mut out = String::new();
    json_write(value, &mut out);
    out
}

fn json_write(value: &JsValue, out: &mut String) {
    match value {
        JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Num(n) if n.is_finite() => out.push_str(&js_number_to_string(*n)),
        JsValue::Num(_) => out.push_str("null"),
        JsValue::Str(s) => json_quote(s, out),
        JsValue::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_write(item, out);
            }
            out.push(']');
        }
        JsValue::Obj(obj) => {
            out.push('{');
            for (i, (k, v)) in obj.entries().into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_quote(k, out);
                out.push(':');
                json_write(v, out);
            }
            out.push('}');
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The core schema over yaml-rust2's events.
// ---------------------------------------------------------------------------------------------

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("core-schema regex compiles")
}

static INT_OCT: LazyLock<Regex> = LazyLock::new(|| re(r"^0o[0-7]+$"));
static INT_DEC: LazyLock<Regex> = LazyLock::new(|| re(r"^[-+]?[0-9]+$"));
static INT_HEX: LazyLock<Regex> = LazyLock::new(|| re(r"^0x[0-9a-fA-F]+$"));
static FLOAT_NAN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"));
static FLOAT_EXP: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$"));
static FLOAT: LazyLock<Regex> = LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$"));
static BOOL: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$"));
static NULL: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:~|[Nn]ull|NULL)?$"));

/// `parseInt(digits, radix)` for a digit string already known valid.
fn parse_radix(digits: &str, radix: u32) -> f64 {
    if let Ok(n) = u64::from_str_radix(digits, radix) {
        #[allow(clippy::cast_precision_loss)]
        return n as f64;
    }
    digits.chars().fold(0.0, |acc, c| {
        acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    })
}

/// `parseFloat` over a string the core-schema test already matched.
fn parse_float(s: &str) -> f64 {
    let t = s.strip_prefix('+').unwrap_or(s);
    let fixed = if let Some(rest) = t.strip_prefix("-.") {
        format!("-0.{rest}")
    } else if let Some(rest) = t.strip_prefix('.') {
        format!("0.{rest}")
    } else {
        t.to_owned()
    };
    fixed.parse::<f64>().unwrap_or(f64::NAN)
}

/// Resolve a plain scalar through the core schema's tags, in `node_modules/yaml/dist/schema/core/schema.js` order.
fn resolve_plain(v: &str) -> JsValue {
    if NULL.is_match(v) {
        JsValue::Null
    } else if BOOL.is_match(v) {
        JsValue::Bool(v.starts_with(['t', 'T']))
    } else if INT_OCT.is_match(v) {
        JsValue::Num(parse_radix(&v[2..], 8))
    } else if INT_DEC.is_match(v) {
        JsValue::Num(parse_float(v))
    } else if INT_HEX.is_match(v) {
        JsValue::Num(parse_radix(&v[2..], 16))
    } else if FLOAT_NAN.is_match(v) {
        JsValue::Num(if v[v.len() - 3..].eq_ignore_ascii_case("nan") {
            f64::NAN
        } else if v.starts_with('-') {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        })
    } else if FLOAT_EXP.is_match(v) || FLOAT.is_match(v) {
        JsValue::Num(parse_float(v))
    } else {
        JsValue::Str(v.to_owned())
    }
}

/// A composed node: its JS value, whether it was a scalar node (`isScalar`, which
/// `uniqueKeys`' equality and `stringifyKey` both turn on), and its flow-context string.
struct Node {
    value: JsValue,
    scalar: bool,
    flow: String,
}

struct Composer<'a> {
    src: &'a str,
    parser: Parser<std::str::Chars<'a>>,
    anchors: HashMap<usize, (JsValue, String)>,
}

impl Composer<'_> {
    fn next(&mut self) -> Result<Event, String> {
        self.parser
            .next_token()
            .map(|(e, _)| e)
            .map_err(|e| prettify_error(self.src, e.info(), e.marker().line(), e.marker().col()))
    }

    fn node(&mut self, event: Event) -> Result<Node, String> {
        let (node, anchor) = match event {
            Event::Alias(id) => {
                let (value, flow) = self
                    .anchors
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| "unknown anchor".to_owned())?;
                return Ok(Node {
                    value,
                    scalar: false,
                    flow,
                });
            }
            Event::Scalar(v, style, anchor, tag) => {
                let core = tag
                    .as_ref()
                    .filter(|t| t.handle == "tag:yaml.org,2002:")
                    .map(|t| t.suffix.as_str());
                let value = match (style, core, tag.is_some()) {
                    (_, Some("str"), _) => JsValue::Str(v.clone()),
                    (TScalarStyle::Plain, None, false)
                    | (TScalarStyle::Plain, Some("null" | "bool" | "int" | "float"), _) => {
                        resolve_plain(&v)
                    }
                    _ => JsValue::Str(v.clone()),
                };
                let flow = if value == JsValue::Null {
                    String::new()
                } else {
                    v
                };
                (
                    Node {
                        value,
                        scalar: true,
                        flow,
                    },
                    anchor,
                )
            }
            Event::SequenceStart(anchor, _) => {
                let mut items = Vec::new();
                let mut flows = Vec::new();
                loop {
                    let ev = self.next()?;
                    if ev == Event::SequenceEnd {
                        break;
                    }
                    let item = self.node(ev)?;
                    flows.push(item.flow);
                    items.push(item.value);
                }
                let flow = if flows.is_empty() {
                    "[]".to_owned()
                } else {
                    format!("[ {} ]", flows.join(", "))
                };
                (
                    Node {
                        value: JsValue::Arr(items),
                        scalar: false,
                        flow,
                    },
                    anchor,
                )
            }
            Event::MappingStart(anchor, _) => {
                let mut obj = JsObject::default();
                let mut keys: Vec<JsValue> = Vec::new();
                let mut flows = Vec::new();
                loop {
                    let ev = self.next()?;
                    if ev == Event::MappingEnd {
                        break;
                    }
                    let key = self.node(ev)?;
                    let ev = self.next()?;
                    let value = self.node(ev)?;
                    if key.scalar {
                        // `mapIncludes`: scalar keys whose values are `===` collide.
                        if keys.iter().any(|k| js_strict_equals(k, &key.value)) {
                            return Err("Map keys must be unique".to_owned());
                        }
                        keys.push(key.value.clone());
                    }
                    flows.push(if value.scalar && value.value == JsValue::Null {
                        key.flow.clone()
                    } else {
                        format!("{}: {}", key.flow, value.flow)
                    });
                    // `stringifyKey` (`node_modules/yaml/dist/nodes/addPairToJSMap.js`).
                    let string_key = match &key.value {
                        JsValue::Null => String::new(),
                        JsValue::Bool(b) => b.to_string(),
                        JsValue::Num(n) => js_number_to_string(*n),
                        JsValue::Str(s) => s.clone(),
                        JsValue::Arr(_) | JsValue::Obj(_) => key.flow.clone(),
                    };
                    obj.set(string_key, value.value);
                }
                let flow = if flows.is_empty() {
                    "{}".to_owned()
                } else {
                    format!("{{ {} }}", flows.join(", "))
                };
                (
                    Node {
                        value: JsValue::Obj(obj),
                        scalar: false,
                        flow,
                    },
                    anchor,
                )
            }
            other => return Err(format!("unexpected event {other:?}")),
        };
        if anchor != 0 {
            self.anchors
                .insert(anchor, (node.value.clone(), node.flow.clone()));
        }
        Ok(node)
    }
}

/// `a === b` for two scalar values.
fn js_strict_equals(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(x), JsValue::Bool(y)) => x == y,
        (JsValue::Num(x), JsValue::Num(y)) => x.total_cmp(y).is_eq() || (*x == 0.0 && *y == 0.0),
        (JsValue::Str(x), JsValue::Str(y)) => x == y,
        _ => false,
    }
}

/// `prettifyError` (`node_modules/yaml/dist/errors.js:22-62`), transcribed over yaml-rust2's own
/// error position: `info` (yaml-rust2's text — D-A), then ` at line L, column C`, and — when
/// the excerpt has a non-space character — `:`, a blank line, the source line (folded at 80
/// UTF-16 units with `…`, re-centred when the column is past 60), the caret line, and a
/// trailing newline. `line` is yaml-rust2's 1-based line and `col` its 0-based **char**
/// column; every slice below is in UTF-16 units, as the JS is, and a cut surrogate decodes to
/// U+FFFD (the bytes stdout receives from a lone JS surrogate). yaml-rust2 reports no end
/// position, so the caret is always one `^` (`count = 1`, `errors.js:50`).
fn prettify_error(src: &str, info: &str, line: usize, col: usize) -> String {
    // `lc.lineStarts`: 0 and every offset after a `\n` — the pieces of `split('\n')`.
    let pieces: Vec<&str> = src.split('\n').collect();
    let line_text = line.checked_sub(1).and_then(|i| pieces.get(i).copied());
    let col16: usize = line_text.map_or(col, |l| l.chars().take(col).map(char::len_utf16).sum());
    let mut message = format!("{info} at line {line}, column {}", col16 + 1);
    // `src.substring(lineStarts[line - 1], lineStarts[line]).replace(/[\n\r]+$/, '')`; a line
    // past the last start reads `substring(undefined, undefined)`, the whole source.
    let mut line_str: Vec<u16> = line_text
        .unwrap_or(src)
        .trim_end_matches(['\n', '\r'])
        .encode_utf16()
        .collect();
    let ellipsis: u16 = 0x2026;
    let mut ci = col16;
    if ci >= 60 && line_str.len() > 80 {
        let trim_start = (ci - 39).min(line_str.len() - 79);
        let mut trimmed = vec![ellipsis];
        trimmed.extend_from_slice(&line_str[trim_start..]);
        line_str = trimmed;
        ci -= trim_start - 1;
    }
    if line_str.len() > 80 {
        line_str.truncate(79);
        line_str.push(ellipsis);
    }
    let lead_blank = line_str[..ci.min(line_str.len())]
        .iter()
        .all(|&u| u == u16::from(b' '));
    if line > 1 && lead_blank {
        // `src.substring(lineStarts[line - 2], lineStarts[line - 1])`: the previous line and its
        // `\n`.
        if let Some(prev) = pieces.get(line - 2) {
            let mut joined: Vec<u16> = prev.encode_utf16().collect();
            joined.push(u16::from(b'\n'));
            if joined.len() > 80 {
                joined.truncate(79);
                joined.extend("…\n".encode_utf16());
            }
            joined.extend_from_slice(&line_str);
            line_str = joined;
        }
    }
    if line_str.iter().any(|&u| u != u16::from(b' ')) {
        let excerpt = String::from_utf16_lossy(&line_str);
        let pointer = " ".repeat(ci);
        message.push_str(&format!(":\n\n{excerpt}\n{pointer}^\n"));
    }
    message
}

/// `parse(meta, { logLevel: "error" })` under the core schema: the JS value, or why it failed
/// (yaml-rust2's message, or ours for a condition `yaml` rejects — D-A).
pub fn parse_frontmatter(meta: &str) -> Result<JsValue, String> {
    // `yaml` rejects a tab in the indentation of the first content line; yaml-rust2 skips
    // leading whitespace before the first token and accepts it. Every later line it already
    // rejects as `yaml` does (census, synthetic witnesses).
    let first_content = meta.split('\n').find(|line| {
        let t = line.trim_start_matches([' ', '\t']);
        !t.is_empty() && !t.starts_with('#')
    });
    if let Some(line) = first_content {
        let lead = &line[..line.len() - line.trim_start_matches([' ', '\t']).len()];
        if lead.contains('\t') {
            return Err("Tabs are not allowed as indentation".to_owned());
        }
    }
    let mut composer = Composer {
        src: meta,
        parser: Parser::new_from_str(meta),
        anchors: HashMap::new(),
    };
    let mut doc: Option<JsValue> = None;
    let mut documents = 0;
    loop {
        match composer.next()? {
            Event::StreamEnd => break,
            Event::DocumentStart => {
                documents += 1;
                if documents > 1 {
                    return Err(
                        "Source contains multiple documents; please use YAML.parseAllDocuments()"
                            .to_owned(),
                    );
                }
                let ev = composer.next()?;
                if ev != Event::DocumentEnd {
                    doc = Some(composer.node(ev)?.value);
                    if composer.next()? != Event::DocumentEnd {
                        return Err("expected document end".to_owned());
                    }
                }
            }
            _ => {}
        }
    }
    Ok(doc.unwrap_or(JsValue::Null))
}

// ---------------------------------------------------------------------------------------------
// The formatter: `src/frontmatter.ts`, transcribed.
// ---------------------------------------------------------------------------------------------

fn dim(text: &str, sgr: SgrMode) -> String {
    style_span(sgr, &create_styler(StyleName::Dim, None), text)
}

/// `ISO_TIMESTAMP`. JS `\d` is ASCII-only and the `regex` crate's is Unicode, so it is
/// spelled `[0-9]`.
static ISO_TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$",
    )
});

/// `trimIsoDate`.
fn trim_iso_date(value: &str) -> String {
    ISO_TIMESTAMP
        .captures(js_trim(value))
        .and_then(|c| c.get(1))
        .map_or_else(|| value.to_owned(), |m| m.as_str().to_owned())
}

/// `formatScalar`.
fn format_scalar(value: &JsValue) -> String {
    match value {
        JsValue::Null => "—".into(),
        JsValue::Str(s) if js_trim(s).is_empty() => "—".into(),
        JsValue::Str(s) => trim_iso_date(s),
        JsValue::Num(n) => js_number_to_string(*n),
        JsValue::Bool(b) => b.to_string(),
        other => json_stringify(other),
    }
}

/// `formatValue`.
fn format_value(value: &JsValue) -> String {
    match value {
        JsValue::Arr(items) if items.is_empty() => "—".into(),
        JsValue::Arr(items) => items
            .iter()
            .map(format_scalar)
            .collect::<Vec<_>>()
            .join(", "),
        other => format_scalar(other),
    }
}

static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(&format!("[{JS_WS_CLASS}]+")));

fn to_i64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

/// `wrapValue`.
fn wrap_value(text: &str, width: i64, measure: Measure) -> Vec<String> {
    if width <= 0 || to_i64(measure.width(text)) <= width {
        return vec![text.to_owned()];
    }
    let words: Vec<&str> = WS_RUN.split(text).filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return vec![String::new()];
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in words {
        let candidate = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if !current.is_empty() && to_i64(measure.width(&candidate)) > width {
            lines.push(std::mem::replace(&mut current, word.to_owned()));
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
        .iter()
        .flat_map(|l| hard_split(l, width, measure))
        .collect()
}

/// `hardSplit`. `String.prototype.slice` counts UTF-16 units, so the cut is made over the
/// UTF-16 encoding; a cut inside a surrogate pair decodes to U+FFFD here where JS would carry
/// a lone surrogate.
fn hard_split(line: &str, width: i64, measure: Measure) -> Vec<String> {
    if width <= 0 || to_i64(measure.width(line)) <= width {
        return vec![line.to_owned()];
    }
    let w = |units: &[u16]| to_i64(measure.width(&String::from_utf16_lossy(units)));
    let mut out = Vec::new();
    let mut remaining: Vec<u16> = line.encode_utf16().collect();
    while w(&remaining) > width {
        let mut cut = usize::try_from(width).unwrap_or(0).min(remaining.len());
        while cut > 1 && w(&remaining[..cut]) > width {
            cut -= 1;
        }
        out.push(String::from_utf16_lossy(&remaining[..cut]));
        remaining = remaining.split_off(cut);
    }
    if !remaining.is_empty() {
        out.push(String::from_utf16_lossy(&remaining));
    }
    out
}

/// `formatMapping`.
fn format_mapping(
    record: &JsObject,
    target: i64,
    depth: usize,
    measure: Measure,
    sgr: SgrMode,
) -> String {
    let entries = record.entries();
    if entries.is_empty() {
        return dim("—", sgr);
    }
    let indent = "  ".repeat(depth);
    let indent_width = to_i64(measure.width(&indent));
    let raw_max = entries
        .iter()
        .map(|(k, _)| to_i64(measure.width(k)))
        .max()
        .unwrap_or(0);
    let key_budget = 4.max((target - indent_width).div_euclid(2) - 2);
    let max_key_width = raw_max.min(key_budget);
    let value_width = 1.max(target - indent_width - (max_key_width + 2));
    let pad_width = usize::try_from(max_key_width).unwrap_or(0);

    let mut lines: Vec<String> = Vec::new();
    for (key, value) in entries {
        // `key.padEnd(maxKeyWidth)`: a UTF-16 length padded against a column count.
        let padded_key = format!(
            "{key}{}",
            " ".repeat(pad_width.saturating_sub(utf16_len(key)))
        );
        if let (JsValue::Obj(inner), true) = (value, depth < 1) {
            lines.push(format!("{indent}{}:", dim(&padded_key, sgr)));
            lines.push(format_mapping(inner, target, depth + 1, measure, sgr));
            continue;
        }
        let formatted = match value {
            JsValue::Obj(_) => json_stringify(value),
            other => format_value(other),
        };
        for (i, line) in wrap_value(&formatted, value_width, measure)
            .into_iter()
            .enumerate()
        {
            if i == 0 {
                lines.push(format!("{indent}{}: {line}", dim(&padded_key, sgr)));
            } else {
                lines.push(format!("{indent}{}  {line}", " ".repeat(pad_width)));
            }
        }
    }
    lines.join("\n")
}

fn line_span(block: &str, offset: usize) -> (usize, usize) {
    (offset + 1, offset + block.split('\n').count())
}

/// `formatMetaBlockDetailed`. Never fails; the `Result` keeps the render seam's shape.
pub fn format_meta_block_detailed(
    meta: &str,
    target_width: usize,
    measure: Measure,
    sgr: SgrMode,
) -> Result<MetaBlockResult, RenderError> {
    let target = to_i64(target_width);
    match parse_frontmatter(meta) {
        Err(reason) => {
            let (summary, detail) = reason
                .find('\n')
                .map_or((reason.as_str(), ""), |i| (&reason[..i], &reason[i..]));
            let wrapped = wrap_value(
                &format!("! could not parse frontmatter: {summary}"),
                target,
                measure,
            );
            let diagnostic = dim(&(wrapped.join("\n") + detail), sgr);
            let echo = dim(js_trim_end(meta), sgr);
            let offset = diagnostic.split('\n').count();
            Ok(MetaBlockResult {
                text: format!("{diagnostic}\n{echo}"),
                verbatim_ranges: vec![line_span(&echo, offset)],
            })
        }
        Ok(JsValue::Obj(record)) => Ok(MetaBlockResult {
            text: format_mapping(&record, target, 0, measure, sgr),
            verbatim_ranges: Vec::new(),
        }),
        Ok(_) => {
            let echo = dim(js_trim_end(meta), sgr);
            Ok(MetaBlockResult {
                verbatim_ranges: vec![line_span(&echo, 0)],
                text: echo,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_requires_a_key_shaped_first_line() {
        assert_eq!(
            split_frontmatter("---\ntitle: x\n---\nbody"),
            (Some("title: x".into()), "body")
        );
        assert_eq!(split_frontmatter("---\nnot yaml\n---\nb").0, None);
        assert_eq!(
            split_frontmatter("---\r\na: 1\r\n---\r\nb"),
            (Some("a: 1".into()), "b")
        );
        assert_eq!(
            split_frontmatter("---\na: 1\n---"),
            (Some("a: 1".into()), "")
        );
        assert_eq!(split_frontmatter("no fm").0, None);
    }

    fn fmt(meta: &str, width: usize) -> MetaBlockResult {
        format_meta_block_detailed(meta, width, crate::width::NARROW_MEASURE, SgrMode::None)
            .expect("infallible")
    }

    #[test]
    fn number_to_string_is_ecmascript() {
        for (x, s) in [
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.000_001, "0.000001"),
            (-0.0, "0"),
            (1.5, "1.5"),
            (f64::INFINITY, "Infinity"),
            (f64::NAN, "NaN"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
        ] {
            assert_eq!(js_number_to_string(x), s);
        }
    }

    #[test]
    fn core_schema_scalars() {
        let v = parse_frontmatter("a: yes\nb: on\nc: True\nd: 0o17\ne: 0x1F\nf: .inf\ng: ~\nh: 1.50\ni: 007\nj: 12:30\nk: 2026-07-06\nl: '1'")
            .expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"a":"yes","b":"on","c":true,"d":15,"e":31,"f":null,"g":null,"h":1.5,"i":7,"j":"12:30","k":"2026-07-06","l":"1"}"#
        );
    }

    #[test]
    fn object_keys_put_integer_like_keys_first() {
        let v = parse_frontmatter("b: 1\n10: x\n2: y\n01: z\na: 3").expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"1":"z","2":"y","10":"x","b":1,"a":3}"#
        );
    }

    #[test]
    fn duplicate_scalar_keys_fail_like_unique_keys() {
        assert!(parse_frontmatter("x: 1\nx: 2").is_err());
        assert!(parse_frontmatter("1: a\n1.0: b").is_err());
        assert!(parse_frontmatter("~: a\nnull: b").is_err());
        // `1` and `"1"` are not `===`: both land on key "1", the later value in place.
        assert_eq!(
            json_stringify(&parse_frontmatter("1: a\nz: 0\n\"1\": b").expect("parses")),
            r#"{"1":"b","z":0}"#
        );
    }

    #[test]
    fn collection_keys_are_flow_stringified() {
        let v = parse_frontmatter("created: {{today}}\n? [a, b]\n: v").expect("parses");
        assert_eq!(
            json_stringify(&v),
            r#"{"created":{"{ today }":null},"[ a, b ]":"v"}"#
        );
    }

    #[test]
    fn a_leading_tab_indent_fails_as_yaml_does() {
        assert!(parse_frontmatter("\ta: 1").is_err());
        assert!(parse_frontmatter("# c\n \ta: 1").is_err());
        assert!(parse_frontmatter("a: 1\n\t# c").is_ok());
    }

    #[test]
    fn multiple_documents_fail() {
        assert!(parse_frontmatter("a: 1\n---\nb: 2").is_err());
    }

    #[test]
    fn mapping_formats_with_padded_keys_and_em_dashes() {
        assert_eq!(
            fmt(
                "title: x\ntags: []\nempty: ''\nn:\nlist: [a, 1, {b: c}]",
                80
            )
            .text,
            "title: x\ntags : —\nempty: —\nn    : —\nlist : a, 1, {\"b\":\"c\"}"
        );
    }

    #[test]
    fn timestamps_trim_to_the_date() {
        assert_eq!(fmt("d: 2026-07-06T12:30:00Z", 80).text, "d: 2026-07-06");
    }

    #[test]
    fn nested_mapping_recurses_once_then_stringifies() {
        assert_eq!(
            fmt("a:\n  b:\n    c: 1\n  e: 2", 80).text,
            "a:\n  b: {\"c\":1}\n  e: 2"
        );
        assert_eq!(fmt("a: {}", 80).text, "a:\n—");
    }

    #[test]
    fn long_values_wrap_under_the_key_column() {
        assert_eq!(fmt("k: aaa bbb ccc", 8).text, "k: aaa\n   bbb\n   ccc");
        assert_eq!(fmt("k: abcdefgh", 6).text, "k: abc\n   def\n   gh");
    }

    #[test]
    fn a_non_mapping_document_is_echoed_verbatim() {
        let r = fmt("- a\n- b\n", 80);
        assert_eq!(r.text, "- a\n- b");
        assert_eq!(r.verbatim_ranges, vec![(1, 2)]);
    }

    #[test]
    fn a_failed_parse_echoes_under_its_diagnostic() {
        let r = fmt("a: [unterminated\nb: 1", 200);
        let lines: Vec<&str> = r.text.split('\n').collect();
        assert!(lines[0].starts_with("! could not parse frontmatter: "));
        assert_eq!(&lines[lines.len() - 2..], &["a: [unterminated", "b: 1"]);
        let start = lines.len() - 1;
        assert_eq!(r.verbatim_ranges, vec![(start, start + 1)]);
    }

    #[test]
    fn prettify_appends_position_excerpt_and_caret() {
        assert_eq!(
            prettify_error("a: 1\nb: x y: z", "info", 2, 4),
            "info at line 2, column 5:\n\nb: x y: z\n    ^\n"
        );
    }

    #[test]
    fn prettify_includes_the_previous_line_at_a_line_start() {
        assert_eq!(
            prettify_error("a:\n  - b\nc", "info", 3, 0),
            "info at line 3, column 1:\n\n  - b\nc\n^\n"
        );
    }

    #[test]
    fn prettify_recentres_and_folds_a_long_line_at_80_units() {
        let line = "x".repeat(200);
        let expected = format!(
            "info at line 1, column 151:\n\n…{}…\n{}^\n",
            "x".repeat(78),
            " ".repeat(40)
        );
        assert_eq!(prettify_error(&line, "info", 1, 150), expected);
    }

    #[test]
    fn prettify_counts_columns_in_utf16_units() {
        // `😀` is one char and two UTF-16 units, as `yaml`'s `col` counts it.
        assert_eq!(
            prettify_error("k: 😀 x", "info", 1, 5),
            "info at line 1, column 7:\n\nk: 😀 x\n      ^\n"
        );
    }

    #[test]
    fn a_failed_parse_diagnostic_has_the_excerpt_layout() {
        let r = fmt("a: b\nk: x {a: b} c", 200);
        let lines: Vec<&str> = r.text.split('\n').collect();
        assert!(lines[0].ends_with(':'), "{lines:?}");
        assert_eq!(lines[1], "");
        assert_eq!(lines[2], "k: x {a: b} c");
        assert!(lines[3].trim_start() == "^", "{lines:?}");
        assert_eq!(lines[4], "");
        assert_eq!(r.verbatim_ranges, vec![(6, 7)]);
    }

    #[test]
    fn dim_wraps_keys_and_echo_under_colour() {
        let r =
            format_meta_block_detailed("a: 1", 80, crate::width::NARROW_MEASURE, SgrMode::Formats)
                .expect("infallible");
        assert_eq!(r.text, "\u{1b}[2ma\u{1b}[22m: 1");
    }
}
