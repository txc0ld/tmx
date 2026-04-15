# Hardening Changelog

Date: 2026-04-15

## Security

- Hardened `src-tauri/src/commands/http_proxy.rs`:
  - DNS-resolves hostnames and blocks HTTPS targets resolving to private, loopback, link-local, multicast, unspecified, broadcast, or CGNAT addresses.
  - Restricts plaintext HTTP to loopback destinations.
  - Disables redirects so validated URLs cannot redirect into private networks.
  - Adds an explicit HTTP method allowlist.
  - Rejects hop-by-hop/proxy headers such as `Host`, `Content-Length`, `Transfer-Encoding`, and proxy auth headers.
- Hardened `src-tauri/src/commands/filesystem.rs`:
  - Blocks writes through existing symlinks.
  - Caps text writes at 10 MB to match read-side expectations.
  - Canonicalizes watched directories and enforces the allowed-root policy before starting filesystem watchers.
- Hardened `src/components/tiles/SshTile.tsx`:
  - Validates SSH usernames and hosts.
  - Adds `--` before the SSH destination to prevent option interpretation.
- Hardened `src/stores/mcpStore.ts`:
  - Validates and encodes GitHub repo paths, Slack channel IDs, Jira hosts/ticket URLs, and Notion database IDs before sending requests through the proxy.
- Removed tracked local Claude state:
  - Deleted `.claude/settings.local.json`.
  - Deleted `.claude/scheduled_tasks.lock`.
  - Added `.claude/` to `.gitignore`.

## Correctness

- Fixed `src/components/tiles/EditorTile.tsx` autosave race:
  - Pending saves are cleared when `filePath` changes.
  - Debounced writes capture the path at edit time and only write if the editor is still on that file.
- Fixed `src/components/tiles/RunnerTile.tsx` completion semantics:
  - Runner commands now write a shell script that records an exit marker and exits.
  - Pass/fail status now uses the explicit `__TX_EXIT:<code>` marker when available.
- Fixed `src/components/tiles/AgentTile.tsx` context pipe offsets:
  - Pipe offsets are now stored as absolute next positions, preventing repeated pipes from skipping unread output.
- Fixed `src/components/palette/CommandPalette.tsx` keyboard navigation:
  - Arrow key handlers now ignore empty result sets instead of computing modulo zero.
- Cleaned native dead-code warnings:
  - Removed the unused `PtySession` struct and stale PTY helper methods.
  - Removed unused imports in Rust modules.

## Resilience

- Added global startup/runtime logging in `src/main.tsx`:
  - Logs global script errors.
  - Logs unhandled promise rejections.
  - Replaces the non-null root assertion with an explicit root check.
- Hardened `src-tauri/src/commands/workspace.rs`:
  - Adds 10 MB workspace/snapshot JSON caps on read and write.
  - Adds a Windows-compatible rename fallback for existing workspace files.
  - Cleans up temporary files on failed writes.
- Hardened `src-tauri/src/commands/projects.rs`:
  - Adds project count and JSON size caps.
  - Validates project IDs, names, icons, colors, descriptions, cwd values, git URLs, and branches.
  - Rejects duplicate project IDs.
  - Uses atomic writes.
- Updated `src/stores/usageStore.ts`:
  - OpenUsage requests now use the Rust `httpFetch` proxy instead of direct `fetch()`.
  - Invalid OpenUsage payloads are rejected.

## DevEx

- Added `.env.example` documenting that TerminalX has no required build-time secrets and that service tokens are entered in-app.
- Expanded `.gitignore` for local environment files, `.claude/`, website build output, coverage, and TypeScript build metadata.
- Added `.githooks/pre-commit` to run:
  - `pnpm test`
  - `pnpm build`
  - `cargo check` when Cargo is available
- Added `scripts/install-git-hooks.ps1`.
- Added `pnpm hooks:install` script.
- Removed the zero-byte orphan `package.json.tmp`.

## Tests

- Added `src/test/mcpStore.test.ts` covering MCP URL builder validation and encoding.
- Verified:
  - `pnpm test`: 67 passing tests.
  - `pnpm build`: passing, with existing Vite chunk warnings.
  - `cargo check`: passing, warning-free.
  - `cargo test`: passing harnesses, no Rust unit tests yet.
  - `pnpm audit --audit-level moderate`: no known vulnerabilities.

## Deferred Follow-Up

- Add Rust unit tests for filesystem, HTTP proxy, project, and workspace validators.
- Add main app CI for `pnpm test`, `pnpm build`, `cargo check`, and `cargo test`.
- Reduce Vite bundle size and resolve static/dynamic import overlap.
- Tighten CSP by removing `unsafe-eval` and `unsafe-inline` after Monaco/style compatibility work.
- Add formal discriminated-union validation for workspace import.
- Update README/FEATURES/AGENTS and add the missing `DESIGN.md`.
- Run `cargo audit` after installing `cargo-audit`.
