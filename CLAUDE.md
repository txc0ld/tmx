# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TerminalX

TerminalX is a native desktop app (Tauri 2) — an infinite canvas workspace for orchestrating multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. Tiles (terminals, agents, editors, browsers, etc.) are arranged spatially on a canvas and wired together for data flow.

**Stack:** Tauri 2 (Rust backend, `portable-pty` for PTY) + React 19 + TypeScript 5 + Vite 6 + Zustand 5 + xterm.js 5.5 + Monaco Editor

## Build & Dev Commands

```bash
pnpm tauri dev        # Full dev mode (Rust + Vite hot reload) — requires VS Build Tools vcvarsall.bat on PATH
pnpm tauri build      # Production binary (Windows MSI / macOS DMG)
pnpm dev              # Frontend-only dev server (Vite, port 5173)
npx tsc --noEmit      # Type-check without emitting
```

**Windows-specific:** Cargo must find the MSVC linker. Launch via a shell that has run `vcvarsall.bat x64`, or use the Developer Command Prompt. The git-bash `link` command shadows MSVC's `link.exe` — always build from PowerShell or cmd with VS env.

## Architecture

### Frontend (`src/`)

Entry: `main.tsx` → `App.tsx`. All inline styles, no CSS files (except xterm.css import). Colors via CSS custom properties set by `themeStore`.

**Stores** (`stores/`): Zustand 5, one per domain. `canvasStore.ts` is central — tiles, wires, transforms, z-stack, focus mode, multi-select, bookmarks, wire data bus. Other stores: `themeStore`, `projectStore`, `templateStore`, `timelineStore`, `toastStore`, `clipboardStore`, `paletteStore`.

**Tile system**: 13 tile types (discriminated union on `type` field in `types/index.ts`). Each tile component lives in `components/tiles/`. All wrapped by `TileShell.tsx` which provides glass styling, drag-to-move, edge resize, z-ordering, focus mode dimming, mouse-tracking glow overlay, and the "piped" wire indicator.

**Canvas** (`components/canvas/`): `InfiniteCanvas.tsx` applies CSS `transform: translate/scale` to a child layer. `CanvasGrid.tsx` renders SVG dot pattern. `TileDock.tsx` is a click-to-spawn toolbar. `Minimap.tsx` shows viewport overview. Canvas pans on left-drag on empty space, middle-click, or Alt+drag.

**IPC** (`utils/ipc.ts`): All Tauri `invoke()` calls wrapped here. Components never call `invoke()` directly.

**Theme** (`design/tokens.ts` + `stores/themeStore.ts`): All color values in tokens.ts are CSS `var(--tx-*)` references. `themeStore` sets these vars on `:root` at runtime. 5 themes (Electric, Phantom, Ember, Ice, Snow) — only the accent color changes, bg is always `#000000`, fg always `#FFFFFF`. The `ThemePicker` in `StatusRail` switches themes.

### Backend (`src-tauri/`)

Entry: `main.rs` → `lib.rs` (Tauri builder, plugins, command registration).

**Commands** (`commands/`): `terminal.rs` (PTY spawn/write/resize/kill via `portable-pty`), `agents.rs` (CLI agent lifecycle, delegates to PTY), `projects.rs` (CRUD persisted to `~/.config/terminalx/projects.json`), `git.rs` (clone/status), `workspace.rs` (canvas state persistence + snapshots), `filesystem.rs` (directory tree + watcher), `timeline.rs` (event recording).

**State** (`state/`): `AppState` holds `PtyManager` (PTY sessions), agent registry, and timeline events, all behind `parking_lot::Mutex`.

## Critical Patterns

### Zustand selector gotcha
`canvasStore` has `currentTiles()` etc. that call `get()` — these are **actions, not selectors**. Using them in `useCanvasStore(s => s.currentTiles())` will NOT trigger re-renders. Always use inline selectors: `useCanvasStore(s => s.tiles[s.activeProject] || EMPTY)` with module-level constants for default values to avoid infinite render loops from new object identity.

### xterm.js focus in WebView2
xterm's hidden `<textarea>` at `left: -9999em; z-index: -5` gets clipped by the CSS-transformed + `overflow: hidden` canvas subtree in WebView2. The `xtermInput.ts` utility re-homes the textarea to `document.body` and adds mousedown listeners on the xterm screen to force focus. Applied in all 4 xterm consumers: TerminalTile, AgentTile, TerminalPane, RunnerTile.

### Tauri event listener cleanup
`onPtyOutput`, `onPtyExit`, `onAgentStatus` return `Promise<UnlistenFn>`. Cleanup in useEffect: `unlisten.then(fn => fn())`.

### Canvas coordinate conversion
Screen → canvas: `(screenX - transform.x) / transform.scale`. Use `screenToCanvas()` from `utils/layout.ts`.

### Tile spawning
Tiles spawned from `TileDock` and `App.tsx` use the active project's `cwd` for terminal/agent/runner/filetree tiles. The dock cascades tiles diagonally to avoid overlap.

## Key Data Flows

**PTY:** TerminalTile → `usePty` hook → `ipc.ts` (`ptySpawn`) → Rust `terminal.rs` → `portable-pty` → reader thread → Tauri `emit("pty-output")` → frontend `listen` → `xterm.write()`

**Wiring:** `useWiringEngine` hook subscribes to store. PTY output feeds `canvasStore.wireData`. When a wire connects tile A→B and A has new data, the wire animates and B receives context. Agent chains write output to destination PTY on completion.

**Auto-save:** `InfiniteCanvas` debounces (2s) saves of tiles/wires/transform to `~/.config/terminalx/workspaces/{projectId}.json` via `saveWorkspace` IPC.

**Projects:** Persisted to `~/.config/terminalx/projects.json`. Loaded on app start. GitHub cloning via `git_clone` IPC command + native folder picker dialog.
