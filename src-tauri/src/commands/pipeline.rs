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
