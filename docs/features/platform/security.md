# Security Posture

> What's hardened, what's intentionally permissive, and why.

## Threat model

TerminalX is a power-user desktop terminal with broad filesystem and process-spawn authority. The trust model is:

- **The user is trusted.** They're running the app locally and can install / configure anything.
- **The webview is semi-trusted.** Renderer compromise (XSS in plugin content, malicious MCP response) shouldn't translate to filesystem escape or arbitrary-command execution.
- **Remote hosts (MCP endpoints, git remotes, browser targets) are untrusted.** SSRF, rebind, and remote-helper-RCE attacks are in scope.

## Hardened boundaries

### Filesystem

- Path allowlist (`is_path_allowed`) covers power-user surfaces but rejects `/proc`, `/sys`, `/dev`, `/root`.
- Null-byte rejection on every input path.
- `write_file_text` refuses to overwrite through symlinks (prevents escape via allowed parent → blocked target).
- Directory watchers canonicalized + scope-checked before the notifier registers.

### PTY / shell

- Public `pty_spawn` goes through `SHELL_ALLOWLIST` — only `bash`, `zsh`, `sh`, `fish`, `powershell.exe`, `pwsh`, `cmd.exe`, `ssh`, `docker` and the user's own `$SHELL`.
- Internal `pty_spawn_internal` bypasses the allowlist — used by agent spawns (agents aren't shells). Path / arg validation still applies.
- Null-byte + leading-dash rejection on shell names.
- Custom command args (from user config) validated for null bytes + 16 KB length cap.

### Git

- `validate_git_url` rejects `ext::` / `transport::` remote helpers (CVE-class RCE on clone).
- Clone runs `git -c protocol.ext.allow=never -c protocol.file.allow=never clone -- <url> <dest>` — `--` stops flag parsing.
- Branch names validated against git refname rules (no `..`, `@{`, control chars).
- Loopback git hosts (`localhost`, `127.0.0.1`, `[::1]`) rejected — prevents local-server-as-git-remote RCE.

### HTTP / MCP

- `http_fetch` (see [http-proxy.md](../integrations/http-proxy.md)) is the only outbound-HTTP path.
- SSRF guards: RFC 1918 private, CGNAT, loopback, link-local, IPv6 ULA, multicast — all blocked for HTTPS; HTTP is loopback-only.
- DNS pinned at validation time via `resolve_to_addrs` — closes the rebind window between validate and connect.
- URL credentials (`http://user:pass@host`) rejected.
- Redirects disabled (`Policy::none()`).
- Header blocklist: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-Authorization`, `Proxy-Authenticate`.
- Response cap 10 MB, request body cap 5 MB, timeout 15 s.

### CSP (webview)

All allowances are load-bearing:

- `script-src 'unsafe-eval'` — **required** by Monaco's language tokenizers and worker bootstrap.
- `style-src 'unsafe-inline'` — **required** by Vite HMR `<style>` injection + xterm's runtime style tags.
- `frame-src https: http://localhost:*` — backs the Browser tile.
- `img-src https:` — agent-output image previews and browser-tile scraping.

No `'unsafe-inline'` in `script-src`. No `dangerouslySetInnerHTML` / `eval()` / `new Function()` in app source.

### Workspace import

- Discriminated-union schema validation (`src/utils/workspaceImport.ts`) on every import.
- Size caps: 5000 tiles, 10 000 wires, 65 K per string field, 2 MB per long string.
- Coord clamp, dim clamp, unknown-tile-type reject, dangerous URL-scheme reject, duplicate-ID reject, dangling-wire-endpoint reject.

## Known residual risk

- **DNS rebinding in the ~50 ms window after cache TTL.** The cache invalidates when resolved IPs drift, but a rebind during the first request after TTL expiry could theoretically slip through. Mitigation: the cache TTL is 60 s, and `resolve_to_addrs` pins the IP for every request.
- **Plugin sandbox.** `PluginTile` was removed as dead code. If resurrected, the iframe must stay `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`) and `postMessage` must target the plugin's exact origin.

## Tests

- 38 Rust unit tests cover `is_path_allowed`, SSRF IP classification, header blocklist, URL validation, project / workspace / git validators.
- 92 frontend tests cover workspace import validation + MCP URL builders.

**Key files:** `src-tauri/src/commands/*`, `src/utils/workspaceImport.ts`, `CONTRIBUTING.md` → Security posture section.

## Related

- [HTTP proxy](../integrations/http-proxy.md) · [PTY management](./pty-management.md) · [Filesystem access](./filesystem-access.md) · [Import / export](../persistence/import-export.md)
