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

/// Spawn an AI agent CLI process
#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_type: AgentType,
    cwd: String,
    task: Option<String>,
    custom_command: Option<String>,
) -> Result<String, String> {
    // Resolve CLI binary and args
    let (bin, args) = if let Some(ref cmd) = custom_command {
        // Custom command: split first word as binary, rest as args
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() {
            return Err("Custom command is empty".to_string());
        }
        let bin_name = parts[0];
        // Reject binary names containing path separators — only PATH-resolved names allowed
        if bin_name.contains('/') || bin_name.contains('\\') {
            return Err("Custom command must be a program name, not a path".to_string());
        }
        (bin_name.to_string(), parts[1..].iter().map(|s| s.to_string()).collect::<Vec<_>>())
    } else {
        // Validate task doesn't start with '-' (prevents argument injection)
        if let Some(ref t) = task {
            if t.starts_with('-') {
                return Err("Task cannot start with '-'".to_string());
            }
            if t.len() > 32768 {
                return Err("Task too long (max 32KB)".to_string());
            }
        }
        match agent_type {
            AgentType::Claude => {
                let mut a: Vec<String> = vec![];
                if let Some(ref t) = task {
                    a.push("-p".to_string());
                    a.push(t.clone());
                }
                ("claude".to_string(), a)
            }
            AgentType::Codex => {
                let mut a: Vec<String> = vec![];
                if let Some(ref t) = task {
                    a.push(t.clone());
                }
                ("codex".to_string(), a)
            }
            AgentType::Gemini => {
                let mut a: Vec<String> = vec![];
                if let Some(ref t) = task {
                    a.push(t.clone());
                }
                ("gemini".to_string(), a)
            }
        }
    };

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

#[derive(Debug, Deserialize)]
pub struct OneshotInvocation {
    /// Internal: tests inject a known bin (e.g. /bin/echo). Production callers
    /// don't set this; resolved from `agent` enum at the IPC boundary.
    #[serde(skip)]
    pub bin_override: Option<String>,

    pub args: Vec<String>,
    pub stdin: Option<String>,
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

    let mut child = cmd.spawn().map_err(|e| format!("spawn {bin}: {e}"))?;

    if let Some(input) = &inv.stdin {
        if let Some(mut sin) = child.stdin.take() {
            sin.write_all(input.as_bytes())
                .await
                .map_err(|e| format!("write stdin: {e}"))?;
            // Drop sin to close stdin so the child finishes reading.
        }
    }

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
        timeout_secs: input.timeout_secs,
        cwd: input.cwd,
    };
    run_oneshot_inner(inv).await
}

#[cfg(test)]
mod oneshot_tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn run_oneshot_captures_stdout_and_exit_code() {
        let res = run_oneshot_inner(OneshotInvocation {
            bin_override: Some("/bin/echo".into()),
            args: vec!["hello".into(), "world".into()],
            stdin: None,
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
            timeout_secs: 1,
            cwd: None,
        })
        .await
        .unwrap();
        assert!(res.timed_out);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
