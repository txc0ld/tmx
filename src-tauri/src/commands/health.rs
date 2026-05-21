//! Boot-time health check for required CLIs.
//!
//! Probes for the presence of `claude`, `codex`, `gemini`, and `git` on the
//! user's PATH so the welcome banner can guide first-time users. Pure PATH
//! lookup — never spawns the binary, so it's cheap to call at boot and safe
//! to call repeatedly. Cross-platform: walks `PATH` manually rather than
//! shelling out to `which` / `where.exe` because (a) it's faster, (b) it
//! avoids spawning a child process from the UI thread, and (c) `which` is
//! not always present on minimal Linux containers.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub claude: bool,
    pub codex: bool,
    pub gemini: bool,
    pub git_installed: bool,
}

/// Resolve a binary name on PATH, returning `true` if found.
///
/// On Windows, also checks PATHEXT-style suffixes (`.exe`, `.cmd`, `.bat`).
/// Pure read-only filesystem probe — never spawns the binary.
pub(super) fn binary_on_path(name: &str) -> bool {
    binary_on_path_with(name, std::env::var_os("PATH"))
}

fn binary_on_path_with(name: &str, path_env: Option<std::ffi::OsString>) -> bool {
    let Some(path_env) = path_env else {
        return false;
    };
    let candidates = candidate_filenames(name);
    for dir in std::env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in &candidates {
            let full: PathBuf = dir.join(candidate);
            if is_executable(&full) {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn candidate_filenames(name: &str) -> Vec<String> {
    // Mirror Windows PATHEXT defaults plus the npm-shim `.cmd` extension —
    // claude/codex/gemini ship as `.cmd` shims on Windows.
    vec![
        name.to_string(),
        format!("{name}.exe"),
        format!("{name}.cmd"),
        format!("{name}.bat"),
    ]
}

#[cfg(not(target_os = "windows"))]
fn candidate_filenames(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    // On Windows, presence of the file with a recognized extension is enough —
    // NTFS doesn't carry a per-file executable bit the way POSIX does.
    path.is_file()
}

#[tauri::command]
pub async fn pipeline_health_check() -> Result<HealthReport, String> {
    Ok(HealthReport {
        claude: binary_on_path("claude"),
        codex: binary_on_path("codex"),
        gemini: binary_on_path("gemini"),
        git_installed: binary_on_path("git"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    #[cfg(unix)]
    use std::fs;

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }

    #[test]
    fn missing_binary_returns_false() {
        let tmp = tempfile::tempdir().unwrap();
        let path_env = OsString::from(tmp.path());
        assert!(!binary_on_path_with(
            "definitely-not-a-real-binary-xyz",
            Some(path_env)
        ));
    }

    #[test]
    fn empty_path_returns_false() {
        assert!(!binary_on_path_with("anything", None));
        assert!(!binary_on_path_with("anything", Some(OsString::new())));
    }

    #[cfg(unix)]
    #[test]
    fn present_executable_returns_true() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("fake-claude");
        fs::write(&bin, b"#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&bin);

        let path_env = OsString::from(tmp.path());
        assert!(binary_on_path_with("fake-claude", Some(path_env)));
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_returns_false() {
        // A file with the right name but no execute bit is NOT a binary —
        // this guards against false positives from `.gitignore` / `Makefile`
        // / etc. that happen to share a name with a CLI we probe.
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("git");
        fs::write(&bin, b"not actually executable").unwrap();
        // No chmod +x — leave default (0o644).
        let path_env = OsString::from(tmp.path());
        assert!(!binary_on_path_with("git", Some(path_env)));
    }

    #[cfg(unix)]
    #[test]
    fn multiple_path_entries_finds_in_later_entry() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let bin = second.path().join("codex");
        fs::write(&bin, b"#!/bin/sh\nexit 0\n").unwrap();
        make_executable(&bin);

        let path_env = std::env::join_paths([first.path(), second.path()]).unwrap();
        assert!(binary_on_path_with("codex", Some(path_env)));
    }
}
