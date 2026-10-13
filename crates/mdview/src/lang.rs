//! Fence-language aliases and the supported-language fallback, ported from `TS_BASELINE` `src/lang.ts`.
//!
//! `supportsLanguage` is the highlighter's: [`supports_language`] (syntect), called directly.
//!
//! **One TS quirk not reproduced:** `aliases[lower]` is a plain-object lookup, so a fence
//! language spelled like an `Object.prototype` key (`constructor`, `__proto__`) reads the
//! prototype member instead of `undefined`. Here the map is a map.

use std::collections::BTreeMap;
use std::rc::Rc;

use crate::highlight::supports_language;
use crate::text::{is_js_whitespace, js_trim};

/// The locked built-in aliases (`plans/vault-readiness.md` decision 3), in TS order.
pub const LANG_ALIASES: &[(&str, &str)] = &[("dataviewjs", "javascript"), ("dataview", "sql")];

/// `getBuiltinAliases`.
pub fn builtin_aliases() -> BTreeMap<String, String> {
    LANG_ALIASES
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// A fence-language resolver: an alias map (built-ins under user entries).
#[derive(Clone)]
pub struct FenceLanguageResolver {
    aliases: Rc<BTreeMap<String, String>>,
}

impl FenceLanguageResolver {
    /// `makeFenceLanguageResolver(userAliases)`: user entries win over the built-ins.
    pub fn new(user_aliases: &BTreeMap<String, String>) -> Self {
        let mut aliases = builtin_aliases();
        for (k, v) in user_aliases {
            aliases.insert(k.clone(), v.clone());
        }
        FenceLanguageResolver {
            aliases: Rc::new(aliases),
        }
    }

    /// Built-ins only.
    pub fn builtin() -> Self {
        Self::new(&BTreeMap::new())
    }

    /// `resolveWith`: `None` and blank pass through unchanged; otherwise the first word,
    /// lower-cased, aliased, and `plaintext` unless supported.
    pub fn resolve(&self, raw: Option<&str>) -> Option<String> {
        let raw = raw?;
        let trimmed = js_trim(raw);
        if trimmed.is_empty() {
            return Some(raw.to_owned());
        }
        let first_word = trimmed.split(is_js_whitespace).next().unwrap_or(trimmed);
        let lower = first_word.to_lowercase();
        let aliased = self.aliases.get(&lower).cloned().unwrap_or(lower);
        if supports_language(&aliased) {
            Some(aliased)
        } else {
            Some("plaintext".to_owned())
        }
    }

    /// `isSupportedLanguage`: trimmed, lower-cased, asked of syntect (no aliasing).
    pub fn is_supported(&self, language: &str) -> bool {
        supports_language(&js_trim(language).to_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r() -> FenceLanguageResolver {
        FenceLanguageResolver::builtin()
    }

    #[test]
    fn aliases_and_fallback() {
        assert_eq!(
            r().resolve(Some("dataviewjs")).as_deref(),
            Some("javascript")
        );
        assert_eq!(
            r().resolve(Some("  DataView  extra")).as_deref(),
            Some("sql")
        );
        assert_eq!(r().resolve(Some("mermaid")).as_deref(), Some("plaintext"));
    }

    #[test]
    fn missing_and_blank_pass_through() {
        assert_eq!(r().resolve(None), None);
        assert_eq!(r().resolve(Some("   ")).as_deref(), Some("   "));
        assert_eq!(r().resolve(Some("")).as_deref(), Some(""));
    }

    #[test]
    fn user_aliases_layer_over_builtins_and_resolvers_are_independent() {
        let mut user = BTreeMap::new();
        user.insert("dataview".to_owned(), "python".to_owned());
        user.insert("tasks".to_owned(), "nope".to_owned());
        let custom = FenceLanguageResolver::new(&user);
        assert_eq!(custom.resolve(Some("dataview")).as_deref(), Some("python"));
        assert_eq!(custom.resolve(Some("tasks")).as_deref(), Some("plaintext"));
        let plain = FenceLanguageResolver::builtin();
        assert_eq!(plain.resolve(Some("dataview")).as_deref(), Some("sql"));
        assert!(plain.is_supported(" Python "));
        assert!(!plain.is_supported("dataview"));
    }
}
