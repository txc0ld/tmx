use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
}

#[tauri::command]
pub async fn docker_available() -> Result<bool, String> {
    let check = Command::new("docker")
        .args(["--version"])
        .output()
        .await;
    match check {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn docker_list_containers() -> Result<Vec<DockerContainer>, String> {
    let output = Command::new("docker")
        .args(["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"])
        .output()
        .await
        .map_err(|e| format!("Docker error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("docker ps failed: {}", stderr.trim()));
    }

    fn truncate(s: &str, max: usize) -> String {
        if s.len() <= max { return s.to_string(); }
        // Safe UTF-8 truncation
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) { end -= 1; }
        s[..end].to_string()
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let containers: Vec<DockerContainer> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 4 { return None; }
            let id = parts[0].trim();
            if id.is_empty() { return None; }
            Some(DockerContainer {
                id: truncate(id, 64),
                name: truncate(parts[1].trim(), 128),
                image: truncate(parts[2].trim(), 256),
                status: truncate(parts[3].trim(), 128),
            })
        })
        .take(500) // Cap at 500 containers
        .collect();

    Ok(containers)
}
