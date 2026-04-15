# Slack Integration

> Channel messages → tasks.

## What it is

Pulls messages from a Slack channel via Bot Token auth. Messages become rows in the Todo tile's "FROM INTEGRATIONS" panel.

## Setup

1. [Create a Slack app](https://api.slack.com/apps) with `channels:history`, `groups:history` scopes.
2. Install to workspace → copy the **Bot User OAuth Token** (`xoxb-...`).
3. Get the **Channel ID** (right-click channel → View channel details → bottom of panel).
4. Command Palette → "Add MCP Connection" → Slack → paste token + channel id → Save.

## Power moves

- **Dedicated dev channel.** Create a `#agent-tasks` channel; anything posted there becomes a task. Perfect for async handoff.
- **Auto-dispatch to Claude.** Todo auto-wire → prompts become Slack-driven. Teammate writes "fix the auth redirect bug" in Slack; Claude gets it 5 min later.
- **Filter at the Slack side.** Use a dedicated channel or a custom workflow to only post things you want surfaced — the integration pulls all messages from the channel.

## Tech notes

- URL builder: `buildSlackHistoryUrl(channel)` → `https://slack.com/api/conversations.history?channel=...&limit=20`. Validates channel matches `^[A-Za-z0-9][A-Za-z0-9_-]{1,255}$`.
- Auth header: `Authorization: Bearer ${token}`.
- Response filtered: only `messages[]` with non-empty text and a timestamp newer than `lastSync` become new tasks.
- Task text truncated to a sensible preview (first 200 chars); full message available in the task detail.
- Backoff applies — repeated 401 / 429 / 5xx responses back off up to 10 min between retries.

**Key files:** `src/stores/mcpStore.ts` (buildSlackHistoryUrl, fetchSlackTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md) · [task-assign wire](../wiring/task-assign.md)
