import { useCanvasStore } from '@/stores/canvasStore';

/**
 * Subscribe to the active project's zoom factor as a primitive.
 *
 * Returns a stable number (Object.is equality) so consumers only re-render
 * when the zoom actually changes — not on every pan, tile edit, or
 * unrelated transform update.
 *
 * Content-heavy tiles (TerminalTile / AgentTile / RunnerTile / EditorTile /
 * DiffTile) use this to counter the outer canvas zoom with an internal
 * `zoom: 1 / canvasZoom` wrapper and bump their font/dimension sizes by
 * `canvasZoom`. The combination keeps the tile visually the same size at
 * any outer zoom, while rendering its content at the true zoomed resolution
 * (xterm WebGL / Monaco canvas stays crisp instead of stretching the
 * raster).
 *
 * The 0.1..3 clamp matches useCanvas.ts wheel bounds; we clamp here too
 * as defense against any stored workspace having an out-of-range scale
 * that slipped past validateTransform.
 */
export function useCanvasZoom(): number {
  return useCanvasStore(s => {
    const scale = s.transforms[s.activeProject]?.scale ?? 1;
    if (!Number.isFinite(scale)) return 1;
    if (scale < 0.1) return 0.1;
    if (scale > 3) return 3;
    return scale;
  });
}
