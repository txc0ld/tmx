use crate::state::app_state::AppState;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentType {
    Claude,
    Codex,
    Gemini,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Spawning,
    Idle,
    Working,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub agent_type: AgentType,
    pub status: AgentStatus,
    pub cwd: String,
    pub pid: Option<u32>,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentStatusChange {
    pub id: String,
    pub status: AgentStatus,
}

/// Resolve the CLI binary name + initial args from an agent_spawn request.
///
/// Pure helper extracted so the args-building logic can be unit-tested
/// without a live Tauri AppHandle / State. The `pipeline_run` flag
/// (Claude only) appends the hardcoded `--dangerously-skip-permissions`
/// flag — see `agent_spawn` doc-comment for the security rationale.
pub(super) fn resolve_spawn_bin_and_args(
    agent_type: &AgentType,
    task: Option<&str>,
    custom_command: Option<&str>,
    pipeline_run: bool,
) -> Result<(String, Vec<String>), String> {
    if let Some(cmd) = custom_command {
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() {
            return Err("Custom command is empty".to_string());
        }
        let bin_name = parts[0];
        if bin_name.contains('/') || bin_name.contains('\\') {
            return Err("Custom command must be a program name, not a path".to_string());
        }
        return Ok((
            bin_name.to_string(),
            parts[1..].iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        ));
    }

    // Validate task doesn't start with '-' (prevents argument injection)
    if let Some(t) = task {
        if t.starts_with('-') {
            return Err("Task cannot start with '-'".to_string());
        }
        if t.len() > 32768 {
            return Err("Task too long (max 32KB)".to_string());
        }
    }

    Ok(match agent_type {
        AgentType::Claude => {
            let mut a: Vec<String> = vec![];
            // Pipeline-spawned Claude bypasses interactive tool-permission
            // prompts; the worktree boundary + guardrails hook + per-role
            // capabilities lists are the safety net.
            if pipeline_run {
                a.push("--dangerously-skip-permissions".to_string());
            }
            if let Some(t) = task {
                a.push("-p".to_string());
                a.push(t.to_string());
            }
            ("claude".to_string(), a)
        }
        AgentType::Codex => {
            // Codex / Gemini equivalent flags are not hardcoded yet — the CLI
            // surface for unattended runs is still in flux. Pipeline runs
            // targeting non-Claude providers will continue to hit any
            // interactive prompts the upstream CLI throws; revisit when
            // dogfooding the Codex / Gemini roles.
            let mut a: Vec<String> = vec![];
            if let Some(t) = task {
                a.push(t.to_string());
            }
            ("codex".to_string(), a)
        }
        AgentType::Gemini => {
            let mut a: Vec<String> = vec![];
            if let Some(t) = task {
                a.push(t.to_string());
            }
            ("gemini".to_string(), a)
        }
    })
}

/// Spawn an AI agent CLI process
///
/// `pipeline_run` (default false): when true AND `agent_type` is Claude, the
/// hardcoded `--dangerously-skip-permissions` flag is appended to the args
/// list so pipeline-spawned Claude Code processes don't hit the interactive
/// "Do you want to proceed?" tool-permission prompt on every `git add`,
/// `npm install`, `Write(...)`, etc. The pipeline run is already isolated
/// inside `<projectDir>/.tx-worktrees/<runId>/` (a fresh git worktree on a
/// fresh branch) and the `tx-pipeline-managed` PreToolUse guardrails hook +
/// per-role capabilities allow/deny lists in `.claude/settings.json` form
/// the actual safety boundary. Stand-alone agent tiles (manual user spawn)
/// keep `pipeline_run = false` and the prompt remains.
///
/// The flag is a hardcoded string — callers cannot inject arbitrary flags
/// through this field.
#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_type: AgentType,
    cwd: String,
    task: Option<String>,
    custom_command: Option<String>,
    pipeline_run: Option<bool>,
) -> Result<String, String> {
    let pipeline_run = pipeline_run.unwrap_or(false);

    // Resolve CLI binary and args
    let (bin, args) = resolve_spawn_bin_and_args(
        &agent_type,
        task.as_deref(),
        custom_command.as_deref(),
        pipeline_run,
    )?;

    // Check if binary exists in PATH
    let check = if cfg!(target_os = "windows") {
        tokio::process::Command::new("where.exe").arg(&bin).output().await
    } else {
        tokio::process::Command::new("which").arg(&bin).output().await
    };

    match check {
        Ok(output) if output.status.success() => {}
        _ => {
            return Err(format!(
                "'{}' not found in PATH. Install the {} CLI or set a custom command.",
                bin,
                match agent_type {
                    AgentType::Claude => "Claude Code",
                    AgentType::Codex => "Codex",
                    AgentType::Gemini => "Gemini",
                }
            ));
        }
    }

    // On Windows, npm global CLIs are .cmd scripts — must run through cmd.exe
    let (spawn_bin, spawn_args) = if cfg!(target_os = "windows") {
        let mut cmd_args = vec!["/C".to_string(), bin.clone()];
        cmd_args.extend(args);
        ("cmd.exe".to_string(), cmd_args)
    } else {
        (bin.clone(), args)
    };

    // Validate custom_command args don't contain null bytes before spawning.
    // We intentionally do NOT reject arg-looking tokens (e.g. `--model sonnet`) —
    // custom_command is a user trust boundary: users legitimately pass model flags.
    // Renderer compromise is mitigated at the agent_spawn call site and by the webview CSP.
    if custom_command.is_some() {
        for a in &spawn_args {
            if a.contains('\0') {
                return Err("Custom command argument contains null byte".to_string());
            }
            if a.len() > 16384 {
                return Err("Custom command argument too long".to_string());
            }
        }
    }

    // Spawn via PTY with args — bypasses renderer-facing allowlist because
    // bin names are already validated (claude/codex/gemini or path-less custom).
    let pty_id = super::terminal::pty_spawn_internal(
        app.clone(),
        state.clone(),
        Some(spawn_bin),
        Some(cwd.clone()),
        Some(120),
        Some(30),
        Some(spawn_args),
    )
    .await?;

    // Register in agent registry using the PTY ID so events route correctly
    state.agent_registry.lock().insert(
        pty_id.clone(),
        AgentInfo {
            id: pty_id.clone(),
            agent_type,
            status: AgentStatus::Working,
            cwd,
            pid: None,
            uptime_secs: 0,
        },
    );

    // Emit initial status
    if let Err(e) = app.emit("agent-status", AgentStatusChange {
        id: pty_id.clone(),
        status: AgentStatus::Working,
    }) {
        eprintln!("agent-status emit failed: {}", e);
    }

    // Return the PTY ID so frontend can receive output
    Ok(pty_id)
}

/// Kill an agent process
#[tauri::command]
pub async fn agent_kill(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.agent_registry.lock().remove(&id);
    // Also kill the PTY — log failures but don't block caller
    if let Err(e) = state.pty_manager.lock().kill(&id) {
        eprintln!("agent_kill: failed to kill PTY {}: {}", id, e);
    }
    Ok(())
}

/// List all running agents
#[tauri::command]
pub async fn agent_list(
    state: State<'_, AppState>,
) -> Result<Vec<AgentInfo>, String> {
    let agents = state.agent_registry.lock();
    Ok(agents.values().cloned().collect())
}

use tokio::io::AsyncWriteExt;
use tokio::process::Command as TokioCommand;
use tokio::time::{timeout, Duration as TokioDuration};

/// Phase 3b.4 — separator between the system prompt brief and the user-facing
/// stdin payload. The agent's first turn receives ONE input stream:
///   `<system_prompt>\n\n---\n\n<stdin>`
/// and treats the prefix as initial context (skill content + acceptance
/// criterion + working file globs). Provider-agnostic — works the same on
/// claude/codex/gemini one-shot invocations because none of them parse the
/// stdin format; they all just hand it to the model as the first message.
pub const BRIEF_SEPARATOR: &str = "\n\n---\n\n";

#[derive(Debug, Deserialize)]
pub struct OneshotInvocation {
    /// Internal: tests inject a known bin (e.g. /bin/echo). Production callers
    /// don't set this; resolved from `agent` enum at the IPC boundary.
    #[serde(skip)]
    pub bin_override: Option<String>,

    pub args: Vec<String>,
    pub stdin: Option<String>,
    /// Phase 3b.4: prepended to stdin (with `BRIEF_SEPARATOR`) so the agent's
    /// first turn receives the brief as initial context. None = no prefix.
    /// Investigated `claude --system-prompt` / `--append-system-prompt`: those
    /// flags exist on Claude but neither codex nor gemini have an equivalent,
    /// so the stdin-prefix approach is the only provider-agnostic option.
    pub system_prompt: Option<String>,
    /// Phase 3b.4: file globs the sub-agent declares it'll touch. Recorded for
    /// audit but NOT enforced at the FS layer this phase — the
    /// tx-pipeline-subagent skill's behavioral contract is the constraint. FS
    /// enforcement (e.g. via `.claude/settings.json` permissions) is deferred
    /// to a post-3b hardening pass if dogfooding shows sub-agents escaping
    /// their brief.
    #[serde(default)]
    pub working_files: Vec<String>,
    pub timeout_secs: u64,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OneshotResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
}

/// Pure-async core. Caller resolves the binary path; this just runs it.
pub async fn run_oneshot_inner(inv: OneshotInvocation) -> Result<OneshotResult, String> {
    let bin = inv
        .bin_override
        .clone()
        .ok_or_else(|| "no binary specified".to_string())?;

    let started = std::time::Instant::now();

    let mut cmd = TokioCommand::new(&bin);
    cmd.args(&inv.args);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    if let Some(cwd) = &inv.cwd {
        cmd.current_dir(cwd);
    }
    // Without kill_on_drop, a timed-out subprocess keeps running after
    // tokio::time::timeout cancels the wait_with_output future.
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;

    // Compose the actual stdin: optional system_prompt prefix + separator +
    // user stdin. If no system_prompt is set, behavior is identical to before.
    // Phase 3b.4.
    let composed_stdin: Option<String> = match (&inv.system_prompt, &inv.stdin) {
        (None, None) => None,
        (None, Some(s)) => Some(s.clone()),
        (Some(prefix), None) => Some(prefix.clone()),
        (Some(prefix), Some(s)) => Some(format!("{prefix}{BRIEF_SEPARATOR}{s}")),
    };

    if let Some(input) = composed_stdin {
        if let Some(mut sin) = child.stdin.take() {
            sin.write_all(input.as_bytes())
                .await
                .map_err(|e| format!("write stdin: {e}"))?;
            // Drop sin to close stdin so the child finishes reading.
        }
    }

    // working_files is informational only this phase — the skill enforces
    // scope behaviorally. Polish.2 added the `subagent_invoked` telemetry
    // event which captures `workingFilesCount` from the Builder's
    // pre-invocation sentinel, so the data is reconstructable from the run
    // log without a stderr leak. (Was: eprintln on every invocation.)
    let _ = &inv.working_files;

    let wait = child.wait_with_output();
    let result = timeout(TokioDuration::from_secs(inv.timeout_secs), wait).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(out)) => Ok(OneshotResult {
            stdout: String::from_utf8_lossy(&out.stdout).to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            exit_code: out.status.code(),
            timed_out: false,
            duration_ms,
        }),
        Ok(Err(e)) => Err(format!("wait child: {e}")),
        Err(_) => Ok(OneshotResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: true,
            duration_ms,
        }),
    }
}

fn resolve_oneshot_bin(agent: &str) -> Result<String, String> {
    match agent {
        "claude" => Ok("claude".to_string()),
        "codex" => Ok("codex".to_string()),
        "gemini" => Ok("gemini".to_string()),
        other => Err(format!("unsupported one-shot agent: {other}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct OneshotIpcInput {
    pub agent: String,
    pub args: Vec<String>,
    pub stdin: Option<String>,
    /// Phase 3b.4: prepended to stdin with `BRIEF_SEPARATOR` so the spawned
    /// agent receives `<system_prompt>\n\n---\n\n<stdin>` as its first input.
    pub system_prompt: Option<String>,
    /// Phase 3b.4: file globs the sub-agent declares it'll touch. Logged for
    /// audit; NOT enforced at the FS layer this phase.
    #[serde(default)]
    pub working_files: Vec<String>,
    #[serde(default = "default_oneshot_timeout")]
    pub timeout_secs: u64,
    pub cwd: Option<String>,
}

fn default_oneshot_timeout() -> u64 {
    600
}

#[tauri::command]
pub async fn agent_run_oneshot(input: OneshotIpcInput) -> Result<OneshotResult, String> {
    let bin = resolve_oneshot_bin(&input.agent)?;
    let inv = OneshotInvocation {
        bin_override: Some(bin),
        args: input.args,
        stdin: input.stdin,
        system_prompt: input.system_prompt,
        working_files: input.working_files,
        timeout_secs: input.timeout_secs,
        cwd: input.cwd,
    };
    run_oneshot_inner(inv).await
}

// Pure-function tests for the spawn-args resolver. No subprocess / Tauri
// state required — runs on every platform.
#[cfg(test)]
mod spawn_args_tests {
    use super::*;

    #[test]
    fn claude_pipeline_run_appends_skip_permissions_flag() {
        let (bin, args) =
            resolve_spawn_bin_and_args(&AgentType::Claude, None, None, true).unwrap();
        assert_eq!(bin, "claude");
        assert!(
            args.contains(&"--dangerously-skip-permissions".to_string()),
            "expected --dangerously-skip-permissions, got {args:?}"
        );
    }

    #[test]
    fn claude_default_omits_skip_permissions_flag() {
        let (bin, args) =
            resolve_spawn_bin_and_args(&AgentType::Claude, None, None, false).unwrap();
        assert_eq!(bin, "claude");
        assert!(
            !args.contains(&"--dangerously-skip-permissions".to_string()),
            "stand-alone agent tile must NOT skip permissions; got {args:?}"
        );
    }

    #[test]
    fn claude_pipeline_run_with_task_keeps_flag_before_dash_p() {
        let (_, args) =
            resolve_spawn_bin_and_args(&AgentType::Claude, Some("hi"), None, true).unwrap();
        // Order: --dangerously-skip-permissions, -p, <task>
        assert_eq!(args[0], "--dangerously-skip-permissions");
        assert_eq!(args[1], "-p");
        assert_eq!(args[2], "hi");
    }

    #[test]
    fn codex_pipeline_run_does_not_inject_claude_flag() {
        let (bin, args) =
            resolve_spawn_bin_and_args(&AgentType::Codex, None, None, true).unwrap();
        assert_eq!(bin, "codex");
        assert!(
            !args.contains(&"--dangerously-skip-permissions".to_string()),
            "Claude flag must not leak into Codex args; got {args:?}"
        );
    }

    #[test]
    fn gemini_pipeline_run_does_not_inject_claude_flag() {
        let (bin, args) =
            resolve_spawn_bin_and_args(&AgentType::Gemini, None, None, true).unwrap();
        assert_eq!(bin, "gemini");
        assert!(
            !args.contains(&"--dangerously-skip-permissions".to_string()),
            "Claude flag must not leak into Gemini args; got {args:?}"
        );
    }

    #[test]
    fn custom_command_pipeline_run_does_not_inject_flag() {
        // Custom commands are a user trust boundary; we don't second-guess
        // their flags. If the user wants --dangerously-skip-permissions on
        // a pipeline-spawned custom command they put it in the command
        // string themselves.
        let (bin, args) = resolve_spawn_bin_and_args(
            &AgentType::Claude,
            None,
            Some("claude --model opus-4"),
            true,
        )
        .unwrap();
        assert_eq!(bin, "claude");
        assert_eq!(args, vec!["--model".to_string(), "opus-4".to_string()]);
    }

    #[test]
    fn task_starting_with_dash_is_rejected() {
        let err = resolve_spawn_bin_and_args(&AgentType::Claude, Some("-p"), None, false)
            .unwrap_err();
        assert!(err.contains("cannot start with '-'"), "got: {err}");
    }
}

// These tests use POSIX paths (/bin/echo, /bin/sh, /bin/cat) as stand-ins
// for the agent CLIs, so the suite is Unix-only. Windows CI is covered by
// the same module on Phase 2b's downstream e2e smoke (mocked at the TS
// layer) and by phase 3's `agent_run_oneshot` integration paths.
#[cfg(all(test, unix))]
mod oneshot_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn run_oneshot_captures_stdout_and_exit_code() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/echo".into()),
            args: vec!["hello".into(), "world".into()],
            stdin: None,
            system_prompt: None,
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert!(res.stdout.starts_with("hello world"));
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.timed_out);
    }

    #[tokio::test]
    async fn run_oneshot_captures_nonzero_exit() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/sh".into()),
            args: vec!["-c".into(), "exit 7".into()],
            stdin: None,
            system_prompt: None,
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert_eq!(res.exit_code, Some(7));
    }

    #[tokio::test]
    async fn run_oneshot_pipes_stdin() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/cat".into()),
            args: vec![],
            stdin: Some("piped input".into()),
            system_prompt: None,
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert_eq!(res.stdout.trim(), "piped input");
    }

    #[tokio::test]
    async fn run_oneshot_times_out_long_running() {
        let started = std::time::Instant::now();
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            stdin: None,
            system_prompt: None,
            working_files: vec![],
            timeout_secs: 1,
            cwd: None,
        })
        .await
        .unwrap();
        assert!(res.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 3b.4 — system_prompt + working_files extensions
    // ─────────────────────────────────────────────────────────────────

    /// 3b.4 #1 — `system_prompt` is prepended to `stdin` with the
    /// BRIEF_SEPARATOR; /bin/cat echoes the composed buffer back so we can
    /// assert on the exact framing.
    #[tokio::test]
    async fn run_oneshot_prepends_system_prompt_to_stdin() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/cat".into()),
            args: vec![],
            stdin: Some("hello".into()),
            system_prompt: Some("you are a sub-agent".into()),
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert_eq!(res.stdout, "you are a sub-agent\n\n---\n\nhello");
        assert_eq!(res.exit_code, Some(0));
    }

    /// 3b.4 #2 — system_prompt with no stdin sends just the prompt (no
    /// trailing separator) so the agent doesn't receive a dangling delimiter.
    #[tokio::test]
    async fn run_oneshot_system_prompt_alone_no_separator() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/cat".into()),
            args: vec![],
            stdin: None,
            system_prompt: Some("brief only".into()),
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert_eq!(res.stdout, "brief only");
    }

    /// 3b.4 #3 — `working_files` is informational only this phase. The
    /// subprocess runs identically whether the field is empty or populated;
    /// the field exists so the IPC surface is forward-compatible with future
    /// FS-layer enforcement.
    #[tokio::test]
    async fn run_oneshot_working_files_does_not_alter_execution() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/echo".into()),
            args: vec!["ok".into()],
            stdin: None,
            system_prompt: None,
            working_files: vec!["src/auth/**".into(), "src/lib.rs".into()],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        assert!(res.stdout.starts_with("ok"));
        assert_eq!(res.exit_code, Some(0));
        assert!(!res.timed_out);
    }

    /// 3b.4 #4 — when `system_prompt` is None the stdin pipeline is
    /// byte-for-byte identical to pre-3b.4 behavior (no separator injected).
    #[tokio::test]
    async fn run_oneshot_no_system_prompt_preserves_stdin_exactly() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/cat".into()),
            args: vec![],
            stdin: Some("just stdin".into()),
            system_prompt: None,
            working_files: vec![],
            timeout_secs: 5,
            cwd: None,
        })
        .await
        .unwrap();
        // No trailing newline added by /bin/cat; exact preservation of the
        // raw stdin bytes.
        assert_eq!(res.stdout, "just stdin");
    }

    /// 3b.4 #5 — `kill_on_drop(true)` from Phase 2c-i.2 is preserved through
    /// the 3b.4 changes: a long-running subprocess is reaped within the
    /// timeout window even after the new composed-stdin path runs.
    #[tokio::test]
    async fn run_oneshot_kill_on_drop_preserved_with_system_prompt() {
        let started = std::time::Instant::now();
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/sh".into()),
            args: vec!["-c".into(), "sleep 30".into()],
            stdin: Some("ignored".into()),
            system_prompt: Some("prefix".into()),
            working_files: vec!["x".into()],
            timeout_secs: 1,
            cwd: None,
        })
        .await
        .unwrap();
        assert!(res.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
