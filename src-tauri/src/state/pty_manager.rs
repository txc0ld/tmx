use portable_pty::{Child, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{ErrorKind, Write};
use std::time::Duration;

/// Hard cap on concurrent PTY sessions. Each PTY owns a reader thread, a
/// writer, file descriptors, and a terminal buffer. The macOS soft fd limit
/// is 256 per process; 64 PTYs leaves headroom for Tauri's own fds and the
/// webview's fds. Breach → pty_spawn returns an error the UI can toast.
pub const MAX_CONCURRENT_PTYS: usize = 64;

struct PtyEntry {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    pid: Option<u32>,
}

pub struct PtyManager {
    sessions: HashMap<String, PtyEntry>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn insert(
        &mut self,
        id: String,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send>,
    ) -> Result<(), String> {
        if self.sessions.len() >= MAX_CONCURRENT_PTYS {
            return Err(format!(
                "Too many active PTYs ({} in use, max {}). Close a terminal or agent tile before spawning more.",
                self.sessions.len(), MAX_CONCURRENT_PTYS
            ));
        }
        if self.sessions.contains_key(&id) {
            return Err(format!("PTY session {} already exists", id));
        }
        let pid = child.process_id();
        let writer = master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;
        self.sessions.insert(
            id,
            PtyEntry {
                writer,
                master,
                child,
                pid,
            },
        );
        Ok(())
    }

    pub fn process_id(&self, id: &str) -> Option<u32> {
        self.sessions.get(id).and_then(|entry| entry.pid)
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> Result<(), String> {
        let entry = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| format!("PTY session not found: {}", id))?;
        // Chunk writes to 256 bytes to avoid Windows PTY pipe buffer overflow.
        // Retry transient WouldBlock/Interrupted errors a handful of times
        // with a short sleep — without this, a busy PTY can silently drop
        // bytes from large pastes or multi-agent writes.
        for chunk in data.chunks(256) {
            let mut retries = 5u32;
            loop {
                match entry.writer.write_all(chunk) {
                    Ok(()) => break,
                    Err(e)
                        if (e.kind() == ErrorKind::WouldBlock
                            || e.kind() == ErrorKind::Interrupted)
                            && retries > 0 =>
                    {
                        retries -= 1;
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(e) => return Err(format!("Write error: {}", e)),
                }
            }
            if let Err(e) = entry.writer.flush() {
                // Flush errors are usually "pipe closed" on a dying shell.
                return Err(format!("Flush error: {}", e));
            }
        }
        Ok(())
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let entry = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| format!("PTY session not found: {}", id))?;
        entry
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize error: {}", e))
    }

    pub fn kill(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut entry) = self.sessions.remove(id) {
            kill_entry(&mut entry);
        } else {
            return Err(format!("PTY session not found: {}", id));
        }
        Ok(())
    }

    pub fn shutdown_all(&mut self) {
        for (_, mut entry) in self.sessions.drain() {
            kill_entry(&mut entry);
        }
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        // Ensure all child processes are killed when the manager is dropped
        for (_, mut entry) in self.sessions.drain() {
            kill_entry(&mut entry);
        }
    }
}

fn kill_entry(entry: &mut PtyEntry) {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = entry.pid {
            if kill_windows_process_tree(pid).is_ok() {
                return;
            }
        }
    }
    // Fallback for Unix and for Windows processes already gone by the time
    // taskkill runs.
    let _ = entry.child.kill();
}

#[cfg(target_os = "windows")]
fn kill_windows_process_tree(pid: u32) -> Result<(), String> {
    let pid_arg = pid.to_string();
    let status = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid_arg, "/T", "/F"])
        .status()
        .map_err(|e| format!("spawn taskkill.exe: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill.exe exited with {status}"))
    }
}
