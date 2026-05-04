//! Pipeline command surface (Phase 1).
//!
//! Phase 1 ships:
//!   - pipeline_preflight    — git/CLI/worktree-dir checks
//!   - pipeline_worktree_create / _destroy
//!   - pipeline_install_skills (stub — full impl in Phase 2)
//!
//! Future phases extend this with `pipeline_merger_run`, `agent_run_oneshot`, etc.

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
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallSkillsResult {
    pub skills_dir: String,
    pub installed: Vec<String>,
    pub already_present: Vec<String>,
    pub stub: bool,
}

fn cmd_present(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Reject paths that contain control characters or shell-metacharacter footguns.
/// Mirrors the validation pattern used by `agent_spawn` (see commands/agents.rs).
fn validate_path_arg(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("empty path".into());
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    Ok(())
}

fn run_preflight_inner(project_dir: &Path) -> PreflightResult {
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

    PreflightResult {
        is_git_repo,
        working_tree_clean,
        main_branch,
        claude_present,
        codex_present,
        gh_present,
        gh_authenticated,
        worktree_dir_writable,
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
    Ok(run_preflight_inner(&p))
}

fn validate_branch_name(b: &str) -> Result<(), String> {
    if b.is_empty() {
        return Err("empty branch".into());
    }
    if b.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("branch name contains whitespace/control".into());
    }
    if b.starts_with('-') || b.contains("..") || b.contains("//") {
        return Err("invalid branch name".into());
    }
    Ok(())
}

fn create_worktree_inner(
    project_dir: &Path,
    branch: &str,
    worktree_path: &Path,
    base_branch: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    validate_branch_name(branch)?;

    if let Some(parent) = worktree_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
    }

    let mut args = vec!["worktree", "add", "-b", branch];
    let wp = worktree_path.to_string_lossy().to_string();
    args.push(&wp);
    if let Some(base) = base_branch {
        args.push(base);
    }

    let out = Command::new("git")
        .args(&args)
        .current_dir(project_dir)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(format!("git worktree add failed: {err}"));
    }

    Ok(WorktreeCreateResult {
        path: wp,
        branch: branch.to_string(),
    })
}

#[tauri::command]
pub fn pipeline_worktree_create(
    project_dir: String,
    branch: String,
    worktree_path: String,
    base_branch: Option<String>,
) -> Result<WorktreeCreateResult, String> {
    validate_path_arg(&project_dir)?;
    validate_path_arg(&worktree_path)?;
    create_worktree_inner(
        Path::new(&project_dir),
        &branch,
        Path::new(&worktree_path),
        base_branch.as_deref(),
    )
}

fn destroy_worktree_inner(
    project_dir: &Path,
    worktree_path: &Path,
    branch: &str,
) -> Result<(), String> {
    if !worktree_path.exists() {
        return Ok(());
    }

    // git worktree remove (force, since we may have uncommitted scratchpads)
    let _ = Command::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            &worktree_path.to_string_lossy(),
        ])
        .current_dir(project_dir)
        .output();

    // best-effort branch delete (force, since worktree had it)
    let _ = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(project_dir)
        .output();

    // belt-and-braces: filesystem cleanup if git worktree didn't fully remove
    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .map_err(|e| format!("rmdir {}: {e}", worktree_path.display()))?;
    }

    Ok(())
}

#[tauri::command]
pub fn pipeline_worktree_destroy(
    project_dir: String,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    validate_path_arg(&project_dir)?;
    validate_path_arg(&worktree_path)?;
    validate_branch_name(&branch)?;
    destroy_worktree_inner(Path::new(&project_dir), Path::new(&worktree_path), &branch)
}

fn skills_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".claude").join("skills");
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile).join(".claude").join("skills");
    }
    PathBuf::from(".claude").join("skills")
}

const BUNDLED_PIPELINE_SKILLS: &[&str] = &["tx-pipeline-stage-handoff", "tx-pipeline-reviewer"];

fn install_skills_inner() -> InstallSkillsResult {
    let dir = skills_dir();
    let _ = std::fs::create_dir_all(&dir);
    let mut already = Vec::new();
    for s in BUNDLED_PIPELINE_SKILLS {
        if dir.join(s).join("SKILL.md").exists() {
            already.push((*s).to_string());
        }
    }
    InstallSkillsResult {
        skills_dir: dir.to_string_lossy().to_string(),
        installed: Vec::new(),
        already_present: already,
        stub: true,
    }
}

#[tauri::command]
pub fn pipeline_install_skills() -> Result<InstallSkillsResult, String> {
    Ok(install_skills_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn preflight_reports_non_git_dir() {
        let dir = tempdir().unwrap();
        let result = run_preflight_inner(dir.path());
        assert!(!result.is_git_repo);
        assert!(!result.errors.is_empty());
    }

    #[test]
    fn preflight_reports_git_dir_clean() {
        let dir = tempdir().unwrap();
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

        let result = run_preflight_inner(dir.path());
        assert!(result.is_git_repo);
        assert!(result.working_tree_clean);
    }

    #[test]
    fn preflight_reports_dirty_tree() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        fs::write(dir.path().join("a.txt"), "x").unwrap();

        let result = run_preflight_inner(dir.path());
        assert!(result.is_git_repo);
        assert!(!result.working_tree_clean);
    }

    #[test]
    fn worktree_create_succeeds_in_git_repo() {
        let dir = tempdir().unwrap();
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

        let res = create_worktree_inner(
            dir.path(),
            "feat/test-1",
            dir.path().join(".tx-worktrees/r1").as_path(),
            None,
        );
        assert!(res.is_ok(), "got error: {:?}", res.err());
        assert!(dir.path().join(".tx-worktrees/r1").exists());
    }

    #[test]
    fn worktree_create_rejects_invalid_branch() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        let res = create_worktree_inner(
            dir.path(),
            "bad branch with spaces",
            dir.path().join(".tx-worktrees/r1").as_path(),
            None,
        );
        assert!(res.is_err());
    }

    #[test]
    fn worktree_destroy_removes_worktree() {
        let dir = tempdir().unwrap();
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

        let wt = dir.path().join(".tx-worktrees/r1");
        create_worktree_inner(dir.path(), "feat/destroy-test", &wt, None).unwrap();
        assert!(wt.exists());

        let res = destroy_worktree_inner(dir.path(), &wt, "feat/destroy-test");
        assert!(res.is_ok());
        assert!(!wt.exists());
    }

    #[test]
    fn worktree_destroy_idempotent_on_missing_path() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        let res = destroy_worktree_inner(
            dir.path(),
            &dir.path().join(".tx-worktrees/never"),
            "feat/never",
        );
        assert!(res.is_ok(), "destroy should be idempotent");
    }

    #[test]
    fn install_skills_stub_returns_metadata() {
        let res = install_skills_inner();
        assert!(res.stub);
        assert!(!res.skills_dir.is_empty());
    }
}
