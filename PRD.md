# TerminalX — Product Requirements Document

> **One line:** Infinite canvas workspace that turns CLI agent orchestration from tab-switching chaos into spatial, visual, wired workflow.

---

## Product Vision

TerminalX is a native desktop application that replaces the terminal multiplexer + IDE + browser tab sprawl that defines modern AI-assisted development. Every tool a developer interacts with — CLI agents, terminals, browsers, file trees, task lists, diffs — lives as a tile on an infinite canvas. Tiles are spatially arranged, visually monitored, and **wired together** so data flows between them without copy-paste.

The developer is a conductor. The canvas is the score. The agents are the orchestra.

---

## Target User

Technical founders and senior developers who:
- Run 2-5 CLI agents simultaneously (Claude Code, Codex, Gemini CLI)
- Work across multiple projects daily
- Context-switch constantly between terminal, browser, and editor
- Value keyboard-first workflow and spatial memory
- Run Windows + macOS (cross-platform is mandatory)

---

## Core Concepts

### 1. Projects
Discord-style project switching. Left sidebar shows project icons. Each project has its own canvas state, tile layout, and workspace configuration. Switching is instant — canvas state persists per project.

### 2. Infinite Canvas
Stitch/Figma-style infinite canvas with pan (Alt+drag / middle-click) and zoom (scroll wheel). Dot grid background scales with zoom. Minimap in bottom-right shows viewport position. Canvas is the workspace — not a grid, not tabs, not splits.

### 3. Tiles
Draggable, resizable panels on the canvas. Each tile is a functional unit:

| Tile Type | Purpose | Key Feature |
|-----------|---------|-------------|
| **Agent** | Claude Code / Codex / Gemini CLI | Live status badge, model info, elapsed timer, bypass perms |
| **Terminal** | OS shell (zsh/bash/pwsh) | Real PTY via Rust, supports splits (tmux-like) |
| **Browser** | Embedded webview | Real localhost preview, not a placeholder |
| **Todo** | Task management | Drag-to-assign to agent tiles |
| **Diff** | Code review | PR-style inline comments → agent reads feedback |
| **Editor** | Code editing | Monaco Editor, syntax highlighting |
| **Note** | Canvas annotation | Markdown-rendered, glassmorphic, placed anywhere |
| **Kanban** | Board view | Columns for pipeline stages |

### 4. Wiring
SVG connections between tiles. Output port on one tile → input port on another. When data flows, the connection line animates (#ccff00 dashed, 1.2s linear). Types of wires:

- **Terminal → Agent**: terminal output feeds as context to agent
- **Agent → Browser**: agent saves file → browser auto-refreshes
- **Todo → Agent**: drag task → agent receives as prompt
- **Agent → Diff**: agent completes → diff tile shows changes
- **Agent → Agent**: chain agent outputs as inputs

### 5. Focus Mode
`⌘⏎` enters Focus Mode. Select 1-2 tiles. Everything else dims (15% opacity, blurred). Selected tiles center and scale up. This is pair-programming mode — one human, one agent, zero distraction. Escape exits.

### 6. Command Palette
`⌘K` opens a Raycast-grade fuzzy search overlay. Actions:
- Switch projects
- Spawn tile (by type)
- Run shell command
- Jump to tile (by name)
- Search file contents across project
- Toggle focus mode
- Save/load workspace snapshot
- Kill agent process

### 7. Workspace Snapshots
Save entire canvas layout as a named preset. Restore instantly. Examples:
- "Solidity Audit" — Claude + terminal + diff + forge test output
- "Frontend Sprint" — browser preview + terminal + todo + agent
- "Ship Mode" — all agents active + browser + terminal + kanban

### 8. Session Timeline
Collapsible bottom drawer. Horizontal timeline of all events:
- Commands executed
- Files modified
- Agent prompts sent
- Build results
- Git operations
Scrub backwards to replay. Filter by tile/agent. Dev flight recorder.

### 9. Status Rail
Thin persistent bar at canvas bottom:
- Per-agent CPU/RAM
- Active git branch + dirty file count
- Network status
- Total session uptime
- Active wiring count

### 10. Spatial Toasts
When an agent finishes, toast notification slides in from the direction of that tile on canvas. If Claude tile is top-left, toast enters from top-left. Reinforces spatial memory of where things are.

---

## Technical Requirements

### Performance
- Cold start: < 2 seconds
- Canvas pan/zoom: 60fps with 20+ tiles
- PTY input latency: < 16ms
- Binary size: < 15MB
- Memory baseline (no agents): < 80MB

### Platform
- Windows 10/11 (x64)
- macOS 12+ (ARM + Intel)
- Linux (Debian/Ubuntu, stretch goal)

### Security
- Tauri 2 capability system — least-privilege by default
- No telemetry, no phoning home
- Code and prompts never leave the machine
- Per-project filesystem access scoping

---

## Milestones

### M1 — Foundation (Weeks 1-3)
- [ ] Tauri 2 project scaffold with Rust + React
- [ ] Infinite canvas with pan/zoom/minimap
- [ ] Project sidebar with switching
- [ ] Tile shell (drag, resize, z-stack, close)
- [ ] Terminal tile with real PTY
- [ ] Agent tile (Claude Code CLI spawn + output stream)
- [ ] Design system applied (Kinetic Topology)
- [ ] Workspace state persistence to disk

### M2 — Orchestration (Weeks 4-6)
- [ ] Wiring system (SVG connections, data flow)
- [ ] Command palette (⌘K)
- [ ] Focus mode (⌘⏎)
- [ ] Todo tile with drag-to-assign
- [ ] Browser tile with Tauri webview
- [ ] Spatial toast notifications
- [ ] Status rail

### M3 — Power Features (Weeks 7-9)
- [ ] Terminal splits (tmux-like)
- [ ] Diff tile with inline comments
- [ ] Editor tile (Monaco)
- [ ] Session timeline
- [ ] Workspace snapshots
- [ ] Canvas annotations (Note tile)
- [ ] Multi-agent process management (Codex, Gemini CLI)

### M4 — Polish & Ship (Weeks 10-12)
- [ ] Global hotkeys (⌘Space to summon)
- [ ] System tray integration
- [ ] Auto-update mechanism
- [ ] Onboarding flow
- [ ] Performance optimization pass
- [ ] Cross-platform build pipeline
- [ ] Installer packaging (MSI + DMG)

---

## Competitive Position

| Product | What it does | Where TerminalX wins |
|---------|-------------|---------------------|
| **Nyx** | Tiled canvas for AI agents | Wiring system, command palette, workspace snapshots |
| **Warp** | Modern terminal | Not a canvas, no agent orchestration, no wiring |
| **tmux** | Terminal multiplexer | No visual canvas, no agent integration, no browser |
| **Cursor** | AI-powered IDE | Editor-first not canvas-first, no multi-agent orchestration |
| **VS Code** | IDE with terminal | Tab-based, no spatial layout, no wiring |

TerminalX is not a terminal. It is not an IDE. It is an **orchestration canvas** — the missing layer between the developer and the agents doing the work.

---

## Branding

- **Name:** TerminalX
- **Aesthetic:** Kinetic Topology — cinematic, brutalist contrast meets glassmorphism
- **Primary accent:** `#ccff00` Electric Lime
- **Typography:** Plus Jakarta Sans (titles) + Public Sans (body) + JetBrains Mono (code)
- **Philosophy:** The void is intentional. Light is hierarchy. Every glow earns its place.

---

*Fantom Labs — Built by Tay*
