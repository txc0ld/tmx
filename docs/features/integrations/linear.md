# Linear Integration

> Assigned Linear issues, optionally bi-directional for status updates.

## What it is

Pulls issues assigned to the authenticated user. Optionally scope to a specific team. Marking tasks done in the Todo tile can write back to Linear.

## Setup

1. [Create a Linear API key](https://linear.app/settings/api) (personal or OAuth, personal is simpler).
2. Command Palette → "Add MCP Connection" → Linear → paste `lin_api_...`.
3. Optional: enter **Team ID** to filter.

## Power moves

- **Inbox-zero Linear.** Todo shows all assigned issues; wire to Claude for auto-triage. Flip done to clear from Linear in one move.
- **Priority-aware dispatch.** Linear priority badges show in the task row — glance before dispatching to an agent.
- **Cycle review.** Pull the active cycle's work; quickly see what you have left.

## Tech notes

- Uses Linear GraphQL API at `https://api.linear.app/graphql`. Query fetches assigned issues in active cycles.
- Auth header: `Authorization: ${apiKey}` (no `Bearer` prefix — Linear's quirk).
- Bi-directional: toggling a task's `done` flag calls a mutation updating the issue's status to the team's "Done" state. Failure silently retries on next sync.
- Task source id: `Linear:${issue.id}` — stable across team moves.

**Key files:** `src/stores/mcpStore.ts` (fetchLinearTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md)
