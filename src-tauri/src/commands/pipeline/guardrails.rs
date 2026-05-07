//! `pipeline_guardrails_install` / `pipeline_guardrails_uninstall` —
//! manage a marked PreToolUse hook entry in the worktree's `.claude/settings.json`.
//!
//! On run start the controller installs a hook that points at
//! `~/.claude/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh`
//! so the agents inside the worktree can't `git push` / `reset --hard` / etc.
//! On terminal state the controller removes the hook again. Both operations
//! preserve any user-authored content in the same settings file via the
//! `tx-pipeline-managed: true` marker on the entry we own.

use super::validate_path_arg;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// Sibling field on each settings entry we manage. Uninstall removes only
/// entries with this marker so user-authored hooks survive.
const MARKER_KEY: &str = "tx-pipeline-managed";

/// Hook command. Matches the schema documented in
/// `~/.claude/skills/git-guardrails-claude-code/SKILL.md` (global form):
/// expanded `~` is a Claude Code shell convention; we reuse the same
/// `$HOME` form which works in the same shell context.
const HOOK_COMMAND: &str = "$HOME/.claude/skills/git-guardrails-claude-code/scripts/block-dangerous-git.sh";

fn settings_path(worktree_dir: &Path) -> PathBuf {
    worktree_dir.join(".claude").join("settings.json")
}

/// Build the marked PreToolUse entry we manage.
fn build_marked_entry() -> Value {
    json!({
        "matcher": "Bash",
        MARKER_KEY: true,
        "hooks": [
            { "type": "command", "command": HOOK_COMMAND }
        ]
    })
}

fn read_settings(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Atomic write: temp + rename. Mirrors `workspace.rs::atomic_write` minus
/// the async wrapper (these IPCs are sync — guardrails is light I/O).
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("write tmp: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Windows: rename-over-existing can fail on some filesystems; remove + retry.
        if path.exists() {
            std::fs::remove_file(path).map_err(|err| format!("rename failed ({e}); cleanup also failed: {err}"))?;
            std::fs::rename(&tmp, path).map_err(|err| format!("rename retry failed: {err}"))?;
        } else {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename failed: {e}"));
        }
    }
    Ok(())
}

/// Get-or-create `hooks` (object) → `PreToolUse` (array). Returns Err if
/// either exists with the wrong type — never silently overwrite user content.
fn get_or_create_pretooluse(root: &mut Value) -> Result<&mut Vec<Value>, String> {
    if !root.is_object() {
        return Err("settings.json root must be a JSON object".into());
    }
    let obj = root.as_object_mut().expect("checked above");
    let hooks = obj.entry("hooks".to_string()).or_insert_with(|| Value::Object(Map::new()));
    if !hooks.is_object() {
        return Err("settings.json `hooks` is not an object — refusing to overwrite user content".into());
    }
    let hooks_obj = hooks.as_object_mut().expect("checked above");
    let pretool = hooks_obj
        .entry("PreToolUse".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !pretool.is_array() {
        return Err("settings.json `hooks.PreToolUse` is not an array — refusing to overwrite user content".into());
    }
    Ok(pretool.as_array_mut().expect("checked above"))
}

fn entry_is_managed(entry: &Value) -> bool {
    entry
        .as_object()
        .and_then(|o| o.get(MARKER_KEY))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn install_inner(worktree_dir: &Path) -> Result<(), String> {
    let path = settings_path(worktree_dir);
    let mut root = read_settings(&path)?;
    {
        let arr = get_or_create_pretooluse(&mut root)?;
        // Idempotent: if any entry is already marked, leave the file alone.
        if arr.iter().any(entry_is_managed) {
            // Still write nothing — the file is already correct.
            return Ok(());
        }
        arr.push(build_marked_entry());
    }
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &serialized)
}

fn uninstall_inner(worktree_dir: &Path) -> Result<(), String> {
    let path = settings_path(worktree_dir);
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_settings(&path)?;
    {
        let arr = get_or_create_pretooluse(&mut root)?;
        let before = arr.len();
        arr.retain(|e| !entry_is_managed(e));
        if arr.len() == before {
            // Nothing of ours to remove — don't rewrite the file.
            return Ok(());
        }
        // NOTE: empty array is intentionally preserved so the user-visible
        // structure stays the same.
    }
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &serialized)
}

#[tauri::command]
pub fn pipeline_guardrails_install(worktree_dir: String) -> Result<(), String> {
    validate_path_arg(&worktree_dir)?;
    install_inner(Path::new(&worktree_dir))
}

#[tauri::command]
pub fn pipeline_guardrails_uninstall(worktree_dir: String) -> Result<(), String> {
    validate_path_arg(&worktree_dir)?;
    uninstall_inner(Path::new(&worktree_dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn read_json(path: &Path) -> Value {
        let s = fs::read_to_string(path).expect("read settings");
        serde_json::from_str(&s).expect("parse settings")
    }

    #[test]
    fn install_creates_settings_with_marked_entry() {
        let dir = tempdir().unwrap();
        install_inner(dir.path()).unwrap();

        let path = settings_path(dir.path());
        assert!(path.exists(), "settings.json should be created");

        let v = read_json(&path);
        let arr = v["hooks"]["PreToolUse"].as_array().expect("array");
        assert_eq!(arr.len(), 1);
        let entry = &arr[0];
        assert_eq!(entry[MARKER_KEY], json!(true));
        assert_eq!(entry["matcher"], json!("Bash"));
        assert_eq!(entry["hooks"][0]["command"], json!(HOOK_COMMAND));
        assert_eq!(entry["hooks"][0]["type"], json!("command"));
    }

    #[test]
    fn install_is_idempotent() {
        let dir = tempdir().unwrap();
        install_inner(dir.path()).unwrap();
        install_inner(dir.path()).unwrap();
        install_inner(dir.path()).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let arr = v["hooks"]["PreToolUse"].as_array().expect("array");
        assert_eq!(arr.len(), 1, "no duplicate marked entries");
    }

    #[test]
    fn install_preserves_existing_user_content() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Pre-populate with a permissions block + a user-authored PreToolUse entry.
        let user = json!({
            "permissions": { "allow": ["Read", "Edit"] },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Read", "hooks": [{ "type": "command", "command": "echo user" }] }
                ],
                "PostToolUse": [
                    { "matcher": "Edit", "hooks": [{ "type": "command", "command": "echo post" }] }
                ]
            },
            "extra": "untouched"
        });
        fs::write(&path, serde_json::to_string_pretty(&user).unwrap()).unwrap();

        install_inner(dir.path()).unwrap();

        let v = read_json(&path);
        // User content untouched.
        assert_eq!(v["permissions"]["allow"], json!(["Read", "Edit"]));
        assert_eq!(v["extra"], json!("untouched"));
        assert_eq!(v["hooks"]["PostToolUse"][0]["matcher"], json!("Edit"));

        let arr = v["hooks"]["PreToolUse"].as_array().expect("array");
        assert_eq!(arr.len(), 2);
        // First entry is the user's (preserved order).
        assert_eq!(arr[0]["matcher"], json!("Read"));
        assert!(!entry_is_managed(&arr[0]));
        // Second is ours, marked.
        assert_eq!(arr[1]["matcher"], json!("Bash"));
        assert!(entry_is_managed(&arr[1]));
    }

    #[test]
    fn uninstall_removes_only_marked_entries() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Mixed entries: one user, one ours.
        let mixed = json!({
            "permissions": { "allow": ["Read"] },
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Read", "hooks": [{ "type": "command", "command": "echo user" }] },
                    { "matcher": "Bash", MARKER_KEY: true, "hooks": [{ "type": "command", "command": HOOK_COMMAND }] }
                ]
            }
        });
        fs::write(&path, serde_json::to_string_pretty(&mixed).unwrap()).unwrap();

        uninstall_inner(dir.path()).unwrap();

        let v = read_json(&path);
        let arr = v["hooks"]["PreToolUse"].as_array().expect("array");
        assert_eq!(arr.len(), 1, "only user entry should remain");
        assert_eq!(arr[0]["matcher"], json!("Read"));
        assert_eq!(v["permissions"]["allow"], json!(["Read"]));
    }

    #[test]
    fn uninstall_is_noop_if_file_missing() {
        let dir = tempdir().unwrap();
        // Don't create .claude/settings.json — uninstall must not error.
        uninstall_inner(dir.path()).unwrap();
        assert!(!settings_path(dir.path()).exists(), "should not create file");
    }

    #[test]
    fn uninstall_leaves_empty_array_when_we_were_only_entry() {
        let dir = tempdir().unwrap();
        install_inner(dir.path()).unwrap();
        uninstall_inner(dir.path()).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let arr = v["hooks"]["PreToolUse"].as_array().expect("array");
        assert!(arr.is_empty(), "PreToolUse should be empty after uninstall");
        // hooks.PreToolUse key is preserved (not deleted).
        assert!(v["hooks"].as_object().unwrap().contains_key("PreToolUse"));
    }

    #[test]
    fn install_rejects_when_pretooluse_is_wrong_type() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bad = json!({
            "hooks": { "PreToolUse": "not-an-array" }
        });
        fs::write(&path, serde_json::to_string_pretty(&bad).unwrap()).unwrap();

        let res = install_inner(dir.path());
        assert!(res.is_err(), "should reject non-array PreToolUse");
        let msg = res.unwrap_err();
        assert!(msg.contains("PreToolUse"), "error should name the field: {msg}");
    }

    #[test]
    fn install_rejects_when_hooks_is_wrong_type() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bad = json!({ "hooks": ["not-an-object"] });
        fs::write(&path, serde_json::to_string_pretty(&bad).unwrap()).unwrap();

        let res = install_inner(dir.path());
        assert!(res.is_err());
    }

    #[test]
    fn install_rejects_empty_path() {
        let res = pipeline_guardrails_install(String::new());
        assert!(res.is_err());
    }

    #[test]
    fn install_rejects_control_chars_in_path() {
        let res = pipeline_guardrails_install("/tmp/bad\npath".into());
        assert!(res.is_err());
    }

    #[test]
    fn install_handles_empty_existing_file() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "").unwrap();

        install_inner(dir.path()).unwrap();
        let v = read_json(&path);
        assert_eq!(v["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
    }
}
