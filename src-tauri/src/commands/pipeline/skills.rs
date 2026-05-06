//! `pipeline_install_skills` — copy bundled SKILL.md files into ~/.claude/skills/.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct InstallSkillsResult {
    pub skills_dir: String,
    pub installed: Vec<String>,
    pub already_present: Vec<String>,
    pub errors: Vec<String>,
    pub stub: bool,
}

fn skills_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".claude").join("skills");
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile).join(".claude").join("skills");
    }
    PathBuf::from(".claude").join("skills")
}

const BUNDLED_PIPELINE_SKILLS: &[&str] = &["tx-pipeline-stage-handoff", "tx-pipeline-reviewer"];

/// Pure helper exposed for testing. Real `install_skills_inner` calls this with
/// the resolved bundle dir + the user's `~/.claude/skills/` dir.
fn install_skills_with_paths(bundle_dir: &Path, target_dir: &Path) -> InstallSkillsResult {
    let _ = std::fs::create_dir_all(target_dir);
    let mut installed = Vec::new();
    let mut already = Vec::new();
    let mut errors = Vec::new();

    for skill in BUNDLED_PIPELINE_SKILLS {
        let target_skill_dir = target_dir.join(skill);
        if target_skill_dir.join("SKILL.md").exists() {
            already.push((*skill).to_string());
            continue;
        }

        let source_skill_dir = bundle_dir.join(skill);
        if !source_skill_dir.exists() {
            errors.push(format!("bundle missing for {skill}"));
            continue;
        }

        match copy_dir_recursive(&source_skill_dir, &target_skill_dir) {
            Ok(()) => installed.push((*skill).to_string()),
            Err(e) => errors.push(format!("install {skill}: {e}")),
        }
    }

    InstallSkillsResult {
        skills_dir: target_dir.to_string_lossy().to_string(),
        installed,
        already_present: already,
        errors,
        stub: false,
    }
}

/// Copy a directory and its contents recursively. Skips symlinks (defensive).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn install_skills_inner(app: &tauri::AppHandle) -> Result<InstallSkillsResult, String> {
    let bundle_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("resources")
        .join("skills");
    let target = skills_dir();
    Ok(install_skills_with_paths(&bundle_dir, &target))
}

#[tauri::command]
pub fn pipeline_install_skills(app: tauri::AppHandle) -> Result<InstallSkillsResult, String> {
    install_skills_inner(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn install_skills_stub_returns_metadata() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        let res = install_skills_with_paths(bundle.path(), target.path());
        assert!(!res.stub);
        assert!(!res.skills_dir.is_empty());
    }

    #[test]
    fn install_skills_installs_missing_skill_from_bundle() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        // Seed the full bundle so the happy-path install has no errors.
        for skill in BUNDLED_PIPELINE_SKILLS {
            let bundled_skill = bundle.path().join(skill);
            fs::create_dir_all(&bundled_skill).unwrap();
            fs::write(
                bundled_skill.join("SKILL.md"),
                format!("---\nname: {skill}\n---\n# test\n"),
            )
            .unwrap();
        }

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res
            .installed
            .contains(&"tx-pipeline-stage-handoff".to_string()));
        assert!(res.already_present.is_empty());
        assert!(res.errors.is_empty());
        assert!(target
            .path()
            .join("tx-pipeline-stage-handoff/SKILL.md")
            .exists());
        assert!(!res.stub);
    }

    #[test]
    fn install_skills_skips_already_present_skill() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::write(bundled_skill.join("SKILL.md"), "v1").unwrap();

        let existing = target.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("SKILL.md"), "user-edit").unwrap();

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res.installed.is_empty());
        assert_eq!(
            res.already_present,
            vec!["tx-pipeline-stage-handoff".to_string()]
        );
        let preserved = fs::read_to_string(existing.join("SKILL.md")).unwrap();
        assert_eq!(preserved, "user-edit");
    }

    #[test]
    fn install_skills_records_error_when_bundle_missing() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        // No skills in bundle

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert!(res.installed.is_empty());
        assert!(res.already_present.is_empty());
        assert_eq!(res.errors.len(), BUNDLED_PIPELINE_SKILLS.len());
    }

    #[test]
    fn install_skills_handles_partial_bundle() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::write(bundled_skill.join("SKILL.md"), "ok").unwrap();

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert_eq!(res.installed, vec!["tx-pipeline-stage-handoff".to_string()]);
        assert_eq!(res.errors.len(), BUNDLED_PIPELINE_SKILLS.len() - 1);
    }
}
