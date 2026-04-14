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

    let stdout = String::from_utf8_lossy(&output.stdout);
    let containers = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            DockerContainer {
                id: parts.first().unwrap_or(&"").trim().to_string(),
                name: parts.get(1).unwrap_or(&"").trim().to_string(),
                image: parts.get(2).unwrap_or(&"").trim().to_string(),
                status: parts.get(3).unwrap_or(&"").trim().to_string(),
            }
        })
        .filter(|c| !c.id.is_empty())
        .collect();

    Ok(containers)
}
