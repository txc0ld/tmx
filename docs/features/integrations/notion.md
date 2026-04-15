# Notion Integration

> Notion database rows → tasks.

## What it is

Queries a single Notion database and maps rows to tasks. Best when your database has clear "task-like" columns (title, status, priority).

## Setup

1. Create a Notion internal integration: [notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Share the target database with your integration (in the database's share menu → Connections).
3. Grab the **Database ID** from the URL: `notion.so/<workspace>/<DATABASE_ID>?v=...`.
4. Command Palette → "Add MCP Connection" → Notion → paste token (`secret_...`) + database id.

## Power moves

- **Task pipeline.** Use Notion's database as a shared task pool. Multiple teammates + your TerminalX canvas see the same rows.
- **Status filter.** Ensure your database has a "Status" select field — the integration prefers rows not in "Done" / "Archived".
- **Page as prompt.** The integration currently surfaces title + a URL to the Notion page. Opening the URL is one click from the Todo row.

## Tech notes

- URL builder: `buildNotionQueryUrl(databaseId)` → `https://api.notion.com/v1/databases/${encoded}/query`. Database ID validated `^[A-Za-z0-9-]{1,128}$`.
- Auth: `Authorization: Bearer ${token}`, `Notion-Version: 2022-06-28`.
- Request body: POST with optional JSON filter. v1 uses a sensible default; future versions may expose per-connection filter config.
- Task text = database row title; `url` = Notion page URL.

**Key files:** `src/stores/mcpStore.ts` (buildNotionQueryUrl, fetchNotionTasks).

## Related

- [MCP overview](./overview.md) · [Todo tile](../tiles/todo.md)
