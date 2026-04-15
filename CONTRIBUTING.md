# Contributing to TerminalX

Thanks for your interest. This guide will get you productive fast.

---

## Getting Started

### 1. Prerequisites

Ensure you have:
- Rust 1.90+
- Node.js 22+
- pnpm 9+
- Platform-specific build tools (see [README](./README.md#installation))

### 2. Clone & install

```bash
git clone https://github.com/txc0ld/tmx.git
cd tmx
pnpm install
```

### 3. Run dev mode

```bash
pnpm tauri dev
```

First run compiles Rust (~2-3 min). Subsequent runs use cached builds and hot-reload the frontend instantly.

---

## Development Workflow

### Before you code

Read [CLAUDE.md](./CLAUDE.md). It covers architecture, data flows, and the critical patterns you'll need to know.

### Making changes

| Change type | Test command |
|-------------|-------------|
| Frontend only | Vite HMR handles it automatically |
| Rust backend | File watcher auto-rebuilds on save |
| New IPC command | Must rebuild Rust + restart Tauri |
| Types in `src/types/` | Run `npx tsc --noEmit` to verify |

### Before committing

```bash
npx tsc --noEmit        # Must pass
npx vite build          # Must succeed
cd src-tauri && cargo check  # Must succeed
```

---

## Architecture Rules

These are non-negotiable patterns. Violating them causes bugs that are hard to debug.

### 1. Never create objects inline in Zustand selectors

```ts
// ❌ BAD — infinite re-renders
const tiles = useCanvasStore(s => s.tiles[s.activeProject] || []);

// ✅ GOOD — stable reference
const EMPTY: Tile[] = [];
const tiles = useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY);
```

Applies to `|| []`, `|| {}`, `?? []`, `?? {}` — anything creating a new object/array inside a selector.

### 2. All Tauri calls go through `utils/ipc.ts`

```ts
// ❌ BAD
import { invoke } from '@tauri-apps/api/core';
await invoke('pty_spawn', { ... });

// ✅ GOOD
import { ptySpawn } from '@/utils/ipc';
await ptySpawn({ ... });
```

### 3. Colors come from design tokens

```ts
// ❌ BAD — hardcoded
style={{ color: '#CCFF00' }}

// ✅ GOOD — theme-aware
import { colors } from '@/design/tokens';
style={{ color: colors.primary }}
```

### 4. Tile types are discriminated unions

When adding a new tile type:

1. Add to `TileType` in `src/types/index.ts`
2. Create interface extending `TileBase`
3. Add to the `Tile` union
4. Register in `InfiniteCanvas.tsx` `renderTileContent()` switch
5. Add to `TileDock.tsx` `DOCK_GROUPS` array
6. Add default size + config to `TileDock` and `App.tsx`

### 5. PTY writes must go through the existing pipeline

The Rust `PtyManager.write()` already chunks writes to 256 bytes for Windows pipe compatibility. Don't bypass it. Don't add your own chunking on the frontend unless you have a specific reason (see `TodoTile` auto-dispatch for a valid exception).

---

## Commit Conventions

Use conventional commits:

```
feat: add tile cloning button
fix: resolve infinite render loop in TodoTile
refactor: extract snap logic to utils/layout.ts
docs: update MCP setup instructions
perf: lazy-load Monaco editor
chore: bump dependencies
```

**Co-author attribution for AI assistance:**

```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] `npx tsc --noEmit` passes
- [ ] `pnpm tauri build` succeeds (or at least `pnpm dev` runs without console errors)
- [ ] Tested on your platform (note the platform in the PR description)
- [ ] No hardcoded colors (uses `colors.*` from tokens)
- [ ] No direct `invoke()` calls (uses `utils/ipc.ts`)
- [ ] No Zustand selectors creating new objects inline
- [ ] New features documented in `FEATURES.md`
- [ ] New architecture patterns documented in `CLAUDE.md`

---

## Security posture

This is a power-user terminal/workspace app, so the trust model is different from a web app:

- **Local filesystem access is intentionally broad** (see `is_path_allowed` in `src-tauri/src/commands/filesystem.rs`) — users need to read/write anywhere they can reach. Correctness safeguards (null-byte rejection, symlink-write rejection, 10 MB text caps) are fine; tightening the path allowlist breaks real workflows.
- **Shell PTY spawning is allowlisted** (`SHELL_ALLOWLIST` in `terminal.rs`) — but agent spawns use `pty_spawn_internal` which bypasses the allowlist on purpose.
- **HTTP proxy is SSRF-hardened** — private IPs (10.x, 172.16-31.x, 192.168.x, 100.64-127.x), loopback, link-local, IPv6 ULA, URL credentials, and redirect following are all blocked. After validation, DNS resolution is pinned via `reqwest::ClientBuilder::resolve_to_addrs` to prevent DNS-rebinding TOCTOU between validation and connect.
- **CSP allowances are intentional:** `script-src 'unsafe-eval'` is required by Monaco's language tokenizers and worker bootstrap. `style-src 'unsafe-inline'` is required by Vite's HMR `<style>` injection and by xterm's runtime style tags. `frame-src https:` backs `BrowserTile`. `img-src https:` backs agent-output image previews and browser-tile scraping. Each allowance is justified by a feature — do not remove without replacing the feature too.
- **Plugin sandbox** — `PluginTile` was removed as unused; if it's resurrected, the iframe must stay `sandbox="allow-scripts allow-forms"` (no `allow-same-origin`) and `postMessage` must target the plugin's exact origin, not `*`.

When adding new IPC commands, validate every user-reachable argument at the boundary: length caps, null-byte rejection, scheme/enum checks. Write a `#[cfg(test)]` block covering the validator. Tests for existing validators are in `src-tauri/src/commands/*.rs`.

---

## Reporting Bugs

File an issue at [github.com/txc0ld/tmx/issues](https://github.com/txc0ld/tmx/issues) with:

1. **Platform** — Windows / macOS / Linux + version
2. **Steps to reproduce** — as minimal as possible
3. **Expected vs actual behavior**
4. **Console output** — press F12 in dev mode, paste any red errors
5. **Rust logs** — check the terminal where `pnpm tauri dev` is running

---

## Feature Requests

Open a GitHub issue with the `enhancement` label. For larger features, describe:

- **The problem** you're solving
- **Your proposed solution**
- **Alternatives** you considered
- **Who this helps** (single user, teams, specific workflows)

---

## Code of Conduct

Be respectful. Assume good faith. Ship good work.

---

## Questions?

Open a GitHub Discussion or reach out to [@txc0ld](https://github.com/txc0ld).
