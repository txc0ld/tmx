# Security Policy

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Report privately by either:

1. **GitHub Private Vulnerability Reporting** — preferred.
   [Open an advisory](https://github.com/txc0ld/tmx/security/advisories/new)
   on this repository. Only maintainers see it until it's published.

2. **Email** — `connect@fantomlabs.io` with subject line
   `[SECURITY] <short description>`. PGP key available on request.

Please include:

- TerminalX version (`Help → About` or `package.json` version)
- OS + version (Windows / macOS / Linux distro)
- Steps to reproduce (minimal repro preferred)
- Impact assessment (what an attacker could do)
- Suggested fix, if you have one

We'll acknowledge within **3 business days** and aim for a fix or
mitigation within **30 days** for high-severity issues. You'll be
credited in the advisory unless you request otherwise.

## Supported Versions

TerminalX is pre-1.0. Only the latest `0.x` release receives security
fixes. Upgrade aggressively.

## Scope

In scope:

- The Tauri app binary and its Rust IPC surface (`src-tauri/src/commands/**`)
- The HTTP proxy (`http_fetch`) and its SSRF guards
- The MCP token storage path (keychain + localStorage migration)
- Subprocess spawning (PTY, agent CLIs, git, docker)
- Filesystem access controls (`is_path_allowed`)

Out of scope:

- The Formspree-hosted early-access form on the website
- Third-party agent CLIs (Claude Code, Codex, Gemini) — report to their vendors
- Denial-of-service from local resource exhaustion (infinite loops in a
  tile, etc.) — TerminalX is a local app; the attacker model is remote

## Known Hardening

- HTTP proxy blocks RFC 1918, CGNAT, link-local, loopback, multicast,
  IPv6 ULA, and URL credentials. DNS-pinned client prevents rebinding.
- Git clone disables `ext::` / `transport::` remote helpers.
- MCP tokens stored in OS keychain (Keychain / Credential Manager /
  Secret Service) — never in `localStorage`.
- Tauri capabilities deny `.env`, `.ssh/**`, `.aws/**`,
  `.config/gcloud/**`. CSP has no `'unsafe-inline'` in `script-src`.
- Shell spawn uses an allowlist; agent spawn uses a separate
  internal path with arg validation (null bytes + 16 KB cap).

If you find a gap, please report it via the channels above.
