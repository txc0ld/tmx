//! OS keychain bridge for MCP tokens and other sensitive values.
//!
//! Frontend stores connector IDs + non-secret config in localStorage, and
//! calls these commands to set/get/delete the actual token values via the
//! user's OS keychain (macOS Keychain, Windows Credential Manager, Linux
//! Secret Service). An XSS in the webview can reach `localStorage` but
//! not the keychain — that's the threat model this closes.
//!
//! Account naming convention (enforced here): `<scope>:<subject>:<field>`.
//! Example: `mcp:github-abc123:token`. Scope + subject combination is
//! unique per secret; keeps names predictable and collision-free.

use keyring::Entry;

const SERVICE: &str = "com.fantomlabs.terminalx";

fn validate_account(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 512 {
        return Err("Secret account must be 1-512 chars".to_string());
    }
    if account.contains('\0') {
        return Err("Secret account contains null byte".to_string());
    }
    // Allow ASCII alphanumerics + `.-_:/` (common ID shapes).
    for ch in account.chars() {
        if !ch.is_ascii_alphanumeric() && !matches!(ch, '.' | '-' | '_' | ':' | '/') {
            return Err(format!("Invalid character in secret account: '{}'", ch));
        }
    }
    Ok(())
}

fn entry(account: &str) -> Result<Entry, String> {
    validate_account(account)?;
    Entry::new(SERVICE, account).map_err(|e| format!("Keychain open error: {}", e))
}

/// Write or replace a secret.
///
/// Value is stored in the OS keychain under `service = com.fantomlabs.terminalx`,
/// `user = account`. Returns an error if the platform's keychain is locked
/// or unavailable (e.g., no Secret Service on a minimal Linux box).
#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    if value.len() > 16 * 1024 {
        return Err("Secret value too large (16 KB cap)".to_string());
    }
    let e = entry(&account)?;
    e.set_password(&value).map_err(|e| format!("Keychain write error: {}", e))
}

/// Read a secret. Returns `None` if no entry exists — distinct from an
/// actual error (locked keychain, permissions, etc.).
#[tauri::command]
pub async fn secret_get(account: String) -> Result<Option<String>, String> {
    let e = entry(&account)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Keychain read error: {}", err)),
    }
}

/// Delete a secret. Silently succeeds if the entry didn't exist — a
/// delete-idempotent API is easier for the frontend migration loop to
/// reason about than one that errors on missing.
#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    let e = entry(&account)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Keychain delete error: {}", err)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_accepts_expected_shapes() {
        assert!(validate_account("mcp:github-abc/123:token").is_ok());
        assert!(validate_account("mcp:slack_conn.1:apiKey").is_ok());
        assert!(validate_account("x").is_ok());
    }

    #[test]
    fn account_rejects_bad_input() {
        assert!(validate_account("").is_err(), "empty rejected");
        assert!(validate_account("with space").is_err(), "space rejected");
        assert!(validate_account("bad\0byte").is_err(), "null byte rejected");
        assert!(validate_account("shell;injection").is_err(), "semicolon rejected");
        assert!(validate_account(&"a".repeat(513)).is_err(), "too long rejected");
    }
}
