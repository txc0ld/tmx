# Tile Dock

> Quick-launch shelf at the bottom of the canvas.

## What it is

The persistent row of "new tile" buttons pinned to the bottom. Fully customizable per-device — reorder, hide, and pin templates so frequently-used configurations (e.g. "Codex agent") are one click away.

## How to use

- Click a dock button to spawn a tile.
- Click the ⚙ (gear) to open the customize panel.
- In the panel: drag items to reorder (or use up/down arrows), click ✕ to hide, `+ Add Tile` to browse available items.
- Pin templates from the "+ Add Tile" menu — pinned templates spawn with their full config, not a generic default.
- Spawn positions use a **column-major grid**: first tile at `(24, 24)` screen coords, 3 tall per column, 700×500 pitch with 8 px gap.

## Power moves

- **Pin your favorite agent config.** Create a Claude template with your preferred model/effort/memory, pin it — the dock button spawns exactly that, not a default-config Agent.
- **Hide tiles you don't use.** Hide SSH or Docker if you never touch them. The `+ Add Tile` menu remains for one-offs.
- **Per-device.** Dock layout is stored in `localStorage` — each machine has its own layout. Good for work-vs-home setups.
- **Spawn predictability.** The column-major grid means if you click Terminal three times quickly, they stack vertically instead of overlapping.

## Tech notes

- Stored in `localStorage['tx-dock-items']` as a `DockEntry[]` discriminated union:
  ```ts
  type DockEntry =
    | { kind: 'type'; type: TileType }
    | { kind: 'template'; templateId: string }
  ```
- Legacy `string[]` storage auto-migrates.
- Drag-to-reorder uses HTML5 native DnD with a ref-mirrored drag index to work around React state being async (would otherwise drop the first event).
- Changes broadcast via `window` event `tx-dock-updated` so the "+ Add Tile" menu's ★/☆ state stays in sync when you pin/unpin templates.
- `spawnTileFromEntry` reads the entry and either applies `buildTileDefaults(type)` or resolves the pinned template from `templateStore`.

**Key files:** `src/components/canvas/TileDock.tsx`, `src/stores/templateStore.ts`.

## Related

- [Templates](../ux/templates.md) · [Infinite canvas](./infinite-canvas.md)
