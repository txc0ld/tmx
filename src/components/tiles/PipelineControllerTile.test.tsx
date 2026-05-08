import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
  waitFor,
} from '@testing-library/react';

// Mock the IPC module BEFORE the component import so the component picks
// up the spies. Other tests in the file don't use these — they only
// fire when the user clicks the Delete-worktree button.
vi.mock('@/utils/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/utils/ipc')>('@/utils/ipc');
  return {
    ...actual,
    pipelineWorktreeDestroy: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
  };
});

import { PipelineControllerTile } from './PipelineControllerTile';
import { usePipelineStore } from '@/stores/pipelineStore';
import { useProjectStore } from '@/stores/projectStore';
import { pipelineWorktreeDestroy, deleteFile } from '@/utils/ipc';
import type {
  PipelineRun,
  PipelineControllerTile as TileT,
} from '@/types';

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-abort-1',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt/run-abort-1',
    branch: 'feat/r-abort',
    baseBranch: 'main',
    state: 'planning',
    artifacts: {
      builds: [],
      reviews: [],
      ciResults: [],
      questions: [],
      redTeamReports: [],
    },
    retryCounters: { reviewerReject: 0, ciFail: 0 },
    startedAt: 1,
    escalationLog: [],
    tiles: {},
    fingerprint: {
      templateId: 'tmpl-anth-trio',
      templateHash: 'h',
      skillHashes: {},
      rolePromptHashes: {},
      models: {},
      capabilityManifests: {},
      terminalxVersion: '0.1.0',
    },
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3 },
    templateDualReviewer: false,
    ...overrides,
  };
}

function makeTile(runId: string): TileT {
  return {
    id: 'tile-pc-1',
    type: 'pipeline-controller',
    x: 0,
    y: 0,
    w: 600,
    h: 300,
    runId,
  };
}

function seedStores(run: PipelineRun) {
  usePipelineStore.setState({ runs: { [run.id]: run }, activeRunIds: [run.id] });
  useProjectStore.setState({
    projects: [
      {
        id: 'proj-1',
        name: 'Test',
        icon: '',
        color: '',
        description: '',
        cwd: '/tmp/proj-1',
      },
    ],
    active: 'proj-1',
    loading: false,
    cloning: false,
  } as ReturnType<typeof useProjectStore.getState>);
}

function resetStores() {
  usePipelineStore.setState({ runs: {}, activeRunIds: [] });
}

describe('PipelineControllerTile — Abort confirmation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
  });
  afterEach(() => {
    cleanup();
    resetStores();
    vi.useRealTimers();
  });

  it('first click on Abort does not dispatch; second click within 4s dispatches', () => {
    const run = makeRun();
    seedStores(run);
    const dispatch = vi.fn();
    // Spy via store override so the component's useStore picks it up.
    usePipelineStore.setState({ dispatch });

    render(<PipelineControllerTile tile={makeTile(run.id)} />);

    // Find the Abort button — the only one with that label initially.
    const btn = screen.getByRole('button', { name: /^Abort$/ });
    fireEvent.click(btn);
    expect(dispatch).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Confirm abort?');

    // Second click within window dispatches exactly once with the
    // exact event the state-machine expects.
    fireEvent.click(btn);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(run.id, {
      type: 'abort',
      reason: 'user clicked abort',
    });
  });

  it('confirm window times out after 4s; the next click is treated as a fresh first-click', () => {
    const run = makeRun();
    seedStores(run);
    const dispatch = vi.fn();
    usePipelineStore.setState({ dispatch });

    render(<PipelineControllerTile tile={makeTile(run.id)} />);
    const btn = screen.getByRole('button', { name: /^Abort$/ });
    fireEvent.click(btn);
    expect(btn.textContent).toContain('Confirm abort?');
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(btn.textContent).toBe('Abort');
    fireEvent.click(btn);
    // Still the first click of a fresh window — no dispatch yet.
    expect(dispatch).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Confirm abort?');
  });

  it('Clear button on terminal-state runs requires confirmation before removeRun', () => {
    const run = makeRun({ state: 'failed' });
    seedStores(run);
    const removeRun = vi.fn();
    usePipelineStore.setState({ removeRun });

    render(<PipelineControllerTile tile={makeTile(run.id)} />);
    const btn = screen.getByRole('button', { name: /^Clear$/ });
    fireEvent.click(btn);
    expect(removeRun).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Confirm clear?');
    fireEvent.click(btn);
    expect(removeRun).toHaveBeenCalledTimes(1);
    expect(removeRun).toHaveBeenCalledWith(run.id);
  });
});

// Real-timers block: the delete flow is async and we wait for promises to
// settle, so fake timers would just hang waitFor.
describe('PipelineControllerTile — Delete worktree', () => {
  beforeEach(() => {
    resetStores();
    vi.mocked(pipelineWorktreeDestroy).mockReset().mockResolvedValue(undefined);
    vi.mocked(deleteFile).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('is hidden while the run is in a non-terminal state', () => {
    const run = makeRun({ state: 'planning' });
    seedStores(run);
    render(<PipelineControllerTile tile={makeTile(run.id)} />);
    expect(screen.queryByRole('button', { name: /Delete worktree/i })).toBeNull();
  });

  it('appears on terminal states (done/failed/escalated)', () => {
    for (const state of ['done', 'failed', 'escalated'] as const) {
      const run = makeRun({ id: `run-del-${state}`, state });
      seedStores(run);
      render(<PipelineControllerTile tile={makeTile(run.id)} />);
      expect(
        screen.getByRole('button', { name: /Delete worktree/i }),
      ).toBeTruthy();
      cleanup();
      resetStores();
    }
  });

  it('two-click confirm then runs worktreeDestroy + deleteFile + removeRun', async () => {
    const run = makeRun({ state: 'failed' });
    seedStores(run);
    const removeRun = vi.fn();
    usePipelineStore.setState({ removeRun });

    render(<PipelineControllerTile tile={makeTile(run.id)} />);

    const btn = screen.getByRole('button', { name: /^Delete worktree$/ });

    // First click — confirm state, no IPC fired yet.
    fireEvent.click(btn);
    expect(pipelineWorktreeDestroy).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
    expect(removeRun).not.toHaveBeenCalled();
    expect(btn.textContent).toContain('Confirm delete worktree?');

    // Second click within window — fires the cleanup chain.
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(removeRun).toHaveBeenCalledTimes(1);
    });
    expect(pipelineWorktreeDestroy).toHaveBeenCalledTimes(1);
    expect(pipelineWorktreeDestroy).toHaveBeenCalledWith({
      projectDir: '/tmp/proj-1',
      worktreePath: run.worktreePath,
      branch: run.branch,
    });
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteFile).toHaveBeenCalledWith(
      `/tmp/proj-1/.terminalx/pipeline-runs/${run.id}.json`,
    );
    expect(removeRun).toHaveBeenCalledWith(run.id);
  });

  it('still calls removeRun + deleteFile when worktreeDestroy fails (so user can retry from clean state) and surfaces the error', async () => {
    const run = makeRun({ state: 'failed' });
    seedStores(run);
    const removeRun = vi.fn();
    usePipelineStore.setState({ removeRun });
    vi.mocked(pipelineWorktreeDestroy).mockRejectedValueOnce(
      new Error('git worktree busy'),
    );

    render(<PipelineControllerTile tile={makeTile(run.id)} />);
    const btn = screen.getByRole('button', { name: /^Delete worktree$/ });
    fireEvent.click(btn);
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(removeRun).toHaveBeenCalledTimes(1);
    });
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('git worktree busy');
  });
});
