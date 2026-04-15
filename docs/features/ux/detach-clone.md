# Detach + Clone

> Send a tile to its own OS window, or duplicate it on the canvas.

## What it is

Two title-bar buttons on every tile:

- **Detach (↗)** — Moves the tile into a new OS window. Useful for multi-monitor setups — drag the window to your secondary display.
- **Clone (⎘)** — Creates a duplicate tile on the canvas 40 px down-right with `(copy)` in the title. Fresh runtime state (new PTY, fresh memory, etc.).

## How to use

- Hover a tile → title-bar chrome buttons appear.
- Click the up-right-arrow (↗) to detach.
- Click the copy (⎘) to clone.
- Close the detached window to re-dock the tile to the canvas.

## Power moves

- **Multi-monitor.** Detach a terminal to a second display, keep your canvas clean on the main monitor.
- **Duplicate agent config.** Clone an Agent tile to spawn another one with the same memory / model / effort — no gear-icon ceremony.
- **Temporary focus.** Detach a tile when you need it big, re-dock when done.
- **Testing templates.** Clone a tile, tweak it, save the tweaked one as a template — original intact.

## Tech notes

- **Detach** opens a new Tauri webview window via `@tauri-apps/api/webview`. The detached tile renders in that window; state is shared via the same Zustand stores (singleton per process).
- **Clone** spits out a new tile via `canvasStore.addTile` with a new UUID. `ptyId` is stripped — cloned Terminal / Agent tiles spawn their own fresh PTY.
- Cloned tile position: `{ x: original.x + 40, y: original.y + 40 }` so it's visibly offset.
- A cloned Agent doesn't copy `agentMemoryStore` content (memory is per-project, not per-tile) — but does copy the agent config (model, effort, custom command).

**Key files:** `src/components/tiles/TileShell.tsx` (handleClone, detachTile button), `src/utils/detachTile.ts`.

## Related

- [Tile dock](../canvas/tile-dock.md) · [Templates](./templates.md)
