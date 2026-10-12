//! jsonedit — skeleton (WP-1 of `plans/jsonedit.md`). Only `--version` and
//! `--help` exist yet; validation and the editor loop land in WP-2/WP-3.
//! `jsonc-parser` is declared but not referenced until WP-2.

use std::io::Write;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const USAGE: &str = "usage: jsonedit --version | --help";

/// Outcome of parsing the command line, kept pure for testing.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Help,
    Usage,
}

pub fn parse_args(args: &[String]) -> Command {
    match args {
        [a] if a == "--version" => Command::Version,
        [a] if a == "--help" || a == "-h" => Command::Help,
        _ => Command::Usage,
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
        Command::Usage => {
            let _ = writeln!(err, "{USAGE}");
            2
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
            assert!(err.starts_with("usage:"));
        }
    }
}
