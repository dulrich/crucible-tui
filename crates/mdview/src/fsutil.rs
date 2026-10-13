//! The one atomic file writer and home-directory lookup mdview's two writers share
//! (the config's `highlightAs` update and the ambiguous-width cache). jsonedit keeps its own,
//! stronger replace (mode/owner preservation); the crates deliberately share no code.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::colour::Env;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `homedir()`: `HOME` from the threaded `Env`, else the platform answer, else empty.
pub fn home_dir(env: &Env) -> String {
    env.get("HOME")
        .filter(|h| !h.is_empty())
        .cloned()
        .or_else(|| std::env::home_dir().map(|p| p.to_string_lossy().into_owned()))
        .unwrap_or_default()
}

/// A temp path beside `path`: pid, nanoseconds and a process-wide counter, so two writers in
/// one process (or two processes in one nanosecond) never collide.
fn temp_path(path: &Path) -> PathBuf {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(".{name}.tmp-{}-{nanos}-{n}", std::process::id()))
}

/// Write `bytes` to `path` atomically: a temp file in the same directory, `sync_all`, rename.
/// The temp is removed on any error. The parent directory must exist.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = temp_path(path);
    let attempt = || -> std::io::Result<()> {
        let mut file = File::options().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    };
    let result = attempt();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mdview-fsutil-{tag}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn writes_content_and_leaves_no_temp() {
        let dir = scratch("ok");
        let path = dir.join("out.json");
        write_atomic(&path, b"one\n").unwrap();
        write_atomic(&path, b"two\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two\n");
        assert_eq!(entries(&dir), vec!["out.json".to_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn failed_rename_removes_the_temp() {
        let dir = scratch("fail");
        let target = dir.join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("occupant"), "x").unwrap();
        assert!(write_atomic(&target, b"payload").is_err());
        assert_eq!(entries(&dir), vec!["target".to_owned()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn home_dir_reads_the_threaded_env() {
        let e: Env = [("HOME".to_owned(), "/threaded/home".to_owned())]
            .into_iter()
            .collect();
        assert_eq!(home_dir(&e), "/threaded/home");
    }

    #[test]
    fn temp_names_are_unique() {
        let p = Path::new("/x/f");
        assert_ne!(temp_path(p), temp_path(p));
    }
}
