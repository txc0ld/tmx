# Changelog

All notable changes to TerminalX are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) with [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### Added
- Comprehensive README, CONTRIBUTING guide, LICENSE (MIT)

---

## [1.0.0] — 2026-04-15

Initial public release.

### Tile System (15 types)
- **Terminal** — interactive shell with split panes, command history
- **Agent** — Claude Code, Codex, Gemini CLI with xterm rendering
- **Editor** — Monaco with syntax highlighting, auto-save
- **Diff** — Monaco DiffEditor for code review
- **Note** — Markdown editor with debounced save
- **Todo / Tasks** — with MCP integrations and auto-dispatch
- **Kanban** — drag columns and cards
- **File Tree** — click files to open in Editor
- **Git** — status, log, branches, stage, commit, checkout
- **Browser** — embedded webview for localhost
- **Runner** — one-shot command executor
- **SSH** — remote terminal
- **Docker** — container list + attach
- **Usage** — LLM session + cost tracking
- **Group** — collapse multiple tiles

### Canvas
- Infinite pan/zoom with cursor-centered zoom
- Rubber-band selection (Shift+drag)
- Tile-to-tile snap alignment guides
- Minimap with click-to-navigate
- Rubber-band, multi-select, grouping
- Workspace tabs (named workspaces per project)
- 6 themes (Electric, Phantom, Ember, Ice, Snow, Slate — light)

### Wiring
- 5 wire types: context-pipe, agent-chain, refresh-trigger, task-assign, diff-feed
- Visual drag-to-connect ports
- Auto-pulse animation on data flow

### MCP Integrations
- Slack, GitHub, Linear, Jira, Notion, Google Calendar
- HTTP proxy through Rust (bypasses WebView CSP/CORS)
- Per-project connection storage
- 5-minute auto-sync + seen-task deduplication
- Auto-dispatch to connected agent

### Agent Intelligence
- Multi-Agent Debate (spawn Claude+Codex+Gemini side-by-side)
- Agent Memory (per-project persistent context)
- Auto-Recovery (Runner fails → error auto-dispatched to agent)
- Cost estimation (tokens + $ per agent, per session)

### Workspace
- 3-layer persistence (localStorage cache + disk save + beforeunload)
- Crash recovery from localStorage
- Auto-snapshots every 5 min for time-travel rollback
- Export/import workspaces as JSON
- Save custom layouts as project presets
- Session recording (replay all PTY I/O)

### Productivity
- Command Palette with fuzzy search (Ctrl+K)
- Global search across tiles (Ctrl+F)
- Focus Mode (Ctrl+Enter)
- 40+ keyboard shortcuts
- Clipboard history with paste-to-PTY
- Tile cloning, output pinning, sticky notes
- Image paste (saves to file, pastes path)
- Multi-monitor support (detach tiles to OS windows)

### Developer Experience
- Tauri 2 + React 19 + TypeScript 5.6
- portable-pty 0.8 with 256-byte Windows chunking
- reqwest 0.12 HTTP proxy for MCP
- xterm.js 5.5 with WebGL rendering
- Monaco Editor (lazy-loaded)
- Zustand 5 with 13 stores
- React.memo + lazy imports for performance

### Security
- CSP with minimal allow-list
- Path traversal sanitization
- Git URL / branch name injection prevention
- Custom command binary validation
- HTTPS-only HTTP proxy

---

[Unreleased]: https://github.com/txc0ld/tmx/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/txc0ld/tmx/releases/tag/v1.0.0
