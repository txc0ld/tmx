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
        let writer = master.take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;
        self.sessions.insert(id, PtyEntry { writer, master, child });
        Ok(())
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> Result<(), String> {
        let entry = self.sessions.get_mut(id)
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
                        if (e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted)
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
        let entry = self.sessions.get_mut(id)
            .ok_or_else(|| format!("PTY session not found: {}", id))?;
        entry.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))
    }

    pub fn kill(&mut self, id: &str) -> Result<(), String> {
        if let Some(mut entry) = self.sessions.remove(id) {
            // Kill the child process; ignore errors (it may have already exited)
            let _ = entry.child.kill();
        } else {
            return Err(format!("PTY session not found: {}", id));
        }
        Ok(())
    }

    pub fn shutdown_all(&mut self) {
        for (_, mut entry) in self.sessions.drain() {
            let _ = entry.child.kill();
        }
    }

}

impl Drop for PtyManager {
    fn drop(&mut self) {
        // Ensure all child processes are killed when the manager is dropped
        for (_, mut entry) in self.sessions.drain() {
            let _ = entry.child.kill();
        }
    }
}
