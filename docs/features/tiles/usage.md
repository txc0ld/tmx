# Usage Tile

> Agent session tracker with token + cost estimates.

## What it is

A dashboard for your agent activity. Shows active + recently-completed agent sessions, estimated token counts, and optional real-time OpenAI costs via [OpenUsage](../integrations/openusage.md).

## How to use

- Add a Usage tile (or use the built-in Usage template).
- Running agents show as active rows with elapsed time.
- Completed agents roll into a recent-history section.
- If OpenUsage is configured, an extra panel shows real API cost per provider.
- Reset the local tracker via the tile's context menu.

## Use cases

**Budget awareness.** Watch token spend in near-real-time during heavy agent use.

**Session audit.** Recall which agents ran and how long after a debugging session.

**Team reporting.** Screenshot the tile for a "this is what the agents actually did today" summary.

## Tech notes

- Internal tracking lives in `usageStore`, auto-subscribed to `canvasStore` changes — any agent tile spawning or completing updates the store without the Usage tile being open.
- Token / cost numbers are **estimates** based on output byte count + model pricing maps. Real costs (if you care) come from OpenUsage.
- OpenUsage requests route through the Rust HTTP proxy (`httpFetch`) so SSRF guards apply and the WebView's CSP doesn't block the request.
- If `openUsageError` is set, the optional panel hides with a short reason.

**Key files:** `src/components/tiles/UsageTile.tsx`, `src/stores/usageStore.ts`.

## Related

- [OpenUsage integration](../integrations/openusage.md) · [Agent tile](./agent.md) · [Agent spawn](../agents/agent-spawn.md)
