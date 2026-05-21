import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// themeStore.ts reads localStorage at module init; happy-dom's stub
// doesn't expose getItem. Mock the whole store with a minimal surface
// since AgentTile only consumes `getActiveTheme()` + `subscribe()`.
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

// ─── Mocks ──────────────────────────────────────────────────────────
// xterm + FitAddon: stub out the heavy DOM/terminal setup; expose
// controllable `cols`/`rows` so the zoom-refit useEffect can read sane
// numbers off termRef when fit() runs.
let currentCols = 92;
let currentRows = 40;

const fitMock = vi.fn(() => {
  // fit() in real xterm reflows based on container size; for the test
  // we just leave currentCols/Rows as the test set them.
});

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) { this.options = opts; }
    get cols() { return currentCols; }
    get rows() { return currentRows; }
    loadAddon = vi.fn();
    open = vi.fn();
    onData = vi.fn();
    write = vi.fn();
    scrollToBottom = vi.fn();
    dispose = vi.fn();
    focus = vi.fn();
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    fit = fitMock;
  }
  return { FitAddon: MockFitAddon };
});

// xterm.css side-effect import
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Keyboard capture is wired against a real container in production; we
// don't exercise it here.
vi.mock('./xtermInput', () => ({
  attachKeyboardCapture: vi.fn(() => () => {}),
}));

// IPC layer: capture ptyResize calls. agentSpawn never resolves so the
// post-spawn ptyResize branch in AgentTile doesn't race the test.
vi.mock('@/utils/ipc', () => ({
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  agentSpawn: vi.fn(() => new Promise(() => {})), // never resolves
  agentKill: vi.fn().mockResolvedValue(undefined),
  onPtyOutput: vi.fn().mockResolvedValue(() => {}),
  onPtyExit: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

import { ptyResize } from '@/utils/ipc';
import { AgentTile } from './AgentTile';
import { useCanvasStore } from '@/stores/canvasStore';
import type { AgentTile as AgentTileType, CanvasTransform } from '@/types';

const mockPtyResize = vi.mocked(ptyResize);

function makeTile(over: Partial<AgentTileType> = {}): AgentTileType {
  return {
    id: 'tile-zoom-1',
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
    ptyId: 'pty-zoom-1',
    ...over,
  };
}

function setTransform(scale: number, projectId = 'proj-zoom') {
  const t: CanvasTransform = { x: 0, y: 0, scale };
  useCanvasStore.setState((s) => ({
    activeProject: projectId,
    transforms: { ...s.transforms, [projectId]: t },
  }));
}

describe('AgentTile zoom-refit', () => {
  beforeEach(() => {
    mockPtyResize.mockClear();
    fitMock.mockClear();
    currentCols = 92;
    currentRows = 40;
    // Anchor the store so the subscriber's lastScale baseline is known.
    useCanvasStore.setState({
      activeProject: 'proj-zoom',
      transforms: { 'proj-zoom': { x: 0, y: 0, scale: 1 } },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires ptyResize once after the 120ms debounce when scale changes', async () => {
    render(<AgentTile tile={makeTile()} />);
    // Drain the spawn-effect promise queue (agentSpawn never resolves so
    // its post-spawn ptyResize path is dormant — any later ptyResize call
    // must come from the zoom-refit subscriber).
    await act(async () => { await Promise.resolve(); });

    mockPtyResize.mockClear();

    act(() => { setTransform(0.5); });
    // Before the debounce fires, no call yet.
    expect(mockPtyResize).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(120); });

    expect(mockPtyResize).toHaveBeenCalledTimes(1);
    expect(mockPtyResize).toHaveBeenCalledWith('pty-zoom-1', 92, 40);
  });

  it('coalesces rapid scale changes within the debounce window into one call', async () => {
    render(<AgentTile tile={makeTile()} />);
    await act(async () => { await Promise.resolve(); });
    mockPtyResize.mockClear();

    act(() => { setTransform(0.9); });
    await act(async () => { vi.advanceTimersByTime(40); });
    act(() => { setTransform(0.7); });
    await act(async () => { vi.advanceTimersByTime(40); });
    // Final scale change before debounce fires — bumps cols/rows so we
    // can verify last-value-wins.
    currentCols = 60;
    currentRows = 30;
    act(() => { setTransform(0.4); });
    await act(async () => { vi.advanceTimersByTime(120); });

    expect(mockPtyResize).toHaveBeenCalledTimes(1);
    expect(mockPtyResize).toHaveBeenCalledWith('pty-zoom-1', 60, 30);
  });

  it('does not call ptyResize when tile.ptyId is undefined', async () => {
    render(<AgentTile tile={makeTile({ ptyId: undefined })} />);
    await act(async () => { await Promise.resolve(); });
    mockPtyResize.mockClear();

    act(() => { setTransform(0.5); });
    await act(async () => { vi.advanceTimersByTime(120); });

    expect(mockPtyResize).not.toHaveBeenCalled();
  });

  it('skips resize when xterm reports cols=0 / rows=0 (terminal not ready)', async () => {
    render(<AgentTile tile={makeTile()} />);
    await act(async () => { await Promise.resolve(); });
    mockPtyResize.mockClear();

    currentCols = 0;
    currentRows = 0;
    act(() => { setTransform(0.5); });
    await act(async () => { vi.advanceTimersByTime(120); });

    expect(mockPtyResize).not.toHaveBeenCalled();
  });

  it('does not fire on no-op transform writes (same scale)', async () => {
    render(<AgentTile tile={makeTile()} />);
    await act(async () => { await Promise.resolve(); });
    mockPtyResize.mockClear();

    // setState that doesn't change scale should be a no-op for the subscriber.
    act(() => {
      useCanvasStore.setState((s) => ({
        transforms: { ...s.transforms, 'proj-zoom': { x: 50, y: 50, scale: 1 } },
      }));
    });
    await act(async () => { vi.advanceTimersByTime(120); });

    expect(mockPtyResize).not.toHaveBeenCalled();
  });
});
