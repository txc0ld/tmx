import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

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

// xterm + FitAddon stubs (mirrors AgentTile.zoom-refit.test.tsx)
vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {};
    constructor(opts: Record<string, unknown>) { this.options = opts; }
    get cols() { return 92; }
    get rows() { return 40; }
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
  class MockFitAddon { fit = vi.fn(); }
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('./xtermInput', () => ({
  attachKeyboardCapture: vi.fn(() => () => {}),
}));

// IPC mock: capture agentSpawn opts. Returns a never-resolving promise so
// the post-spawn await chain doesn't fire during the test.
vi.mock('@/utils/ipc', () => ({
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  agentSpawn: vi.fn(() => new Promise(() => {})),
  agentKill: vi.fn().mockResolvedValue(undefined),
  onPtyOutput: vi.fn().mockResolvedValue(() => {}),
  onPtyExit: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

import { agentSpawn } from '@/utils/ipc';
import { AgentTile } from './AgentTile';
import { useCanvasStore } from '@/stores/canvasStore';
import type { AgentTile as AgentTileType } from '@/types';

const mockAgentSpawn = vi.mocked(agentSpawn);

function makeTile(over: Partial<AgentTileType> = {}): AgentTileType {
  return {
    id: 'tile-skip-1',
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
    status: 'spawning',
    elapsed: 0,
    ...over,
  };
}

describe('AgentTile pipelineRun wiring', () => {
  beforeEach(() => {
    mockAgentSpawn.mockClear();
    useCanvasStore.setState({
      activeProject: 'proj-skip',
      transforms: { 'proj-skip': { x: 0, y: 0, scale: 1 } },
    });
  });

  it('passes pipelineRun: true when tile.pipelineRunId is set', async () => {
    render(<AgentTile tile={makeTile({ pipelineRunId: 'run-abc', pipelineRole: 'builder' })} />);
    // Drain the spawn-effect microtask queue.
    await act(async () => { await Promise.resolve(); });

    expect(mockAgentSpawn).toHaveBeenCalledTimes(1);
    const opts = mockAgentSpawn.mock.calls[0][0];
    expect(opts.pipelineRun).toBe(true);
  });

  it('omits pipelineRun for stand-alone (manual) agent tiles', async () => {
    render(<AgentTile tile={makeTile()} />);
    await act(async () => { await Promise.resolve(); });

    expect(mockAgentSpawn).toHaveBeenCalledTimes(1);
    const opts = mockAgentSpawn.mock.calls[0][0];
    // Critical: a manual agent tile must NOT bypass the interactive
    // tool-permission prompt. The flag must be absent (or explicitly false).
    expect(opts.pipelineRun).toBeFalsy();
  });
});
