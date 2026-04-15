# Google Calendar Integration

> Upcoming events → tasks.

## What it is

Pulls the next 7 days of events from a Google Calendar, surfaces each as a task row with event title + start time. Past events auto-mark done on next sync.

## Setup

1. [Create an API key](https://console.cloud.google.com/apis/credentials) with the Google Calendar API enabled.
2. For private calendars: set up OAuth and share the calendar with the authenticated service account.
3. Command Palette → "Add MCP Connection" → Google Calendar → paste API key + calendar id (`primary` or a specific calendar id).

## Power moves

- **Today's focus.** Only today's events show as unchecked; yesterday's auto-mark done.
- **Meeting prep via agents.** Wire Calendar → Todo → Claude; each meeting becomes a prep prompt 15 min before.
- **Multi-calendar.** Add multiple Calendar connections — one for work, one for personal — both surface in the same Todo inbox.

## Tech notes

- Uses the Calendar v3 API's `events.list` endpoint.
- Query window: `timeMin=now` to `timeMax=now+7d`, `singleEvents=true`, `orderBy=startTime`.
- Auto-done logic: on each sync, check if `event.end.dateTime < now`; if so, set task.done locally (no write-back to Calendar).
- OAuth path supported via `@tauri-apps/plugin-shell` open + PKCE flow — API-key path is simpler.

**Key files:** `src/stores/mcpStore.ts` (fetchGoogleCalendarTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md)
