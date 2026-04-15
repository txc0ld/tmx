use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const MAX_SNAPSHOTS: usize = 10000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub project_id: String,
    pub tiles: serde_json::Value,
    pub wires: serde_json::Value,
    pub transform: Transform,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

fn workspace_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("terminalx").join("workspaces")
}

async fn ensure_dir() -> Result<(), String> {
    let dir = workspace_dir();
    if !dir.exists() {
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("Failed to create workspace directory: {}", e))?;
    }
    Ok(())
}

/// Reject path components that could escape the config directory
fn sanitize_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name.len() > 255 {
        return Err("Name too long (max 255 chars)".to_string());
    }
    if name == "." || name == ".." {
        return Err("Name cannot be '.' or '..'".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') || name.contains(':') {
        return Err(format!("Invalid name: {}", name));
    }
    Ok(())
}

/// Atomic write — write to temp file then rename.
/// Prevents corruption if the app crashes mid-write.
async fn atomic_write(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, contents)
        .await
        .map_err(|e| format!("Write error: {}", e))?;
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| format!("Rename error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn save_workspace(state: WorkspaceState) -> Result<(), String> {
    sanitize_name(&state.project_id)?;
    ensure_dir().await?;
    let path = workspace_dir().join(format!("{}.json", state.project_id));
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Serialize error: {}", e))?;
    atomic_write(&path, &json).await
}

#[tauri::command]
pub async fn load_workspace(project_id: String) -> Result<Option<WorkspaceState>, String> {
    sanitize_name(&project_id)?;
    let path = workspace_dir().join(format!("{}.json", project_id));
    if !path.exists() {
        return Ok(None);
    }
    let json = tokio::fs::read_to_string(path).await.map_err(|e| format!("Read error: {}", e))?;
    let state = serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))?;
    Ok(Some(state))
}

#[tauri::command]
pub async fn save_snapshot(project_id: String, name: String, state: WorkspaceState) -> Result<(), String> {
    sanitize_name(&project_id)?;
    sanitize_name(&name)?;
    ensure_dir().await?;
    let snapshots_dir = workspace_dir().join("snapshots").join(&project_id);
    if !snapshots_dir.exists() {
        tokio::fs::create_dir_all(&snapshots_dir)
            .await
            .map_err(|e| format!("Failed to create snapshots directory: {}", e))?;
    }
    let path = snapshots_dir.join(format!("{}.json", name));
    let json = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Serialize error: {}", e))?;
    atomic_write(&path, &json).await
}

#[tauri::command]
pub async fn load_snapshot(project_id: String, name: String) -> Result<Option<WorkspaceState>, String> {
    sanitize_name(&project_id)?;
    sanitize_name(&name)?;
    let path = workspace_dir().join("snapshots").join(&project_id).join(format!("{}.json", name));
    if !path.exists() {
        return Ok(None);
    }
    let json = tokio::fs::read_to_string(path).await.map_err(|e| format!("Read error: {}", e))?;
    let state = serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))?;
    Ok(Some(state))
}

#[tauri::command]
pub async fn delete_snapshot(project_id: String, name: String) -> Result<(), String> {
    sanitize_name(&project_id)?;
    sanitize_name(&name)?;
    let path = workspace_dir().join("snapshots").join(&project_id).join(format!("{}.json", name));
    if path.exists() {
        tokio::fs::remove_file(path).await.map_err(|e| format!("Delete error: {}", e))
    } else {
        Err("Snapshot not found".to_string())
    }
}

#[tauri::command]
pub async fn list_snapshots(project_id: String) -> Result<Vec<String>, String> {
    sanitize_name(&project_id)?;
    let dir = workspace_dir().join("snapshots").join(&project_id);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut entries = tokio::fs::read_dir(dir).await.map_err(|e| format!("Read dir error: {}", e))?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| format!("Read dir error: {}", e))? {
        if names.len() >= MAX_SNAPSHOTS {
            break;
        }
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "json") {
            if let Some(stem) = path.file_stem() {
                names.push(stem.to_string_lossy().to_string());
            }
        }
    }
    Ok(names)
}
