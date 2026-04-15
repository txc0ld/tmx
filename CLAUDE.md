# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TerminalX

Native desktop app (Tauri 2) — infinite canvas workspace for orchestrating multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. Tiles (terminals, agents, editors, browsers, etc.) are arranged spatially and wired together for data flow.

**Stack:** Tauri 2 (Rust, `portable-pty`, `reqwest`) + React 19 + TypeScript 5 + Vite 6 + Zustand 5 + xterm.js 5.5 + Monaco Editor

## Build & Dev Commands

```bash
pnpm tauri dev        # Full dev (Rust + Vite HMR). First run compiles ~500 crates (~3 min).
pnpm tauri build      # Production binary (MSI / DMG / AppImage / .deb)
pnpm dev              # Frontend only (Vite :5173, no Tauri)
npx tsc --noEmit      # Frontend type-check
cd src-tauri && cargo check    # Rust type-check
cd src-tauri && cargo test     # Rust tests
```

**Windows:** Cargo needs MSVC linker. If `cargo` isn't in PATH, add `%USERPROFILE%\.cargo\bin`. Git-bash's `link` command shadows MSVC's `link.exe` — build from PowerShell or `cmd.exe`. Agent CLIs (claude/codex/gemini) are npm `.cmd` scripts; the agent spawn auto-wraps them with `cmd.exe /C`.

**macOS:** `xcode-select --install` + `rustup`. Native traffic lights render via `titleBarStyle: "Overlay"` — the custom window buttons in `TopBar.tsx` are hidden on macOS.

**Linux:** Needs `libwebkit2gtk-4.1-dev` + `libayatana-appindicator3-dev` + `librsvg2-dev`.

**iOS/Android:** Not supported — `portable-pty` is target-gated out in `Cargo.toml` because mobile sandboxes forbid subprocess spawning. Terminal architecture is fundamentally incompatible.

## Architecture

### Frontend (`src/`)

Entry: `main.tsx` → `AppErrorBoundary` → `App.tsx`. All inline styles (except `xterm.css`). Colors via CSS custom properties set by `themeStore`. Monaco Editor/DiffEditor are lazy-loaded.

**Stores (`stores/`, Zustand 5, 14 total):**
- `canvasStore` — Central state: tiles, wires, transforms, z-stack, focus mode, multi-select, bookmarks, workspace tabs, snap guides, sticky notes, wire data bus (500KB cap per PTY)
- `projectStore` — Project CRUD, active-project persistence. Starts empty — users add projects via the + button in the sidebar.
- `themeStore` — 6 themes (5 dark + 1 light `Slate`). CSS var application via `applyThemeToDOM()`. Light themes get dark tile surfaces + dark chrome.
- `mcpStore` — Per-project MCP connections (Slack/GitHub/Linear/Jira/Notion). Subscribed to `projectStore` for project-switch reloads. Sync is sequential with 250ms jitter. Error toasts on failures (once per connection per session).
- `usageStore` — Agent session tracking + token/cost estimation. Auto-tracks via `canvasStore` subscription.
- `agentMemoryStore` — Per-project persistent context injected into every new agent spawn (after 2s delay, with ANSI escape stripping).
- `recordingStore` — Session replay. Events coalesced within 10ms window. Auto-stops at 50k events.
- `commandHistoryStore` — Per-terminal command buffer.
- `templateStore` — 16 built-in + user templates in localStorage.
- `pluginStore` — Custom tile types via sandboxed iframes.
- `toastStore`, `timelineStore`, `clipboardStore`, `paletteStore`.

**Tile system:** 15 types via discriminated union in `types/index.ts` (agent, terminal, editor, diff, note, todo, kanban, filetree, git, browser, runner, ssh, docker, usage, group). Each has a component in `components/tiles/`. `TileShell.tsx` (memo'd) wraps every tile with drag + resize + snap + z-order + title-bar chrome (5 buttons: pin/clone/detach/template/close, shown on hover).

**Canvas (`components/canvas/`):** `InfiniteCanvas.tsx` is the workhorse — transform layer, rubber-band (Shift+drag), snap guides, sticky notes, workspace tabs, minimap, tile dock, auto-save (2s disk + 500ms localStorage cache), auto-snapshot (every 5 min for time-travel).

**IPC (`utils/ipc.ts`):** All `invoke()` calls wrapped here. Components never call `invoke()` directly. Includes: PTY, agents, 11 git commands, docker, workspace, filesystem, projects, timeline, and `http_fetch` (HTTP proxy with SSRF guards).

### Backend (`src-tauri/`)

Entry: `main.rs` → `lib.rs` (Tauri builder, plugin registration, PTY cleanup on `WindowEvent::Destroyed`).

**Commands (`commands/`):**
- `terminal.rs` — PTY lifecycle. Writes chunked to 256 bytes (Windows pipe buffer safety). **Public `pty_spawn` uses `SHELL_ALLOWLIST`** (bash/zsh/sh/fish/powershell/cmd/ssh/docker). **Internal `pty_spawn_internal`** bypasses the allowlist for trusted callers (agent spawn).
- `agents.rs` — Claude/Codex/Gemini. Windows wraps through `cmd.exe /C` for `.cmd` scripts. Validates custom command args (null bytes + 16KB cap). Routes through `pty_spawn_internal`.
- `git.rs` — 11 commands. `validate_git_url()` rejects `ext::` / `transport::` remote helpers, loopback hosts, malformed URLs. Clone uses `git -c protocol.ext.allow=never -c protocol.file.allow=never` + `--` to block remote-helper RCE. Branch names validated against refname rules.
- `http_proxy.rs` — `http_fetch` for MCP API calls. **SSRF-hardened:** blocks RFC 1918 private IPs, CGNAT (100.64/10), link-local, loopback, multicast, IPv6 ULA (fc00::/7), URL credentials. HTTPS-only for non-loopback hosts. 10MB response / 5MB body caps.
- `filesystem.rs` — `read_file_tree` canonicalizes paths and rejects anything outside `$HOME`, `/tmp`, `/Users`, `/Volumes`, `/workspace`, `/workspaces`, `/srv`, `/home`. Symlink skip prevents infinite recursion. Directory watchers validated (exists + is_dir) and deduplicated.
- `docker.rs` — `tokio::process::Command` (not PTY). UTF-8-safe truncation + 500-container cap.
- `workspace.rs` — Atomic writes via temp-file + rename. `sanitize_name` rejects path separators, `..`, null bytes, colons, 255+ chars. Snapshot list capped at 10k.
- `projects.rs` — Persisted to `~/.config/terminalx/projects.json`.
- `timeline.rs` — Event recording capped at 10k with `rotate_left + truncate`.

**State (`state/`):** `AppState` owns `PtyManager`, `AgentRegistry`, `Timeline`, `Watchers` — all behind `parking_lot::Mutex`. `PtyManager` implements `Drop` for automatic cleanup. Session IDs are uniqueness-checked on insert.

**Security (`capabilities/default.json`):** `fs:default` has explicit allow (`$APPDATA/**`, `$APPCONFIG/**`, `$APPLOCALDATA/**`, `$DOCUMENT/**`, `$DESKTOP/**`, `$HOME/Projects/**`) and deny (`**/.env`, `.ssh/**`, `.aws/**`, `.config/gcloud/**`). CSP has no `'unsafe-inline'` in `script-src`.

## Critical Patterns

### #1 CRASH CAUSE: Zustand selectors creating new objects

NEVER create new objects/arrays inside a Zustand selector. This is THE source of infinite render loops.

```ts
// ❌ INFINITE LOOP — creates new array every render
useCanvasStore(s => s.tiles[s.activeProject] || [])

// ✅ CORRECT — stable reference via module-level constant
const EMPTY_TILES: Tile[] = [];
useCanvasStore(s => s.tiles[s.activeProject] ?? EMPTY_TILES)
```

Applies to `|| []`, `|| {}`, `?? []`, `?? {}` inside ANY `useXxxStore(s => ...)`.

### xterm keyboard capture

xterm's hidden `<textarea>` can't receive focus inside WebView2's CSS-transformed canvas. `xtermInput.ts` bypasses it entirely — captures `keydown` on the container div and translates keys to VT sequences. Also handles image paste (saves to file, pastes path). Applied in all 4 xterm consumers: TerminalTile, AgentTile, TerminalPane, RunnerTile.

### PTY write chunking

Large PTY writes get truncated on Windows. `PtyManager.write()` chunks ALL writes to 256 bytes with flush between each. Frontend auto-dispatch (TodoTile) additionally chunks at 128 bytes with 50ms delay before sending `\r`.

### Agent spawn pipeline

`agentSpawn` IPC → resolves binary (claude/codex/gemini or custom command) → validates args → on Windows wraps in `cmd.exe /C` → calls `pty_spawn_internal` (NOT `pty_spawn` — bypasses SHELL_ALLOWLIST because agents aren't shells) → injects agent memory context after 2s delay.

### Tauri event listener cleanup

`onPtyOutput`, `onPtyExit`, `onAgentStatus` return `Promise<UnlistenFn>`. Use a `mounted` flag pattern in useEffect cleanup to handle the async resolution race.

### Canvas coordinate conversion

`(screenX - transform.x) / transform.scale`. Use `screenToCanvas()` from `utils/layout.ts`.

### Platform detection

`utils/platform.ts` — synchronous `isMac()` / `isWindows()` / `modShortcut('K')` helpers. Used to hide custom window buttons on macOS (native traffic lights render via `titleBarStyle: "Overlay"`) and to show `⌘K` vs `Ctrl+K` labels.

### Light theme surface inversion

When `isLightBg()` is true, `applyThemeToDOM()` sets dark surface colors so tiles and chrome stay dark with white text while the canvas background is light. xterm terminals also flip via `isLightTheme()` in each terminal component.

### HTTP proxy for MCP

MCP API calls (Slack/GitHub/Linear/Jira/Notion) MUST go through `httpFetch` (Rust proxy) — direct `fetch()` is blocked by WebView CSP + CORS. The proxy also enforces SSRF guards.

### Plugin sandbox boundary

`PluginTile` iframe uses `sandbox="allow-scripts allow-forms"` — no `allow-same-origin`, no `allow-popups`. `postMessage` targets the plugin's origin specifically (not `*`). Received messages validate `e.origin` against `plugin.entryUrl`.

## Key Data Flows

**PTY:** TerminalTile → `usePty` → `ipc.ts (ptySpawn)` → `terminal.rs` → `portable-pty` → reader thread → `emit("pty-output")` → frontend `listen` → `xterm.write()` + `canvasStore.wireData` + `recordingStore`.

**Wiring:** `useWiringEngine` subscribes to canvasStore. 5 wire types — `context-pipe`, `agent-chain`, `refresh-trigger`, `task-assign`, `diff-feed`. Agent chains pipe last 50 lines on completion. Auto-recovery: Runner `status === 'fail'` + wire to Agent → error auto-dispatched to agent PTY.

**MCP tasks:** `syncConnection` → `httpFetch` IPC → JSON parse → filter by `seenTaskIds` → TodoTile "FROM INTEGRATIONS" panel. Auto-dispatch: if "Auto" toggle on, new tasks are chunk-written to agent PTY with `\r` after.

**Persistence:** 3 layers — (1) localStorage cache (500ms, quota-exceeded handler GCs old auto-snapshots), (2) IPC disk save (2s debounce, atomic via temp+rename), (3) `beforeunload` immediate save. Restore priority: disk → localStorage fallback. Auto-snapshots every 5 min for time-travel (`Ctrl+K → Time Travel`).

## Docs

- `README.md` — Install instructions (per-OS: macOS/Windows/Linux/Fedora/Arch) + AI-agent install prompts for Claude/Codex/Gemini
- `FEATURES.md` — Feature guide + X-post social copy
- `CHANGELOG.md` — Keep-a-Changelog format, semver
- `CONTRIBUTING.md` — Development workflow, architecture rules, PR checklist
