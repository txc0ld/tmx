use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub description: String,
    pub cwd: String,
    #[serde(default)]
    pub git_url: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

async fn projects_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("terminalx");
    if !dir.exists() {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }
    dir.join("projects.json")
}

#[tauri::command]
pub async fn load_projects() -> Result<Vec<Project>, String> {
    let path = projects_path().await;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = tokio::fs::read_to_string(path).await.map_err(|e| format!("Read error: {}", e))?;
    let projects: Vec<Project> = serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))?;
    Ok(projects)
}

#[tauri::command]
pub async fn save_projects(projects: Vec<Project>) -> Result<(), String> {
    let path = projects_path().await;
    let json = serde_json::to_string_pretty(&projects).map_err(|e| format!("Serialize error: {}", e))?;
    tokio::fs::write(path, json).await.map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
pub async fn add_project(project: Project) -> Result<(), String> {
    let mut projects = load_projects().await?;
    projects.push(project);
    save_projects(projects).await
}

#[tauri::command]
pub async fn delete_project(id: String) -> Result<(), String> {
    let mut projects = load_projects().await?;
    projects.retain(|p| p.id != id);
    save_projects(projects).await
}
