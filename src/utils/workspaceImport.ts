import type { Tile, TileType, Wire, WireType, CanvasTransform } from '@/types';

// Tile/wire fan-out caps — anything larger is either corruption or hostile.
const MAX_TILES = 5000;
const MAX_WIRES = 10000;
const MAX_STRING = 65_536;           // per-field cap (64 KB)
const MAX_LONG_STRING = 2_000_000;   // 2 MB — NoteTile.content / DiffTile.paste*
const MAX_ARRAY = 2000;              // per-list cap (columns, items, hunks, comments, splits, etc.)

// Clamp tiles to a reasonable canvas region so we never store NaN/Infinity or
// absurd offsets that could break rendering math downstream.
const MAX_COORD = 1_000_000;
const MIN_W = 40;
const MIN_H = 40;
const MAX_DIM = 10_000;

const TILE_TYPES: ReadonlySet<TileType> = new Set<TileType>([
  'agent', 'terminal', 'browser', 'todo', 'diff', 'editor', 'note', 'kanban',
  'filetree', 'group', 'runner', 'ssh', 'docker', 'git', 'usage',
]);

const WIRE_TYPES: ReadonlySet<WireType> = new Set<WireType>([
  'context-pipe', 'refresh-trigger', 'task-assign', 'diff-feed',
  'agent-chain', 'file-open',
]);

const AGENT_TYPES = new Set(['claude', 'codex', 'gemini']);
const AGENT_STATUSES = new Set(['spawning', 'idle', 'working', 'done', 'error']);
const RUNNER_STATUSES = new Set(['idle', 'running', 'pass', 'fail']);
const DIFF_MODES = new Set(['git', 'compare', 'paste']);

export interface ValidatedWorkspace {
  tiles: Tile[];
  wires: Wire[];
  transform: CanvasTransform;
}

export class WorkspaceImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceImportError';
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = MAX_STRING): string {
  if (typeof v !== 'string') throw new WorkspaceImportError('Expected string');
  if (v.length > max) throw new WorkspaceImportError(`String exceeds ${max} chars`);
  return v;
}

function optStr(v: unknown, max = MAX_STRING): string | undefined {
  if (v === undefined || v === null) return undefined;
  return str(v, max);
}

function num(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new WorkspaceImportError('Expected finite number');
  }
  if (v < min || v > max) {
    throw new WorkspaceImportError(`Number out of range [${min}, ${max}]`);
  }
  return v;
}

function optNum(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  return num(v, min, max);
}

function optBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new WorkspaceImportError('Expected boolean');
  return v;
}

function strArray(v: unknown, maxLen = MAX_ARRAY, itemMax = MAX_STRING): string[] {
  if (!Array.isArray(v)) throw new WorkspaceImportError('Expected array');
  if (v.length > maxLen) throw new WorkspaceImportError(`Array exceeds ${maxLen} items`);
  return v.map(item => str(item, itemMax));
}

function validateBase(raw: Record<string, unknown>): {
  id: string; type: TileType; x: number; y: number; w: number; h: number; title?: string;
} {
  const type = str(raw.type, 32);
  if (!TILE_TYPES.has(type as TileType)) {
    throw new WorkspaceImportError(`Unknown tile type: ${type}`);
  }
  return {
    id: str(raw.id, 128),
    type: type as TileType,
    x: num(raw.x, -MAX_COORD, MAX_COORD),
    y: num(raw.y, -MAX_COORD, MAX_COORD),
    w: num(raw.w, MIN_W, MAX_DIM),
    h: num(raw.h, MIN_H, MAX_DIM),
    title: optStr(raw.title, 1024),
  };
}

// ─── Per-tile-type validators ──────────────────────────────────────
// Each validator receives the raw object and the validated base, and returns
// a fully-typed Tile. Unknown extra fields are silently dropped — we only
// keep what the schema knows about. This is the import-hardening principle:
// treat the file as untrusted user input, not as a structural clone.

function validateAgent(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  const agent = str(raw.agent, 32);
  if (!AGENT_TYPES.has(agent)) throw new WorkspaceImportError(`Bad agent: ${agent}`);
  const status = str(raw.status, 32);
  if (!AGENT_STATUSES.has(status)) throw new WorkspaceImportError(`Bad status: ${status}`);
  return {
    ...base,
    type: 'agent',
    agent: agent as 'claude' | 'codex' | 'gemini',
    model: str(raw.model, 128),
    effort: str(raw.effort, 64),
    mode: str(raw.mode, 64),
    version: str(raw.version, 64),
    cwd: str(raw.cwd, 4096),
    branch: str(raw.branch, 255),
    status: status as 'spawning' | 'idle' | 'working' | 'done' | 'error',
    // ptyId intentionally dropped — it's session-scoped
    elapsed: num(raw.elapsed ?? 0, 0, Number.MAX_SAFE_INTEGER),
    command: optStr(raw.command, 16_384),
    autoComplete: optBool(raw.autoComplete),
    idleThresholdMs: optNum(raw.idleThresholdMs, 0, 86_400_000),
    doneSentinel: optStr(raw.doneSentinel, 1024),
    autoPipe: optBool(raw.autoPipe),
    autoPipeIdleMs: optNum(raw.autoPipeIdleMs, 0, 86_400_000),
    autoPromptTemplate: optStr(raw.autoPromptTemplate, 16_384),
  };
}

function validateTerminal(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  let splits: { id: string; direction: 'horizontal' | 'vertical'; ratio: number; ptyId: string }[] | undefined;
  if (raw.splits !== undefined) {
    if (!Array.isArray(raw.splits)) throw new WorkspaceImportError('splits must be array');
    if (raw.splits.length > 16) throw new WorkspaceImportError('Too many splits');
    splits = raw.splits.map((s: unknown) => {
      if (!isObj(s)) throw new WorkspaceImportError('Bad split');
      const dir = str(s.direction, 16);
      if (dir !== 'horizontal' && dir !== 'vertical') throw new WorkspaceImportError(`Bad split direction: ${dir}`);
      return {
        id: str(s.id, 128),
        direction: dir,
        ratio: num(s.ratio, 0, 1),
        ptyId: str(s.ptyId, 128),
      };
    });
  }
  return {
    ...base,
    type: 'terminal',
    cwd: str(raw.cwd, 4096),
    branch: str(raw.branch, 255),
    node: str(raw.node, 64),
    splits,
  };
}

function validateBrowser(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  const url = str(raw.url, 8192);
  // Only allow http(s) and about:blank — a malformed import shouldn't point
  // our webview at javascript: or file: schemes.
  if (url && !/^(https?:|about:blank|$)/i.test(url)) {
    throw new WorkspaceImportError(`Unsafe browser URL scheme: ${url.slice(0, 60)}`);
  }
  return { ...base, type: 'browser', url };
}

function validateTodo(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  if (!Array.isArray(raw.items)) throw new WorkspaceImportError('todo.items must be array');
  if (raw.items.length > MAX_ARRAY) throw new WorkspaceImportError('Too many todo items');
  const items = raw.items.map((it: unknown) => {
    if (!isObj(it)) throw new WorkspaceImportError('Bad todo item');
    return {
      id: str(it.id, 128),
      text: str(it.text, 8192),
      done: typeof it.done === 'boolean' ? it.done : false,
      assignedAgent: optStr(it.assignedAgent, 128),
    };
  });
  return {
    ...base,
    type: 'todo',
    items,
    autoDispatch: optBool(raw.autoDispatch),
  };
}

function validateDiff(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  let hunks: { oldStart: number; newStart: number; lines: { type: 'add' | 'remove' | 'context'; content: string }[] }[] = [];
  if (raw.hunks !== undefined) {
    if (!Array.isArray(raw.hunks)) throw new WorkspaceImportError('diff.hunks must be array');
    if (raw.hunks.length > MAX_ARRAY) throw new WorkspaceImportError('Too many diff hunks');
    hunks = raw.hunks.map((h: unknown) => {
      if (!isObj(h)) throw new WorkspaceImportError('Bad diff hunk');
      if (!Array.isArray(h.lines)) throw new WorkspaceImportError('Bad hunk lines');
      if (h.lines.length > 10_000) throw new WorkspaceImportError('Hunk too large');
      const lines = h.lines.map((l: unknown) => {
        if (!isObj(l)) throw new WorkspaceImportError('Bad hunk line');
        const t = str(l.type, 16);
        if (t !== 'add' && t !== 'remove' && t !== 'context') throw new WorkspaceImportError(`Bad line type: ${t}`);
        return { type: t as 'add' | 'remove' | 'context', content: str(l.content, 16_384) };
      });
      return {
        oldStart: num(h.oldStart ?? 0, 0, Number.MAX_SAFE_INTEGER),
        newStart: num(h.newStart ?? 0, 0, Number.MAX_SAFE_INTEGER),
        lines,
      };
    });
  }
  const comments = Array.isArray(raw.comments) ? raw.comments.map((c: unknown) => {
    if (!isObj(c)) throw new WorkspaceImportError('Bad diff comment');
    return {
      id: str(c.id, 128),
      line: num(c.line ?? 0, 0, Number.MAX_SAFE_INTEGER),
      text: str(c.text, 16_384),
      resolved: typeof c.resolved === 'boolean' ? c.resolved : false,
    };
  }) : [];
  if (comments.length > MAX_ARRAY) throw new WorkspaceImportError('Too many diff comments');

  const mode = raw.mode === undefined ? undefined : str(raw.mode, 16);
  if (mode !== undefined && !DIFF_MODES.has(mode)) throw new WorkspaceImportError(`Bad diff mode: ${mode}`);

  return {
    ...base,
    type: 'diff',
    filePath: optStr(raw.filePath, 4096) ?? '',
    hunks,
    comments,
    mode: mode as 'git' | 'compare' | 'paste' | undefined,
    repoPath: optStr(raw.repoPath, 4096),
    gitTarget: optStr(raw.gitTarget, 4096),
    compareLeft: optStr(raw.compareLeft, 4096),
    compareRight: optStr(raw.compareRight, 4096),
    pasteOriginal: optStr(raw.pasteOriginal, MAX_LONG_STRING),
    pasteModified: optStr(raw.pasteModified, MAX_LONG_STRING),
  };
}

function validateEditor(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return {
    ...base,
    type: 'editor',
    filePath: str(raw.filePath, 4096),
    language: optStr(raw.language, 64) ?? '',
  };
}

function validateNote(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return {
    ...base,
    type: 'note',
    content: optStr(raw.content, MAX_LONG_STRING) ?? '',
  };
}

function validateKanban(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  if (!Array.isArray(raw.columns)) throw new WorkspaceImportError('kanban.columns must be array');
  if (raw.columns.length > 32) throw new WorkspaceImportError('Too many kanban columns');
  const columns = raw.columns.map((col: unknown) => {
    if (!isObj(col)) throw new WorkspaceImportError('Bad kanban column');
    if (!Array.isArray(col.items)) throw new WorkspaceImportError('Bad kanban items');
    if (col.items.length > MAX_ARRAY) throw new WorkspaceImportError('Too many kanban items');
    return {
      id: str(col.id, 128),
      title: str(col.title, 128),
      items: col.items.map((it: unknown) => {
        if (!isObj(it)) throw new WorkspaceImportError('Bad kanban item');
        return {
          id: str(it.id, 128),
          text: str(it.text, 8192),
          color: optStr(it.color, 32),
        };
      }),
    };
  });
  return { ...base, type: 'kanban', columns };
}

function validateFileTree(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return {
    ...base,
    type: 'filetree',
    rootPath: str(raw.rootPath, 4096),
    expandedPaths: Array.isArray(raw.expandedPaths) ? strArray(raw.expandedPaths, MAX_ARRAY, 4096) : [],
    selectedFile: optStr(raw.selectedFile, 4096),
  };
}

function validateGroup(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return {
    ...base,
    type: 'group',
    label: str(raw.label, 255),
    childTileIds: Array.isArray(raw.childTileIds) ? strArray(raw.childTileIds, MAX_TILES, 128) : [],
    collapsed: typeof raw.collapsed === 'boolean' ? raw.collapsed : false,
  };
}

function validateRunner(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  const status = str(raw.status, 32);
  if (!RUNNER_STATUSES.has(status)) throw new WorkspaceImportError(`Bad runner status: ${status}`);
  return {
    ...base,
    type: 'runner',
    command: str(raw.command, 16_384),
    cwd: str(raw.cwd, 4096),
    status: status as 'idle' | 'running' | 'pass' | 'fail',
    lastOutput: optStr(raw.lastOutput, MAX_LONG_STRING) ?? '',
  };
}

function validateSsh(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return {
    ...base,
    type: 'ssh',
    host: str(raw.host, 255),
    port: num(raw.port ?? 22, 1, 65535),
    user: str(raw.user, 64),
    connected: typeof raw.connected === 'boolean' ? raw.connected : false,
  };
}

function validateDocker(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  const containers = Array.isArray(raw.containers) ? raw.containers.map((c: unknown) => {
    if (!isObj(c)) throw new WorkspaceImportError('Bad docker container');
    return {
      id: str(c.id, 128),
      name: str(c.name, 255),
      image: str(c.image, 512),
      status: str(c.status, 64),
    };
  }) : [];
  if (containers.length > 500) throw new WorkspaceImportError('Too many docker containers');
  return {
    ...base,
    type: 'docker',
    containers,
    selectedContainer: optStr(raw.selectedContainer, 128),
  };
}

function validateGit(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return { ...base, type: 'git', repoPath: str(raw.repoPath, 4096) };
}

function validateUsage(_raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  return { ...base, type: 'usage' };
}

function validatePipelineController(raw: Record<string, unknown>, base: ReturnType<typeof validateBase>): Tile {
  // pipeline-controller tiles aren't legitimately exportable in Phase 1 —
  // they're spawned by pipeline runs and bound to runtime-only run state.
  // Best-effort restore: preserve the runId if present, else empty (the
  // tile renders a "No run bound" fallback).
  const runId = typeof raw.runId === 'string' ? raw.runId : '';
  return { ...base, type: 'pipeline-controller', runId };
}

// ─── Dispatch table ────────────────────────────────────────────────
// Using a dispatch table (instead of a switch) keeps the entry points
// obvious and future tile additions easy to wire in.
const TILE_VALIDATORS: Record<TileType, (raw: Record<string, unknown>, base: ReturnType<typeof validateBase>) => Tile> = {
  agent: validateAgent,
  terminal: validateTerminal,
  browser: validateBrowser,
  todo: validateTodo,
  diff: validateDiff,
  editor: validateEditor,
  note: validateNote,
  kanban: validateKanban,
  filetree: validateFileTree,
  group: validateGroup,
  runner: validateRunner,
  ssh: validateSsh,
  docker: validateDocker,
  git: validateGit,
  usage: validateUsage,
  'pipeline-controller': validatePipelineController,
};

export function validateTile(raw: unknown): Tile {
  if (!isObj(raw)) throw new WorkspaceImportError('Tile must be an object');
  const base = validateBase(raw);
  return TILE_VALIDATORS[base.type](raw, base);
}

export function validateWire(raw: unknown, tileIds?: ReadonlySet<string>): Wire {
  if (!isObj(raw)) throw new WorkspaceImportError('Wire must be an object');
  const wireType = str(raw.wireType, 32);
  if (!WIRE_TYPES.has(wireType as WireType)) {
    throw new WorkspaceImportError(`Unknown wire type: ${wireType}`);
  }
  const fromPort = str(raw.fromPort, 32);
  if (fromPort !== 'output' && fromPort !== 'stdout' && fromPort !== 'complete') {
    throw new WorkspaceImportError(`Bad fromPort: ${fromPort}`);
  }
  const toPort = str(raw.toPort, 32);
  if (toPort !== 'input' && toPort !== 'context' && toPort !== 'trigger') {
    throw new WorkspaceImportError(`Bad toPort: ${toPort}`);
  }
  const fromTile = str(raw.fromTile, 128);
  const toTile = str(raw.toTile, 128);
  // If the caller gave us a tile-id set, require wire endpoints to reference
  // real tiles — otherwise dangling wires would render as ghosts.
  if (tileIds && (!tileIds.has(fromTile) || !tileIds.has(toTile))) {
    throw new WorkspaceImportError(`Wire references missing tile(s): ${fromTile} → ${toTile}`);
  }
  return {
    id: str(raw.id, 128),
    fromTile,
    fromPort: fromPort as 'output' | 'stdout' | 'complete',
    toTile,
    toPort: toPort as 'input' | 'context' | 'trigger',
    wireType: wireType as WireType,
    active: typeof raw.active === 'boolean' ? raw.active : false,
  };
}

export function validateTransform(raw: unknown): CanvasTransform {
  if (!isObj(raw)) return { x: 0, y: 0, scale: 1 };
  const x = typeof raw.x === 'number' && Number.isFinite(raw.x) ? raw.x : 0;
  const y = typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : 0;
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale) ? raw.scale : 1;
  // Clamp to safe bounds
  return {
    x: Math.max(-MAX_COORD, Math.min(MAX_COORD, x)),
    y: Math.max(-MAX_COORD, Math.min(MAX_COORD, y)),
    scale: Math.max(0.05, Math.min(10, scale)),
  };
}

/**
 * Validate a workspace-import payload and return the parts we'll graft into
 * the canvas. Throws WorkspaceImportError with a clear reason on failure.
 *
 * Contract: pass untrusted JSON.parse output. We don't trust anything here —
 * every field is checked, unknown fields are dropped, array sizes are capped,
 * wire endpoints must reference real tiles.
 */
export function validateWorkspaceImport(raw: unknown): ValidatedWorkspace {
  if (!isObj(raw)) throw new WorkspaceImportError('Workspace must be an object');
  if (raw.version !== undefined && raw.version !== 1) {
    throw new WorkspaceImportError(`Unsupported workspace version: ${String(raw.version)}`);
  }
  if (!Array.isArray(raw.tiles)) throw new WorkspaceImportError('tiles must be an array');
  if (raw.tiles.length > MAX_TILES) throw new WorkspaceImportError(`Too many tiles (max ${MAX_TILES})`);

  const tiles = raw.tiles.map((t, i) => {
    try {
      return validateTile(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new WorkspaceImportError(`Tile [${i}]: ${msg}`);
    }
  });

  // Reject duplicate tile IDs — a workspace that re-used an ID would break
  // z-stack lookups, wire routing, and persistence invariants.
  const tileIds = new Set<string>();
  for (const t of tiles) {
    if (tileIds.has(t.id)) throw new WorkspaceImportError(`Duplicate tile id: ${t.id}`);
    tileIds.add(t.id);
  }

  const wiresRaw = Array.isArray(raw.wires) ? raw.wires : [];
  if (wiresRaw.length > MAX_WIRES) throw new WorkspaceImportError(`Too many wires (max ${MAX_WIRES})`);
  const wires = wiresRaw.map((w, i) => {
    try {
      return validateWire(w, tileIds);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new WorkspaceImportError(`Wire [${i}]: ${msg}`);
    }
  });

  return {
    tiles,
    wires,
    transform: validateTransform(raw.transform),
  };
}
