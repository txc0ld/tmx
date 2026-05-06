//! `pipeline_merger_run` — open a PR (`gh pr create`) when a GitHub remote is
//! detected, or fall back to a local `git switch <main> && git merge --no-ff
//! <branch>`. Always gated by a one-shot 5-minute confirm-token issued by
//! `pipeline_merger_request_token` so the UI confirm modal (Phase 2c-ii.2) is
//! the only path that can trigger a merge.
//!
//! Design notes:
//! - Runtime errors fold into `MergerResult { status: "failure", ... }` instead
//!   of `Err(_)`, mirroring `verification.rs` so the controller doesn't have
//!   to special-case Result::Err vs structured failure.
//! - The token store is a process-global `OnceLock<Mutex<HashMap<...>>>`. Each
//!   consumption sweeps expired entries, keeping the map tiny without a
//!   background task.
//! - Tests inject mock `gh` / `git` invocations via `MergerBinOverride` —
//!   per-subcommand overrides (`gh_repo_view`, `gh_pr_create`, `git_switch`,
//!   `git_merge`) so a single test run can mix-and-match canned responses.

use super::validate_path_arg;
use crate::commands::git::validate_branch_name;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::process::Command as TokioCommand;

const TOKEN_TTL: Duration = Duration::from_secs(300);
const STDERR_DETAIL_CAP: usize = 1024;

#[derive(Debug, Clone)]
struct TokenEntry {
    run_id: String,
    issued_at: Instant,
}

fn token_store() -> &'static Mutex<HashMap<String, TokenEntry>> {
    static STORE: OnceLock<Mutex<HashMap<String, TokenEntry>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Sweep expired tokens. Called on every consume so the map stays small without
/// a background reaper.
fn gc_tokens(store: &mut HashMap<String, TokenEntry>) {
    store.retain(|_, e| e.issued_at.elapsed() < TOKEN_TTL);
}

/// Issue a fresh confirm-token bound to `run_id`. Returns the token (UUID v4).
/// The caller (UI confirm modal) passes this back via `MergerInput.confirm_token`.
fn issue_token_inner(run_id: String) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    let mut store = token_store().lock();
    gc_tokens(&mut store);
    store.insert(
        token.clone(),
        TokenEntry {
            run_id,
            issued_at: Instant::now(),
        },
    );
    token
}

/// Consume a token: must exist, match `run_id`, and not be older than `TOKEN_TTL`.
/// On success the entry is removed (one-shot). Stale entries are GC'd as a side
/// effect even on failure paths.
fn consume_token(token: &str, run_id: &str) -> bool {
    let mut store = token_store().lock();
    gc_tokens(&mut store);
    match store.get(token) {
        Some(entry) if entry.run_id == run_id && entry.issued_at.elapsed() < TOKEN_TTL => {
            store.remove(token);
            true
        }
        _ => false,
    }
}

#[tauri::command]
pub fn pipeline_merger_request_token(run_id: String) -> Result<String, String> {
    if run_id.is_empty() {
        return Err("empty run_id".into());
    }
    if !run_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("run_id must match [a-zA-Z0-9_-]+".into());
    }
    Ok(issue_token_inner(run_id))
}

#[derive(Debug, Default, Deserialize)]
pub struct MergerBinOverride {
    /// (binary, prefix_args). When set, `gh repo view` is replaced by
    /// `<binary> <prefix_args...>` — original args are dropped so the test can
    /// canned-respond freely.
    pub gh_repo_view: Option<(String, Vec<String>)>,
    pub gh_pr_create: Option<(String, Vec<String>)>,
    pub git_switch: Option<(String, Vec<String>)>,
    pub git_merge: Option<(String, Vec<String>)>,
}

#[derive(Debug, Deserialize)]
pub struct MergerInput {
    pub run_id: String,
    pub project_dir: String,
    pub branch: String,
    pub base_branch: String,
    pub confirm_token: String,
    /// Test-only: inject mock invocations. `#[serde(skip)]` so frontend callers
    /// can never set it through IPC.
    #[serde(skip)]
    pub bin_override: Option<MergerBinOverride>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergerResult {
    pub status: String, // "success" | "failure" | "invalid_token"
    pub mode: String,   // "pr" | "local" | "unknown"
    pub pr_url: Option<String>,
    pub detail: String,
}

fn fail(mode: &str, detail: impl Into<String>) -> MergerResult {
    MergerResult {
        status: "failure".into(),
        mode: mode.into(),
        pr_url: None,
        detail: detail.into(),
    }
}

fn invalid_token(detail: impl Into<String>) -> MergerResult {
    MergerResult {
        status: "invalid_token".into(),
        mode: "unknown".into(),
        pr_url: None,
        detail: detail.into(),
    }
}

/// Trim stderr (lossy UTF-8) to `STDERR_DETAIL_CAP` at a char boundary.
fn trim_stderr(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes).trim().to_string();
    if s.len() <= STDERR_DETAIL_CAP {
        return s;
    }
    let mut end = STDERR_DETAIL_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Run a command (with optional override) in `project_dir`, return (success, stdout, stderr).
async fn run_cmd(
    default_bin: &str,
    default_args: &[&str],
    override_: &Option<(String, Vec<String>)>,
    project_dir: &str,
) -> Result<(bool, String, String), String> {
    let (bin, args): (String, Vec<String>) = match override_ {
        Some((b, prefix)) => (b.clone(), prefix.clone()),
        None => (
            default_bin.to_string(),
            default_args.iter().map(|s| s.to_string()).collect(),
        ),
    };

    let mut cmd = TokioCommand::new(&bin);
    cmd.args(&args);
    cmd.current_dir(project_dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);

    let child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("wait {bin}: {e}"))?;

    Ok((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// Detect a GitHub remote via `gh repo view --json owner,name`. Returns true
/// when the command exits 0 AND stdout parses as JSON containing both
/// `owner.login` and `name`. Anything less → assume no remote → local mode.
async fn detect_gh_remote(
    override_: &Option<(String, Vec<String>)>,
    project_dir: &str,
) -> bool {
    let res = run_cmd(
        "gh",
        &["repo", "view", "--json", "owner,name"],
        override_,
        project_dir,
    )
    .await;
    let Ok((ok, stdout, _stderr)) = res else {
        return false;
    };
    if !ok {
        return false;
    }
    // Permissive JSON parse — gh's output may include extra fields; we only
    // care that both `owner.login` and `name` exist.
    let val: serde_json::Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let owner_login = val
        .get("owner")
        .and_then(|o| o.get("login"))
        .and_then(|n| n.as_str());
    let name = val.get("name").and_then(|n| n.as_str());
    matches!((owner_login, name), (Some(_), Some(_)))
}

pub async fn run_merger_inner(input: MergerInput) -> MergerResult {
    // ── Token gate ─────────────────────────────────────────────
    if !consume_token(&input.confirm_token, &input.run_id) {
        return invalid_token("confirm_token missing, expired, or run_id mismatch");
    }

    // ── Argument validation (post-token so a malformed call still consumes
    //    the token — prevents a probing caller from learning whether a token
    //    is valid by varying inputs).
    if let Err(e) = validate_path_arg(&input.project_dir) {
        return fail("unknown", format!("invalid project_dir: {e}"));
    }
    if let Err(e) = validate_branch_name(&input.branch) {
        return fail("unknown", format!("invalid branch: {e}"));
    }
    if let Err(e) = validate_branch_name(&input.base_branch) {
        return fail("unknown", format!("invalid base_branch: {e}"));
    }

    let bin_override = input.bin_override.unwrap_or_default();

    // ── Mode detection ─────────────────────────────────────────
    let is_pr_mode = detect_gh_remote(&bin_override.gh_repo_view, &input.project_dir).await;

    if is_pr_mode {
        // PR mode: gh pr create --base <base> --head <branch> --title <auto> --body <auto>
        let title = format!("Merge {} into {}", input.branch, input.base_branch);
        let body = format!(
            "Auto-generated by TerminalX agentic pipeline.\n\nMerging `{}` into `{}`.",
            input.branch, input.base_branch
        );
        let res = run_cmd(
            "gh",
            &[
                "pr",
                "create",
                "--base",
                &input.base_branch,
                "--head",
                &input.branch,
                "--title",
                &title,
                "--body",
                &body,
            ],
            &bin_override.gh_pr_create,
            &input.project_dir,
        )
        .await;
        return match res {
            Ok((true, stdout, _)) => MergerResult {
                status: "success".into(),
                mode: "pr".into(),
                pr_url: Some(stdout.trim().to_string()),
                detail: format!("opened PR for {} → {}", input.branch, input.base_branch),
            },
            Ok((false, _, stderr)) => fail("pr", format!("gh pr create failed: {}", trim_stderr(stderr.as_bytes()))),
            Err(e) => fail("pr", e),
        };
    }

    // ── Local mode: git switch + git merge --no-ff ─────────────
    let switch_res = run_cmd(
        "git",
        &["switch", &input.base_branch],
        &bin_override.git_switch,
        &input.project_dir,
    )
    .await;
    match switch_res {
        Ok((true, _, _)) => {}
        Ok((false, _, stderr)) => {
            return fail("local", format!("git switch failed: {}", trim_stderr(stderr.as_bytes())));
        }
        Err(e) => return fail("local", e),
    }

    let merge_msg = format!("merge {} into {}", input.branch, input.base_branch);
    let merge_res = run_cmd(
        "git",
        &["merge", "--no-ff", &input.branch, "-m", &merge_msg],
        &bin_override.git_merge,
        &input.project_dir,
    )
    .await;
    match merge_res {
        Ok((true, _, _)) => MergerResult {
            status: "success".into(),
            mode: "local".into(),
            pr_url: None,
            detail: format!("merged into {}", input.base_branch),
        },
        Ok((false, _, stderr)) => fail("local", format!("git merge failed: {}", trim_stderr(stderr.as_bytes()))),
        Err(e) => fail("local", e),
    }
}

#[tauri::command]
pub async fn pipeline_merger_run(input: MergerInput) -> Result<MergerResult, String> {
    Ok(run_merger_inner(input).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test helper — directly stuff a token entry with a specific issued_at so
    // we can simulate expiry without sleeping for 5 minutes.
    fn insert_token_with_age(token: &str, run_id: &str, age: Duration) {
        let mut store = token_store().lock();
        store.insert(
            token.into(),
            TokenEntry {
                run_id: run_id.into(),
                issued_at: Instant::now() - age,
            },
        );
    }

    fn make_input(
        run_id: &str,
        token: &str,
        project_dir: &str,
        bin_override: MergerBinOverride,
    ) -> MergerInput {
        MergerInput {
            run_id: run_id.into(),
            project_dir: project_dir.into(),
            branch: "feat/test-branch".into(),
            base_branch: "main".into(),
            confirm_token: token.into(),
            bin_override: Some(bin_override),
        }
    }

    // ── Token-gate tests (no shell required) ──────────────────

    #[tokio::test]
    async fn invalid_token_when_no_token_issued() {
        let input = make_input("run-aaa1", "nonexistent-token", "/tmp", MergerBinOverride::default());
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "invalid_token");
        assert_eq!(res.mode, "unknown");
        assert!(res.pr_url.is_none());
    }

    #[tokio::test]
    async fn invalid_token_when_wrong_run_id() {
        let token = issue_token_inner("run-correct".into());
        let input = make_input("run-different", &token, "/tmp", MergerBinOverride::default());
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "invalid_token");
        // Token should still be in store (we didn't consume on mismatch — the
        // legitimate caller might still come through with the right run_id).
        assert!(token_store().lock().contains_key(&token));
        // Cleanup
        token_store().lock().remove(&token);
    }

    #[tokio::test]
    async fn invalid_token_when_expired_and_gc_runs() {
        let token = "expired-token-zzz".to_string();
        insert_token_with_age(&token, "run-expired", Duration::from_secs(400));
        let input = make_input("run-expired", &token, "/tmp", MergerBinOverride::default());
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "invalid_token");
        // GC sweeps expired entries on every consume.
        assert!(!token_store().lock().contains_key(&token));
    }

    #[test]
    fn issue_token_rejects_bad_run_id() {
        assert!(pipeline_merger_request_token("".into()).is_err());
        assert!(pipeline_merger_request_token("bad id with spaces".into()).is_err());
        assert!(pipeline_merger_request_token("ok-id_123".into()).is_ok());
    }

    // ── Behavioral tests (Unix-only — bin_override uses /bin/sh) ──

    #[cfg(unix)]
    fn sh(script: &str) -> Option<(String, Vec<String>)> {
        Some(("/bin/sh".into(), vec!["-c".into(), script.into()]))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_mode_success_when_no_gh_remote() {
        let token = issue_token_inner("run-local-ok".into());
        let input = make_input(
            "run-local-ok",
            &token,
            "/tmp",
            MergerBinOverride {
                gh_repo_view: sh("exit 1"),       // no GH remote
                gh_pr_create: None,
                git_switch: sh("exit 0"),          // clean switch
                git_merge: sh("echo merged && exit 0"),
            },
        );
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "success", "detail: {}", res.detail);
        assert_eq!(res.mode, "local");
        assert!(res.pr_url.is_none());
        assert!(res.detail.contains("main"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pr_mode_success_when_gh_remote_present() {
        let token = issue_token_inner("run-pr-ok".into());
        let input = make_input(
            "run-pr-ok",
            &token,
            "/tmp",
            MergerBinOverride {
                gh_repo_view: sh(r#"echo '{"owner":{"login":"acme"},"name":"repo"}' && exit 0"#),
                gh_pr_create: sh("echo https://github.com/acme/repo/pull/42 && exit 0"),
                git_switch: None,
                git_merge: None,
            },
        );
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "success", "detail: {}", res.detail);
        assert_eq!(res.mode, "pr");
        assert_eq!(
            res.pr_url.as_deref(),
            Some("https://github.com/acme/repo/pull/42")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_mode_failure_propagates_stderr() {
        let token = issue_token_inner("run-local-fail".into());
        let input = make_input(
            "run-local-fail",
            &token,
            "/tmp",
            MergerBinOverride {
                gh_repo_view: sh("exit 1"),
                gh_pr_create: None,
                git_switch: sh("exit 0"),
                git_merge: sh("echo 'CONFLICT (content)' 1>&2 && exit 1"),
            },
        );
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "failure");
        assert_eq!(res.mode, "local");
        assert!(
            res.detail.contains("CONFLICT") || res.detail.contains("git merge failed"),
            "detail missing stderr: {}",
            res.detail
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn token_consumed_on_success_blocks_replay() {
        let token = issue_token_inner("run-replay".into());
        let input1 = make_input(
            "run-replay",
            &token,
            "/tmp",
            MergerBinOverride {
                gh_repo_view: sh("exit 1"),
                gh_pr_create: None,
                git_switch: sh("exit 0"),
                git_merge: sh("exit 0"),
            },
        );
        let res1 = run_merger_inner(input1).await;
        assert_eq!(res1.status, "success");

        // Replay the same token — should be invalid_token.
        let input2 = make_input(
            "run-replay",
            &token,
            "/tmp",
            MergerBinOverride::default(),
        );
        let res2 = run_merger_inner(input2).await;
        assert_eq!(res2.status, "invalid_token");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_branch_name_rejected_after_token_consume() {
        let token = issue_token_inner("run-badbranch".into());
        let input = MergerInput {
            run_id: "run-badbranch".into(),
            project_dir: "/tmp".into(),
            branch: "bad branch with spaces".into(),
            base_branch: "main".into(),
            confirm_token: token.clone(),
            bin_override: Some(MergerBinOverride::default()),
        };
        let res = run_merger_inner(input).await;
        assert_eq!(res.status, "failure");
        assert!(res.detail.contains("invalid branch"), "detail: {}", res.detail);
        // Token was consumed (validation happens post-token to prevent probing).
        assert!(!token_store().lock().contains_key(&token));
    }

    #[test]
    fn trim_stderr_truncates_at_char_boundary() {
        let big = format!("{}{}", "x".repeat(1023), "🎉");
        let out = trim_stderr(big.as_bytes());
        // 1023 ascii + 4-byte emoji = 1027 bytes total > 1024
        assert!(out.ends_with('…'));
        assert!(out.len() <= STDERR_DETAIL_CAP + 4); // ellipsis is 3 bytes UTF-8
    }
}
