//! `pipeline_preflight` — git/CLI/worktree-dir checks before a pipeline run.

use super::validate_path_arg;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct PreflightResult {
    pub is_git_repo: bool,
    pub working_tree_clean: bool,
    pub main_branch: Option<String>,
    pub claude_present: bool,
    pub codex_present: bool,
    pub gh_present: bool,
    pub gh_authenticated: bool,
    pub worktree_dir_writable: bool,
    // 2c-ii.6 additions (kept at end so older JSON callers stay compatible).
    pub signed_skills_ok: bool,
    pub capability_binaries_ok: bool,
    pub skill_cache_writable: bool,
    // 2c-iii.6 addition: project-relative paths matching the sensitive-file
    // pattern set (.env, *.pem, id_rsa, etc.). Capped at 50 entries.
    pub sensitive_paths_found: Vec<String>,
    pub errors: Vec<String>,
}

/// Filename patterns considered "sensitive" for pipeline pre-flight.
/// Matched against the file's name component only (not full path).
const SENSITIVE_EXACT_NAMES: &[&str] = &[".env", "aws-credentials"];
const SENSITIVE_PREFIX_PATTERNS: &[&str] =
    &[".env.", "id_rsa", "id_ed25519", "secrets.", "gcp-key"];
const SENSITIVE_SUFFIX_PATTERNS: &[&str] =
    &[".pem", ".key", ".kdbx", ".p12", ".pfx", ".ovpn"];

/// Directory names that are never recursed into during the sensitive-path scan.
const SCAN_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".tx-worktrees",
    ".terminalx",
    ".next",
    ".cache",
];

const SENSITIVE_SCAN_MAX_DEPTH: usize = 4;
const SENSITIVE_SCAN_MAX_RESULTS: usize = 50;

/// Return true if the given (lowercased) filename matches any sensitive
/// pattern. Filename-only — callers should pass `entry.file_name()`.
fn matches_sensitive(name: &str) -> bool {
    if SENSITIVE_EXACT_NAMES.iter().any(|n| *n == name) {
        return true;
    }
    if SENSITIVE_PREFIX_PATTERNS.iter().any(|p| name.starts_with(p)) {
        return true;
    }
    if SENSITIVE_SUFFIX_PATTERNS.iter().any(|s| name.ends_with(s)) {
        return true;
    }
    false
}

/// Walk `project_dir` up to depth `SENSITIVE_SCAN_MAX_DEPTH`, skipping
/// `SCAN_SKIP_DIRS`, and return relative paths whose filename matches the
/// sensitive pattern set. Output is capped at `SENSITIVE_SCAN_MAX_RESULTS`.
fn scan_sensitive_paths(project_dir: &Path) -> Vec<String> {
    let mut results = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(project_dir.to_path_buf(), 0)];

    while let Some((dir, depth)) = stack.pop() {
        if results.len() >= SENSITIVE_SCAN_MAX_RESULTS {
            break;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if results.len() >= SENSITIVE_SCAN_MAX_RESULTS {
                break;
            }
            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            // Skip symlinks entirely — they could escape project_dir.
            if file_type.is_symlink() {
                continue;
            }
            let name_os = entry.file_name();
            let name = match name_os.to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let path = entry.path();
            if file_type.is_dir() {
                if SCAN_SKIP_DIRS.iter().any(|s| *s == name.as_str()) {
                    continue;
                }
                if depth + 1 <= SENSITIVE_SCAN_MAX_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if matches_sensitive(&name) {
                let rel = path
                    .strip_prefix(project_dir)
                    .map(|p| p.to_path_buf())
                    .unwrap_or(path.clone());
                if let Some(s) = rel.to_str() {
                    results.push(s.to_string());
                }
            }
        }
    }

    results
}

fn cmd_present(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Resolve the user's home dir using the same precedence as `skills::skills_dir`:
/// `HOME` → `USERPROFILE` → `dirs::home_dir()`. Returns `None` if all three fail.
fn resolve_home_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        return Some(PathBuf::from(h));
    }
    if let Some(p) = std::env::var_os("USERPROFILE") {
        return Some(PathBuf::from(p));
    }
    dirs::home_dir()
}

/// Probe-write a temp file inside `dir`. Returns Ok on success after cleanup.
fn probe_writable(dir: &Path) -> std::io::Result<()> {
    let probe = dir.join(format!(".tx-preflight-{}", uuid::Uuid::new_v4()));
    std::fs::write(&probe, b"tx")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Check skill_cache_writable: `~/.claude/skills/` (or, if it doesn't yet
/// exist, the first existing ancestor) must accept a probe write.
fn check_skill_cache_writable(home_dir: &Path) -> Result<(), String> {
    let target = home_dir.join(".claude").join("skills");
    // Walk up to first existing dir (target itself, or first ancestor).
    let mut probe_at: Option<PathBuf> = None;
    let mut cursor: Option<&Path> = Some(target.as_path());
    while let Some(c) = cursor {
        if c.exists() {
            probe_at = Some(c.to_path_buf());
            break;
        }
        cursor = c.parent();
    }
    let dir = probe_at.ok_or_else(|| {
        format!(
            "skill cache: no existing ancestor of {} found",
            target.display()
        )
    })?;
    probe_writable(&dir).map_err(|e| format!("skill cache not writable at {}: {e}", dir.display()))
}

/// Check signed_skills_ok: every installed bundled skill in
/// `~/.claude/skills/<name>/SKILL.md` must match its build-time hash.
/// Skills not yet installed are vacuously OK.
fn check_signed_skills(home_dir: &Path) -> Result<(), Vec<String>> {
    let skills_root = home_dir.join(".claude").join("skills");
    let mut errs = Vec::new();
    for skill in super::skills::BUNDLED_PIPELINE_SKILLS {
        let path = skills_root.join(skill).join("SKILL.md");
        if !path.exists() {
            continue; // vacuous pass; install IPC will lay it down later
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                if let Err(e) = super::skill_provenance::verify_skill(skill, &bytes) {
                    errs.push(format!("verify installed {skill}: {e}"));
                }
            }
            Err(e) => errs.push(format!("read installed {skill}/SKILL.md: {e}")),
        }
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(errs)
    }
}

fn run_preflight_inner(project_dir: &Path, home_dir: Option<&Path>) -> PreflightResult {
    let mut errors = Vec::new();

    let is_git_repo = Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(project_dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_git_repo {
        errors.push("not a git repo (run `git init`)".into());
    }

    let working_tree_clean = if is_git_repo {
        Command::new("git")
            .args(["status", "--porcelain"])
            .current_dir(project_dir)
            .output()
            .ok()
            .map(|o| o.stdout.is_empty())
            .unwrap_or(false)
    } else {
        false
    };

    let main_branch = if is_git_repo {
        let out = Command::new("git")
            .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
            .current_dir(project_dir)
            .output()
            .ok();
        match out {
            Some(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                s.strip_prefix("origin/").map(|x| x.to_string()).or(Some(s))
            }
            _ => {
                let try_branch = |b: &str| -> bool {
                    Command::new("git")
                        .args(["rev-parse", "--verify", b])
                        .current_dir(project_dir)
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                };
                if try_branch("main") {
                    Some("main".into())
                } else if try_branch("master") {
                    Some("master".into())
                } else {
                    None
                }
            }
        }
    } else {
        None
    };

    let claude_present = cmd_present("claude");
    let codex_present = cmd_present("codex");
    let gh_present = cmd_present("gh");
    let gh_authenticated = if gh_present {
        Command::new("gh")
            .args(["auth", "status"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    } else {
        false
    };

    let worktree_parent = project_dir.join(".tx-worktrees");
    let worktree_dir_writable = std::fs::create_dir_all(&worktree_parent).is_ok();

    // Capability binaries: `git` is the only hard requirement here.
    // `gh` is already covered by `gh_present` and is local-merge-fallbackable.
    let capability_binaries_ok = cmd_present("git");
    if !capability_binaries_ok {
        errors.push("`git` not found on PATH (required for pipeline runs)".into());
    }

    // Skill provenance + cache writability use the resolved home dir.
    // If home_dir is unavailable, mark both as failures (we can't proceed
    // without a place to read/write skills).
    let (signed_skills_ok, skill_cache_writable) = match home_dir {
        Some(home) => {
            let signed = match check_signed_skills(home) {
                Ok(()) => true,
                Err(skill_errs) => {
                    errors.extend(skill_errs);
                    false
                }
            };
            let writable = match check_skill_cache_writable(home) {
                Ok(()) => true,
                Err(e) => {
                    errors.push(e);
                    false
                }
            };
            (signed, writable)
        }
        None => {
            errors.push("could not resolve home dir (HOME / USERPROFILE unset)".into());
            (false, false)
        }
    };

    let sensitive_paths_found = scan_sensitive_paths(project_dir);

    PreflightResult {
        is_git_repo,
        working_tree_clean,
        main_branch,
        claude_present,
        codex_present,
        gh_present,
        gh_authenticated,
        worktree_dir_writable,
        signed_skills_ok,
        capability_binaries_ok,
        skill_cache_writable,
        sensitive_paths_found,
        errors,
    }
}

#[tauri::command]
pub fn pipeline_preflight(project_dir: String) -> Result<PreflightResult, String> {
    validate_path_arg(&project_dir)?;
    let p = PathBuf::from(&project_dir);
    if !p.exists() {
        return Err(format!("project_dir does not exist: {}", project_dir));
    }
    let home = resolve_home_dir();
    Ok(run_preflight_inner(&p, home.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// Helper: wrap a temp dir as a fake `$HOME` for tests. Returns the
    /// `tempdir()` guard (drop = cleanup) and a path ref usable as `home_dir`.
    fn fake_home() -> tempfile::TempDir {
        tempdir().unwrap()
    }

    #[test]
    fn preflight_reports_non_git_dir() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(!result.is_git_repo);
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn preflight_reports_git_dir_clean() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "t@t"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "t"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();
        Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "x"])
            .current_dir(dir.path())
            .output()
            .unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(result.is_git_repo);
        assert!(result.working_tree_clean);
    }

    #[test]
    fn preflight_reports_dirty_tree() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(result.is_git_repo);
        assert!(!result.working_tree_clean);
    }

    // ─── 2c-ii.6 additions ────────────────────────────────────────

    #[test]
    fn signed_skills_ok_is_true_when_no_skills_installed() {
        // Empty home — no `.claude/skills/` exists. Vacuous pass.
        let dir = tempdir().unwrap();
        let home = fake_home();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(
            result.signed_skills_ok,
            "vacuous pass with no installed skills; errors: {:?}",
            result.errors
        );
    }

    #[test]
    fn signed_skills_ok_is_false_when_installed_skill_is_tampered() {
        let dir = tempdir().unwrap();
        let home = fake_home();

        // Lay down a tampered SKILL.md for a real bundled skill.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let real = std::fs::read(
            manifest_dir.join("resources/skills/tx-pipeline-stage-handoff/SKILL.md"),
        )
        .unwrap();
        let mut tampered = real.clone();
        tampered.push(b'!'); // single-byte flip / append

        let installed_dir = home.path().join(".claude/skills/tx-pipeline-stage-handoff");
        fs::create_dir_all(&installed_dir).unwrap();
        fs::write(installed_dir.join("SKILL.md"), &tampered).unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(!result.signed_skills_ok, "tampered skill should fail verification");
        assert!(
            result.errors.iter().any(|e| e.contains("hash mismatch")),
            "expected a hash-mismatch error in {:?}",
            result.errors
        );
    }

    #[test]
    fn signed_skills_ok_is_true_when_installed_skill_is_pristine() {
        let dir = tempdir().unwrap();
        let home = fake_home();

        // Lay down the real bundled SKILL.md unchanged.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let real = std::fs::read(
            manifest_dir.join("resources/skills/tx-pipeline-stage-handoff/SKILL.md"),
        )
        .unwrap();
        let installed_dir = home.path().join(".claude/skills/tx-pipeline-stage-handoff");
        fs::create_dir_all(&installed_dir).unwrap();
        fs::write(installed_dir.join("SKILL.md"), &real).unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(
            result.signed_skills_ok,
            "pristine bundled skill should verify; errors: {:?}",
            result.errors
        );
    }

    #[test]
    fn capability_binaries_ok_matches_cmd_present_git() {
        // Hard to negative-test cleanly. Assert the result equals what
        // `cmd_present("git")` returns on the test machine.
        let dir = tempdir().unwrap();
        let home = fake_home();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert_eq!(result.capability_binaries_ok, cmd_present("git"));
    }

    #[test]
    fn skill_cache_writable_is_true_for_writable_temp_home() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(
            result.skill_cache_writable,
            "fresh temp home should be writable; errors: {:?}",
            result.errors
        );
    }

    #[test]
    fn skill_cache_writable_works_when_skills_dir_already_exists() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        // Pre-create the skills dir to exercise the "exists" branch.
        fs::create_dir_all(home.path().join(".claude/skills")).unwrap();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(result.skill_cache_writable, "existing dir should accept probe write");
    }

    #[test]
    fn preflight_populates_new_fields_in_baseline_case() {
        // Sanity: existing fields still populate alongside the new ones.
        let dir = tempdir().unwrap();
        let home = fake_home();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        // New fields all default to safe values for an empty temp home.
        assert!(result.signed_skills_ok);
        assert!(result.skill_cache_writable);
        // capability_binaries_ok depends on PATH; just check it's a bool
        // (compile-time guarantee — the assertion exists for documentation).
        let _ = result.capability_binaries_ok;
    }

    // ─── 2c-iii.6 sensitive-path scan ─────────────────────────────

    #[test]
    fn sensitive_scan_empty_project_returns_empty() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        // Only a benign file present.
        fs::write(dir.path().join("README.md"), "hi").unwrap();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert!(
            result.sensitive_paths_found.is_empty(),
            "expected no matches, got {:?}",
            result.sensitive_paths_found
        );
    }

    #[test]
    fn sensitive_scan_flags_dotenv_at_root() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert_eq!(result.sensitive_paths_found, vec![".env".to_string()]);
    }

    #[test]
    fn sensitive_scan_flags_pem_idrsa_secrets() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        fs::write(dir.path().join("server.pem"), "x").unwrap();
        fs::write(dir.path().join("id_rsa"), "x").unwrap();
        fs::write(dir.path().join("secrets.toml"), "x").unwrap();
        // Decoy that should NOT match.
        fs::write(dir.path().join("README.md"), "x").unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        let mut found = result.sensitive_paths_found.clone();
        found.sort();
        assert_eq!(
            found,
            vec![
                "id_rsa".to_string(),
                "secrets.toml".to_string(),
                "server.pem".to_string(),
            ]
        );
    }

    #[test]
    fn sensitive_scan_skips_node_modules() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        let nm = dir.path().join("node_modules/some-package");
        fs::create_dir_all(&nm).unwrap();
        fs::write(nm.join("cert.pem"), "x").unwrap();
        // Same pattern at root SHOULD be reported.
        fs::write(dir.path().join("real.pem"), "x").unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert_eq!(result.sensitive_paths_found, vec!["real.pem".to_string()]);
    }

    #[test]
    fn sensitive_scan_caps_results_at_50() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        for i in 0..60 {
            fs::write(dir.path().join(format!("k{i}.pem")), "x").unwrap();
        }
        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert_eq!(
            result.sensitive_paths_found.len(),
            SENSITIVE_SCAN_MAX_RESULTS,
            "should cap at {}, got {}",
            SENSITIVE_SCAN_MAX_RESULTS,
            result.sensitive_paths_found.len()
        );
    }

    #[test]
    fn sensitive_scan_walks_subdirectories() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        let sub = dir.path().join("config");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("secrets.yaml"), "x").unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        // Path separator differs on Windows; normalize for the assertion.
        let normalized: Vec<String> = result
            .sensitive_paths_found
            .iter()
            .map(|p| p.replace('\\', "/"))
            .collect();
        assert_eq!(normalized, vec!["config/secrets.yaml".to_string()]);
    }

    #[test]
    fn sensitive_scan_does_not_match_unrelated_dotfiles() {
        let dir = tempdir().unwrap();
        let home = fake_home();
        fs::write(dir.path().join(".gitignore"), "x").unwrap();
        fs::write(dir.path().join(".prettierrc"), "x").unwrap();
        // A real match alongside the decoys to prove the scan still works.
        fs::write(dir.path().join(".env.local"), "x").unwrap();

        let result = run_preflight_inner(dir.path(), Some(home.path()));
        assert_eq!(
            result.sensitive_paths_found,
            vec![".env.local".to_string()]
        );
    }
}
