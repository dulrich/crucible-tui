//! jsonedit — validate (and, from WP-3 of `plans/jsonedit.md`, edit) JSON,
//! JSONC and JSON5 files without re-printing them. This module is the CLI:
//! `--check` runs the pure validator in `validate.rs` and reports
//! `FILE:LINE:COL: message`; edit mode runs the safe-edit loop in `edit.rs`.

use std::io::Write;
use std::path::Path;

pub mod edit;
pub mod indent;
pub mod validate;
pub use edit::EditEnv;
pub use indent::Indent;
pub use validate::{Diagnostic, Dialect, validate};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Build id embedded by `build.rs` (fleet `--build` / `--version` contract).
pub const BUILD_ID: &str = env!("FLEET_BUILD_ID");

const USAGE: &str = "usage: jsonedit [--dialect json|jsonc|json5] [--indent tab|N] FILE\n       jsonedit --check [--dialect json|jsonc|json5] FILE\n       jsonedit --version | --help";

/// Outcome of parsing the command line, kept pure for testing.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Build,
    Help,
    Check {
        file: String,
        dialect: Option<Dialect>,
    },
    Edit {
        file: String,
        dialect: Option<Dialect>,
        indent: Option<Indent>,
    },
    Usage(String),
}

pub fn parse_args(args: &[String]) -> Command {
    // `--help` wins over `--build`/`--version` (fleet build/version gate); both answer before any file I/O.
    if args.iter().any(|a| a == "--help" || a == "-h") {
        return Command::Help;
    }
    if args.iter().any(|a| a == "--build") {
        return Command::Build;
    }
    if args.iter().any(|a| a == "--version") {
        return Command::Version;
    }
    let (mut check, mut dialect, mut file, mut indent) = (false, None, None, None);
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
            "--indent" if indent.is_none() => {
                let Some(v) = it.next() else {
                    return Command::Usage("--indent needs a value".into());
                };
                match Indent::from_name(v) {
                    Some(i) => indent = Some(i),
                    None => return Command::Usage(format!("bad --indent '{v}' (tab or N)")),
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
        (true, Some(_)) if indent.is_some() => {
            Command::Usage("--indent applies to edit mode only".into())
        }
        (true, Some(file)) => Command::Check { file, dialect },
        (false, Some(file)) => Command::Edit {
            file,
            dialect,
            indent,
        },
    }
}

/// Runs the CLI and returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    run_with(args, &mut std::io::stdout(), &mut std::io::stderr())
}

/// Like [`run`], with the edit environment taken from the process.
pub fn run_with(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    run_env(args, out, err, &mut EditEnv::from_process)
}

/// Runs the CLI with an injected edit environment (built only in edit mode).
pub fn run_env(
    args: &[String],
    out: &mut dyn Write,
    err: &mut dyn Write,
    env: &mut dyn FnMut() -> Result<EditEnv, String>,
) -> i32 {
    match parse_args(args) {
        Command::Version => {
            let _ = writeln!(out, "jsonedit {VERSION} ({BUILD_ID})");
            0
        }
        Command::Build => {
            let _ = writeln!(out, "{BUILD_ID}");
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
        Command::Edit {
            file,
            dialect,
            indent,
        } => match env() {
            Ok(mut env) => edit::edit(&file, dialect, indent, &mut env, err),
            Err(why) => {
                let _ = writeln!(err, "jsonedit: {why}");
                1
            }
        },
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
            (
                0,
                format!("jsonedit {VERSION} ({BUILD_ID})\n"),
                String::new()
            )
        );
        assert_eq!(
            call(&["--build"]),
            (0, format!("{BUILD_ID}\n"), String::new())
        );
        assert_eq!(call(&["--build", "--help"]).0, 0);
        assert!(call(&["--build", "--help"]).1.contains("usage:"));
        let (code, out, _) = call(&["--help"]);
        assert_eq!(code, 0);
        assert!(out.contains("usage:"));
    }

    #[test]
    fn anything_else_is_usage_exit_two() {
        for args in [
            &[][..],
            &["--check", "--indent", "2", "x"][..],
            &["--indent", "3x", "x"][..],
        ] {
            let (code, out, err) = call(args);
            assert_eq!((code, out.as_str()), (2, ""));
            assert!(err.contains("usage:"));
        }
    }
}
