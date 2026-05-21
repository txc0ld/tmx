<div align="center">

# TerminalX

### **The canvas-native terminal.** Run Claude, Codex, and Gemini side-by-side, wire them together, and ship 10× faster.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.90+-000000?logo=rust)](https://rust-lang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript)](https://typescriptlang.org)

[**Feature docs**](./docs/features/README.md) · [**Wiring tutorial**](./WIRING.md) · [**Pipeline guide**](./docs/PIPELINE.md) · [**Features**](./FEATURES.md) · [**Design**](./DESIGN.md) · [**Install**](#install) · [**Quick start**](#quick-start)

</div>

---

<img width="2560" height="1392" alt="termX" src="https://github.com/user-attachments/assets/ec45aee4-c69d-481a-a96f-9e4da97d804f" />

---

## Why it's different

Most dev tools give you one thing at a time: one terminal, one editor, one browser tab.

**TerminalX gives you a canvas.** Tiles arrange spatially, connect with wires, and automate the copy-paste out of your day.

<br />

### 🧠 &nbsp; Orchestrate AI CLIs

Spawn Claude, Codex, and Gemini as first-class tiles.

Auto-complete detection means you don't wait for process exit — chains fire on logical completion.

<br />

### 🔗 &nbsp; Wire anything to anything

Six wire types. Drag from one tile's output port to another's input port — the type auto-infers.

```
Terminal  →  Agent      context-pipe
Agent     →  Agent      agent-chain
Runner    →  Agent      auto-fix loop
Todo      →  Agent      task dispatch
FileTree  →  Editor     file-open routing
Agent     →  Browser    refresh trigger
```

<br />

### 💬 &nbsp; Inbox, meet IDE

MCP connectors for Slack, GitHub, Linear, Jira, Notion, Calendar, Gmail.

Tasks land in a Todo tile — optionally auto-dispatched to a wired agent.

<br />

### ⚡ &nbsp; Native performance

Tauri 2 + Rust. **47 MB idle.**

Native PTY with bounded-channel backpressure. WebGL-rendered terminals. Connection-pooled HTTP proxy. Per-tile lazy chunks.

<br />

### 🛡️ &nbsp; Hardened

SSRF-guarded HTTP with pinned DNS. Shell allowlist. 64-PTY cap. Path validation. Atomic writes.

Workspace schema validation on import. CSP without `unsafe-inline` in `script-src`.

<br />

### 💾 &nbsp; Never loses work

Three-layer auto-save: `localStorage` → disk → `beforeunload`.

Auto-snapshots every 5 min for time-travel. Export workspaces as portable JSON.

---

## Who it's for

Developers who would rather **see everything at once** than alt-tab through tabs and windows. Multi-agent practitioners who need a spatial model of who's doing what. Teams who live in Slack + Linear and want that context inside the dev loop, not on a different monitor.

If you prefer IDE-driven single-file editing, you'll find this foreign. If you've ever wished your terminal sprawled into something bigger — you're home.

---

## Feature documentation

Every feature has its own page in [**docs/features/**](./docs/features/README.md). Quick links:

| Category | Highlights |
|---|---|
| **[Tiles](./docs/features/README.md#tile-types-15)** | [Terminal](./docs/features/tiles/terminal.md) · [Agent](./docs/features/tiles/agent.md) · [Editor](./docs/features/tiles/editor.md) · [Diff](./docs/features/tiles/diff.md) · [Git](./docs/features/tiles/git.md) · [Runner](./docs/features/tiles/runner.md) · [SSH](./docs/features/tiles/ssh.md) · [Docker](./docs/features/tiles/docker.md) · [+7 more](./docs/features/README.md#tile-types-15) |
| **[Wiring](./docs/features/README.md#wiring-system)** | [Overview](./docs/features/wiring/overview.md) · [context-pipe](./docs/features/wiring/context-pipe.md) · [agent-chain](./docs/features/wiring/agent-chain.md) · [task-assign](./docs/features/wiring/task-assign.md) · [file-open](./docs/features/wiring/file-open.md) · [+2 more](./docs/features/README.md#wiring-system) |
| **[Canvas](./docs/features/README.md#canvas--workspace)** | [Infinite canvas](./docs/features/canvas/infinite-canvas.md) · [Workspace tabs](./docs/features/canvas/workspace-tabs.md) · [Bookmarks](./docs/features/canvas/bookmarks.md) · [Minimap](./docs/features/canvas/minimap.md) · [Tile dock](./docs/features/canvas/tile-dock.md) · [Layouts](./docs/features/canvas/layouts.md) |
| **[Agents](./docs/features/README.md#agent-orchestration)** | [Spawn](./docs/features/agents/agent-spawn.md) · [Memory](./docs/features/agents/agent-memory.md) · [Auto-complete](./docs/features/agents/auto-complete.md) · [Auto-pipe](./docs/features/agents/auto-pipe.md) · [Pipe button](./docs/features/agents/pipe-button.md) |
| **[Workflows](./docs/features/README.md#workflows--patterns)** | [Prompt library](./docs/features/workflows/prompt-library.md) · [Starter layouts](./docs/features/workflows/starter-layouts.md) · [Wire blueprints](./docs/features/workflows/blueprints.md) |
| **[Integrations](./docs/features/README.md#external-integrations-mcp)** | [Slack](./docs/features/integrations/slack.md) · [GitHub](./docs/features/integrations/github.md) · [Linear](./docs/features/integrations/linear.md) · [Jira](./docs/features/integrations/jira.md) · [Notion](./docs/features/integrations/notion.md) · [Calendar](./docs/features/integrations/google-calendar.md) · [Gmail](./docs/features/integrations/gmail.md) · [HTTP proxy](./docs/features/integrations/http-proxy.md) · [OpenUsage](./docs/features/integrations/openusage.md) |
| **[Persistence](./docs/features/README.md#persistence--recovery)** | [Workspace](./docs/features/persistence/workspace.md) · [Snapshots](./docs/features/persistence/snapshots.md) · [Recording](./docs/features/persistence/session-recording.md) · [Time travel](./docs/features/persistence/time-travel.md) · [Import/export](./docs/features/persistence/import-export.md) |
| **[UX](./docs/features/README.md#ux--productivity)** | [Palette](./docs/features/ux/command-palette.md) · [Templates](./docs/features/ux/templates.md) · [History](./docs/features/ux/command-history.md) · [Timeline](./docs/features/ux/session-timeline.md) · [Themes](./docs/features/ux/theme-system.md) · [Detach + clone](./docs/features/ux/detach-clone.md) |
| **[Platform](./docs/features/README.md#platform--engine)** | [PTY management](./docs/features/platform/pty-management.md) · [FS access](./docs/features/platform/filesystem-access.md) · [Bundle](./docs/features/platform/bundle-chunking.md) · [Window chrome](./docs/features/platform/window-chrome.md) · [Security](./docs/features/platform/security.md) |

Each page has a **Power moves** section with non-obvious workflows.

---

## Platform support

| Platform | Status | Notes |
|---|---|---|
| **Windows 10 / 11** | ✅ Fully supported | Primary target. Needs VS Build Tools for dev. |
| **macOS (Intel / Apple Silicon)** | ✅ Fully supported | Native traffic lights, `⌘` modifier in UI. |
| **Linux (Ubuntu / Fedora / Arch)** | ✅ Fully supported | Uses `$SHELL`. Needs webkit2gtk. |
| **iOS / Android** | ❌ Not feasible | Mobile sandboxes forbid PTY spawning. |

---

## Install

Pick your OS. First build compiles ~500 Rust crates (2–3 min); subsequent builds are incremental.

### macOS

<details open>
<summary><b>Step-by-step (Intel or Apple Silicon)</b></summary>

```bash
# 1. Xcode CLT (provides the Rust linker)
xcode-select --install

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 3. Node 22+ and pnpm
brew install node  # or from nodejs.org
npm install -g pnpm

# 4. Clone and run
git clone https://github.com/txc0ld/tmx.git
cd tmx
pnpm install
pnpm tauri dev

# 5. (Optional) Distributable
pnpm tauri build
# → src-tauri/target/release/bundle/
```

**Troubleshooting**
- `cargo: command not found` → `source "$HOME/.cargo/env"` or open a new terminal.
- `"Cannot verify developer"` on a bundled `.dmg` → right-click app → Open → Open.

</details>

### Windows 10 / 11

<details>
<summary><b>Step-by-step (PowerShell)</b></summary>

```powershell
# 1. Install Visual Studio Build Tools 2022 from
#    https://visualstudio.microsoft.com/downloads/
#    Workload: "Desktop development with C++" + Windows SDK

# 2. Rust — run rustup-init.exe from https://rustup.rs

# 3. Node 22+ from https://nodejs.org, then:
npm install -g pnpm

# 4. WebView2 — preinstalled on Win10 (May 2022+) and Win11.
#    Otherwise: https://developer.microsoft.com/microsoft-edge/webview2/

# 5. Clone and run (PowerShell — NOT git-bash)
git clone https://github.com/txc0ld/tmx.git
cd tmx
pnpm install
pnpm tauri dev

# 6. (Optional) MSI installer
pnpm tauri build
# → src-tauri\target\release\bundle\msi\TerminalX_0.1.0_x64_en-US.msi
```

**Troubleshooting**
- `link.exe not found` → you're in git-bash. Use PowerShell or `cmd.exe`.
- `MSB8066: custom build exited with code 1` → reopen shell after installing Build Tools.
- "Agent Spawn Failed: not a valid Win32 application" → rebuild: `cd src-tauri && cargo build`.

</details>

### Linux

<details>
<summary><b>Ubuntu / Debian</b></summary>

```bash
# 1. Build deps
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# 3. Node 22+ and pnpm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install -g pnpm

# 4. Clone and run
git clone https://github.com/txc0ld/tmx.git
cd tmx && pnpm install && pnpm tauri dev

# 5. (Optional) AppImage / .deb
pnpm tauri build
```

**Troubleshooting**
- `no package 'webkit2gtk-4.1' found` → try `libwebkit2gtk-4.0-dev`.
- Blank window on NVIDIA + Wayland → `WEBKIT_DISABLE_COMPOSITING_MODE=1 pnpm tauri dev`.

</details>

<details>
<summary><b>Fedora / Arch</b></summary>

```bash
# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel gcc gcc-c++ make

# Arch
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg
```

Then continue from **Step 2** (Rust) in the Ubuntu guide.

</details>

### Let an AI agent install it

Paste any of these into Claude Code, Codex CLI, or Gemini CLI — it'll handle OS detection, prereq checks, and the walkthrough.

<details>
<summary><b>Prompt for Claude / Codex / Gemini</b></summary>

```
I want to install TerminalX from https://github.com/txc0ld/tmx on this machine.

Please:
1. Detect my OS, shell, and architecture.
2. Check which prerequisites I have: git, rustc/cargo, node (v22+), pnpm,
   and OS build tools (Xcode CLT on macOS, MSVC Build Tools on Windows,
   webkit2gtk + build-essential on Linux).
3. For anything missing, tell me the exact install command — don't run
   sudo or system-level installs without confirming with me first.
4. Clone to ~/tmx (or C:\src\tmx on Windows), run `pnpm install`, then
   `pnpm tauri dev` in the background.
5. Report back when the app window opens, or surface the error if the
   build fails. Use the README as source of truth; ask before deviating.
```

</details>

---

## Quick start

```bash
pnpm tauri dev
```

1. **Add a project** — `+` in the sidebar, pick your repo folder.
2. **Apply default layout** — top-bar **Layout** button spawns Terminal + Agent + File Tree + Tasks + Git.
3. **Open the palette** — `Ctrl/⌘+K`, fuzzy-search 25+ commands.
4. **Connect an integration** — palette → "Add MCP Connection" → Slack / GitHub / Linear etc. See [MCP overview](./docs/features/integrations/overview.md).
5. **Wire something up** — drag a Terminal's right port to an Agent's left port. See [wiring tutorial](./WIRING.md).

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/⌘+K` | Command palette |
| `Ctrl/⌘+F` | Search across all tile content |
| `Ctrl/⌘+Enter` | Toggle focus mode |
| `Ctrl/⌘+Tab` / `+Shift+Tab` | Cycle through tiles |
| `Ctrl/⌘+W` | Close focused/selected tiles |
| `Ctrl/⌘+G` | Group selected tiles |
| `Ctrl/⌘+Shift+B` | Save canvas bookmark |
| `Ctrl/⌘+1`–`9` | Jump to bookmark |
| `Ctrl/⌘+Shift+D` | Split terminal pane |
| `Ctrl+Arrow` | Navigate split panes |
| `Shift+Drag` | Rubber-band select |
| `Alt+Drag` / middle-click | Pan canvas |
| `Scroll` | Zoom canvas |
| `Escape` | Close overlays / exit focus mode |

---

## Dev commands

```bash
pnpm tauri dev          # Full stack (Rust + Vite HMR)
pnpm dev                # Frontend-only (no Tauri)
pnpm tauri build        # Production binary for your OS
pnpm test               # Frontend unit tests (Vitest)
npx tsc --noEmit        # TypeScript type-check
cd src-tauri && cargo check   # Rust type-check
cd src-tauri && cargo test    # Rust tests
```

CI runs on every push/PR across Ubuntu, Windows, and macOS — see [.github/workflows/ci.yml](./.github/workflows/ci.yml).

---

## Architecture

```
React 19 frontend (src/)                Rust backend (src-tauri/)
┌────────────────────────────┐          ┌──────────────────────────┐
│ InfiniteCanvas              │          │ 30+ IPC commands         │
│ TileShell (memo'd)          │  IPC /   │  • PTY (portable-pty,    │
│ 15 tile components          │ ←────→   │    bounded channel,      │
│ WiringLayer + engine        │  events  │    64 cap)               │
│                             │          │  • Agents (.cmd wrap)    │
│ 14 Zustand stores           │          │  • 11 git commands       │
│ Hooks (usePty, useCanvas,   │          │  • Docker, filesystem,   │
│   useWiringEngine)          │          │    workspace, timeline   │
│                             │          │  • HTTP proxy (SSRF +    │
│ Lazy chunks per tile        │          │    DNS pinned + pooled)  │
└────────────────────────────┘          └──────────────────────────┘
```

**Stack:** Tauri 2 · React 19 · TypeScript 5.6 · Vite 6 · Zustand 5 · xterm.js 5 · Monaco · portable-pty 0.8 · reqwest 0.12

Deep architecture: [**CLAUDE.md**](./CLAUDE.md) · Design system: [**DESIGN.md**](./DESIGN.md) · Security posture: [**CONTRIBUTING.md**](./CONTRIBUTING.md#security-posture).

---

## Project structure

```
src/                    React frontend
├── components/
│   ├── canvas/         InfiniteCanvas, Minimap, TileDock, WorkspaceTabs
│   ├── tiles/          15 tile components + TileShell
│   ├── topbar/         Layout menu, Clear Canvas, theme picker
│   ├── palette/        Command palette
│   ├── wiring/         Wire rendering + drag-to-connect
│   └── timeline/       Session timeline
├── stores/             14 Zustand stores
├── hooks/              usePty, useCanvas, useWiringEngine
├── utils/              ipc, layout, workspaceImport, detachTile
├── design/             Token-based design system (tokens.ts)
└── types/              Discriminated unions for all tile types

src-tauri/              Rust backend
├── src/
│   ├── commands/       30+ IPC handlers
│   └── state/          AppState, PtyManager
├── capabilities/       Tauri permission manifests
└── icons/              App icons

docs/features/          Per-feature documentation (~55 files)
CLAUDE.md               Architecture + critical patterns for AI agents
DESIGN.md               Design-system source of truth
FEATURES.md             Product feature tour
WIRING.md               Drag-to-connect wiring tutorial
CONTRIBUTING.md         PR workflow + security posture
```

---

## Contributing

Contributions welcome. See [**CONTRIBUTING.md**](./CONTRIBUTING.md) for the full workflow, security posture, and PR checklist.

**Quick guidelines:**
1. Fork and branch (`feat/your-feature`).
2. Type-check (`npx tsc --noEmit`) before committing.
3. Follow patterns in [CLAUDE.md](./CLAUDE.md) — especially Zustand selectors (the #1 crash cause) and the memoization rules.
4. Cross-platform: if you touched Rust or IPC, test on your OS + confirm CI passes on all three.
5. Conventional commits (`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`).

### Known patterns to avoid

- ❌ `useXxxStore(s => s.thing || [])` — creates new arrays every render, infinite loop. Use a module-level constant with `??`.
- ❌ `invoke()` directly from components — always wrap in `utils/ipc.ts`.
- ❌ Hardcoded colors — use `colors.*` from `design/tokens.ts`.
- ❌ `@tauri-apps/plugin-fs` for user project files — scope is too narrow. Use `readFileText` / `writeFileText` from `utils/ipc.ts`.

---

## License

MIT © [Fantom Labs](https://github.com/txc0ld)

---

<div align="center">

**Built by [Tay](https://github.com/txc0ld) at Fantom Labs**

[Website](https://fantomlabs.io) · [GitHub](https://github.com/txc0ld/tmx) · [Issues](https://github.com/txc0ld/tmx/issues) · [Feature docs](./docs/features/README.md)

</div>
