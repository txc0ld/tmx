# Minimap

> Bird's-eye overview of your canvas.

## What it is

A small floating panel (bottom-right by default) showing all tiles scaled down with a highlighted viewport rectangle. Click to jump the main canvas to that spot.

## How to use

- Visible by default. Toggle via Command Palette → "Toggle Minimap".
- Click anywhere in the minimap to center the canvas on that position.
- Drag the viewport rectangle to pan smoothly.
- Tile colors match their type (filled dot indicator).

## Power moves

- **Find lost tiles.** After a zoom-out or rubber-band delete, use the minimap to spot where tiles are clustered.
- **Multi-zone canvases.** For canvases with multiple clusters of tiles (frontend region, backend region), the minimap makes navigation a click instead of a pan.
- **Screenshot cue.** Before screenshotting, check the minimap to confirm nothing's off-canvas.

## Tech notes

- Rendered with absolute positions scaled to a fixed minimap size. Tile coords divided by a scale factor derived from canvas bounds.
- Viewport rect computed as `(-transform.x / scale, -transform.y / scale, vpW / scale, vpH / scale)` — canvas coords of the visible window.
- Clicking converts minimap coords → canvas coords → sets `transform.x/y` to center the click point.
- Auto-hides when there are zero tiles.

**Key files:** `src/components/canvas/Minimap.tsx`.

## Related

- [Infinite canvas](./infinite-canvas.md) · [Bookmarks](./bookmarks.md)
