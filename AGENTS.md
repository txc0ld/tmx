# AGENTS.md — TerminalX

Brief orientation for AI coding agents working on this repo. For depth, read [**CLAUDE.md**](./CLAUDE.md) (architecture + critical patterns) and the per-feature pages under [**docs/features/**](./docs/features/README.md).

## What this app is

Native desktop (Tauri 2) app — an infinite canvas workspace for orchestrating multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. 15 tile types (terminal, agent, editor, diff, git, runner, ssh, docker, browser, file tree, note, todo, kanban, group, usage) connected by 6 wire types. MCP integrations for Slack / GitHub / Linear / Jira / Notion / Google Calendar / Gmail.

**Stack:** Tauri 2 · React 19 · TypeScript 5 · Vite 6 · Zustand 5 · xterm.js 5 · Monaco Editor · portable-pty 0.8 · reqwest 0.12.

## Directory layout

```
src/                      React frontend
├── App.tsx               Root — sidebar + canvas + palette routing
├── main.tsx              Entry; global error logging; initMcpProjectSync
├── components/
│   ├── canvas/           InfiniteCanvas, Minimap, TileDock, WorkspaceTabs, SearchOverlay
│   ├── tiles/            15 tile components + TileShell (memoized wrapper)
│   ├── topbar/           TopBar with Layout menu + Clear Canvas + theme picker
│   ├── palette/          CommandPalette (Ctrl/⌘+K)
│   ├── wiring/           WiringLayer (SVG paths), drag-to-connect ports
│   ├── sidebar/          ProjectSidebar (bottom-left)
│   ├── status/           StatusRail, ToastContainer, ThemePicker
│   └── timeline/         SessionTimeline
├── stores/               14 Zustand stores (canvasStore is the big one)
├── hooks/                usePty, useCanvas, useWiringEngine
├── utils/                ipc (Tauri invoke wrappers), layout, workspaceImport, detachTile
├── design/               tokens.ts (Kinetic Topology design system; see DESIGN.md)
└── types/                index.ts — discriminated unions for all Tile + Wire + Project types

src-tauri/                Rust backend
├── src/
│   ├── main.rs           Entry; calls run() in lib.rs
│   ├── lib.rs            Tauri builder + IPC handler registration
│   ├── commands/         30+ #[tauri::command] handlers
│   │   ├── terminal.rs   PTY spawn/write/resize/kill (bounded-channel backpressure)
│   │   ├── agents.rs     Agent CLI spawn (Windows cmd.exe wrap)
│   │   ├── filesystem.rs read_file_tree, read_file_text, write_file_text, get_file_size, watchers
│   │   ├── workspace.rs  Canvas state persistence (atomic writes)
│   │   ├── timeline.rs   Session event recording (10k cap, ring buffer)
│   │   ├── projects.rs   Project CRUD
│   │   ├── git.rs        11 git commands (validate_git_url, refname rules)
│   │   ├── http_proxy.rs SSRF-hardened outbound HTTP, DNS pinning, pooled clients
│   │   └── docker.rs     List containers + attach exec
│   └── state/
│       ├── app_state.rs  AppState container (PtyManager + AgentRegistry + Timeline + Watchers)
│       └── pty_manager.rs  PtyManager (64 PTY cap, retry-on-WouldBlock writes)
├── Cargo.toml
├── tauri.conf.json       CSP + window config
└── capabilities/default.json  Tauri 2 capabilities

docs/features/            ~55 per-feature docs (this repo's knowledge base)
.github/workflows/        CI (pnpm test + cargo check + cargo test on Ubuntu/Win/Mac)
```

## Build commands

```bash
pnpm tauri dev             # Full stack (Rust + Vite HMR)
pnpm dev                   # Frontend only (no Tauri)
pnpm tauri build           # Production binary
pnpm test                  # Vitest
npx tsc --noEmit           # TypeScript type-check
cd src-tauri && cargo check
cd src-tauri && cargo test --lib
```

## Critical patterns (read these before editing)

**#1 crash cause — Zustand selectors that create new objects.**
```ts
// ❌ infinite render loop — new array every call
useCanvasStore(s => s.tiles[s.activeProject] || [])

// ✅ stable reference via module-level constant
const EMPTY: Tile[] = [];
useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY)
```

**Don't use `@tauri-apps/plugin-fs` for user project files.** Scope is too narrow — fails on `~/.claude/projects/...`. Use `readFileText` / `writeFileText` from `utils/ipc.ts` which go through `read_file_text` / `write_file_text` in Rust with the broader `is_path_allowed` validator.

**PTY writes chunk at 256 bytes.** Already handled at the Rust level in `PtyManager::write`. Frontend-side auto-dispatch (TodoTile) additionally chunks at 128 bytes with a 50 ms delay before `\r`.

**Agent spawn goes through `pty_spawn_internal`**, not `pty_spawn`. Agents aren't shells, so they bypass the renderer-facing `SHELL_ALLOWLIST`. On Windows, agents are `.cmd` scripts and the spawn wraps them through `cmd.exe /C`.

**MCP traffic must go through `httpFetch`**, never direct `fetch()`. CSP + CORS + SSRF + DNS pinning all happen in `http_proxy.rs`.

**All frontend IPC goes through `utils/ipc.ts`.** Never call `invoke()` directly from components.

**All colors/spacing/typography via design tokens** (`src/design/tokens.ts`). Never hardcode. Alpha helper: `alpha(color, percent)` (uses `color-mix`, works with CSS custom properties).

## Where to dig for specifics

| Topic | File |
|---|---|
| Architecture deep dive + data flows | [CLAUDE.md](./CLAUDE.md) |
| Per-feature docs (~55 pages) | [docs/features/](./docs/features/README.md) |
| Design-system tokens + rules | [DESIGN.md](./DESIGN.md) |
| Wiring tutorial | [WIRING.md](./WIRING.md) |
| Security posture | [CONTRIBUTING.md → Security](./CONTRIBUTING.md#security-posture) |
| Test patterns | `src/test/*.test.ts` + `src-tauri/src/commands/**/tests` |

## Coding conventions

- All Tauri commands in `src-tauri/src/commands/` with `#[tauri::command]`.
- All IPC calls wrapped in `src/utils/ipc.ts` — never `invoke()` directly from components.
- Zustand stores in `src/stores/` — one store per domain.
- All colors/spacing/typography via design tokens — never hardcode.
- Rust: `thiserror` / `anyhow` where useful, `serde` for serialization, `parking_lot::Mutex` for shared state.
- TypeScript: strict mode, discriminated unions for tile/wire types. No `any` without a comment explaining why.
- File names: PascalCase for components, camelCase for utils/hooks/stores.
- Commits: conventional (`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`).

## Tests + CI

- **Frontend:** 92 Vitest tests in `src/test/` — wire inference, engine dispatch, workspace import validators, MCP URL builders, agent auto-complete.
- **Rust:** 38 `#[cfg(test)]` unit tests — filesystem validator, SSRF IP classification, header blocklist, project/workspace/git validators.
- **CI:** [.github/workflows/ci.yml](.github/workflows/ci.yml) runs both across Ubuntu + Windows + macOS on every push/PR to `main`.
