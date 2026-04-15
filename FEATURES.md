# Feature Tour

> Infinite canvas workspace for orchestrating CLI agents, terminals, and tools in parallel. Built with Tauri 2 + React 19 + Rust.

This is the product-level tour. For deep per-feature docs, see [**docs/features/**](./docs/features/README.md). For the wiring tutorial, see [**WIRING.md**](./WIRING.md).

---

## The pitch

Run Claude, Codex, and Gemini side-by-side on an infinite canvas. Wire them together. Pull tasks from Slack, GitHub, Linear, Jira. Watch agents, terminals, editors, and git panels coexist without tab-switching.

TerminalX is Figma meets terminal meets AI — for developers who'd rather see everything at once than cycle through windows.

---

## Core capabilities

### 🎨 Infinite canvas

Pan, zoom, snap-to-grid, rubber-band select. 15 tile types. Multi-project, multi-workspace, 5 layout slots per project, bookmarks, minimap, customizable dock, sticky notes.

→ [Canvas docs](./docs/features/README.md#canvas--workspace)

### 🤖 Agent orchestration

Spawn Claude Code / Codex / Gemini as tiles. Auto-complete via DONE sentinel or idle detection — chain completes without waiting for process exit. Per-project agent memory injects architecture context into every new spawn.

→ [Agent docs](./docs/features/README.md#agent-orchestration)

### 🔗 Wiring system

Drag from any tile's right port to another's left port. 6 wire types, auto-inferred:

- **context-pipe** — Terminal → Agent: pipe tail of output as agent context
- **agent-chain** — Agent → Agent: output chains hands-free
- **task-assign** — Todo → Agent: new tasks dispatch automatically
- **file-open** — File Tree → Editor/Diff: click-route files to the right place
- **refresh-trigger** — Agent → Browser: cue reload on complete
- **diff-feed** — Agent → Diff: populate diff on complete

→ [Wiring docs](./docs/features/README.md#wiring-system)

### 💬 MCP integrations

Out-of-the-box connectors for external services. Tasks land in the Todo tile's inbox, optionally auto-dispatched to a wired agent.

| Service | What lands |
|---|---|
| Slack | Channel messages |
| GitHub | Assigned issues + PRs |
| Linear | Assigned issues (bi-directional) |
| Jira | JQL-filtered tickets |
| Notion | Database rows |
| Google Calendar | Upcoming events |
| Gmail | Unread messages |
| OpenUsage | LLM cost + usage |

→ [Integration docs](./docs/features/README.md#external-integrations-mcp)

### ⚙️ Native performance

- 47 MB idle, 64 concurrent PTYs hard-capped.
- xterm.js WebGL renderer with bounded-channel backpressure.
- Per-tile lazy chunks (Monaco, xterm, framer-motion, fuse split out).
- Main bundle 413 KB / 120 KB gzipped.
- Connection-pooled HTTP proxy (60 s TTL, DNS-pinned).

→ [Platform docs](./docs/features/README.md#platform--engine)

### 🛡️ Hardened

- Shell allowlist on public PTY spawn, internal bypass for agents.
- Path validator (`is_path_allowed`) spans home + drives + mount roots, rejects `/proc`/`/sys`/`/dev`.
- HTTP proxy: SSRF guards, DNS pinning, redirect disable, URL-credentials reject.
- Workspace import: discriminated-union schema validation with per-tile schema.
- CSP without `unsafe-inline` script-src. No `dangerouslySetInnerHTML` / `eval` in app source.

→ [Security posture](./docs/features/platform/security.md) · [CONTRIBUTING.md → Security](./CONTRIBUTING.md#security-posture)

### 💾 Never loses work

- 3-layer auto-save: localStorage cache (500 ms) + disk file (2 s) + `beforeunload` flush.
- Auto-snapshots every 5 minutes for time-travel.
- Import / export workspaces as portable JSON.
- Session recording for full PTY-byte replay.

→ [Persistence docs](./docs/features/README.md#persistence--recovery)

---

## Power features

**🧠 Agent memory** — [docs](./docs/features/agents/agent-memory.md)
Paste your architecture notes once per project. Every new agent gets them automatically — codebase context from turn one.

**⚔️ Multi-agent debate**
Spawn Claude + Codex + Gemini with the same prompt, compare their answers. Drag three Agent tiles, one template each. Or chain them: Claude plans, Codex builds, Gemini reviews.

**🔄 Auto-recovery** — [task-assign](./docs/features/wiring/task-assign.md), [Runner tile](./docs/features/tiles/runner.md)
Wire a Runner to an Agent. On test failure, the last 30 lines of output auto-dispatch to the agent with "Fix this error:" as a prefix.

**⏰ Time travel** — [docs](./docs/features/persistence/time-travel.md)
Auto-snapshots every 5 min give ~1 hour of history. Restore any of them in two clicks.

**🎬 Session recording** — [docs](./docs/features/persistence/session-recording.md)
Start recording. Every PTY byte is captured with timestamps. Replay at variable speed, export to JSON, share with a teammate.

**📌 Output pinning** — [Terminal tile](./docs/features/tiles/terminal.md)
Pin a terminal's current output as a Note tile. Useful for before/after compares or leaving an error message visible while you fix it.

**🖼️ Image paste**
Paste a screenshot into a terminal (or agent) — TerminalX writes it to disk and pastes the path.

**🪟 Multi-monitor** — [docs](./docs/features/ux/detach-clone.md)
Detach any tile to its own OS window. Drag to a second display.

**🎯 Templates** — [docs](./docs/features/ux/templates.md)
Save a tile's exact config (model, effort, command, etc.) as a template. Pin to the dock — the dock button spawns that template, not a default-config tile.

**🔍 Search across everything** — `Ctrl/⌘+F`
Full-text search tile names, note content, command history, file paths. One input, zero tabs.

**🖱️ Command palette** — `Ctrl/⌘+K`
Fuzzy-search 25+ commands: add tile, switch project, save snapshot, run git, load template, set theme.

---

## Workflow examples

### Auto-fix test failures

```
┌─────────────┐         ┌─────────────┐
│  Runner     │ ──wire─▶│  Claude     │  (context-pipe)
│  npm test   │         │  auto-pipe  │
└─────────────┘         └─────────────┘
```

Failing test → Claude receives error → suggests fix → you accept or iterate.

### Inbox-to-agent

```
┌─────────────┐    ┌──────────┐     ┌─────────────┐
│  GitHub     │───▶│  Todo    │───▶│  Codex      │
│  MCP sync   │    │  Auto on │     │  auto-dispatch
└─────────────┘    └──────────┘     └─────────────┘
```

Assigned PR arrives in GitHub → task appears in Todo → dispatches to Codex → code drafted by the time you notice.

### Agent chain

```
Claude (plan) → Codex (implement) → Gemini (review) → Diff tile
```

Each agent's DONE sentinel fires the next. Open a Diff tile at the end to review the final changes.

### File-tree-driven review

```
┌───────────┐    ┌──────────┐
│ File Tree │───▶│ Editor   │
│ (wired)   │ │  └──────────┘
└───────────┘ │  ┌──────────┐
              └─▶│ Diff     │
                 │ git mode │
                 └──────────┘
```

Click a file → loads in Editor + shows git diff in Diff tile. No new tiles spawned per file.

---

## Share this

<details>
<summary><b>Social copy</b></summary>

**The hook:**
> TerminalX — run Claude, Codex, and Gemini side by side on an infinite canvas. Wire them together. Let them work in parallel. Ship 10× faster.

**Multi-agent:**
> What if 3 AI agents could work on your codebase at the same time?
> Claude refactors the backend. Codex writes tests. Gemini builds the frontend. All at once, visible at once.

**Automation:**
> I connected Slack to TerminalX. Now when someone drops a task in #dev, it auto-routes to a Claude agent. No human in the loop. Tasks in → code out.

**Multi-terminal:**
> Infinite canvas of terminals. Split panes. Dev server in one, logs in another, SSH to prod in a third. All visible, no tab-switching.

**Dev workflow:**
> My setup: Claude (plan) → Codex (implement) → Gemini (review) wired head-to-tail. Test failures auto-dispatch to a fixer agent. Slack tasks auto-prompt Claude. I do architecture; agents do the rest.

</details>

---

## Docs map

- [**README**](./README.md) — install + quick start
- [**docs/features/**](./docs/features/README.md) — per-feature deep docs (~55 pages)
- [**WIRING.md**](./WIRING.md) — drag-to-connect tutorial with screenshots
- [**CLAUDE.md**](./CLAUDE.md) — architecture + critical patterns (for AI agents + devs)
- [**DESIGN.md**](./DESIGN.md) — design-system source of truth
- [**CONTRIBUTING.md**](./CONTRIBUTING.md) — PR workflow + security posture
- [**CHANGELOG.md**](./CHANGELOG.md) — release notes

---

<div align="center">

Built by [Tay](https://github.com/txc0ld) at Fantom Labs · [GitHub](https://github.com/txc0ld/tmx)

</div>
