//! `pipeline_install_skills` — copy bundled SKILL.md files into ~/.claude/skills/.
//! `pipeline_skill_status` — list bundled skills with installed + hash-match flags.
//! `pipeline_force_install_skill` — delete + reinstall a single bundled skill.

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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillStatus {
    pub name: String,
    /// True iff `~/.claude/skills/<name>/SKILL.md` exists and is readable.
    pub installed: bool,
    /// True iff the installed bytes match the build-time hash. Only meaningful
    /// when `installed` is true; reported as `false` for missing skills.
    pub hash_ok: bool,
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

pub(super) const BUNDLED_PIPELINE_SKILLS: &[&str] =
    &["tx-pipeline-stage-handoff", "tx-pipeline-reviewer"];

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

        // Verify the bundled SKILL.md hash matches what the build saw before
        // we copy it into the user's skills dir. Per-skill skip on mismatch
        // (don't fail the whole batch).
        let source_skill_md = source_skill_dir.join("SKILL.md");
        match std::fs::read(&source_skill_md) {
            Ok(bytes) => {
                if let Err(e) = super::skill_provenance::verify_skill(skill, &bytes) {
                    errors.push(format!("verify {skill}: {e}"));
                    continue;
                }
            }
            Err(e) => {
                errors.push(format!("read {skill}/SKILL.md: {e}"));
                continue;
            }
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

// ─── Skill status (Phase 3a.4) ────────────────────────────────────────

/// Pure helper for testing: report per-skill installed + hash-match using the
/// caller-supplied skills root (i.e. `~/.claude/skills/`).
fn skill_status_with_dir(target_dir: &Path) -> Vec<SkillStatus> {
    BUNDLED_PIPELINE_SKILLS
        .iter()
        .map(|name| {
            let skill_md = target_dir.join(name).join("SKILL.md");
            match std::fs::read(&skill_md) {
                Ok(bytes) => SkillStatus {
                    name: (*name).to_string(),
                    installed: true,
                    hash_ok: super::skill_provenance::verify_skill(name, &bytes).is_ok(),
                },
                Err(_) => SkillStatus {
                    name: (*name).to_string(),
                    installed: false,
                    hash_ok: false,
                },
            }
        })
        .collect()
}

#[tauri::command]
pub fn pipeline_skill_status() -> Result<Vec<SkillStatus>, String> {
    Ok(skill_status_with_dir(&skills_dir()))
}

// ─── Force-install one skill (Phase 3a.4) ─────────────────────────────

/// Pure helper for testing. Deletes `<target>/<skill>` if present, then copies
/// the bundle entry across (verifying the hash before copy, identical to
/// `install_skills_with_paths`).
fn force_install_skill_with_paths(
    bundle_dir: &Path,
    target_dir: &Path,
    skill: &str,
) -> Result<(), String> {
    if !BUNDLED_PIPELINE_SKILLS.iter().any(|s| *s == skill) {
        return Err(format!("unknown skill '{skill}' (not bundled)"));
    }

    let target_skill_dir = target_dir.join(skill);
    let source_skill_dir = bundle_dir.join(skill);
    let source_skill_md = source_skill_dir.join("SKILL.md");

    // Verify the bundled bytes match the build-time hash before we touch the
    // user's filesystem. Mirror the order from `install_skills_with_paths` so
    // a tampered bundle never deletes the user's working copy.
    let bytes = std::fs::read(&source_skill_md)
        .map_err(|e| format!("read bundle {skill}/SKILL.md: {e}"))?;
    super::skill_provenance::verify_skill(skill, &bytes)
        .map_err(|e| format!("verify {skill}: {e}"))?;

    // Wipe the existing install (if any). `remove_dir_all` returns NotFound
    // when nothing is there; treat that as a no-op.
    if target_skill_dir.exists() {
        std::fs::remove_dir_all(&target_skill_dir)
            .map_err(|e| format!("remove {skill}: {e}"))?;
    }

    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("create skills dir: {e}"))?;

    copy_dir_recursive(&source_skill_dir, &target_skill_dir)
        .map_err(|e| format!("install {skill}: {e}"))?;

    Ok(())
}

fn force_install_skill_inner(app: &tauri::AppHandle, skill: &str) -> Result<(), String> {
    let bundle_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?
        .join("resources")
        .join("skills");
    force_install_skill_with_paths(&bundle_dir, &skills_dir(), skill)
}

#[tauri::command]
pub fn pipeline_force_install_skill(
    app: tauri::AppHandle,
    skill_name: String,
) -> Result<(), String> {
    force_install_skill_inner(&app, &skill_name)
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

    /// Copy the real bundled `resources/skills/<name>/SKILL.md` into a temp
    /// bundle dir. The install function now verifies content against
    /// build-time hashes, so synthetic test content fails the check —
    /// tests must seed with the real bytes.
    fn seed_real_bundle(bundle: &Path) {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for skill in BUNDLED_PIPELINE_SKILLS {
            let src = manifest_dir.join("resources").join("skills").join(skill).join("SKILL.md");
            let bundled_skill = bundle.join(skill);
            fs::create_dir_all(&bundled_skill).unwrap();
            fs::copy(&src, bundled_skill.join("SKILL.md")).unwrap();
        }
    }

    #[test]
    fn install_skills_installs_missing_skill_from_bundle() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        seed_real_bundle(bundle.path());

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
        // Seed only one skill from the real bundle — the other should record
        // a missing-bundle error.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let src = manifest_dir.join("resources/skills/tx-pipeline-stage-handoff/SKILL.md");
        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::copy(&src, bundled_skill.join("SKILL.md")).unwrap();

        let res = install_skills_with_paths(bundle.path(), target.path());

        assert_eq!(res.installed, vec!["tx-pipeline-stage-handoff".to_string()]);
        assert_eq!(res.errors.len(), BUNDLED_PIPELINE_SKILLS.len() - 1);
    }

    // ─── skill_status_with_dir (Phase 3a.4) ───────────────────────────

    #[test]
    fn skill_status_reports_not_installed_when_dir_empty() {
        let target = tempdir().unwrap();
        let res = skill_status_with_dir(target.path());
        assert_eq!(res.len(), BUNDLED_PIPELINE_SKILLS.len());
        for s in &res {
            assert!(!s.installed, "skill {} should be not-installed", s.name);
            assert!(!s.hash_ok, "skill {} hash_ok must be false when missing", s.name);
        }
    }

    #[test]
    fn skill_status_reports_hash_ok_for_real_bundle_bytes() {
        let target = tempdir().unwrap();
        // Seed real bundle bytes into the "installed" location, mirroring what
        // `pipeline_install_skills` would have produced.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for skill in BUNDLED_PIPELINE_SKILLS {
            let installed = target.path().join(skill);
            fs::create_dir_all(&installed).unwrap();
            let src = manifest_dir
                .join("resources/skills")
                .join(skill)
                .join("SKILL.md");
            fs::copy(&src, installed.join("SKILL.md")).unwrap();
        }

        let res = skill_status_with_dir(target.path());
        for s in &res {
            assert!(s.installed, "{} should be installed", s.name);
            assert!(s.hash_ok, "{} hash should match bundled", s.name);
        }
    }

    #[test]
    fn skill_status_reports_hash_mismatch_for_user_edited_file() {
        let target = tempdir().unwrap();
        let installed = target.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "user-edited content").unwrap();

        let res = skill_status_with_dir(target.path());
        let handoff = res
            .iter()
            .find(|s| s.name == "tx-pipeline-stage-handoff")
            .unwrap();
        assert!(handoff.installed);
        assert!(!handoff.hash_ok, "user-edited content must trip hash_ok=false");
    }

    // ─── force_install_skill_with_paths (Phase 3a.4) ──────────────────

    #[test]
    fn force_install_overwrites_existing_user_edited_skill() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        seed_real_bundle(bundle.path());

        // Pre-existing user-edit at the install target — force-install must
        // wipe it.
        let installed = target.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "user-edit").unwrap();

        force_install_skill_with_paths(
            bundle.path(),
            target.path(),
            "tx-pipeline-stage-handoff",
        )
        .expect("force-install should succeed");

        // After force-install, the file content should match the bundle hash.
        let bytes = fs::read(installed.join("SKILL.md")).unwrap();
        super::super::skill_provenance::verify_skill("tx-pipeline-stage-handoff", &bytes)
            .expect("post-install bytes match build hash");
    }

    #[test]
    fn force_install_creates_when_not_present() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        seed_real_bundle(bundle.path());

        force_install_skill_with_paths(
            bundle.path(),
            target.path(),
            "tx-pipeline-reviewer",
        )
        .expect("force-install should succeed for missing skill");

        assert!(target.path().join("tx-pipeline-reviewer/SKILL.md").exists());
    }

    #[test]
    fn force_install_rejects_unknown_skill_name() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        let err = force_install_skill_with_paths(
            bundle.path(),
            target.path(),
            "../etc/passwd",
        )
        .unwrap_err();
        assert!(err.contains("unknown skill"), "got: {err}");
    }

    #[test]
    fn force_install_refuses_tampered_bundle_and_preserves_target() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();

        // Bundle contains tampered content for the skill.
        let bundled = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled).unwrap();
        fs::write(bundled.join("SKILL.md"), "tampered").unwrap();

        // Pre-existing target install we want to make sure stays put.
        let installed = target.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "existing-good").unwrap();

        let err = force_install_skill_with_paths(
            bundle.path(),
            target.path(),
            "tx-pipeline-stage-handoff",
        )
        .unwrap_err();
        assert!(err.contains("hash mismatch") || err.contains("verify"), "got: {err}");

        // Critically: we must not have wiped the user's existing copy.
        let preserved = fs::read_to_string(installed.join("SKILL.md")).unwrap();
        assert_eq!(preserved, "existing-good");
    }

    #[test]
    fn install_skills_refuses_tampered_bundle_content() {
        let bundle = tempdir().unwrap();
        let target = tempdir().unwrap();
        // Seed with content that does NOT match the build-time hash.
        let bundled_skill = bundle.path().join("tx-pipeline-stage-handoff");
        fs::create_dir_all(&bundled_skill).unwrap();
        fs::write(bundled_skill.join("SKILL.md"), "definitely tampered content").unwrap();
        // Other skill missing entirely (already covered above; we focus on tamper here).
        let res = install_skills_with_paths(bundle.path(), target.path());

        // Tampered skill should not have been installed.
        assert!(!res.installed.iter().any(|s| s == "tx-pipeline-stage-handoff"));
        // An error mentioning the hash mismatch should be present.
        assert!(res.errors.iter().any(|e| e.contains("hash mismatch")), "expected hash-mismatch error in {:?}", res.errors);
        // Target dir should not have the skill installed.
        assert!(!target.path().join("tx-pipeline-stage-handoff/SKILL.md").exists());
    }
}
