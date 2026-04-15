# Infinite Canvas

> The spatial playing field.

## What it is

A boundless 2D canvas that holds your tiles. Pan by dragging empty space, zoom with the scroll wheel, snap tiles to grid or to each other, and multi-select with a rubber-band rectangle.

## How to use

- **Pan:** Left-click drag on empty canvas, middle-click drag, or `Alt` + left-click drag.
- **Zoom:** `Ctrl/⌘ + scroll wheel` over the canvas. Zooms toward cursor position.
- **Zoom reset:** Command Palette → "Zoom to 100%".
- **Rubber-band select:** `Shift` + drag on empty canvas. Tiles intersecting the rectangle are selected.
- **Move selection:** Drag any selected tile; all selected tiles move with it (deltas snapped to grid).
- **Snap guides:** Pink alignment guides appear when you drag a tile near another's edge or center.

## Power moves

- **Two-finger canvas gestures (macOS).** Trackpad pinch-to-zoom works via the standard Ctrl+wheel simulation.
- **Deep zoom out for overview.** Zoom to ~0.3× for a bird's-eye view across workspaces.
- **Bookmarks as jumps.** `Ctrl+Shift+B` saves a canvas position; recall with Command Palette → "Jump to Bookmark". See [bookmarks](./bookmarks.md).
- **Sticky notes.** Double-click empty canvas to drop a sticky note (separate from Note tiles — sticky notes are canvas-level annotations, not tiles).
- **Workspace tabs.** One project can have many canvases via [workspace tabs](./workspace-tabs.md) — switch without cluttering.
- **Focus mode.** Command Palette → "Focus Mode" dims everything except the selected tiles. Useful for screen sharing or deep work.

## Tech notes

- Transform is `transform: translate(x, y) scale(s)` on the inner layer with `transform-origin: 0 0`. (We tried CSS `zoom` for crispness but xterm's fit addon reads `getBoundingClientRect` which zoom inflates — content gets scrambled.)
- Screen ↔ canvas coord conversion: `canvasX = (screenX - translateX) / scale`. Used by every drop/drag/pointer handler.
- Pan and wheel handlers live in `useCanvas`. Wheel zooms toward cursor: computed as `newTranslate = cursor - (cursor - oldTranslate) * scaleRatio`.
- Rubber-band selection is a single SVG rectangle rendered inside `InfiniteCanvas`. Tiles test via axis-aligned bounding-box intersect.
- Auto-save is Zustand-subscribe-based (not `useEffect` deps) — only reschedules on real state changes, not every re-render.

**Key files:** `src/components/canvas/InfiniteCanvas.tsx`, `src/hooks/useCanvas.ts`, `src/utils/layout.ts` (snapToGrid, snapToTiles).

## Related

- [Workspace tabs](./workspace-tabs.md) · [Bookmarks](./bookmarks.md) · [Minimap](./minimap.md) · [Tile dock](./tile-dock.md) · [Layout slots](./layouts.md)
