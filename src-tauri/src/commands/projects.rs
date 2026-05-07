use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;

const MAX_PROJECTS: usize = 500;
const MAX_PROJECTS_JSON_BYTES: usize = 2 * 1024 * 1024;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
}

async fn projects_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("terminalx");
    if !dir.exists() {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }
    dir.join("projects.json")
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Project id must be 1-128 chars".to_string());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("Project id contains invalid characters".to_string());
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max_len: usize, allow_empty: bool) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("{} contains a null byte", label));
    }
    if !allow_empty && value.trim().is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if value.len() > max_len {
        return Err(format!("{} is too long (max {} chars)", label, max_len));
    }
    Ok(())
}

fn validate_color(color: &str) -> Result<(), String> {
    validate_text("Project color", color, 32, false)?;
    if color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err("Project color must be a #RRGGBB hex value".to_string())
}

fn validate_project(project: &Project) -> Result<(), String> {
    validate_id(&project.id)?;
    validate_text("Project name", &project.name, 120, false)?;
    validate_text("Project icon", &project.icon, 32, false)?;
    validate_color(&project.color)?;
    validate_text("Project description", &project.description, 2000, true)?;
    validate_text("Project cwd", &project.cwd, 4096, false)?;
    if let Some(git_url) = &project.git_url {
        validate_text("Project git_url", git_url, 2048, true)?;
    }
    if let Some(branch) = &project.branch {
        validate_text("Project branch", branch, 255, true)?;
    }
    if let Some(webhook) = &project.webhook_url {
        // Empty is allowed (means "clear it"); when present, must be https://
        // and capped at a sensible URL length. The deeper SSRF guard runs in
        // `http_proxy::http_fetch` at delivery time — this is just shape
        // validation so junk values can't leak into the persisted file.
        validate_text("Project webhook_url", webhook, 2048, true)?;
        let trimmed = webhook.trim();
        if !trimmed.is_empty() && !trimmed.starts_with("https://") {
            return Err("Project webhook_url must start with https://".to_string());
        }
    }
    Ok(())
}

fn validate_projects(projects: &[Project]) -> Result<(), String> {
    if projects.len() > MAX_PROJECTS {
        return Err(format!("Too many projects (max {})", MAX_PROJECTS));
    }
    let mut ids = HashSet::new();
    for project in projects {
        validate_project(project)?;
        if !ids.insert(project.id.as_str()) {
            return Err(format!("Duplicate project id: {}", project.id));
        }
    }
    Ok(())
}

async fn atomic_write(path: &std::path::Path, contents: &str) -> Result<(), String> {
    crate::util::fs_atomic::atomic_write_async(path, contents.as_bytes())
        .await
        .map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
pub async fn load_projects() -> Result<Vec<Project>, String> {
    let path = projects_path().await;
    if !path.exists() {
        return Ok(vec![]);
    }
    let metadata = tokio::fs::metadata(&path).await.map_err(|e| format!("Stat error: {}", e))?;
    if metadata.len() as usize > MAX_PROJECTS_JSON_BYTES {
        return Err(format!("Projects file too large ({} bytes, max {}MB)", metadata.len(), MAX_PROJECTS_JSON_BYTES / (1024 * 1024)));
    }
    let json = tokio::fs::read_to_string(path).await.map_err(|e| format!("Read error: {}", e))?;
    let projects: Vec<Project> = serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))?;
    validate_projects(&projects)?;
    Ok(projects)
}

#[tauri::command]
pub async fn save_projects(projects: Vec<Project>) -> Result<(), String> {
    validate_projects(&projects)?;
    let path = projects_path().await;
    let json = serde_json::to_string_pretty(&projects).map_err(|e| format!("Serialize error: {}", e))?;
    if json.len() > MAX_PROJECTS_JSON_BYTES {
        return Err(format!("Projects file too large ({} bytes, max {}MB)", json.len(), MAX_PROJECTS_JSON_BYTES / (1024 * 1024)));
    }
    atomic_write(&path, &json).await
}

#[tauri::command]
pub async fn add_project(project: Project) -> Result<(), String> {
    validate_project(&project)?;
    let mut projects = load_projects().await?;
    if projects.len() >= MAX_PROJECTS {
        return Err(format!("Too many projects (max {})", MAX_PROJECTS));
    }
    if projects.iter().any(|p| p.id == project.id) {
        return Err(format!("Duplicate project id: {}", project.id));
    }
    projects.push(project);
    save_projects(projects).await
}

#[tauri::command]
pub async fn update_project(project: Project) -> Result<(), String> {
    validate_project(&project)?;
    let mut projects = load_projects().await?;
    let pos = projects
        .iter()
        .position(|p| p.id == project.id)
        .ok_or_else(|| format!("Project not found: {}", project.id))?;
    projects[pos] = project;
    save_projects(projects).await
}

#[tauri::command]
pub async fn delete_project(id: String) -> Result<(), String> {
    validate_id(&id)?;
    let mut projects = load_projects().await?;
    projects.retain(|p| p.id != id);
    save_projects(projects).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_project() -> Project {
        Project {
            id: "proj-1".into(),
            name: "Demo".into(),
            icon: "🚀".into(),
            color: "#ff00aa".into(),
            description: "".into(),
            cwd: "/Users/foo/code".into(),
            git_url: None,
            branch: None,
            webhook_url: None,
        }
    }

    #[test]
    fn valid_project_passes() {
        assert!(validate_project(&ok_project()).is_ok());
    }

    #[test]
    fn id_must_be_alphanumeric_with_safe_separators() {
        assert!(validate_id("proj_1").is_ok());
        assert!(validate_id("proj-1").is_ok());
        assert!(validate_id("proj.1").is_ok());
        assert!(validate_id("abc123").is_ok());
        assert!(validate_id("").is_err(), "empty rejected");
        assert!(validate_id("bad id").is_err(), "spaces rejected");
        assert!(validate_id("bad/id").is_err(), "slash rejected");
        assert!(validate_id("bad\\id").is_err(), "backslash rejected");
        assert!(validate_id("bad:id").is_err(), "colon rejected");
        assert!(validate_id(&"x".repeat(129)).is_err(), "too long rejected");
    }

    #[test]
    fn color_must_be_hex_rrggbb() {
        assert!(validate_color("#ff00aa").is_ok());
        assert!(validate_color("#FF00AA").is_ok());
        assert!(validate_color("#000000").is_ok());
        assert!(validate_color("red").is_err());
        assert!(validate_color("#ff").is_err());
        assert!(validate_color("#ff00aabb").is_err(), "too long");
        assert!(validate_color("ff00aa").is_err(), "missing #");
        assert!(validate_color("#gggggg").is_err(), "non-hex");
    }

    #[test]
    fn text_fields_enforce_null_byte_rejection() {
        let mut p = ok_project();
        p.name = "bad\0name".into();
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn empty_required_text_fields_rejected() {
        let mut p = ok_project();
        p.name = "".into();
        assert!(validate_project(&p).is_err());

        let mut p = ok_project();
        p.cwd = "   ".into();
        assert!(validate_project(&p).is_err(), "whitespace-only rejected");

        let mut p = ok_project();
        p.icon = "".into();
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn description_can_be_empty() {
        let mut p = ok_project();
        p.description = "".into();
        assert!(validate_project(&p).is_ok());
    }

    #[test]
    fn duplicate_ids_rejected() {
        let a = ok_project();
        let mut b = ok_project();
        b.name = "Other".into();
        assert!(validate_projects(&[a, b]).is_err());
    }

    #[test]
    fn too_many_projects_rejected() {
        let mut projects = Vec::with_capacity(MAX_PROJECTS + 1);
        for i in 0..=MAX_PROJECTS {
            let mut p = ok_project();
            p.id = format!("proj-{}", i);
            projects.push(p);
        }
        assert!(validate_projects(&projects).is_err());
    }

    #[test]
    fn webhook_url_must_be_https() {
        let mut p = ok_project();
        p.webhook_url = Some("https://hooks.slack.com/abc".into());
        assert!(validate_project(&p).is_ok());

        let mut p = ok_project();
        p.webhook_url = Some("http://hooks.slack.com/abc".into());
        assert!(validate_project(&p).is_err(), "http rejected");

        let mut p = ok_project();
        p.webhook_url = Some("file:///etc/passwd".into());
        assert!(validate_project(&p).is_err(), "non-https scheme rejected");

        let mut p = ok_project();
        p.webhook_url = Some("".into());
        assert!(validate_project(&p).is_ok(), "empty allowed (means clear)");
    }

    #[test]
    fn optional_branch_and_git_url_capped() {
        let mut p = ok_project();
        p.git_url = Some("x".repeat(3000));
        assert!(validate_project(&p).is_err());

        let mut p = ok_project();
        p.branch = Some("x".repeat(300));
        assert!(validate_project(&p).is_err());
    }
}
