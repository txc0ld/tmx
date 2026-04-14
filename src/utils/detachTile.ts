import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useCanvasStore } from '@/stores/canvasStore';
import type { Tile } from '@/types';

const detachedWindows = new Map<string, WebviewWindow>();

/**
 * Detach a tile into its own OS window.
 * The tile is removed from the canvas and rendered in a new Tauri window.
 * When the window is closed, the tile returns to the canvas.
 */
export async function detachTile(tileId: string): Promise<void> {
  const store = useCanvasStore.getState();
  const pid = store.activeProject;
  const tiles = store.tiles[pid] || [];
  const tile = tiles.find(t => t.id === tileId);
  if (!tile) return;

  // Don't detach if already detached
  if (detachedWindows.has(tileId)) {
    const existing = detachedWindows.get(tileId)!;
    await existing.setFocus();
    return;
  }

  const label = `detached-${tileId.slice(0, 8)}`;
  const title = `${tile.title || tile.type} — TerminalX`;

  try {
    const webview = new WebviewWindow(label, {
      title,
      width: tile.w,
      height: tile.h + 32, // account for title bar
      x: 100,
      y: 100,
      decorations: true,
      resizable: true,
      url: `index.html#/detached/${tileId}`,
    });

    detachedWindows.set(tileId, webview);

    // Store tile data for the detached window to read
    sessionStorage.setItem(`tx-detached-${tileId}`, JSON.stringify(tile));

    // Remove tile from canvas (it lives in the window now)
    store.removeTile(tileId);

    // When window closes, restore tile to canvas
    webview.onCloseRequested(async () => {
      const tileData = sessionStorage.getItem(`tx-detached-${tileId}`);
      if (tileData) {
        try {
          const restored: Tile = JSON.parse(tileData);
          useCanvasStore.getState().addTile(restored);
        } catch {
          // Tile data corrupted, skip restore
        }
        sessionStorage.removeItem(`tx-detached-${tileId}`);
      }
      detachedWindows.delete(tileId);
    });
  } catch (e) {
    console.error('Failed to detach tile:', e);
  }
}

export function isDetached(tileId: string): boolean {
  return detachedWindows.has(tileId);
}
