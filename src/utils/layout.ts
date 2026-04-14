import type { CanvasTransform, Tile } from '@/types';

export function snapToGrid(v: number, g: number = 8): number {
  return Math.round(v / g) * g;
}

export function screenToCanvas(
  screenX: number,
  screenY: number,
  transform: CanvasTransform,
): { x: number; y: number } {
  return {
    x: (screenX - transform.x) / transform.scale,
    y: (screenY - transform.y) / transform.scale,
  };
}

// ─── Tile-to-tile snapping ───────────────────────────────
export interface SnapGuide {
  axis: 'x' | 'y';
  pos: number; // canvas coordinate of the guide line
}

const SNAP_THRESHOLD = 8;

/**
 * Given a tile being dragged (with proposed x, y, w, h) and all other tiles,
 * returns the snapped position and any active guide lines.
 */
export function snapToTiles(
  x: number, y: number, w: number, h: number,
  others: Tile[], excludeId: string,
): { x: number; y: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let snappedX = x;
  let snappedY = y;
  let bestDx = SNAP_THRESHOLD + 1;
  let bestDy = SNAP_THRESHOLD + 1;

  const myEdges = { left: x, right: x + w, cx: x + w / 2, top: y, bottom: y + h, cy: y + h / 2 };

  for (const t of others) {
    if (t.id === excludeId) continue;
    const oEdges = { left: t.x, right: t.x + t.w, cx: t.x + t.w / 2, top: t.y, bottom: t.y + t.h, cy: t.y + t.h / 2 };

    // X-axis snaps: my left→their left, my left→their right, my right→their left, my right→their right, center→center
    const xPairs: [number, number, number][] = [
      [myEdges.left, oEdges.left, 0],    // snap my left to their left → offset 0
      [myEdges.left, oEdges.right, 0],   // snap my left to their right
      [myEdges.right, oEdges.left, w],   // snap my right to their left → my x = oEdges.left - w
      [myEdges.right, oEdges.right, w],  // snap my right to their right
      [myEdges.cx, oEdges.cx, w / 2],    // center alignment
    ];
    for (const [my, their, offset] of xPairs) {
      const d = Math.abs(my - their);
      if (d < bestDx) {
        bestDx = d;
        snappedX = their - offset;
        // We'll rebuild guides after finding best snap
      }
    }

    // Y-axis snaps
    const yPairs: [number, number, number][] = [
      [myEdges.top, oEdges.top, 0],
      [myEdges.top, oEdges.bottom, 0],
      [myEdges.bottom, oEdges.top, h],
      [myEdges.bottom, oEdges.bottom, h],
      [myEdges.cy, oEdges.cy, h / 2],
    ];
    for (const [my, their, offset] of yPairs) {
      const d = Math.abs(my - their);
      if (d < bestDy) {
        bestDy = d;
        snappedY = their - offset;
      }
    }
  }

  // If we didn't snap close enough, revert to original
  if (bestDx > SNAP_THRESHOLD) snappedX = x;
  if (bestDy > SNAP_THRESHOLD) snappedY = y;

  // Build guide lines for active snaps
  if (bestDx <= SNAP_THRESHOLD) {
    // Find all edges that align at snappedX or snappedX+w
    for (const t of others) {
      if (t.id === excludeId) continue;
      for (const edge of [t.x, t.x + t.w, t.x + t.w / 2]) {
        if (Math.abs(snappedX - edge) < 1 || Math.abs(snappedX + w - edge) < 1 || Math.abs(snappedX + w / 2 - edge) < 1) {
          guides.push({ axis: 'x', pos: edge });
        }
      }
    }
  }
  if (bestDy <= SNAP_THRESHOLD) {
    for (const t of others) {
      if (t.id === excludeId) continue;
      for (const edge of [t.y, t.y + t.h, t.y + t.h / 2]) {
        if (Math.abs(snappedY - edge) < 1 || Math.abs(snappedY + h - edge) < 1 || Math.abs(snappedY + h / 2 - edge) < 1) {
          guides.push({ axis: 'y', pos: edge });
        }
      }
    }
  }

  return { x: snappedX, y: snappedY, guides };
}
