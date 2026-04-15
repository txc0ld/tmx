use crate::state::app_state::AppState;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Clone)]
pub struct PtyOutput {
    pub id: String,
    pub data: String,
}

/// Messages passed from the blocking PTY reader thread to the non-blocking
/// emitter thread. A bounded channel between them is what gives us
/// backpressure: if the emitter falls behind, the reader blocks on `send`,
/// which blocks the PTY read, which blocks the child process's writes at the
/// OS level. Without this, a busy shell can out-produce the webview event
/// queue and memory grows unboundedly.
enum PtyEvent {
    Data(String),
    Exit,
}

/// Channel capacity between reader and emitter. Each slot holds up to 8 KB
/// of UTF-8, so 256 slots ≈ 2 MB worst-case in-flight per PTY — enough that
/// burst output doesn't block immediately, tight enough that slow frontend
/// translates to real backpressure within a few hundred ms.
const PTY_CHANNEL_CAPACITY: usize = 256;

/// PTY column/row bounds. Below 20 cols or 3 rows the terminal is unusable;
/// above 512 we stop clamping what most shells / programs can actually
/// render meaningfully and what portable-pty guarantees on all platforms.
const PTY_COLS_MIN: u16 = 20;
const PTY_COLS_MAX: u16 = 512;
const PTY_ROWS_MIN: u16 = 3;
const PTY_ROWS_MAX: u16 = 512;

/// Binaries the renderer is permitted to spawn via `pty_spawn`.
/// Keep this tight — the renderer is the untrusted boundary.
/// Internal callers (e.g. agent_spawn) go through `pty_spawn_internal` which bypasses this list.
const SHELL_ALLOWLIST: &[&str] = &[
    // Standard shells
    "/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/bash", "/usr/bin/zsh", "/usr/bin/sh",
    "bash", "zsh", "sh", "fish", "/opt/homebrew/bin/fish",
    "powershell.exe", "pwsh.exe", "pwsh", "cmd.exe",
    // Network / container clients permitted as first-class tiles
    "ssh", "docker",
];

fn is_shell_allowed(shell: &str) -> bool {
    if shell.contains('\0') || shell.starts_with('-') { return false; }
    if SHELL_ALLOWLIST.contains(&shell) { return true; }
    // Also allow the user's configured SHELL env var
    if let Ok(user_shell) = std::env::var("SHELL") {
        if shell == user_shell { return true; }
    }
    false
}

fn validate_pty_args(args: &[String]) -> Result<(), String> {
    for a in args {
        if a.contains('\0') {
            return Err("Argument contains null byte".to_string());
        }
        if a.len() > 16384 {
            return Err("Argument too long".to_string());
        }
    }
    Ok(())
}

/// Spawn a new PTY session and begin streaming output.
/// Publicly exposed to the renderer — `shell` is validated against `SHELL_ALLOWLIST`.
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
    if let Some(ref s) = shell {
        if !is_shell_allowed(s) {
            return Err(format!("Shell '{}' is not in the allowlist", s));
        }
    }
    if let Some(ref a) = args {
        validate_pty_args(a)?;
    }
    pty_spawn_internal(app, state, shell, cwd, cols, rows, args).await
}

/// Internal PTY spawner — trusts the caller (e.g. agent_spawn) to have validated inputs.
/// Not exposed as a tauri command.
pub async fn pty_spawn_internal(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    args: Option<Vec<String>>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let cols = cols.unwrap_or(120).clamp(PTY_COLS_MIN, PTY_COLS_MAX);
    let rows = rows.unwrap_or(30).clamp(PTY_ROWS_MIN, PTY_ROWS_MAX);

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

    // Reader/emitter decoupling via bounded channel. Rationale in `PtyEvent`
    // docs above. The 8 KB read buffer (vs. previous 4 KB) trades twice the
    // per-thread stack use for half as many wake-ups on busy shells.
    let (tx, rx) = mpsc::sync_channel::<PtyEvent>(PTY_CHANNEL_CAPACITY);

    // Reader thread: blocking PTY reads → channel. `send` blocks when the
    // channel is full, which ripples back through the PTY pipe to naturally
    // backpressure the child process.
    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if tx.send(PtyEvent::Data(data)).is_err() {
                        // Emitter thread exited — stop reading.
                        return;
                    }
                }
                Err(e) => {
                    eprintln!("PTY {} read error: {}", reader_id, e);
                    break;
                }
            }
        }
        let _ = tx.send(PtyEvent::Exit);
    });

    // Emitter thread: channel → webview events. Errors are retried with
    // exponential backoff up to 2 s per attempt, capped at ~30 attempts —
    // a brief webview hiccup doesn't kill the stream, but a genuinely
    // gone frontend exits cleanly instead of busy-looping.
    let emit_id = id.clone();
    std::thread::spawn(move || {
        let mut consecutive_errors = 0u32;
        let mut backoff_ms = 50u64;
        while let Ok(event) = rx.recv() {
            match event {
                PtyEvent::Data(data) => {
                    let payload = PtyOutput { id: emit_id.clone(), data };
                    loop {
                        match app.emit("pty-output", payload.clone()) {
                            Ok(()) => {
                                consecutive_errors = 0;
                                backoff_ms = 50;
                                break;
                            }
                            Err(e) => {
                                consecutive_errors += 1;
                                if consecutive_errors >= 30 {
                                    eprintln!(
                                        "pty-output: giving up after {} errors for {}: {}",
                                        consecutive_errors, emit_id, e
                                    );
                                    return;
                                }
                                std::thread::sleep(Duration::from_millis(backoff_ms));
                                backoff_ms = (backoff_ms * 2).min(2000);
                            }
                        }
                    }
                }
                PtyEvent::Exit => break,
            }
        }
        if let Err(e) = app.emit("pty-exit", emit_id.clone()) {
            eprintln!("pty-exit emit failed for {}: {}", emit_id, e);
        }
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

/// Resize a PTY session. Clamped to the same bounds as spawn so a buggy
/// caller can't send a 0x0 terminal (hangs ncurses apps) or a 10000x10000
/// one (oomable on some shells).
#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let cols = cols.clamp(PTY_COLS_MIN, PTY_COLS_MAX);
    let rows = rows.clamp(PTY_ROWS_MIN, PTY_ROWS_MAX);
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
