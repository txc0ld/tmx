//! Shared marker convention for pipeline-managed entries inside a worktree's
//! `.claude/settings.json`.
//!
//! Background (2c-ii.4 review): guardrails originally tagged each PreToolUse
//! entry with `tx-pipeline-managed: true` (kebab-case) while capabilities
//! stored a top-level `_tx_pipeline_capabilities` map (snake-case). That
//! drift made it hard to grep, hard to reason about, and risked future
//! collisions if either side renamed.
//!
//! Phase 3a unifies both under one prefix:
//!
//! - **Per-entry marker** (hooks): each PreToolUse entry we own carries a
//!   sibling `_tx_pipeline_managed_entry: true`. This is the simpler /
//!   user-edit-robust option (Option B in the plan) — survives the user
//!   reordering or splicing entries around it because we identify by
//!   marker, not by index.
//! - **Top-level namespace** (capabilities): `_tx_pipeline_managed.capabilities[<role>]`
//!   holds the per-role copy of `permissions.allow` / `permissions.deny`
//!   strings we authored, so uninstall removes only ours.
//!
//! Both keys share the `_tx_pipeline_managed` prefix. The legacy keys
//! (`tx-pipeline-managed`, `_tx_pipeline_capabilities`) remain readable
//! during a transition window via [`migrate_in_place`], which both
//! install and uninstall call before doing any mutation. That makes a
//! rolled-back binary safe — old marker → still removable; new marker
//! → still readable on a re-run.

use serde_json::{Map, Value};

/// Top-level key on the settings root for pipeline-managed state.
pub const NAMESPACE: &str = "_tx_pipeline_managed";

/// Per-entry sibling field on `hooks.PreToolUse` entries we own.
pub const ENTRY_MARKER: &str = "_tx_pipeline_managed_entry";

/// Legacy per-entry marker key. Migration rewrites this to [`ENTRY_MARKER`].
const LEGACY_ENTRY_MARKER: &str = "tx-pipeline-managed";

/// Legacy top-level capabilities key. Migration moves its contents into
/// `_tx_pipeline_managed.capabilities`.
const LEGACY_CAPABILITIES_KEY: &str = "_tx_pipeline_capabilities";

/// Returns true if the entry has our per-entry marker set to `true`.
/// Tolerates the legacy key during the transition window — callers that
/// run [`migrate_in_place`] first will only ever see the new form, but
/// being lenient here means a half-migrated file stays consistent.
pub fn entry_is_managed(entry: &Value) -> bool {
    let Some(obj) = entry.as_object() else { return false };
    let new_form = obj.get(ENTRY_MARKER).and_then(Value::as_bool).unwrap_or(false);
    let old_form = obj.get(LEGACY_ENTRY_MARKER).and_then(Value::as_bool).unwrap_or(false);
    new_form || old_form
}

/// Walk the settings root and rewrite legacy markers to the unified form.
///
/// Steps:
/// 1. For each entry under `hooks.PreToolUse`: if it has the legacy
///    `tx-pipeline-managed: true` field, remove it and set
///    `_tx_pipeline_managed_entry: true` instead.
/// 2. If a top-level `_tx_pipeline_capabilities` key exists, move its
///    contents into `_tx_pipeline_managed.capabilities` (merging into
///    an existing namespace object if one is already there, with the
///    new namespace winning — but in practice they should never coexist).
///
/// Idempotent: running on already-migrated or fresh `{}` is a no-op.
/// Defensive on malformed input — bails out of any branch whose shape
/// doesn't match expectations rather than panicking, so a partially
/// hand-edited file survives.
pub fn migrate_in_place(root: &mut Value) {
    let Some(obj) = root.as_object_mut() else { return };

    // ── 1. Per-entry marker rename inside hooks.PreToolUse ──
    if let Some(hooks) = obj.get_mut("hooks").and_then(Value::as_object_mut) {
        if let Some(arr) = hooks.get_mut("PreToolUse").and_then(Value::as_array_mut) {
            for entry in arr.iter_mut() {
                let Some(entry_obj) = entry.as_object_mut() else { continue };
                let had_legacy = entry_obj
                    .get(LEGACY_ENTRY_MARKER)
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if had_legacy {
                    entry_obj.remove(LEGACY_ENTRY_MARKER);
                    // Set the new marker. If somehow both already present, the
                    // overwrite is fine — the new form wins.
                    entry_obj.insert(ENTRY_MARKER.to_string(), Value::Bool(true));
                } else if entry_obj.contains_key(LEGACY_ENTRY_MARKER) {
                    // Legacy key exists with a non-true value (false / null /
                    // garbage). Treat as not-ours but still strip the key so
                    // the file stops referencing the old name.
                    entry_obj.remove(LEGACY_ENTRY_MARKER);
                }
            }
        }
    }

    // ── 2. Move legacy top-level capabilities key into the namespace ──
    if let Some(legacy) = obj.remove(LEGACY_CAPABILITIES_KEY) {
        // Only migrate if the legacy value is an object — otherwise drop it
        // (we never wrote anything else and don't want to corrupt the new
        // namespace).
        if let Value::Object(legacy_map) = legacy {
            // Get-or-create the namespace object.
            let ns = obj
                .entry(NAMESPACE.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Value::Object(ns_map) = ns {
                // Get-or-create the `capabilities` sub-object.
                let caps = ns_map
                    .entry("capabilities".to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(caps_map) = caps {
                    for (k, v) in legacy_map {
                        // Don't overwrite a value already present under the new
                        // namespace — the new namespace wins, since migration
                        // should be idempotent and the legacy form is older.
                        caps_map.entry(k).or_insert(v);
                    }
                }
                // If `capabilities` was a non-object (corrupted), leave it.
            }
            // If `_tx_pipeline_managed` was a non-object (corrupted), the
            // legacy data is silently dropped. Better than panicking.
        }
    }
}

/// Borrow `root._tx_pipeline_managed.capabilities[role]` mutably, if present.
///
/// Currently used by tests and reserved for future callers that need to
/// patch a per-role marker in place; capabilities.rs uses the read-modify-
/// write `read_marker` / `write_marker` pair instead.
#[allow(dead_code)]
pub fn capabilities_section<'a>(
    root: &'a mut Value,
    role: &str,
) -> Option<&'a mut Value> {
    root.as_object_mut()?
        .get_mut(NAMESPACE)?
        .as_object_mut()?
        .get_mut("capabilities")?
        .as_object_mut()?
        .get_mut(role)
}

/// Get a *read-only* reference to `root._tx_pipeline_managed.capabilities[role]`.
#[allow(dead_code)]
pub fn capabilities_section_ref<'a>(root: &'a Value, role: &str) -> Option<&'a Value> {
    root.as_object()?
        .get(NAMESPACE)?
        .as_object()?
        .get("capabilities")?
        .as_object()?
        .get(role)
}

/// Set `root._tx_pipeline_managed.capabilities[role] = value`, creating
/// intermediate objects as needed. Errors if any intermediate node has
/// the wrong type — mirrors the defensive style elsewhere in this module.
#[allow(dead_code)]
pub fn set_capabilities_section(
    root: &mut Value,
    role: &str,
    value: Value,
) -> Result<(), String> {
    if !root.is_object() {
        return Err("settings.json root must be a JSON object".into());
    }
    let obj = root.as_object_mut().expect("checked above");
    let ns = obj
        .entry(NAMESPACE.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !ns.is_object() {
        return Err(format!("settings.json `{NAMESPACE}` is not an object"));
    }
    let ns_map = ns.as_object_mut().expect("checked above");
    let caps = ns_map
        .entry("capabilities".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !caps.is_object() {
        return Err(format!("settings.json `{NAMESPACE}.capabilities` is not an object"));
    }
    caps.as_object_mut()
        .expect("checked above")
        .insert(role.to_string(), value);
    Ok(())
}

/// Remove `root._tx_pipeline_managed.capabilities[role]`. If that leaves
/// `capabilities` empty, removes it. If that leaves the namespace empty,
/// removes that too — keeping the file clean of breadcrumb markers when
/// no roles remain.
#[allow(dead_code)]
pub fn remove_capabilities_section(root: &mut Value, role: &str) {
    let Some(obj) = root.as_object_mut() else { return };
    let Some(ns) = obj.get_mut(NAMESPACE).and_then(Value::as_object_mut) else { return };
    let caps_empty = {
        let Some(caps) = ns.get_mut("capabilities").and_then(Value::as_object_mut) else {
            return;
        };
        caps.remove(role);
        caps.is_empty()
    };
    if caps_empty {
        ns.remove("capabilities");
    }
    if ns.is_empty() {
        obj.remove(NAMESPACE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrate_rewrites_old_hook_markers() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "tx-pipeline-managed": true, "hooks": [] }
                ]
            }
        });
        migrate_in_place(&mut root);
        let entry = &root["hooks"]["PreToolUse"][0];
        assert_eq!(entry[ENTRY_MARKER], json!(true));
        assert!(
            entry.get(LEGACY_ENTRY_MARKER).is_none(),
            "legacy marker must be removed"
        );
    }

    #[test]
    fn migrate_rewrites_old_capability_markers() {
        let mut root = json!({
            "permissions": { "allow": [], "deny": [] },
            "_tx_pipeline_capabilities": {
                "planner": { "allow": ["Bash(rg *)"], "deny": [] }
            }
        });
        migrate_in_place(&mut root);
        assert!(
            root.get(LEGACY_CAPABILITIES_KEY).is_none(),
            "legacy capabilities key must be removed"
        );
        let planner = capabilities_section_ref(&root, "planner").expect("present");
        assert_eq!(planner["allow"], json!(["Bash(rg *)"]));
    }

    #[test]
    fn migrate_handles_both_old_markers_in_one_file() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "tx-pipeline-managed": true, "hooks": [] },
                    { "matcher": "Read", "hooks": [] }
                ]
            },
            "_tx_pipeline_capabilities": {
                "builder": { "allow": ["Bash(pnpm *)"], "deny": [] }
            }
        });
        migrate_in_place(&mut root);
        // Hook entry rewritten.
        let arr = root["hooks"]["PreToolUse"].as_array().expect("array");
        assert_eq!(arr[0][ENTRY_MARKER], json!(true));
        assert!(arr[0].get(LEGACY_ENTRY_MARKER).is_none());
        // User entry untouched.
        assert!(arr[1].get(ENTRY_MARKER).is_none());
        // Capabilities moved.
        assert!(root.get(LEGACY_CAPABILITIES_KEY).is_none());
        let builder = capabilities_section_ref(&root, "builder").expect("present");
        assert_eq!(builder["allow"], json!(["Bash(pnpm *)"]));
    }

    #[test]
    fn migrate_is_idempotent() {
        let mut root = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Bash", "tx-pipeline-managed": true, "hooks": [] }
                ]
            },
            "_tx_pipeline_capabilities": {
                "planner": { "allow": ["X"], "deny": [] }
            }
        });
        migrate_in_place(&mut root);
        let after_first = serde_json::to_string(&root).unwrap();
        migrate_in_place(&mut root);
        let after_second = serde_json::to_string(&root).unwrap();
        assert_eq!(after_first, after_second, "second migrate must be a no-op");
    }

    #[test]
    fn migrate_is_noop_on_fresh_object() {
        let mut root = json!({});
        let before = serde_json::to_string(&root).unwrap();
        migrate_in_place(&mut root);
        let after = serde_json::to_string(&root).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn migrate_preserves_unrelated_user_content() {
        let mut root = json!({
            "permissions": { "allow": ["Read"], "deny": [] },
            "extra": "untouched",
            "hooks": {
                "PreToolUse": [
                    { "matcher": "Read", "hooks": [{ "type": "command", "command": "echo user" }] }
                ],
                "PostToolUse": [
                    { "matcher": "Edit", "hooks": [] }
                ]
            }
        });
        let before = root.clone();
        migrate_in_place(&mut root);
        assert_eq!(root, before, "no markers means no changes");
    }

    #[test]
    fn entry_is_managed_accepts_both_old_and_new_markers() {
        let new_form = json!({ ENTRY_MARKER: true });
        let old_form = json!({ LEGACY_ENTRY_MARKER: true });
        let unmarked = json!({ "matcher": "Bash" });
        assert!(entry_is_managed(&new_form));
        assert!(entry_is_managed(&old_form));
        assert!(!entry_is_managed(&unmarked));
    }

    #[test]
    fn capabilities_helpers_round_trip() {
        let mut root = json!({});
        set_capabilities_section(&mut root, "planner", json!({"allow": ["X"], "deny": []})).unwrap();
        assert_eq!(
            capabilities_section_ref(&root, "planner").unwrap()["allow"],
            json!(["X"])
        );
        remove_capabilities_section(&mut root, "planner");
        // Cleanup: namespace removed when empty.
        assert!(root.get(NAMESPACE).is_none());
    }

    #[test]
    fn migrate_drops_corrupted_legacy_capabilities_value() {
        // Legacy key with a non-object value: don't propagate garbage into the
        // new namespace, just drop it.
        let mut root = json!({
            "_tx_pipeline_capabilities": "not-an-object"
        });
        migrate_in_place(&mut root);
        assert!(root.get(LEGACY_CAPABILITIES_KEY).is_none());
        assert!(root.get(NAMESPACE).is_none());
    }
}
