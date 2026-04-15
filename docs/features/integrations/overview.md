# MCP Integrations — Overview

> External services as task sources for the canvas.

## What it is

TerminalX ships with connectors for 8 external services that appear as "task inboxes" in the [Todo tile](../tiles/todo.md). Configure a connection once per project; the app polls it every 5 minutes and surfaces new tasks in the UI.

## Supported services

| Service | Tasks pulled | Docs |
|---|---|---|
| Slack | Channel messages | [slack.md](./slack.md) |
| GitHub | Assigned issues + PRs | [github.md](./github.md) |
| Linear | Assigned issues (bi-directional) | [linear.md](./linear.md) |
| Jira | JQL-filtered tickets | [jira.md](./jira.md) |
| Notion | Database rows | [notion.md](./notion.md) |
| Google Calendar | Upcoming events | [google-calendar.md](./google-calendar.md) |
| Gmail | Unread emails | [gmail.md](./gmail.md) |
| OpenUsage | LLM usage / cost | [openusage.md](./openusage.md) |

## How integrations work end-to-end

1. **Add a connection.** Command Palette → "Add MCP Connection" → pick service → enter token + any config (channel id, repo, etc.).
2. **Store per project.** Connections are scoped per project id (`localStorage['tx-mcp-${projectId}']`).
3. **Auto-sync.** `useMcpStore.syncAll()` runs on app start, then every 5 min. Connections sync **in parallel** with concurrency cap 3 and per-connection exponential backoff (30 s → 10 min on failure).
4. **Requests go through the HTTP proxy.** The Rust-side `http_fetch` handles the actual network call — see [http-proxy.md](./http-proxy.md). MCP APIs are reached outbound, validated against SSRF rules.
5. **Tasks land in Todo.** Visible in the "FROM INTEGRATIONS" panel of any Todo tile in the active project.
6. **Optional auto-dispatch.** If a Todo is wired to an Agent with Auto on, new tasks are chunk-written to the agent's PTY as prompts. See [task-assign](../wiring/task-assign.md).

## Power moves

- **GitHub + Slack + Linear in one inbox.** Three connections → Todo tile shows all assigned work across tools in one panel.
- **Calendar as "next up" cue.** Google Calendar events flow in as tasks with start time; glance at the Todo tile to see what's next.
- **Selective dispatch.** Leave Auto off, pick which tasks go to which agent manually. Still beats copying text between Slack and a terminal.
- **Multi-project isolation.** Connections are per-project. Personal vs work tokens stay separate.

## Tech notes

- `useMcpStore` holds connections + task cache + backoff state. Per-connection: `{ id, name, type, status, config, lastSync?, error? }`.
- URLs for each integration are **validated and encoded** via dedicated builders (`buildGitHubIssuesUrl`, `buildSlackHistoryUrl`, etc.) to prevent path/query injection from misconfigured tokens. Tests live in `src/test/mcpStore.test.ts`.
- The module-scope subscription to `projectStore` that handles project-switch reloads is installed once via `initMcpProjectSync()` from App mount — not at module import time (prevents HMR leaks).
- Tasks use stable source ids (`Linear:PROJ-123`, `GitHub:owner/repo#issue`, etc.) so `seenTaskIds` survives across sessions without duplicates.

**Key files:** `src/stores/mcpStore.ts`, `src-tauri/src/commands/http_proxy.rs`, `src/test/mcpStore.test.ts`.

## Related

- [Todo tile](../tiles/todo.md) · [task-assign wire](../wiring/task-assign.md) · [HTTP proxy](./http-proxy.md)
