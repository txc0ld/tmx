# Browser Tile

> Embedded iframe for dev servers and docs.

## What it is

A sandboxed `<iframe>` that lets you pin a URL on the canvas. Meant for localhost dev servers, internal docs, or staging environments — not general web browsing.

## How to use

- Add a Browser tile. Default URL points at `http://localhost:3000`.
- Type a URL and press Enter to navigate.
- Refresh button does a hard reload (clears iframe src then restores).
- If a URL fails to load, an error state shows in the center.

## Use cases

**Dev preview.** Point at your Vite / Next / Rails server. Wire a [refresh-trigger](../wiring/refresh-trigger.md) from an agent so the preview reloads once the agent commits a change.

**Docs at a glance.** Pin MDN, your internal API docs, or GitHub PR pages next to the code that needs them.

**Staging smoke test.** Keep the staging URL open while iterating on a fix.

## Tech notes

- URL parsed via `new URL()` before navigation. Only `http:` and `https:` schemes accepted — `javascript:`, `data:`, `file:` are rejected.
- Iframe sandbox is `allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox` — broad but typical for dev servers. Tauri's CSP has `frame-src https: http://localhost:*`.
- Iframes don't automatically refresh in response to outer canvas transforms or zoom — they're DOM elements but the iframe's content is its own browsing context.
- Currently lazy-loaded (not in the initial bundle) — only pulled when first Browser tile mounts.

**Key files:** `src/components/tiles/BrowserTile.tsx`, `src-tauri/tauri.conf.json` (CSP).

## Related

- [refresh-trigger wire](../wiring/refresh-trigger.md) · [Security posture](../platform/security.md)
