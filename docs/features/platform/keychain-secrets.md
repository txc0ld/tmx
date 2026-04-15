# OS Keychain for Secrets

> MCP tokens live in the platform keychain, not `localStorage`.

## What it is

Any field a connector marks `secret: true` (API tokens, bot tokens, OAuth credentials) is stored in the user's OS keychain rather than `localStorage`. An XSS-equivalent in the webview can reach `localStorage` but not the keychain — that's the threat model this closes.

## Platform backends

| Platform | Backend |
|---|---|
| **macOS** | Keychain Services |
| **Windows** | Credential Manager |
| **Linux** | Secret Service (gnome-keyring / kwallet / KeePassXC) |

All three go through the `keyring` Rust crate with native-feature flags.

## How to use

- Add an MCP connection via the palette — TerminalX automatically splits secret fields from non-secret ones.
- Non-secret config (repo name, channel ID, Jira host) stays in `localStorage` as before.
- Secret fields are written to the keychain under service `com.fantomlabs.terminalx` with account `mcp:<connection-id>:<field-key>`.
- On every sync, the store hydrates secrets fresh from the keychain before making the API call.

## One-shot migration

On first boot after upgrading, the app scans `localStorage['tx-mcp-connections-*']` for any connection whose config still has a secret-marked field. For each one, it:

1. Writes the value to the keychain under the account convention above.
2. Strips the secret from the `localStorage` JSON.
3. Re-saves the sanitized config.

A toast confirms how many tokens were moved. Migration is idempotent — safe to run on every boot.

## Tech notes

- Three Rust IPC commands: `secret_set`, `secret_get`, `secret_delete`. All validated (account must be `^[A-Za-z0-9._:/\-]{1,512}$`, value capped at 16 KB).
- `secret_get` returns `Option<String>` — distinguishes "no entry" from a real keychain error (locked keychain, permissions issue on Linux minimal install).
- `secret_delete` is idempotent — silently succeeds on `NoEntry`. Makes the frontend migration loop easier to reason about.
- `persistSecrets` / `clearSecrets` / `hydrateSecrets` in `mcpStore.ts` manage the sync-time hydration and connection lifecycle.
- `saveConnections` sanitizes every config object via `splitSecrets` before persisting to `localStorage` — even if a caller somehow sticks a secret back into state, it doesn't make it to disk.
- Addresses [issue #1](https://github.com/txc0ld/tmx/issues/1).

**Key files:** `src-tauri/src/commands/secrets.rs`, `src/utils/ipc.ts` (secret helpers), `src/stores/mcpStore.ts` (splitSecrets, persistSecrets, hydrateSecrets, migrateMcpSecretsToKeychain), `src/App.tsx` (migration useEffect).

## Related

- [MCP overview](../integrations/overview.md) · [HTTP proxy](../integrations/http-proxy.md) · [Security posture](./security.md)
