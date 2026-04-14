use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLogEntry {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "M", "A", "D", "??"
    pub staged: bool,
}

#[tauri::command]
pub async fn git_available() -> Result<bool, String> {
    let check = if cfg!(target_os = "windows") {
        Command::new("where.exe").arg("git").output().await
    } else {
        Command::new("which").arg("git").output().await
    };
    match check {
        Ok(output) => Ok(output.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn git_clone(url: String, dest: String) -> Result<(), String> {
    // Reject URLs starting with '-' to prevent argument injection
    if url.starts_with('-') {
        return Err("Invalid git URL: must not start with '-'".to_string());
    }

    let expanded = shellexpand::tilde(&dest).to_string();
    let output = Command::new("git")
        .args(["clone", &url, &expanded])
        .output()
        .await
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("git clone failed: {}", stderr.trim()))
    }
}

#[tauri::command]
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();

    // Get branch name
    let branch_output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    let branch = if branch_output.status.success() {
        String::from_utf8_lossy(&branch_output.stdout).trim().to_string()
    } else {
        "unknown".to_string()
    };

    // Check dirty state
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    let dirty = !String::from_utf8_lossy(&status_output.stdout).trim().is_empty();

    Ok(GitStatus {
        branch,
        dirty,
        ahead: 0,
        behind: 0,
    })
}

#[tauri::command]
pub async fn git_log(repo_path: String, limit: Option<u32>) -> Result<Vec<GitLogEntry>, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let n = limit.unwrap_or(50).min(200).to_string();
    let output = Command::new("git")
        .args(["log", "--format=%H%n%h%n%an%n%aI%n%s", "-n", &n])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git log failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let lines: Vec<&str> = stdout.trim().split('\n').collect();
    let mut entries = Vec::new();
    for chunk in lines.chunks(5) {
        if chunk.len() == 5 {
            entries.push(GitLogEntry {
                hash: chunk[0].to_string(),
                short_hash: chunk[1].to_string(),
                author: chunk[2].to_string(),
                date: chunk[3].to_string(),
                message: chunk[4].to_string(),
            });
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn git_branches(repo_path: String) -> Result<Vec<String>, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if !output.status.success() {
        return Err("git branch failed".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.trim().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[tauri::command]
pub async fn git_checkout(repo_path: String, branch: String) -> Result<(), String> {
    if branch.starts_with('-') {
        return Err("Invalid branch name".to_string());
    }
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["checkout", &branch])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("git checkout failed: {}", stderr.trim()))
    }
}

#[tauri::command]
pub async fn git_diff_summary(repo_path: String) -> Result<String, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["diff", "--stat"])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("git diff failed: {}", stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn git_files_status(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["status", "--porcelain=v1"])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut files = Vec::new();
    for line in stdout.lines() {
        let chars: Vec<char> = line.chars().collect();
        if chars.len() < 4 { continue; }
        let index_status = chars[0];
        let worktree_status = chars[1];
        // chars[2] is the space separator
        let path: String = chars[3..].iter().collect();
        let staged = index_status != ' ' && index_status != '?';
        let status = if index_status == '?' {
            "??".to_string()
        } else if staged {
            index_status.to_string()
        } else {
            worktree_status.to_string()
        };
        files.push(GitFileStatus { path, status, staged });
    }
    Ok(files)
}

#[tauri::command]
pub async fn git_stage(repo_path: String, path: String) -> Result<(), String> {
    if path.starts_with('-') {
        return Err("Invalid path".to_string());
    }
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["add", &path])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if output.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

#[tauri::command]
pub async fn git_unstage(repo_path: String, path: String) -> Result<(), String> {
    if path.starts_with('-') {
        return Err("Invalid path".to_string());
    }
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["restore", "--staged", &path])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if output.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
}

#[tauri::command]
pub async fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    let expanded = shellexpand::tilde(&repo_path).to_string();
    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&expanded)
        .output()
        .await
        .map_err(|e| format!("git error: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
