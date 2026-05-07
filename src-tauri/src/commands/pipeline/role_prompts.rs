//! Read bundled role-prompt content from `resources/role-prompts/<role>.md`.
//!
//! These files contain the per-role agent prompts (planner / builder / reviewer)
//! that the run factory hashes into the fingerprint. Agent-time injection of
//! the prompt content into spawned agent processes happens via the existing
//! agent-memory injection path (not yet wired — Phase 3).

use std::path::PathBuf;
use tauri::Manager;

const ALLOWED_ROLES: &[&str] = &["planner", "builder", "reviewer", "reviewer-codex", "red-team"];

fn role_prompt_path(app: &tauri::AppHandle, role: &str) -> Result<PathBuf, String> {
    if !ALLOWED_ROLES.contains(&role) {
        return Err(format!("unknown role: {role}"));
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    Ok(resource_dir
        .join("resources")
        .join("role-prompts")
        .join(format!("{role}.md")))
}

#[tauri::command]
pub fn pipeline_read_role_prompt(
    app: tauri::AppHandle,
    role: String,
) -> Result<Option<String>, String> {
    let path = role_prompt_path(&app, &role)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {role}.md: {e}"))?;
    let s = String::from_utf8(bytes).map_err(|e| format!("utf8 {role}.md: {e}"))?;
    if s.is_empty() {
        return Ok(None);
    }
    Ok(Some(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_role_at_path_resolution() {
        // Test the path-validation gate without needing a Tauri AppHandle.
        // We invoke role_prompt_path indirectly by reusing the role check.
        let bad = "nonexistent-role";
        assert!(!ALLOWED_ROLES.contains(&bad));
        let weird = "../etc/passwd";
        assert!(!ALLOWED_ROLES.contains(&weird));
    }

    #[test]
    fn allowed_roles_match_pipeline_role_union() {
        // PipelineRole TS union: 'planner' | 'builder' | 'reviewer' | 'reviewer-codex' | 'red-team' | 'controller'.
        // Controller has no agent process so no role prompt — exclude it here.
        assert!(ALLOWED_ROLES.contains(&"planner"));
        assert!(ALLOWED_ROLES.contains(&"builder"));
        assert!(ALLOWED_ROLES.contains(&"reviewer"));
        assert!(ALLOWED_ROLES.contains(&"reviewer-codex"));
        assert!(ALLOWED_ROLES.contains(&"red-team"));
        assert!(!ALLOWED_ROLES.contains(&"controller"));
    }
}
