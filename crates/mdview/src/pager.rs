//! The pager, ported from `TS_BASELINE` `src/cli.ts`'s `runPager` (WP-8 of `plans/mdview-rust-port.md`).
//!
//! `less -R` when stdout is a TTY and `--no-pager` is absent; plain stdout when `less` cannot
//! be spawned, exactly like TS's `child.on("error")` fallback. The TTY question is answered by
//! the caller **before** the spawn (once `less` owns the terminal the answer is meaningless).
//!
//! One deliberate departure from TS: a `BrokenPipe` on stdout is quiet success. Bun crashes
//! with an `EPIPE` trace and exit 1 on `mdview x | head -c1`; the plan locks quiet exit 0.

use std::io::{self, Write};
use std::process::{Command, Stdio};

/// Whether this run pages: `process.stdout.isTTY && !options.noPager`.
pub fn should_page(stdout_is_tty: bool, no_pager: bool) -> bool {
    stdout_is_tty && !no_pager
}

/// Write `bytes` to `out`, treating a closed reader (`BrokenPipe`) as success.
pub fn write_quiet(out: &mut dyn Write, bytes: &[u8]) -> io::Result<()> {
    match out.write_all(bytes).and_then(|()| out.flush()) {
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}

/// Write to the process's stdout, `BrokenPipe` being quiet success.
pub fn write_stdout(text: &str) -> io::Result<()> {
    write_quiet(&mut io::stdout().lock(), text.as_bytes())
}

/// `runPager`: pipe `output` through `program -R`, else fall back to `fallback`.
/// Returns whether the pager ran.
pub fn page_with(program: &str, output: &str, fallback: &mut dyn Write) -> io::Result<bool> {
    let child = Command::new(program)
        .arg("-R")
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => {
            write_quiet(fallback, output.as_bytes())?;
            return Ok(false);
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        // A pager quit early closes its stdin; TS swallows that, and so does this.
        let _ = stdin.write_all(output.as_bytes());
    }
    let _ = child.wait();
    Ok(true)
}

/// `runPager(output)` with `less`.
pub fn page(output: &str) -> io::Result<()> {
    page_with("less", output, &mut io::stdout().lock()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_is_tty_and_not_no_pager() {
        assert!(should_page(true, false));
        assert!(!should_page(true, true));
        assert!(!should_page(false, false));
        assert!(!should_page(false, true));
    }

    #[test]
    fn absent_pager_falls_back_to_stdout() {
        let mut buf = Vec::new();
        let ran = page_with("mdview-no-such-pager-binary", "hello\n", &mut buf).unwrap();
        assert!(!ran);
        assert_eq!(buf, b"hello\n");
    }

    #[test]
    fn present_pager_receives_output() {
        // `cat -R` is not valid; `true` ignores its argument and its stdin.
        let mut buf = Vec::new();
        assert!(page_with("true", "x".repeat(1 << 20).as_str(), &mut buf).unwrap());
        assert!(buf.is_empty());
    }

    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn broken_pipe_is_quiet_success_other_errors_are_not() {
        assert!(write_quiet(&mut Broken, b"x").is_ok());
        struct Full;
        impl Write for Full {
            fn write(&mut self, _: &[u8]) -> io::Result<usize> {
                Err(io::Error::from(io::ErrorKind::StorageFull))
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        assert!(write_quiet(&mut Full, b"x").is_err());
    }
}
