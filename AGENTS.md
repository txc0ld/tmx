# AGENTS.md — TerminalX

## Identity

**TerminalX** is an infinite canvas terminal workspace for developers who orchestrate multiple CLI agents (Claude Code, Codex, Gemini CLI) in parallel. It is a native desktop application built on Tauri 2 with a React + TypeScript frontend and a Rust backend. The product philosophy follows Jack Dorsey's protocol primitive model: **one verb (orchestrate), removes the intermediary (context switching), creates network effects (tile wiring).**

## Architecture

```
terminalx/
├── src-tauri/           # Rust backend — process mgmt, PTY, filesystem
│   ├── src/
│   │   ├── main.rs              # Tauri app entry, IPC registration
│   │   ├── commands/            # Tauri #[command] handlers
│   │   │   ├── terminal.rs      # PTY spawn/write/resize/kill
│   │   │   ├── agents.rs        # Agent process lifecycle
│   │   │   ├── filesystem.rs    # File tree + watcher (notify crate)
│   │   │   ├── workspace.rs     # Canvas state persistence
│   │   │   ├── timeline.rs      # Session event recording
│   │   │   └── wiring.rs        # Tile connection data flow
│   │   ├── state/               # Managed Tauri state
│   │   │   ├── app_state.rs     # Global app state
│   │   │   └── pty_manager.rs   # PTY session registry
│   │   └── plugins/             # Future plugin system trait
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json         # Tauri 2 capability permissions
│
├── src/                 # React + TypeScript frontend
│   ├── App.tsx                  # Root — sidebar + canvas routing
│   ├── main.tsx                 # Entry point
│   ├── design/
│   │   └── tokens.ts            # Kinetic Topology design system
│   ├── stores/
│   │   ├── projectStore.ts      # Zustand — project state
│   │   ├── canvasStore.ts       # Zustand — per-project tile state
│   │   ├── paletteStore.ts      # Command palette state
│   │   └── timelineStore.ts     # Session timeline events
│   ├── hooks/
│   │   ├── useCanvas.ts         # Pan/zoom/transform
│   │   ├── usePty.ts            # PTY IPC bridge
│   │   ├── useWiring.ts         # Tile connection logic
│   │   └── useFocusMode.ts      # Focus mode state
│   ├── components/
│   │   ├── tiles/
│   │   │   ├── AgentTile.tsx    # Claude/Codex/Gemini agent
│   │   │   ├── TerminalTile.tsx # Shell w/ PTY + split panes
│   │   │   ├── BrowserTile.tsx  # Webview localhost preview
│   │   │   ├── TodoTile.tsx     # Task list + drag-to-assign
│   │   │   ├── DiffTile.tsx     # PR-style review
│   │   │   ├── EditorTile.tsx   # Monaco/CodeMirror
│   │   │   ├── NoteTile.tsx     # Canvas annotation
│   │   │   └── TileShell.tsx    # Glass wrapper, drag, resize
│   │   ├── canvas/
│   │   │   ├── InfiniteCanvas.tsx
│   │   │   ├── CanvasGrid.tsx   # Dot grid
│   │   │   ├── Minimap.tsx
│   │   │   └── FocusMode.tsx    # Dim/blur overlay
│   │   ├── wiring/
│   │   │   ├── WiringLayer.tsx  # SVG connection lines
│   │   │   └── WiringPort.tsx   # Input/output ports on tiles
│   │   ├── palette/
│   │   │   └── CommandPalette.tsx # ⌘K fuzzy search
│   │   ├── status/
│   │   │   └── StatusRail.tsx   # Bottom status bar
│   │   ├── timeline/
│   │   │   └── SessionTimeline.tsx # Horizontal event scrubber
│   │   ├── sidebar/
│   │   │   └── ProjectSidebar.tsx  # Discord-style project icons
│   │   └── topbar/
│   │       └── TopBar.tsx
│   ├── types/
│   │   ├── tile.ts              # Tile type definitions
│   │   ├── project.ts           # Project type
│   │   ├── wire.ts              # Wiring connection type
│   │   └── timeline.ts          # Timeline event type
│   └── utils/
│       ├── ipc.ts               # Tauri invoke wrappers
│       └── layout.ts            # Snap/align helpers
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── AGENTS.md            # This file
├── PRD.md               # Product requirements
├── DESIGN.md            # Kinetic Topology design system
└── README.md
```

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Runtime | Tauri | 2.x (latest stable) | Native shell, IPC, webview |
| Backend | Rust | stable | PTY, process mgmt, fs, state |
| Frontend | React | 19.x | UI framework |
| Language | TypeScript | 5.x | Type safety |
| Bundler | Vite | 6.x | Dev server + build |
| State | Zustand | 5.x | Client state management |
| Terminal | xterm.js | 5.x | Terminal rendering |
| Editor | Monaco Editor | latest | Code editor tile |
| PTY | portable-pty | latest | Cross-platform PTY |
| FS Watch | notify | 7.x | File system events |
| Styling | Tailwind CSS | 4.x | Utility classes + design tokens |
| Fonts | Public Sans, Plus Jakarta Sans, JetBrains Mono | — | Kinetic Topology |

## Design System

Kinetic Topology — see DESIGN.md. Key rules:
- `#FFFFFF` reserved for entity names / primary anchors ONLY
- `#c4c4c4` for body text, `#b5d25e` for metadata
- `#ccff00` is energy — use sparingly (active states, selection, data flow)
- Glassmorphism: `rgba(26,26,26,0.4)` + `backdrop-filter: blur(20px)` + ghost border `rgba(255,255,255,0.06)`
- Luminescent shadows: `rgba(204,255,0,0.04)`, never black
- No traditional borders. Tonal shifts, spacing, ghost borders only
- No dividers. Whitespace separates

## Build Commands

```bash
# Development
pnpm tauri dev

# Build (Windows .msi + macOS .dmg)
pnpm tauri build

# Frontend only (for UI iteration)
pnpm dev
```

## Coding Conventions

- All Tauri commands in `src-tauri/src/commands/` with `#[tauri::command]`
- All IPC calls wrapped in `src/utils/ipc.ts` — never call `invoke()` directly from components
- Zustand stores in `src/stores/` — one store per domain
- Tile components receive data via props, never read global state directly
- All colors/spacing/typography via design tokens — never hardcode
- Rust: `thiserror` for error types, `serde` for serialization
- TypeScript: strict mode, no `any`, discriminated unions for tile types
- File names: kebab-case for files, PascalCase for components

## Critical Paths

### PTY Flow
1. User clicks terminal tile → `usePty` hook calls `invoke("pty_spawn", { shell, cwd })`
2. Rust spawns PTY via `portable-pty`, stores in `PtyManager`
3. Rust streams output via Tauri event channel → frontend `xterm.js`
4. User types → `invoke("pty_write", { id, data })` → Rust writes to PTY
5. Resize → `invoke("pty_resize", { id, cols, rows })`

### Agent Flow
1. Agent tile spawns → `invoke("agent_spawn", { agent_type, cwd, task })`
2. Rust spawns agent CLI process (e.g., `claude --cwd ./project`)
3. Output streams via event channel to tile
4. Status updates (idle/working/done) emitted as events
5. Completion triggers toast + timeline entry

### Wiring Flow
1. User drags from output port on Tile A to input port on Tile B
2. `useWiring` creates connection: `{ from: tileA.id, to: tileB.id, type }`
3. When Tile A emits data (terminal output, agent completion, etc.)
4. WiringLayer animates the `#ccff00` dashed flow line
5. Tile B receives piped data (as context, as command, as refresh trigger)

### Workspace Persistence
1. Canvas state (tiles, positions, wires, zoom) stored per-project
2. On change → debounced write to `~/.terminalx/workspaces/{project}.json`
3. On project switch → load workspace state, restore canvas
4. Snapshots saved as named presets in same directory
