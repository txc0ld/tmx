//! SHA-256 verification of bundled skill content vs build-time hashes.
//!
//! Tamper-detection layer: the Tauri binary is already codesigned for
//! distribution (macOS notarization / Windows Authenticode), so this
//! catches post-extraction edits to the bundled `resources/skills/`
//! payload — not adversarial signing-key compromise.
//!
//! Phase 2c-ii.5. Adapted from the spec's "ed25519 with TerminalX release
//! key" because TerminalX has no key-management infra yet; full signing
//! lands in a future phase.

use sha2::{Digest, Sha256};

include!(concat!(env!("OUT_DIR"), "/skill_hashes.rs"));

/// Look up the build-time SHA-256 hex digest for a bundled skill.
pub fn expected_hash(skill: &str) -> Option<&'static str> {
    SKILL_HASHES
        .iter()
        .find(|(n, _)| *n == skill)
        .map(|(_, h)| *h)
}

/// Compute a lowercase-hex SHA-256 digest of `content`.
pub fn compute_hash(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

/// Verify that `content` matches the build-time hash for `skill`.
///
/// Returns `Err(...)` if the skill is unknown (not bundled at build time)
/// or the bytes don't match. Callers should surface the error to the user
/// (per-skill skip) rather than crashing the install batch.
pub fn verify_skill(skill: &str, content: &[u8]) -> Result<(), String> {
    let expected = expected_hash(skill).ok_or_else(|| {
        format!("no expected hash for skill '{skill}' (was it bundled at build time?)")
    })?;
    let actual = compute_hash(content);
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "skill '{skill}' content hash mismatch — expected {expected}, got {actual}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_bundled_skill(name: &str) -> Vec<u8> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("skills")
            .join(name)
            .join("SKILL.md");
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    #[test]
    fn compute_hash_is_64_char_lower_hex() {
        let h = compute_hash(b"hello");
        assert_eq!(h.len(), 64, "sha256 hex digest is 64 chars: {h}");
        assert!(
            h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "lowercase hex only: {h}"
        );
    }

    #[test]
    fn compute_hash_is_deterministic() {
        let a = compute_hash(b"the quick brown fox");
        let b = compute_hash(b"the quick brown fox");
        assert_eq!(a, b);
    }

    #[test]
    fn compute_hash_differs_for_different_inputs() {
        let a = compute_hash(b"hello");
        let b = compute_hash(b"hellp");
        assert_ne!(a, b);
    }

    #[test]
    fn verify_skill_ok_for_bundled_handoff() {
        let bytes = read_bundled_skill("tx-pipeline-stage-handoff");
        verify_skill("tx-pipeline-stage-handoff", &bytes).expect("bundled bytes match build hash");
    }

    #[test]
    fn verify_skill_ok_for_bundled_reviewer() {
        let bytes = read_bundled_skill("tx-pipeline-reviewer");
        verify_skill("tx-pipeline-reviewer", &bytes).expect("bundled bytes match build hash");
    }

    #[test]
    fn verify_skill_err_on_tampered_content() {
        let mut bytes = read_bundled_skill("tx-pipeline-stage-handoff");
        // Flip a byte to force a mismatch. Append works too — any change.
        bytes.push(b'!');
        let err = verify_skill("tx-pipeline-stage-handoff", &bytes).unwrap_err();
        assert!(err.contains("hash mismatch"), "got: {err}");
    }

    #[test]
    fn verify_skill_err_for_unknown_skill() {
        let err = verify_skill("not-a-real-skill", b"whatever").unwrap_err();
        assert!(err.contains("no expected hash"), "got: {err}");
    }

    #[test]
    fn expected_hash_returns_some_for_bundled_none_for_unknown() {
        assert!(expected_hash("tx-pipeline-stage-handoff").is_some());
        assert!(expected_hash("tx-pipeline-reviewer").is_some());
        assert!(expected_hash("does-not-exist").is_none());
    }
}
