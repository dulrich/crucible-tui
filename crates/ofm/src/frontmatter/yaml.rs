//! The core schema over yaml-rust2's events: the composer, `prettifyError` and `parse`.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

use super::js_value::*;

pub(super) fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("core-schema regex compiles")
}

pub(super) static INT_OCT: LazyLock<Regex> = LazyLock::new(|| re(r"^0o[0-7]+$"));
pub(super) static INT_DEC: LazyLock<Regex> = LazyLock::new(|| re(r"^[-+]?[0-9]+$"));
pub(super) static INT_HEX: LazyLock<Regex> = LazyLock::new(|| re(r"^0x[0-9a-fA-F]+$"));
pub(super) static FLOAT_NAN: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$"));
pub(super) static FLOAT_EXP: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$"));
pub(super) static FLOAT: LazyLock<Regex> =
    LazyLock::new(|| re(r"^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$"));
pub(super) static BOOL: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$"));
pub(super) static NULL: LazyLock<Regex> = LazyLock::new(|| re(r"^(?:~|[Nn]ull|NULL)?$"));

/// `parseInt(digits, radix)` for a digit string already known valid.
pub(super) fn parse_radix(digits: &str, radix: u32) -> f64 {
    if let Ok(n) = u64::from_str_radix(digits, radix) {
        #[allow(clippy::cast_precision_loss)]
        return n as f64;
    }
    digits.chars().fold(0.0, |acc, c| {
        acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
    })
}

/// `parseFloat` over a string the core-schema test already matched.
pub(super) fn parse_float(s: &str) -> f64 {
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
pub(super) fn resolve_plain(v: &str) -> JsValue {
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
pub(super) struct Node {
    value: JsValue,
    scalar: bool,
    flow: String,
}

pub(super) struct Composer<'a> {
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
pub(super) fn js_strict_equals(a: &JsValue, b: &JsValue) -> bool {
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
pub(super) fn prettify_error(src: &str, info: &str, line: usize, col: usize) -> String {
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
