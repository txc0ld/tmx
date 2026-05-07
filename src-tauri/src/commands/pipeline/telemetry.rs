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
