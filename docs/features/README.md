# Feature Reference

Deep dives into every feature in TerminalX. Each page is scannable — a short description, how to use it, common workflows, and a tech note for developers extending the app.

For product-level overview, see the [**root README**](../../README.md). For the quick feature tour, see [**FEATURES.md**](../../FEATURES.md).

---

## Tile types (15)

The canvas hosts 15 discrete tile kinds, each with its own renderer and state model.

| Tile | What it does |
|---|---|
| [**Terminal**](./tiles/terminal.md) | xterm.js shell with optional split panes |
| [**Agent**](./tiles/agent.md) | Claude / Codex / Gemini orchestrated inside a PTY |
| [**Editor**](./tiles/editor.md) | Monaco code editor with tiered loading for big files |
| [**Diff**](./tiles/diff.md) | Side-by-side compare (git / files / paste) |
| [**Browser**](./tiles/browser.md) | Embedded iframe for dev servers |
| [**Note**](./tiles/note.md) | Freeform markdown scratch pad |
| [**Todo**](./tiles/todo.md) | Task list with MCP inbox integration |
| [**Kanban**](./tiles/kanban.md) | Multi-column task board |
| [**File Tree**](./tiles/filetree.md) | Directory browser wired into editors |
| [**Group**](./tiles/group.md) | Collapse related tiles into one |
| [**Runner**](./tiles/runner.md) | Run a command once, show exit status |
| [**SSH**](./tiles/ssh.md) | Remote shell over SSH |
| [**Docker**](./tiles/docker.md) | Container list + attach |
| [**Git**](./tiles/git.md) | Status, log, branches, commit |
| [**Usage**](./tiles/usage.md) | Agent session tracker + OpenUsage panel |

## Wiring system

Drag from one tile's output port to another's input port. The app infers the wire type.

| Wire | Source → Target | Purpose |
|---|---|---|
| [**Overview**](./wiring/overview.md) | — | How wiring works end-to-end |
| [**context-pipe**](./wiring/context-pipe.md) | Terminal → Agent | Pipe terminal output as agent context |
| [**agent-chain**](./wiring/agent-chain.md) | Agent → Agent | Feed one agent's output as the next prompt |
| [**refresh-trigger**](./wiring/refresh-trigger.md) | Agent → Browser | Reload a dev server after agent completes |
| [**task-assign**](./wiring/task-assign.md) | Todo → Agent | Dispatch tasks to agents on creation |
| [**diff-feed**](./wiring/diff-feed.md) | Agent → Diff | Auto-populate a diff tile from agent output |
| [**file-open**](./wiring/file-open.md) | File Tree → Editor/Diff | Click-routed file opens into wired target |

## Canvas & workspace

| Page | Summary |
|---|---|
| [**Infinite canvas**](./canvas/infinite-canvas.md) | Pan, zoom, snap, rubber-band select |
| [**Workspace tabs**](./canvas/workspace-tabs.md) | Multiple canvases per project |
| [**Bookmarks**](./canvas/bookmarks.md) | Save + jump to canvas positions |
| [**Minimap**](./canvas/minimap.md) | Overview + click to jump |
| [**Tile dock**](./canvas/tile-dock.md) | Quick-launch shelf, customizable per-device |
| [**Layout slots**](./canvas/layouts.md) | 5 saved layouts per project |

## Agent orchestration

| Page | Summary |
|---|---|
| [**Agent spawn**](./agents/agent-spawn.md) | How Claude / Codex / Gemini actually start |
| [**Agent memory**](./agents/agent-memory.md) | Per-project context auto-injected into every agent |
| [**Auto-complete**](./agents/auto-complete.md) | DONE sentinel + idle detection without process exit |
| [**Auto-pipe**](./agents/auto-pipe.md) | Hands-free source → agent once the source goes idle |
| [**Pipe Context button**](./agents/pipe-button.md) | Manual one-shot pipe for wired sources |

## Workflows & patterns

High-level composition features that wrap the primitives into reusable flows.

| Page | Summary |
|---|---|
| [**Prompt library**](./workflows/prompt-library.md) | 8 curated prompts + your saves, one-click dispatch to any agent |
| [**Starter layouts**](./workflows/starter-layouts.md) | Detect project type (Rust / Tauri / Next.js / …) → spawn matching tile set |
| [**Wire blueprints**](./workflows/blueprints.md) | Save tile + wire compositions as reusable patterns — components for workflows |

## External integrations (MCP)

| Page | Summary |
|---|---|
| [**MCP overview**](./integrations/overview.md) | How external services are wired |
| [**Slack**](./integrations/slack.md) | Messages → tasks |
| [**GitHub**](./integrations/github.md) | Assigned issues + PRs → tasks |
| [**Linear**](./integrations/linear.md) | Assigned issues with bi-directional status |
| [**Jira**](./integrations/jira.md) | JQL-filtered tickets |
| [**Notion**](./integrations/notion.md) | Database rows → tasks |
| [**Google Calendar**](./integrations/google-calendar.md) | Upcoming events → tasks |
| [**Gmail**](./integrations/gmail.md) | Unread mail → tasks |
| [**HTTP proxy**](./integrations/http-proxy.md) | SSRF-safe request path for all MCP calls |
| [**OpenUsage**](./integrations/openusage.md) | Real LLM cost tracking |

## Persistence & recovery

| Page | Summary |
|---|---|
| [**Workspace**](./persistence/workspace.md) | 3-layer auto-save (localStorage / disk / beforeunload) |
| [**Snapshots**](./persistence/snapshots.md) | Named + auto 5-min backups |
| [**Session recording**](./persistence/session-recording.md) | Replayable PTY capture |
| [**Time travel**](./persistence/time-travel.md) | Restore any snapshot |
| [**Import / export**](./persistence/import-export.md) | Share workspaces as JSON |

## UX & productivity

| Page | Summary |
|---|---|
| [**Command palette**](./ux/command-palette.md) | Ctrl/⌘+K action launcher |
| [**Templates**](./ux/templates.md) | Pre-configured tiles, pinnable to the dock |
| [**Command history**](./ux/command-history.md) | Per-terminal recall |
| [**Session timeline**](./ux/session-timeline.md) | Audit log of everything that happened |
| [**Theme system**](./ux/theme-system.md) | 6 themes, light-theme surface inversion |
| [**Detach + clone**](./ux/detach-clone.md) | Tile to new window, duplicate tile |

## Platform & engine

| Page | Summary |
|---|---|
| [**PTY management**](./platform/pty-management.md) | Backpressure channel, 64 PTY cap, retry |
| [**Filesystem access**](./platform/filesystem-access.md) | Broad-scope IPC for power-user FS use |
| [**Bundle chunking**](./platform/bundle-chunking.md) | How xterm / motion / fuse are split |
| [**Window chrome**](./platform/window-chrome.md) | Platform-aware title bar + controls |
| [**Security**](./platform/security.md) | CSP, SSRF, shell allowlist, path scoping |
| [**Keychain secrets**](./platform/keychain-secrets.md) | MCP tokens in OS keychain, not localStorage |

---

## Doc conventions

Every feature page follows the same shape:

1. **What it is** — a 2-3 sentence description
2. **How to use** — concrete user steps
3. **Use cases** — the workflows this enables
4. **Tech notes** — for devs extending or debugging
5. **Key files** — exact paths in this repo
6. **Related** — cross-links

If a page is missing details you wanted, file an issue — the docs track the code, not the reverse.
