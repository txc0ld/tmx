//! `pipeline_cleanup_old_runs` — age-based GC for terminal pipeline runs.
//!
//! Why this exists
//! ───────────────
//! Per-run telemetry JSONL files (`<projectDir>/.terminalx/pipeline-telemetry/<runId>.jsonl`,
//! plus the rotated `.jsonl.1`) and run-record JSON snapshots
//! (`<projectDir>/.terminalx/pipeline-runs/<runId>.json`) are write-once /
//! grow-only. Each individual file has a 5MB rotation cap (`telemetry.rs`)
//! but nothing prunes the directories themselves, so after months of use a
//! project can accumulate thousands of files for runs that finished long
//! ago. This command walks the run-records directory, picks out runs that
//! are both terminal AND older than the retention window, and deletes the
//! run record + telemetry file(s) + (optionally) the old worktree.
//!
//! Safety
//! ──────
//! - Every deletion target is constructed by joining `project_dir` with a
//!   fixed subdir (`.terminalx/...` or `.tx-worktrees/<runId>`). The only
//!   user-derived component in any path is the run id, which is validated
//!   against `[A-Za-z0-9_-]+` BEFORE any filesystem call.
//! - Path traversal is impossible because the run id can't contain `/`,
//!   `\`, or `..` after validation.
//! - We never touch `project_dir` itself or anything outside `.terminalx/`
//!   and `.tx-worktrees/` — the cleanup is scoped to TerminalX-managed
//!   subtrees.
//! - A retention of 0 days is treated as "never run". The frontend uses
//!   that as the "disable auto-cleanup" sentinel.
//!
//! What counts as terminal
//! ───────────────────────
//! Mirrors `state-machine.ts::TERMINAL_STATES` — `done`, `failed`, or
//! `escalated`. Anything else (active stages, `awaiting_*`, `idle`) is
//! left alone regardless of age. A run that's been stuck in
//! `awaiting_clarification` for two months still has a human waiting on
//! it; cleanup MUST NOT yank its files.
//!
//! Age computation
//! ───────────────
//! We prefer the run's `endedAt` field (always set when transitioning to
//! a terminal state — see `state-machine.ts`). When that's missing for
//! some pre-Phase-3 record, we fall back to the file's mtime so a corrupt
//! record can still age out.

use super::validate_path_arg;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Default retention window. The frontend's settings UI also defaults to
/// 30 — this constant is the source of truth for "what does the Rust side
/// consider sensible if the caller passes something out of range?"
#[allow(dead_code)]
pub const DEFAULT_RETENTION_DAYS: u32 = 30;

/// Run id whitelist — must match `pipeline_telemetry_log::validate_run_id`
/// and `failure_bundle::validate_run_id` so a run id valid for one IPC is
/// valid for all of them.
fn run_id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// JSON shape we care about. We don't deserialize the full `PipelineRun`
/// because the schema evolves and we don't want a single new field to
/// break cleanup. Only `id`, `state`, and `endedAt` matter here.
#[derive(Debug, Deserialize)]
struct RunRecord {
    id: String,
    state: String,
    #[serde(rename = "endedAt")]
    ended_at: Option<u64>,
    /// Optional: only present when the project record was created via
    /// `Date.now()` ms. Used as a last-resort fallback for `endedAt`.
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
}

#[derive(Debug, Default, Serialize)]
pub struct CleanupResult {
    pub removed_records: u32,
    pub removed_telemetry: u32,
    pub removed_worktrees: u32,
    pub errors: Vec<String>,
}

fn is_terminal_state(state: &str) -> bool {
    matches!(state, "done" | "failed" | "escalated")
}

/// Returns the unix-millis timestamp we'll compare against the cutoff.
/// Prefer `endedAt`; fall back to `startedAt`; fall back to file mtime.
fn record_age_anchor_ms(rec: &RunRecord, file_path: &Path) -> u64 {
    if let Some(t) = rec.ended_at {
        return t;
    }
    if let Some(t) = rec.started_at {
        return t;
    }
    // mtime fallback. If even that fails we return 0 so the record looks
    // very old and gets cleaned up — corrupt records shouldn't pin disk.
    let mtime = std::fs::metadata(file_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    mtime
}

fn path_mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX)
}

/// Try `git worktree remove --force` first (cleans up git's bookkeeping)
/// and fall back to `remove_dir_all` for cases where git missed something
/// (e.g. orphaned directory whose worktree was already removed from
/// `git worktree list`). Mirrors the pattern in `worktree.rs::destroy_worktree_inner`.
fn remove_worktree_dir(project_dir: &Path, worktree_path: &Path) -> Result<(), String> {
    if !worktree_path.exists() {
        return Ok(());
    }
    let _ = Command::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            &worktree_path.to_string_lossy(),
        ])
        .current_dir(project_dir)
        .output();
    if worktree_path.exists() {
        std::fs::remove_dir_all(worktree_path)
            .map_err(|e| format!("rmdir {}: {e}", worktree_path.display()))?;
    }
    Ok(())
}

/// Pure inner — takes the cutoff as ms-since-epoch so tests can pin it
/// without touching `SystemTime::now()`. Production callers compute
/// `now_ms - retention_days * 86_400_000`.
pub(crate) fn cleanup_inner(project_dir: &Path, cutoff_ms: u64) -> CleanupResult {
    let mut result = CleanupResult::default();

    let runs_dir = project_dir.join(".terminalx/pipeline-runs");
    let telemetry_dir = project_dir.join(".terminalx/pipeline-telemetry");
    let worktrees_root = project_dir.join(".tx-worktrees");

    let entries = match std::fs::read_dir(&runs_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return result,
        Err(e) => {
            result
                .errors
                .push(format!("read_dir {}: {e}", runs_dir.display()));
            return result;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Only `.json` files are run records. Ignore anything else humans
        // (or future code) drops in there.
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        let raw = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                result.errors.push(format!("read {}: {e}", path.display()));
                continue;
            }
        };

        let rec: RunRecord = match serde_json::from_str(&raw) {
            Ok(r) => r,
            Err(_) => {
                // Malformed snapshot — leave alone. Don't auto-delete
                // anything we can't confidently classify as terminal.
                continue;
            }
        };

        // Re-validate the parsed id. The filename and the in-record id
        // SHOULD match, but we use the in-record id to construct
        // telemetry/worktree paths, so it has to be a safe string.
        if !run_id_ok(&rec.id) {
            // Parse OK but malicious/garbage id — leave alone, no IO.
            continue;
        }

        if !is_terminal_state(&rec.state) {
            continue;
        }

        let anchor_ms = record_age_anchor_ms(&rec, &path);
        if anchor_ms > cutoff_ms {
            continue;
        }

        // Old + terminal — clean it up.

        if let Err(e) = std::fs::remove_file(&path) {
            result.errors.push(format!("rm {}: {e}", path.display()));
            // Don't try to clean the rest of this run's files — record
            // deletion is the source of truth, telemetry without record
            // is fine to leave.
            continue;
        }
        result.removed_records += 1;

        let jsonl = telemetry_dir.join(format!("{}.jsonl", rec.id));
        let jsonl_rot = telemetry_dir.join(format!("{}.jsonl.1", rec.id));
        for tel in [&jsonl, &jsonl_rot] {
            match std::fs::remove_file(tel) {
                Ok(()) => result.removed_telemetry += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => result.errors.push(format!("rm {}: {e}", tel.display())),
            }
        }

        let wt = worktrees_root.join(&rec.id);
        if wt.exists() {
            match remove_worktree_dir(project_dir, &wt) {
                Ok(()) => result.removed_worktrees += 1,
                Err(e) => result.errors.push(e),
            }
        }
    }

    // Orphaned worktrees: directories under `.tx-worktrees/` whose run
    // record is gone AND whose directory mtime is older than the retention
    // cutoff. A just-created worktree can briefly exist before its run JSON
    // is flushed, so recent orphans are preserved for a later cleanup pass.
    //
    // Historical note: this used to delete every orphan regardless of age.
    // That was unsafe during launch/persistence races on Windows.
    //
    // Original invariant still applies: only safe run-id directories are touched.
    if worktrees_root.exists() {
        let entries = match std::fs::read_dir(&worktrees_root) {
            Ok(e) => e,
            Err(e) => {
                result
                    .errors
                    .push(format!("read_dir {}: {e}", worktrees_root.display()));
                return result;
            }
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let name = match p.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !run_id_ok(&name) {
                // Don't touch unfamiliar directories.
                continue;
            }
            // Does a record file still exist?
            let record = runs_dir.join(format!("{name}.json"));
            if record.exists() {
                continue;
            }
            if path_mtime_ms(&p) > cutoff_ms {
                continue;
            }
            match remove_worktree_dir(project_dir, &p) {
                Ok(()) => result.removed_worktrees += 1,
                Err(e) => result.errors.push(e),
            }
        }
    }

    result
}

#[tauri::command]
pub fn pipeline_cleanup_old_runs(
    project_dir: String,
    retention_days: u32,
) -> Result<CleanupResult, String> {
    validate_path_arg(&project_dir)?;
    if retention_days == 0 {
        // Sentinel: 0 disables auto-cleanup. The frontend already gates
        // the call, but defense-in-depth — never accidentally wipe
        // everything because of a misread setting.
        return Ok(CleanupResult::default());
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let window = Duration::from_secs(u64::from(retention_days) * 24 * 60 * 60);
    let cutoff_ms = now_ms.saturating_sub(window.as_millis() as u64);
    Ok(cleanup_inner(Path::new(&project_dir), cutoff_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_record(project: &Path, id: &str, state: &str, ended_at: Option<u64>) {
        let dir = project.join(".terminalx/pipeline-runs");
        fs::create_dir_all(&dir).unwrap();
        let body = match ended_at {
            Some(t) => format!(r#"{{"id":"{id}","state":"{state}","endedAt":{t},"startedAt":1}}"#),
            None => format!(r#"{{"id":"{id}","state":"{state}","startedAt":1}}"#),
        };
        fs::write(dir.join(format!("{id}.json")), body).unwrap();
    }

    fn write_telemetry(project: &Path, id: &str) {
        let dir = project.join(".terminalx/pipeline-telemetry");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{id}.jsonl")), "{}\n").unwrap();
        fs::write(dir.join(format!("{id}.jsonl.1")), "{}\n").unwrap();
    }

    #[test]
    fn cleanup_removes_terminal_records_older_than_cutoff() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // ended 1000 ms ago, cutoff at 500 ⇒ ended < cutoff (older), wipe.
        write_record(project, "r-old", "done", Some(100));
        write_telemetry(project, "r-old");

        let res = cleanup_inner(project, 500);
        assert_eq!(res.removed_records, 1);
        assert_eq!(res.removed_telemetry, 2);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert!(!project.join(".terminalx/pipeline-runs/r-old.json").exists());
        assert!(!project
            .join(".terminalx/pipeline-telemetry/r-old.jsonl")
            .exists());
        assert!(!project
            .join(".terminalx/pipeline-telemetry/r-old.jsonl.1")
            .exists());
    }

    #[test]
    fn cleanup_skips_terminal_records_newer_than_cutoff() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        write_record(project, "r-new", "done", Some(9_000));
        write_telemetry(project, "r-new");

        let res = cleanup_inner(project, 500);
        assert_eq!(res.removed_records, 0);
        assert_eq!(res.removed_telemetry, 0);
        assert!(project.join(".terminalx/pipeline-runs/r-new.json").exists());
    }

    #[test]
    fn cleanup_skips_non_terminal_runs_regardless_of_age() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // Stuck-on-clarification run from way back — must NOT be touched.
        write_record(project, "r-await", "awaiting_clarification", Some(1));
        write_telemetry(project, "r-await");
        write_record(project, "r-active", "building", Some(1));

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_records, 0);
        assert_eq!(res.removed_telemetry, 0);
        assert!(project
            .join(".terminalx/pipeline-runs/r-await.json")
            .exists());
        assert!(project
            .join(".terminalx/pipeline-runs/r-active.json")
            .exists());
    }

    #[test]
    fn cleanup_handles_each_terminal_state() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        write_record(project, "r-done", "done", Some(1));
        write_record(project, "r-failed", "failed", Some(1));
        write_record(project, "r-esc", "escalated", Some(1));
        write_record(project, "r-other", "merging", Some(1));

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_records, 3);
        assert!(project
            .join(".terminalx/pipeline-runs/r-other.json")
            .exists());
    }

    #[test]
    fn cleanup_removes_run_worktree_when_present() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        write_record(project, "r-wt", "done", Some(1));
        let wt = project.join(".tx-worktrees/r-wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join("scratch.md"), "x").unwrap();

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_records, 1);
        assert_eq!(res.removed_worktrees, 1);
        assert!(!wt.exists());
    }

    #[test]
    fn cleanup_removes_orphan_worktrees_with_no_run_record() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // No record file at all, but a stale worktree dir.
        let wt = project.join(".tx-worktrees/r-orphan");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join("a.txt"), "x").unwrap();

        // Also create the runs dir so the early `read_dir` doesn't bail
        // before the orphan-worktree pass.
        fs::create_dir_all(project.join(".terminalx/pipeline-runs")).unwrap();

        let res = cleanup_inner(project, u64::MAX);
        assert_eq!(res.removed_worktrees, 1);
        assert!(!wt.exists());
    }

    #[test]
    fn cleanup_preserves_recent_orphan_worktrees_with_no_run_record() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let wt = project.join(".tx-worktrees/r-recent-orphan");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join("a.txt"), "x").unwrap();
        fs::create_dir_all(project.join(".terminalx/pipeline-runs")).unwrap();

        let res = cleanup_inner(project, 1);

        assert_eq!(res.removed_worktrees, 0);
        assert!(wt.exists());
    }

    #[test]
    fn cleanup_skips_worktree_dirs_with_invalid_names() {
        // Defense-in-depth: if someone hand-creates `.tx-worktrees/../escape`
        // we never path-interpolate that into a delete.
        let dir = tempdir().unwrap();
        let project = dir.path();
        fs::create_dir_all(project.join(".terminalx/pipeline-runs")).unwrap();
        // `..escape` is invalid by run-id rules (contains `.`).
        let bad = project.join(".tx-worktrees/..escape");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("a.txt"), "x").unwrap();

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_worktrees, 0);
        assert!(bad.exists(), "must not touch unfamiliar dir names");
    }

    #[test]
    fn cleanup_skips_records_with_invalid_run_ids() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let runs = project.join(".terminalx/pipeline-runs");
        fs::create_dir_all(&runs).unwrap();
        // File on disk uses a safe name, but the in-record id is hostile.
        // We use the in-record id to interpolate the telemetry/worktree
        // path, so a bad id MUST short-circuit before any IO.
        fs::write(
            runs.join("safe.json"),
            r#"{"id":"../etc/passwd","state":"done","endedAt":1}"#,
        )
        .unwrap();

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_records, 0);
        assert!(runs.join("safe.json").exists());
    }

    #[test]
    fn cleanup_skips_malformed_json() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let runs = project.join(".terminalx/pipeline-runs");
        fs::create_dir_all(&runs).unwrap();
        fs::write(runs.join("broken.json"), "{ not valid json").unwrap();
        write_record(project, "r-good", "done", Some(1));

        let res = cleanup_inner(project, 9_999_999);
        // Good record cleaned, broken left alone.
        assert_eq!(res.removed_records, 1);
        assert!(runs.join("broken.json").exists());
    }

    #[test]
    fn cleanup_skips_non_json_files_in_runs_dir() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let runs = project.join(".terminalx/pipeline-runs");
        fs::create_dir_all(&runs).unwrap();
        fs::write(runs.join("README.txt"), "ignore me").unwrap();
        fs::write(runs.join(".DS_Store"), "ignore").unwrap();

        let res = cleanup_inner(project, 9_999_999);
        assert_eq!(res.removed_records, 0);
        assert!(runs.join("README.txt").exists());
    }

    #[test]
    fn cleanup_returns_empty_result_when_runs_dir_missing() {
        let dir = tempdir().unwrap();
        // Bare project dir — no `.terminalx/` subtree at all.
        let res = cleanup_inner(dir.path(), 9_999_999);
        assert_eq!(res.removed_records, 0);
        assert_eq!(res.removed_telemetry, 0);
        assert_eq!(res.removed_worktrees, 0);
        assert!(res.errors.is_empty());
    }

    #[test]
    fn cleanup_command_zero_retention_is_no_op() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        write_record(project, "r-old", "done", Some(1));
        write_telemetry(project, "r-old");

        let res = pipeline_cleanup_old_runs(project.to_string_lossy().to_string(), 0).unwrap();
        assert_eq!(res.removed_records, 0);
        assert!(project.join(".terminalx/pipeline-runs/r-old.json").exists());
    }

    #[test]
    fn cleanup_command_validates_path_arg() {
        let res = pipeline_cleanup_old_runs("\0bad".into(), 30);
        assert!(res.is_err());
    }

    #[test]
    fn cleanup_falls_back_to_started_at_when_ended_at_missing() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // Pre-Phase-3 record has no `endedAt` — fall back to `startedAt`.
        let runs = project.join(".terminalx/pipeline-runs");
        fs::create_dir_all(&runs).unwrap();
        fs::write(
            runs.join("r-old.json"),
            r#"{"id":"r-old","state":"done","startedAt":100}"#,
        )
        .unwrap();

        let res = cleanup_inner(project, 500);
        assert_eq!(res.removed_records, 1);
    }
}
