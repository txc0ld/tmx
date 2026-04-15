# Todo Tile

> Task list with built-in MCP inbox.

## What it is

Two lists in one tile: manual items you add yourself, plus an auto-synced inbox of tasks pulled from Slack, GitHub, Linear, Jira, Notion, Calendar, and Gmail. Optionally dispatches new tasks to a wired agent.

## How to use

- Click `+` to add manual items. Check them off when done.
- MCP inbox shows in a separate "FROM INTEGRATIONS" panel — one row per unseen task.
- Dismiss an MCP task (`×`) to permanently hide it; the task is recorded as seen.
- Flip **Auto** to wire this Todo to an Agent. Every new MCP task + every new manual item is chunk-written to the agent's PTY with `\r` at the end.

## Use cases

**Inbox zero with agents.** Wire a GitHub connection → Todo → Claude. Assigned PRs arrive as prompts the agent handles automatically via [task-assign](../wiring/task-assign.md).

**Dev standup.** Link Linear so today's issues show up in the tile before you even open Linear.

**Personal scratch list.** Use just the manual-items section when you don't need MCP.

## Tech notes

- MCP sync runs in parallel with concurrency cap 3 and per-connection exponential backoff (30s → 10 min). A dead connection never retries in lockstep with healthy ones.
- `seenTaskIds` is a persistent `Set` keyed by the task's upstream source id — dismissals survive app restarts so a Linear issue you already triaged doesn't come back.
- Auto-dispatch writes the task text in 128-byte chunks with a 50 ms inter-chunk delay. Without the chunking, large task descriptions drop bytes on Windows PTY pipes.
- Task items stored at `tile.items: TodoItem[]`. Each: `{ id, text, done, assignedAgent? }`.

**Key files:** `src/components/tiles/TodoTile.tsx`, `src/stores/mcpStore.ts`.

## Related

- [task-assign wire](../wiring/task-assign.md) · [MCP overview](../integrations/overview.md) · [Slack](../integrations/slack.md) · [GitHub](../integrations/github.md) · [Linear](../integrations/linear.md) · [Jira](../integrations/jira.md) · [Notion](../integrations/notion.md)
