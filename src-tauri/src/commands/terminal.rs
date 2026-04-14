use crate::state::app_state::AppState;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Clone)]
pub struct PtyOutput {
    pub id: String,
    pub data: String,
}

/// Spawn a new PTY session and begin streaming output
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let cols = cols.unwrap_or(120);
    let rows = rows.unwrap_or(30);

    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    // Determine shell
    let shell_cmd = shell.unwrap_or_else(|| {
        if cfg!(target_os = "windows") {
            "powershell.exe".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
        }
    });

    let mut cmd = CommandBuilder::new(&shell_cmd);
    if let Some(ref extra_args) = args {
        for arg in extra_args {
            cmd.arg(arg);
        }
    }
    if let Some(ref dir) = cwd {
        let expanded = shellexpand::tilde(dir).to_string();
        cmd.cwd(expanded);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Drop the slave side — we only need the master
    drop(pair.slave);

    // Get reader for streaming output
    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    // Store master and child in PtyManager for write/resize/kill
    state.pty_manager.lock().insert(id.clone(), pair.master, child)?;

    // Spawn reader thread → stream output to frontend
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit("pty-output", PtyOutput {
                        id: reader_id.clone(),
                        data,
                    });
                }
                Err(_) => break,
            }
        }
        // PTY closed — notify frontend
        let _ = app.emit("pty-exit", reader_id);
    });

    Ok(id)
}

/// Write data to a PTY session (user keystrokes)
#[tauri::command]
pub async fn pty_write(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state.pty_manager.lock()
        .write(&id, data.as_bytes())
        .map_err(|e| format!("PTY write error: {}", e))
}

/// Resize a PTY session
#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.lock()
        .resize(&id, cols, rows)
        .map_err(|e| format!("PTY resize error: {}", e))
}

/// Kill a PTY session
#[tauri::command]
pub async fn pty_kill(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    state.pty_manager.lock()
        .kill(&id)
        .map_err(|e| format!("PTY kill error: {}", e))
}
