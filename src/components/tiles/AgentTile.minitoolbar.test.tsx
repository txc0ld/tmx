import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

// ─── Mocks ──────────────────────────────────────────────────────────
// themeStore reads localStorage at module init; happy-dom's stub doesn't
// expose getItem. Mock to the minimal surface AgentTile uses.
vi.mock('@/stores/themeStore', () => {
  const theme = { id: 'mocha', name: 'Mocha', bg: '#1e1e2e', fg: '#cdd6f4', accent: '#cba6f7' };
  return {
    useThemeStore: Object.assign(
      () => theme,
      {
        getState: () => ({ getActiveTheme: () => theme }),
        subscribe: (_fn: () => void) => () => {},
      },
    ),
  };
});

// xterm: capture clear() + provide a buffer scrollback iterable so the
// Copy handler has something to read.
const clearMock = vi.fn();
const writeMock = vi.fn();
const scrollLines = ['hello world', 'second line', ''];

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) { this.options = opts; }
    get cols() { return 92; }
    get rows() { return 40; }
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    write = writeMock;
    scrollToBottom = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
    clear = clearMock;
    buffer = {
      active: {
        get length() { return scrollLines.length; },
        getLine: (i: number) => ({
          translateToString: (_trim: boolean) => scrollLines[i] ?? '',
        }),
      },
    };
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon { fit = vi.fn(); }
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('./xtermInput', () => ({
  attachKeyboardCapture: vi.fn(() => () => {}),
}));

// IPC mock — captures ptyKill + agentSpawn so we can verify the
// Kill / Restart sequencing.
vi.mock('@/utils/ipc', () => ({
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  // agentSpawn never resolves so post-spawn awaits don't fire during the test.
  agentSpawn: vi.fn(() => new Promise(() => {})),
  agentKill: vi.fn().mockResolvedValue(undefined),
  onPtyOutput: vi.fn().mockResolvedValue(() => {}),
  onPtyExit: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

import { ptyKill, agentSpawn } from '@/utils/ipc';
import { AgentTile } from './AgentTile';
import { useCanvasStore } from '@/stores/canvasStore';
import { useToastStore } from '@/stores/toastStore';
import type { AgentTile as AgentTileType } from '@/types';

const mockPtyKill = vi.mocked(ptyKill);
const mockAgentSpawn = vi.mocked(agentSpawn);

function makeTile(over: Partial<AgentTileType> = {}): AgentTileType {
  return {
    id: 'tile-mt-1',
    type: 'agent',
    x: 0, y: 0, w: 720, h: 480,
    title: 'Builder',
    agent: 'claude',
    model: 'opus-4-7',
    effort: '',
    mode: '',
    version: '',
    cwd: '/tmp',
    branch: '',
    status: 'working',
    elapsed: 0,
    ptyId: 'pty-mt-1',
    ...over,
  };
}

// Seed the canvas store so spawn-effect lookups (activeProject + tiles)
// don't fight us. Each test puts the tile under its own project.
function seedStore(tile: AgentTileType, projectId: string) {
  useCanvasStore.setState((s) => ({
    activeProject: projectId,
    transforms: { ...s.transforms, [projectId]: { x: 0, y: 0, scale: 1 } },
    tiles: { ...s.tiles, [projectId]: [tile] },
  }));
}

describe('AgentTile mini-toolbar', () => {
  beforeEach(() => {
    mockPtyKill.mockClear();
    mockAgentSpawn.mockClear();
    clearMock.mockClear();
    writeMock.mockClear();
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Kill / Restart / Copy / Clear buttons', () => {
    const tile = makeTile();
    seedStore(tile, 'proj-mt-render');
    render(<AgentTile tile={tile} />);

    expect(screen.getByText('Kill')).toBeTruthy();
    expect(screen.getByText('Restart')).toBeTruthy();
    expect(screen.getByLabelText('Copy output')).toBeTruthy();
    expect(screen.getByLabelText('Clear output')).toBeTruthy();
  });

  it('Kill confirm flow calls ptyKill on second click', () => {
    const tile = makeTile();
    seedStore(tile, 'proj-mt-kill');
    render(<AgentTile tile={tile} />);

    const killBtn = screen.getByText('Kill').closest('button')!;
    fireEvent.click(killBtn);
    expect(mockPtyKill).not.toHaveBeenCalled();
    // Second click consumes the confirm window.
    fireEvent.click(killBtn);
    expect(mockPtyKill).toHaveBeenCalledTimes(1);
    expect(mockPtyKill).toHaveBeenCalledWith('pty-mt-1');
  });

  it('Restart calls ptyKill then re-spawns (kill, then a fresh agentSpawn)', async () => {
    const tile = makeTile();
    seedStore(tile, 'proj-mt-restart');
    const { rerender } = render(<AgentTile tile={tile} />);

    // First mount triggers spawn (because the spawnedRef gate releases on
    // the initial render). Drain microtasks then clear so we only count
    // the post-restart spawn.
    await act(async () => { await Promise.resolve(); });
    mockAgentSpawn.mockClear();

    const restartBtn = screen.getByText('Restart').closest('button')!;
    fireEvent.click(restartBtn);
    fireEvent.click(restartBtn);

    // Allow the kill promise to settle so the store update lands.
    await act(async () => { await Promise.resolve(); });

    expect(mockPtyKill).toHaveBeenCalledWith('pty-mt-1');

    // Restart cleared ptyId on the tile in the store. Re-render with the
    // updated tile (mirrors what the parent canvas does on store update)
    // so the spawn effect sees the released ptyId guard.
    const updated = useCanvasStore.getState().tiles['proj-mt-restart'][0] as AgentTileType;
    expect(updated.ptyId).toBeUndefined();
    rerender(<AgentTile tile={updated} />);
    await act(async () => { await Promise.resolve(); });

    // Sequence: ptyKill happened first, agentSpawn fired after — both
    // were called, and ptyKill recorded its call before agentSpawn.
    expect(mockAgentSpawn).toHaveBeenCalledTimes(1);
    const killOrder = mockPtyKill.mock.invocationCallOrder[0];
    const spawnOrder = mockAgentSpawn.mock.invocationCallOrder[0];
    expect(killOrder).toBeLessThan(spawnOrder);
  });

  it('Copy writes the xterm scrollback to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const tile = makeTile();
    seedStore(tile, 'proj-mt-copy');
    render(<AgentTile tile={tile} />);

    const copyBtn = screen.getByLabelText('Copy output');
    await act(async () => { fireEvent.click(copyBtn); });
    // Drain the writeText promise.
    await act(async () => { await Promise.resolve(); });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('hello world');
    expect(writeText.mock.calls[0][0]).toContain('second line');
  });

  it('Clear calls terminal.clear()', () => {
    const tile = makeTile();
    seedStore(tile, 'proj-mt-clear');
    render(<AgentTile tile={tile} />);

    const clearBtn = screen.getByLabelText('Clear output');
    fireEvent.click(clearBtn);
    expect(clearMock).toHaveBeenCalledTimes(1);
  });

  it('shows the [Pipeline] warning prefix on Kill / Restart tooltips for pipeline tiles', () => {
    const tile = makeTile({ pipelineRunId: 'run-xyz' });
    seedStore(tile, 'proj-mt-pipeline');
    render(<AgentTile tile={tile} />);

    const killBtn = screen.getByText('Kill').closest('button')!;
    const restartBtn = screen.getByText('Restart').closest('button')!;
    expect(killBtn.getAttribute('title')).toContain('[Pipeline] Killing this agent will mark the run as failed');
    expect(restartBtn.getAttribute('title')).toContain('[Pipeline] Killing this agent will mark the run as failed');
  });

  it('does NOT show the [Pipeline] warning for stand-alone agent tiles', () => {
    const tile = makeTile();
    seedStore(tile, 'proj-mt-nonpipeline');
    render(<AgentTile tile={tile} />);

    const killBtn = screen.getByText('Kill').closest('button')!;
    expect(killBtn.getAttribute('title') ?? '').not.toContain('[Pipeline]');
  });
});
