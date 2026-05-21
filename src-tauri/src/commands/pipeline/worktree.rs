//! `pipeline_worktree_create` / `pipeline_worktree_destroy` — git worktree CRUD.

use super::validate_path_arg;
// Branch validation lives in git.rs (`validate_branch_name`) so the pipeline
// applies the same git-refname rules as the rest of the codebase.
use crate::commands::git::validate_branch_name;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize)]
pub struct WorktreeCreateResult {
    pub path: String,
    pub branch: String,
}

fn run_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(windows)]
fn is_windows_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    std::fs::symlink_metadata(path)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_path: &Path) -> bool {
    false
}

fn contains_parent_dir(path: &Path) -> bool {
    path.components().any(|c| matches!(c, Component::ParentDir))
}

fn scoped_worktree_path(
    project_dir: &Path,
    worktree_path: &Path,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let project = std::fs::canonicalize(project_dir)
        .map_err(|e| format!("canonicalize project_dir {}: {e}", project_dir.display()))?;
    let display_project = if project_dir.is_absolute() {
        project_dir.to_path_buf()
    } else {
        project.clone()
    };
    let root = display_project.join(".tx-worktrees");
    let root_for_canonical_checks = project.join(".tx-worktrees");

    if contains_parent_dir(worktree_path) {
        return Err("worktree path must not contain `..`".into());
    }

    let candidate = if worktree_path.is_absolute() {
        match worktree_path.strip_prefix(project_dir) {
            Ok(rel) => display_project.join(rel),
            Err(_) => worktree_path.to_path_buf(),
        }
    } else {
        display_project.join(worktree_path)
    };

    let name = candidate
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "worktree path must end with a run id".to_string())?;
    if !run_id_ok(name) {
        return Err("worktree path run id is invalid".into());
    }

    if candidate.exists() {
        let meta = std::fs::symlink_metadata(&candidate)
            .map_err(|e| format!("metadata {}: {e}", candidate.display()))?;
        if meta.file_type().is_symlink() || is_windows_reparse_point(&candidate) {
            return Err("refusing to operate on symlink/reparse-point worktree path".into());
        }
        let root_canon = std::fs::canonicalize(&root_for_canonical_checks)
            .map_err(|e| format!("canonicalize worktree root {}: {e}", root.display()))?;
        let candidate_canon = std::fs::canonicalize(&candidate)
            .map_err(|e| format!("canonicalize worktree {}: {e}", candidate.display()))?;
        if candidate_canon.parent() != Some(root_canon.as_path()) {
            return Err(format!(
                "worktree path must be a direct child of {}",
                root.display()
            ));
        }
        Ok(candidate)
    } else {
        if candidate.parent() != Some(root.as_path()) {
            return Err(format!(
                "worktree path must be a direct child of {}",
                root.display()
            ));
        }
        if must_exist {
            return Err(format!(
                "worktree path does not exist: {}",
                candidate.display()
            ));
        }
        Ok(candidate)
    }
}

fn create_worktree_inner(
    project_dir: &Path,
    branch: &str,
    worktree_path: &Path,
    base_branch: Option<&str>,
) -> Result<WorktreeCreateResult, String> {
    validate_branch_name(branch)?;
    let worktree_path = scoped_worktree_path(project_dir, worktree_path, false)?;

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
    let worktree_path = match scoped_worktree_path(project_dir, worktree_path, true) {
        Ok(path) => path,
        Err(e) if e.contains("does not exist") => return Ok(()),
        Err(e) => return Err(e),
    };

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
        std::fs::remove_dir_all(&worktree_path)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
    fn worktree_destroy_rejects_existing_path_outside_tx_worktrees() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        let outside = dir.path().join("Documents");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "x").unwrap();

        let res = destroy_worktree_inner(dir.path(), &outside, "feat/not-managed");

        assert!(res.is_err());
        assert!(outside.exists(), "outside directory must not be deleted");
        assert!(outside.join("keep.txt").exists());
    }

    #[test]
    fn worktree_destroy_rejects_parent_traversal() {
        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(dir.path().join(".tx-worktrees")).unwrap();
        let hostile = dir.path().join(".tx-worktrees/../outside");

        let res = destroy_worktree_inner(dir.path(), &hostile, "feat/not-managed");

        assert!(res.is_err());
        assert!(
            outside.exists(),
            "parent traversal target must not be deleted"
        );
    }

    #[cfg(unix)]
    #[test]
    fn worktree_destroy_rejects_symlink_under_tx_worktrees() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "x").unwrap();
        let root = dir.path().join(".tx-worktrees");
        fs::create_dir_all(&root).unwrap();
        let link = root.join("r-link");
        symlink(outside.path(), &link).unwrap();

        let res = destroy_worktree_inner(dir.path(), &link, "feat/not-managed");

        assert!(res.is_err());
        assert!(outside.path().join("keep.txt").exists());
        assert!(link.exists());
    }
}
