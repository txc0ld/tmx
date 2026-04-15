import { create } from 'zustand';
import { useCanvasStore } from './canvasStore';
import type { Wire, WireType, Tile } from '@/types';

interface WiringState {
  // Drag state
  dragging: boolean;
  fromTileId: string | null;
  cursorX: number;
  cursorY: number;

  start: (fromTileId: string, clientX: number, clientY: number) => void;
  moveCursor: (clientX: number, clientY: number) => void;
  finish: (toTileId: string | null) => void;
  cancel: () => void;
}

// Auto-detect the wire type based on source → target tile types
function inferWireType(from: Tile, to: Tile): WireType {
  if (from.type === 'agent' && to.type === 'agent') return 'agent-chain';
  if (from.type === 'agent' && to.type === 'browser') return 'refresh-trigger';
  if (from.type === 'agent' && to.type === 'todo') return 'task-assign';
  if (from.type === 'agent' && to.type === 'diff') return 'diff-feed';
  return 'context-pipe'; // default: terminal → agent, etc.
}

export const useWiringStore = create<WiringState>((set, get) => ({
  dragging: false,
  fromTileId: null,
  cursorX: 0,
  cursorY: 0,

  start: (fromTileId, clientX, clientY) => {
    set({ dragging: true, fromTileId, cursorX: clientX, cursorY: clientY });
  },

  moveCursor: (clientX, clientY) => {
    if (!get().dragging) return;
    set({ cursorX: clientX, cursorY: clientY });
  },

  finish: (toTileId) => {
    const { dragging, fromTileId } = get();
    if (!dragging || !fromTileId) { set({ dragging: false, fromTileId: null }); return; }
    if (!toTileId || toTileId === fromTileId) {
      set({ dragging: false, fromTileId: null });
      return;
    }
    const canvas = useCanvasStore.getState();
    const pid = canvas.activeProject;
    const tiles = canvas.tiles[pid] || [];
    const from = tiles.find(t => t.id === fromTileId);
    const to = tiles.find(t => t.id === toTileId);
    if (!from || !to) { set({ dragging: false, fromTileId: null }); return; }

    // Prevent duplicates
    const wires = canvas.wires[pid] || [];
    const exists = wires.some(w => w.fromTile === fromTileId && w.toTile === toTileId);
    if (!exists) {
      const wire: Wire = {
        id: crypto.randomUUID(),
        fromTile: fromTileId,
        fromPort: 'output',
        toTile: toTileId,
        toPort: 'input',
        wireType: inferWireType(from, to),
        active: false,
      };
      canvas.addWire(wire);
    }
    set({ dragging: false, fromTileId: null });
  },

  cancel: () => set({ dragging: false, fromTileId: null }),
}));
