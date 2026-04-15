use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

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
    if let Some(home) = dirs::home_dir() {
        let home_clean = strip_verbatim_prefix(&home);
        if canonical.starts_with(&home_clean) { return true; }
    }
    #[cfg(windows)]
    {
        // Allow common Windows roots: user profile dir, project dirs under drives
        let roots = [
            r"C:\Users", r"D:\", r"E:\",       // drive letters
            r"C:\workspace", r"C:\src",
        ];
        if roots.iter().any(|r| canonical.starts_with(r)) { return true; }
    }
    #[cfg(not(windows))]
    {
        let roots = [
            "/tmp", "/var/folders",               // macOS temp
            "/Users",                             // macOS home root
            "/Volumes",                           // external drives
            "/workspace", "/workspaces", "/srv",  // common container mounts
            "/home",                              // Linux home root
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
    let expanded = shellexpand::tilde(&path).to_string();

    // Validate the path exists and is a directory before creating a watcher
    let watch_path = PathBuf::from(&expanded);
    if !watch_path.exists() {
        return Err(format!("Path does not exist: {}", expanded));
    }
    if !watch_path.is_dir() {
        return Err(format!("Path is not a directory: {}", expanded));
    }

    // Skip if already watching this path
    if state.watchers.lock().contains_key(&expanded) {
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
    state.watchers.lock().insert(expanded, watcher);

    Ok(())
}

/// Stop watching a directory
#[tauri::command]
pub async fn unwatch_directory(
    state: tauri::State<'_, crate::state::app_state::AppState>,
    path: String,
) -> Result<(), String> {
    let expanded = shellexpand::tilde(&path).to_string();
    // Removing the watcher drops it, which stops watching
    state.watchers.lock().remove(&expanded)
        .ok_or_else(|| format!("No watcher found for: {}", path))?;
    Ok(())
}
