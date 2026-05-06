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
use tauri::Manager;

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
    pub errors: Vec<String>,
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

/// Pure helper exposed for testing. Real `install_skills_inner` calls this with
/// the resolved bundle dir + the user's `~/.claude/skills/` dir.
fn install_skills_with_paths(bundle_dir: &Path, target_dir: &Path) -> InstallSkillsResult {
    let _ = std::fs::create_dir_all(target_dir);
    let mut installed = Vec::new();
    let mut already = Vec::new();
    let mut errors = Vec::new();

    for skill in BUNDLED_PIPELINE_SKILLS {
        let target_skill_dir = target_dir.join(skill);
        if target_skill_dir.join("SKILL.md").exists() {
            already.push((*skill).to_string());
            continue;
        }

        let source_skill_dir = bundle_dir.join(skill);
        if !source_skill_dir.exists() {
            errors.push(format!("bundle missing for {skill}"));
            continue;
        }

        match copy_dir_recursive(&source_skill_dir, &target_skill_dir) {
            Ok(()) => installed.push((*skill).to_string()),
            Err(e) => errors.push(format!("install {skill}: {e}")),
        }
    }

    InstallSkillsResult {
        skills_dir: target_dir.to_string_lossy().to_string(),
        installed,
        already_present: already,
        errors,
        stub: false,
    }
}

/// Copy a directory and its contents recursively. Skips symlinks (defensive).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn install_skills_inner(app: &tauri::AppHandle) -> Result<InstallSkillsResult, String> {
    let bundle_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("resources")
        .join("skills");
    let target = skills_dir();
    Ok(install_skills_with_paths(&bundle_dir, &target))
}

#[tauri::command]
pub fn pipeline_install_skills(app: tauri::AppHandle) -> Result<InstallSkillsResult, String> {
    install_skills_inner(&app)
}

fn validate_run_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("empty run_id".into());
    }
    if id.len() > 128 {
        return Err("run_id too long".into());
    }
    if id.chars().any(|c| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        return Err("run_id must be ascii alphanumeric / '-' / '_'".into());
    }
    Ok(())
}

fn telemetry_log_inner(project_dir: &Path, run_id: &str, line: &str) -> Result<(), String> {
    validate_run_id(run_id)?;
    if line.contains('\n') {
        return Err("telemetry line may not contain newlines".into());
    }

    let dir = project_dir.join(".terminalx/pipeline-telemetry");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;

    let path = dir.join(format!("{run_id}.jsonl"));
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    f.write_all(line.as_bytes()).map_err(|e| format!("write: {e}"))?;
    f.write_all(b"\n").map_err(|e| format!("write nl: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn pipeline_telemetry_log(
    project_dir: String,
    run_id: String,
    line: String,
) -> Result<(), String> {
    validate_path_arg(&project_dir)?;
    telemetry_log_inner(Path::new(&project_dir), &run_id, &line)
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
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        let res = install_skills_with_paths(bundle.path(), target.path());
        assert!(!res.stub);
        assert!(!res.skills_dir.is_empty());
    }

    #[test]
    fn install_skills_installs_missing_skill_from_bundle() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        // Seed the full bundle so the happy-path install has no errors.
        for skill in BUNDLED_PIPELINE_SKILLS {
            let bundled_skill = bundle.path().join(skill);
            fs::create_dir_all(&bundled_skill).unwrap();
            fs::write(
                bundled_skill.join("SKILL.md"),
                format!("---\nname: {skill}\n---\n# test\n"),
            )
            .unwrap();
        }

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res
            .installed
            .contains(&"tx-pipeline-stage-handoff".to_string()));
        assert!(res.already_present.is_empty());
        assert!(res.errors.is_empty());
        assert!(target
            .path()
            .join("tx-pipeline-stage-handoff/SKILL.md")
            .exists());
        assert!(!res.stub);
    }

    #[test]
    fn install_skills_skips_already_present_skill() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::write(bundled_skill.join("SKILL.md"), "v1").unwrap();

        let existing = target.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("SKILL.md"), "user-edit").unwrap();

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res.installed.is_empty());
        assert_eq!(
            res.already_present,
            vec!["tx-pipeline-stage-handoff".to_string()]
        );
        let preserved = fs::read_to_string(existing.join("SKILL.md")).unwrap();
        assert_eq!(preserved, "user-edit");
    }

    #[test]
    fn install_skills_records_error_when_bundle_missing() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        // No skills in bundle

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res.installed.is_empty());
        assert!(res.already_present.is_empty());
        assert_eq!(res.errors.len(), BUNDLED_PIPELINE_SKILLS.len());
    }

    #[test]
    fn install_skills_handles_partial_bundle() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::write(bundled_skill.join("SKILL.md"), "ok").unwrap();

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert_eq!(res.installed, vec!["tx-pipeline-stage-handoff".to_string()]);
        assert_eq!(res.errors.len(), BUNDLED_PIPELINE_SKILLS.len() - 1);
    }

    #[test]
    fn telemetry_log_appends_jsonl_line() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let line = r#"{"at":1,"event":"state_change","from":"idle","to":"planning"}"#;

        telemetry_log_inner(project, "r-test-1", line).unwrap();

        let f = project.join(".terminalx/pipeline-telemetry/r-test-1.jsonl");
        let contents = fs::read_to_string(&f).unwrap();
        assert!(contents.starts_with(line));
        assert!(contents.ends_with('\n'));
    }

    #[test]
    fn telemetry_log_appends_multiple_lines() {
        let dir = tempdir().unwrap();
        let project = dir.path();

        telemetry_log_inner(project, "r-1", r#"{"at":1}"#).unwrap();
        telemetry_log_inner(project, "r-1", r#"{"at":2}"#).unwrap();
        telemetry_log_inner(project, "r-1", r#"{"at":3}"#).unwrap();

        let contents = fs::read_to_string(project.join(".terminalx/pipeline-telemetry/r-1.jsonl")).unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains(r#""at":1"#));
        assert!(lines[2].contains(r#""at":3"#));
    }

    #[test]
    fn telemetry_log_rejects_newline_in_payload() {
        let dir = tempdir().unwrap();
        let res = telemetry_log_inner(dir.path(), "r-1", "broken\nline");
        assert!(res.is_err());
    }

    #[test]
    fn telemetry_log_rejects_invalid_run_id() {
        let dir = tempdir().unwrap();
        let res = telemetry_log_inner(dir.path(), "../escape", r#"{"at":1}"#);
        assert!(res.is_err());
    }
}
