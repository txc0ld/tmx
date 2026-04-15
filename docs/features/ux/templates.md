# Templates

> Pre-configured tile instances, pinnable to the dock.

## What it is

Save a tile's exact configuration as a template (category, config, optional description). Spawning from a template creates a new tile with that config — perfect for "my Claude Opus setup" or "npm test runner" without rebuilding every time.

## How to use

- Right-click a tile → "Save as template" → name + optional description.
- Command Palette → "Apply Template" → pick one → tile spawns with that config.
- In the "+ Add Tile" menu, pin a template (★ icon) to add it to the tile dock as a one-click launcher.
- Templates are stored in `localStorage` — survive restart, don't sync across devices.

## Power moves

- **Codex in the dock.** Save your favorite Codex config as a template, pin it to the dock → clicking "Codex" in the dock spawns *that*, not a default-config Agent.
- **Multi-model template set.** Three pinned Claude templates (Opus, Sonnet, Haiku) give you a one-click model picker right in the dock.
- **Runner template library.** `npm test`, `cargo build`, `pytest` — one template each, pinned.
- **Share templates.** Copy `localStorage['tx-templates']` from one machine to another, or commit to git as a dotfile.
- **Built-in + user.** 16 built-in templates ship — combined with your user ones in one list.

## Tech notes

- Stored in `templateStore` with persistence to `localStorage['tx-templates']`.
- Template shape: `{ id, name, category: TileType, description, config: Record<string, unknown>, isBuiltin: boolean }`.
- When a template is pinned to the dock, the dock entry uses the discriminated form `{ kind: 'template', templateId }` — so the template can evolve and the dock picks up the changes.
- Broadcast via `window` event `tx-dock-updated` so the "+ Add Tile" menu's ★/☆ state stays in sync with dock pin state.

**Key files:** `src/stores/templateStore.ts`, `src/components/canvas/TileDock.tsx` (spawnTileFromEntry, pin-template menu).

## Related

- [Tile dock](../canvas/tile-dock.md) · [Command palette](./command-palette.md)
