import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCanvasStore } from '@/stores/canvasStore';
import { useWiringEngine } from '@/hooks/useWiringEngine';
import { useToastStore } from '@/stores/toastStore';
import { ptyWrite } from '@/utils/ipc';
import type { Tile, Wire } from '@/types';

vi.mock('@/utils/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/utils/ipc')>('@/utils/ipc');
  return { ...actual, ptyWrite: vi.fn().mockResolvedValue(undefined) };
});

const PID = 'engine-test';

function reset() {
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
  useToastStore.setState({ toasts: [] });
  vi.clearAllMocks();
}

function setup(tiles: Tile[], wires: Wire[], wireData: Record<string, string> = {}) {
  useCanvasStore.setState({
    tiles: { [PID]: tiles },
    wires: { [PID]: wires },
    wireData,
  });
}

function setAgentStatus(tileId: string, status: string) {
  useCanvasStore.setState(s => {
    const tiles = s.tiles[PID] || [];
    return {
      tiles: {
        ...s.tiles,
        [PID]: tiles.map(t => t.id === tileId ? { ...t, status } as Tile : t),
      },
    };
  });
}

async function flushAsyncTimers() {
  // Let the subscription callbacks + debounced buffer fire
  await new Promise(r => setTimeout(r, 300));
}

describe('useWiringEngine — runtime behavior per wire type', () => {
  beforeEach(reset);

  it('agent-chain: writes source output to target PTY when source agent completes', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const sourceAgent = {
      id: 'agent-a', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-a',
      title: 'Designer',
    };
    const targetAgent = { ...sourceAgent, id: 'agent-b', x: 500, ptyId: 'pty-b', title: 'Builder' };

    setup(
      [sourceAgent, targetAgent],
      [{
        id: 'wire-1',
        fromTile: 'agent-a', fromPort: 'output',
        toTile: 'agent-b', toPort: 'input',
        wireType: 'agent-chain', active: false,
      }],
      { 'pty-a': 'line 1\nline 2\nfinal output' },
    );

    // Status transition working → done triggers the handler
    setAgentStatus('agent-a', 'done');
    await flushAsyncTimers();

    expect(ptyWrite).toHaveBeenCalled();
    const [targetPty, payload] = (ptyWrite as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(targetPty).toBe('pty-b');
    expect(payload).toContain('final output');
    expect(payload).toContain('Context from previous agent');

    unmount();
  });

  it('task-assign: adds last output line as todo item when source agent completes', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const agent = {
      id: 'agent-x', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-x',
      title: 'Planner',
    };
    const todo = {
      id: 'todo-1', type: 'todo' as const, x: 500, y: 0, w: 300, h: 400,
      items: [],
    };

    setup(
      [agent, todo],
      [{
        id: 'w1', fromTile: 'agent-x', fromPort: 'output',
        toTile: 'todo-1', toPort: 'input',
        wireType: 'task-assign', active: false,
      }],
      { 'pty-x': 'doing stuff\nTODO: migrate user sessions' },
    );

    setAgentStatus('agent-x', 'done');
    await flushAsyncTimers();

    interface TodoResult { items: Array<{ id: string; text: string; done: boolean; assignedAgent?: string }> }
    const updatedTodo = useCanvasStore.getState().tiles[PID]?.find(t => t.id === 'todo-1') as unknown as TodoResult;
    expect(updatedTodo.items).toHaveLength(1);
    expect(updatedTodo.items[0].text).toContain('TODO: migrate user sessions');
    expect(updatedTodo.items[0].assignedAgent).toBe('Planner');

    unmount();
  });

  it('refresh-trigger: emits a toast when source agent completes', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const agent = {
      id: 'agent-ref', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-ref',
    };
    const browser = {
      id: 'browser-1', type: 'browser' as const, x: 500, y: 0, w: 600, h: 500,
      url: 'http://localhost:3000',
      title: 'App preview',
    };

    setup(
      [agent, browser],
      [{ id: 'w1', fromTile: 'agent-ref', fromPort: 'output', toTile: 'browser-1', toPort: 'input', wireType: 'refresh-trigger', active: false }],
    );

    setAgentStatus('agent-ref', 'done');
    await flushAsyncTimers();

    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBeGreaterThan(0);
    expect(toasts.some(t => t.message.includes('refresh'))).toBe(true);

    unmount();
  });

  it('diff-feed: emits a toast when source agent completes', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const agent = {
      id: 'agent-d', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-d',
    };
    const diff = {
      id: 'diff-1', type: 'diff' as const, x: 500, y: 0, w: 600, h: 400,
      filePath: 'src/app.ts', hunks: [], comments: [], title: 'Changes',
    };

    setup(
      [agent, diff],
      [{ id: 'w1', fromTile: 'agent-d', fromPort: 'output', toTile: 'diff-1', toPort: 'input', wireType: 'diff-feed', active: false }],
    );

    setAgentStatus('agent-d', 'done');
    await flushAsyncTimers();

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some(t => t.message.toLowerCase().includes('diff'))).toBe(true);

    unmount();
  });

  it('context-pipe (agent→agent): pipes output to target PTY on completion', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const srcAgent = {
      id: 'src', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-src',
      title: 'Src',
    };
    const dstAgent = { ...srcAgent, id: 'dst', x: 500, ptyId: 'pty-dst', title: 'Dst' };

    setup(
      [srcAgent, dstAgent],
      [{ id: 'w1', fromTile: 'src', fromPort: 'output', toTile: 'dst', toPort: 'input', wireType: 'context-pipe', active: false }],
      { 'pty-src': 'hello world' },
    );

    setAgentStatus('src', 'done');
    await flushAsyncTimers();

    expect(ptyWrite).toHaveBeenCalled();
    const calls = (ptyWrite as ReturnType<typeof vi.fn>).mock.calls;
    const matching = calls.find(c => c[0] === 'pty-dst');
    expect(matching).toBeDefined();
    expect(matching![1]).toContain('hello world');

    unmount();
  });

  it('wire.active flips true when triggered, then back to false after timer', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const agent = {
      id: 'a', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0, ptyId: 'pty-a',
    };
    const browser = {
      id: 'b', type: 'browser' as const, x: 500, y: 0, w: 600, h: 500,
      url: 'http://localhost:3000',
    };

    setup([agent, browser], [{
      id: 'wire-1',
      fromTile: 'a', fromPort: 'output',
      toTile: 'b', toPort: 'input',
      wireType: 'refresh-trigger', active: false,
    }]);

    setAgentStatus('a', 'done');
    await new Promise(r => setTimeout(r, 100));
    expect(useCanvasStore.getState().wires[PID]?.[0].active).toBe(true);

    // Refresh-trigger deactivates after 2s; verify eventually it goes back to false
    await new Promise(r => setTimeout(r, 2100));
    expect(useCanvasStore.getState().wires[PID]?.[0].active).toBe(false);

    unmount();
  });

  it('does not fire when source did not actually transition to done', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const srcAgent = {
      id: 'src', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'done' as const, elapsed: 0, ptyId: 'pty-src',
    };
    const dstAgent = { ...srcAgent, id: 'dst', x: 500, ptyId: 'pty-dst' };

    setup([srcAgent, dstAgent], [{
      id: 'w1', fromTile: 'src', fromPort: 'output',
      toTile: 'dst', toPort: 'input',
      wireType: 'agent-chain', active: false,
    }]);

    // Source was already done — no transition
    setAgentStatus('src', 'done');
    await flushAsyncTimers();
    expect(ptyWrite).not.toHaveBeenCalled();

    unmount();
  });

  it('tolerates missing ptyIds (source never spawned a PTY)', async () => {
    const { unmount } = renderHook(() => useWiringEngine());

    const srcAgent = {
      id: 'src', type: 'agent' as const, x: 0, y: 0, w: 400, h: 300,
      agent: 'claude' as const, model: 'opus-4', effort: 'high', mode: 'code', version: '',
      cwd: '~', branch: '', status: 'working' as const, elapsed: 0,
      // no ptyId
    };
    const todo = { id: 'todo-1', type: 'todo' as const, x: 500, y: 0, w: 300, h: 400, items: [] };

    setup([srcAgent, todo], [{
      id: 'w1', fromTile: 'src', fromPort: 'output',
      toTile: 'todo-1', toPort: 'input',
      wireType: 'task-assign', active: false,
    }]);

    // Should not crash
    expect(() => setAgentStatus('src', 'done')).not.toThrow();
    await flushAsyncTimers();

    unmount();
  });
});
