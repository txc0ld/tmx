use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub node_type: FileNodeType,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileNodeType {
    File,
    Directory,
}

const IGNORED_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "dist", ".next",
    "__pycache__", ".turbo", "build", ".cache",
];
const MAX_TEXT_WRITE_BYTES: usize = 10 * 1024 * 1024;

/// Read directory tree recursively (max depth 4).
/// Rejects paths that resolve outside the user's home / well-known project roots
/// to limit what a compromised renderer can enumerate.
/// Strip the Windows UNC verbatim prefix (`\\?\`) from a path so comparisons
/// against `dirs::home_dir()` (which never includes it) work correctly.
fn strip_verbatim_prefix(p: &std::path::Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            // UNC form: \\?\UNC\server\share\... -> \\server\share\...
            if let Some(unc_rest) = rest.strip_prefix("UNC\\") {
                return PathBuf::from(format!(r"\\{}", unc_rest));
            }
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

#[tauri::command]
pub async fn read_file_tree(
    path: String,
    max_depth: Option<u32>,
) -> Result<Vec<FileNode>, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let root = PathBuf::from(shellexpand::tilde(&path).to_string());
    let canonical_raw = root.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let canonical = strip_verbatim_prefix(&canonical_raw);
    if !is_path_allowed(&canonical) {
        return Err("Path is outside the allowed roots (home dir, common project folders)".to_string());
    }
    Ok(read_dir_recursive(&canonical, 0, max_depth.unwrap_or(4).min(8)))
}

fn is_path_allowed(canonical: &std::path::Path) -> bool {
    // TerminalX is a terminal/cmd/powershell upgrade — users need broad access
    // to do real work. We scope out only the obviously non-user paths; we do
    // not try to sandbox the user's own disks.
    if let Some(home) = dirs::home_dir() {
        let home_clean = strip_verbatim_prefix(&home);
        if canonical.starts_with(&home_clean) { return true; }
    }
    #[cfg(windows)]
    {
        // Allow any drive letter (A-Z) at the root. UNC verbatim prefix is
        // already stripped upstream, and mapped/network drives get picked up
        // here too.
        let s = canonical.to_string_lossy();
        if let Some(bytes) = s.as_bytes().get(..3) {
            if bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
                return true;
            }
        }
        // Bare UNC path \\server\share\...
        if s.starts_with(r"\\") { return true; }
    }
    #[cfg(not(windows))]
    {
        // Broad list covering macOS/Linux layouts: temps, user roots, mounts,
        // container paths, common tool dirs, system config. We do NOT allow
        // `/proc`, `/sys`, `/dev` (not real files) or `/root`.
        //
        // On macOS, `/tmp` and `/var` are symlinks to `/private/tmp` and
        // `/private/var` — canonicalize() follows those, so we include the
        // resolved forms explicitly.
        let roots = [
            "/tmp", "/var/folders", "/var/tmp",           // linux temp
            "/private/tmp", "/private/var",               // macOS resolved temp
            "/Users", "/Volumes",                          // macOS user + external
            "/Library", "/Applications",                   // macOS system (read-only-ish)
            "/home",                                        // linux home root
            "/mnt", "/media",                              // mounts
            "/workspace", "/workspaces", "/srv",           // container paths
            "/opt", "/usr/local", "/usr/share", "/etc",    // tools & config
            "/data",
        ];
        if roots.iter().any(|r| canonical.starts_with(r)) { return true; }
    }
    false
}

fn read_dir_recursive(dir: &PathBuf, depth: u32, max_depth: u32) -> Vec<FileNode> {
    if depth >= max_depth {
        return vec![];
    }

    let mut nodes = vec![];

    if let Ok(entries) = fs::read_dir(dir) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by(|a, b| {
            let a_dir = a.path().is_dir();
            let b_dir = b.path().is_dir();
            b_dir.cmp(&a_dir).then(a.file_name().cmp(&b.file_name()))
        });

        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') && depth == 0 && name != ".env" {
                continue;
            }
            let path = entry.path();

            // Skip symlinks to prevent infinite recursion via loops
            if path.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                continue;
            }

            if path.is_dir() {
                if IGNORED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let children = read_dir_recursive(&path, depth + 1, max_depth);
                nodes.push(FileNode {
                    name,
                    path: path.to_string_lossy().to_string(),
                    node_type: FileNodeType::Directory,
                    children: Some(children),
                });
            } else {
                nodes.push(FileNode {
                    name,
                    path: path.to_string_lossy().to_string(),
                    node_type: FileNodeType::File,
                    children: None,
                });
            }
        }
    }

    nodes
}

/// Read a file as UTF-8 text, validated against the same allowed-roots
/// list as `read_file_tree`. Used by EditorTile and DiffTile so users can
/// open any file under their home directory (the Tauri fs plugin scope is
/// stricter and trips on paths like ~/.claude/projects/...).
#[tauri::command]
pub async fn read_file_text(path: String) -> Result<String, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let raw = PathBuf::from(shellexpand::tilde(&path).to_string());
    let canonical_raw = raw.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let canonical = strip_verbatim_prefix(&canonical_raw);
    if !is_path_allowed(&canonical) {
        return Err("Path is outside the allowed roots".to_string());
    }
    if canonical.is_dir() {
        return Err("Path is a directory".to_string());
    }
    // 10 MB cap — anything bigger is almost certainly not a text file the
    // user wants to load into Monaco
    let metadata = fs::metadata(&canonical).map_err(|e| format!("Stat error: {}", e))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err(format!("File too large ({} bytes — 10 MB cap)", metadata.len()));
    }
    fs::read_to_string(&canonical).map_err(|e| format!("Read error: {}", e))
}

/// Write UTF-8 text to a file, validated against the same allowed-roots
/// list as `read_file_tree`. Used by EditorTile auto-save.
#[tauri::command]
pub async fn write_file_text(path: String, contents: String) -> Result<(), String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    if contents.len() > MAX_TEXT_WRITE_BYTES {
        return Err(format!("File too large ({} bytes - 10 MB cap)", contents.len()));
    }
    let raw = PathBuf::from(shellexpand::tilde(&path).to_string());
    // For writes the file may not exist yet — canonicalize the parent dir
    // and rejoin with the file name.
    let parent = raw.parent().ok_or_else(|| "Path has no parent".to_string())?;
    let file_name = raw.file_name().ok_or_else(|| "Path has no file name".to_string())?;
    let canonical_parent_raw = parent.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let canonical_parent = strip_verbatim_prefix(&canonical_parent_raw);
    if !is_path_allowed(&canonical_parent) {
        return Err("Path is outside the allowed roots".to_string());
    }
    let final_path = canonical_parent.join(file_name);
    if let Ok(metadata) = fs::symlink_metadata(&final_path) {
        if metadata.file_type().is_symlink() {
            return Err("Refusing to write through a symlink".to_string());
        }
        if metadata.is_dir() {
            return Err("Path is a directory".to_string());
        }
        let canonical_final_raw = final_path.canonicalize().map_err(|e| format!("Path error: {}", e))?;
        let canonical_final = strip_verbatim_prefix(&canonical_final_raw);
        if !is_path_allowed(&canonical_final) {
            return Err("Path is outside the allowed roots".to_string());
        }
    }
    fs::write(&final_path, contents).map_err(|e| format!("Write error: {}", e))
}

/// Start watching a directory for changes
#[tauri::command]
pub async fn watch_directory(
    app: AppHandle,
    state: tauri::State<'_, crate::state::app_state::AppState>,
    path: String,
) -> Result<(), String> {
    use notify::{recommended_watcher, RecursiveMode, Watcher};

    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let raw = PathBuf::from(shellexpand::tilde(&path).to_string());
    let canonical_raw = raw.canonicalize().map_err(|e| format!("Path error: {}", e))?;
    let watch_path = strip_verbatim_prefix(&canonical_raw);
    if !is_path_allowed(&watch_path) {
        return Err("Path is outside the allowed roots".to_string());
    }
    if !watch_path.is_dir() {
        return Err(format!("Path is not a directory: {}", watch_path.to_string_lossy()));
    }
    let watch_key = watch_path.to_string_lossy().to_string();

    // Skip if already watching this path
    if state.watchers.lock().contains_key(&watch_key) {
        return Ok(());
    }

    let app_clone = app.clone();
    let mut watcher = recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            let paths: Vec<String> = event.paths.iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let summary = format!("{:?}: {}", event.kind, paths.join(", "));
            if let Err(e) = app_clone.emit("fs-change", summary) {
                eprintln!("fs-change emit failed: {}", e);
            }
        }
    })
    .map_err(|e| format!("Watcher error: {}", e))?;

    watcher
        .watch(&watch_path, RecursiveMode::Recursive)
        .map_err(|e| format!("Watch error: {}", e))?;

    // Store watcher in AppState for proper cleanup
    state.watchers.lock().insert(watch_key, watcher);

    Ok(())
}

/// Stop watching a directory
#[tauri::command]
pub async fn unwatch_directory(
    state: tauri::State<'_, crate::state::app_state::AppState>,
    path: String,
) -> Result<(), String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let expanded = shellexpand::tilde(&path).to_string();
    let key = PathBuf::from(&expanded)
        .canonicalize()
        .map(|p| strip_verbatim_prefix(&p).to_string_lossy().to_string())
        .unwrap_or(expanded);
    // Removing the watcher drops it, which stops watching
    state.watchers.lock().remove(&key)
        .ok_or_else(|| format!("No watcher found for: {}", path))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn home_directory_is_allowed() {
        let home = dirs::home_dir().expect("home dir available in test env");
        assert!(is_path_allowed(&home));
        assert!(is_path_allowed(&home.join("some-file.txt")));
        assert!(is_path_allowed(&home.join("projects/terminalx")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_letters_are_allowed() {
        assert!(is_path_allowed(&PathBuf::from(r"C:\Users\foo")));
        assert!(is_path_allowed(&PathBuf::from(r"D:\")));
        assert!(is_path_allowed(&PathBuf::from(r"E:\data\file.txt")));
        // All drive letters should be allowed now — it's a power-user terminal
        assert!(is_path_allowed(&PathBuf::from(r"Z:\backup")));
        assert!(is_path_allowed(&PathBuf::from(r"F:\external")));
        // UNC network shares
        assert!(is_path_allowed(&PathBuf::from(r"\\server\share\file")));
    }

    #[cfg(not(windows))]
    #[test]
    fn macos_and_linux_roots_are_allowed() {
        assert!(is_path_allowed(&PathBuf::from("/Users/foo/code")));
        assert!(is_path_allowed(&PathBuf::from("/Volumes/External/file")));
        assert!(is_path_allowed(&PathBuf::from("/home/foo/code")));
        assert!(is_path_allowed(&PathBuf::from("/tmp/scratch")));
        assert!(is_path_allowed(&PathBuf::from("/opt/homebrew/bin/git")));
        assert!(is_path_allowed(&PathBuf::from("/mnt/disk1/data")));
        // macOS: /tmp canonicalizes to /private/tmp — must be explicitly allowed
        assert!(is_path_allowed(&PathBuf::from("/private/tmp/foo")));
        assert!(is_path_allowed(&PathBuf::from("/private/var/folders/xx")));
        // System dirs users commonly need
        assert!(is_path_allowed(&PathBuf::from("/Library/Logs")));
        assert!(is_path_allowed(&PathBuf::from("/Applications/MyApp.app")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_non_path_strings() {
        // These aren't real absolute paths — allowlist should reject.
        assert!(!is_path_allowed(&PathBuf::from("not-a-path")));
        // Only absolute drive-letter paths — no shell shortcuts
        assert!(!is_path_allowed(&PathBuf::from("C:no-slash")));
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_rejects_sensitive_virtual_filesystems() {
        assert!(!is_path_allowed(&PathBuf::from("/proc/1/environ")));
        assert!(!is_path_allowed(&PathBuf::from("/sys/class/net")));
        assert!(!is_path_allowed(&PathBuf::from("/dev/null")));
        assert!(!is_path_allowed(&PathBuf::from("/root/.ssh/id_rsa")));
    }
}
