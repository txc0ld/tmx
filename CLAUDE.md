# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TerminalX

TerminalX is a native desktop app (Tauri 2) — an infinite canvas workspace for orchestrating multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. Tiles (terminals, agents, editors, browsers, etc.) are arranged spatially on a canvas and wired together for data flow.

**Stack:** Tauri 2 (Rust backend, `portable-pty` for PTY, `reqwest` for HTTP proxy) + React 19 + TypeScript 5 + Vite 6 + Zustand 5 + xterm.js 5.5 + Monaco Editor

## Build & Dev Commands

```bash
pnpm tauri dev        # Full dev mode (Rust + Vite hot reload)
pnpm tauri build      # Production binary (Windows MSI / macOS DMG)
pnpm dev              # Frontend-only dev server (Vite, port 5173)
npx tsc --noEmit      # Type-check without emitting
npx vite build        # Frontend-only production build
```

**Windows-specific:** Cargo must find the MSVC linker. If `cargo` isn't in PATH, add `$USERPROFILE/.cargo/bin` to PATH. The git-bash `link` command shadows MSVC's `link.exe` — build from PowerShell or cmd with VS env. On Windows, agent CLIs (claude, codex, gemini) are `.cmd` scripts — the agent spawn wraps them through `cmd.exe /C` automatically.

**macOS:** Install Xcode Command Line Tools + Rust (`rustup`). Then `pnpm install && pnpm tauri dev`.

## Architecture

### Frontend (`src/`)

Entry: `main.tsx` → `AppErrorBoundary` → `App.tsx`. All inline styles, no CSS files (except xterm.css import). Colors via CSS custom properties set by `themeStore`. Heavy components (Monaco Editor/Diff) are lazy-loaded via `React.lazy()`.

**Stores** (`stores/`): Zustand 5, 13 stores total:
- `canvasStore` — Central: tiles, wires, transforms, z-stack, focus mode, multi-select, bookmarks, workspace tabs, snap guides, sticky notes, wire data bus
- `projectStore` — Project CRUD, active project persistence
- `themeStore` — 6 themes, CSS variable application, light/dark detection
- `mcpStore` — MCP integrations (Slack, GitHub, Linear, Jira, Notion), per-project connections, HTTP proxy through Rust
- `usageStore` — Agent session tracking, token/cost estimation, OpenUsage API polling
- `agentMemoryStore` — Per-project persistent context injected into agent spawns
- `recordingStore` — Session recording (PTY output with timestamps)
- `commandHistoryStore` — Per-terminal command buffer
- `templateStore` — 16 built-in + user-saved tile templates
- `pluginStore` — Custom tile type registration via iframe sandbox
- `toastStore`, `timelineStore`, `clipboardStore`, `paletteStore`

**Tile system**: 15 tile types (discriminated union on `type` field in `types/index.ts`): agent, terminal, editor, diff, note, todo, kanban, filetree, git, browser, runner, ssh, docker, usage, group. Each tile component in `components/tiles/`. All wrapped by `TileShell.tsx` (memo'd) which provides: drag-to-move with tile-to-tile snapping, edge resize, z-ordering, focus mode dimming, title bar with clone/pin/detach/template/close buttons.

**Canvas** (`components/canvas/`): `InfiniteCanvas.tsx` — transform layer, rubber-band selection (Shift+drag), snap alignment guides, sticky notes, workspace tabs, minimap, tile dock, auto-save (2s disk + 500ms localStorage cache), auto-snapshot (every 5 min for time-travel). `useCanvas.ts` hook handles pan/zoom.

**IPC** (`utils/ipc.ts`): All Tauri `invoke()` calls wrapped here. Components never call `invoke()` directly. Includes wrappers for PTY, agents, git (11 commands), docker, workspace, filesystem, projects, timeline, and HTTP proxy.

**Theme** (`design/tokens.ts` + `stores/themeStore.ts`): All color values in tokens.ts are CSS `var(--tx-*)` references. 6 themes: Electric, Phantom, Ember, Ice, Snow (dark), Slate (light). Light themes get dark tile surfaces, dark chrome bars, and white text automatically via `isLightBg()` detection in `applyThemeToDOM()`.

### Backend (`src-tauri/`)

Entry: `main.rs` → `lib.rs` (Tauri builder, plugins, command registration, PTY cleanup on window destroy).

**Commands** (`commands/`):
- `terminal.rs` — PTY spawn/write/resize/kill. Writes are chunked to 256 bytes to prevent Windows pipe buffer overflow.
- `agents.rs` — CLI agent lifecycle. On Windows, spawns through `cmd.exe /C` for `.cmd` scripts. Validates binary names against path injection.
- `git.rs` — 11 commands: available, clone, status, log, branches, checkout, diff_summary, files_status, stage, unstage, commit. UTF-8-safe string parsing.
- `docker.rs` — docker_available, docker_list_containers via `tokio::process::Command`.
- `http_proxy.rs` — `http_fetch` command proxies HTTP requests through Rust (bypasses WebView CSP/CORS for MCP API calls). HTTPS-only with User-Agent header.
- `workspace.rs` — Canvas state persistence + snapshots. Path traversal sanitization.
- `filesystem.rs` — Directory tree + watcher. Duplicate watch prevention.
- `projects.rs` — CRUD persisted to `~/.config/terminalx/projects.json`.
- `timeline.rs` — Event recording, capped at 10k.

**State** (`state/`): `AppState` holds `PtyManager` (PTY sessions with 256-byte chunked writes), agent registry, timeline events, file watchers — all behind `parking_lot::Mutex`. `shutdown_all()` called on window destroy.

## Critical Patterns

### Zustand selector infinite loop (THE #1 CRASH CAUSE)
NEVER create new objects/arrays inside a Zustand selector. This causes infinite re-renders:
```ts
// BAD — creates new array every render → infinite loop
useCanvasStore(s => s.tiles[s.activeProject] || [])
useCanvasStore(s => s.workspaceNames[s.activeProject] || ['Default'])

// GOOD — module-level constant, stable identity
const EMPTY: Tile[] = [];
useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY)
```
This applies to `|| []`, `|| {}`, `?? []`, `?? {}` inside ANY `useXxxStore(s => ...)` call. Always use a module-level constant for fallback values.

### xterm.js keyboard capture
xterm's hidden `<textarea>` cannot receive focus inside WebView2's CSS-transformed canvas. `xtermInput.ts` bypasses it entirely — captures `keydown` on the container div and translates keys to VT sequences. Also handles image paste (saves to file, pastes path). Applied in all 4 xterm consumers: TerminalTile, AgentTile, TerminalPane, RunnerTile.

### PTY write chunking
Large text writes to PTY get truncated on Windows. The Rust `PtyManager.write()` chunks all writes to 256 bytes with flush between each chunk. Frontend `TodoTile` auto-dispatch also chunks at 128 bytes with 50ms delays for agent prompts.

### Tauri event listener cleanup
`onPtyOutput`, `onPtyExit`, `onAgentStatus` return `Promise<UnlistenFn>`. Use a `mounted` guard in useEffect cleanup to handle race conditions where the promise resolves after unmount.

### Canvas coordinate conversion
Screen → canvas: `(screenX - transform.x) / transform.scale`. Use `screenToCanvas()` from `utils/layout.ts`.

### Light theme surface inversion
When `isLightBg()` is true, `applyThemeToDOM()` sets dark surface colors (`#262b22`, `#2d3228`) so tiles and chrome have dark backgrounds with white text, while the canvas stays light. xterm themes also flip via `isLightTheme()` in each terminal component.

## Key Data Flows

**PTY:** TerminalTile → `usePty` hook → `ipc.ts` (`ptySpawn`) → Rust `terminal.rs` → `portable-pty` → reader thread → Tauri `emit("pty-output")` → frontend `listen` → `xterm.write()` + `wireData` + `recordingStore`

**Wiring:** `useWiringEngine` hook subscribes to canvasStore. 5 wire types: context-pipe, agent-chain, refresh-trigger, task-assign, diff-feed. Agent chains pipe last 50 lines on completion. Auto-recovery: runner failure → dispatches error to wired agent.

**MCP Tasks:** Slack/GitHub/Linear/Jira/Notion → `mcpStore.syncConnection()` → `httpFetch` IPC (Rust proxy) → API response → filtered by `seenTaskIds` → displayed in TodoTile. Auto-dispatch: if "Auto" is on, new tasks are chunked-written to agent PTY.

**Persistence:** 3 layers — localStorage cache (500ms), IPC disk save (2s debounce), `beforeunload` immediate save. Restore priority: disk first, localStorage fallback. Auto-snapshots every 5 min for time-travel rollback.

**Agent Spawn:** `agentSpawn` IPC → Rust resolves binary → Windows: wraps in `cmd.exe /C` → `pty_spawn` → injects agent memory context after 2s delay if set.
