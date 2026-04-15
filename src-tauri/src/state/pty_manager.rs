use portable_pty::{Child, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::Write;

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
        // Chunk writes to avoid Windows PTY pipe buffer overflow
        for chunk in data.chunks(256) {
            entry.writer.write_all(chunk)
                .map_err(|e| format!("Write error: {}", e))?;
            entry.writer.flush()
                .map_err(|e| format!("Flush error: {}", e))?;
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
