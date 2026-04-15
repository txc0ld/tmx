<div align="center">

# TerminalX

**Infinite canvas workspace for orchestrating CLI agents in parallel.**

Run Claude, Codex, and Gemini side-by-side. Wire them together. Ship 10× faster.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.90+-000000?logo=rust)](https://rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://typescriptlang.org)

[Features](#features) · [Install](#installation) · [Quick Start](#quick-start) · [Architecture](#architecture) · [Contributing](#contributing)

</div>

---

## What is TerminalX?

TerminalX is a native desktop app that turns your terminal workflow into a spatial canvas. Instead of juggling tabs, windows, and AI tools, you arrange everything on an infinite canvas — terminals, agents, editors, git panels, browsers — and wire them together for automated workflows.

**Built for developers who:**
- Run multiple AI agents in parallel (Claude Code, Codex, Gemini CLI)
- Want zero context-switching between terminals, editors, and browsers
- Need persistent, spatially-organized workspaces per project
- Pull tasks from Slack, GitHub, Linear, Jira, or Notion directly into their dev environment
- Care about performance (50MB RAM, native PTY, WebGL-rendered terminals)

---

## Features

**Core**
- 🎨 **Infinite canvas** — pan, zoom, snap-to-edge alignment, rubber-band selection, workspace tabs
- 🤖 **15 tile types** — Terminal, Agent, Editor, Diff, Git, Docker, SSH, Note, Todo, Kanban, Browser, Runner, File Tree, Usage, Group
- 🔗 **Wiring system** — 5 wire types for automated data flow between tiles
- 🎯 **6 themes** — Electric, Phantom, Ember, Ice, Snow, Slate (light mode)

**Integrations**
- 💬 **MCP connectors** — Slack, GitHub, Linear, Jira, Notion, Google Calendar
- 📊 **OpenUsage** — LLM cost tracking across providers
- 🐙 **Git panel** — Status, log, branches, stage, commit — no CLI needed
- 🐳 **Docker** — Container list + attach

**Power Features**
- 🧠 **Agent Memory** — persistent project context auto-injected into every new agent
- ⚔️ **Multi-Agent Debate** — spawn Claude + Codex + Gemini with the same prompt, compare
- 🔄 **Auto-Recovery** — wire a Runner → Agent; failures auto-dispatch to the agent for fixing
- ⏰ **Time Travel** — rollback to auto-snapshots (every 5 min, 1 hour of history)
- 🎬 **Session Recording** — replay all terminal I/O with timestamps
- 📌 **Output Pinning** — freeze terminal output as a note tile
- 🖼️ **Image Paste** — paste screenshots into terminals (saves file, pastes path)
- 💾 **Crash Recovery** — 3-layer persistence (localStorage + disk + beforeunload)
- 🪟 **Multi-Monitor** — detach any tile into its own OS window

See [**FEATURES.md**](./FEATURES.md) for the complete feature guide.

---

## Installation

### Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| **Rust** | 1.90+ | [rustup.rs](https://rustup.rs) |
| **Node.js** | 22+ | [nodejs.org](https://nodejs.org) |
| **pnpm** | 9+ | `npm install -g pnpm` |

### Platform-specific

<details>
<summary><b>Windows</b></summary>

- Visual Studio Build Tools 2022 with the **Desktop development with C++** workload
- WebView2 (pre-installed on Windows 10/11)
- Launch dev from PowerShell or a shell with `vcvarsall.bat x64` env initialized
</details>

<details>
<summary><b>macOS</b></summary>

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
</details>

<details>
<summary><b>Linux</b></summary>

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev
```
</details>

### Clone & Run

```bash
git clone https://github.com/txc0ld/tmx.git
cd tmx
pnpm install
pnpm tauri dev
```

---

## Quick Start

1. **Launch** — `pnpm tauri dev` opens the app
2. **Add a project** — click the `+` button in the bottom-left sidebar, pick your repo folder
3. **Apply default layout** — click the **Layout** button in the top bar to spawn Terminal + Agent + File Tree + Tasks + Git tiles
4. **Open the palette** — `Ctrl/Cmd+K` to fuzzy-search 25+ commands
5. **Connect Slack** — drop a Tasks tile, go to the MCP tab, add your Slack bot token. Tasks from your channel sync every 5 min.
6. **Enable Auto-dispatch** — click the "Auto" button; new tasks get sent to a Claude agent automatically

---

## Commands

### Development

```bash
pnpm tauri dev          # Full stack: Rust backend + Vite HMR (default)
pnpm dev                # Frontend-only (Vite on :5173, no Tauri)
pnpm tauri build        # Production binary (MSI on Windows, DMG on macOS, AppImage on Linux)
```

### Quality

```bash
npx tsc --noEmit        # Type-check TypeScript (no emit)
npx vite build          # Frontend production bundle
cargo check             # Rust type-check (run from src-tauri/)
cargo test              # Run Rust tests (run from src-tauri/)
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Command Palette (fuzzy search everything) |
| `Ctrl+F` | Search across all tile content |
| `Ctrl+Enter` | Toggle Focus Mode |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle through tiles |
| `Ctrl+W` | Close focused/selected tiles |
| `Ctrl+G` | Group selected tiles |
| `Ctrl+Shift+B` | Save canvas bookmark |
| `Ctrl+1`–`Ctrl+9` | Jump to bookmark |
| `Ctrl+Shift+D` | Split terminal pane |
| `Ctrl+Arrow` | Navigate split panes |
| `Shift+Drag` | Rubber-band select on canvas |
| `Alt+Drag` / middle-click | Pan canvas |
| `Scroll` | Zoom canvas |
| `Escape` | Close overlays / exit focus mode |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  React 19 Frontend (src/)                           │
│  ┌─────────────────────────────────────────────┐   │
│  │  InfiniteCanvas — transform + tile layer    │   │
│  │  TileShell — drag/resize/snap/z-order       │   │
│  │  15 tile components                          │   │
│  └─────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────┐   │
│  │  13 Zustand stores (canvas, theme, mcp,     │   │
│  │  usage, recording, templates, plugins, ...) │   │
│  └─────────────────────────────────────────────┘   │
└────────────────┬────────────────────────────────────┘
                 │ Tauri invoke() / events
┌────────────────▼────────────────────────────────────┐
│  Rust Backend (src-tauri/)                          │
│  ┌─────────────────────────────────────────────┐   │
│  │  29 IPC commands:                            │   │
│  │  • PTY (portable-pty, chunked writes)       │   │
│  │  • Agents (cmd.exe wrap on Windows)         │   │
│  │  • Git (11 commands)                         │   │
│  │  • Docker, Filesystem, Workspace, Timeline  │   │
│  │  • HTTP Proxy (reqwest, CSP/CORS bypass)    │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Stack:** Tauri 2 · React 19 · TypeScript 5.6 · Vite 6 · Zustand 5 · xterm.js 5.5 · Monaco Editor · portable-pty 0.8 · reqwest 0.12

See [**CLAUDE.md**](./CLAUDE.md) for deep architecture notes, critical patterns, and data flows.

---

## Project Structure

```
.
├── src/                           # React frontend
│   ├── components/
│   │   ├── canvas/                # InfiniteCanvas, Minimap, TileDock, WorkspaceTabs, SearchOverlay
│   │   ├── tiles/                 # 15 tile components + TileShell
│   │   ├── topbar/                # TopBar with Layout/Save buttons
│   │   ├── sidebar/               # ProjectSidebar (bottom-left projects)
│   │   ├── status/                # StatusRail, ToastContainer, ThemePicker
│   │   ├── palette/               # Command Palette
│   │   ├── wiring/                # Wire rendering + drag-connect
│   │   └── timeline/              # Session timeline
│   ├── stores/                    # 13 Zustand stores
│   ├── hooks/                     # useCanvas, usePty, useWiringEngine
│   ├── utils/                     # ipc, layout, detachTile, projectIcon
│   ├── design/                    # tokens.ts (colors, spacing, typography)
│   └── types/                     # Discriminated unions for all tile types
│
├── src-tauri/                     # Rust backend
│   ├── src/
│   │   ├── commands/              # Terminal, agents, git, docker, http_proxy, etc.
│   │   └── state/                 # AppState, PtyManager
│   ├── capabilities/              # Tauri permission manifests
│   └── icons/                     # App icons (Windows, macOS, Linux)
│
├── CLAUDE.md                      # Architecture guide for AI coding agents
├── FEATURES.md                    # Full feature list + X post copy
└── README.md                      # This file
```

---

## Contributing

Contributions welcome. Quick guidelines:

1. **Fork** and create a feature branch (`git checkout -b feat/your-feature`)
2. **Type-check** before committing (`npx tsc --noEmit`)
3. **Follow patterns** in [CLAUDE.md](./CLAUDE.md) — especially the Zustand selector pattern (#1 crash cause)
4. **Test** on your platform before opening a PR
5. **Commit style** — conventional commits preferred (`feat:`, `fix:`, `refactor:`)

### Known patterns to avoid

- ❌ Inline `|| []` or `?? []` inside `useXxxStore(s => ...)` selectors — causes infinite render loops
- ❌ Calling `invoke()` directly from components — always wrap in `utils/ipc.ts`
- ❌ Hardcoded colors — use `colors.*` from `design/tokens.ts`
- ❌ Large PTY writes without chunking — already handled at the Rust level

---

## Troubleshooting

<details>
<summary><b>Rust build fails on Windows: "link.exe not found"</b></summary>

Git-bash's `link` command shadows MSVC's `link.exe`. Build from PowerShell or `cmd.exe`, not git-bash. If `cargo` itself isn't in PATH, add `%USERPROFILE%\.cargo\bin`.
</details>

<details>
<summary><b>"Agent Spawn Failed: not a valid Win32 application"</b></summary>

The agent CLI (claude/codex/gemini) is an npm `.cmd` script, not a `.exe`. TerminalX wraps these through `cmd.exe /C` automatically on Windows — if you see this, rebuild Rust: `cd src-tauri && cargo build`.
</details>

<details>
<summary><b>Infinite render loop / "Maximum update depth exceeded"</b></summary>

A Zustand selector is returning a new object/array each render. Find the selector with `|| []` or `?? []` and replace with a module-level constant. See [CLAUDE.md](./CLAUDE.md) → "Zustand selector infinite loop".
</details>

<details>
<summary><b>MCP integration fails with "Failed to fetch"</b></summary>

MCP API calls must route through the Rust HTTP proxy (to bypass WebView CSP/CORS). The proxy is registered in `src-tauri/src/commands/http_proxy.rs` and uses `reqwest`. Rebuild Rust if you see CORS errors.
</details>

<details>
<summary><b>Tile content disappears / blank tiles</b></summary>

Likely a lazy-loaded component (EditorTile, DiffTile) failed to load. Check the browser console (F12 in dev mode) for module import errors. The AppErrorBoundary should catch render crashes and show the error.
</details>

---

## License

MIT © [Fantom Labs](https://github.com/txc0ld)

---

<div align="center">

**Built by [Tay](https://github.com/txc0ld) at Fantom Labs**

[Website](https://fantomlabs.com) · [GitHub](https://github.com/txc0ld/tmx) · [Report an issue](https://github.com/txc0ld/tmx/issues)

</div>
