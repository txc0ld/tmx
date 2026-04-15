import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import { useWiringStore } from '@/stores/wiringStore';
import type { Tile, AgentTile, TerminalTile, BrowserTile, TodoTile, DiffTile, RunnerTile } from '@/types';

// ─── Test helpers ──────────────────────────────────────

const PID = 'test-project';

function resetStores() {
  useCanvasStore.setState({
    tiles: { [PID]: [] },
    wires: { [PID]: [] },
    transforms: { [PID]: { x: 0, y: 0, scale: 1 } },
    activeProject: PID,
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
  });
  useWiringStore.setState({ dragging: false, fromTileId: null, cursorX: 0, cursorY: 0 });
}

function makeTile(partial: Partial<Tile> & { id: string; type: Tile['type'] }): Tile {
  const base = {
    x: 0, y: 0, w: 400, h: 300,
  };
  switch (partial.type) {
    case 'agent':
      return { ...base, agent: 'claude', model: 'opus-4', effort: 'high', mode: 'code', version: '', cwd: '~', branch: '', status: 'idle', elapsed: 0, ...partial } as AgentTile;
    case 'terminal':
      return { ...base, cwd: '~', branch: '', node: '', splits: [], ...partial } as TerminalTile;
    case 'browser':
      return { ...base, url: 'http://localhost:3000', ...partial } as BrowserTile;
    case 'todo':
      return { ...base, items: [], ...partial } as TodoTile;
    case 'diff':
      return { ...base, filePath: 'test.ts', hunks: [], comments: [], ...partial } as DiffTile;
    case 'runner':
      return { ...base, command: 'npm test', cwd: '~', status: 'idle', lastOutput: '', ...partial } as RunnerTile;
    default:
      throw new Error(`Unsupported test tile type: ${partial.type}`);
  }
}

function addTiles(tiles: Tile[]) {
  useCanvasStore.setState(s => ({ tiles: { ...s.tiles, [PID]: tiles } }));
}

// ─── wiringStore state machine ──────────────────────────

describe('wiringStore — drag state machine', () => {
  beforeEach(resetStores);

  it('starts in a clean state', () => {
    const s = useWiringStore.getState();
    expect(s.dragging).toBe(false);
    expect(s.fromTileId).toBe(null);
  });

  it('start() enters dragging mode with source tile + cursor coords', () => {
    useWiringStore.getState().start('tile-a', 100, 200);
    const s = useWiringStore.getState();
    expect(s.dragging).toBe(true);
    expect(s.fromTileId).toBe('tile-a');
    expect(s.cursorX).toBe(100);
    expect(s.cursorY).toBe(200);
  });

  it('moveCursor() updates coords only while dragging', () => {
    useWiringStore.getState().moveCursor(50, 50);
    expect(useWiringStore.getState().cursorX).toBe(0); // ignored
    useWiringStore.getState().start('a', 10, 20);
    useWiringStore.getState().moveCursor(500, 600);
    expect(useWiringStore.getState().cursorX).toBe(500);
    expect(useWiringStore.getState().cursorY).toBe(600);
  });

  it('cancel() resets state without creating a wire', () => {
    addTiles([makeTile({ id: 'a', type: 'terminal' }), makeTile({ id: 'b', type: 'agent' })]);
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().cancel();
    const s = useWiringStore.getState();
    expect(s.dragging).toBe(false);
    expect(s.fromTileId).toBe(null);
    expect(useCanvasStore.getState().wires[PID]?.length ?? 0).toBe(0);
  });

  it('finish(null) cancels without creating a wire', () => {
    addTiles([makeTile({ id: 'a', type: 'terminal' })]);
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish(null);
    expect(useCanvasStore.getState().wires[PID]?.length ?? 0).toBe(0);
  });

  it('finish(sameTile) does not create a self-wire', () => {
    addTiles([makeTile({ id: 'a', type: 'terminal' })]);
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish('a');
    expect(useCanvasStore.getState().wires[PID]?.length ?? 0).toBe(0);
  });

  it('finish() with non-existent tile does not crash or create wire', () => {
    addTiles([makeTile({ id: 'a', type: 'terminal' })]);
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish('ghost-tile');
    expect(useCanvasStore.getState().wires[PID]?.length ?? 0).toBe(0);
    expect(useWiringStore.getState().dragging).toBe(false);
  });
});

// ─── Wire type inference ────────────────────────────────

describe('wire type inference (drag drop combinations)', () => {
  beforeEach(resetStores);

  const cases: Array<[Tile['type'], Tile['type'], string]> = [
    ['agent',    'agent',   'agent-chain'],
    ['agent',    'browser', 'refresh-trigger'],
    ['agent',    'todo',    'task-assign'],
    ['agent',    'diff',    'diff-feed'],
    ['terminal', 'agent',   'context-pipe'],
    ['runner',   'agent',   'context-pipe'],
    ['terminal', 'browser', 'context-pipe'],
    ['runner',   'todo',    'context-pipe'],
  ];

  for (const [from, to, expected] of cases) {
    it(`${from} → ${to} creates a ${expected} wire`, () => {
      const fromTile = makeTile({ id: 'from', type: from });
      const toTile = makeTile({ id: 'to', type: to, x: 500 });
      addTiles([fromTile, toTile]);

      useWiringStore.getState().start('from', 0, 0);
      useWiringStore.getState().finish('to');

      const wires = useCanvasStore.getState().wires[PID] ?? [];
      expect(wires).toHaveLength(1);
      expect(wires[0].wireType).toBe(expected);
      expect(wires[0].fromTile).toBe('from');
      expect(wires[0].toTile).toBe('to');
      expect(wires[0].active).toBe(false);
    });
  }
});

// ─── Duplicate prevention ───────────────────────────────

describe('wire deduplication', () => {
  beforeEach(resetStores);

  it('creating the same wire twice only persists one', () => {
    addTiles([
      makeTile({ id: 'a', type: 'terminal' }),
      makeTile({ id: 'b', type: 'agent', x: 500 }),
    ]);

    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish('b');
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish('b');

    const wires = useCanvasStore.getState().wires[PID] ?? [];
    expect(wires).toHaveLength(1);
  });

  it('opposite direction (b → a) creates a separate wire', () => {
    addTiles([
      makeTile({ id: 'a', type: 'agent' }),
      makeTile({ id: 'b', type: 'agent', x: 500 }),
    ]);

    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().finish('b');
    useWiringStore.getState().start('b', 0, 0);
    useWiringStore.getState().finish('a');

    const wires = useCanvasStore.getState().wires[PID] ?? [];
    expect(wires).toHaveLength(2);
  });
});

// ─── Wire persistence & removal ─────────────────────────

describe('canvasStore wire CRUD', () => {
  beforeEach(resetStores);

  it('addWire persists to activeProject key', () => {
    useCanvasStore.getState().addWire({
      id: 'w1', fromTile: 'a', fromPort: 'output',
      toTile: 'b', toPort: 'input',
      wireType: 'context-pipe', active: false,
    });
    expect(useCanvasStore.getState().wires[PID]).toHaveLength(1);
  });

  it('removeWire drops only the matching wire', () => {
    const c = useCanvasStore.getState();
    c.addWire({ id: 'w1', fromTile: 'a', fromPort: 'output', toTile: 'b', toPort: 'input', wireType: 'context-pipe', active: false });
    c.addWire({ id: 'w2', fromTile: 'b', fromPort: 'output', toTile: 'c', toPort: 'input', wireType: 'agent-chain', active: false });
    c.removeWire('w1');
    const wires = useCanvasStore.getState().wires[PID] ?? [];
    expect(wires).toHaveLength(1);
    expect(wires[0].id).toBe('w2');
  });

  it('setWireActive toggles the active flag (for UI pulse)', () => {
    useCanvasStore.getState().addWire({
      id: 'w1', fromTile: 'a', fromPort: 'output',
      toTile: 'b', toPort: 'input',
      wireType: 'context-pipe', active: false,
    });
    useCanvasStore.getState().setWireActive('w1', true);
    expect(useCanvasStore.getState().wires[PID]?.[0].active).toBe(true);
    useCanvasStore.getState().setWireActive('w1', false);
    expect(useCanvasStore.getState().wires[PID]?.[0].active).toBe(false);
  });

  it('removing a tile deletes wires connected to it', () => {
    addTiles([
      makeTile({ id: 'a', type: 'terminal' }),
      makeTile({ id: 'b', type: 'agent' }),
    ]);
    useCanvasStore.getState().addWire({
      id: 'w1', fromTile: 'a', fromPort: 'output',
      toTile: 'b', toPort: 'input',
      wireType: 'context-pipe', active: false,
    });
    useCanvasStore.getState().removeTile('a');
    expect(useCanvasStore.getState().wires[PID]).toHaveLength(0);
  });
});

// ─── Project isolation ──────────────────────────────────

describe('wires are scoped to projects', () => {
  it('wires in project A do not appear in project B', () => {
    resetStores();
    useCanvasStore.setState({ activeProject: 'proj-a' });
    useCanvasStore.getState().addWire({
      id: 'w1', fromTile: 'x', fromPort: 'output',
      toTile: 'y', toPort: 'input',
      wireType: 'context-pipe', active: false,
    });
    useCanvasStore.setState({ activeProject: 'proj-b' });
    useCanvasStore.getState().addWire({
      id: 'w2', fromTile: 'p', fromPort: 'output',
      toTile: 'q', toPort: 'input',
      wireType: 'agent-chain', active: false,
    });

    expect(useCanvasStore.getState().wires['proj-a']).toHaveLength(1);
    expect(useCanvasStore.getState().wires['proj-b']).toHaveLength(1);
    expect(useCanvasStore.getState().wires['proj-a']?.[0].id).toBe('w1');
    expect(useCanvasStore.getState().wires['proj-b']?.[0].id).toBe('w2');
  });
});

// ─── Wire data bus (context-pipe plumbing) ──────────────

describe('wire data bus — appendWireData', () => {
  beforeEach(resetStores);

  it('accumulates output keyed by tileId/ptyId', async () => {
    useCanvasStore.getState().appendWireData('pty-1', 'hello ');
    useCanvasStore.getState().appendWireData('pty-1', 'world');
    // 200ms debounce flush
    await new Promise(r => setTimeout(r, 250));
    expect(useCanvasStore.getState().wireData['pty-1']).toBe('hello world');
  });

  it('keeps last 50 lines on overflow', async () => {
    const big = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    useCanvasStore.getState().appendWireData('pty-1', big);
    await new Promise(r => setTimeout(r, 250));
    const data = useCanvasStore.getState().wireData['pty-1'] || '';
    const lines = data.split('\n');
    expect(lines.length).toBeLessThanOrEqual(50);
    expect(lines[lines.length - 1]).toBe('line59');
  });

  it('getWireDataForTile returns the current buffer', async () => {
    useCanvasStore.getState().appendWireData('pty-x', 'test output');
    await new Promise(r => setTimeout(r, 250));
    expect(useCanvasStore.getState().getWireDataForTile('pty-x')).toBe('test output');
  });
});

// ─── Defensive behavior ─────────────────────────────────

describe('defensive checks', () => {
  beforeEach(resetStores);

  it('finish() with no prior start does not crash', () => {
    expect(() => useWiringStore.getState().finish('any-id')).not.toThrow();
  });

  it('moveCursor without start has no effect', () => {
    useWiringStore.getState().moveCursor(999, 999);
    expect(useWiringStore.getState().cursorX).toBe(0);
  });

  it('start → cancel → start again works', () => {
    addTiles([
      makeTile({ id: 'a', type: 'terminal' }),
      makeTile({ id: 'b', type: 'agent', x: 500 }),
    ]);
    useWiringStore.getState().start('a', 0, 0);
    useWiringStore.getState().cancel();
    useWiringStore.getState().start('a', 10, 20);
    useWiringStore.getState().finish('b');
    expect(useCanvasStore.getState().wires[PID]).toHaveLength(1);
  });
});
