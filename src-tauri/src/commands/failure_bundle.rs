//! Failure-bundle generator (Phase 2c-iii.7).
//!
//! On terminal-failure transitions (`failed` / `escalated`) the frontend
//! invokes `pipeline_failure_bundle_generate` to write a single-file
//! diagnostic archive at:
//!
//!     <project_dir>/.terminalx/failure-bundles/<run-id>.tar.gz
//!
//! The archive contains six text artifacts, every one of which is run
//! through `secrets_mask::mask_secrets` BEFORE being written into the
//! tarball:
//!
//!   - `telemetry.jsonl` — copy of the existing
//!     `.terminalx/pipeline-telemetry/<run-id>.jsonl` (already masked at
//!     write time; pass through `mask_secrets` again — idempotent).
//!   - `artifacts.json`  — frontend-provided JSON of `run.artifacts`.
//!   - `preflight.json`  — frontend-provided JSON of the most recent
//!     `PreflightResult`.
//!   - `git_status.txt`  — `git status --porcelain` from `project_dir`.
//!   - `git_diff.txt`    — `git diff <base_branch>..HEAD` capped at 5MB.
//!   - `versions.txt`    — TerminalX + claude + codex CLI versions plus
//!     any best-effort warnings from the git invocations.
//!
//! Path-traversal attack surface
//! ─────────────────────────────
//! The only filename component derived from input is `<run_id>`. We
//! validate it against the same `[A-Za-z0-9_-]+` whitelist used by the
//! telemetry path, with explicit rejection of `..` / `/` / `\` / control
//! chars. `project_dir` is NOT joined with any user-controlled path
//! segment beyond `.terminalx/failure-bundles/<run_id>.tar.gz`, so an
//! attacker who controls the run id still can't escape into a parent dir.
//! `branch` and `base_branch` flow only into `git diff` argv (not the
//! filesystem); they're rejected if they contain ASCII control characters
//! or shell-metacharacter footguns.

use crate::commands::secrets_mask::mask_secrets;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 5 MB cap on the captured `git diff` output. A diff bigger than this
/// usually means something has gone wrong (bulk renames, accidental
/// vendored-dir rewrite, generated artifacts) and is not useful for
/// post-mortem anyway. The cap also keeps the bundle small enough to
/// attach to a GitHub issue.
const MAX_DIFF_BYTES: usize = 5 * 1024 * 1024;

/// 256-byte cap on the captured `git status --porcelain` output is too
/// tight; 1MB is plenty (porcelain is one line per changed file). The cap
/// exists only to prevent a runaway repo from inflating the bundle.
const MAX_STATUS_BYTES: usize = 1 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct FailureBundleInput {
    pub project_dir: String,
    pub run_id: String,
    /// Active branch for the run (typically the worktree branch). Used in
    /// the git-diff range fall-back and in `versions.txt` context.
    pub branch: String,
    /// The base branch the run forked from. `git diff <base>..HEAD` runs
    /// in `project_dir` (NOT the worktree) so a project that hasn't yet
    /// merged the worktree branch back can still see the pending diff.
    pub base_branch: String,
    /// Frontend-provided JSON of `run.artifacts`. Already masked
    /// frontend-side via `secretsMask` — we mask again defensively.
    pub artifacts_json: String,
    /// Frontend-provided JSON of the most recent `PreflightResult`. Same
    /// double-mask discipline.
    pub preflight_json: String,
    pub terminalx_version: String,
    pub claude_version: Option<String>,
    pub codex_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FailureBundleResult {
    pub bundle_path: String,
    pub size_bytes: u64,
    /// Names of files inside the archive in deterministic order. Useful for
    /// the frontend's "open in finder" toast and for the cargo tests.
    pub entries: Vec<String>,
}

/// Run-id whitelist mirrors `pipeline_telemetry_log::validate_run_id` —
/// alphanumeric, dash, underscore. The function signature accepts the raw
/// input (so the test surface can drive it) and returns descriptive errors.
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

fn validate_branch_arg(s: &str, name: &str) -> Result<(), String> {
    if s.is_empty() {
        return Err(format!("empty {name}"));
    }
    if s.chars().any(|c| c.is_control()) {
        return Err(format!("{name} contains control characters"));
    }
    // Cheap shell-metacharacter rejection. A branch name like
    // `foo;rm -rf /` would never reach `git diff` argv (we use process
    // argv, not a shell), but rejecting it keeps the surface narrow and
    // catches operator typos that would confuse git.
    if s.chars().any(|c| matches!(c, ';' | '|' | '&' | '`' | '$' | '\n' | '\r')) {
        return Err(format!("{name} contains shell metacharacters"));
    }
    Ok(())
}

/// Truncate `bytes` to at most `cap` bytes, appending an ASCII marker if
/// truncation actually happened. The marker is on a new line so the diff
/// stays grep-able. Operates on bytes (not chars) because git diff output
/// can contain non-UTF-8 paths and we want a byte-accurate cap.
fn truncate_with_marker(bytes: &[u8], cap: usize, marker: &str) -> Vec<u8> {
    if bytes.len() <= cap {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(cap + marker.len() + 1);
    out.extend_from_slice(&bytes[..cap]);
    out.push(b'\n');
    out.extend_from_slice(marker.as_bytes());
    out
}

/// Run a git subcommand from `project_dir` and return (stdout_bytes,
/// optional warning string). Nonzero exit → empty stdout + warning. The
/// warning ends up in `versions.txt` so a misbehaving repo (e.g. shallow
/// clone with no merge base) doesn't crash bundle generation.
fn run_git(project_dir: &Path, args: &[&str]) -> (Vec<u8>, Option<String>) {
    let res = Command::new("git").args(args).current_dir(project_dir).output();
    match res {
        Ok(out) if out.status.success() => (out.stdout, None),
        Ok(out) => {
            let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stderr_short: String = stderr.chars().take(500).collect();
            (
                Vec::new(),
                Some(format!(
                    "git {} exited {code}: {stderr_short}",
                    args.join(" ")
                )),
            )
        }
        Err(e) => (
            Vec::new(),
            Some(format!("git {} spawn failed: {e}", args.join(" "))),
        ),
    }
}

/// Read the existing telemetry JSONL for this run. Empty string when the
/// file is absent (a run that hit terminal before any state-change
/// telemetry landed — rare but plausible).
fn read_telemetry_jsonl(project_dir: &Path, run_id: &str) -> String {
    let path = project_dir
        .join(".terminalx")
        .join("pipeline-telemetry")
        .join(format!("{run_id}.jsonl"));
    std::fs::read_to_string(&path).unwrap_or_default()
}

/// Compose the `versions.txt` body. Plain `key: value\n` lines so it stays
/// human-readable when the bundle is opened in a tar viewer.
fn build_versions_txt(
    input: &FailureBundleInput,
    git_status_warn: Option<&str>,
    git_diff_warn: Option<&str>,
) -> String {
    let mut s = String::with_capacity(256);
    s.push_str(&format!("terminalx: {}\n", input.terminalx_version));
    s.push_str(&format!(
        "claude: {}\n",
        input.claude_version.as_deref().unwrap_or("(unknown)")
    ));
    s.push_str(&format!(
        "codex: {}\n",
        input.codex_version.as_deref().unwrap_or("(unknown)")
    ));
    s.push_str(&format!("branch: {}\n", input.branch));
    s.push_str(&format!("base_branch: {}\n", input.base_branch));
    s.push_str(&format!("run_id: {}\n", input.run_id));
    if let Some(w) = git_status_warn {
        s.push_str(&format!("git_status_warning: {w}\n"));
    }
    if let Some(w) = git_diff_warn {
        s.push_str(&format!("git_diff_warning: {w}\n"));
    }
    s
}

/// Append a single byte-blob entry into the tar archive under `name`.
fn append_entry<W: std::io::Write>(
    builder: &mut tar::Builder<W>,
    name: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let mut header = tar::Header::new_gnu();
    header.set_path(name).map_err(|e| format!("set_path {name}: {e}"))?;
    header.set_size(bytes.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    builder
        .append(&header, bytes)
        .map_err(|e| format!("append {name}: {e}"))
}

pub fn generate_bundle_inner(
    input: FailureBundleInput,
) -> Result<FailureBundleResult, String> {
    // ── 1. Validate untrusted inputs that hit the filesystem / argv. ──
    validate_run_id(&input.run_id)?;
    validate_branch_arg(&input.branch, "branch")?;
    validate_branch_arg(&input.base_branch, "base_branch")?;
    if input.project_dir.is_empty() {
        return Err("empty project_dir".into());
    }
    if input.project_dir.chars().any(|c| c.is_control()) {
        return Err("project_dir contains control characters".into());
    }

    let project_dir = PathBuf::from(&input.project_dir);

    // ── 2. Make the bundle dir. ────────────────────────────────────────
    let bundle_dir = project_dir.join(".terminalx").join("failure-bundles");
    std::fs::create_dir_all(&bundle_dir)
        .map_err(|e| format!("create bundle dir {}: {e}", bundle_dir.display()))?;
    let bundle_path = bundle_dir.join(format!("{}.tar.gz", input.run_id));

    // ── 3. Collect artifacts (each masked before going into the tar). ──
    let telemetry_raw = read_telemetry_jsonl(&project_dir, &input.run_id);
    let telemetry_masked = mask_secrets(&telemetry_raw);
    let artifacts_masked = mask_secrets(&input.artifacts_json);
    let preflight_masked = mask_secrets(&input.preflight_json);

    let (status_bytes_raw, status_warn) = run_git(&project_dir, &["status", "--porcelain"]);
    let status_bytes_capped = truncate_with_marker(
        &status_bytes_raw,
        MAX_STATUS_BYTES,
        "[output truncated at 1MB]",
    );
    let status_text_masked = mask_secrets(&String::from_utf8_lossy(&status_bytes_capped));

    let diff_range = format!("{}..HEAD", input.base_branch);
    let (diff_bytes_raw, diff_warn) = run_git(&project_dir, &["diff", &diff_range]);
    let diff_bytes_capped = truncate_with_marker(
        &diff_bytes_raw,
        MAX_DIFF_BYTES,
        "[output truncated at 5MB]",
    );
    let diff_text_masked = mask_secrets(&String::from_utf8_lossy(&diff_bytes_capped));

    let versions_txt = build_versions_txt(
        &input,
        status_warn.as_deref(),
        diff_warn.as_deref(),
    );
    // versions.txt is composed from caller-supplied version strings, which
    // have no business carrying secrets — but we mask defensively.
    let versions_masked = mask_secrets(&versions_txt);

    // ── 4. Build the .tar.gz. ──────────────────────────────────────────
    // Deterministic entry order so callers (and tests) can rely on it.
    let entries_with_bytes: Vec<(&str, &[u8])> = vec![
        ("telemetry.jsonl", telemetry_masked.as_bytes()),
        ("artifacts.json", artifacts_masked.as_bytes()),
        ("preflight.json", preflight_masked.as_bytes()),
        ("git_status.txt", status_text_masked.as_bytes()),
        ("git_diff.txt", diff_text_masked.as_bytes()),
        ("versions.txt", versions_masked.as_bytes()),
    ];
    let entry_names: Vec<String> =
        entries_with_bytes.iter().map(|(n, _)| (*n).to_string()).collect();

    {
        let file = std::fs::File::create(&bundle_path)
            .map_err(|e| format!("create {}: {e}", bundle_path.display()))?;
        let gz = GzEncoder::new(file, Compression::default());
        let mut builder = tar::Builder::new(gz);
        for (name, bytes) in &entries_with_bytes {
            append_entry(&mut builder, name, bytes)?;
        }
        builder.finish().map_err(|e| format!("tar finish: {e}"))?;
        // Drop builder → GzEncoder → File flushes everything.
    }

    let size_bytes = std::fs::metadata(&bundle_path)
        .map_err(|e| format!("stat {}: {e}", bundle_path.display()))?
        .len();

    Ok(FailureBundleResult {
        bundle_path: bundle_path.to_string_lossy().into_owned(),
        size_bytes,
        entries: entry_names,
    })
}

#[tauri::command]
pub fn pipeline_failure_bundle_generate(
    input: FailureBundleInput,
) -> Result<FailureBundleResult, String> {
    generate_bundle_inner(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::collections::HashMap;
    use std::fs;
    use std::io::Read;
    use tempfile::tempdir;

    /// Read all entries from a written bundle into a `name → bytes` map.
    fn read_bundle_entries(path: &Path) -> HashMap<String, Vec<u8>> {
        let f = fs::File::open(path).expect("open bundle");
        let gz = GzDecoder::new(f);
        let mut ar = tar::Archive::new(gz);
        let mut out = HashMap::new();
        for entry in ar.entries().expect("read entries") {
            let mut e = entry.expect("entry");
            let name = e.path().expect("path").to_string_lossy().into_owned();
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).expect("read body");
            out.insert(name, buf);
        }
        out
    }

    fn baseline_input(project_dir: &Path, run_id: &str) -> FailureBundleInput {
        FailureBundleInput {
            project_dir: project_dir.to_string_lossy().into_owned(),
            run_id: run_id.to_string(),
            branch: "feat/x".to_string(),
            base_branch: "main".to_string(),
            artifacts_json: r#"{"plan":null,"builds":[],"reviews":[]}"#.to_string(),
            preflight_json: r#"{"is_git_repo":true,"errors":[]}"#.to_string(),
            terminalx_version: "0.1.0".to_string(),
            claude_version: Some("1.2.3".to_string()),
            codex_version: None,
        }
    }

    #[test]
    fn happy_path_writes_all_six_entries() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // Seed a telemetry JSONL.
        let telemetry_path = project.join(".terminalx/pipeline-telemetry");
        fs::create_dir_all(&telemetry_path).unwrap();
        fs::write(
            telemetry_path.join("r-happy.jsonl"),
            "{\"at\":1,\"event\":\"state_change\"}\n{\"at\":2}\n",
        )
        .unwrap();

        let res =
            generate_bundle_inner(baseline_input(project, "r-happy")).expect("bundle generated");

        assert_eq!(res.entries.len(), 6);
        assert!(res.bundle_path.ends_with("/r-happy.tar.gz") || res.bundle_path.ends_with("\\r-happy.tar.gz"));
        assert!(res.size_bytes > 0);

        let entries = read_bundle_entries(Path::new(&res.bundle_path));
        let expected = ["telemetry.jsonl", "artifacts.json", "preflight.json", "git_status.txt", "git_diff.txt", "versions.txt"];
        for name in &expected {
            assert!(entries.contains_key(*name), "missing {name} in bundle: {:?}", entries.keys().collect::<Vec<_>>());
        }

        // versions.txt must include the supplied version + branch context.
        let versions = String::from_utf8(entries["versions.txt"].clone()).unwrap();
        assert!(versions.contains("terminalx: 0.1.0"));
        assert!(versions.contains("claude: 1.2.3"));
        assert!(versions.contains("codex: (unknown)"));
        assert!(versions.contains("branch: feat/x"));
        assert!(versions.contains("base_branch: main"));
        assert!(versions.contains("run_id: r-happy"));

        // Telemetry JSONL flows through.
        let telem = String::from_utf8(entries["telemetry.jsonl"].clone()).unwrap();
        assert!(telem.contains(r#""event":"state_change""#));
    }

    #[test]
    fn artifacts_json_secrets_get_masked() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let mut input = baseline_input(project, "r-mask");
        // Stuff a real-shaped OpenAI key into the artifacts JSON.
        input.artifacts_json =
            r#"{"plan":{"note":"OPENAI_API_KEY=sk-abc123XYZ_ZZZ-456789defghi handle this"}}"#
                .to_string();

        let res = generate_bundle_inner(input).expect("bundle generated");
        let entries = read_bundle_entries(Path::new(&res.bundle_path));
        let artifacts = String::from_utf8(entries["artifacts.json"].clone()).unwrap();
        assert!(
            !artifacts.contains("sk-abc123XYZ_ZZZ-456789defghi"),
            "secret leaked into artifacts.json: {artifacts}"
        );
        assert!(
            artifacts.contains("<MASKED:"),
            "expected mask token in artifacts.json: {artifacts}"
        );
    }

    #[test]
    fn telemetry_jsonl_secrets_get_masked_again() {
        // Telemetry is masked at write time, but generate_bundle_inner
        // applies mask_secrets defensively. Seed an UNMASKED line (which
        // would never happen in production, but documents the contract:
        // even if the on-disk file leaked, the bundle copy doesn't).
        let dir = tempdir().unwrap();
        let project = dir.path();
        let telemetry_path = project.join(".terminalx/pipeline-telemetry");
        fs::create_dir_all(&telemetry_path).unwrap();
        fs::write(
            telemetry_path.join("r-leak.jsonl"),
            r#"{"raw":"AKIAIOSFODNN7EXAMPLE leaked"}"#,
        )
        .unwrap();

        let res =
            generate_bundle_inner(baseline_input(project, "r-leak")).expect("bundle generated");
        let entries = read_bundle_entries(Path::new(&res.bundle_path));
        let telem = String::from_utf8(entries["telemetry.jsonl"].clone()).unwrap();
        assert!(!telem.contains("AKIAIOSFODNN7EXAMPLE"), "secret leaked: {telem}");
        assert!(telem.contains("<MASKED:"), "no mask: {telem}");
    }

    #[test]
    fn run_id_validation_rejects_path_traversal() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        for bad in &["../escape", "..", "../../etc/passwd", "with/slash", "with\\back", "with space", "weird;ls"] {
            let mut input = baseline_input(project, "placeholder");
            input.run_id = (*bad).to_string();
            let res = generate_bundle_inner(input);
            assert!(res.is_err(), "expected reject for run_id {bad:?}, got {res:?}");
        }
    }

    #[test]
    fn branch_validation_rejects_shell_metacharacters() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let mut input = baseline_input(project, "r-meta");
        input.base_branch = "main;rm -rf /".to_string();
        let res = generate_bundle_inner(input);
        assert!(res.is_err(), "expected reject for base_branch with `;`: {res:?}");
        let err = res.err().unwrap();
        assert!(err.contains("shell metacharacters") || err.contains("control"), "unexpected err: {err}");
    }

    #[test]
    fn bundle_dir_created_when_missing() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // No .terminalx/ at all yet.
        assert!(!project.join(".terminalx").exists());

        let res = generate_bundle_inner(baseline_input(project, "r-fresh"))
            .expect("bundle generated against fresh project");
        assert!(project.join(".terminalx/failure-bundles/r-fresh.tar.gz").exists());
        assert_eq!(res.entries.len(), 6);
    }

    #[test]
    fn missing_telemetry_jsonl_yields_empty_entry_no_error() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        // Do NOT seed a telemetry file — generation must still succeed.
        let res = generate_bundle_inner(baseline_input(project, "r-no-telem"))
            .expect("bundle generated despite missing telemetry");
        let entries = read_bundle_entries(Path::new(&res.bundle_path));
        let telem = entries.get("telemetry.jsonl").expect("telemetry.jsonl entry present");
        // Empty file is fine; what matters is the entry exists.
        assert_eq!(telem.len(), 0, "expected empty telemetry, got {} bytes", telem.len());
    }

    #[test]
    fn diff_truncation_at_5mb_appends_marker() {
        // Test the truncation helper directly — synthesizing a real 5MB
        // git diff inside a unit test is too slow and OS-dependent.
        let blob = vec![b'a'; 6 * 1024 * 1024];
        let out = truncate_with_marker(&blob, MAX_DIFF_BYTES, "[output truncated at 5MB]");
        assert!(out.len() > MAX_DIFF_BYTES);
        let tail = String::from_utf8_lossy(&out[MAX_DIFF_BYTES..]).into_owned();
        assert!(tail.contains("[output truncated at 5MB]"), "missing marker: {tail}");

        // Below the cap → no marker, no copy bloat.
        let small = vec![b'b'; 1024];
        let out_small = truncate_with_marker(&small, MAX_DIFF_BYTES, "[output truncated at 5MB]");
        assert_eq!(out_small.len(), 1024);
        assert!(!String::from_utf8_lossy(&out_small).contains("truncated"));
    }

    #[test]
    fn bundle_is_valid_gzip_plus_tar_with_six_entries() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let res = generate_bundle_inner(baseline_input(project, "r-valid"))
            .expect("bundle generated");

        // Re-open via GzDecoder + tar::Archive — any corruption would
        // surface as a parse error during entries iteration.
        let entries = read_bundle_entries(Path::new(&res.bundle_path));
        assert_eq!(entries.len(), 6);
    }
}
