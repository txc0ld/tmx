# TerminalX — Feature Guide

> Infinite canvas workspace for orchestrating CLI agents in parallel.
> Built with Tauri 2 + React 19 + Rust.

---

## What is TerminalX?

TerminalX is a desktop app that lets you run multiple AI coding agents, terminals, and dev tools side-by-side on an infinite canvas. Think Figma meets terminal meets AI. Drag tiles around, wire them together, and let your agents work in parallel while you watch.

---

## X Posts / Social Copy

### The Hook

> TerminalX — run Claude, Codex, and Gemini side by side on an infinite canvas. Wire them together. Let them work in parallel. Ship 10x faster.

### Multi-Agent

> What if you could have 3 AI agents working on your codebase at the same time?
>
> TerminalX lets you run Claude, Codex, and Gemini in parallel on an infinite canvas. One refactors your backend, one writes tests, one builds the frontend. All at once.

### Automation

> I connected Slack to TerminalX.
>
> Now when someone drops a task in our #dev channel, it automatically gets sent to a Claude agent who starts coding it. No human in the loop. Tasks come in, code goes out.

### Multi-Terminal

> TerminalX gives you an infinite canvas of terminals.
>
> Split panes. Drag them around. Run your dev server in one, watch logs in another, SSH into prod in a third. All visible at once. No more tab switching.

### The Dev Workflow

> My TerminalX setup:
> - File tree on the left
> - Terminal + Agent in the center
> - Tasks pulling from GitHub issues on the right
> - Git panel showing live status
>
> Everything wired together. One canvas. Zero context switching.

### Wiring

> The killer feature of TerminalX is wiring.
>
> Connect an agent's output to another agent's input. Chain them. When Agent A finishes, Agent B picks up where it left off. Autonomous multi-step workflows with zero config.

### MCP Integrations

> TerminalX connects to Slack, GitHub, Linear, Jira, and Notion.
>
> Tasks flow in from your existing tools. Hit "Auto" and they get dispatched to an AI agent automatically. Your backlog clears itself.

### For Teams

> Every project in TerminalX gets its own canvas.
>
> Save layouts. Export workspaces as JSON. Share them with your team. Everyone gets the same setup in one click.

### The Canvas

> Why are we still using tabbed terminals in 2025?
>
> TerminalX gives you an infinite canvas. Zoom out to see everything. Zoom in to focus. Drag tiles anywhere. Snap them together. Group them. Bookmark positions. It's spatial computing for developers.

### Docker + SSH

> TerminalX isn't just for AI agents.
>
> Docker container management. SSH terminals. File browsers. Git panels. Code editors. All on the same canvas. All wired together. One app to replace your entire dev toolbar.

### Speed

> Built with Tauri 2 + Rust.
>
> TerminalX uses 50MB of RAM. Native performance. PTY writes chunked at the Rust level. WebGL-rendered terminals. Lazy-loaded Monaco editors. It's fast because it has to be — you're running 10 things at once.

---

## Tile Types (15)

| Tile | Description |
|------|-------------|
| **Terminal** | Interactive shell with split panes (Ctrl+Shift+D), command history dropdown |
| **Agent** | AI agent runner — Claude Code, Codex, Gemini CLI — with real-time xterm output |
| **Editor** | Monaco code editor with syntax highlighting, auto-save, 20+ language support |
| **Diff** | Side-by-side diff viewer powered by Monaco DiffEditor |
| **Note** | Markdown note editor with debounced persistence |
| **Todo / Tasks** | Task list with MCP integrations, auto-dispatch to agents, clear-done |
| **Kanban** | Kanban board with columns, cards, add/remove |
| **File Tree** | Directory browser — click a file to open it in an Editor tile |
| **Git** | Git panel with Status, Log, and Branches tabs — stage, unstage, commit, checkout |
| **Browser** | Embedded web preview for localhost URLs |
| **Runner** | One-shot command executor (npm test, cargo build, etc.) |
| **SSH** | Remote SSH terminal connection |
| **Docker** | Container manager — list, attach, detach |
| **Usage** | LLM usage monitor — internal session tracking + OpenUsage API integration |
| **Group** | Container tile that collapses/expands child tiles |

---

## Canvas

| Feature | How |
|---------|-----|
| **Pan** | Drag empty canvas, middle-click, or Alt+drag |
| **Zoom** | Scroll wheel (zoom toward cursor, 0.1x – 3.0x) |
| **Rubber-band select** | Shift+drag on empty canvas to select multiple tiles |
| **Tile snapping** | Alignment guide lines appear when edges align with other tiles |
| **Minimap** | Bottom-right overview — click to navigate |
| **Grid** | SVG dot-pattern background for visual alignment |
| **Focus Mode** | Ctrl+Enter to maximize focused tile, dim others |
| **Multi-select** | Shift+click tiles, then move/delete/group together |
| **Bookmarks** | Save up to 9 canvas positions (Ctrl+Shift+B), jump with Ctrl+1–9 |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Command Palette |
| `Ctrl+F` | Search across all tiles |
| `Ctrl+Enter` | Toggle Focus Mode |
| `Ctrl+Tab` | Cycle to next tile |
| `Ctrl+Shift+Tab` | Cycle to previous tile |
| `Ctrl+W` | Close focused/selected tiles |
| `Ctrl+G` | Group selected tiles |
| `Ctrl+Shift+B` | Save canvas bookmark |
| `Ctrl+1` – `Ctrl+9` | Jump to bookmark |
| `Ctrl+J` | Toggle session timeline |
| `Ctrl+Shift+D` | Split terminal pane horizontally |
| `Ctrl+Arrow` | Navigate between split panes |
| `Escape` | Close overlays, exit focus mode, clear selection |

---

## Wiring System

Connect tiles with data-flow wires. Drag from output port to input port.

| Wire Type | From → To | Behavior |
|-----------|-----------|----------|
| **context-pipe** | Terminal/Agent → Agent | Pipes last 50 lines of output as context on completion |
| **agent-chain** | Agent → Agent | Chains agent output to next agent's input |
| **refresh-trigger** | Agent → Browser | Notifies browser tile to refresh on agent completion |
| **task-assign** | Agent → Todo | Adds agent's last output line as a new task |
| **diff-feed** | Agent → Diff | Signals diff tile to refresh on agent completion |

---

## MCP Integrations

Connect external services to pull tasks into the Tasks tile.

| Service | What It Pulls |
|---------|---------------|
| **Slack** | Channel messages (Bot Token + Channel ID) |
| **GitHub** | Open issues from a repo (Personal Access Token) |
| **Linear** | Assigned issues (API Key) |
| **Jira** | Assigned tickets (Host + Email + API Token) |
| **Notion** | Database entries (Integration Token + Database ID) |
| **Google Calendar** | Upcoming events (API Key) |

- Connections are **per-project** — each project has its own integrations
- Tasks sync every **5 minutes** + manual refresh
- **Seen tracking** — dismissed/imported tasks never reappear
- **Auto-dispatch** — toggle "Auto" to send new tasks directly to a connected agent

---

## Git Integration

The Git tile provides a full git workflow without leaving TerminalX.

**Status tab:** Staged/unstaged files with +/- buttons, commit box
**Log tab:** Commit history with hash, author, date, message
**Branches tab:** List all branches, click to checkout

All data auto-refreshes every 30 seconds.

---

## Workspace Management

| Feature | Description |
|---------|-------------|
| **Workspace Tabs** | Multiple named workspaces per project — click "+" to create |
| **Save Layout** | Save button in top bar persists current tile arrangement |
| **Default Layout** | Layout button restores saved layout or creates a default 5-tile workspace |
| **Snapshots** | Save/load named canvas states via Command Palette |
| **Export/Import** | Export workspace as JSON, import from file (Command Palette) |
| **Auto-save** | Disk save every 2s + localStorage cache every 500ms |
| **Crash recovery** | Restores last state from localStorage on startup |
| **Active project** | Remembers which project was open across restarts |

---

## Themes

6 built-in themes, switchable from the status bar.

| Theme | Accent | Background |
|-------|--------|------------|
| **Electric** | `#CCFF00` lime | Black |
| **Phantom** | `#6600FF` purple | Black |
| **Ember** | `#F53F3F` red | Black |
| **Ice** | `#22D3EE` cyan | Black |
| **Snow** | `#FFFFFF` white | Black |
| **Slate** | `#2C3525` olive | `#CCD2BA` sage |

Light and dark themes are both supported — surface colors, text opacity, and glow intensity adapt automatically.

---

## Templates

16 built-in templates accessible from the Add Tile dropdown and Command Palette.

**Agents:** Claude Opus 4, Claude Sonnet, Codex, Gemini
**Terminals:** Shell at home, Shell at project root
**Content:** Quick Note, Todo List, Browser :3000, Browser :5173
**Runners:** npm test, npm build, cargo test, cargo build
**Infra:** File Tree, SSH Terminal, Docker

Save any tile as a custom template via the star button on hover.

---

## Session Recording

Record all terminal I/O with timestamps for later replay.

- **Rec button** in the status bar — click to start/stop
- Captures output from all PTY sessions
- Auto-stops at 50,000 events
- Last recording saved to localStorage

---

## Usage Monitoring

The Usage tile tracks LLM agent activity.

**Internal tracking:**
- Total sessions, duration, active count
- Per-agent breakdown (Claude, Codex, Gemini)
- Auto-tracks when agent tiles start/finish

**OpenUsage integration:**
- Polls `127.0.0.1:6736/v1/usage` every 30s
- Shows provider plans, usage progress bars, reset dates
- Color-coded: green (<70%), yellow (70-90%), red (>90%)

---

## Plugin System

Extend TerminalX with custom tile types.

- Register plugins via Command Palette (JSON manifest or URL)
- Plugins render in sandboxed iframes
- Enable/disable per plugin
- Persisted to localStorage

**Manifest format:**
```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "tileType": "my-custom-tile",
  "entryUrl": "https://example.com/plugin.html"
}
```

---

## Multi-Monitor

Detach any tile into its own OS window.

- Hover a tile → click the ↗ arrow button
- Tile opens in a new native window
- Closing the window restores the tile to the canvas
- Window is resizable with native decorations

---

## Project Management

Projects live in the bottom-left sidebar.

- **Add project** — name + folder picker
- **Clone from GitHub** — URL input, auto-extracts repo name, native folder picker
- **Delete** — right-click a project icon
- **Favicons** — auto-resolves `favicon.ico`, `logo.png`, etc. from repo as project avatar
- **Working directory** — shown in the status bar

---

## Command Palette (Ctrl+K)

Fuzzy-searchable command launcher with categories:

- **Templates** — spawn tiles from presets
- **Projects** — switch active project
- **Workspace** — save/load snapshots, export/import
- **Commands** — focus mode, reset zoom, group tiles
- **Navigate** — jump to bookmarks
- **Clipboard** — paste from history to focused tile's PTY
- **Plugins** — register new plugins

---

## Search (Ctrl+F)

Global search across all tile content on the canvas.

**Searches:** tile titles, note content, todo items, editor file paths, terminal output
**Features:** keyboard navigation, Enter to center viewport on match, 50 result limit

---

## Architecture

| Layer | Technology |
|-------|-----------|
| **Desktop shell** | Tauri 2 (Rust + WebView2) |
| **Frontend** | React 19 + TypeScript 5 + Vite 6 |
| **State** | Zustand 5 (10 stores) |
| **Terminal** | xterm.js 5.5 + WebGL renderer |
| **Editor** | Monaco Editor (lazy-loaded) |
| **PTY** | portable-pty 0.8 (Rust) |
| **HTTP** | reqwest 0.12 (Rust, for MCP proxy) |
| **Styling** | CSS custom properties + inline styles (no CSS files) |
| **Persistence** | Tauri filesystem + localStorage crash cache |
