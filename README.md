# TerminalX

> Infinite canvas terminal workspace for AI agent orchestration.

Built on Tauri 2 + React + Rust. Designed with the Kinetic Topology design system.

## Prerequisites

- **Rust** — [rustup.rs](https://rustup.rs)
- **Node.js** ≥ 22 — [nodejs.org](https://nodejs.org)
- **pnpm** — `npm install -g pnpm`
- **Tauri CLI** — installed via `pnpm` (in devDependencies)

### Platform-specific

**Windows:**
- Visual Studio Build Tools 2022 with C++ workload
- WebView2 (pre-installed on Windows 10/11)

**macOS:**
- Xcode Command Line Tools: `xcode-select --install`

**Linux:**
- `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libssl-dev libayatana-appindicator3-dev librsvg2-dev`

## Setup

```bash
# Clone / unzip the project
cd terminalx

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev
```

## Architecture

See [AGENTS.md](./AGENTS.md) for full architecture, coding conventions, and critical paths.

See [PRD.md](./PRD.md) for product requirements and milestones.

See [DESIGN.md](./DESIGN.md) for the Kinetic Topology design system.

## Key Commands

| Command | Action |
|---------|--------|
| `pnpm tauri dev` | Start dev mode (Rust + Vite hot reload) |
| `pnpm tauri build` | Build production binary |
| `pnpm dev` | Frontend only (no Tauri) |
| `cargo test` | Run Rust tests |

## Keyboard Shortcuts (In-App)

| Shortcut | Action |
|----------|--------|
| `⌘K` / `Ctrl+K` | Command Palette |
| `⌘⏎` / `Ctrl+Enter` | Toggle Focus Mode |
| `⌘J` / `Ctrl+J` | Toggle Session Timeline |
| `Alt + Drag` | Pan canvas |
| `Scroll` | Zoom canvas |
| `Escape` | Exit focus mode / close palette |

## Project Structure

```
src-tauri/     → Rust backend (PTY, agents, filesystem, workspace persistence)
src/           → React frontend (canvas, tiles, stores, design tokens)
```

---

*Fantom Labs — Built by Tay*
