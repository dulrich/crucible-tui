//! The JS value `yaml`'s `parse` returns, and the ECMAScript conversions the formatter applies.

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
pub(super) fn is_array_index(key: &str) -> bool {
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
    pub(super) fn set(&mut self, key: String, value: JsValue) {
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
pub(super) fn json_quote(s: &str, out: &mut String) {
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

pub(super) fn json_write(value: &JsValue, out: &mut String) {
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
