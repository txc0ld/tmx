//! Pipeline command surface.
//!
//! Submodules:
//! - preflight: pipeline_preflight (git/CLI/worktree-dir checks)
//! - worktree: pipeline_worktree_create / _destroy
//! - skills: pipeline_install_skills (bundled SKILL.md → ~/.claude/skills/)
//! - telemetry: pipeline_telemetry_log (JSONL append per run)
//! - verification: pipeline_run_verification_step (CI hook executor)
//! - merger: pipeline_merger_run + pipeline_merger_request_token (Phase 2c-ii)
//! - guardrails: pipeline_guardrails_install / _uninstall (Phase 2c-ii.3)
//! - capabilities: pipeline_capabilities_install / _uninstall (Phase 2c-ii.4)
//! - role_prompts: pipeline_read_role_prompt (Phase 2c-iii post-script)
//! - cleanup: pipeline_cleanup_old_runs (age-based GC for terminal runs)

pub mod capabilities;
pub mod cleanup;
pub mod guardrails;
pub mod managed_marker;
pub mod merger;
pub mod preflight;
pub mod role_prompts;
pub mod skill_provenance;
pub mod skills;
pub mod telemetry;
pub mod verification;
pub mod worktree;

pub use capabilities::*;
pub use cleanup::*;
pub use guardrails::*;
pub use merger::*;
pub use preflight::*;
pub use role_prompts::*;
pub use skills::*;
pub use telemetry::*;
pub use verification::*;
pub use worktree::*;

// ─── Shared validators ────────────────────────────────────────

/// Reject paths that contain control characters or shell-metacharacter footguns.
/// Mirrors the validation pattern used by `agent_spawn` (see commands/agents.rs).
pub(super) fn validate_path_arg(s: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err("empty path".into());
    }
    if s.chars().any(|c| c.is_control()) {
        return Err("path contains control characters".into());
    }
    Ok(())
}
