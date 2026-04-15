# HTTP Proxy (`http_fetch`)

> SSRF-hardened request path for all MCP traffic.

## What it is

A Rust IPC command (`http_fetch`) that all frontend-initiated HTTP requests route through. It exists for three reasons:

1. **CSP bypass.** WebView CSP blocks direct `fetch()` to most origins.
2. **CORS bypass.** Many MCP API endpoints don't return CORS headers.
3. **SSRF / rebinding defense.** Centralized guards block private IP ranges and pin DNS resolution.

## What it blocks

- Private IPs: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, CGNAT `100.64.0.0/10`, loopback, link-local, multicast.
- IPv6 equivalents: `::1`, `fc00::/7`, `fe80::/10`, multicast.
- URL credentials (`http://user:pass@host` form).
- `http://` to any non-loopback host (HTTPS-only for remote).
- Redirects follow: disabled — scripts can't bypass the validation by redirecting.
- Header hop-by-hop abuse: `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-*` are rejected.

## Tech notes

- **DNS pinning via `resolve_to_addrs`.** `validate_destination` resolves the hostname once and returns a `Vec<SocketAddr>`. The request client is built with `ClientBuilder::resolve_to_addrs(host, &addrs)` so the connect phase uses the same IP the validation approved — closes the DNS-rebind TOCTOU window.
- **Client pool.** `OnceLock<Mutex<HashMap<hostPort, CachedClient>>>` caches `reqwest::Client` instances per `host:port` with a 60 s TTL and 16-entry LRU. Reuses TLS connections across MCP syncs (saves 20-40 ms per request). Cache invalidates if resolved addresses drift.
- **Body caps.** 10 MB response cap, 5 MB request body cap. 15 s timeout.
- **Method allowlist.** GET / POST / PUT / DELETE / PATCH. Everything else returns 405.

## When to use

All MCP calls. The [`usageStore`](../tiles/usage.md)'s OpenUsage fetch. Plugin manifest fetches. Anywhere the frontend would otherwise call `fetch()` to an external domain.

**Do not use for IPC to Rust itself** — that's `invoke()` in `utils/ipc.ts`, not HTTP.

**Key files:** `src-tauri/src/commands/http_proxy.rs`, `src/utils/ipc.ts` (httpFetch wrapper).

## Related

- [MCP overview](./overview.md) · [Security posture](../platform/security.md) · [OpenUsage](./openusage.md)
