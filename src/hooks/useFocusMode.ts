import { useCanvasStore } from '@/stores/canvasStore';

export function useFocusMode() {
  const isActive = useCanvasStore(s => s.focusModeActive);
  const focusedTileIds = useCanvasStore(s => s.focusModeTiles);
  const focusedTile = useCanvasStore(s => s.focusedTile);

  const enter = (tileIds: string[]) => useCanvasStore.getState().enterFocusMode(tileIds);
  const exit = () => useCanvasStore.getState().exitFocusMode();

  const toggle = () => {
    if (isActive) {
      exit();
    } else if (focusedTile) {
      enter([focusedTile]);
    }
  };

  return { isActive, focusedTileIds, enter, exit, toggle };
}
