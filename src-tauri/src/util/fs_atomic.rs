//! Atomic file writes — temp file + rename, with a Windows fallback for
//! cases where rename-over-existing fails on older filesystems.
//!
//! Two flavors:
//!   - [`atomic_write_sync`]   — `std::fs` (for sync IPC handlers)
//!   - [`atomic_write_async`]  — `tokio::fs` (for async IPC handlers)
//!
//! Both create the parent directory if it doesn't exist (broadest of the
//! four pre-consolidation behaviors), and write to `<path>.tmp` then rename.
//! Errors are returned as [`std::io::Result`] so callers can apply their
//! own user-facing formatting.
//!
//! On rename failure (Windows cross-device or rename-over-existing on
//! older filesystems), the helper attempts `remove(target)` then a single
//! retry rename. The temp file is best-effort cleaned up on terminal failure.

use std::io;
use std::path::Path;

/// Build the temp path used by both sync and async helpers. We append
/// `.tmp` to the file name (rather than `with_extension("tmp")`) so that
/// for a target of `foo.json` the temp is `foo.json.tmp` — preserving the
/// final extension keeps things readable and avoids accidental collisions
/// with sibling files that already have a `.tmp` extension.
fn tmp_path_for(path: &Path) -> std::path::PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::path::PathBuf::from(tmp)
}

/// Synchronous atomic write. Used by sync Tauri IPC handlers.
pub fn atomic_write_sync(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = tmp_path_for(path);
    std::fs::write(&tmp, contents)?;
    if let Err(first_err) = std::fs::rename(&tmp, path) {
        // Windows: rename-over-existing can fail on some filesystems.
        // Cross-device rename can also fail. Try remove + retry.
        if path.exists() {
            if let Err(remove_err) = std::fs::remove_file(path) {
                let _ = std::fs::remove_file(&tmp);
                return Err(io::Error::new(
                    first_err.kind(),
                    format!("rename failed ({first_err}); cleanup also failed: {remove_err}"),
                ));
            }
            if let Err(retry_err) = std::fs::rename(&tmp, path) {
                let _ = std::fs::remove_file(&tmp);
                return Err(retry_err);
            }
        } else {
            let _ = std::fs::remove_file(&tmp);
            return Err(first_err);
        }
    }
    Ok(())
}

/// Asynchronous atomic write. Used by async Tauri IPC handlers.
pub async fn atomic_write_async(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }
    let tmp = tmp_path_for(path);
    tokio::fs::write(&tmp, contents).await?;
    if let Err(first_err) = tokio::fs::rename(&tmp, path).await {
        if path.exists() {
            if let Err(remove_err) = tokio::fs::remove_file(path).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(io::Error::new(
                    first_err.kind(),
                    format!("rename failed ({first_err}); cleanup also failed: {remove_err}"),
                ));
            }
            if let Err(retry_err) = tokio::fs::rename(&tmp, path).await {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(retry_err);
            }
        } else {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(first_err);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Per-test scratch dir under the system tmp. Cleaned on Drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let pid = std::process::id();
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("tx-fs-atomic-{tag}-{pid}-{nanos}"));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn sync_write_creates_file() {
        let s = Scratch::new("sync-create");
        let p = s.path("a.txt");
        atomic_write_sync(&p, b"hello").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        // Temp file should not be left behind.
        assert!(!s.path("a.txt.tmp").exists());
    }

    #[test]
    fn sync_write_replaces_existing_file() {
        let s = Scratch::new("sync-replace");
        let p = s.path("a.txt");
        std::fs::write(&p, b"old contents").unwrap();
        atomic_write_sync(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        assert!(!s.path("a.txt.tmp").exists());
    }

    #[test]
    fn sync_write_creates_missing_parent_dir() {
        let s = Scratch::new("sync-mkdir");
        let p = s.path("nested/sub/dir/a.txt");
        atomic_write_sync(&p, b"xyz").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"xyz");
    }

    #[tokio::test]
    async fn async_write_creates_and_replaces_file() {
        let s = Scratch::new("async-roundtrip");
        let p = s.path("a.json");
        atomic_write_async(&p, b"{\"k\":1}").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"k\":1}");
        atomic_write_async(&p, b"{\"k\":2}").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"k\":2}");
        assert!(!s.path("a.json.tmp").exists());
    }

    #[tokio::test]
    async fn async_write_creates_missing_parent_dir() {
        let s = Scratch::new("async-mkdir");
        let p = s.path("deep/path/file.json");
        atomic_write_async(&p, b"data").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"data");
    }

    /// Path with no parent (just a file name with no directory component) is
    /// not a real callsite, but should not panic — the empty parent branch
    /// is skipped.
    #[test]
    fn sync_write_with_bare_filename_doesnt_panic() {
        // Use a path inside scratch but pass only the file name relative
        // to it via std::env::set_current_dir — actually simpler: just
        // construct a Path("") parent case via a one-component path.
        // PathBuf::from("a").parent() → Some(""), which we skip.
        let s = Scratch::new("sync-bare");
        let cwd_before = std::env::current_dir().unwrap();
        std::env::set_current_dir(&s.0).unwrap();
        let result = atomic_write_sync(Path::new("bare.txt"), b"k");
        std::env::set_current_dir(&cwd_before).unwrap();
        result.unwrap();
        assert_eq!(std::fs::read(s.path("bare.txt")).unwrap(), b"k");
    }
}
