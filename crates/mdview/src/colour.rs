//! The one colour/hyperlink policy decision, ported from `TS_BASELINE` `src/colour.ts`.
//!
//! Pure over its inputs: the environment arrives as an [`Env`] value and the TTY answer as a
//! bool, so nothing here reads process state. Precedence and every upstream quirk are
//! transcribed — including `parseVersion`'s `NaN` comparisons (represented as `f64::NAN`)
//! and `parseInt`'s prefix parse.

use std::collections::HashMap;

use crate::style::Sgr;
use crate::text::{is_js_whitespace, js_trim};

/// The resolved colour policy, passed explicitly — never read from the environment here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub sgr: Sgr,
    pub hyperlinks: bool,
    pub tmux: bool,
}

/// An environment handed in, never read here.
pub type Env = HashMap<String, String>;

/// `auto` / `always` / `never`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColourDirective {
    Auto,
    Always,
    Never,
}

/// `resolveColor` / `resolveColourPolicy`'s inputs.
#[derive(Default)]
pub struct ColourPolicyInput<'a> {
    pub flag: Option<ColourDirective>,
    pub config: Option<ColourDirective>,
    pub env: Option<&'a Env>,
    pub is_tty: Option<bool>,
    pub platform: Option<&'a str>,
    pub warn: Option<&'a dyn Fn(&str)>,
    pub hyperlink_flag: Option<ColourDirective>,
    pub hyperlink_config: Option<ColourDirective>,
}

/// `resolveHyperlinks`' inputs.
#[derive(Default)]
pub struct HyperlinkInput<'a> {
    pub env: Option<&'a Env>,
    pub is_tty: Option<bool>,
    pub platform: Option<&'a str>,
    pub warn: Option<&'a dyn Fn(&str)>,
    pub flag: Option<ColourDirective>,
    pub config: Option<ColourDirective>,
}

/// `parseColourDirective`: trimmed (JS `trim`), lower-cased, exact.
pub fn parse_colour_directive(raw: Option<&str>) -> Option<ColourDirective> {
    let normalized = js_trim(raw?).to_lowercase();
    match normalized.as_str() {
        "auto" => Some(ColourDirective::Auto),
        "always" => Some(ColourDirective::Always),
        "never" => Some(ColourDirective::Never),
        _ => None,
    }
}

/// `parseForceColor`.
pub fn parse_force_color(raw: Option<&str>) -> Option<ColourDirective> {
    match raw? {
        "0" | "false" => Some(ColourDirective::Never),
        "" | "true" | "1" | "2" | "3" => Some(ColourDirective::Always),
        _ => None,
    }
}

/// `JSON.stringify` of a string, for the warning text.
fn json_string(s: &str) -> String {
    serde_json::Value::String(s.to_owned()).to_string()
}

fn directive_from_env(env: &Env, name: &str, warn: &dyn Fn(&str)) -> Option<ColourDirective> {
    let raw = env.get(name)?;
    let parsed = parse_colour_directive(Some(raw));
    if parsed.is_none() {
        warn(&format!(
            "mdview: ignoring malformed {name}={}: expected auto, always or never",
            json_string(raw)
        ));
    }
    parsed
}

fn noop(_: &str) {}

/// `resolveColor`: the SGR level.
pub fn resolve_color(input: &ColourPolicyInput<'_>) -> Sgr {
    let empty = Env::new();
    let env = input.env.unwrap_or(&empty);
    let warn: &dyn Fn(&str) = input.warn.unwrap_or(&noop);
    match input.flag {
        Some(ColourDirective::Always) => return Sgr::Full,
        Some(ColourDirective::Never) => return Sgr::Formats,
        _ => {}
    }
    match directive_from_env(env, "MDVIEW_COLOR", warn) {
        Some(ColourDirective::Always) => return Sgr::Full,
        Some(ColourDirective::Never) => return Sgr::Formats,
        _ => {}
    }
    if env.contains_key("NO_COLOR") {
        return Sgr::None;
    }
    match parse_force_color(env.get("FORCE_COLOR").map(String::as_str)) {
        Some(ColourDirective::Always) => return Sgr::Full,
        Some(ColourDirective::Never) => return Sgr::None,
        _ => {}
    }
    match input.config {
        Some(ColourDirective::Always) => return Sgr::Full,
        Some(ColourDirective::Never) => return Sgr::Formats,
        _ => {}
    }
    if input.is_tty == Some(true) {
        Sgr::Full
    } else {
        Sgr::None
    }
}

/// JS `parseInt(s, 10)`: leading whitespace, optional sign, a decimal prefix; `NaN` if none.
pub fn js_parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_whitespace);
    let (sign, digits) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        return f64::NAN;
    }
    sign * digits[..end].parse::<f64>().unwrap_or(f64::NAN)
}

struct Version {
    major: f64,
    minor: f64,
}

fn parse_version(version: Option<&str>) -> Version {
    let raw = version.unwrap_or("");
    if (3..=4).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_digit()) {
        // `/(\d{1,2})(\d{2})/`: the first one or two digits are the minor, the next two the patch.
        let minor = &raw[..raw.len() - 2];
        return Version {
            major: 0.0,
            minor: js_parse_int(minor),
        };
    }
    let mut parts = raw.split('.').map(js_parse_int);
    Version {
        major: parts.next().unwrap_or(f64::NAN),
        minor: parts.next().unwrap_or(f64::NAN),
    }
}

fn truthy(env: &Env, name: &str) -> bool {
    env.get(name).is_some_and(|v| !v.is_empty())
}

/// `resolveHyperlinks`: the non-TTY ceiling first, then the directives, then detection.
pub fn resolve_hyperlinks(input: &HyperlinkInput<'_>) -> bool {
    let empty = Env::new();
    let env = input.env.unwrap_or(&empty);
    let warn: &dyn Fn(&str) = input.warn.unwrap_or(&noop);
    if input.is_tty != Some(true) {
        return false;
    }
    match input.flag {
        Some(ColourDirective::Always) => return true,
        Some(ColourDirective::Never) => return false,
        _ => {}
    }
    match directive_from_env(env, "MDVIEW_HYPERLINKS", warn) {
        Some(ColourDirective::Always) => return true,
        Some(ColourDirective::Never) => return false,
        _ => {}
    }
    match input.config {
        Some(ColourDirective::Always) => return true,
        Some(ColourDirective::Never) => return false,
        _ => {}
    }
    if env.contains_key("WT_SESSION") {
        return true;
    }
    if input.platform == Some("win32") {
        return false;
    }
    if truthy(env, "CI") || truthy(env, "TEAMCITY_VERSION") {
        return false;
    }
    if truthy(env, "TERM_PROGRAM") {
        let version = parse_version(env.get("TERM_PROGRAM_VERSION").map(String::as_str));
        match env["TERM_PROGRAM"].as_str() {
            "iTerm.app" => {
                if version.major == 3.0 {
                    return version.minor >= 1.0;
                }
                return version.major > 3.0;
            }
            "WezTerm" => return version.major >= 20_200_620.0,
            "vscode" => {
                return version.major > 1.0 || (version.major == 1.0 && version.minor >= 72.0);
            }
            "ghostty" => return true,
            _ => {}
        }
    }
    if truthy(env, "VTE_VERSION") {
        let vte = env["VTE_VERSION"].as_str();
        if vte == "0.50.0" {
            return false;
        }
        let version = parse_version(Some(vte));
        return version.major > 0.0 || version.minor >= 50.0;
    }
    env.get("TERM").is_some_and(|t| t == "alacritty")
}

/// `resolveTmux`.
pub fn resolve_tmux(env: &Env) -> bool {
    if let Some(term) = env.get("TERM")
        && (term.starts_with("screen") || term.starts_with("tmux"))
    {
        return true;
    }
    env.contains_key("TMUX")
}

/// `resolveColourPolicy`.
pub fn resolve_colour_policy(input: &ColourPolicyInput<'_>) -> Policy {
    let empty = Env::new();
    Policy {
        sgr: resolve_color(input),
        hyperlinks: resolve_hyperlinks(&HyperlinkInput {
            env: input.env,
            is_tty: input.is_tty,
            platform: input.platform,
            warn: input.warn,
            flag: input.hyperlink_flag,
            config: input.hyperlink_config,
        }),
        tmux: resolve_tmux(input.env.unwrap_or(&empty)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ColourDirective::*;
    use std::cell::RefCell;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn color(
        flag: Option<ColourDirective>,
        config: Option<ColourDirective>,
        e: &Env,
        tty: bool,
    ) -> Sgr {
        resolve_color(&ColourPolicyInput {
            flag,
            config,
            env: Some(e),
            is_tty: Some(tty),
            ..Default::default()
        })
    }

    fn links(e: &Env, tty: bool) -> bool {
        resolve_hyperlinks(&HyperlinkInput {
            env: Some(e),
            is_tty: Some(tty),
            ..Default::default()
        })
    }

    #[test]
    fn parse_colour_directive_trims_and_lowercases() {
        assert_eq!(
            parse_colour_directive(Some("  ALWAYS\u{FEFF}")),
            Some(Always)
        );
        assert_eq!(parse_colour_directive(Some("yes")), None);
        assert_eq!(parse_colour_directive(None), None);
    }

    #[test]
    fn parse_force_color_values() {
        assert_eq!(parse_force_color(Some("")), Some(Always));
        assert_eq!(parse_force_color(Some("3")), Some(Always));
        assert_eq!(parse_force_color(Some("false")), Some(Never));
        assert_eq!(parse_force_color(Some("4")), None);
    }

    #[test]
    fn colour_precedence_matrix() {
        let e = Env::new();
        assert_eq!(color(None, None, &e, false), Sgr::None);
        assert_eq!(color(None, None, &e, true), Sgr::Full);
        assert_eq!(
            color(Some(Always), None, &env(&[("NO_COLOR", "1")]), false),
            Sgr::Full
        );
        assert_eq!(color(Some(Never), None, &e, true), Sgr::Formats);
        assert_eq!(
            color(
                None,
                None,
                &env(&[("MDVIEW_COLOR", "never"), ("FORCE_COLOR", "3")]),
                true
            ),
            Sgr::Formats
        );
        assert_eq!(
            color(
                None,
                None,
                &env(&[("NO_COLOR", ""), ("FORCE_COLOR", "3")]),
                true
            ),
            Sgr::None
        );
        assert_eq!(
            color(None, None, &env(&[("FORCE_COLOR", "0")]), true),
            Sgr::None
        );
        assert_eq!(
            color(None, None, &env(&[("FORCE_COLOR", "1")]), false),
            Sgr::Full
        );
        assert_eq!(color(None, Some(Never), &e, true), Sgr::Formats);
        assert_eq!(
            color(None, Some(Always), &env(&[("FORCE_COLOR", "0")]), false),
            Sgr::None
        );
        assert_eq!(color(None, Some(Auto), &e, true), Sgr::Full);
    }

    #[test]
    fn malformed_env_directive_warns_and_falls_through() {
        let warnings = RefCell::new(Vec::new());
        let warn = |m: &str| warnings.borrow_mut().push(m.to_owned());
        let e = env(&[("MDVIEW_COLOR", "sometimes")]);
        let got = resolve_color(&ColourPolicyInput {
            env: Some(&e),
            is_tty: Some(true),
            warn: Some(&warn),
            ..Default::default()
        });
        assert_eq!(got, Sgr::Full);
        assert_eq!(
            warnings.borrow().as_slice(),
            [
                "mdview: ignoring malformed MDVIEW_COLOR=\"sometimes\": expected auto, always or never"
            ]
        );
    }

    #[test]
    fn hyperlinks_have_a_non_tty_ceiling() {
        assert!(!resolve_hyperlinks(&HyperlinkInput {
            flag: Some(Always),
            is_tty: Some(false),
            ..Default::default()
        }));
        assert!(resolve_hyperlinks(&HyperlinkInput {
            flag: Some(Always),
            is_tty: Some(true),
            ..Default::default()
        }));
    }

    #[test]
    fn hyperlink_detection_ladder() {
        assert!(links(&env(&[("WT_SESSION", "")]), true));
        assert!(!links(&env(&[("CI", "1"), ("TERM", "alacritty")]), true));
        assert!(links(&env(&[("CI", ""), ("TERM", "alacritty")]), true));
        assert!(links(
            &env(&[
                ("TERM_PROGRAM", "iTerm.app"),
                ("TERM_PROGRAM_VERSION", "3.1.0")
            ]),
            true
        ));
        assert!(!links(
            &env(&[
                ("TERM_PROGRAM", "iTerm.app"),
                ("TERM_PROGRAM_VERSION", "3.0.9")
            ]),
            true
        ));
        assert!(!links(&env(&[("TERM_PROGRAM", "iTerm.app")]), true));
        assert!(links(
            &env(&[
                ("TERM_PROGRAM", "WezTerm"),
                ("TERM_PROGRAM_VERSION", "20240203-110809-5046fc22")
            ]),
            true
        ));
        assert!(links(
            &env(&[
                ("TERM_PROGRAM", "vscode"),
                ("TERM_PROGRAM_VERSION", "1.72.0")
            ]),
            true
        ));
        assert!(!links(
            &env(&[
                ("TERM_PROGRAM", "vscode"),
                ("TERM_PROGRAM_VERSION", "1.71.9")
            ]),
            true
        ));
        assert!(links(&env(&[("TERM_PROGRAM", "ghostty")]), true));
        // An unknown TERM_PROGRAM falls through to VTE.
        assert!(links(
            &env(&[("TERM_PROGRAM", "other"), ("VTE_VERSION", "6003")]),
            true
        ));
        assert!(!links(&env(&[("VTE_VERSION", "0.50.0")]), true));
        assert!(links(&env(&[("VTE_VERSION", "5000")]), true));
        assert!(!links(&env(&[("VTE_VERSION", "4900")]), true));
        assert!(!links(&Env::new(), true));
    }

    #[test]
    fn hyperlink_directives_and_platform() {
        let e = env(&[("MDVIEW_HYPERLINKS", "never"), ("TERM_PROGRAM", "ghostty")]);
        assert!(!links(&e, true));
        assert!(!resolve_hyperlinks(&HyperlinkInput {
            env: Some(&env(&[("TERM", "alacritty")])),
            is_tty: Some(true),
            platform: Some("win32"),
            ..Default::default()
        }));
        assert!(resolve_hyperlinks(&HyperlinkInput {
            is_tty: Some(true),
            config: Some(Always),
            ..Default::default()
        }));
    }

    #[test]
    fn tmux_detection() {
        assert!(resolve_tmux(&env(&[("TERM", "screen-256color")])));
        assert!(resolve_tmux(&env(&[("TERM", "tmux-256color")])));
        assert!(resolve_tmux(&env(&[("TMUX", "")])));
        assert!(!resolve_tmux(&env(&[("TERM", "xterm")])));
    }

    #[test]
    fn js_parse_int_is_a_prefix_parse() {
        assert_eq!(js_parse_int("20200620-abc"), 20_200_620.0);
        assert_eq!(js_parse_int(" -3"), -3.0);
        assert!(js_parse_int("x1").is_nan());
        assert!(js_parse_int("").is_nan());
    }

    #[test]
    fn resolve_colour_policy_composes_the_three() {
        let e = env(&[("FORCE_COLOR", "3"), ("TMUX", "1")]);
        let p = resolve_colour_policy(&ColourPolicyInput {
            env: Some(&e),
            is_tty: Some(false),
            ..Default::default()
        });
        assert_eq!(
            p,
            Policy {
                sgr: Sgr::Full,
                hyperlinks: false,
                tmux: true
            }
        );
    }
}
