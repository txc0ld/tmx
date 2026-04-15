# Wire: refresh-trigger

> Agent done → Browser reload signal.

## What it does

Fires when an Agent transitions to `done`. Emits a toast notification that "Agent completed — browser tile would refresh". The wire is a signal; it doesn't actually poke the iframe (iframes are their own browsing context and can't be force-reloaded from outside without user action).

## How to wire

- Drag from an Agent's right-edge port to a Browser tile's left-edge port.
- Let the agent run to completion.
- Toast appears when the wire fires. Click the browser's **Refresh** button (or rely on HMR if the dev server has it).

## Power moves

- **Dev-server feedback loop.** `Agent → Browser`. Agent modifies code → HMR reloads — the toast confirms the round trip worked.
- **Deployment cue.** Wire a long-running deploy agent to your staging Browser tile. When the deploy completes, you're nudged to refresh and smoke-test.
- **Combine with Runner.** `Runner → Agent → Browser`. Tests pass, agent ships, browser flag to refresh.

## Why not auto-refresh?

Iframes cannot be programmatically refreshed reliably across all content sources — cross-origin iframes ignore `iframe.contentWindow.location.reload()`. Most dev servers have HMR already; the toast is a nudge, not a force. A future version could detect same-origin localhost iframes and auto-reload those.

## Tech notes

- Wire handler calls `toastStore.addToast(...)` with info-level severity.
- Wire is active for 2 s after firing.
- Like all `done`-triggered wires, fires on status transition — the source agent doesn't need to exit.

**Key files:** `src/hooks/useWiringEngine.ts` (refresh-trigger handler).

## Related

- [Browser tile](../tiles/browser.md) · [Agent tile](../tiles/agent.md) · [Auto-complete](../agents/auto-complete.md)
