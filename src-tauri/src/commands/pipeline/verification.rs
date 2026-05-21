//! `pipeline_run_verification_step` — single CI hook executor (Phase 2c-i).
//!
//! Single Rust command runs one verification step (format/lint/typecheck/test)
//! via `tokio::process::Command` in the worktree dir. Output is truncated to
//! 8KB at a UTF-8 char boundary (with a trailing marker), so the controller can
//! surface failures without dragging the full build log across the IPC bus.
//!
//! The TS controller (`src/pipeline/verification-chain.ts`) calls this once per
//! resolved `Step`, so this IPC stays single-shot — no batching, no streaming.
//! Spawn errors / timeouts are folded into `status: "fail"` instead of `Err(_)`
//! so the caller doesn't need to special-case Result.Err vs exit-code-fail.

use super::validate_path_arg;
use serde::{Deserialize, Serialize};
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration as TokioDuration};

const VERIFICATION_OUTPUT_CAP: usize = 8 * 1024;
const VERIFICATION_TRUNC_MARKER: &str = "\n[output truncated at 8KB]";

fn default_step_timeout() -> u64 {
    600
}

#[derive(Debug, Deserialize)]
pub struct VerificationStepInput {
    pub worktree_dir: String,
    /// Single shell command (e.g. "npm run lint", "cargo test"). Invoked via
    /// `/bin/sh -c <command>` on Unix and `cmd.exe /C <command>` on Windows so
    /// shell builtins, pipes, and `&&` behave the way users wrote them.
    pub command: String,
    /// Pass-through tag for telemetry / TS controller. One of
    /// 'format'|'lint'|'typecheck'|'test'.
    pub kind: String,
    #[serde(default = "default_step_timeout")]
    pub timeout_secs: u64,
    /// Test-only: inject an alternate shell invocation (e.g. ("/bin/sh", ["-c"])).
    /// Skipped from JSON so the IPC surface can never be tricked into running
    /// a non-shell binary from the frontend.
    #[serde(skip)]
    pub shell_override: Option<(String, Vec<String>)>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VerificationStepResult {
    pub status: String, // "pass" | "fail"
    pub kind: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output: String,
    pub timed_out: bool,
}

/// UTF-8-safe truncation. Mirrors `docker.rs::truncate` — naive `s[..n]` will
/// panic when `n` lands inside a multi-byte char.
fn truncate_at_char_boundary(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + VERIFICATION_TRUNC_MARKER.len());
    out.push_str(&s[..end]);
    out.push_str(VERIFICATION_TRUNC_MARKER);
    out
}

fn validate_command(cmd: &str) -> Result<(), String> {
    if cmd.is_empty() {
        return Err("empty command".into());
    }
    if cmd.len() > 16 * 1024 {
        return Err("command too long (>16KB)".into());
    }
    if cmd.contains('\0') {
        return Err("command contains null byte".into());
    }
    if cmd.contains('\n') || cmd.contains('\r') {
        return Err("command contains newline".into());
    }
    Ok(())
}

/// Resolve the (binary, leading-args) tuple for the host shell. Unix → `sh -c`,
/// Windows → `cmd.exe /C`. The override hook lets tests pin an exact invocation.
fn resolve_shell(override_: &Option<(String, Vec<String>)>) -> (String, Vec<String>) {
    if let Some((bin, args)) = override_ {
        return (bin.clone(), args.clone());
    }
    #[cfg(windows)]
    {
        ("cmd.exe".to_string(), vec!["/C".to_string()])
    }
    #[cfg(not(windows))]
    {
        ("/bin/sh".to_string(), vec!["-c".to_string()])
    }
}

pub async fn run_verification_step_inner(input: VerificationStepInput) -> VerificationStepResult {
    let started = std::time::Instant::now();
    let kind = input.kind.clone();

    // Validate inputs; bail with a structured failure rather than Err so the
    // caller can render a useful message in the controller-tile timeline.
    if let Err(e) = validate_path_arg(&input.worktree_dir) {
        return VerificationStepResult {
            status: "fail".into(),
            kind,
            exit_code: None,
            duration_ms: 0,
            output: format!("[invalid worktree_dir: {e}]"),
            timed_out: false,
        };
    }
    if let Err(e) = validate_command(&input.command) {
        return VerificationStepResult {
            status: "fail".into(),
            kind,
            exit_code: None,
            duration_ms: 0,
            output: format!("[invalid command: {e}]"),
            timed_out: false,
        };
    }

    let (shell_bin, shell_args) = resolve_shell(&input.shell_override);

    let mut cmd = TokioCommand::new(&shell_bin);
    cmd.args(&shell_args);
    cmd.arg(&input.command);
    cmd.current_dir(&input.worktree_dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Without kill_on_drop, a timed-out subprocess keeps running after
    // tokio::time::timeout cancels the wait_with_output future.
    cmd.kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            return VerificationStepResult {
                status: "fail".into(),
                kind,
                exit_code: None,
                duration_ms,
                output: format!("[spawn {shell_bin}: {e}]"),
                timed_out: false,
            };
        }
    };

    let wait = child.wait_with_output();
    let res = timeout(TokioDuration::from_secs(input.timeout_secs), wait).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match res {
        Ok(Ok(out)) => {
            // Combine stdout + stderr; stderr first only if stdout is empty,
            // otherwise stdout-then-stderr so the typical happy path (where
            // stderr is just warnings) reads naturally.
            let mut combined = String::new();
            combined.push_str(&String::from_utf8_lossy(&out.stdout));
            if !out.stderr.is_empty() {
                if !combined.is_empty() && !combined.ends_with('\n') {
                    combined.push('\n');
                }
                combined.push_str(&String::from_utf8_lossy(&out.stderr));
            }
            let output = truncate_at_char_boundary(&combined, VERIFICATION_OUTPUT_CAP);
            let exit_code = out.status.code();
            let status = if exit_code == Some(0) { "pass" } else { "fail" };
            VerificationStepResult {
                status: status.into(),
                kind,
                exit_code,
                duration_ms,
                output,
                timed_out: false,
            }
        }
        Ok(Err(e)) => VerificationStepResult {
            status: "fail".into(),
            kind,
            exit_code: None,
            duration_ms,
            output: format!("[wait child: {e}]"),
            timed_out: false,
        },
        Err(_) => VerificationStepResult {
            status: "fail".into(),
            kind,
            exit_code: None,
            duration_ms,
            output: "[step timed out]".into(),
            timed_out: true,
        },
    }
}

#[tauri::command]
pub async fn pipeline_run_verification_step(
    input: VerificationStepInput,
) -> Result<VerificationStepResult, String> {
    Ok(run_verification_step_inner(input).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use tempfile::tempdir;

    // ── Verification step runner tests (Phase 2c-i.2) ──────────
    // Unix-gated: tests invoke `/bin/sh` directly so they don't need to know
    // about the Windows `cmd.exe` shell-resolution branch. Windows shell
    // selection is exercised at the integration layer in Phase 2c-iii.

    #[cfg(unix)]
    fn unix_shell_override() -> Option<(String, Vec<String>)> {
        Some(("/bin/sh".into(), vec!["-c".into()]))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_pass_case() {
        let dir = tempdir().unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "exit 0".into(),
            kind: "test".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "pass");
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.timed_out);
        assert_eq!(res.kind, "test");
        assert!(
            res.output.is_empty(),
            "expected empty output, got {:?}",
            res.output
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_fail_case() {
        let dir = tempdir().unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "exit 7".into(),
            kind: "lint".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "fail");
        assert_eq!(res.exit_code, Some(7));
        assert!(!res.timed_out);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_captures_stdout_and_stderr() {
        let dir = tempdir().unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "echo hello && echo err 1>&2".into(),
            kind: "format".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "pass");
        assert!(
            res.output.contains("hello"),
            "missing stdout: {:?}",
            res.output
        );
        assert!(
            res.output.contains("err"),
            "missing stderr: {:?}",
            res.output
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_truncates_oversized_output() {
        let dir = tempdir().unwrap();
        // `yes` emits "y\n" forever; `head -c 20000` caps it deterministically
        // at ~20KB without reaching for /dev/urandom (which can vary between
        // platforms in subtle ways and isn't strictly needed here).
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "yes | head -c 20000".into(),
            kind: "test".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "pass");
        let max = VERIFICATION_OUTPUT_CAP + VERIFICATION_TRUNC_MARKER.len();
        assert!(
            res.output.len() <= max,
            "output {} exceeds cap {}",
            res.output.len(),
            max
        );
        assert!(
            res.output.ends_with(VERIFICATION_TRUNC_MARKER),
            "missing truncation marker; tail: {:?}",
            &res.output[res.output.len().saturating_sub(64)..]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_times_out() {
        let started = std::time::Instant::now();
        let dir = tempdir().unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "sleep 5".into(),
            kind: "test".into(),
            timeout_secs: 1,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "fail");
        assert!(res.timed_out);
        assert!(res.exit_code.is_none());
        // Tolerant upper bound — CI under load can lag — but should never
        // approach the original 5-second sleep.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(4),
            "elapsed {:?} too close to original sleep",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_runs_in_worktree_dir() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("marker.txt"), "ok").unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "ls marker.txt".into(),
            kind: "test".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "pass", "output: {:?}", res.output);
        assert!(res.output.contains("marker.txt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verification_step_rejects_invalid_command() {
        let dir = tempdir().unwrap();
        let res = run_verification_step_inner(VerificationStepInput {
            worktree_dir: dir.path().to_string_lossy().to_string(),
            command: "echo line1\nrm -rf bad".into(),
            kind: "test".into(),
            timeout_secs: 5,
            shell_override: unix_shell_override(),
        })
        .await;
        assert_eq!(res.status, "fail");
        assert!(res.output.contains("invalid command"));
        assert!(res.exit_code.is_none());
    }

    #[test]
    fn truncate_at_char_boundary_handles_multibyte() {
        // Emoji ahead of the cap — naive slicing would panic.
        let s = format!("{}{}", "a".repeat(8190), "🎉");
        let out = truncate_at_char_boundary(&s, VERIFICATION_OUTPUT_CAP);
        // 8190 ascii + 4-byte emoji = 8194 bytes total, exceeds 8192.
        assert!(out.ends_with(VERIFICATION_TRUNC_MARKER));
        assert!(out.len() <= VERIFICATION_OUTPUT_CAP + VERIFICATION_TRUNC_MARKER.len());
    }
}
