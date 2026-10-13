//! Argument parsing, width resolution and the view path, ported behaviourally from
//! `TS_BASELINE` `src/cli.ts` (WP-8 of `plans/mdview-rust-port.md`). The TS file is the spec; every message,
//! usage text and exit path is byte-identical unless this header names the departure.
//!
//! Process state is read here (env, TTY-ness, terminal columns, cwd) and handed to
//! `colour.rs`/`glyphs.rs`/`probe.rs` as values, the way `cli.ts` hands them `process.env`.
//!
//! Deliberate TS quirks reproduced (each cites `TS_BASELINE` `src/cli.ts`):
//! - a bare `<file.md>` with no subcommand is the view path; `view`/`help`/`highlight-as`/
//!   `probe` dispatch only when they are exactly `args[0]` (`main`);
//! - `--width`'s value is an empty-is-missing (`!value`) slot, and a following flag is
//!   consumed as the value;
//! - `--ascii --ascii` is fine, `--ascii --unicode` throws; `--color`/`--hyperlinks` repeat
//!   last-wins, `--no-color` is `--color=never`;
//! - an empty-string file argument counts as missing (`!file`), but still occupies the slot
//!   for the "unexpected extra argument" check (`file !== undefined`);
//! - `--probe` delegates to `probe` with no arguments, after `--help`/`--licenses`;
//! - `probe --timeout` with no value reports `got: undefined`;
//! - `highlight-as` checks `--help` anywhere first, then the first `-` argument, then the
//!   positional count;
//!
//! **Leading BOM (D-D):** `readFile(path, "utf8")` keeps U+FEFF and replaces invalid UTF-8
//! with U+FFFD; `String::from_utf8_lossy` does the same (same maximal-subpart replacement),
//! and nothing here strips the BOM; what the lexer does with it is `lex/`'s concern.
//!
//! Departures, named: a `BrokenPipe` on stdout is quiet exit 0 (TS crashes with exit 1); a
//! `--width` and `probe --timeout` accept a plain unsigned decimal integer only (TS took any
//! JS `Number()` spelling — hex, exponent, fraction, padding); a read error carries
//! `io::Error`'s own text (TS printed Node's `fs` errno wording) — WP-R9, ruling (a);
//! `highlight-as` validates against the syntect language set the renderer highlights with.

pub const USAGE: &str = r#"usage: mdview <file.md> [--width N] [--no-pager] [--check] [--ascii|--unicode] [--color[=WHEN]] [--no-color] [--plain] [--hyperlinks[=WHEN]] [--probe] [--help] [--licenses]

  <file.md>       markdown file to render (required unless --licenses or
                  --probe is given)
  --width N       target render width (default: terminal columns, else 100)
  --color[=WHEN]  when to emit colour: auto (the default), always, or never.
                  Bare --color means --color=always. Repeated, the last one
                  wins
  --no-color      alias for --color=never
  --plain         emit nothing of this tool's own: no SGR colour, no OSC-8
                  hyperlinks. Explicit and absolute — it overrides every
                  other colour/hyperlink input, including a malformed
                  MDVIEW_COLOR or MDVIEW_HYPERLINKS, which under --plain are
                  never even consulted (so no warning about either is
                  printed). Authored escape bytes already in the document are
                  content and pass through unchanged, exactly as they do
                  under --color=never
  --hyperlinks[=WHEN]  when to emit OSC-8 hyperlinks: auto (the default),
                  always, or never. Same conventions as --color. See the
                  hyperlink resolution paragraph below for how it combines
                  with the non-TTY ceiling
  --no-pager      write plain output to stdout instead of piping to a pager
  --check         render with no pager; exit non-zero if any non-code line
                  exceeds the target width (this tool's self-smoke gate)
  --ascii         force the ASCII glyph tier (bullets, rules, table borders,
                  task states) regardless of detected terminal capability
  --unicode       force the Unicode glyph tier; mutually exclusive with --ascii
  --probe         run the terminal ambiguous-width diagnostic and exit; the
                  same thing as `mdview probe` (no file argument needed)
  --help, -h      print this message and exit
  --licenses      print aggregated third-party license notices and exit (no
                  file argument needed; see THIRD-PARTY-LICENSES.txt)

Glyph tier resolution (highest precedence first): resolved ambiguous width
wide forces ASCII (see below), then --ascii/--unicode, then
MDVIEW_GLYPHS=ascii|unicode in the environment, then auto-detection from the
locale and TERM.

Colour resolution (highest precedence first): --plain (absolute — see above),
then --color, then MDVIEW_COLOR=auto|always|never, then NO_COLOR (present at
all, even empty, means never), then FORCE_COLOR (0/false mean never; empty,
true and 1-3 mean always; any other value decides nothing), then the config
file's "color" key, then whether stdout is a terminal. Piped output is
therefore colourless unless you ask for colour explicitly. An explicit never
drops colour but keeps bold, dim, italic, underline and strikethrough (the
formats level); --plain is what removes those too.

OSC-8 hyperlinks are a separate axis, highest precedence first: --plain
(absolute off), then the non-TTY ceiling (never off a terminal, whatever else
is set), then --hyperlinks, then MDVIEW_HYPERLINKS=auto|always|never, then the
config file's "hyperlinks" key, then terminal detection (what the terminal
advertises). On the same axis, a [[wiki-link]] whose slug names a file under
the note's own vault or repository root (the nearest ancestor directory holding
.obsidian or .git) becomes a file:// hyperlink to that file.

Ambiguous-width resolution (highest precedence first): MDVIEW_AMBIGUOUS=narrow|wide
in the environment, then a cached probe result for this terminal, then a live
probe when both stdin and stdout are TTYs, then narrow. Run `mdview probe` to
see which rule won and why.

Subcommands (a bare <file.md> above is still valid on its own — no subcommand
is required to view a file):
  highlight-as <fence> <language>   map a fence language to a highlighter
                                     language and save it to the config file
  probe [--refresh] [--no-cache] [--timeout MS]
                                     report how this terminal renders East Asian
                                     Ambiguous characters
  view <file.md> [options]          same as the bare form above, spelled out
  help [subcommand]                 print this message, or a subcommand's own

Run `mdview <subcommand> --help` or `mdview help <subcommand>` for a
subcommand's own usage.
"#;

pub const HIGHLIGHT_AS_USAGE: &str = r#"usage: mdview highlight-as <fence> <language>

  <fence>       fence info-string language to alias (e.g. dataviewjs)
  <language>    highlighter language to render it as — validated against
                the highlighter's supported list before anything is written
  --help, -h    print this message and exit

Records "<fence> -> <language>" into the user config
($XDG_CONFIG_HOME/mdview/config.json, default ~/.config/mdview/config.json),
layered over the built-in aliases (dataviewjs -> javascript, dataview -> sql).
A user entry for a fence that also has a built-in default wins. The write only
ever touches this one entry: every other config key, and every other
highlight-as mapping, is left as-is.
"#;

pub const PROBE_USAGE: &str = r#"usage: mdview probe [--refresh] [--no-cache] [--timeout MS]

  --refresh     ignore any cached answer and re-probe the terminal
  --no-cache    do not write the result to the cache
  --timeout MS  how long to wait for the terminal's DSR reply (default: 200)
  --help, -h    print this message and exit

Reports how this terminal renders East Asian **Ambiguous** characters — the
class that almost every non-ASCII character in real prose belongs to (— – → ←
… ≥ × • ○ and the whole box-drawing set). Such a character is 1 column in some
terminals and 2 in others, and there is no way to tell from the byte, so the
viewer has to ask.

The probe writes one test glyph (—) at the cursor, asks the terminal for
the cursor position before and after with DSR (\e[6n), and takes the difference.
It reads the reply in raw mode with a short timeout, restores cooked mode on
every exit path, and erases the glyph afterwards, so it leaves nothing behind.
It runs only when stdin and stdout are both TTYs — never under --check, never
in the sweep, never when piped.

The answer is cached per terminal identity (TERM, TERM_PROGRAM, COLORTERM,
VTE_VERSION, the multiplexer, and the locale) so a second terminal never
inherits the first one's answer. Set MDVIEW_AMBIGUOUS=narrow|wide to override
everything, including the cache.
"#;

use std::collections::HashMap;

use crate::colour::{
    ColourDirective, ColourPolicyInput, Env, Policy, parse_colour_directive, resolve_colour_policy,
    resolve_tmux,
};
use crate::config::{load_config, resolve_config_path, write_highlight_alias};
use crate::glyphs::{Tier, resolve_glyphs, wide_forces_ascii};
use crate::lang::FenceLanguageResolver;
use crate::overflow::find_first_overflow;
use crate::pager::{page, should_page, write_stdout};
use crate::probe::{ResolveAmbiguousOptions, format_probe_report, resolve_ambiguous_width};
use crate::render::RenderOptions;
use crate::style::Sgr;

/// `--licenses`: the same file TS embeds, so the bytes match by construction.
pub const LICENSE_NOTICES: &str = include_str!("../../../THIRD-PARTY-LICENSES.txt");

/// Why the CLI stopped: a user-facing message (exit 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    Message(String),
}

impl From<String> for CliError {
    fn from(m: String) -> Self {
        CliError::Message(m)
    }
}

impl From<&str> for CliError {
    fn from(m: &str) -> Self {
        CliError::Message(m.to_owned())
    }
}

type CliResult = Result<i32, CliError>;

/// The process inputs `cli.ts` reads from `process`, gathered once.
pub struct Process {
    pub env: Env,
    pub stdin_is_tty: bool,
    pub stdout_is_tty: bool,
    pub columns: Option<u32>,
    pub cwd: String,
}

impl Process {
    pub fn current() -> Self {
        let env: Env = std::env::vars_os()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
            .collect::<HashMap<_, _>>();
        let stdout_is_tty = rustix::termios::isatty(std::io::stdout());
        let columns = if stdout_is_tty {
            rustix::termios::tcgetwinsize(std::io::stdout())
                .ok()
                .map(|w| u32::from(w.ws_col))
        } else {
            None
        };
        Process {
            env,
            stdin_is_tty: rustix::termios::isatty(std::io::stdin()),
            stdout_is_tty,
            columns,
            cwd: std::env::current_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|_| "/".into()),
        }
    }
}

/// `CliOptions`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CliOptions {
    pub file: String,
    pub width: Option<usize>,
    pub no_pager: bool,
    pub check: bool,
    pub help: bool,
    pub licenses: bool,
    pub probe: bool,
    pub glyph_tier: Option<Tier>,
    pub color: Option<ColourDirective>,
    pub hyperlinks: Option<ColourDirective>,
    pub plain: bool,
}

/// `resolveWidth(explicit, columns)`.
pub fn resolve_width(explicit: Option<usize>, columns: Option<u32>) -> usize {
    if let Some(w) = explicit {
        return w;
    }
    match columns {
        Some(c) if c > 0 => c as usize,
        _ => 100,
    }
}

fn directive_flag(arg: &str, name: &str) -> Result<Option<ColourDirective>, String> {
    if arg == format!("--{name}") {
        return Ok(Some(ColourDirective::Always));
    }
    let Some(raw) = arg.strip_prefix(&format!("--{name}=")) else {
        return Ok(None);
    };
    parse_colour_directive(Some(raw))
        .map(Some)
        .ok_or_else(|| format!("--{name} must be auto, always or never, got: {raw}"))
}

/// `parseArgs(args)`.
pub fn parse_args(args: &[String]) -> Result<CliOptions, String> {
    let mut o = CliOptions::default();
    let mut file: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        match arg {
            "--help" | "-h" => o.help = true,
            "--licenses" => o.licenses = true,
            "--probe" => o.probe = true,
            "--no-pager" => o.no_pager = true,
            "--check" => o.check = true,
            "--ascii" | "--unicode" => {
                let requested = if arg == "--ascii" {
                    Tier::Ascii
                } else {
                    Tier::Unicode
                };
                if o.glyph_tier.is_some_and(|t| t != requested) {
                    return Err("--ascii and --unicode are mutually exclusive".into());
                }
                o.glyph_tier = Some(requested);
            }
            "--no-color" => o.color = Some(ColourDirective::Never),
            "--plain" => o.plain = true,
            "--width" => {
                let value = args.get(index).map(String::as_str).unwrap_or("");
                if value.is_empty() {
                    return Err("missing value for --width".into());
                }
                match parse_positive_int(value) {
                    Some(n) => o.width = Some(n),
                    None => {
                        return Err(format!("--width must be a positive number, got: {value}"));
                    }
                }
                index += 1;
            }
            _ => {
                if let Some(d) = directive_flag(arg, "color")? {
                    o.color = Some(d);
                } else if let Some(d) = directive_flag(arg, "hyperlinks")? {
                    o.hyperlinks = Some(d);
                } else if arg.starts_with('-') {
                    return Err(format!("unknown argument: {arg}"));
                } else if file.is_some() {
                    return Err(format!("unexpected extra argument: {arg}"));
                } else {
                    file = Some(arg.to_owned());
                }
            }
        }
    }
    let file = file.unwrap_or_default();
    if !o.help && !o.licenses && !o.probe && file.is_empty() {
        return Err("missing required argument: <file.md>".into());
    }
    o.file = file;
    Ok(o)
}

/// A plain unsigned decimal integer greater than zero (`usize::from_str` also takes a
/// leading `+`, which is refused here so the spelling stays digits only).
fn parse_positive_int<T: std::str::FromStr + Default + PartialOrd>(raw: &str) -> Option<T> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<T>().ok().filter(|n| *n > T::default())
}

/// `readFile(file, "utf8")`: BOM kept, invalid UTF-8 replaced (D-D).
fn read_source(file: &str) -> Result<String, String> {
    use std::io::Read;
    let wrap = |reason: String| format!("cannot read file: {file} ({reason})");
    let mut handle = std::fs::File::open(file).map_err(|e| wrap(e.to_string()))?;
    let mut bytes = Vec::new();
    handle
        .read_to_end(&mut bytes)
        .map_err(|e| wrap(e.to_string()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn emit(text: &str) -> Result<(), CliError> {
    write_stdout(text).map_err(|e| CliError::Message(e.to_string()))
}

fn warn(message: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{message}");
}

fn run_view(args: &[String], p: &Process) -> CliResult {
    let options = parse_args(args)?;
    if options.help {
        emit(USAGE)?;
        return Ok(0);
    }
    if options.licenses {
        emit(LICENSE_NOTICES)?;
        return Ok(0);
    }
    if options.probe {
        return run_probe(&[], p);
    }
    let source = read_source(&options.file)?;
    let config = load_config(&resolve_config_path(&p.env), &mut |m| warn(m));

    let target_width = resolve_width(options.width, p.columns);
    let ambiguous = resolve_ambiguous_width(ResolveAmbiguousOptions {
        allow_probe: !options.check,
        ..ResolveAmbiguousOptions::new(&p.env)
    });
    let glyphs = resolve_glyphs(&p.env, options.glyph_tier, Some(ambiguous.ambiguous));
    if wide_forces_ascii(options.glyph_tier, ambiguous.ambiguous) {
        warn(
            "mdview: --unicode ignored — this terminal measures East Asian Ambiguous characters as 2 columns, and the Unicode box-drawing set is ambiguous, so tables cannot be laid out with it. Set MDVIEW_AMBIGUOUS=narrow to override (see `mdview probe`).",
        );
    }
    let policy = if options.plain {
        Policy {
            sgr: Sgr::None,
            hyperlinks: false,
            tmux: resolve_tmux(&p.env),
        }
    } else {
        let w = |m: &str| warn(m);
        resolve_colour_policy(&ColourPolicyInput {
            flag: options.color,
            config: config.color,
            hyperlink_flag: options.hyperlinks,
            hyperlink_config: config.hyperlinks,
            env: Some(&p.env),
            is_tty: Some(p.stdout_is_tty),
            platform: Some(std::env::consts::OS),
            warn: Some(&w),
        })
    };
    // `createWikiLinkResolver(resolve(file))` only under hyperlinks: `render.rs` builds it
    // from `path` (`wikiresolve::create_wiki_link_resolver`).
    let path = policy
        .hyperlinks
        .then(|| crate::wikiresolve::resolve(&p.cwd, &options.file));

    let render_options = RenderOptions {
        width: target_width,
        tier: glyphs.tier,
        ambiguous: ambiguous.ambiguous,
        policy,
        emoji: config.emoji,
        path,
        highlight_as: config.highlight_as.clone().unwrap_or_default(),
    };
    let rendered = crate::render(&source, &render_options).map_err(|e| format!("render: {e}"))?;
    let output = rendered.text;

    if options.check {
        if let Some(hit) = find_first_overflow(
            &output,
            target_width,
            &rendered.code_ranges,
            ambiguous.measure,
        ) {
            return Err(format!(
                "line {} exceeds target width {} (measured {})",
                hit.line, target_width, hit.width
            )
            .into());
        }
        emit(&output)?;
        return Ok(0);
    }
    if should_page(p.stdout_is_tty, options.no_pager) {
        page(&output).map_err(|e| CliError::Message(e.to_string()))?;
        return Ok(0);
    }
    emit(&output)?;
    Ok(0)
}

fn run_highlight_as(args: &[String], p: &Process) -> CliResult {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        emit(HIGHLIGHT_AS_USAGE)?;
        return Ok(0);
    }
    if let Some(flag) = args.iter().find(|a| a.starts_with('-')) {
        return Err(format!(
            "highlight-as: unknown argument: {flag} (run `mdview highlight-as --help`)"
        )
        .into());
    }
    if args.len() != 2 {
        return Err(format!(
            "highlight-as: expected exactly 2 arguments <fence> <language>, got {} (run `mdview highlight-as --help`)",
            args.len()
        )
        .into());
    }
    let (fence, language) = (&args[0], &args[1]);
    // Validated against the same language set `render.rs` highlights with (D-C).
    let validator = FenceLanguageResolver::builtin();
    if !validator.is_supported(language) {
        return Err(format!(
            "highlight-as: unsupported language \"{language}\" — the highlighter does not recognize it, so the fence would render unhighlighted rather than mysteriously plain later. Common valid targets: javascript, typescript, python, bash, sql, json, yaml, plaintext (\"plaintext\" is always accepted, if the fence should just not be highlighted)."
        )
        .into());
    }
    let result = write_highlight_alias(fence, language, &resolve_config_path(&p.env))?;
    emit(&format!(
        "mdview: {} config at {} — \"{}\" now highlights as \"{}\"\n",
        if result.created { "created" } else { "updated" },
        result.path.to_string_lossy(),
        crate::text::js_trim(fence).to_lowercase(),
        crate::text::js_trim(language).to_lowercase()
    ))?;
    Ok(0)
}

fn run_probe(args: &[String], p: &Process) -> CliResult {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        emit(PROBE_USAGE)?;
        return Ok(0);
    }
    let (mut refresh, mut no_cache, mut timeout_ms) = (false, false, None);
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        index += 1;
        match arg {
            "--refresh" => refresh = true,
            "--no-cache" => no_cache = true,
            "--timeout" => {
                let value = args.get(index);
                let Some(parsed) = value.and_then(|v| parse_positive_int::<u64>(v)) else {
                    return Err(format!(
                        "probe: --timeout must be a positive number of milliseconds, got: {}",
                        value.map_or("undefined", String::as_str)
                    )
                    .into());
                };
                timeout_ms = Some(parsed);
                index += 1;
            }
            _ => {
                return Err(
                    format!("probe: unknown argument: {arg} (run `mdview probe --help`)").into(),
                );
            }
        }
    }
    let resolution = resolve_ambiguous_width(ResolveAmbiguousOptions {
        allow_probe: true,
        refresh,
        no_cache,
        timeout_ms,
        ..ResolveAmbiguousOptions::new(&p.env)
    });
    emit(&format_probe_report(&resolution, p))?;
    Ok(0)
}

fn run_help(args: &[String]) -> CliResult {
    let text = match args.first().map(String::as_str) {
        None | Some("view" | "help") => USAGE,
        Some("highlight-as") => HIGHLIGHT_AS_USAGE,
        Some("probe") => PROBE_USAGE,
        Some(name) => {
            return Err(format!(
                "help: unknown subcommand: {name} (expected one of: view, highlight-as, probe, help)"
            )
            .into());
        }
    };
    emit(text)?;
    Ok(0)
}

/// `main(args)`: subcommands only when they are exactly `args[0]`; else the view path.
pub fn main_with(args: &[String], p: &Process) -> CliResult {
    match args.first().map(String::as_str) {
        Some("highlight-as") => run_highlight_as(&args[1..], p),
        Some("help") => run_help(&args[1..]),
        Some("probe") => run_probe(&args[1..], p),
        Some("view") => run_view(&args[1..], p),
        _ => run_view(args, p),
    }
}

/// `main()` over the current process.
pub fn main(args: &[String]) -> CliResult {
    main_with(args, &Process::current())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn err(list: &[&str]) -> String {
        parse_args(&a(list)).unwrap_err()
    }

    #[test]
    fn numeric_flags_are_plain_integers() {
        assert_eq!(
            parse_args(&a(&["f", "--width", "80"])).unwrap().width,
            Some(80)
        );
        for bad in [
            "0x50", "1e2", "80.5", "abc", " 80 ", "+80", "-1", "Infinity",
        ] {
            assert_eq!(
                err(&["f", "--width", bad]),
                format!("--width must be a positive number, got: {bad}"),
                "{bad}"
            );
        }
        assert_eq!(parse_positive_int::<u64>("250"), Some(250));
        for bad in ["0x50", "1e2", "80.5", "abc", "0", ""] {
            assert_eq!(parse_positive_int::<u64>(bad), None, "{bad}");
        }
    }

    #[test]
    fn width_resolution() {
        assert_eq!(resolve_width(Some(42), Some(90)), 42);
        assert_eq!(resolve_width(None, Some(90)), 90);
        assert_eq!(resolve_width(None, Some(0)), 100);
        assert_eq!(resolve_width(None, None), 100);
    }

    #[test]
    fn parses_the_flag_set() {
        let o = parse_args(&a(&[
            "f.md",
            "--width",
            "80",
            "--check",
            "--no-pager",
            "--ascii",
            "--ascii",
            "--plain",
        ]))
        .unwrap();
        assert_eq!(
            (o.file.as_str(), o.width, o.check, o.no_pager, o.plain),
            ("f.md", Some(80), true, true, true)
        );
        assert_eq!(o.glyph_tier, Some(Tier::Ascii));
        let o = parse_args(&a(&[
            "f",
            "--color",
            "--no-color",
            "--hyperlinks=never",
            "--hyperlinks",
        ]))
        .unwrap();
        assert_eq!(o.color, Some(ColourDirective::Never));
        assert_eq!(o.hyperlinks, Some(ColourDirective::Always));
        let o = parse_args(&a(&["--no-color", "--color=auto", "f"])).unwrap();
        assert_eq!(o.color, Some(ColourDirective::Auto));
        assert!(parse_args(&a(&["--help"])).unwrap().help);
        assert!(parse_args(&a(&["--licenses"])).unwrap().licenses);
        assert!(parse_args(&a(&["--probe"])).unwrap().probe);
    }

    #[test]
    fn parse_errors_are_the_ts_messages() {
        assert_eq!(
            err(&["--ascii", "--unicode", "f"]),
            "--ascii and --unicode are mutually exclusive"
        );
        assert_eq!(
            err(&["--color=sometimes", "f"]),
            "--color must be auto, always or never, got: sometimes"
        );
        assert_eq!(
            err(&["--hyperlinks=", "f"]),
            "--hyperlinks must be auto, always or never, got: "
        );
        assert_eq!(err(&["f", "--width"]), "missing value for --width");
        assert_eq!(err(&["f", "--width", ""]), "missing value for --width");
        assert_eq!(
            err(&["f", "--width", "0"]),
            "--width must be a positive number, got: 0"
        );
        assert_eq!(
            err(&["--width", "--check", "f"]),
            "--width must be a positive number, got: --check"
        );
        assert_eq!(err(&["--bogus"]), "unknown argument: --bogus");
        assert_eq!(err(&["-"]), "unknown argument: -");
        assert_eq!(err(&["a", "b"]), "unexpected extra argument: b");
        assert_eq!(err(&["", "b"]), "unexpected extra argument: b");
        assert_eq!(err(&[]), "missing required argument: <file.md>");
        assert_eq!(err(&[""]), "missing required argument: <file.md>");
    }

    #[test]
    fn read_errors_carry_io_error_text() {
        let e = read_source("/nonexistent-mdview-dir/x.md").unwrap_err();
        assert_eq!(
            e,
            "cannot read file: /nonexistent-mdview-dir/x.md (No such file or directory (os error 2))"
        );
        let e = read_source("/").unwrap_err();
        assert_eq!(e, "cannot read file: / (Is a directory (os error 21))");
    }

    #[test]
    fn source_keeps_bom_and_replaces_invalid_utf8() {
        let p = std::env::temp_dir().join(format!("mdview-bom-{}.md", std::process::id()));
        std::fs::write(&p, b"\xEF\xBB\xBF# T\xFF\n").unwrap();
        let s = read_source(p.to_str().unwrap()).unwrap();
        assert_eq!(s, "\u{FEFF}# T\u{FFFD}\n");
        std::fs::remove_file(&p).unwrap();
    }
}
