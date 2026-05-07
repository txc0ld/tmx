//! Secret masking for telemetry, failure bundles, and webhook payloads.
//!
//! Pure function `mask_secrets(s)` returns `s` with detected secrets replaced
//! by `<MASKED:abc123>` where `abc123` is the first 6 hex chars of
//! SHA-256(matched_text). Identical secrets get identical masks so log
//! readers can correlate occurrences ("this masked value here is the same
//! one as over there") without leaking the secret itself. PEM blocks
//! collapse to `<MASKED:PEM>` (the body is too variable to hash usefully
//! and is multi-line — the literal mask reads better in JSONL).
//!
//! Detection rules, applied in order, non-overlapping:
//!   1. PEM blocks (`-----BEGIN [TYPE]-----…-----END [TYPE]-----`).
//!   2. Known-prefix tokens (sk-…, ghp_…, gho_…, xoxb-/xoxp-, AKIA…/ASIA…,
//!      AIza…, ya29.…, glpat-…).
//!   3. High-entropy values (≥24 chars, Shannon entropy ≥4.5 bits/char) in
//!      env-shaped contexts (`KEY=VALUE`, `"key": "VALUE"`, `key: VALUE`).
//!      Excludes pure-hex (git SHAs, Cargo.lock checksums) and lock-file
//!      integrity hashes (`sha\d+-…`) which are high-entropy by definition
//!      but legitimate.
//!
//! False negatives leak secrets into telemetry — bad. False positives mask
//! legitimate hex content (git SHAs, package-lock checksums) making
//! debugging impossible — also bad. The exclusions in rule 3 are deliberate
//! and tested.

use regex::Regex;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const MIN_ENTROPY_BITS_PER_CHAR: f64 = 4.5;
const MIN_ENTROPY_LEN: usize = 24;

/// 6-char hex prefix of SHA-256(s). Stable across calls so identical
/// secrets get identical masks.
fn hash6(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let digest = h.finalize();
    let hex = format!("{:x}", digest);
    hex[..6].to_string()
}

fn shannon_entropy(s: &str) -> f64 {
    let len = s.len() as f64;
    if len == 0.0 {
        return 0.0;
    }
    let mut counts = [0u64; 256];
    for &b in s.as_bytes() {
        counts[b as usize] += 1;
    }
    let mut h = 0.0_f64;
    for &c in counts.iter() {
        if c > 0 {
            let p = c as f64 / len;
            h -= p * p.log2();
        }
    }
    h
}

fn is_pure_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Lock-file integrity hashes: `sha512-…`, `sha256-…`, etc. They're base64
/// payloads with high entropy but are not secrets.
fn is_lockfile_integrity(s: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^sha\d+-").unwrap());
    re.is_match(s)
}

/// Patterns for known-prefix secrets. Each pattern matches the entire token
/// (including the prefix) — the whole match is replaced by `<MASKED:hash6>`.
fn prefix_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        // Order is incidental — the regexes don't overlap (each anchors on a
        // distinct sentinel prefix). Use \b before each to avoid matching
        // mid-identifier (so `xsk-…` in a longer string doesn't false-match
        // `sk-…`). For tokens that start with chars that aren't word-class
        // continuations of the preceding char (e.g. `-` in xoxb-), \b still
        // anchors correctly on the leading alphanumeric prefix.
        vec![
            // OpenAI: real keys are 51 chars after `sk-`; require ≥20 for
            // forward-compat with future formats.
            Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}").unwrap(),
            // GitHub PAT / OAuth tokens: 36 char body after `ghp_`/`gho_`/
            // `ghu_`/`ghs_`/`ghr_`. Be liberal on the prefix family.
            Regex::new(r"\bgh[psour]_[A-Za-z0-9]{36,}").unwrap(),
            // Slack bot/user tokens.
            Regex::new(r"\bxox[bpars]-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+").unwrap(),
            // AWS access keys (AKIA = long-term, ASIA = STS short-term).
            Regex::new(r"\bA(?:KIA|SIA)[0-9A-Z]{16}").unwrap(),
            // Google API keys: AIza + 35 chars.
            Regex::new(r"\bAIza[0-9A-Za-z_-]{35}").unwrap(),
            // Google OAuth access tokens: ya29.<arbitrary>.
            Regex::new(r"\bya29\.[0-9A-Za-z._-]+").unwrap(),
            // GitLab PATs.
            Regex::new(r"\bglpat-[0-9A-Za-z_-]{20,}").unwrap(),
        ]
    })
}

/// Env-shaped value capture regexes. Each captures the secret-shaped VALUE
/// in capture group 1; the rest of the match stays as-is (so we replace
/// only the VALUE span, not the `KEY=` prefix).
fn env_value_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            // KEY=VALUE shell shape — VALUE runs to whitespace/quote/end.
            // The KEY portion: at least one identifier-shape char + `=`,
            // optionally preceded by `export `.
            Regex::new(r#"(?m)\b[A-Za-z_][A-Za-z0-9_]*=([A-Za-z0-9+/=_\-\.]+)"#).unwrap(),
            // JSON shape: "key": "VALUE"
            Regex::new(r#""[A-Za-z_][A-Za-z0-9_\-]*"\s*:\s*"([A-Za-z0-9+/=_\-\.]+)""#).unwrap(),
            // YAML shape: key: VALUE  (no quotes — the JSON case already
            // handles quoted values). Anchored to line start to avoid
            // matching things like "Last updated: 2026-01-01" mid-prose.
            Regex::new(r#"(?m)^\s*[A-Za-z_][A-Za-z0-9_\-]*:\s+([A-Za-z0-9+/=_\-\.]{2,})\s*$"#)
                .unwrap(),
        ]
    })
}

fn pem_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)-----BEGIN [A-Z ]+?-----.*?-----END [A-Z ]+?-----").unwrap())
}

/// True if `value` looks high-entropy enough to plausibly be a secret AND
/// isn't excluded by the negative-fixture rules.
fn looks_like_secret_value(value: &str) -> bool {
    if value.len() < MIN_ENTROPY_LEN {
        return false;
    }
    if is_pure_hex(value) {
        return false; // git SHAs, Cargo.lock checksums.
    }
    if is_lockfile_integrity(value) {
        return false; // sha512-…, sha256-… in lock files.
    }
    shannon_entropy(value) >= MIN_ENTROPY_BITS_PER_CHAR
}

/// Mask detected secrets in `input`. Returns a new string.
///
/// Rule order (non-overlapping):
///   1. PEM → `<MASKED:PEM>`.
///   2. Known-prefix tokens → `<MASKED:hash6>`.
///   3. Env-shaped high-entropy values → `<MASKED:hash6>` (only the VALUE
///      span is replaced; the `KEY=` / `"key": ` prefix is preserved).
///
/// Idempotent: `mask_secrets(mask_secrets(s)) == mask_secrets(s)` because
/// the replacement tokens (`<MASKED:…>`) don't match any of our detection
/// regexes (no known-prefix, no env shape, not a PEM block).
pub fn mask_secrets(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }

    // Rule 1: PEM blocks.
    let after_pem = pem_pattern().replace_all(input, "<MASKED:PEM>");

    // Rule 2: known-prefix tokens.
    let mut after_prefix = after_pem.into_owned();
    for re in prefix_patterns() {
        after_prefix = re
            .replace_all(&after_prefix, |caps: &regex::Captures| {
                let m = caps.get(0).unwrap().as_str();
                format!("<MASKED:{}>", hash6(m))
            })
            .into_owned();
    }

    // Rule 3: env-shaped high-entropy values. Replace only the VALUE
    // capture group (group 1), preserving the surrounding KEY=…/"key":…
    // chrome.
    let mut after_env = after_prefix;
    for re in env_value_patterns() {
        after_env = re
            .replace_all(&after_env, |caps: &regex::Captures| {
                let whole = caps.get(0).unwrap().as_str();
                let value = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                if !looks_like_secret_value(value) {
                    return whole.to_string();
                }
                let value_match = caps.get(1).unwrap();
                let start = value_match.start() - caps.get(0).unwrap().start();
                let end = value_match.end() - caps.get(0).unwrap().start();
                let mut out = String::with_capacity(whole.len());
                out.push_str(&whole[..start]);
                out.push_str(&format!("<MASKED:{}>", hash6(value)));
                out.push_str(&whole[end..]);
                out
            })
            .into_owned();
    }

    after_env
}

/// IPC entry point. Frontend calls `secretsMask(input)` for explicit masking
/// (failure bundle, webhook payload). The pipeline telemetry path also
/// applies masking server-side inside `pipeline_telemetry_log` so callers
/// can't forget.
#[tauri::command]
pub fn secrets_mask(input: String) -> Result<String, String> {
    Ok(mask_secrets(&input))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Positive tests (must mask) ────────────────────────────────

    #[test]
    fn masks_openai_sk_token() {
        let s = "OPENAI_API_KEY=sk-abc123XYZ_ZZZ-456789defghi please handle this";
        let out = mask_secrets(s);
        assert!(!out.contains("sk-abc123XYZ_ZZZ-456789defghi"), "secret leaked: {out}");
        assert!(out.contains("<MASKED:"), "no mask applied: {out}");
    }

    #[test]
    fn masks_github_ghp_token() {
        // 36-char body after ghp_.
        let token = "ghp_1234567890ABCDEFabcdef1234567890ABCDef";
        let s = format!("token: {token} (used for API)");
        let out = mask_secrets(&s);
        assert!(!out.contains(token), "secret leaked: {out}");
        assert!(out.contains("<MASKED:"));
    }

    #[test]
    fn masks_github_gho_token() {
        let token = "gho_abcdefghij1234567890ABCDEFGHIJ1234567890";
        let out = mask_secrets(&format!("seen {token} here"));
        assert!(!out.contains(token));
        assert!(out.contains("<MASKED:"));
    }

    #[test]
    fn masks_slack_xoxb_token() {
        let token = "xoxb-12345-67890-11111-aBcDeFgHiJkLmNoPqRsTuVwX";
        let out = mask_secrets(&format!("Slack bot token: {token}"));
        assert!(!out.contains(token));
        assert!(out.contains("<MASKED:"));
    }

    #[test]
    fn masks_aws_akia_access_key() {
        let key = "AKIAIOSFODNN7EXAMPLE";
        let out = mask_secrets(&format!("AWS_ACCESS_KEY_ID={key}"));
        assert!(!out.contains(key));
        assert!(out.contains("<MASKED:"));
    }

    #[test]
    fn masks_aws_asia_access_key() {
        let key = "ASIAIOSFODNN7EXAMPLE";
        let out = mask_secrets(&format!("creds: {key} (sts session)"));
        assert!(!out.contains(key));
    }

    #[test]
    fn masks_google_aiza_api_key() {
        let key = "AIzaSyA-1234567890abcdefghijklmnopqrstuvw"; // 35 char body
        let out = mask_secrets(&format!("config: {key}"));
        assert!(!out.contains(key), "leaked: {out}");
        assert!(out.contains("<MASKED:"));
    }

    #[test]
    fn masks_pem_block() {
        let pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\nggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----";
        let out = mask_secrets(pem);
        assert_eq!(out, "<MASKED:PEM>");
    }

    #[test]
    fn masks_pem_block_inline_in_text() {
        let pem = "before -----BEGIN RSA PRIVATE KEY-----\nbody\nbody2\n-----END RSA PRIVATE KEY----- after";
        let out = mask_secrets(pem);
        assert_eq!(out, "before <MASKED:PEM> after");
    }

    #[test]
    fn identical_secrets_get_identical_hashes() {
        let token = "ghp_1234567890ABCDEFabcdef1234567890ABCDef";
        let s = format!("first {token} and again {token} done");
        let out = mask_secrets(&s);
        assert!(!out.contains(token));
        // Find both <MASKED:...> occurrences and compare them.
        let masks: Vec<&str> = out
            .split("<MASKED:")
            .skip(1)
            .map(|chunk| chunk.split('>').next().unwrap())
            .collect();
        assert_eq!(masks.len(), 2, "expected two masks: {out}");
        assert_eq!(masks[0], masks[1], "identical secrets should produce identical hashes");
    }

    #[test]
    fn masks_env_shaped_high_entropy_value() {
        // 32 char base64-ish, mixed case, mixed digits — high entropy,
        // not pure hex, not sha-prefixed.
        let val = "AbCd1234EfGh5678IjKl9012MnOp3456";
        let out = mask_secrets(&format!("API_TOKEN={val}"));
        assert!(!out.contains(val), "leaked: {out}");
        assert!(out.starts_with("API_TOKEN=<MASKED:"));
    }

    #[test]
    fn masks_json_shaped_high_entropy_value() {
        let val = "AbCd1234EfGh5678IjKl9012MnOp3456";
        let out = mask_secrets(&format!(r#"{{"api_key": "{val}"}}"#));
        assert!(!out.contains(val), "leaked: {out}");
        assert!(out.contains("<MASKED:"));
    }

    // ─── Negative tests (must NOT mask) ────────────────────────────

    #[test]
    fn does_not_mask_git_sha_40_hex() {
        // Real git commit SHA: 40 lowercase hex chars. Pure-hex exclusion.
        let sha = "abc123def4567890abc123def4567890abcdef12";
        let s = format!("commit: {sha}");
        let out = mask_secrets(&s);
        assert_eq!(out, s, "git SHA was masked: {out}");
    }

    #[test]
    fn does_not_mask_lockfile_sha512_integrity() {
        // npm/pnpm-lock-style integrity hash. Has `sha512-` prefix.
        let val = "sha512-aBcDeF1234567890aBcDeF1234567890aBcDeF1234567890aBcDeF1234567890aBcDeF1234567890aBcDeFGGgg==";
        let s = format!(r#""integrity": "{val}""#);
        let out = mask_secrets(&s);
        assert_eq!(out, s, "lockfile integrity was masked: {out}");
    }

    #[test]
    fn does_not_mask_cargo_lock_checksum() {
        // 64-char lowercase hex. Pure-hex exclusion.
        let cs = "1234abcd5678ef901234abcd5678ef901234abcd5678ef901234abcd5678ef90";
        let s = format!(r#"checksum = "{cs}""#);
        let out = mask_secrets(&s);
        assert_eq!(out, s, "Cargo.lock checksum was masked: {out}");
    }

    #[test]
    fn does_not_mask_low_entropy_env_value() {
        // 30 'a's — long enough but entropy is 0.
        let s = "KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let out = mask_secrets(s);
        assert_eq!(out, s, "low-entropy value was masked: {out}");
    }

    #[test]
    fn does_not_mask_short_env_value() {
        // 8 chars, high entropy, but below MIN_ENTROPY_LEN.
        let s = "KEY=A1b2C3d4";
        let out = mask_secrets(s);
        assert_eq!(out, s, "short value was masked: {out}");
    }

    // ─── Idempotence + robustness ────────────────────────────────────

    #[test]
    fn idempotent_double_application() {
        let s = "OPENAI=sk-abc123XYZ_ZZZ-456789defghi and ghp_1234567890ABCDEFabcdef1234567890ABCDef plus AKIAIOSFODNN7EXAMPLE";
        let once = mask_secrets(s);
        let twice = mask_secrets(&once);
        assert_eq!(once, twice, "masking should be idempotent");
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(mask_secrets(""), "");
    }

    #[test]
    fn multiple_secret_kinds_all_masked() {
        let s = "sk-abc123XYZ_ZZZ-456789defghi AKIAIOSFODNN7EXAMPLE -----BEGIN KEY-----\nbody\n-----END KEY-----";
        let out = mask_secrets(s);
        assert!(!out.contains("sk-abc123"));
        assert!(!out.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(!out.contains("BEGIN KEY"));
        assert!(out.contains("<MASKED:PEM>"));
        // Two non-PEM masks (sk and AKIA) — count distinct <MASKED: occurrences.
        let count = out.matches("<MASKED:").count();
        assert_eq!(count, 3, "expected 3 masks: {out}");
    }

    #[test]
    fn does_not_mask_normal_prose() {
        let s = "This is a normal log line about request handling. Took 1.23s.";
        let out = mask_secrets(s);
        assert_eq!(out, s);
    }

    #[test]
    fn shannon_entropy_basic() {
        assert!((shannon_entropy("aaaa") - 0.0).abs() < 1e-9);
        // "ab" alternating: 1 bit/char.
        assert!((shannon_entropy("abab") - 1.0).abs() < 1e-9);
        // Random-ish 32-char string should be well above 4.5.
        assert!(shannon_entropy("AbCd1234EfGh5678IjKl9012MnOp3456") > 4.5);
    }

    #[test]
    fn pure_hex_helper() {
        assert!(is_pure_hex("abc123def456"));
        assert!(is_pure_hex("ABCDEF0123456789"));
        assert!(!is_pure_hex("abc123def456g")); // 'g' is not hex
        assert!(!is_pure_hex(""));
        assert!(!is_pure_hex("sha512-abc"));
    }

    #[test]
    fn hash6_is_stable_and_six_chars() {
        let a = hash6("hello");
        let b = hash6("hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(hash6("hello"), hash6("world"));
    }
}
