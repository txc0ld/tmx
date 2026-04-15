# Group Tile

> Collapse multiple tiles into a single tile.

## What it is

A container that holds other tile IDs. When collapsed, shows only a label + child count. When expanded, shows children inline.

## How to use

- Multi-select (Shift+drag) the tiles you want to group.
- Command Palette → "Group Tiles" → enter a label.
- The selected tiles become children of a Group tile.
- Toggle expand/collapse via the tile's title bar.
- Ungroup restores children to the canvas at their positions.

## Use cases

**Workspace tidiness.** Bundle "Auth service" (Terminal + Agent + Editor + Browser) under one group when you're focused elsewhere.

**Temporary clutter reduction.** Collapse a big debugging session before a demo.

**Visual organization.** Label groups by feature (`Payments`, `Onboarding`) to separate unrelated work on the same canvas.

## Tech notes

- Stored as `tile.childTileIds: string[]` — just references, not nested storage. Children remain top-level in `canvasStore.tiles[pid]`.
- `collapsed: boolean` on the Group toggles the inline children view.
- On ungroup, the Group tile is removed but children stay in place — their `x/y/w/h` is unchanged throughout.
- Workspace import validator enforces group integrity (dangling child IDs are removed).

**Key files:** `src/components/tiles/GroupTile.tsx`.

## Related

- [Infinite canvas](../canvas/infinite-canvas.md) · [Command palette](../ux/command-palette.md)
