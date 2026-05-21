//! `pipeline_telemetry_log` — JSONL append-only log per pipeline run.
//!
//! Every line is run through `secrets_mask::mask_secrets` before write so
//! the on-disk telemetry can never leak a token / PEM / high-entropy env
//! value. This is defense-in-depth: the frontend already calls
//! `secretsMask` for explicit cases (failure bundle, webhook), but the
//! telemetry path here also masks so a forgotten call site can't leak.

use super::validate_path_arg;
use crate::commands::secrets_mask::mask_secrets;
use std::path::Path;

/// Maximum size of a single `<runId>.jsonl` telemetry file before rotation.
/// On reaching this threshold the existing file is renamed to
/// `<runId>.jsonl.1` (overwriting any prior rotation) and a fresh
/// `<runId>.jsonl` is started. Long-running pipelines + heartbeats can
/// otherwise produce unbounded files; 5 MB keeps individual runs bounded
/// while still leaving room for thousands of state-change lines.
const TELEMETRY_MAX_BYTES: u64 = 5 * 1024 * 1024;

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

/// If `path` exists and is at-or-above `cap_bytes`, rename it to
/// `<path>.1` (overwriting any existing `.1`). Idempotent + cheap when
/// the file is below cap (single `metadata` syscall). Single-rotation
/// only — older `.1` data is intentionally discarded so a pathological
/// run can't fill the disk via unbounded rotated history.
fn rotate_if_needed(path: &Path, cap_bytes: u64) -> Result<(), String> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("stat {}: {e}", path.display())),
    };
    if meta.len() < cap_bytes {
        return Ok(());
    }
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    let rotated_path = std::path::PathBuf::from(rotated);
    // `rename` overwrites the destination atomically on both Unix and
    // Windows (Rust std normalizes Windows behavior to POSIX semantics).
    std::fs::rename(path, &rotated_path)
        .map_err(|e| format!("rotate {} -> {}: {e}", path.display(), rotated_path.display()))?;
    Ok(())
}

fn telemetry_log_inner(project_dir: &Path, run_id: &str, line: &str) -> Result<(), String> {
    telemetry_log_with_cap(project_dir, run_id, line, TELEMETRY_MAX_BYTES)
}

fn telemetry_log_with_cap(
    project_dir: &Path,
    run_id: &str,
    line: &str,
    cap_bytes: u64,
) -> Result<(), String> {
    validate_run_id(run_id)?;
    if line.contains('\n') {
        return Err("telemetry line may not contain newlines".into());
    }

    // Mask secrets BEFORE write. `mask_secrets` is idempotent so frontend
    // callers that already masked won't double-encode.
    let masked = mask_secrets(line);
    if masked.contains('\n') {
        // Belt-and-suspenders: masking shouldn't introduce newlines (PEM
        // collapses to a single token, hashes are 6-char). If somehow
        // the mask introduced one, refuse.
        return Err("masked telemetry line contains newline".into());
    }

    let dir = project_dir.join(".terminalx/pipeline-telemetry");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create dir: {e}"))?;

    let path = dir.join(format!("{run_id}.jsonl"));
    rotate_if_needed(&path, cap_bytes)?;

    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    f.write_all(masked.as_bytes()).map_err(|e| format!("write: {e}"))?;
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

    #[test]
    fn telemetry_log_appends_in_place_below_cap() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // 1KB cap — well above the line size, so no rotation.
        telemetry_log_with_cap(project, "r-cap", r#"{"at":1}"#, 1024).unwrap();
        telemetry_log_with_cap(project, "r-cap", r#"{"at":2}"#, 1024).unwrap();

        let f = project.join(".terminalx/pipeline-telemetry/r-cap.jsonl");
        let rotated = project.join(".terminalx/pipeline-telemetry/r-cap.jsonl.1");
        assert!(f.exists());
        assert!(!rotated.exists(), "should not rotate below cap");
        let lines: Vec<String> = fs::read_to_string(&f).unwrap().lines().map(String::from).collect();
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn telemetry_log_rotates_at_or_above_cap() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let f = project.join(".terminalx/pipeline-telemetry/r-rot.jsonl");
        let rotated = project.join(".terminalx/pipeline-telemetry/r-rot.jsonl.1");

        // First write seeds the file with content >= the tiny cap so
        // the NEXT write triggers rotation. `{"at":1}` + '\n' = 9 bytes.
        telemetry_log_with_cap(project, "r-rot", r#"{"at":1}"#, 1024).unwrap();
        // Cap of 8 bytes: file is now 9 bytes >= 8, so the next call
        // should rotate the existing file and start fresh.
        telemetry_log_with_cap(project, "r-rot", r#"{"at":2}"#, 8).unwrap();

        assert!(f.exists(), ".jsonl should exist after rotation");
        assert!(rotated.exists(), ".jsonl.1 should exist after rotation");

        let current = fs::read_to_string(&f).unwrap();
        let archived = fs::read_to_string(&rotated).unwrap();
        assert!(current.contains(r#""at":2"#), "fresh file should hold the new line");
        assert!(!current.contains(r#""at":1"#), "fresh file should not hold pre-rotation lines");
        assert!(archived.contains(r#""at":1"#), "rotated file should hold the pre-rotation line");
    }

    #[test]
    fn telemetry_log_rotation_uses_jsonl_dot_one_naming() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let tdir = project.join(".terminalx/pipeline-telemetry");

        telemetry_log_with_cap(project, "r-name", r#"{"at":1}"#, 1024).unwrap();
        telemetry_log_with_cap(project, "r-name", r#"{"at":2}"#, 8).unwrap();

        // Only `.jsonl` and `.jsonl.1` should exist — no `.2`, `.bak`,
        // timestamped files, etc.
        let mut names: Vec<String> = fs::read_dir(&tdir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["r-name.jsonl".to_string(), "r-name.jsonl.1".to_string()]);
    }

    #[test]
    fn telemetry_log_multiple_rotations_keep_only_one_archive() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let tdir = project.join(".terminalx/pipeline-telemetry");
        let f = project.join(".terminalx/pipeline-telemetry/r-multi.jsonl");
        let rotated = project.join(".terminalx/pipeline-telemetry/r-multi.jsonl.1");

        // Force three rotations in a row using a tiny cap. Each call
        // (after the first) renames the prior file → .jsonl.1, so the
        // OLD .jsonl.1 is overwritten — single-rotation invariant.
        telemetry_log_with_cap(project, "r-multi", r#"{"at":1}"#, 1024).unwrap();
        telemetry_log_with_cap(project, "r-multi", r#"{"at":2}"#, 8).unwrap();
        telemetry_log_with_cap(project, "r-multi", r#"{"at":3}"#, 8).unwrap();
        telemetry_log_with_cap(project, "r-multi", r#"{"at":4}"#, 8).unwrap();

        // Directory contains exactly two files.
        let names: Vec<String> = fs::read_dir(&tdir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 2, "should never accumulate more than two telemetry files: {names:?}");
        assert!(f.exists());
        assert!(rotated.exists());

        // The current archive should hold the immediately-prior line
        // (at=3), proving the old .1 (which held at=2) was overwritten.
        let archived = fs::read_to_string(&rotated).unwrap();
        assert!(archived.contains(r#""at":3"#), "archive should hold most recent rotation: {archived}");
        assert!(!archived.contains(r#""at":2"#), "archive should have overwritten older rotation: {archived}");
        let current = fs::read_to_string(&f).unwrap();
        assert!(current.contains(r#""at":4"#));
    }

    #[test]
    fn telemetry_log_masks_secrets_before_write() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let line = r#"{"at":1,"event":"state_change","note":"OPENAI_API_KEY=sk-abc123XYZ_ZZZ-456789defghi"}"#;

        telemetry_log_inner(project, "r-mask", line).unwrap();

        let f = project.join(".terminalx/pipeline-telemetry/r-mask.jsonl");
        let contents = fs::read_to_string(&f).unwrap();
        assert!(
            !contents.contains("sk-abc123XYZ_ZZZ-456789defghi"),
            "secret leaked into telemetry: {contents}"
        );
        assert!(contents.contains("<MASKED:"), "no mask token in telemetry: {contents}");
    }
}
