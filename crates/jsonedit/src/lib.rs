//! jsonedit — validate (and, from WP-3 of `plans/jsonedit.md`, edit) JSON,
//! JSONC and JSON5 files without re-printing them. This module is the CLI:
//! `--check` runs the pure validator in `validate.rs` and reports
//! `FILE:LINE:COL: message`; the editor loop is not implemented yet.

use std::io::Write;
use std::path::Path;

pub mod validate;
pub use validate::{Diagnostic, Dialect, validate};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "usage: jsonedit [--dialect json|jsonc|json5] [--indent tab|N] FILE\n       jsonedit --check [--dialect json|jsonc|json5] FILE\n       jsonedit --version | --help";

/// Outcome of parsing the command line, kept pure for testing.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Help,
    Check {
        file: String,
        dialect: Option<Dialect>,
    },
    /// Edit mode — WP-3; for now a usage error.
    Edit,
    Usage(String),
}

pub fn parse_args(args: &[String]) -> Command {
    match args {
        [a] if a == "--version" => return Command::Version,
        [a] if a == "--help" || a == "-h" => return Command::Help,
        _ => {}
    }
    let (mut check, mut dialect, mut file) = (false, None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--check" if !check => check = true,
            "--dialect" if dialect.is_none() => {
                let Some(v) = it.next() else {
                    return Command::Usage("--dialect needs a value".into());
                };
                match Dialect::from_name(v) {
                    Some(d) => dialect = Some(d),
                    None => return Command::Usage(format!("unknown dialect '{v}'")),
                }
            }
            s if s.starts_with('-') && s != "-" => {
                return Command::Usage(format!("unexpected option '{s}'"));
            }
            s if file.is_none() => file = Some(s.to_string()),
            s => return Command::Usage(format!("unexpected argument '{s}'")),
        }
    }
    match (check, file) {
        (_, None) => Command::Usage("missing FILE".into()),
        (true, Some(file)) => Command::Check { file, dialect },
        (false, Some(_)) => Command::Edit,
    }
}

/// Runs the CLI and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    run_with(args, &mut std::io::stdout(), &mut std::io::stderr())
}

pub fn run_with(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    match parse_args(args) {
        Command::Version => {
            let _ = writeln!(out, "jsonedit {VERSION}");
            0
        }
        Command::Help => {
            let _ = writeln!(out, "jsonedit {VERSION}\n{USAGE}");
            0
        }
        Command::Usage(why) => {
            let _ = writeln!(err, "jsonedit: {why}\n{USAGE}");
            2
        }
        Command::Edit => {
            let _ = writeln!(
                err,
                "jsonedit: editing is not implemented yet; use --check\n{USAGE}"
            );
            2
        }
        Command::Check { file, dialect } => check(&file, dialect, err),
    }
}

fn check(file: &str, dialect: Option<Dialect>, err: &mut dyn Write) -> i32 {
    let bytes = match std::fs::read(file) {
        Ok(b) => b,
        Err(e) => {
            let _ = writeln!(err, "jsonedit: {file}: {e}");
            return 1;
        }
    };
    let dialect = dialect.unwrap_or_else(|| Dialect::from_path(Path::new(file)));
    match validate(&bytes, dialect) {
        Ok(()) => 0,
        Err(diags) => {
            for d in diags {
                let _ = writeln!(err, "{file}:{}:{}: {}", d.line, d.column, d.message);
            }
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(args: &[&str]) -> (i32, String, String) {
        let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with(&args, &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn version_and_help_exit_zero() {
        assert_eq!(
            call(&["--version"]),
            (0, format!("jsonedit {VERSION}\n"), String::new())
        );
        let (code, out, _) = call(&["--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("usage:"));
    }

    #[test]
    fn anything_else_is_usage_exit_two() {
        for args in [&[][..], &["x"][..], &["--version", "x"][..]] {
            let (code, out, err) = call(args);
            assert_eq!((code, out.as_str()), (2, ""));
            assert!(err.contains("usage:"));
        }
    }
}
