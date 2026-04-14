import { create } from 'zustand';
import type { Tile, Wire, CanvasTransform, WorkspaceSnapshot, GroupTile } from '../types';
import type { SnapGuide } from '@/utils/layout';

// ─── Wire data throttle buffers ────────────────────────
const wireDataBuffer = new Map<string, string>();
let wireFlushTimer: number | null = null;

interface CanvasBookmark {
  name: string;
  transform: CanvasTransform;
}

interface CanvasState {
  // Per-project tile state
  tiles: Record<string, Tile[]>;
  wires: Record<string, Wire[]>;
  transforms: Record<string, CanvasTransform>;

  // Active project
  activeProject: string;

  // Z-ordering
  zStack: string[];
  focusedTile: string | null;

  // Focus mode
  focusModeActive: boolean;
  focusModeTiles: string[];

  // Multi-select
  selectedTiles: string[];

  // Bookmarks
  bookmarks: Record<string, CanvasBookmark[]>;

  // Workspace tabs — per project
  activeWorkspace: Record<string, string>;         // projectId -> workspace name
  workspaceNames: Record<string, string[]>;        // projectId -> list of workspace names

  // Actions — Multi-select
  toggleSelectTile: (tileId: string) => void;
  clearSelection: () => void;
  moveSelectedTiles: (dx: number, dy: number) => void;
  removeSelectedTiles: () => void;
  selectTilesInRect: (rect: { x: number; y: number; w: number; h: number }) => void;

  // Actions — Groups
  groupTiles: (tileIds: string[], label: string) => void;
  ungroupTiles: (groupId: string) => void;
  toggleGroupCollapse: (groupId: string) => void;

  // Actions — Bookmarks
  addBookmark: (name: string) => void;
  jumpToBookmark: (index: number) => void;
  removeBookmark: (index: number) => void;
  currentBookmarks: () => CanvasBookmark[];

  // Actions — Workspace tabs
  createWorkspace: (name: string) => void;
  switchWorkspace: (name: string) => void;
  deleteWorkspace: (name: string) => void;
  renameWorkspace: (oldName: string, newName: string) => void;

  // Actions — Tiles
  setTiles: (projectId: string, tiles: Tile[]) => void;
  addTile: (tile: Tile) => void;
  updateTile: (tileId: string, updates: Partial<Tile>) => void;
  removeTile: (tileId: string) => void;
  moveTile: (tileId: string, x: number, y: number) => void;
  resizeTile: (tileId: string, w: number, h: number) => void;

  // Actions — Z-stack
  bringToFront: (tileId: string) => void;
  setFocusedTile: (tileId: string | null) => void;

  // Actions — Transform
  setTransform: (transform: CanvasTransform) => void;
  resetTransform: () => void;

  // Actions — Wiring
  addWire: (wire: Wire) => void;
  removeWire: (wireId: string) => void;
  setWireActive: (wireId: string, active: boolean) => void;

  // Actions — Focus mode
  enterFocusMode: (tileIds: string[]) => void;
  exitFocusMode: () => void;

  // Actions — Project switching
  switchProject: (projectId: string) => void;

  // Actions — Snapshots
  saveSnapshot: (name: string) => WorkspaceSnapshot;
  loadSnapshot: (snapshot: WorkspaceSnapshot) => void;

  // Session sticky notes
  stickyNotes: Record<string, { id: string; x: number; y: number; text: string; color: string }[]>;
  addStickyNote: (x: number, y: number, text: string) => void;
  removeStickyNote: (noteId: string) => void;
  updateStickyNote: (noteId: string, text: string) => void;

  // Snap guides (ephemeral, set during drag)
  snapGuides: SnapGuide[];
  setSnapGuides: (guides: SnapGuide[]) => void;

  // Wire data bus
  wireData: Record<string, string>;  // tileId -> last output buffer
  appendWireData: (tileId: string, data: string) => void;
  getWireDataForTile: (tileId: string) => string;

  // Selectors
  currentTiles: () => Tile[];
  currentWires: () => Wire[];
  currentTransform: () => CanvasTransform;
}

const DEFAULT_TRANSFORM: CanvasTransform = { x: 0, y: 0, scale: 1 };

export const useCanvasStore = create<CanvasState>((set, get) => ({
  tiles: {},
  wires: {},
  transforms: {},
  activeProject: '',
  zStack: [],
  focusedTile: null,
  focusModeActive: false,
  focusModeTiles: [],
  selectedTiles: [],
  bookmarks: {},
  activeWorkspace: {},
  workspaceNames: {},
  stickyNotes: {},
  snapGuides: [],
  wireData: {},

  // ─── Multi-select ─────────────────────────────────────
  toggleSelectTile: (tileId) =>
    set(s => ({
      selectedTiles: s.selectedTiles.includes(tileId)
        ? s.selectedTiles.filter(id => id !== tileId)
        : [...s.selectedTiles, tileId],
    })),

  clearSelection: () => set({ selectedTiles: [] }),

  moveSelectedTiles: (dx, dy) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      const sel = new Set(s.selectedTiles);
      return {
        tiles: {
          ...s.tiles,
          [pid]: current.map(t =>
            sel.has(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t,
          ),
        },
      };
    }),

  selectTilesInRect: (rect) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      const selected = current
        .filter(t => t.type !== 'group' &&
          t.x < rect.x + rect.w && t.x + t.w > rect.x &&
          t.y < rect.y + rect.h && t.y + t.h > rect.y)
        .map(t => t.id);
      return { selectedTiles: selected };
    }),

  removeSelectedTiles: () =>
    set(s => {
      const pid = s.activeProject;
      const sel = new Set(s.selectedTiles);
      return {
        tiles: { ...s.tiles, [pid]: (s.tiles[pid] || []).filter(t => !sel.has(t.id)) },
        wires: {
          ...s.wires,
          [pid]: (s.wires[pid] || []).filter(w => !sel.has(w.fromTile) && !sel.has(w.toTile)),
        },
        zStack: s.zStack.filter(z => !sel.has(z)),
        selectedTiles: [],
        focusedTile: null,
      };
    }),

  // ─── Groups ───────────────────────────────────────────
  groupTiles: (tileIds, label) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      const children = current.filter(t => tileIds.includes(t.id));
      if (children.length === 0) return s;

      const minX = Math.min(...children.map(t => t.x));
      const minY = Math.min(...children.map(t => t.y));
      const maxX = Math.max(...children.map(t => t.x + t.w));
      const maxY = Math.max(...children.map(t => t.y + t.h));
      const padding = 16;

      const groupTile: GroupTile = {
        id: crypto.randomUUID(),
        type: 'group',
        label,
        childTileIds: tileIds,
        collapsed: false,
        x: minX - padding,
        y: minY - padding - 32, // account for group header
        w: maxX - minX + padding * 2,
        h: maxY - minY + padding * 2 + 32,
      };

      return {
        tiles: { ...s.tiles, [pid]: [...current, groupTile] },
        zStack: [...s.zStack, groupTile.id],
        selectedTiles: [],
      };
    }),

  ungroupTiles: (groupId) =>
    set(s => {
      const pid = s.activeProject;
      return {
        tiles: {
          ...s.tiles,
          [pid]: (s.tiles[pid] || []).filter(t => t.id !== groupId),
        },
        zStack: s.zStack.filter(z => z !== groupId),
      };
    }),

  toggleGroupCollapse: (groupId) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      return {
        tiles: {
          ...s.tiles,
          [pid]: current.map(t =>
            t.id === groupId && t.type === 'group'
              ? { ...t, collapsed: !t.collapsed } as GroupTile
              : t,
          ),
        },
      };
    }),

  // ─── Bookmarks ────────────────────────────────────────
  addBookmark: (name) =>
    set(s => {
      const pid = s.activeProject;
      const transform = s.transforms[pid] || DEFAULT_TRANSFORM;
      const current = s.bookmarks[pid] || [];
      return {
        bookmarks: {
          ...s.bookmarks,
          [pid]: [...current, { name, transform: { ...transform } }],
        },
      };
    }),

  jumpToBookmark: (index) =>
    set(s => {
      const pid = s.activeProject;
      const list = s.bookmarks[pid] || [];
      const bm = list[index];
      if (!bm) return s;
      return {
        transforms: { ...s.transforms, [pid]: { ...bm.transform } },
      };
    }),

  removeBookmark: (index) =>
    set(s => {
      const pid = s.activeProject;
      const list = [...(s.bookmarks[pid] || [])];
      list.splice(index, 1);
      return { bookmarks: { ...s.bookmarks, [pid]: list } };
    }),

  currentBookmarks: () => {
    const s = get();
    return s.bookmarks[s.activeProject] || [];
  },

  // ─── Workspace Tabs ────────────────────────────────────
  createWorkspace: (name) =>
    set(s => {
      const pid = s.activeProject;
      const names = s.workspaceNames[pid] || ['Default'];
      if (names.includes(name)) return s;
      // Save current workspace state
      const currentWs = s.activeWorkspace[pid] || 'Default';
      const wsKey = `${pid}::${currentWs}`;
      return {
        workspaceNames: { ...s.workspaceNames, [pid]: [...names, name] },
        activeWorkspace: { ...s.activeWorkspace, [pid]: name },
        // Save current tiles/wires under old key, start fresh for new workspace
        tiles: { ...s.tiles, [wsKey]: s.tiles[pid] || [], [pid]: [] },
        wires: { ...s.wires, [wsKey]: s.wires[pid] || [], [pid]: [] },
        transforms: { ...s.transforms, [wsKey]: s.transforms[pid] || DEFAULT_TRANSFORM, [pid]: DEFAULT_TRANSFORM },
        zStack: [],
        focusedTile: null,
        selectedTiles: [],
      };
    }),

  switchWorkspace: (name) =>
    set(s => {
      const pid = s.activeProject;
      const currentWs = s.activeWorkspace[pid] || 'Default';
      if (currentWs === name) return s;
      const currentKey = `${pid}::${currentWs}`;
      const targetKey = `${pid}::${name}`;
      return {
        activeWorkspace: { ...s.activeWorkspace, [pid]: name },
        // Stash current state and restore target
        tiles: {
          ...s.tiles,
          [currentKey]: s.tiles[pid] || [],
          [pid]: s.tiles[targetKey] || [],
        },
        wires: {
          ...s.wires,
          [currentKey]: s.wires[pid] || [],
          [pid]: s.wires[targetKey] || [],
        },
        transforms: {
          ...s.transforms,
          [currentKey]: s.transforms[pid] || DEFAULT_TRANSFORM,
          [pid]: s.transforms[targetKey] || DEFAULT_TRANSFORM,
        },
        zStack: [],
        focusedTile: null,
        selectedTiles: [],
      };
    }),

  deleteWorkspace: (name) =>
    set(s => {
      const pid = s.activeProject;
      const names = s.workspaceNames[pid] || ['Default'];
      if (names.length <= 1) return s; // can't delete last workspace
      const filtered = names.filter(n => n !== name);
      const wsKey = `${pid}::${name}`;
      const newTiles = { ...s.tiles };
      const newWires = { ...s.wires };
      const newTransforms = { ...s.transforms };
      delete newTiles[wsKey];
      delete newWires[wsKey];
      delete newTransforms[wsKey];
      // If deleting active workspace, switch to first remaining
      const currentWs = s.activeWorkspace[pid] || 'Default';
      if (currentWs === name) {
        const target = filtered[0];
        const targetKey = `${pid}::${target}`;
        return {
          workspaceNames: { ...s.workspaceNames, [pid]: filtered },
          activeWorkspace: { ...s.activeWorkspace, [pid]: target },
          tiles: { ...newTiles, [pid]: newTiles[targetKey] || [] },
          wires: { ...newWires, [pid]: newWires[targetKey] || [] },
          transforms: { ...newTransforms, [pid]: newTransforms[targetKey] || DEFAULT_TRANSFORM },
          zStack: [],
          focusedTile: null,
          selectedTiles: [],
        };
      }
      return {
        workspaceNames: { ...s.workspaceNames, [pid]: filtered },
        tiles: newTiles,
        wires: newWires,
        transforms: newTransforms,
      };
    }),

  renameWorkspace: (oldName, newName) =>
    set(s => {
      const pid = s.activeProject;
      const names = s.workspaceNames[pid] || ['Default'];
      if (!names.includes(oldName) || names.includes(newName)) return s;
      const oldKey = `${pid}::${oldName}`;
      const newKey = `${pid}::${newName}`; // eslint-disable-line @typescript-eslint/no-unused-vars
      const newTiles = { ...s.tiles, [newKey]: s.tiles[oldKey] };
      const newWires = { ...s.wires, [newKey]: s.wires[oldKey] };
      const newTransforms = { ...s.transforms, [newKey]: s.transforms[oldKey] };
      delete newTiles[oldKey];
      delete newWires[oldKey];
      delete newTransforms[oldKey];
      return {
        workspaceNames: { ...s.workspaceNames, [pid]: names.map(n => n === oldName ? newName : n) },
        activeWorkspace: {
          ...s.activeWorkspace,
          [pid]: s.activeWorkspace[pid] === oldName ? newName : s.activeWorkspace[pid],
        },
        tiles: newTiles,
        wires: newWires,
        transforms: newTransforms,
      };
    }),

  // ─── Tiles ────────────────────────────────────────────
  setTiles: (projectId, tiles) =>
    set(s => ({ tiles: { ...s.tiles, [projectId]: tiles } })),

  addTile: (tile) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      return {
        tiles: { ...s.tiles, [pid]: [...current, tile] },
        zStack: [...s.zStack, tile.id],
        focusedTile: tile.id,
      };
    }),

  updateTile: (tileId, updates) =>
    set(s => {
      const pid = s.activeProject;
      const current = s.tiles[pid] || [];
      return {
        tiles: {
          ...s.tiles,
          [pid]: current.map(t => t.id === tileId ? { ...t, ...updates } as Tile : t),
        },
      };
    }),

  removeTile: (tileId) =>
    set(s => {
      const pid = s.activeProject;
      // Clean up wireData for this tile's PTY
      const tile = (s.tiles[pid] || []).find(t => t.id === tileId);
      const ptyId = tile && 'ptyId' in tile ? (tile as { ptyId?: string }).ptyId : undefined;
      const newWireData = { ...s.wireData };
      if (ptyId) delete newWireData[ptyId];
      // Clean up group childTileIds references
      const updatedTiles = (s.tiles[pid] || [])
        .filter(t => t.id !== tileId)
        .map(t => t.type === 'group' ? { ...t, childTileIds: (t as import('@/types').GroupTile).childTileIds.filter(id => id !== tileId) } : t);
      return {
        tiles: { ...s.tiles, [pid]: updatedTiles },
        wires: {
          ...s.wires,
          [pid]: (s.wires[pid] || []).filter(w => w.fromTile !== tileId && w.toTile !== tileId),
        },
        zStack: s.zStack.filter(z => z !== tileId),
        wireData: newWireData,
        focusedTile: s.focusedTile === tileId ? null : s.focusedTile,
        selectedTiles: s.selectedTiles.filter(id => id !== tileId),
      };
    }),

  moveTile: (tileId, x, y) =>
    set(s => {
      const pid = s.activeProject;
      return {
        tiles: {
          ...s.tiles,
          [pid]: (s.tiles[pid] || []).map(t => t.id === tileId ? { ...t, x, y } : t),
        },
      };
    }),

  resizeTile: (tileId, w, h) =>
    set(s => {
      const pid = s.activeProject;
      return {
        tiles: {
          ...s.tiles,
          [pid]: (s.tiles[pid] || []).map(t => t.id === tileId ? { ...t, w, h } : t),
        },
      };
    }),

  // ─── Z-stack ──────────────────────────────────────────
  bringToFront: (tileId) =>
    set(s => ({
      zStack: [...s.zStack.filter(z => z !== tileId), tileId],
      focusedTile: tileId,
    })),

  setFocusedTile: (tileId) => set({ focusedTile: tileId }),

  // ─── Transform ────────────────────────────────────────
  setTransform: (transform) =>
    set(s => ({
      transforms: { ...s.transforms, [s.activeProject]: transform },
    })),

  resetTransform: () =>
    set(s => ({
      transforms: { ...s.transforms, [s.activeProject]: DEFAULT_TRANSFORM },
    })),

  // ─── Sticky Notes ─────────────────────────────────────
  addStickyNote: (x, y, text) => set(s => {
    const pid = s.activeProject;
    const current = s.stickyNotes[pid] || [];
    const colors = ['#CCFF00', '#FF6B6B', '#4ECDC4', '#FFE66D', '#A8E6CF'];
    return { stickyNotes: { ...s.stickyNotes, [pid]: [...current, { id: crypto.randomUUID(), x, y, text, color: colors[current.length % colors.length] }] } };
  }),
  removeStickyNote: (noteId) => set(s => {
    const pid = s.activeProject;
    return { stickyNotes: { ...s.stickyNotes, [pid]: (s.stickyNotes[pid] || []).filter(n => n.id !== noteId) } };
  }),
  updateStickyNote: (noteId, text) => set(s => {
    const pid = s.activeProject;
    return { stickyNotes: { ...s.stickyNotes, [pid]: (s.stickyNotes[pid] || []).map(n => n.id === noteId ? { ...n, text } : n) } };
  }),

  // ─── Snap Guides ──────────────────────────────────────
  setSnapGuides: (guides) => set({ snapGuides: guides }),

  // ─── Wiring ───────────────────────────────────────────
  addWire: (wire) =>
    set(s => {
      const pid = s.activeProject;
      return { wires: { ...s.wires, [pid]: [...(s.wires[pid] || []), wire] } };
    }),

  removeWire: (wireId) =>
    set(s => {
      const pid = s.activeProject;
      return { wires: { ...s.wires, [pid]: (s.wires[pid] || []).filter(w => w.id !== wireId) } };
    }),

  setWireActive: (wireId, active) =>
    set(s => {
      const pid = s.activeProject;
      return {
        wires: {
          ...s.wires,
          [pid]: (s.wires[pid] || []).map(w => w.id === wireId ? { ...w, active } : w),
        },
      };
    }),

  // ─── Focus Mode ───────────────────────────────────────
  enterFocusMode: (tileIds) =>
    set({ focusModeActive: true, focusModeTiles: tileIds }),

  exitFocusMode: () =>
    set({ focusModeActive: false, focusModeTiles: [] }),

  // ─── Project Switching ────────────────────────────────
  switchProject: (projectId) =>
    set(() => ({
      activeProject: projectId,
      focusedTile: null,
      focusModeActive: false,
      focusModeTiles: [],
      selectedTiles: [],
      zStack: [],
    })),

  // ─── Snapshots ────────────────────────────────────────
  saveSnapshot: (name) => {
    const s = get();
    const pid = s.activeProject;
    return {
      name,
      tiles: s.tiles[pid] || [],
      wires: s.wires[pid] || [],
      transform: s.transforms[pid] || DEFAULT_TRANSFORM,
      zStack: [...s.zStack],
      createdAt: new Date().toISOString(),
    };
  },

  loadSnapshot: (snapshot) =>
    set(s => {
      const pid = s.activeProject;
      return {
        tiles: { ...s.tiles, [pid]: snapshot.tiles },
        wires: { ...s.wires, [pid]: snapshot.wires },
        transforms: { ...s.transforms, [pid]: snapshot.transform },
        zStack: snapshot.zStack ?? snapshot.tiles.map(t => t.id),
        focusedTile: null,
        selectedTiles: [],
        focusModeActive: false,
        focusModeTiles: [],
      };
    }),

  // ─── Wire Data Bus ────────────────────────────────────
  appendWireData: (tileId, data) => {
    const existing = wireDataBuffer.get(tileId) || get().wireData[tileId] || '';
    const combined = existing + data;
    const lines = combined.split('\n');
    const trimmed = lines.length > 50 ? lines.slice(-50).join('\n') : combined;
    wireDataBuffer.set(tileId, trimmed);

    if (!wireFlushTimer) {
      wireFlushTimer = window.setTimeout(() => {
        wireFlushTimer = null;
        const updates: Record<string, string> = {};
        wireDataBuffer.forEach((val, key) => { updates[key] = val; });
        wireDataBuffer.clear();
        if (Object.keys(updates).length > 0) {
          set(s => ({ wireData: { ...s.wireData, ...updates } }));
        }
      }, 200);
    }
  },

  getWireDataForTile: (tileId) => {
    return get().wireData[tileId] || '';
  },

  // ─── Selectors ────────────────────────────────────────
  currentTiles: () => {
    const s = get();
    return s.tiles[s.activeProject] || [];
  },

  currentWires: () => {
    const s = get();
    return s.wires[s.activeProject] || [];
  },

  currentTransform: () => {
    const s = get();
    return s.transforms[s.activeProject] || DEFAULT_TRANSFORM;
  },
}));
