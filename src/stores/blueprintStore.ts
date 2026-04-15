import { create } from 'zustand';
import type { Tile, Wire, WireType } from '@/types';

/**
 * A Blueprint is a reusable canvas pattern: a set of tile configs plus
 * the wires between them, normalized to origin (0,0). Applying a blueprint
 * re-creates the tiles + wires in the active workspace with fresh IDs,
 * offset to the current viewport.
 *
 * Key difference vs. templates:
 *  - Template = a single tile's config. Spawn one tile.
 *  - Blueprint = an N-tile composition + wiring. Spawn a whole workflow.
 *
 * The Figma equivalent is components vs. instances — blueprints are
 * components that compose multiple primitives.
 */

/** A tile's config stripped of runtime state and absolute coordinates. */
export interface BlueprintTile {
  /** Relative position to the blueprint's origin (top-left of bounding box). */
  relX: number;
  relY: number;
  w: number;
  h: number;
  /** The full tile config minus id / x / y / ptyId / runtime fields. */
  config: Record<string, unknown>;
}

/** A wire re-keyed by indexes into the blueprint's tile list. */
export interface BlueprintWire {
  fromIdx: number;
  toIdx: number;
  fromPort: 'output' | 'stdout' | 'complete';
  toPort: 'input' | 'context' | 'trigger';
  wireType: WireType;
}

export interface Blueprint {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tiles: BlueprintTile[];
  wires: BlueprintWire[];
  createdAt: string;
  isBuiltin: boolean;
}

const STORAGE_KEY = 'tx-blueprints';

// Fields stripped when capturing a tile for a blueprint — all runtime or
// instance-level state that shouldn't carry over.
const STRIPPED_FIELDS = new Set([
  'id', 'x', 'y', 'w', 'h', 'ptyId', 'elapsed', 'status', 'connected',
  'containers', 'selectedContainer', 'lastOutput',
]);

function stripRuntime(tile: Tile): Record<string, unknown> {
  const raw = tile as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!STRIPPED_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Capture the bounding box of a set of tiles and emit a Blueprint with
 * relative coords (rel{X,Y} in [0, maxX - minX]).
 */
export function captureBlueprint(
  name: string,
  description: string,
  tiles: Tile[],
  wires: Wire[],
  icon?: string,
): Blueprint {
  if (tiles.length === 0) {
    throw new Error('Cannot capture a blueprint from zero tiles.');
  }
  const minX = Math.min(...tiles.map(t => t.x));
  const minY = Math.min(...tiles.map(t => t.y));

  const idByTileId = new Map<string, number>();
  const blueprintTiles: BlueprintTile[] = tiles.map((t, i) => {
    idByTileId.set(t.id, i);
    return {
      relX: t.x - minX,
      relY: t.y - minY,
      w: t.w,
      h: t.h,
      config: stripRuntime(t),
    };
  });

  // Only include wires whose both endpoints are inside the captured set.
  const blueprintWires: BlueprintWire[] = [];
  for (const w of wires) {
    const fromIdx = idByTileId.get(w.fromTile);
    const toIdx = idByTileId.get(w.toTile);
    if (fromIdx === undefined || toIdx === undefined) continue;
    blueprintWires.push({
      fromIdx,
      toIdx,
      fromPort: w.fromPort,
      toPort: w.toPort,
      wireType: w.wireType,
    });
  }

  return {
    id: `user:${crypto.randomUUID()}`,
    name,
    description,
    icon,
    tiles: blueprintTiles,
    wires: blueprintWires,
    createdAt: new Date().toISOString(),
    isBuiltin: false,
  };
}

/**
 * Apply a blueprint to the active canvas. Returns `{ tiles, wires }`
 * with fresh IDs offset to `anchor`. Caller is responsible for
 * inserting into canvasStore (usually via `addTile` / `addWire`).
 */
export function instantiateBlueprint(
  bp: Blueprint,
  anchor: { x: number; y: number },
): { tiles: Tile[]; wires: Wire[] } {
  const freshIds = bp.tiles.map(() => crypto.randomUUID());
  const tiles: Tile[] = bp.tiles.map((bt, i) => ({
    ...(bt.config as Record<string, unknown>),
    id: freshIds[i],
    x: anchor.x + bt.relX,
    y: anchor.y + bt.relY,
    w: bt.w,
    h: bt.h,
  }) as Tile);

  const wires: Wire[] = bp.wires.map(bw => ({
    id: crypto.randomUUID(),
    fromTile: freshIds[bw.fromIdx],
    toTile: freshIds[bw.toIdx],
    fromPort: bw.fromPort,
    toPort: bw.toPort,
    wireType: bw.wireType,
    active: false,
  }));

  return { tiles, wires };
}

// ─── Built-in starter blueprints ─────────────────────────────────────
// Three curated patterns that ship as starting points. Users clone +
// modify freely; cloning turns them into user blueprints.

const BUILTIN: Blueprint[] = [
  {
    id: 'builtin:auto-fix-loop',
    name: 'Auto-fix test loop',
    description: 'Runner + Claude Agent wired for hands-free test failures → fixes.',
    icon: '🔧',
    tiles: [
      {
        relX: 0, relY: 0, w: 600, h: 400,
        config: { type: 'runner', command: 'pnpm test', cwd: '~', lastOutput: '' },
      },
      {
        relX: 624, relY: 0, w: 600, h: 450,
        config: {
          type: 'agent', agent: 'claude', model: 'opus-4', effort: 'high',
          mode: 'chat', version: '', cwd: '~', branch: '',
          autoPipe: true, autoPipeIdleMs: 2000,
          autoPromptTemplate: 'Build/test output above. If red, diagnose the root cause and propose the minimal fix. If green, say DONE.',
        },
      },
    ],
    wires: [
      { fromIdx: 0, toIdx: 1, fromPort: 'output', toPort: 'input', wireType: 'context-pipe' },
    ],
    createdAt: '',
    isBuiltin: true,
  },
  {
    id: 'builtin:review-workflow',
    name: 'Review workflow',
    description: 'Git + Diff + Editor wired — click a changed file, see diff + content.',
    icon: '🔍',
    tiles: [
      {
        relX: 0, relY: 0, w: 350, h: 500,
        config: { type: 'git', repoPath: '~' },
      },
      {
        relX: 374, relY: 0, w: 700, h: 500,
        config: { type: 'diff', filePath: '', hunks: [], comments: [], mode: 'git' },
      },
      {
        relX: 1098, relY: 0, w: 600, h: 500,
        config: { type: 'editor', filePath: '', language: '' },
      },
      {
        relX: 0, relY: 524, w: 350, h: 400,
        config: { type: 'filetree', rootPath: '~', expandedPaths: [] },
      },
    ],
    wires: [
      { fromIdx: 3, toIdx: 2, fromPort: 'output', toPort: 'input', wireType: 'file-open' },
      { fromIdx: 3, toIdx: 1, fromPort: 'output', toPort: 'input', wireType: 'file-open' },
    ],
    createdAt: '',
    isBuiltin: true,
  },
  {
    id: 'builtin:triple-agent-debate',
    name: 'Triple-agent debate',
    description: 'Claude + Codex + Gemini side-by-side for multi-model comparison.',
    icon: '⚔️',
    tiles: [
      {
        relX: 0, relY: 0, w: 600, h: 450,
        config: {
          type: 'agent', agent: 'claude', model: 'opus-4', effort: 'high',
          mode: 'chat', version: '', cwd: '~', branch: '',
          title: 'Claude',
        },
      },
      {
        relX: 624, relY: 0, w: 600, h: 450,
        config: {
          type: 'agent', agent: 'codex', model: '', effort: '',
          mode: 'chat', version: '', cwd: '~', branch: '',
          title: 'Codex',
        },
      },
      {
        relX: 1248, relY: 0, w: 600, h: 450,
        config: {
          type: 'agent', agent: 'gemini', model: '', effort: '',
          mode: 'chat', version: '', cwd: '~', branch: '',
          title: 'Gemini',
        },
      },
    ],
    wires: [],
    createdAt: '',
    isBuiltin: true,
  },
];

interface BlueprintState {
  blueprints: Blueprint[];
  saveBlueprint: (bp: Blueprint) => void;
  deleteBlueprint: (id: string) => void;
  getBlueprint: (id: string) => Blueprint | undefined;
}

function loadFromStorage(): Blueprint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const user: Blueprint[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(user)) return [...BUILTIN];
    // Dedupe: built-ins by id, user overrides aren't allowed on builtin ids.
    const byId = new Map<string, Blueprint>();
    for (const b of BUILTIN) byId.set(b.id, b);
    for (const b of user) if (!b.isBuiltin) byId.set(b.id, b);
    return Array.from(byId.values());
  } catch {
    return [...BUILTIN];
  }
}

function saveToStorage(bps: Blueprint[]): void {
  try {
    const userOnly = bps.filter(b => !b.isBuiltin);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(userOnly));
  } catch {
    // Quota failure is acceptable here — user can re-save.
  }
}

export const useBlueprintStore = create<BlueprintState>((set, get) => ({
  blueprints: loadFromStorage(),

  saveBlueprint: (bp) => {
    set(state => {
      const existing = state.blueprints.findIndex(b => b.id === bp.id);
      const next = existing >= 0
        ? state.blueprints.map((b, i) => i === existing ? bp : b)
        : [...state.blueprints, bp];
      saveToStorage(next);
      return { blueprints: next };
    });
  },

  deleteBlueprint: (id) => {
    set(state => {
      const target = state.blueprints.find(b => b.id === id);
      if (!target || target.isBuiltin) return state;
      const next = state.blueprints.filter(b => b.id !== id);
      saveToStorage(next);
      return { blueprints: next };
    });
  },

  getBlueprint: (id) => get().blueprints.find(b => b.id === id),
}));
