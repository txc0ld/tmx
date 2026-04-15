# Canvas Bookmarks

> Save and jump to canvas positions.

## What it is

Named pan/zoom positions. Useful for big canvases — save a bookmark at your "testing corner", another at "deploy pipeline", jump between with hotkeys.

## How to use

- Command Palette → "Add Bookmark" → enter a name. Saves current pan + zoom.
- Command Palette → "Jump to Bookmark" → list picker. Pan/zoom animates to the saved position.
- Delete via Command Palette → "Remove Bookmark".
- Number keys `1–9` can be assigned as shortcuts.

## Power moves

- **Architecture tour.** Bookmark each major region of a sprawling canvas — `frontend`, `backend`, `infra`, `monitoring`. Jump to explain during demos.
- **Position before you zoom in.** Bookmark the overview before diving deep into one tile; one click back when you're done.
- **Per-workspace bookmarks.** Bookmarks are scoped per project (not per workspace) — cross-workspace jumps work too.

## Tech notes

- Stored in `canvasStore.bookmarks: Record<projectId, CanvasBookmark[]>`. Each: `{ name, transform: { x, y, scale } }`.
- Jump invokes `canvasStore.setTransform` directly — no animation in v1 (instant). A future version could tween.
- Persisted with the workspace save format.

**Key files:** `src/stores/canvasStore.ts` (addBookmark, jumpToBookmark, removeBookmark).

## Related

- [Infinite canvas](./infinite-canvas.md) · [Command palette](../ux/command-palette.md)
