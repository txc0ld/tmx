//! `pipeline_capabilities_install` / `pipeline_capabilities_uninstall` —
//! translate a per-role `RoleCapabilities` manifest into Claude Code
//! `permissions.allow` / `permissions.deny` entries inside the worktree's
//! `.claude/settings.json`, scoped via the unified
//! `_tx_pipeline_managed.capabilities[<role>]` marker so uninstall only
//! removes the entries we added (preserving anything the user authored in
//! the same file).
//!
//! Legacy `_tx_pipeline_capabilities` (top-level sibling) markers from
//! pre-3a installs are auto-migrated on read via `managed_marker::migrate_in_place`.
//!
//! See spec §17.1 for the rationale: guardrails block destructive git verbs;
//! capability scoping additionally bounds file-write paths, shell verbs,
//! network egress, and MCP tool selection per agent role *before* the agent
//! process spawns.

use super::managed_marker;
use super::validate_path_arg;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// Per-role copy of the entries we appended to `permissions.allow` / `permissions.deny`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManagedPermissions {
    #[serde(default)]
    allow: Vec<String>,
    #[serde(default)]
    deny: Vec<String>,
}

/// Mirrors `RoleCapabilities` in `src/types/index.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleCapabilities {
    pub file_writes: FileWrites,
    pub shell: ShellPatterns,
    pub network: NetworkScope,
    #[serde(default)]
    pub mcp_tools: Vec<String>,
    /// Bytes. Not enforced by Claude Code's settings.json today; carried for
    /// future agent-side runtime checks (see spec §17.1). Deserialized so the
    /// frontend type round-trips faithfully — tracked here, used later.
    #[serde(default)]
    #[allow(dead_code)]
    pub max_file_size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileWrites {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPatterns {
    #[serde(default)]
    pub allow_patterns: Vec<String>,
    #[serde(default)]
    pub deny_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NetworkScope {
    None,
    PackageManagers,
    Unrestricted,
}

/// Roles we accept. Mirrors `PipelineRole` minus `controller` (no agent process).
const VALID_ROLES: &[&str] = &["planner", "builder", "reviewer", "reviewer-codex"];

fn validate_role(role: &str) -> Result<(), String> {
    if !VALID_ROLES.contains(&role) {
        return Err(format!(
            "invalid role: {role:?} (expected one of {VALID_ROLES:?})"
        ));
    }
    Ok(())
}

fn settings_path(worktree_dir: &Path) -> PathBuf {
    worktree_dir.join(".claude").join("settings.json")
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

/// Atomic write: temp + rename. Thin wrapper over the shared
/// `util::fs_atomic::atomic_write_sync` helper.
fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    crate::util::fs_atomic::atomic_write_sync(path, contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

// ─── Capability → permission-string translation ─────────────────────

/// Package-manager registry domains permitted under `network: package-managers`.
/// Covers npm/pnpm/yarn, Rust/cargo, Python/pip+pypi, Go modules, RubyGems.
/// Selected from registries the bundled CLIs actually fetch from; anything
/// outside this list is denied.
const PACKAGE_MANAGER_DOMAINS: &[&str] = &[
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "crates.io",
    "static.crates.io",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
    "rubygems.org",
];

/// Translate a `RoleCapabilities` manifest into the entries we will append to
/// `permissions.allow` / `permissions.deny`.
fn capabilities_to_permissions(caps: &RoleCapabilities) -> ManagedPermissions {
    let mut allow: Vec<String> = Vec::new();
    let mut deny: Vec<String> = Vec::new();

    // ── shell verbs ──
    for pat in &caps.shell.allow_patterns {
        allow.push(format!("Bash({pat})"));
    }
    for pat in &caps.shell.deny_patterns {
        deny.push(format!("Bash({pat})"));
    }

    // ── file-writes ──
    // Claude Code distinguishes Write (new file) and Edit (modify existing).
    // Spec §17.1 talks about "fileWrites" as a single concept; we apply the
    // glob to both so a Reviewer with `deny: ['**']` is read-only via either tool.
    for glob in &caps.file_writes.allow {
        allow.push(format!("Write({glob})"));
        allow.push(format!("Edit({glob})"));
    }
    for glob in &caps.file_writes.deny {
        deny.push(format!("Write({glob})"));
        deny.push(format!("Edit({glob})"));
    }

    // ── network egress ──
    match caps.network {
        NetworkScope::None => {
            deny.push("WebFetch".to_string());
            deny.push("WebSearch".to_string());
        }
        NetworkScope::PackageManagers => {
            for domain in PACKAGE_MANAGER_DOMAINS {
                allow.push(format!("WebFetch(domain:{domain})"));
            }
            // No general `WebFetch` allow → anything outside the listed domains
            // falls through to Claude Code's default-deny for unmatched matchers.
            // We additionally deny WebSearch since registries are the only allowed egress.
            deny.push("WebSearch".to_string());
        }
        NetworkScope::Unrestricted => {
            allow.push("WebFetch".to_string());
            allow.push("WebSearch".to_string());
        }
    }

    // ── MCP tool allowlist ──
    for tool in &caps.mcp_tools {
        allow.push(format!("mcp__{tool}__*"));
    }

    // Note: `maxFileSize` has no Claude-Code-side enforcement today;
    // §17.1 anticipates a future PreToolUse hook for it. Tracked silently.

    ManagedPermissions { allow, deny }
}

// ─── settings.json mutation helpers ─────────────────────

/// Read the per-role `_tx_pipeline_managed.capabilities` map from the
/// settings root, if any. Used by both install (idempotency check) and
/// uninstall (removal).
fn read_marker(root: &Value) -> Map<String, Value> {
    root.as_object()
        .and_then(|o| o.get(managed_marker::NAMESPACE))
        .and_then(Value::as_object)
        .and_then(|o| o.get("capabilities"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// Write the per-role map back to `_tx_pipeline_managed.capabilities`.
/// Removes intermediate keys when they become empty so the file stays
/// clean of breadcrumb markers when no roles remain.
fn write_marker(root: &mut Value, marker: Map<String, Value>) {
    let obj = root.as_object_mut().expect("validated upstream");
    if marker.is_empty() {
        // Clean up the namespace if `capabilities` was the only sub-key.
        if let Some(ns) = obj.get_mut(managed_marker::NAMESPACE).and_then(Value::as_object_mut) {
            ns.remove("capabilities");
            if ns.is_empty() {
                obj.remove(managed_marker::NAMESPACE);
            }
        }
        return;
    }
    let ns = obj
        .entry(managed_marker::NAMESPACE.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let ns_map = match ns.as_object_mut() {
        Some(m) => m,
        None => {
            // Namespace exists but is corrupted (non-object). Replace it —
            // this can only happen if the user hand-edited the file with
            // garbage, which we accept overwriting since the namespace is
            // ours.
            *ns = Value::Object(Map::new());
            ns.as_object_mut().expect("just inserted")
        }
    };
    ns_map.insert("capabilities".to_string(), Value::Object(marker));
}

/// Append `entries` to the JSON array at `root.permissions.<field>`,
/// creating the parent objects/arrays if missing. Errors if any existing
/// node has the wrong type.
fn append_permission_entries(
    root: &mut Value,
    field: &str,
    entries: &[String],
) -> Result<(), String> {
    if !root.is_object() {
        return Err("settings.json root must be a JSON object".into());
    }
    let obj = root.as_object_mut().expect("checked above");
    let perms = obj
        .entry("permissions".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !perms.is_object() {
        return Err("settings.json `permissions` is not an object".into());
    }
    let perms_obj = perms.as_object_mut().expect("checked above");
    let arr_v = perms_obj
        .entry(field.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !arr_v.is_array() {
        return Err(format!(
            "settings.json `permissions.{field}` is not an array — refusing to overwrite user content"
        ));
    }
    let arr = arr_v.as_array_mut().expect("checked above");
    for s in entries {
        arr.push(Value::String(s.clone()));
    }
    Ok(())
}

/// Remove (one occurrence per matching string) the given entries from
/// `root.permissions.<field>`. No-op if any path segment is missing.
fn remove_permission_entries(root: &mut Value, field: &str, entries: &[String]) {
    let arr = root
        .get_mut("permissions")
        .and_then(Value::as_object_mut)
        .and_then(|o| o.get_mut(field))
        .and_then(Value::as_array_mut);
    let Some(arr) = arr else { return };
    for s in entries {
        if let Some(idx) = arr.iter().position(|v| v.as_str() == Some(s)) {
            arr.remove(idx);
        }
    }
}

fn install_inner(
    worktree_dir: &Path,
    role: &str,
    caps: &RoleCapabilities,
) -> Result<(), String> {
    let path = settings_path(worktree_dir);
    let mut root = read_settings(&path)?;

    // Make sure root is an object — this is what guards the rest of the writes.
    if !root.is_object() {
        return Err("settings.json root must be a JSON object".into());
    }

    // Migrate any legacy markers (`_tx_pipeline_capabilities`,
    // `tx-pipeline-managed`) into the unified namespace before reading the
    // per-role marker. This is a no-op on already-migrated files.
    let pre_migrate = root.clone();
    managed_marker::migrate_in_place(&mut root);
    let migration_dirty = root != pre_migrate;

    let new_managed = capabilities_to_permissions(caps);

    // Idempotency: if marker[role] already matches what we'd write, no-op
    // *unless* migration moved bytes around — in which case we still need
    // to flush the renamed marker to disk.
    let marker = read_marker(&root);
    if let Some(existing) = marker.get(role) {
        if let Ok(existing_parsed) = serde_json::from_value::<ManagedPermissions>(existing.clone()) {
            if existing_parsed == new_managed {
                if !migration_dirty {
                    // Trust the on-disk file — same role, same capabilities.
                    return Ok(());
                }
                // Same content but migration renamed the key — write through.
                let serialized = serde_json::to_string_pretty(&root)
                    .map_err(|e| format!("serialize: {e}"))?;
                return atomic_write(&path, &serialized);
            }
        }
        // Different content under our marker: uninstall first so we don't
        // accumulate stale entries from an earlier capability set.
        uninstall_inner(worktree_dir, role)?;
        // Re-read from disk after the uninstall write.
        root = read_settings(&path)?;
        if !root.is_object() {
            return Err("settings.json root must be a JSON object after uninstall".into());
        }
    }

    // Append our new entries.
    append_permission_entries(&mut root, "allow", &new_managed.allow)?;
    append_permission_entries(&mut root, "deny", &new_managed.deny)?;

    // Record what we added under the marker so uninstall can remove only ours.
    let mut marker = read_marker(&root);
    marker.insert(role.to_string(), serde_json::to_value(&new_managed).expect("serialize"));
    write_marker(&mut root, marker);

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &serialized)
}

fn uninstall_inner(worktree_dir: &Path, role: &str) -> Result<(), String> {
    let path = settings_path(worktree_dir);
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_settings(&path)?;
    if !root.is_object() {
        // Bizarre user content — leave it alone.
        return Ok(());
    }
    // Migrate legacy markers first so an uninstall called by a new binary on
    // a settings.json written by an old binary still finds our entries.
    managed_marker::migrate_in_place(&mut root);
    let mut marker = read_marker(&root);
    let Some(existing) = marker.remove(role) else {
        // We never installed for this role (or someone deleted our marker).
        return Ok(());
    };
    let parsed: ManagedPermissions = match serde_json::from_value(existing) {
        Ok(p) => p,
        Err(_) => {
            // Marker corrupted — drop the role's marker entry but don't
            // touch permissions arrays. Better to leak a few entries than
            // to mistakenly delete user content.
            write_marker(&mut root, marker);
            let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
            return atomic_write(&path, &serialized);
        }
    };

    remove_permission_entries(&mut root, "allow", &parsed.allow);
    remove_permission_entries(&mut root, "deny", &parsed.deny);
    write_marker(&mut root, marker);

    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {e}"))?;
    atomic_write(&path, &serialized)
}

// ─── Tauri commands ─────────────────────

#[tauri::command]
pub fn pipeline_capabilities_install(
    worktree_dir: String,
    role: String,
    capabilities: RoleCapabilities,
) -> Result<(), String> {
    validate_path_arg(&worktree_dir)?;
    validate_role(&role)?;
    install_inner(Path::new(&worktree_dir), &role, &capabilities)
}

#[tauri::command]
pub fn pipeline_capabilities_uninstall(
    worktree_dir: String,
    role: String,
) -> Result<(), String> {
    validate_path_arg(&worktree_dir)?;
    validate_role(&role)?;
    uninstall_inner(Path::new(&worktree_dir), &role)
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

    fn planner_caps() -> RoleCapabilities {
        RoleCapabilities {
            file_writes: FileWrites {
                allow: vec![
                    "docs/superpowers/specs/**".into(),
                    "docs/superpowers/plans/**".into(),
                ],
                deny: vec!["**/*.env".into(), "**/.git/**".into(), "**/secrets.*".into()],
            },
            shell: ShellPatterns {
                allow_patterns: vec![
                    "rg *".into(),
                    "git status".into(),
                ],
                deny_patterns: vec!["git push *".into(), "rm -rf *".into()],
            },
            network: NetworkScope::None,
            mcp_tools: vec![],
            max_file_size: 256_000,
        }
    }

    fn builder_caps() -> RoleCapabilities {
        RoleCapabilities {
            file_writes: FileWrites {
                allow: vec!["src/**".into(), "tests/**".into()],
                deny: vec!["**/*.env".into(), "docs/**".into()],
            },
            shell: ShellPatterns {
                allow_patterns: vec!["pnpm *".into(), "cargo *".into()],
                deny_patterns: vec!["git push *".into()],
            },
            network: NetworkScope::PackageManagers,
            mcp_tools: vec![],
            max_file_size: 256_000,
        }
    }

    fn reviewer_caps() -> RoleCapabilities {
        RoleCapabilities {
            file_writes: FileWrites {
                allow: vec![],
                deny: vec!["**".into()],
            },
            shell: ShellPatterns {
                allow_patterns: vec!["rg *".into(), "git diff *".into()],
                deny_patterns: vec![],
            },
            network: NetworkScope::None,
            mcp_tools: vec![],
            max_file_size: 256_000,
        }
    }

    #[test]
    fn install_creates_settings_with_translated_permissions_for_planner() {
        let dir = tempdir().unwrap();
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();

        let path = settings_path(dir.path());
        assert!(path.exists());

        let v = read_json(&path);
        let allow = v["permissions"]["allow"].as_array().expect("allow array");
        let deny = v["permissions"]["deny"].as_array().expect("deny array");

        // Shell verbs translated.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(rg *)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(git status)")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Bash(git push *)")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Bash(rm -rf *)")));

        // File writes translate to BOTH Write() and Edit().
        assert!(allow.iter().any(|x| x.as_str() == Some("Write(docs/superpowers/specs/**)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("Edit(docs/superpowers/specs/**)")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Write(**/*.env)")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Edit(**/*.env)")));

        // network: none → deny WebFetch + WebSearch.
        assert!(deny.iter().any(|x| x.as_str() == Some("WebFetch")));
        assert!(deny.iter().any(|x| x.as_str() == Some("WebSearch")));

        // Marker present under the unified namespace.
        assert!(v[managed_marker::NAMESPACE]["capabilities"]["planner"].is_object());
    }

    #[test]
    fn install_is_idempotent() {
        let dir = tempdir().unwrap();
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();
        let after_first = fs::read_to_string(settings_path(dir.path())).unwrap();

        install_inner(dir.path(), "planner", &planner_caps()).unwrap();
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();

        let after_third = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert_eq!(after_first, after_third, "repeated install must be a byte-exact no-op");
    }

    #[test]
    fn install_then_uninstall_round_trips_to_empty_baseline() {
        let dir = tempdir().unwrap();
        // Pre-existing empty settings.
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{}").unwrap();
        let baseline = fs::read_to_string(&path).unwrap();

        install_inner(dir.path(), "planner", &planner_caps()).unwrap();
        uninstall_inner(dir.path(), "planner").unwrap();

        let v = read_json(&path);
        // Marker gone (cleanup unwinds the empty namespace too).
        assert!(v.get(managed_marker::NAMESPACE).is_none(), "marker should be removed when last role uninstalled");
        // Permissions arrays empty (not removed — same as guardrails leaves PreToolUse).
        assert_eq!(v["permissions"]["allow"].as_array().unwrap().len(), 0);
        assert_eq!(v["permissions"]["deny"].as_array().unwrap().len(), 0);
        // Note: we don't byte-equal the baseline — `permissions: {allow: [], deny: []}`
        // is a normalized state we accept.
        let _ = baseline;
    }

    #[test]
    fn reviewer_caps_deny_all_writes() {
        let dir = tempdir().unwrap();
        install_inner(dir.path(), "reviewer", &reviewer_caps()).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let deny = v["permissions"]["deny"].as_array().expect("deny");
        assert!(deny.iter().any(|x| x.as_str() == Some("Write(**)")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Edit(**)")));

        let allow = v["permissions"]["allow"].as_array().expect("allow");
        // No Write/Edit allow entries — reviewer is read-only.
        assert!(!allow.iter().any(|x| x.as_str().map(|s| s.starts_with("Write(") || s.starts_with("Edit(")).unwrap_or(false)));
    }

    #[test]
    fn user_content_preserved_through_install_and_uninstall() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let user = json!({
            "permissions": {
                "allow": ["Bash(echo hello)", "Read"],
                "deny": ["Bash(sudo *)"]
            },
            "extra": "untouched"
        });
        fs::write(&path, serde_json::to_string_pretty(&user).unwrap()).unwrap();

        install_inner(dir.path(), "planner", &planner_caps()).unwrap();

        let v = read_json(&path);
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        // User entries still present.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(echo hello)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("Read")));
        // Our entries appended.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(rg *)")));
        // Untouched siblings.
        assert_eq!(v["extra"], json!("untouched"));

        uninstall_inner(dir.path(), "planner").unwrap();
        let v = read_json(&path);
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        let deny = v["permissions"]["deny"].as_array().expect("deny");
        // User entries STILL present after uninstall.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(echo hello)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("Read")));
        assert!(deny.iter().any(|x| x.as_str() == Some("Bash(sudo *)")));
        // Our entries gone.
        assert!(!allow.iter().any(|x| x.as_str() == Some("Bash(rg *)")));
        assert_eq!(v["extra"], json!("untouched"));
    }

    #[test]
    fn switching_roles_keeps_only_active_role_entries() {
        let dir = tempdir().unwrap();
        // Install planner, then switch to builder (which uninstalls planner first).
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();
        uninstall_inner(dir.path(), "planner").unwrap();
        install_inner(dir.path(), "builder", &builder_caps()).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        // Builder entries present.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(pnpm *)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("Write(src/**)")));
        // Planner-only entries gone (rg * is in BOTH planner+builder defaults
        // typically, but our test fixtures keep them disjoint to make this
        // assertion meaningful).
        assert!(!allow.iter().any(|x| x.as_str() == Some("Bash(rg *)")));
        // Marker only contains builder.
        let caps_marker = &v[managed_marker::NAMESPACE]["capabilities"];
        assert!(caps_marker["builder"].is_object());
        assert!(caps_marker.get("planner").is_none());
    }

    #[test]
    fn install_with_different_caps_replaces_existing_role_entries() {
        // If the same role gets re-installed with a different capability set,
        // the old entries must be removed first (else they accumulate).
        let dir = tempdir().unwrap();
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();

        // Re-install with a stripped-down planner that has no shell allowlist.
        let stripped = RoleCapabilities {
            file_writes: FileWrites { allow: vec![], deny: vec![] },
            shell: ShellPatterns { allow_patterns: vec!["ls *".into()], deny_patterns: vec![] },
            network: NetworkScope::None,
            mcp_tools: vec![],
            max_file_size: 0,
        };
        install_inner(dir.path(), "planner", &stripped).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        // Old planner entries gone.
        assert!(!allow.iter().any(|x| x.as_str() == Some("Bash(rg *)")));
        // New entry present.
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(ls *)")));
    }

    #[test]
    fn package_managers_network_emits_domain_allowlist() {
        let dir = tempdir().unwrap();
        install_inner(dir.path(), "builder", &builder_caps()).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        assert!(allow.iter().any(|x| x.as_str() == Some("WebFetch(domain:registry.npmjs.org)")));
        assert!(allow.iter().any(|x| x.as_str() == Some("WebFetch(domain:crates.io)")));
        // No bare WebFetch — only domain-scoped.
        assert!(!allow.iter().any(|x| x.as_str() == Some("WebFetch")));
        let deny = v["permissions"]["deny"].as_array().expect("deny");
        assert!(deny.iter().any(|x| x.as_str() == Some("WebSearch")));
    }

    #[test]
    fn mcp_tools_become_wildcarded_allow_entries() {
        let dir = tempdir().unwrap();
        let caps = RoleCapabilities {
            file_writes: FileWrites { allow: vec![], deny: vec![] },
            shell: ShellPatterns { allow_patterns: vec![], deny_patterns: vec![] },
            network: NetworkScope::None,
            mcp_tools: vec!["slack".into(), "linear".into()],
            max_file_size: 0,
        };
        install_inner(dir.path(), "planner", &caps).unwrap();

        let v = read_json(&settings_path(dir.path()));
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        assert!(allow.iter().any(|x| x.as_str() == Some("mcp__slack__*")));
        assert!(allow.iter().any(|x| x.as_str() == Some("mcp__linear__*")));
    }

    #[test]
    fn uninstall_is_noop_if_file_missing() {
        let dir = tempdir().unwrap();
        // No .claude/settings.json in dir.
        uninstall_inner(dir.path(), "planner").unwrap();
        assert!(!settings_path(dir.path()).exists());
    }

    #[test]
    fn install_rejects_invalid_role() {
        let res = pipeline_capabilities_install(
            "/tmp/foo".into(),
            "saboteur".into(),
            serde_json::from_value(json!({
                "fileWrites": {"allow": [], "deny": []},
                "shell": {"allowPatterns": [], "denyPatterns": []},
                "network": "none",
                "mcpTools": [],
                "maxFileSize": 0,
            })).unwrap(),
        );
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("invalid role"));
    }

    #[test]
    fn install_rejects_empty_path() {
        let caps: RoleCapabilities = serde_json::from_value(json!({
            "fileWrites": {"allow": [], "deny": []},
            "shell": {"allowPatterns": [], "denyPatterns": []},
            "network": "none",
            "mcpTools": [],
            "maxFileSize": 0,
        })).unwrap();
        let res = pipeline_capabilities_install(String::new(), "planner".into(), caps);
        assert!(res.is_err());
    }

    #[test]
    fn install_rejects_control_chars_in_path() {
        let caps: RoleCapabilities = serde_json::from_value(json!({
            "fileWrites": {"allow": [], "deny": []},
            "shell": {"allowPatterns": [], "denyPatterns": []},
            "network": "none",
            "mcpTools": [],
            "maxFileSize": 0,
        })).unwrap();
        let res = pipeline_capabilities_install("/tmp/x\npath".into(), "planner".into(), caps);
        assert!(res.is_err());
    }

    #[test]
    fn install_handles_empty_existing_file() {
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "").unwrap();

        install_inner(dir.path(), "planner", &planner_caps()).unwrap();
        let v = read_json(&path);
        assert!(v["permissions"]["allow"].is_array());
    }

    /// Legacy top-level capabilities key. Kept here only for migration-test
    /// fixtures — production code routes through `managed_marker::NAMESPACE`.
    const LEGACY_CAPABILITIES_KEY: &str = "_tx_pipeline_capabilities";

    #[test]
    fn install_on_legacy_marker_file_migrates_to_unified_namespace() {
        // Pre-3a settings.json: `_tx_pipeline_capabilities` at the root.
        // After install, the legacy key must be gone and the contents must
        // live under `_tx_pipeline_managed.capabilities`. User content is
        // preserved.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let pre = json!({
            "permissions": {
                "allow": ["Bash(echo hello)", "Bash(rg *)", "Bash(git status)",
                          "Write(docs/superpowers/specs/**)", "Edit(docs/superpowers/specs/**)",
                          "Write(docs/superpowers/plans/**)", "Edit(docs/superpowers/plans/**)"],
                "deny":  ["Bash(git push *)", "Bash(rm -rf *)",
                          "Write(**/*.env)", "Edit(**/*.env)",
                          "Write(**/.git/**)", "Edit(**/.git/**)",
                          "Write(**/secrets.*)", "Edit(**/secrets.*)",
                          "WebFetch", "WebSearch"]
            },
            "extra": "untouched",
            LEGACY_CAPABILITIES_KEY: {
                "planner": {
                    "allow": ["Bash(rg *)", "Bash(git status)",
                              "Write(docs/superpowers/specs/**)", "Edit(docs/superpowers/specs/**)",
                              "Write(docs/superpowers/plans/**)", "Edit(docs/superpowers/plans/**)"],
                    "deny":  ["Bash(git push *)", "Bash(rm -rf *)",
                              "Write(**/*.env)", "Edit(**/*.env)",
                              "Write(**/.git/**)", "Edit(**/.git/**)",
                              "Write(**/secrets.*)", "Edit(**/secrets.*)",
                              "WebFetch", "WebSearch"]
                }
            }
        });
        fs::write(&path, serde_json::to_string_pretty(&pre).unwrap()).unwrap();

        // Re-installing with the same capabilities should migrate the marker
        // without changing the permission arrays.
        install_inner(dir.path(), "planner", &planner_caps()).unwrap();

        let v = read_json(&path);
        assert!(v.get(LEGACY_CAPABILITIES_KEY).is_none(), "legacy key must be removed");
        assert!(
            v[managed_marker::NAMESPACE]["capabilities"]["planner"].is_object(),
            "marker migrated under unified namespace"
        );
        // User content preserved.
        assert_eq!(v["extra"], json!("untouched"));
        let allow = v["permissions"]["allow"].as_array().expect("allow");
        assert!(allow.iter().any(|x| x.as_str() == Some("Bash(echo hello)")));
    }

    #[test]
    fn user_content_preserved_through_migration_with_unrelated_keys() {
        // A user's settings.json with hand-authored unrelated keys plus our
        // legacy marker — both must survive the migration unchanged.
        let dir = tempdir().unwrap();
        let path = settings_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let pre = json!({
            "permissions": { "allow": ["Read"], "deny": [] },
            "model": "claude-opus-4-1",
            "env": { "FOO": "bar" },
            LEGACY_CAPABILITIES_KEY: {
                "planner": { "allow": [], "deny": [] }
            }
        });
        fs::write(&path, serde_json::to_string_pretty(&pre).unwrap()).unwrap();

        // Force a uninstall pathway — the legacy marker says we own a planner
        // entry with empty allow/deny, so uninstall just removes the marker.
        uninstall_inner(dir.path(), "planner").unwrap();

        let v = read_json(&path);
        // Legacy key gone.
        assert!(v.get(LEGACY_CAPABILITIES_KEY).is_none());
        // Namespace also gone (no roles left after uninstall).
        assert!(v.get(managed_marker::NAMESPACE).is_none());
        // User content untouched.
        assert_eq!(v["model"], json!("claude-opus-4-1"));
        assert_eq!(v["env"]["FOO"], json!("bar"));
        assert_eq!(v["permissions"]["allow"], json!(["Read"]));
    }
}
