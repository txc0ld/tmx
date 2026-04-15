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

    // Spawn via PTY with args
    let pty_id = super::terminal::pty_spawn(
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
