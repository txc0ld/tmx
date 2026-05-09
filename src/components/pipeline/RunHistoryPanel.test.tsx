import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import type { PipelineRun, PipelineState } from '@/types';
import { RunHistoryPanel } from './RunHistoryPanel';

function makeRun(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: 'run-default',
    templateId: 'tmpl-anth-trio',
    projectId: 'proj-1',
    worktreePath: '/tmp/wt',
    branch: 'feat/x',
    baseBranch: 'main',
    state: 'idle' as PipelineState,
    artifacts: { builds: [], reviews: [], ciResults: [], questions: [], redTeamReports: [] },
    retryCounters: { reviewerReject: 0, ciFail: 0, planReject: 0 },
    startedAt: 1000,
    escalationLog: [],
    tiles: {},
    fingerprint: {
      templateId: 'tmpl-anth-trio',
      templateHash: 'h',
      skillHashes: {},
      rolePromptHashes: {},
      models: {},
      capabilityManifests: {},
      terminalxVersion: '0.0.0',
    },
    planLineage: [],
    runMode: 'standard',
    autoApprovePlan: false,
    useDualReviewer: false,
    runRedTeam: false,
    effectiveRetryBudgets: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    templateRetryBudget: { reviewerReject: 3, ciFail: 3, planReject: 3 },
    templateDualReviewer: false,
    ...over,
  };
}

function asMap(runs: PipelineRun[]): Record<string, PipelineRun> {
  const out: Record<string, PipelineRun> = {};
  for (const r of runs) out[r.id] = r;
  return out;
}

afterEach(() => cleanup());

describe('RunHistoryPanel', () => {
  it('renders the empty state when there are no runs for this project', () => {
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={{}}
        activeProjectId="proj-1"
      />,
    );
    expect(screen.getByTestId('run-history-empty').textContent).toContain('No runs yet');
  });

  it('shows runs sorted newest-first by startedAt', () => {
    const runs = asMap([
      makeRun({ id: 'old', branch: 'feat/old', startedAt: 100, state: 'done' }),
      makeRun({ id: 'mid', branch: 'feat/mid', startedAt: 500, state: 'done' }),
      makeRun({ id: 'new', branch: 'feat/new', startedAt: 900, state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute('data-runid')).toBe('new');
    expect(rows[1].getAttribute('data-runid')).toBe('mid');
    expect(rows[2].getAttribute('data-runid')).toBe('old');
  });

  it('filters to only awaiting runs when the Awaiting chip is toggled on', () => {
    const runs = asMap([
      makeRun({ id: 'wait', startedAt: 100, state: 'awaiting_plan_approval' }),
      makeRun({ id: 'done', startedAt: 200, state: 'done' }),
      makeRun({ id: 'fail', startedAt: 300, state: 'failed' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId('run-history-filter-awaiting'));
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('wait');
  });

  it('clicking a row calls onOpenLogs with the matching run', () => {
    const onOpenLogs = vi.fn();
    const target = makeRun({ id: 'pick-me', state: 'done' });
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={onOpenLogs}
        runs={asMap([target])}
        activeProjectId="proj-1"
      />,
    );
    const row = screen.getByTestId('run-history-row');
    fireEvent.click(row);
    expect(onOpenLogs).toHaveBeenCalledTimes(1);
    expect(onOpenLogs.mock.calls[0][0].id).toBe('pick-me');
  });

  it('only shows runs for the active project', () => {
    const runs = asMap([
      makeRun({ id: 'mine', projectId: 'proj-1', state: 'done' }),
      makeRun({ id: 'other', projectId: 'proj-2', state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('mine');
  });

  it('Escape closes the panel', () => {
    const onClose = vi.fn();
    render(
      <RunHistoryPanel
        onClose={onClose}
        onOpenLogs={vi.fn()}
        runs={{}}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies the awaiting/done/failed pill colors via the state-classification rules', () => {
    const runs = asMap([
      makeRun({ id: 'a', startedAt: 300, state: 'awaiting_merge_approval' }),
      makeRun({ id: 'd', startedAt: 200, state: 'done' }),
      makeRun({ id: 'f', startedAt: 100, state: 'failed' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const rows = screen.getAllByTestId('run-history-row');
    // Pills label by raw state — assert the label, color is style-only.
    expect(within(rows[0]).getByTestId('run-history-row-pill').textContent).toBe(
      'awaiting_merge_approval',
    );
    expect(within(rows[1]).getByTestId('run-history-row-pill').textContent).toBe('done');
    expect(within(rows[2]).getByTestId('run-history-row-pill').textContent).toBe('failed');
  });

  it('each row has a Re-run button that calls onRerun with the run (and does not call onOpenLogs)', () => {
    const onRerun = vi.fn();
    const onOpenLogs = vi.fn();
    const target = makeRun({ id: 'pick-rerun', state: 'failed' });
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={onOpenLogs}
        onRerun={onRerun}
        runs={asMap([target])}
        activeProjectId="proj-1"
      />,
    );
    const btn = screen.getByTestId('run-history-row-rerun');
    fireEvent.click(btn);
    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onRerun.mock.calls[0][0].id).toBe('pick-rerun');
    // Row click would normally open logs; verify the rerun button stops
    // propagation so a single click doesn't ALSO open logs.
    expect(onOpenLogs).not.toHaveBeenCalled();
  });

  it('search input filters runs by case-insensitive branch substring', () => {
    const runs = asMap([
      makeRun({ id: 'a', branch: 'feat/login-page', startedAt: 100, state: 'done' }),
      makeRun({ id: 'b', branch: 'fix/auth-bug', startedAt: 200, state: 'done' }),
      makeRun({ id: 'c', branch: 'chore/deps', startedAt: 300, state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    const input = screen.getByTestId('run-history-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'AUTH' } });
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('b');
  });

  it('search input filters runs by goal-file substring (lazy-loaded via readFileText)', async () => {
    const runs = asMap([
      makeRun({ id: 'a', branch: 'feat/x', worktreePath: '/wt/a', state: 'done' }),
      makeRun({ id: 'b', branch: 'feat/y', worktreePath: '/wt/b', state: 'done' }),
    ]);
    const goals: Record<string, string> = {
      '/wt/a/PIPELINE_GOAL.md': 'Add dark mode toggle',
      '/wt/b/PIPELINE_GOAL.md': 'Fix login flow regression',
    };
    const readFileText = vi.fn(async (path: string) => goals[path] ?? '');
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
        readFileText={readFileText}
      />,
    );
    // Before any typing, both visible and goal-fetch must NOT have fired
    // (lazy: branch-only filtering until the user expresses search intent).
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(2);
    expect(readFileText).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('run-history-search'), {
      target: { value: 'dark mode' },
    });
    await waitFor(() => {
      const rows = screen.getAllByTestId('run-history-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].getAttribute('data-runid')).toBe('a');
    });
    expect(readFileText).toHaveBeenCalledWith('/wt/a/PIPELINE_GOAL.md');
    expect(readFileText).toHaveBeenCalledWith('/wt/b/PIPELINE_GOAL.md');
  });

  it('goal-fetch errors do not crash the panel; row stays visible via branch match', async () => {
    const runs = asMap([
      makeRun({ id: 'a', branch: 'feat/searchme', worktreePath: '/gone/a', state: 'done' }),
    ]);
    const readFileText = vi.fn(async () => {
      throw new Error('worktree deleted');
    });
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
        readFileText={readFileText}
      />,
    );
    fireEvent.change(screen.getByTestId('run-history-search'), {
      target: { value: 'searchme' },
    });
    // Branch matches; goal read errors silently. Wait for the IPC promise to
    // settle so any unhandled rejection would surface.
    await waitFor(() => expect(readFileText).toHaveBeenCalled());
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('a');
  });

  it('date range filter narrows runs by startedAt (inclusive on both sides)', () => {
    const day = (s: string) => new Date(`${s}T12:00:00Z`).getTime();
    const runs = asMap([
      makeRun({ id: 'a', startedAt: day('2026-05-05'), state: 'done' }),
      makeRun({ id: 'b', startedAt: day('2026-05-07'), state: 'done' }),
      makeRun({ id: 'c', startedAt: day('2026-05-09'), state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.change(screen.getByTestId('run-history-date-from'), {
      target: { value: '2026-05-06' },
    });
    fireEvent.change(screen.getByTestId('run-history-date-to'), {
      target: { value: '2026-05-08' },
    });
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('b');
  });

  it('combined chip + search + date filters AND together', () => {
    const day = (s: string) => new Date(`${s}T12:00:00Z`).getTime();
    const runs = asMap([
      // Match: failed, branch contains 'auth', within range.
      makeRun({ id: 'hit', branch: 'fix/auth', startedAt: day('2026-05-07'), state: 'failed' }),
      // Right state, right branch, wrong date.
      makeRun({ id: 'oldFail', branch: 'fix/auth', startedAt: day('2026-04-01'), state: 'failed' }),
      // Right date, wrong state.
      makeRun({ id: 'doneAuth', branch: 'fix/auth', startedAt: day('2026-05-07'), state: 'done' }),
      // Right state + date, wrong branch.
      makeRun({ id: 'failOther', branch: 'feat/other', startedAt: day('2026-05-07'), state: 'failed' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId('run-history-filter-failed'));
    fireEvent.change(screen.getByTestId('run-history-search'), {
      target: { value: 'auth' },
    });
    fireEvent.change(screen.getByTestId('run-history-date-from'), {
      target: { value: '2026-05-06' },
    });
    fireEvent.change(screen.getByTestId('run-history-date-to'), {
      target: { value: '2026-05-08' },
    });
    const rows = screen.getAllByTestId('run-history-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-runid')).toBe('hit');
  });

  it('Clear filters button resets search/date/chips and shows all runs again', () => {
    const day = (s: string) => new Date(`${s}T12:00:00Z`).getTime();
    const runs = asMap([
      makeRun({ id: 'a', branch: 'feat/a', startedAt: day('2026-05-05'), state: 'done' }),
      makeRun({ id: 'b', branch: 'feat/b', startedAt: day('2026-05-07'), state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    // Force an empty result via a no-match search.
    fireEvent.change(screen.getByTestId('run-history-search'), {
      target: { value: 'nonexistent-xyz' },
    });
    fireEvent.change(screen.getByTestId('run-history-date-from'), {
      target: { value: '2030-01-01' },
    });
    expect(screen.queryAllByTestId('run-history-row')).toHaveLength(0);
    expect(screen.getByTestId('run-history-empty-filtered')).toBeTruthy();
    fireEvent.click(screen.getByTestId('run-history-clear-filters'));
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(2);
    expect((screen.getByTestId('run-history-search') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('run-history-date-from') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('run-history-date-to') as HTMLInputElement).value).toBe('');
  });

  it('clicking the All chip clears any existing filter', () => {
    const runs = asMap([
      makeRun({ id: 'wait', startedAt: 100, state: 'awaiting_plan_approval' }),
      makeRun({ id: 'done', startedAt: 200, state: 'done' }),
    ]);
    render(
      <RunHistoryPanel
        onClose={vi.fn()}
        onOpenLogs={vi.fn()}
        runs={runs}
        activeProjectId="proj-1"
      />,
    );
    fireEvent.click(screen.getByTestId('run-history-filter-awaiting'));
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('run-history-filter-all'));
    expect(screen.getAllByTestId('run-history-row')).toHaveLength(2);
  });
});
